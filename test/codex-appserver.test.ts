import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { AppServerThread } from "../src/codex-appserver.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("Codex app-server approval", () => {
  it.each([
    { approved: true, legacy: false },
    { approved: false, legacy: false },
    { approved: true, legacy: true },
    { approved: false, legacy: true },
  ])("answers the original request ($approved, legacy=$legacy)", async ({ approved, legacy }) => {
    const stdout = new PassThrough();
    const send = (message: object) => stdout.write(JSON.stringify(message) + "\n");
    const received: Array<Record<string, unknown>> = [];
    const stdin = new Writable({
      write(chunk, _encoding, done) {
        const message = JSON.parse(chunk.toString()) as Record<string, unknown>;
        received.push(message);
        switch (message.method) {
          case "initialize":
            send({ id: message.id, result: {} });
            break;
          case "thread/resume":
            send({ id: message.id, result: { thread: { id: "thread-1" } } });
            break;
          case "turn/start":
            send({ id: message.id, result: {} });
            send(legacy ? {
              id: "approval-1",
              method: "item/tool/requestUserInput",
              params: { questions: [{
                id: "mcp_tool_call_approval_123",
                question: "Allow coolify to create_application?",
                options: [{ label: "Allow" }, { label: "Cancel" }],
              }] },
            } : {
              id: "approval-1",
              method: "mcpServer/elicitation/request",
              params: {
                mode: "form",
                serverName: "coolify",
                message: "Allow coolify to create_application?",
                _meta: { codex_approval_kind: "mcp_tool_call" },
                requestedSchema: { type: "object", properties: {} },
              },
            });
            break;
          default:
            if (message.id === "approval-1") {
              send({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } });
            }
        }
        done();
      },
    });
    const kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(Object.assign(new EventEmitter(), { stdin, stdout, kill }) as never);

    const thread = new AppServerThread("thread-1", {
      workingDirectory: process.cwd(), sandboxMode: "workspace-write", approvalPolicy: "on-request",
    }, {});
    const approve = vi.fn(async () => approved);
    const events = [];
    for await (const event of thread.events("Deploy", new AbortController().signal, approve)) events.push(event);

    expect(approve).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("create_application"), expect.any(AbortSignal));
    expect(received).toContainEqual(expect.objectContaining({
      method: "thread/resume", params: expect.objectContaining({ approvalPolicy: "on-request", sandbox: "workspace-write" }),
    }));
    expect(received.at(-1)).toEqual({
      id: "approval-1",
      result: legacy
        ? { answers: { mcp_tool_call_approval_123: { answers: [approved ? "Allow" : "Cancel"] } } }
        : { action: approved ? "accept" : "decline", content: approved ? {} : null, _meta: null },
    });
    expect(events.map((event) => event.type)).toEqual(["thread.started", "turn.completed"]);
    expect(kill).toHaveBeenCalledOnce();
  });
});
