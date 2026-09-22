import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCliCheckCache } from "../../../utils/cli-check-cache";
import type {
  ProviderConnectionContext,
  ProviderStreamController,
  ProviderStreamEvent,
  ProviderTurnInput,
  RegisteredModelProvider,
  RegisteredSetting,
} from "../api";
import {
  CODEX_RPC_TIMEOUT_MS,
  CODEX_STOP_GRACE_MS,
  CodexSession,
  type CodexSpawn,
  codexProviderPlugin,
  createCodexCredentialCheck,
  mapCodexNotification,
} from "./codex-provider";

interface StubApi {
  mount: () => Promise<void>;
  providers: RegisteredModelProvider[];
  settings: RegisteredSetting[];
}

function makeStubApi(): StubApi {
  const providers: RegisteredModelProvider[] = [];
  const settings: RegisteredSetting[] = [];

  const api = {
    onDispose: () => {},
    registerSetting: (setting: unknown) => {
      settings.push(setting as RegisteredSetting);
      return () => {};
    },
    registerModelProvider: (provider: unknown) => {
      providers.push(provider as RegisteredModelProvider);
      return () => {};
    },
    registerCommand: () => () => {},
    registerTool: () => () => {},
    registerModel: () => () => {},
    registerScreen: () => () => {},
    registerStatusIndicator: () => () => {},
  } as Record<string, unknown>;

  // A native plugin has no `activate`: mount it on a real root whose bindings
  // forward into the same recorders the stub api used.
  const mount = async () => {
    const root = createCodesurfRoot({
      registerModelProvider: (spec) => {
        providers.push(spec as never);
        return () => {};
      },
      registerSetting: (spec) => {
        settings.push(spec as never);
        return () => {};
      },
      listSettings: () => settings as never,
      subscribeSetting: () => () => {},
    });
    await mountPlugin(root, codexProviderPlugin);
  };
  void api;

  return { mount, providers, settings };
}

describe("builtin.provider-codex", () => {
  it("declares the expected extension manifest", () => {
    expect(codexProviderPlugin.manifest).toMatchObject({
      id: "builtin.provider-codex",
      enabledByDefault: false,
      capabilities: ["provider-adapters", "models", "settings"],
    });
  });

  it("registers sandbox/approval/effort settings and the owning-adapter provider", async () => {
    const stub = makeStubApi();
    await stub.mount();

    expect(stub.settings.map((s) => s.key)).toEqual(
      expect.arrayContaining([
        "openai.codex-app-server.sandbox",
        "openai.codex-app-server.approvalPolicy",
        "openai.codex-app-server.effort",
      ]),
    );

    const provider = stub.providers.find((p) => p.id === "openai.codex-app-server");
    expect(provider).toBeDefined();
    expect(provider?.providerId).toBe("openai");
    expect(provider?.transport).toBe("stdio");
    expect(provider?.connectionMode).toBe("persistent");
    expect(provider?.sessionStrategy).toBe("singleton");
    expect(provider?.capabilities).toMatchObject({ streaming: true, tools: true, reasoning: true });
    expect(provider?.auth?.mode).toBe("oauth");
  });
});

// ── Fake `codex app-server` child ───────────────────────────────────────────

interface RpcRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

/** Stand-in for the spawned child: EventEmitter + PassThrough stdio. Parses
 *  what the transport writes to stdin so tests can reply by request id, and
 *  lets tests script stdout/stderr, exit, close, and spawn errors. */
class FakeCodexChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly requests: RpcRequest[] = [];
  readonly responses: Array<{ id: number | string; result: unknown }> = [];
  readonly signals: string[] = [];
  /** When false, SIGTERM is ignored (SIGKILL always exits). */
  autoExitOnKill = true;
  private exited = false;
  private partial = "";

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.partial += chunk;
      let nl = this.partial.indexOf("\n");
      while (nl !== -1) {
        const line = this.partial.slice(0, nl).trim();
        this.partial = this.partial.slice(nl + 1);
        if (line) {
          const msg = JSON.parse(line) as RpcRequest & { result?: unknown };
          if (msg.method) this.requests.push(msg);
          else this.responses.push({ id: msg.id, result: msg.result });
        }
        nl = this.partial.indexOf("\n");
      }
    });
  }

  kill(signal = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.autoExitOnKill || signal === "SIGKILL") this.exit(null, signal as NodeJS.Signals);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  reply(id: number | string, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  serverRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  requestsFor(method: string): RpcRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await flush();
}

