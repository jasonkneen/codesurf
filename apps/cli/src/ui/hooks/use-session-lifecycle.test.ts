import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../agent/agent";

// Render-free harness (see use-plan-actions.test.ts): useCallback is identity
// and every context returns a controlled snapshot.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useCallback: <T>(fn: T) => fn };
});

const h = vi.hoisted(() => {
  const events: string[] = [];
  const conv = {
    setMessages: vi.fn(),
    setJustStopped: vi.fn(),
    justStoppedTimerRef: { current: null },
    startTimeRef: { current: 0 },
    setTodoPlan: vi.fn(),
    setPendingQuestionnaire: vi.fn(),
    setAgentRoster: vi.fn(),
    setSessionTitle: vi.fn(),
    setSessionId: vi.fn(),
    setSessionRecap: vi.fn(),
    setActivePlan: vi.fn(),
    setExpandedMessages: vi.fn(),
    setPqs: vi.fn(),
    isProcessingRef: { current: false },
    setIsProcessing: vi.fn((value: boolean) => events.push(`setIsProcessing:${value}`)),
    activeRunIdRef: { current: 7 },
    interruptedRunIdRef: { current: null as number | null },
    cancelledRunIdsRef: { current: new Set<number>() },
    activeTurnRef: { current: null as unknown },
  };
  const coordinator = { reset: vi.fn(() => events.push("coordinator.reset")) };
  const stoppedTelegramTurnKeysRef = { current: new Set<string>() };
  const serverMode = {
    remoteFront: null as null | { client: { abort: (session: string) => void }; sessionId: string; url: string },
  };
  return { events, conv, coordinator, stoppedTelegramTurnKeysRef, serverMode };
});

vi.mock("../context/conversation-state-context.js", () => ({ useConversationState: () => h.conv }));
vi.mock("../context/telegram-context.js", () => ({
  useTelegram: () => ({
    coordinatorRef: { current: h.coordinator },
    stoppedTelegramTurnKeysRef: h.stoppedTelegramTurnKeysRef,
  }),
}));
vi.mock("../context/approval-context.js", () => ({ useApproval: () => ({ setPendingEditApproval: vi.fn() }) }));
vi.mock("../context/modal-context.js", () => ({
  useModalVisibility: () => ({
    setShowSessionsModal: vi.fn(),
    setSessionsSearchQuery: vi.fn(),
    setSessionsModalIndex: vi.fn(),
    setSessionsList: vi.fn(),
  }),
}));
vi.mock("../context/model-context.js", () => ({
  useModel: () => ({ setModel: vi.fn(), setModelAdapterId: vi.fn(), setModeState: vi.fn() }),
}));
vi.mock("../context/composer-context.js", () => ({ useComposer: () => ({ replacePasteBlocks: vi.fn() }) }));
vi.mock("../context/queue-context.js", () => ({
  useQueue: () => ({ setQueuedMessages: vi.fn(), setQueueFocusId: vi.fn(), queuedMessagesRef: { current: [] } }),
}));
vi.mock("../context/running-agents-context.js", () => ({
  useRunningAgents: () => ({
    setAgentsFooterFocused: vi.fn(),
    setShowAgentsPopup: vi.fn(),
    setAgentModalId: vi.fn(),
    setAgentModalSnapshot: vi.fn(),
  }),
}));
vi.mock("../../core/plugins/builtin/file-tools-approval", () => ({ resetEditApprovalSession: vi.fn() }));
vi.mock("../context/server-mode-context.js", () => ({ useServerMode: () => h.serverMode }));

import { useSessionLifecycle } from "./use-session-lifecycle";

function makeAgent() {
  const snapshot = { entries: [], session: { id: "s2", title: null } };
  return {
    abort: vi.fn(() => h.events.push("agent.abort")),
    startNewSession: vi.fn(() => {
      h.events.push("agent.startNewSession");
      return snapshot;
    }),
    resumeSession: vi.fn(() => {
      h.events.push("agent.resumeSession");
      return snapshot;
    }),
    getSessionId: () => "s2",
    getSessionRecap: () => null,
    getModel: () => "m",
    getModelAdapterId: () => "a",
    getMode: () => "agent",
    listSessions: () => [],
  };
}

