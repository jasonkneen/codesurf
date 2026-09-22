import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSession, ProviderStreamController, ProviderStreamEvent } from "../../core/plugins";
import type { StreamChunk } from "../../types/index";
import type { TurnContext } from "./types";

// Regressions for the provider-session turn runner:
//   A5  — owning-provider Edit/Write/MultiEdit approvals get a faithful diff
//         preview (typed adapter, no suppressing cast).
//   A11 — the provider event queue and abort listener are scoped to the turn:
//         abandoned consumers, synchronous sendTurn throws, late emits after
//         cancellation and large bursts all leave the scope at baseline.

const hostCwd = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../core/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/plugins")>();
  return {
    ...actual,
    getHostServices: () => ({ bash: { cwd: () => hostCwd.dir } }),
  };
});

const userModelMessage: ModelMessage = { role: "user", content: "hello" };

// The runner's transitive imports (core/plugins) take several seconds on
// a cold module graph; warm them once so no single test pays for it.
beforeAll(async () => {
  await import("./session-turn");
}, 60_000);

function makeCtx() {
  const ctx: TurnContext = {
    getMessages: () => [userModelMessage],
    mode: "agent",
    maxToolRounds: 3,
    maxTokens: 1024,
    getSessionId: () => "session-1",
    getCompactionSettings: () => ({ enabled: false }) as never,
    getBatchClientOptions: () => ({ apiKey: "k" }) as never,
    recordUsage: vi.fn(),
    appendCompletedTurn: vi.fn(),
    terminalizeCancelledTurn: vi.fn(async () => {}),
    emitTurnStop: vi.fn(async () => {}),
    emitTurnStopFailure: vi.fn(async () => {}),
    refreshSessionRecap: vi.fn(async () => {}),
    compactForContext: vi.fn(async () => false),
    buildSharedTurnToolset: vi.fn(async () => ({ tools: {}, closeMcp: async () => {}, mcpUnavailableMessage: null })),
    executeBatchToolCall: vi.fn(),
    setCurrentProviderSession: vi.fn(),
  };
  return ctx;
}

type SendTurn = NonNullable<ProviderSession["sendTurn"]>;

function makeSession(sendTurn: SendTurn): ProviderSession {
  return { adapterId: "test.adapter", providerId: "test", mode: "persistent", sendTurn };
}

function makeRuntime(session: ProviderSession) {
  return {
    model: null as never,
    modelId: "test-model",
    modelInfo: undefined,
    providerOptions: undefined,
    adapterId: "test.adapter",
    providerId: "test",
    session,
  };
}

async function runTurn(ctx: TurnContext, session: ProviderSession, signal: AbortSignal) {
  const { runSessionTurn } = await import("./session-turn");
  return runSessionTurn(ctx, {
    userMessage: "hello",
    userModelMessage,
    observer: {},
    runtime: makeRuntime(session),
    signal,
  });
}