async function waitFor<T>(probe: () => T | undefined | null, what: string, rounds = 50): Promise<T> {
  for (let i = 0; i < rounds; i += 1) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** True when `promise` has already settled (either way) — checked without
 *  blocking on it. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    flush().then(() => false),
  ]);
}

function makeCtx(): ProviderConnectionContext {
  return {
    conversationId: "conv-1",
    adapterId: "openai.codex-app-server",
    providerId: "openai",
    settings: { get: (_key: string, fallback?: unknown) => fallback } as ProviderConnectionContext["settings"],
  };
}

function makeController(): ProviderStreamController & { events: ProviderStreamEvent[] } {
  const events: ProviderStreamEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

function textOf(controller: { events: ProviderStreamEvent[] }): string {
  return controller.events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.delta)
    .join("");
}

function makeInput(overrides: Partial<ProviderTurnInput> = {}): ProviderTurnInput {
  return {
    conversationId: "conv-1",
    providerId: "openai",
    adapterId: "openai.codex-app-server",
    modelId: "gpt-6-astra",
    prompt: "do work",
    messages: [],
    ...overrides,
  };
}

function makeSession(): { session: CodexSession; spawned: FakeCodexChild[]; spawn: ReturnType<typeof vi.fn> } {
  const spawned: FakeCodexChild[] = [];
  const spawn = vi.fn((_bin: string, _args: string[]) => {
    const child = new FakeCodexChild();
    spawned.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const session = new CodexSession(makeCtx(), { spawn: spawn as unknown as CodexSpawn });
  return { session, spawned, spawn };
}

/** Drive the startup handshake: answer `initialize` and `thread/start`. */
async function connect(child: FakeCodexChild, threadId = "thread-1"): Promise<void> {
  const init = await waitFor(() => child.requestsFor("initialize")[0], "initialize request");
  child.reply(init.id, { userAgent: "codex/test" });
  const start = await waitFor(() => child.requestsFor("thread/start")[0], "thread/start request");
  child.reply(start.id, { thread: { id: threadId } });
}

/** Boot a session with one turn in flight and its `turn/start` reply pending. */
async function startTurn(
  session: CodexSession,
  spawned: FakeCodexChild[],
  input: ProviderTurnInput,
): Promise<{
  child: FakeCodexChild;
  controller: ReturnType<typeof makeController>;
  turn: Promise<unknown>;
  start: RpcRequest;
}> {
  const controller = makeController();
  const turn = session.sendTurn(input, controller);
  const child = await waitFor(() => spawned[0], "spawned child");
  await connect(child);
  const start = await waitFor(() => child.requestsFor("turn/start")[0], "turn/start request");
  return { child, controller, turn, start };
}

describe("CodexSession turn identity and cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("interrupts the codex turn and resolves sendTurn when the host abort signal fires", async () => {
    const { session, spawned } = makeSession();
    const ac = new AbortController();
    const { child, turn, start } = await startTurn(session, spawned, makeInput({ abortSignal: ac.signal }));
    child.reply(start.id, { turn: { id: "turn-1" } });
    await settle();

    ac.abort();
    await expect(turn).resolves.toEqual({ usage: {} });
    const interrupt = await waitFor(() => child.requestsFor("turn/interrupt")[0], "turn/interrupt");
    expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
  });

  it("does not start a turn when the abort signal is already aborted at entry", async () => {
    const { session, spawned } = makeSession();
    const turn = session.sendTurn(makeInput({ abortSignal: AbortSignal.abort() }), makeController());
    const child = await waitFor(() => spawned[0], "spawned child");
    await connect(child);
    await expect(turn).resolves.toEqual({ usage: {} });
    expect(child.requestsFor("turn/start")).toHaveLength(0);
  });

  it("keeps a startup-cancelled turn's late output away from its replacement and interrupts it once its id is known", async () => {
    const { session, spawned } = makeSession();
    const acA = new AbortController();
    const {
      child,
      controller: a,
      turn: turnA,
      start: startA,
    } = await startTurn(session, spawned, makeInput({ prompt: "A", abortSignal: acA.signal }));

    // Cancel A before codex has replied to its turn/start: no id ⇒ no
    // interrupt yet, but the host is released immediately.
    acA.abort();
    await expect(turnA).resolves.toEqual({ usage: {} });
    expect(child.requestsFor("turn/interrupt")).toHaveLength(0);

    // Begin B on the same session while A's reply is still outstanding.
    const b = makeController();
    const turnB = session.sendTurn(makeInput({ prompt: "B" }), b);
    const startB = await waitFor(() => child.requestsFor("turn/start")[1], "B turn/start");
    expect(startB.id).not.toBe(startA.id);

    // A's start notification and text arrive before A's reply. B has no id yet
    // and A is still awaiting its reply, so neither may be attributed to B.
    child.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-A" } });
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-A", itemId: "i", delta: "stale" });
    await settle();
    expect(textOf(b)).toBe("");

    // A's reply lands: its identity is now known ⇒ interrupt exactly once.
    child.reply(startA.id, { turn: { id: "turn-A" } });
    const interrupt = await waitFor(() => child.requestsFor("turn/interrupt")[0], "turn/interrupt");
    expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "turn-A" });

    // Late A traffic — text, an approval, usage, completion — is retired.
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-A", itemId: "i", delta: "more" });
    child.serverRequest(77, "item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-A",
      command: "rm -rf /",
    });
    child.notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-A", usage: { inputTokens: 99 } });
    child.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-A" } });
    await settle();
    expect(b.events).toEqual([{ type: "status", status: "streaming" }]);
    expect(await isSettled(turnB)).toBe(false);
    expect(child.responses).toContainEqual({ id: 77, result: { decision: "decline" } });

    // B proceeds normally with its own identity.
    child.reply(startB.id, { turn: { id: "turn-B" } });
    child.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-B" } });
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-B", itemId: "j", delta: "fresh" });
    child.notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-B", usage: { inputTokens: 3 } });
    child.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-B" } });
    await expect(turnB).resolves.toEqual({
      usage: { inputTokens: 3, outputTokens: undefined, cacheReadTokens: undefined },
    });
    expect(textOf(b)).toBe("fresh");
    expect(child.requestsFor("turn/interrupt")).toHaveLength(1);
    // The retired turn's own controller never saw its late output either.
    expect(a.events).toEqual([{ type: "status", status: "streaming" }]);
  });

  it("ignores notifications addressed to another thread", async () => {
    const { session, spawned } = makeSession();
    const { child, controller, turn, start } = await startTurn(session, spawned, makeInput());
    child.reply(start.id, { turn: { id: "turn-1" } });
    child.notify("item/agentMessage/delta", {
      threadId: "thread-other",
      turnId: "turn-1",
      itemId: "i",
      delta: "foreign",
    });
    child.notify("turn/completed", { threadId: "thread-other", turn: { id: "turn-1" } });
    await settle();
    expect(textOf(controller)).toBe("");
    expect(await isSettled(turn)).toBe(false);

    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "i", delta: "mine" });
    child.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });
    await expect(turn).resolves.toEqual({ usage: {} });
    expect(textOf(controller)).toBe("mine");
  });

  it("shares one handshake when warm() and the first send overlap", async () => {
    const { session, spawned } = makeSession();
    const warming = session.warm();
    const controller = makeController();
    const turn = session.sendTurn(makeInput(), controller);
    const child = await waitFor(() => spawned[0], "spawned child");
    await connect(child);
    await warming;
    const start = await waitFor(() => child.requestsFor("turn/start")[0], "turn/start request");
    expect(child.requestsFor("initialize")).toHaveLength(1);
    expect(child.requestsFor("thread/start")).toHaveLength(1);
    expect(spawned).toHaveLength(1);

    child.reply(start.id, { turn: { id: "turn-1" } });
    child.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });
    await expect(turn).resolves.toEqual({ usage: {} });
  });

  it("keeps the turn live across an error notification that codex will retry", async () => {
    const { session, spawned } = makeSession();
    const { child, controller, turn, start } = await startTurn(session, spawned, makeInput());
    child.reply(start.id, { turn: { id: "turn-1" } });
    child.notify("error", {
      error: { message: "stream disconnected", codexErrorInfo: null, additionalDetails: null, misalignment: null },
      willRetry: true,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await settle();
    expect(await isSettled(turn)).toBe(false);
    expect(controller.events.some((e) => e.type === "error")).toBe(false);

    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "i", delta: "ok" });
    child.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });
    await expect(turn).resolves.toEqual({ usage: {} });
    expect(textOf(controller)).toBe("ok");
  });

  it("rejects an overlapping send while a turn is in flight and leaves the live turn untouched", async () => {
    const { session, spawned } = makeSession();
    const { child, controller, turn, start } = await startTurn(session, spawned, makeInput({ prompt: "A" }));

    await expect(session.sendTurn(makeInput({ prompt: "B" }), makeController())).rejects.toThrow(/already in progress/);
    await settle();
    expect(child.requestsFor("turn/start")).toHaveLength(1);

    child.reply(start.id, { turn: { id: "turn-1" } });
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "i", delta: "ok" });
    child.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });
    await expect(turn).resolves.toEqual({ usage: {} });
    expect(textOf(controller)).toBe("ok");
  });
});