describe("useSessionLifecycle session swaps during a running turn", () => {
  beforeEach(() => {
    h.events.length = 0;
    h.conv.isProcessingRef.current = true;
    h.conv.activeRunIdRef.current = 7;
    h.conv.cancelledRunIdsRef.current = new Set();
    h.conv.activeTurnRef.current = null;
  });

  it("aborts the running turn before starting a new session (/clear)", () => {
    const agent = makeAgent();
    const { resetToNewSession } = useSessionLifecycle(agent as unknown as Agent, vi.fn());

    resetToNewSession();

    expect(h.events).toEqual(["agent.abort", "coordinator.reset", "setIsProcessing:false", "agent.startNewSession"]);
    expect(h.conv.isProcessingRef.current).toBe(false);
    // The aborted run lost ownership, so a late finish cannot touch the new session.
    expect(h.conv.activeRunIdRef.current).toBe(8);
    expect(h.conv.cancelledRunIdsRef.current.has(7)).toBe(true);
  });

  it("aborts the running turn before resuming another session", () => {
    const agent = makeAgent();
    const { resumeSessionFromModal } = useSessionLifecycle(agent as unknown as Agent, vi.fn());

    resumeSessionFromModal("s2");

    expect(h.events.slice(0, 4)).toEqual([
      "agent.abort",
      "coordinator.reset",
      "setIsProcessing:false",
      "agent.resumeSession",
    ]);
  });

  it("does not abort anything when idle", () => {
    h.conv.isProcessingRef.current = false;
    const agent = makeAgent();
    const { resetToNewSession } = useSessionLifecycle(agent as unknown as Agent, vi.fn());

    resetToNewSession();

    expect(agent.abort).not.toHaveBeenCalled();
    expect(h.events).toEqual(["agent.startNewSession"]);
  });
});

describe("useSessionLifecycle Ctrl+X on a telegram turn", () => {
  it("records the stopped telegram turn so its late bridge events are dropped", () => {
    h.events.length = 0;
    h.stoppedTelegramTurnKeysRef.current = new Set();
    h.conv.isProcessingRef.current = true;
    const agent = makeAgent();
    h.conv.activeTurnRef.current = { kind: "telegram", remoteKey: "chat1:msg7", agent };
    const { abortActiveRun } = useSessionLifecycle(agent as unknown as Agent, vi.fn());

    expect(abortActiveRun()).toBe(true);

    expect(h.stoppedTelegramTurnKeysRef.current.has("chat1:msg7")).toBe(true);
    expect(h.conv.isProcessingRef.current).toBe(false);
  });
});

// Attached to a server, the turn runs on the node: aborting the local Agent
// alone left it running, so the next message was refused as busy.
describe("useSessionLifecycle on a server turn", () => {
  beforeEach(() => {
    h.events.length = 0;
    h.conv.isProcessingRef.current = true;
    h.conv.activeTurnRef.current = null;
    h.serverMode.remoteFront = {
      client: { abort: (session) => h.events.push(`node.abort:${session}`) },
      sessionId: "attach-session",
      url: "ws://node",
    };
  });
  afterEach(() => {
    h.serverMode.remoteFront = null;
  });

  it("Ctrl+X stops the turn on the node, not just the local agent", () => {
    const agent = makeAgent();
    const { abortActiveRun } = useSessionLifecycle(agent as unknown as Agent, vi.fn());

    expect(abortActiveRun()).toBe(true);

    expect(h.events).toContain("node.abort:s2");
  });

  it("/clear stops the old session's turn on the node before swapping", () => {
    const agent = makeAgent();
    const { resetToNewSession } = useSessionLifecycle(agent as unknown as Agent, vi.fn());

    resetToNewSession();

    expect(h.events).toContain("node.abort:s2");
    expect(h.events.indexOf("node.abort:s2")).toBeLessThan(h.events.indexOf("agent.startNewSession"));
  });
});