async function drain(generator: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

/** A sendTurn whose controller is captured and whose settlement is deferred. */
function deferredSendTurn() {
  let controller: ProviderStreamController | null = null;
  let resolve: (value: { usage?: undefined }) => void = () => {};
  const promise = new Promise<{ usage?: undefined }>((r) => {
    resolve = r;
  });
  const sendTurn: SendTurn = (_input, c) => {
    controller = c;
    return promise;
  };
  return {
    sendTurn,
    emit: (event: ProviderStreamEvent) => {
      if (!controller) throw new Error("sendTurn not started");
      controller.emit(event);
    },
    resolve: () => resolve({}),
  };
}

describe("adaptProviderEditApproval (A5)", () => {
  it("maps the SDK Edit shape onto the native edit_file preview input", async () => {
    const { adaptProviderEditApproval } = await import("./session-turn");
    expect(adaptProviderEditApproval("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" })).toEqual({
      kind: "preview",
      outboundName: "edit_file",
      input: { path: "a.ts", old_string: "x", new_string: "y" },
    });
  });

  it("passes the native edit_file / write_file shapes through unchanged", async () => {
    const { adaptProviderEditApproval } = await import("./session-turn");
    expect(adaptProviderEditApproval("edit_file", { path: "a.ts", old_string: "x", new_string: "y" })).toEqual({
      kind: "preview",
      outboundName: "edit_file",
      input: { path: "a.ts", old_string: "x", new_string: "y" },
    });
    expect(adaptProviderEditApproval("write_file", { path: "a.ts", content: "body" })).toEqual({
      kind: "preview",
      outboundName: "write_file",
      input: { path: "a.ts", content: "body" },
    });
  });

  it("maps the SDK Write shape onto write_file", async () => {
    const { adaptProviderEditApproval } = await import("./session-turn");
    expect(adaptProviderEditApproval("Write", { file_path: "a.ts", content: "body" })).toEqual({
      kind: "preview",
      outboundName: "write_file",
      input: { path: "a.ts", content: "body" },
    });
  });

  it("previews a single-edit MultiEdit and explicitly refuses to preview several edits", async () => {
    const { adaptProviderEditApproval } = await import("./session-turn");
    expect(
      adaptProviderEditApproval("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] }),
    ).toEqual({
      kind: "preview",
      outboundName: "edit_file",
      input: { path: "a.ts", old_string: "x", new_string: "y" },
    });
    const multi = adaptProviderEditApproval("MultiEdit", {
      file_path: "a.ts",
      edits: [
        { old_string: "x", new_string: "y" },
        { old_string: "p", new_string: "q" },
      ],
    });
    expect(multi.kind).toBe("unsupported");
    if (multi.kind !== "unsupported") throw new Error("unreachable");
    expect(multi.outboundName).toBe("edit_file");
    expect(multi.reason).toMatch(/MultiEdit/);
    expect(multi.reason).toMatch(/2 edits/);
  });

  it("refuses to preview replace_all edits (a single-match preview would misreport them)", async () => {
    const { adaptProviderEditApproval } = await import("./session-turn");
    const result = adaptProviderEditApproval("Edit", {
      file_path: "a.ts",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(result.kind).toBe("unsupported");
  });

  it("leaves non-file tools alone", async () => {
    const { adaptProviderEditApproval } = await import("./session-turn");
    expect(adaptProviderEditApproval("Bash", { command: "ls" })).toEqual({ kind: "passthrough" });
  });
});

describe("owning-provider approval previews (A5)", () => {
  beforeEach(() => {
    hostCwd.dir = mkdtempSync(join(tmpdir(), "codesurf-session-turn-"));
    writeFileSync(join(hostCwd.dir, "target.ts"), "const value = 1;\nexport default value;\n");
  });
  afterEach(() => {
    rmSync(hostCwd.dir, { recursive: true, force: true });
  });

  async function approvalChunk(toolName: string, input: unknown) {
    const ctx = makeCtx();
    const session = makeSession(async (_input, controller) => {
      controller.emit({ type: "tool-approval-request", approvalId: "ap-1", toolName, input });
      controller.emit({ type: "done" });
      return {};
    });
    const chunks = await drain(await runTurn(ctx, session, new AbortController().signal));
    const chunk = chunks.find((c) => c.type === "tool_approval_request");
    if (!chunk) throw new Error("no approval chunk yielded");
    return chunk;
  }

  it("SDK Edit yields the expected patch and keeps the original input for execution", async () => {
    const input = { file_path: "target.ts", old_string: "const value = 1;", new_string: "const value = 2;" };
    const chunk = await approvalChunk("Edit", input);
    expect(chunk.toolCall?.function.name).toBe("edit_file");
    expect(JSON.parse(chunk.toolCall?.function.arguments ?? "{}")).toEqual(input);
    expect(chunk.editPrecheck).toBeDefined();
    expect(chunk.editPrecheck?.filePath).toBe("target.ts");
    expect(chunk.editPrecheck?.patch).toContain("-const value = 1;");
    expect(chunk.editPrecheck?.patch).toContain("+const value = 2;");
    expect(chunk.editPrecheck?.patch).not.toContain("WARNING");
    expect(chunk.editPrecheck?.additions).toBe(1);
    expect(chunk.editPrecheck?.removals).toBe(1);
  });

  it("native edit_file yields the expected patch", async () => {
    const chunk = await approvalChunk("edit_file", {
      path: "target.ts",
      old_string: "export default value;",
      new_string: "export { value };",
    });
    expect(chunk.editPrecheck?.patch).toContain("-export default value;");
    expect(chunk.editPrecheck?.patch).toContain("+export { value };");
    expect(chunk.editPrecheck?.patch).not.toContain("WARNING");
  });

  it("SDK Write still previews a rewrite", async () => {
    const chunk = await approvalChunk("Write", { file_path: "target.ts", content: "// replaced\n" });
    expect(chunk.toolCall?.function.name).toBe("write_file");
    expect(chunk.editPrecheck?.isNew).toBe(false);
    expect(chunk.editPrecheck?.patch).toContain("+// replaced");
    expect(chunk.editPrecheck?.patch).toContain("-const value = 1;");
  });

  it("MultiEdit with several edits routes to the edit panel without a fabricated preview", async () => {
    const chunk = await approvalChunk("MultiEdit", {
      file_path: "target.ts",
      edits: [
        { old_string: "const value = 1;", new_string: "const value = 2;" },
        { old_string: "export default value;", new_string: "export { value };" },
      ],
    });
    expect(chunk.toolCall?.function.name).toBe("edit_file");
    expect(chunk.editPrecheck).toBeUndefined();
  });
});

describe("provider event queue scope (A11)", () => {
  it("consumer return() after the first chunk removes the abort listener and drops late emits", async () => {
    const ctx = makeCtx();
    const { sendTurn, emit, resolve } = deferredSendTurn();
    const abort = new AbortController();
    const addSpy = vi.spyOn(abort.signal, "addEventListener");
    const removeSpy = vi.spyOn(abort.signal, "removeEventListener");

    const iterator = await runTurn(ctx, makeSession(sendTurn), abort.signal);
    const first = iterator.next();
    // Trailing newline forces an immediate flush so the first next() settles.
    emit({ type: "text-delta", delta: "first line\n" });
    expect((await first).value).toEqual({ type: "content", content: "first line\n" });

    await iterator.return(undefined);

    expect(addSpy).toHaveBeenCalledTimes(1);
    const listener = addSpy.mock.calls[0]![1];
    expect(removeSpy).toHaveBeenCalledWith("abort", listener);
    expect(ctx.setCurrentProviderSession).toHaveBeenLastCalledWith(null);

    // The provider keeps streaming into an abandoned scope: nothing may leak
    // out, throw, or terminalize.
    expect(() => {
      emit({ type: "text-delta", delta: "late\n" });
      emit({ type: "tool-call", id: "t1", toolName: "Bash", args: {} });
      emit({ type: "done" });
    }).not.toThrow();
    resolve();
    await new Promise((r) => setImmediate(r));
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(ctx.appendCompletedTurn).not.toHaveBeenCalled();
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
    expect(ctx.terminalizeCancelledTurn).not.toHaveBeenCalled();
  });

  it("a synchronous sendTurn throw becomes a failed turn and still removes the listener", async () => {
    const ctx = makeCtx();
    const abort = new AbortController();
    const addSpy = vi.spyOn(abort.signal, "addEventListener");
    const removeSpy = vi.spyOn(abort.signal, "removeEventListener");
    const session = makeSession(() => {
      throw new Error("spawn failed synchronously");
    });

    const chunks = await drain(await runTurn(ctx, session, abort.signal));

    expect(chunks).toContainEqual({ type: "error", content: "spawn failed synchronously" });
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStopFailure).toHaveBeenCalledWith("spawn failed synchronously", abort.signal);
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith("abort", addSpy.mock.calls[0]![1]);
    expect(ctx.setCurrentProviderSession).toHaveBeenLastCalledWith(null);
  });

  it("late provider events after cancellation are dropped and never terminalize again", async () => {
    const ctx = makeCtx();
    const { sendTurn, emit, resolve } = deferredSendTurn();
    const abort = new AbortController();
    const removeSpy = vi.spyOn(abort.signal, "removeEventListener");

    const iterator = await runTurn(ctx, makeSession(sendTurn), abort.signal);
    const first = iterator.next();
    emit({ type: "text-delta", delta: "working\n" });
    expect((await first).value).toEqual({ type: "content", content: "working\n" });

    abort.abort();
    const rest: StreamChunk[] = [];
    for await (const chunk of iterator) rest.push(chunk);
    expect(rest).toEqual([{ type: "content", content: "\n\n[Cancelled]" }, { type: "done" }]);
    expect(ctx.terminalizeCancelledTurn).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    // The subprocess acknowledges the abort late: its events and settlement
    // land in a disposed scope.
    emit({ type: "text-delta", delta: "late text" });
    emit({ type: "error", message: "interrupted" });
    emit({ type: "done", stopReason: "aborted" });
    resolve();
    await new Promise((r) => setImmediate(r));

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(ctx.terminalizeCancelledTurn).toHaveBeenCalledTimes(1);
    expect(ctx.emitTurnStop).not.toHaveBeenCalled();
    expect(ctx.emitTurnStopFailure).not.toHaveBeenCalled();
    expect(ctx.appendCompletedTurn).not.toHaveBeenCalled();
  });

  it("persists one assistant/tool pair per tool round so the transcript keeps its order", async () => {
    const ctx = makeCtx();
    const session = makeSession(async (_input, controller) => {
      controller.emit({ type: "text-delta", delta: "I'll read the file first." });
      controller.emit({ type: "tool-call", id: "c1", toolName: "bash", args: { command: "cat a" } });
      controller.emit({ type: "tool-result", id: "c1", result: "A" });
      controller.emit({ type: "text-delta", delta: "Done." });
      controller.emit({ type: "done" });
      return {};
    });

    await drain(await runTurn(ctx, session, new AbortController().signal));

    expect(ctx.appendCompletedTurn).toHaveBeenCalledTimes(1);
    const [, messages] = vi.mocked(ctx.appendCompletedTurn).mock.calls[0]!;
    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "I'll read the file first." },
        { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "cat a" } },
      ],
    });
    expect(messages[2]).toEqual({ role: "assistant", content: "Done." });
  });

  it("files a late result with the round that issued its call", async () => {
    // Two parallel calls; one answers, the model writes more text (a new
    // round), THEN the second answers. Filing it with the current round put
    // assistant text between call c2 and its result.
    const ctx = makeCtx();
    const session = makeSession(async (_input, controller) => {
      controller.emit({ type: "tool-call", id: "c1", toolName: "bash", args: { command: "cat a" } });
      controller.emit({ type: "tool-call", id: "c2", toolName: "bash", args: { command: "cat b" } });
      controller.emit({ type: "tool-result", id: "c1", result: "A" });
      controller.emit({ type: "text-delta", delta: "Still waiting on b." });
      controller.emit({ type: "tool-result", id: "c2", result: "B" });
      controller.emit({ type: "tool-result", id: "ghost", result: "?" });
      controller.emit({ type: "done" });
      return {};
    });

    await drain(await runTurn(ctx, session, new AbortController().signal));

    const [, messages] = vi.mocked(ctx.appendCompletedTurn).mock.calls[0]!;
    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    const results = (messages[1]!.content as Array<{ toolCallId: string }>).map((part) => part.toolCallId);
    expect(results).toEqual(["c1", "c2"]);
    // No synthesized "interrupted" result for c2, and nothing for the unknown id.
    const allResults = messages.flatMap((m) =>
      m.role === "tool" ? (m.content as Array<{ toolCallId: string }>).map((part) => part.toolCallId) : [],
    );
    expect(allResults).toEqual(["c1", "c2"]);
    expect(messages[2]).toEqual({ role: "assistant", content: "Still waiting on b." });
  });

  it("passes provider cache token counts through to usage recording", async () => {
    const ctx = makeCtx();
    const session = makeSession(async (_input, controller) => {
      controller.emit({ type: "text-delta", delta: "ok" });
      controller.emit({
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 100 },
      });
      controller.emit({ type: "done" });
      return {};
    });

    await drain(await runTurn(ctx, session, new AbortController().signal));

    // 10 cache-miss input + 5 output + 900 read + 100 written. `inputTokens`
    // is the MISS slice, so a total of 15 would drop the 1000 tokens the
    // prefix cache was billed for.
    expect(ctx.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cacheReadTokens: 900, cacheWriteTokens: 100, totalTokens: 1015 }),
      "message",
      expect.any(String),
    );
  });

  it("forwards provider status events as status chunks", async () => {
    const ctx = makeCtx();
    const session = makeSession(async (_input, controller) => {
      controller.emit({ type: "status", status: "connecting" });
      controller.emit({ type: "text-delta", delta: "hi" });
      controller.emit({ type: "done" });
      return {};
    });

    const chunks = await drain(await runTurn(ctx, session, new AbortController().signal));

    expect(chunks[0]).toEqual({ type: "status", status: "connecting", content: undefined });
    expect(chunks).toContainEqual({ type: "content", content: "hi" });
  });

  it("passes provider cache token counts through to usage recording", async () => {
    const ctx = makeCtx();
    const session = makeSession(async (_input, controller) => {
      controller.emit({ type: "text-delta", delta: "ok" });
      controller.emit({
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 100 },
      });
      controller.emit({ type: "done" });
      return {};
    });

    await drain(await runTurn(ctx, session, new AbortController().signal));

    // 10 cache-miss input + 5 output + 900 read + 100 written. `inputTokens`
    // is the MISS slice, so a total of 15 would drop the 1000 tokens the
    // prefix cache was billed for.
    expect(ctx.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cacheReadTokens: 900, cacheWriteTokens: 100, totalTokens: 1015 }),
      "message",
      expect.any(String),
    );
  });

  it("a large synchronous burst is delivered completely and in order", async () => {
    const ctx = makeCtx();
    const count = 20_000;
    const deltas = Array.from({ length: count }, (_, i) => `${i}\n`);
    const session = makeSession(async (_input, controller) => {
      for (const delta of deltas) controller.emit({ type: "text-delta", delta });
      controller.emit({ type: "done" });
      return {};
    });

    const chunks = await drain(await runTurn(ctx, session, new AbortController().signal));

    const text = chunks
      .filter((c) => c.type === "content")
      .map((c) => c.content)
      .join("");
    expect(text).toBe(deltas.join(""));
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(ctx.emitTurnStop).toHaveBeenCalledTimes(1);
    expect(ctx.appendCompletedTurn).toHaveBeenCalledTimes(1);
    const [, messages] = vi.mocked(ctx.appendCompletedTurn).mock.calls[0]!;
    expect(messages).toEqual([{ role: "assistant", content: deltas.join("") }]);
  });
});