describe("CodexSession transport failure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects the streaming turn when the child exits after turn/start replied, then re-spawns on the next send", async () => {
    const { session, spawned, spawn } = makeSession();
    const { child, controller, turn, start } = await startTurn(session, spawned, makeInput());
    child.reply(start.id, { turn: { id: "turn-1" } });
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "i", delta: "partial" });
    await settle();
    expect(textOf(controller)).toBe("partial");

    child.stderr.write("fatal: auth token expired\n");
    child.exit(1);
    await expect(turn).rejects.toThrow(/exited with code 1[\s\S]*auth token expired/);

    // A fresh send re-spawns rather than staying wedged on the dead child.
    const next = makeController();
    const turn2 = session.sendTurn(makeInput({ prompt: "again" }), next);
    const child2 = await waitFor(() => spawned[1], "re-spawned child");
    await connect(child2, "thread-2");
    const start2 = await waitFor(() => child2.requestsFor("turn/start")[0], "second turn/start");
    expect(start2.params.threadId).toBe("thread-2");
    child2.reply(start2.id, { turn: { id: "turn-2" } });
    child2.notify("turn/completed", { threadId: "thread-2", turn: { id: "turn-2" } });
    await expect(turn2).resolves.toEqual({ usage: {} });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("rejects a pending approval's turn on exit and drops the approval", async () => {
    const { session, spawned } = makeSession();
    const { child, controller, turn, start } = await startTurn(session, spawned, makeInput());
    child.reply(start.id, { turn: { id: "turn-1" } });
    child.serverRequest(9, "item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      command: "ls",
    });
    await settle();
    const approval = controller.events.find((e) => e.type === "tool-approval-request");
    expect(approval).toMatchObject({ approvalId: "codex-9", toolName: "command" });

    child.exit(null, "SIGSEGV");
    await expect(turn).rejects.toThrow(/killed by SIGSEGV/);
    // Nothing is left to answer: a late host decision is a no-op, not a write
    // to a dead pipe.
    session.respondToToolApproval("codex-9", true);
    await settle();
    expect(child.responses).toEqual([]);
  });

  it("disconnect during generation rejects the turn and waits for the child to close", async () => {
    const { session, spawned } = makeSession();
    const { child, turn, start } = await startTurn(session, spawned, makeInput());
    child.reply(start.id, { turn: { id: "turn-1" } });
    child.autoExitOnKill = false;

    const disconnected = session.disconnect();
    await expect(turn).rejects.toThrow(/disconnected/);
    await settle();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(await isSettled(disconnected)).toBe(false);

    child.exit(0, "SIGTERM");
    await expect(disconnected).resolves.toBeUndefined();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM on disconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { session, spawned } = makeSession();
    const { child, turn, start } = await startTurn(session, spawned, makeInput());
    child.reply(start.id, { turn: { id: "turn-1" } });
    child.autoExitOnKill = false;

    const disconnected = session.disconnect();
    await expect(turn).rejects.toThrow(/disconnected/);
    await settle();
    expect(child.signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(CODEX_STOP_GRACE_MS);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(disconnected).resolves.toBeUndefined();
  });

  it("surfaces an asynchronous spawn failure (missing executable) as a rejected send", async () => {
    const spawned: FakeCodexChild[] = [];
    const spawn: CodexSpawn = () => {
      const child = new FakeCodexChild();
      spawned.push(child);
      // Node reports ENOENT after spawn() returns: an 'error' on the child and
      // a destroyed stdin, never an 'exit'.
      setImmediate(() => {
        child.stdin.destroy(new Error("write EPIPE"));
        child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const session = new CodexSession(makeCtx(), { spawn });

    await expect(session.sendTurn(makeInput(), makeController())).rejects.toThrow(/failed to start.*ENOENT/);
    expect(spawned).toHaveLength(1);
  });

  it("drains a stderr flood into a bounded tail without stalling the pipe", async () => {
    const { session, spawned } = makeSession();
    const { child, controller, turn, start } = await startTurn(session, spawned, makeInput());
    child.reply(start.id, { turn: { id: "turn-1" } });

    const chunk = `${"e".repeat(10 * 1024)}\n`;
    for (let i = 0; i < 200; i += 1) {
      // A drained pipe keeps accepting writes; an undrained one back-pressures.
      expect(child.stderr.write(chunk)).toBe(true);
    }
    await settle();
    // stdout is still serviced after the flood.
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "i", delta: "still" });
    await settle();
    expect(textOf(controller)).toBe("still");

    child.exit(2);
    await expect(turn).rejects.toThrow(/exited with code 2/);
    const message = String(await turn.catch((err: Error) => err.message));
    expect(message.length).toBeLessThan(9 * 1024);
  });

  it("rejects a send whose initialize is never answered once the RPC deadline passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { session, spawned } = makeSession();
    const turn = session.sendTurn(makeInput(), makeController());
    const child = await waitFor(() => spawned[0], "spawned child");
    await waitFor(() => child.requestsFor("initialize")[0], "initialize request");

    await vi.advanceTimersByTimeAsync(CODEX_RPC_TIMEOUT_MS - 1);
    expect(await isSettled(turn)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(turn).rejects.toThrow(/initialize timed out/);
  });
});

