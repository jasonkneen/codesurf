// Regression coverage for the `canUseTool` permission ordering in the Claude
// Agent SDK provider (providers review, "Claude tool permission callback
// executes a fast path before host approval").
//
// Contract under test:
//   - The host authorization decision (live permission setting, else an
//     approval prompt on the active turn) happens BEFORE any local execution.
//     Under a prompt-required policy a ripgrep-shaped Bash request performs
//     zero reads until the user approves, and none at all after a denial or
//     abort.
//   - A request with no active turn is denied unless an explicit policy
//     (yolo / dontAsk / acceptEdits) permits it — the missing controller is
//     not authorization.
//   - Under yolo / dontAsk the native ripgrep fast path still runs with no
//     prompt, exactly as before.
//
// The "approval service" is the host side of the real protocol: the
// `tool-approval-request` event on the turn controller plus
// `session.respondToToolApproval`. `executeGrep` is a spy so a read is
// observable without touching the filesystem.
import type { Query as ClaudeAgentQuery, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeGrep } from "../../../tools/grep";
import type { ProviderStreamEvent, ProviderTurnInput } from "../api";
import { AsyncPushQueue, ClaudeAgentSession } from "../native/claude-agent-provider";

// The provider writes its debug log under `os.homedir()/.grok`; point that at
// an owned temp dir so this file never touches the real home directory.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const home = fsMod.mkdtempSync(pathMod.join(actual.tmpdir(), "codesurf-claude-perm-"));
  return { ...actual, homedir: () => home };
});

vi.mock("../../../tools/grep", () => ({
  executeGrep: vi.fn(async () => ({ success: true, output: "src/a.ts:1:TODO" })),
}));

const executeGrepMock = vi.mocked(executeGrep);

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan" | "auto";

type CapturedCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string },
) => Promise<{ behavior: string; message?: string; interrupt?: boolean }>;

type ApprovalRequest = Extract<ProviderStreamEvent, { type: "tool-approval-request" }>;

function makeTurnInput(overrides: Partial<ProviderTurnInput> = {}): ProviderTurnInput {
  return {
    conversationId: "test-conv",
    providerId: "anthropic",
    adapterId: "anthropic.agent-sdk",
    modelId: "claude-sonnet-4-5",
    prompt: "hello",
    messages: [],
    ...overrides,
  };
}

function resultMessage(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: "u-r",
    session_id: "s1",
  } as unknown as SDKMessage;
}

/** Drain queued microtasks without touching timers. Enough for any eagerly
 *  started (i.e. wrongly ordered) execution to register on the spy. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function createHarness(mode: PermissionMode = "default") {
  const queue = new AsyncPushQueue<SDKMessage>();
  const events: ProviderStreamEvent[] = [];
  const pushed: SDKUserMessage[] = [];
  let resolveCaptured!: (fn: CapturedCanUseTool) => void;
  const captured = new Promise<CapturedCanUseTool>((resolve) => {
    resolveCaptured = resolve;
  });
  const query = Object.assign(queue.iterable, {
    interrupt: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setMaxThinkingTokens: vi.fn(async () => undefined),
    supportedCommands: vi.fn(async () => ({ commands: [] })),
    supportedModels: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
    streamInput: vi.fn(async () => undefined),
  }) as unknown as ClaudeAgentQuery;
  const session = new ClaudeAgentSession({
    adapterId: "anthropic.agent-sdk",
    queryFactory: (params) => {
      resolveCaptured(params.options.canUseTool as unknown as CapturedCanUseTool);
      // Drain the SDK input iterable like the subprocess would, so a synthetic
      // tool_result pushed by the native fast path is observable.
      void (async () => {
        for await (const message of params.prompt) pushed.push(message);
      })();
      return query;
    },
    options: { model: "claude-sonnet-4-5" },
    getPermissionMode: () => mode,
  });

  /** Start a turn. `events` gives the turn its own controller sink (so a
   *  replacement turn's transcript can be inspected in isolation); `abortSignal`
   *  is the host's per-turn signal (Esc / STOP). */
  const startTurn = (opts: { abortSignal?: AbortSignal; events?: ProviderStreamEvent[] } = {}): Promise<unknown> => {
    const sink = opts.events ?? events;
    const turnPromise = session.sendTurn(makeTurnInput({ abortSignal: opts.abortSignal }), {
      emit: (e) => sink.push(e),
    });
    turnPromise.catch(() => {});
    return turnPromise;
  };

  /** Emit one SDK `result` without awaiting anything — used when the first
   *  result is swallowed by the drain of a retired turn. */
  const pushResult = (): void => {
    queue.push(resultMessage());
  };

  /** Settle the active turn the way the SDK does: emit its `result`. */
  const finishTurn = async (turnPromise: Promise<unknown>): Promise<void> => {
    queue.push(resultMessage());
    await turnPromise;
  };

  const approvalRequests = (): ApprovalRequest[] =>
    events.filter((e): e is ApprovalRequest => e.type === "tool-approval-request");

  const teardown = async (): Promise<void> => {
    queue.close();
    await session.disconnect();
  };

  return { session, events, pushed, captured, startTurn, pushResult, finishTurn, approvalRequests, teardown };
}

