// Regression for review finding A10 (title/recap results written to a
// different session) and the "Additional source findings" bullet on
// background-notification queueing.
//
// A10: `generateTitle` / `refreshSessionRecap` generate across awaits and then
// used the CURRENT `this.session.id` to persist title, recap and usage. Title
// generation is launched asynchronously by the UI, so switching sessions while
// it was pending applied session A's title/recap/usage to session B. Now the
// requesting session is captured up front and a stale result is discarded.
//
// Notifications: `processMessage` set `isProcessingTurn` BEFORE its boundary
// drain, so the drain queued instead of delivering and newly received
// notifications missed the current turn. Queued entries were also plain
// strings, so they survived a session switch and were spliced into the next
// session's transcript. The boundary now drains explicitly, and queue entries
// are bound to the session they arrived for.
//
// The module graph is mocked once for the suite: re-importing the agent graph
// per test blows the 5s default timeout on a loaded machine.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function emptyHookResult() {
  return { blocked: false, blockingErrors: [], commandErrors: [], additionalContexts: [] };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };
type Titled = { title: string; modelId: string; usage: Usage };
type Recapped = { recap: string; modelId: string; usage: Usage };
type Recap = { text: string; model: string; updatedAt: Date };
type Message = { role: string; content: unknown };

function makeSession(id: string) {
  return {
    id,
    workspaceId: "workspace-1",
    title: null as string | null,
    recap: null as Recap | null,
    model: "provider-model",
    mode: "agent" as const,
    cwdAtStart: "/mock/cwd",
    cwdLast: "/mock/cwd",
    status: "active" as const,
    createdAt: new Date("2026-09-05T10:00:00.000Z"),
    updatedAt: new Date("2026-09-05T10:00:00.000Z"),
  };
}

const workspace = {
  id: "workspace-1",
  scopeKey: "mock",
  canonicalPath: "/mock/cwd",
  gitRoot: null,
  displayName: "mock",
  lastSeenAt: new Date("2026-09-05T10:00:00.000Z"),
};

type AgentInternals = {
  messages: Message[];
  isProcessingTurn: boolean;
  refreshSessionRecap(signal?: AbortSignal): Promise<void>;
};

// Per-test handles the suite-level mocks read through. Reassigned by newAgent().
const gates = { title: deferred<Titled>(), recap: deferred<Recapped>() };
const sentMessages: Message[][] = [];

const generateTitle = vi.fn(() => gates.title.promise);
const generateRecap = vi.fn(() => gates.recap.promise);
const recordUsageEvent = vi.fn();
const appendMessages = vi.fn((_sessionId: string, messages: unknown[]) => messages.map(() => 0));
const sendTurn = vi.fn(async (input: { messages: Message[] }, controller: { emit: (event: unknown) => void }) => {
  sentMessages.push(input.messages.map((m) => ({ role: m.role, content: m.content })));
  controller.emit({ type: "text-delta", delta: "ok" });
  controller.emit({ type: "done" });
  return {};
});

let AgentCtor: typeof import("./agent").Agent;

beforeAll(async () => {
  vi.resetModules();

  vi.doMock("../hooks/index", async () => {
    const actual = await vi.importActual<typeof import("../hooks/index")>("../hooks/index");
    return { ...actual, executeEventHooks: vi.fn(async () => emptyHookResult()) };
  });

  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages,
    buildChatEntries: vi.fn(() => [
      { type: "user", content: "Summarize this session.", timestamp: new Date("2026-09-05T10:00:00.000Z") },
    ]),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
    loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    recordUsageEvent,
    SessionStore: class {
      getWorkspace() {
        return null;
      }
      openSession() {
        return null;
      }
      createSession() {
        return null;
      }
      setModel() {}
      getRequiredSession() {
        return null;
      }
      setMode() {}
      touchSession() {}
    },
  }));

  vi.doMock("../grok/client", async () => {
    const actual = await vi.importActual<typeof import("../grok/client")>("../grok/client");
    return { ...actual, generateTitle, generateRecap };
  });

  // A provider-owned session so a full `processMessage` turn runs without a
  // model: the sendTurn mock snapshots the messages it was handed.
  vi.doMock("../core/plugins", async () => {
    const actual = await vi.importActual<typeof import("../core/plugins")>("../core/plugins");
    return {
      ...actual,
      getEnabledToolSet: vi.fn(() => ({})),
      resolveModelRuntimeViaKernel: vi.fn(async () => ({
        model: null,
        modelId: "provider-model",
        modelInfo: undefined,
        providerOptions: undefined,
        adapterId: "provider.adapter",
        providerId: "provider",
        session: { adapterId: "provider.adapter", providerId: "provider", mode: "persistent", sendTurn },
      })),
      runtimeUsesSendTurn: vi.fn(() => true),
    };
  });

  const { setBashSink } = await import("../core/plugins");
  setBashSink(buildMockBashSink().sink);

  ({ Agent: AgentCtor } = await import("./agent"));
});

