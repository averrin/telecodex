import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type { Input, ModelReasoningEffort, ThreadEvent, SandboxMode, ApprovalMode } from "@openai/codex-sdk";

export type RequestApproval = (details: string, signal: AbortSignal) => Promise<boolean>;

interface ThreadOptions {
  model?: string;
  workingDirectory: string;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  modelReasoningEffort?: ModelReasoningEffort;
}

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message: string };
}

export class AppServerThread {
  constructor(
    public id: string | null,
    private readonly options: ThreadOptions,
    private readonly env: Record<string, string>,
  ) {}

  async *events(input: Input, signal: AbortSignal, approve?: RequestApproval): AsyncGenerator<ThreadEvent> {
    signal.throwIfAborted();
    const require = createRequire(import.meta.url);
    const executable = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
    const child = spawn(process.execPath, [executable, "app-server", "--listen", "stdio://"], {
      env: this.env,
      cwd: this.options.workingDirectory,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: child.stdout });
    const messages = lines[Symbol.asyncIterator]();
    let processError: Error | undefined;
    child.on("error", (error) => { processError = error; lines.close(); });
    child.stdin.on("error", (error) => { processError = error; lines.close(); });
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    let sequence = 0;
    let usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    const send = (message: Message) => child.stdin.write(JSON.stringify(message) + "\n");
    const next = async (): Promise<Message> => {
      const line = await messages.next();
      signal.throwIfAborted();
      if (line.done) throw processError ?? new Error("Codex app-server disconnected");
      return JSON.parse(line.value) as Message;
    };
    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = ++sequence;
      send({ id, method, params });
      for (;;) {
        const message = await next();
        if (message.method && message.id !== undefined) {
          await replyToRequest(message, send, signal, approve);
        } else if (message.id === id) {
          if (message.error) throw new Error(message.error.message);
          return message.result;
        }
      }
    };