const RG_INPUT = { command: "rg TODO src" };

const isSynthetic = (m: SDKUserMessage): boolean => (m as { isSynthetic?: boolean }).isSynthetic === true;
const isToolTraffic = (e: ProviderStreamEvent): boolean =>
  e.type === "tool-approval-request" || e.type === "tool-call" || e.type === "tool-result";

describe("ClaudeAgentSession canUseTool — authorization precedes execution", () => {
  beforeEach(() => {
    executeGrepMock.mockClear();
  });

  it("prompt-required policy: a ripgrep Bash request performs zero reads before approval, then runs natively", async () => {
    const h = createHarness("default");
    const turnPromise = h.startTurn();
    const canUseTool = await h.captured;

    const ac = new AbortController();
    const pending = canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-rg" });
    await settle();

    // The host was asked first, and nothing has been read yet.
    const [prompt] = h.approvalRequests();
    expect(prompt).toBeTruthy();
    expect(prompt?.toolName).toBe("Bash");
    expect(executeGrepMock).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.type === "tool-result")).toBe(false);

    h.session.respondToToolApproval(prompt!.approvalId, true);
    const result = await pending;

    // Approval selected the native path: exactly one read, result fed back.
    expect(executeGrepMock).toHaveBeenCalledTimes(1);
    expect(executeGrepMock.mock.calls[0]?.[0]).toEqual({ pattern: "TODO", path: "src" });
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("Ripgrep fast-path");
    expect(h.events.some((e) => e.type === "tool-call" && e.id === "tu-rg")).toBe(true);
    expect(h.events.some((e) => e.type === "tool-result" && e.id === "tu-rg" && e.isError === false)).toBe(true);
    await vi.waitFor(() => {
      expect(h.pushed.some((m) => (m as { isSynthetic?: boolean }).isSynthetic === true)).toBe(true);
    });

    await h.finishTurn(turnPromise);
    await h.teardown();
  });

  it("prompt-required policy: a denied ripgrep request performs no read at all", async () => {
    const h = createHarness("default");
    const turnPromise = h.startTurn();
    const canUseTool = await h.captured;

    const ac = new AbortController();
    const pending = canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-rg" });
    await settle();
    const [prompt] = h.approvalRequests();
    expect(prompt).toBeTruthy();

    h.session.respondToToolApproval(prompt!.approvalId, false);
    const result = await pending;

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("denied");
    expect(executeGrepMock).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.type === "tool-call" || e.type === "tool-result")).toBe(false);
    expect(h.pushed.some((m) => (m as { isSynthetic?: boolean }).isSynthetic === true)).toBe(false);

    await h.finishTurn(turnPromise);
    await h.teardown();
  });

  it("prompt-required policy: aborting the SDK tool signal while the prompt is pending denies without a read", async () => {
    const h = createHarness("default");
    const turnPromise = h.startTurn();
    const canUseTool = await h.captured;

    const ac = new AbortController();
    const pending = canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-rg" });
    await settle();
    expect(h.approvalRequests()).toHaveLength(1);

    ac.abort();
    const result = await pending;

    expect(result.behavior).toBe("deny");
    expect(executeGrepMock).not.toHaveBeenCalled();
    // The approval slot was released — a late click must be a no-op.
    expect(() => h.session.respondToToolApproval(h.approvalRequests()[0]!.approvalId, true)).not.toThrow();
    expect(executeGrepMock).not.toHaveBeenCalled();

    await h.finishTurn(turnPromise);
    await h.teardown();
  });

  it("a late request after the turn retired is denied, with no prompt and no read", async () => {
    const h = createHarness("default");
    const turnPromise = h.startTurn();
    const canUseTool = await h.captured;
    await h.finishTurn(turnPromise);
    const promptsBefore = h.approvalRequests().length;

    const ac = new AbortController();
    const rg = await canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-late-rg" });
    const write = await canUseTool(
      "Write",
      { file_path: "x.ts", content: "" },
      { signal: ac.signal, toolUseID: "tu-late-w" },
    );

    expect(rg.behavior).toBe("deny");
    expect(write.behavior).toBe("deny");
    expect(executeGrepMock).not.toHaveBeenCalled();
    expect(h.approvalRequests()).toHaveLength(promptsBefore);
    expect(h.events.some((e) => e.type === "tool-call" || e.type === "tool-result")).toBe(false);

    await h.teardown();
  });

  it("a request before any turn (SDK warmed, nothing sent) is denied under a prompt-required policy", async () => {
    const h = createHarness("default");
    await h.session.warm();
    const canUseTool = await h.captured;

    const ac = new AbortController();
    const result = await canUseTool("Bash", { command: "ls" }, { signal: ac.signal, toolUseID: "tu-init" });

    expect(result.behavior).toBe("deny");
    expect(executeGrepMock).not.toHaveBeenCalled();
    expect(h.approvalRequests()).toHaveLength(0);

    await h.teardown();
  });

  it.each([
    "bypassPermissions",
    "dontAsk",
  ] as const)("%s: a late request after the turn retired is still allowed by the explicit policy (no native path without a turn)", async (mode) => {
    const h = createHarness(mode);
    const turnPromise = h.startTurn();
    const canUseTool = await h.captured;
    await h.finishTurn(turnPromise);

    const ac = new AbortController();
    const rg = await canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-late-rg" });
    const ls = await canUseTool("Bash", { command: "ls" }, { signal: ac.signal, toolUseID: "tu-late-ls" });

    expect(rg.behavior).toBe("allow");
    expect(ls.behavior).toBe("allow");
    expect(executeGrepMock).not.toHaveBeenCalled();
    expect(h.approvalRequests()).toHaveLength(0);

    await h.teardown();
  });

  it.each([
    "bypassPermissions",
    "dontAsk",
  ] as const)("%s: an in-turn ripgrep request takes the native fast path with no prompt", async (mode) => {
    const h = createHarness(mode);
    const turnPromise = h.startTurn();
    const canUseTool = await h.captured;

    const ac = new AbortController();
    const result = await canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-rg" });

    expect(h.approvalRequests()).toHaveLength(0);
    expect(executeGrepMock).toHaveBeenCalledTimes(1);
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("Ripgrep fast-path");
    expect(h.events.some((e) => e.type === "tool-result" && e.id === "tu-rg")).toBe(true);

    await h.finishTurn(turnPromise);
    await h.teardown();
  });

  it("prompt-required policy: a non-ripgrep Bash request is allowed for the SDK after approval, never read natively", async () => {
    const h = createHarness("default");
    const turnPromise = h.startTurn();
    const canUseTool = await h.captured;

    const ac = new AbortController();
    const pending = canUseTool("Bash", { command: "ls -la" }, { signal: ac.signal, toolUseID: "tu-ls" });
    await settle();
    const [prompt] = h.approvalRequests();
    expect(prompt).toBeTruthy();
    h.session.respondToToolApproval(prompt!.approvalId, true);
    const result = await pending;

    expect(result.behavior).toBe("allow");
    expect(executeGrepMock).not.toHaveBeenCalled();

    await h.finishTurn(turnPromise);
    await h.teardown();
  });

  // ── Retired turn with a live replacement ──────────────────────────────
  // After a host abort or a steer, the SDK is still finishing turn A (the
  // session is "draining" until A's `result` arrives) while turn B is already
  // the host's active turn. Any canUseTool call in that window belongs to A;
  // it must not be authorized against B's controller, must not run natively,
  // and must not push a synthetic tool_result for A's toolUseID.

  it("a late request from a host-aborted turn is denied while its replacement turn is live", async () => {
    const h = createHarness("default");
    const abortA = new AbortController();
    const eventsA: ProviderStreamEvent[] = [];
    const turnA = h.startTurn({ abortSignal: abortA.signal, events: eventsA });
    const canUseTool = await h.captured;

    abortA.abort();
    await turnA;
    expect(eventsA.some((e) => e.type === "done" && e.stopReason === "aborted")).toBe(true);

    const eventsB: ProviderStreamEvent[] = [];
    const turnB = h.startTurn({ events: eventsB });
    await settle();

    const ac = new AbortController();
    const result = await canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-a-late" });

    expect(result.behavior).toBe("deny");
    expect(result.message).not.toContain("Ripgrep fast-path");
    expect(eventsB.filter(isToolTraffic)).toHaveLength(0);
    expect(eventsA.filter(isToolTraffic)).toHaveLength(0);
    expect(executeGrepMock).not.toHaveBeenCalled();
    await settle();
    expect(h.pushed.some(isSynthetic)).toBe(false);

    // Once A's `result` has been drained, B's own requests are authorized
    // normally — the denial is scoped to the drain window, not a lockout.
    h.pushResult();
    await settle();
    const pendingB = canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-b" });
    await settle();
    const promptsB = eventsB.filter((e): e is ApprovalRequest => e.type === "tool-approval-request");
    expect(promptsB).toHaveLength(1);
    expect(executeGrepMock).not.toHaveBeenCalled();
    h.session.respondToToolApproval(promptsB[0]!.approvalId, false);
    expect((await pendingB).behavior).toBe("deny");

    await h.finishTurn(turnB);
    await h.teardown();
  });

  it("a late request from a steered-away turn is denied while its replacement turn is live", async () => {
    const h = createHarness("default");
    const eventsA: ProviderStreamEvent[] = [];
    const turnA = h.startTurn({ events: eventsA });
    const canUseTool = await h.captured;

    // Steer: sendTurn re-entered while A is still in flight on the SDK side.
    const eventsB: ProviderStreamEvent[] = [];
    const turnB = h.startTurn({ events: eventsB });
    await turnA;
    expect(eventsA.some((e) => e.type === "done" && e.stopReason === "aborted")).toBe(true);
    await settle();

    const ac = new AbortController();
    const result = await canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-a-late" });

    expect(result.behavior).toBe("deny");
    expect(result.message).not.toContain("Ripgrep fast-path");
    expect(eventsB.filter(isToolTraffic)).toHaveLength(0);
    expect(eventsA.filter(isToolTraffic)).toHaveLength(0);
    expect(executeGrepMock).not.toHaveBeenCalled();
    await settle();
    expect(h.pushed.some(isSynthetic)).toBe(false);

    h.pushResult();
    await settle();
    const pendingB = canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-b" });
    await settle();
    const promptsB = eventsB.filter((e): e is ApprovalRequest => e.type === "tool-approval-request");
    expect(promptsB).toHaveLength(1);
    h.session.respondToToolApproval(promptsB[0]!.approvalId, false);
    expect((await pendingB).behavior).toBe("deny");

    await h.finishTurn(turnB);
    await h.teardown();
  });

  it.each([
    "bypassPermissions",
    "dontAsk",
  ] as const)("%s: a late request from a retired turn is allowed for the SDK but never run natively onto the replacement", async (mode) => {
    const h = createHarness(mode);
    const abortA = new AbortController();
    const eventsA: ProviderStreamEvent[] = [];
    const turnA = h.startTurn({ abortSignal: abortA.signal, events: eventsA });
    const canUseTool = await h.captured;

    abortA.abort();
    await turnA;
    const eventsB: ProviderStreamEvent[] = [];
    const turnB = h.startTurn({ events: eventsB });
    await settle();

    const ac = new AbortController();
    const result = await canUseTool("Bash", RG_INPUT, { signal: ac.signal, toolUseID: "tu-a-late" });

    expect(result.behavior).toBe("allow");
    expect(executeGrepMock).not.toHaveBeenCalled();
    expect(eventsB.filter(isToolTraffic)).toHaveLength(0);
    expect(eventsA.filter(isToolTraffic)).toHaveLength(0);
    await settle();
    expect(h.pushed.some(isSynthetic)).toBe(false);

    h.pushResult();
    await h.finishTurn(turnB);
    await h.teardown();
  });
});