afterAll(async () => {
  vi.restoreAllMocks();
  try {
    const { setBashSink, setHooksSink } = await import("../core/plugins");
    setBashSink(null);
    setHooksSink(null);
  } catch {}
  vi.resetModules();
  vi.doUnmock("../core/plugins");
  vi.doUnmock("../grok/client");
  vi.doUnmock("../hooks/index");
  vi.doUnmock("../storage/index");
});

beforeEach(() => {
  gates.title = deferred<Titled>();
  gates.recap = deferred<Recapped>();
  sentMessages.length = 0;
  for (const fn of [generateTitle, generateRecap, recordUsageEvent, appendMessages, sendTurn]) fn.mockClear();
});

/** Fresh Agent on session A with an in-memory two-session store. */
function newAgent() {
  const agent = new AgentCtor(undefined, undefined, "provider-model", undefined, { persistSession: false });
  const sessions: Record<string, ReturnType<typeof makeSession>> = { A: makeSession("A"), B: makeSession("B") };
  const store = {
    setTitle: vi.fn((id: string, title: string | null) => {
      sessions[id]!.title = title;
    }),
    setRecap: vi.fn((id: string, recap: Recap | null) => {
      sessions[id]!.recap = recap;
    }),
    getRequiredSession: vi.fn((id: string) => sessions[id]!),
    getSessionById: vi.fn((id: string) => sessions[id] ?? null),
    getWorkspace: () => workspace,
    touchSession: vi.fn(),
  };
  const consumeNotifications = vi.fn(async (): Promise<Array<{ id: string; message: string }>> => []);
  Object.assign(agent as object, {
    apiKey: "test-key",
    session: sessions.A,
    workspace,
    sessionStore: store,
    delegations: { consumeNotifications },
  });
  return { agent, internals: agent as unknown as AgentInternals, sessions, store, consumeNotifications };
}

const usage: Usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