    try {
      await request("initialize", {
        clientInfo: { name: "telecodex", title: "Telecodex", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      send({ method: "initialized" });
      const { workingDirectory, sandboxMode, approvalPolicy, model, modelReasoningEffort } = this.options;
      const { thread } = await request(this.id ? "thread/resume" : "thread/start", {
        ...(this.id ? { threadId: this.id, excludeTurns: true } : {}),
        cwd: workingDirectory,
        sandbox: sandboxMode,
        approvalPolicy,
        approvalsReviewer: "user",
        model,
      }) as { thread: { id: string } };
      this.id = thread.id;
      yield { type: "thread.started", thread_id: thread.id };
      const items = new Map<string, string>();
      const turnRequestId = ++sequence;
      send({
        id: turnRequestId,
        method: "turn/start",
        params: {
          threadId: thread.id,
          effort: modelReasoningEffort,
          input: (typeof input === "string" ? [{ type: "text" as const, text: input }] : input).map(
            (part) => part.type === "local_image"
              ? { type: "localImage", path: part.path }
              : { ...part, text_elements: [] },
          ),
        },
      });
      for (;;) {
        const message = await next();
        const params = message.params ?? {};
        if (message.method && message.id !== undefined) {
          await replyToRequest(message, send, signal, approve);
          continue;
        }
        if (message.id === turnRequestId && message.error) throw new Error(message.error.message);
        if (params.threadId !== thread.id) continue;
        if (message.method === "thread/tokenUsage/updated") {
          const { last } = params.tokenUsage as {
            last: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
          };
          usage = { input_tokens: last.inputTokens, cached_input_tokens: last.cachedInputTokens,
            cache_write_input_tokens: last.cacheWriteInputTokens, output_tokens: last.outputTokens,
            reasoning_output_tokens: last.reasoningOutputTokens };
        } else if (message.method === "turn/completed") {
          const turn = params.turn as { status: string; error?: { message: string } };
          if (turn.status !== "completed") throw new Error(turn.error?.message ?? `Codex turn ${turn.status}`);
          yield { type: "turn.completed", usage };
          return;
        } else {
          const event = itemEvent(message.method, params, items);
          if (event) yield event;
        }
      }
    } finally {
      signal.removeEventListener("abort", stop);
      lines.close();
      child.stdin.end();
      stop();
    }
  }
}

async function replyToRequest(
  message: Message,
  send: (message: Message) => unknown,
  signal: AbortSignal,
  approve?: RequestApproval,
): Promise<void> {
  const params = message.params ?? {};
  const ask = async (details: string) => approve ? approve(details, signal).catch(() => false) : false;
  let result: unknown;
  switch (message.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      const network = params.networkApprovalContext as { host?: string } | undefined;
      const description = [params.command, params.cwd, params.grantRoot, network?.host, params.reason]
        .filter(Boolean).join("\n");
      const label = message.method.includes("fileChange") ? "File change" : "Command execution";
      result = { decision: await ask([label, description].filter(Boolean).join("\n")) ? "accept" : "decline" };
      break;
    }
    case "item/tool/requestUserInput": {
      const questions = params.questions as Array<{
        id: string; question: string; options?: Array<{ label: string }>;
      }>;
      const question = questions?.length === 1 ? questions[0] : undefined;
      if (!question?.id.startsWith("mcp_tool_call_approval_") ||
        !question.options?.some(({ label }) => label === "Allow") ||
        !question.options.some(({ label }) => label === "Cancel")) {
        result = { answers: {} };
        break;
      }
      const answer = await ask(question.question) ? "Allow" : "Cancel";
      result = { answers: { [question.id]: { answers: [answer] } } };
      break;
    }
    case "mcpServer/elicitation/request": {
      const schema = params.requestedSchema as { properties?: Record<string, unknown> } | undefined;
      const meta = params._meta as { codex_approval_kind?: string } | undefined;
      const accepted = params.mode === "form" && meta?.codex_approval_kind === "mcp_tool_call" &&
        schema?.properties && Object.keys(schema.properties).length === 0 &&
        await ask(`MCP ${params.serverName}\n${params.message}`);
      result = { action: accepted ? "accept" : "decline", content: accepted ? {} : null, _meta: null };
      break;
    }
    default:
      send({ id: message.id, error: { code: -32601, message: "Unsupported app-server request" } });
      return;
  }
  send({ id: message.id, result });
}

function itemEvent(
  method: string | undefined,
  params: Record<string, unknown>,
  output: Map<string, string>,
): ThreadEvent | undefined {
  if (method === "turn/plan/updated") {
    const plan = params.plan as Array<{ step: string; status: string }>;
    return { type: "item.updated", item: { type: "todo_list", id: String(params.turnId),
      items: plan.map(({ step, status }) => ({ text: step, completed: status === "completed" })) } };
  }
  if (method === "item/agentMessage/delta" || method === "item/commandExecution/outputDelta") {
    const { itemId, delta } = params as { itemId: string; delta: string };
    const text = (output.get(itemId) ?? "") + delta;
    output.set(itemId, text);
    return {
      type: "item.updated",
      item: method === "item/agentMessage/delta"
        ? { type: "agent_message", id: itemId, text }
        : { type: "command_execution", id: itemId, command: "", aggregated_output: text, status: "in_progress" },
    };
  }
  if (method !== "item/started" && method !== "item/completed") return;
  const item = params.item as {
    type: string; id: string; text?: string; command?: string; aggregatedOutput?: string;
    status?: string; error?: { message: string }; server?: string; tool?: string;
    query?: string; changes?: Array<{ path: string; kind: { type: "add" | "delete" | "update" } }>;
  };
  const type = method === "item/started" ? "item.started" : "item.completed";
  const status = item.status === "completed" ? "completed"
    : type === "item.started" ? "in_progress" : "failed";
  switch (item.type) {
    case "agentMessage":
      return { type, item: { type: "agent_message", id: item.id, text: item.text ?? "" } };
    case "commandExecution":
      return { type, item: { type: "command_execution", id: item.id, command: item.command ?? "",
        aggregated_output: item.aggregatedOutput ?? output.get(item.id) ?? "", status } };
    case "mcpToolCall":
      return { type, item: { type: "mcp_tool_call", id: item.id, server: item.server ?? "",
        tool: item.tool ?? "", arguments: null, status, error: item.error ?? undefined } };
    case "fileChange":
      return { type, item: { type: "file_change", id: item.id,
        changes: (item.changes ?? []).map(({ path, kind }) => ({ path, kind: kind.type })),
        status: status === "completed" ? "completed" : "failed" } };
    case "webSearch":
      return { type, item: { type: "web_search", id: item.id, query: item.query ?? "" } };
  }
}