describe("createCodexCredentialCheck", () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    clearCliCheckCache();
    dir = mkdtempSync(join(tmpdir(), "codesurf-codex-auth-"));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function fixtureExecutable(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("reports ok synchronously when the auth file exists, without probing", () => {
    const authFile = join(dir, "auth.json");
    writeFileSync(authFile, "{}");
    const execFile = vi.fn();
    const check = createCodexCredentialCheck({ bin: join(dir, "missing-codex"), authFile, execFile });
    expect(check()).toEqual({ ok: true });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports install-cli synchronously when the executable is absent", () => {
    const execFile = vi.fn();
    const check = createCodexCredentialCheck({
      bin: join(dir, "missing-codex"),
      authFile: join(dir, "nope"),
      execFile,
    });
    expect(check()).toMatchObject({ ok: false, needsUserAction: "install-cli" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("probes a custom executable off PATH asynchronously and caches the settled result", async () => {
    process.env.PATH = join(dir, "empty-path");
    const bin = fixtureExecutable("my-codex", "exit 0");
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: (Error & { code?: unknown }) | null) => void,
      ) => {
        setImmediate(() => callback(null));
      },
    );
    const check = createCodexCredentialCheck({ bin, authFile: join(dir, "nope"), execFile, timeoutMs: 1234 });

    const first = check();
    expect(first).toBeInstanceOf(Promise);
    await expect(first).resolves.toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.slice(0, 3)).toEqual([bin, ["login", "status"], { timeout: 1234 }]);

    // Settled ⇒ later (render-path) calls get the value synchronously and the
    // probe is not re-run within the cache TTL.
    expect(check()).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("maps a failing probe to start-oauth and ENOENT to install-cli", async () => {
    const bin = fixtureExecutable("my-codex", "exit 1");
    const failing = vi.fn(
      (_f: string, _a: string[], _o: { timeout: number }, cb: (e: (Error & { code?: unknown }) | null) => void) =>
        cb(Object.assign(new Error("exit 1"), { code: 1 })),
    );
    await expect(
      createCodexCredentialCheck({ bin, authFile: join(dir, "nope"), execFile: failing })(),
    ).resolves.toMatchObject({ ok: false, needsUserAction: "start-oauth" });

    clearCliCheckCache();
    const enoent = vi.fn(
      (_f: string, _a: string[], _o: { timeout: number }, cb: (e: (Error & { code?: unknown }) | null) => void) =>
        cb(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
    );
    await expect(
      createCodexCredentialCheck({ bin, authFile: join(dir, "nope"), execFile: enoent })(),
    ).resolves.toMatchObject({ ok: false, needsUserAction: "install-cli" });
  });

  it("bounds a login-status probe that never returns", async () => {
    const bin = fixtureExecutable("hanging-codex", "sleep 30");
    const check = createCodexCredentialCheck({ bin, authFile: join(dir, "nope"), timeoutMs: 200 });
    const started = Date.now();
    await expect(check()).resolves.toMatchObject({ ok: false, needsUserAction: "start-oauth" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("mapCodexNotification", () => {
  const map = (method: string, params: Record<string, unknown> = {}): ProviderStreamEvent[] =>
    mapCodexNotification(method, params);

  it("maps agent message deltas to text-delta events", () => {
    expect(map("item/agentMessage/delta", { delta: "hi" })).toEqual([{ type: "text-delta", delta: "hi" }]);
  });

  it("maps reasoning deltas (text + summary) to reasoning-delta events", () => {
    expect(map("item/reasoning/textDelta", { delta: "think" })).toEqual([{ type: "reasoning-delta", delta: "think" }]);
    expect(map("item/reasoning/summaryTextDelta", { delta: "sum" })).toEqual([
      { type: "reasoning-delta", delta: "sum" },
    ]);
  });

  it("maps token usage updates, reading both camelCase and snake_case fields", () => {
    expect(map("thread/tokenUsage/updated", { usage: { inputTokens: 10, outputTokens: 4 } })).toEqual([
      { type: "usage", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: undefined } },
    ]);
    expect(map("thread/tokenUsage/updated", { input_tokens: 7, output_tokens: 2 })).toEqual([
      { type: "usage", usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: undefined } },
    ]);
  });

  it("maps error notifications to error events with a fallback message", () => {
    expect(map("error", { message: "boom" })).toEqual([{ type: "error", message: "boom" }]);
    expect(map("error", {})).toEqual([{ type: "error", message: "codex error" }]);
  });

  it("reads the v2 ErrorNotification shape and maps a retried error to a non-terminal status", () => {
    const error = { message: "rate limited", codexErrorInfo: null, additionalDetails: null, misalignment: null };
    expect(map("error", { error, willRetry: false, threadId: "t", turnId: "u" })).toEqual([
      { type: "error", message: "rate limited" },
    ]);
    expect(map("error", { error, willRetry: true, threadId: "t", turnId: "u" })).toEqual([
      { type: "status", status: "streaming", message: "Retrying: rate limited" },
    ]);
  });

  it("maps turn/completed to a done event", () => {
    expect(map("turn/completed", {})).toEqual([{ type: "done", stopReason: "stop" }]);
  });

  it("maps Codex command execution item lifecycle to tool call/result events", () => {
    const commandItem = {
      type: "commandExecution",
      id: "cmd-1",
      command: "pwd",
      cwd: "/tmp",
      processId: null,
      source: "exec",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "/tmp\n",
      exitCode: 0,
      durationMs: 12,
    };

    expect(map("item/started", { item: commandItem })).toEqual([
      {
        type: "tool-call",
        id: "cmd-1",
        toolName: "command",
        args: { command: "pwd", cwd: "/tmp", source: "exec" },
      },
    ]);
    expect(map("item/completed", { item: commandItem })).toEqual([
      {
        type: "tool-result",
        id: "cmd-1",
        result: { output: "/tmp\n", exitCode: 0, status: "completed", durationMs: 12 },
        isError: false,
      },
    ]);
  });

  it("maps Codex MCP and dynamic tool lifecycle events to tool call/result events", () => {
    expect(
      map("item/started", {
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "filesystem",
          tool: "read_file",
          status: "in_progress",
          arguments: { path: "README.md" },
          pluginId: null,
          result: null,
          error: null,
          durationMs: null,
        },
      }),
    ).toEqual([
      {
        type: "tool-call",
        id: "mcp-1",
        toolName: "filesystem.read_file",
        args: { path: "README.md" },
      },
    ]);

    expect(
      map("item/completed", {
        item: {
          type: "dynamicToolCall",
          id: "dyn-1",
          namespace: "codex",
          tool: "apply_patch",
          arguments: { path: "src/a.ts" },
          status: "completed",
          contentItems: [{ type: "inputText", text: "patched" }],
          success: true,
          durationMs: 3,
        },
      }),
    ).toEqual([
      {
        type: "tool-result",
        id: "dyn-1",
        result: { contentItems: [{ type: "inputText", text: "patched" }], status: "completed", durationMs: 3 },
        isError: false,
      },
    ]);
  });

  it("does not emit tool events for completed assistant message items", () => {
    expect(
      map("item/completed", {
        item: {
          type: "agentMessage",
          id: "msg-1",
          text: "hello",
          phase: null,
          memoryCitation: null,
        },
      }),
    ).toEqual([]);
  });

  it("emits nothing for empty deltas or unhandled methods", () => {
    expect(map("item/agentMessage/delta", { delta: "" })).toEqual([]);
    expect(map("turn/started", { turn: { id: "t1" } })).toEqual([]);
    expect(map("item/unknown/event", {})).toEqual([]);
  });
});