describe("title/recap results stay with the requesting session (A10)", () => {
  it("discards a delayed title when the session switched while it was pending", async () => {
    const { agent, sessions, store } = newAgent();

    const pending = agent.generateTitle("hello from A");
    await settle();
    expect(generateTitle).toHaveBeenCalledTimes(1);

    agent.resumeSession("B");
    expect(agent.getSessionInfo()?.id).toBe("B");

    gates.title.resolve({ title: "Title for A", modelId: "title-model", usage });
    await expect(pending).resolves.toBe("Title for A");

    expect(store.setTitle).not.toHaveBeenCalled();
    expect(recordUsageEvent).not.toHaveBeenCalled();
    expect(sessions.B!.title).toBeNull();
    expect(sessions.A!.title).toBeNull();
    expect(agent.getSessionInfo()?.id).toBe("B");
  });

  it("persists the title and its usage to the requesting session when it is still current", async () => {
    const { agent, sessions, store } = newAgent();
    const pending = agent.generateTitle("hello from A");
    await settle();
    gates.title.resolve({ title: "Title for A", modelId: "title-model", usage });
    await expect(pending).resolves.toBe("Title for A");

    expect(store.setTitle).toHaveBeenCalledWith("A", "Title for A");
    expect(recordUsageEvent).toHaveBeenCalledWith("A", "title", "title-model", usage);
    expect(sessions.A!.title).toBe("Title for A");
    expect(agent.getSessionInfo()?.title).toBe("Title for A");
  });

  it("discards a delayed recap when the session switched while it was pending", async () => {
    const { agent, internals, sessions, store } = newAgent();

    const pending = internals.refreshSessionRecap();
    await settle();
    expect(generateRecap).toHaveBeenCalledTimes(1);

    agent.resumeSession("B");
    gates.recap.resolve({ recap: "Recap of A", modelId: "recap-model", usage });
    await pending;

    expect(store.setRecap).not.toHaveBeenCalled();
    expect(recordUsageEvent).not.toHaveBeenCalled();
    expect(sessions.B!.recap).toBeNull();
    expect(agent.getSessionRecap()).toBeNull();
  });

  it("persists the recap to the requesting session when it is still current", async () => {
    const { agent, internals, store } = newAgent();
    const pending = internals.refreshSessionRecap();
    await settle();
    gates.recap.resolve({ recap: "Recap of A", modelId: "recap-model", usage });
    await pending;

    expect(store.setRecap).toHaveBeenCalledWith("A", expect.objectContaining({ text: "Recap of A" }));
    expect(recordUsageEvent).toHaveBeenCalledWith("A", "recap", "recap-model", usage);
    expect(agent.getSessionRecap()).toBe("Recap of A");
  });
});

describe("background notification delivery", () => {
  it("delivers notifications received at the turn boundary to the current turn", async () => {
    const { agent, consumeNotifications } = newAgent();
    // The end-of-turn recap would park on the recap gate; it is not under test here.
    agent.setRecapsEnabled(false);
    consumeNotifications.mockResolvedValueOnce([{ id: "d1", message: "Delegation d1 finished." }]);

    const chunks = [];
    for await (const chunk of agent.processMessage("what did d1 find?")) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(sentMessages).toHaveLength(1);
    // The notification precedes this turn's user message: the model saw it now,
    // not on some later turn. It travels as a <system-reminder> user turn — a
    // mid-conversation system message is rejected by Anthropic.
    expect(sentMessages[0]).toEqual([
      { role: "user", content: "<system-reminder>\nDelegation d1 finished.\n</system-reminder>" },
      { role: "user", content: "what did d1 find?" },
    ]);
  });

  it("drops a mid-turn notification queued for a session that is no longer current", async () => {
    const { agent, internals, consumeNotifications } = newAgent();

    // UI poll lands mid-turn on session A: returned for display, queued for
    // the next boundary rather than spliced into the live turn.
    internals.isProcessingTurn = true;
    consumeNotifications.mockResolvedValueOnce([{ id: "d1", message: "Delegation d1 finished." }]);
    await expect(agent.consumeBackgroundNotifications()).resolves.toEqual(["Delegation d1 finished."]);
    expect(internals.messages).toHaveLength(0);

    // Turn ends; the user switches to B before the next boundary.
    internals.isProcessingTurn = false;
    agent.resumeSession("B");
    await agent.consumeBackgroundNotifications();

    expect(internals.messages).toHaveLength(0);
    expect(appendMessages).not.toHaveBeenCalled();
  });

  it("delivers a mid-turn notification at the next boundary of the same session", async () => {
    const { agent, internals, consumeNotifications } = newAgent();

    internals.isProcessingTurn = true;
    consumeNotifications.mockResolvedValueOnce([{ id: "d1", message: "Delegation d1 finished." }]);
    await agent.consumeBackgroundNotifications();
    expect(internals.messages).toHaveLength(0);

    internals.isProcessingTurn = false;
    await agent.consumeBackgroundNotifications();

    const reminder = { role: "user", content: "<system-reminder>\nDelegation d1 finished.\n</system-reminder>" };
    expect(internals.messages).toEqual([reminder]);
    // Persisted in the same shape, so a reload rebuilds what the model saw.
    expect(appendMessages).toHaveBeenCalledWith("A", [reminder]);
  });
});
