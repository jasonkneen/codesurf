import type { TextareaRenderable } from "@opentui/core";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../agent/agent";
import {
  type ActiveTurnState,
  type FileMentionBlock,
  getFileMentionToken,
  getPasteBlockToken,
  type PasteBlock,
} from "../app-helpers";
import type { QueuedSubmission } from "./queue-submissions";
import type { ProcessMessageOptions } from "./use-turn-engine";
import type { PromptHistoryHandle } from "./usePromptHistory";

// Render-free harness (see use-plan-actions.test.ts): hooks run once outside
// React with useCallback as identity, useRef as a plain box and useEffect run
// inline; every context returns a shared, controlled snapshot so the real
// composer submit path, the real queue drain (useTurnStream.finishTurnProcessing)
// and the real send-now dispatcher (useQueueActions) operate on one queue.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(fn: T) => fn,
    useRef: <T>(init: T) => ({ current: init }),
    useEffect: (fn: () => unknown) => {
      fn();
    },
  };
});

const h = vi.hoisted(() => {
  const inputText = { current: "" };
  const input = {
    get plainText() {
      return inputText.current;
    },
    setText(text: string) {
      inputText.current = text;
    },
    clear() {
      inputText.current = "";
    },
    insertText(text: string) {
      inputText.current += text;
    },
    requestRender() {},
    focus() {},
    cursorOffset: 0,
  };
  const inputRef = { current: input };
  const conv = {
    setMessages: vi.fn(),
    setIsProcessing: vi.fn(),
    setLiveTurnSourceLabel: vi.fn(),
    setSessionTitle: vi.fn(),
    setSessionId: vi.fn(),
    setSessionRecap: vi.fn(),
    setActivePlan: vi.fn(),
    setActiveSubagent: vi.fn(),
    setPqs: vi.fn(),
    contentAccRef: { current: "" },
    reasoningAccRef: { current: "" },
    startTimeRef: { current: 0 },
    toolStartTimesRef: { current: new Map() },
    scrollRef: { current: null },
    transcriptAutoFollowRef: { current: true },
    isProcessingRef: { current: false },
    shellModeRef: { current: false },
    pasteBlocksRef: { current: [] as PasteBlock[] },
    pasteCounterRef: { current: 0 },
    activeRunIdRef: { current: 0 },
    interruptedRunIdRef: { current: null as number | null },
    cancelledRunIdsRef: { current: new Set<number>() },
    activeTurnRef: { current: null as ActiveTurnState | null },
  };
  const queue = {
    queueFocusId: null as string | null,
    setQueueFocusId: vi.fn(),
    queueFocusIdRef: { current: null as string | null },
    queuedMessagesRef: { current: [] as QueuedSubmission[] },
    setQueuedMessages: vi.fn(),
    nextQueueIdRef: { current: 0 },
  };
  const composer = {
    inputRef,
    commitComposer: vi.fn(() => input.clear()),
    promptHistory: null as PromptHistoryHandle | null,
    replacePasteBlocks: vi.fn((next: PasteBlock[]) => {
      conv.pasteBlocksRef.current = next;
    }),
    insertDroppedFilePaths: vi.fn(() => false),
    fileMentionBlocksRef: { current: [] as FileMentionBlock[] },
  };
  const agents = {
    setAgentsFooterFocused: vi.fn(),
    agentsFooterFocusedRef: { current: false },
    showAgentsPopupRef: { current: false },
    agentModalIdRef: { current: null as string | null },
  };
  const approval = {
    setActiveToolCalls: vi.fn(),
    pendingToolApprovalRef: { current: null as { approvalId: string } | null },
    pendingEditApprovalRef: { current: null as { approvalId: string } | null },
    pendingPaymentApprovalRef: { current: null as { approvalId?: string } | null },
  };
  const coordinator = { reset: vi.fn() };
  const telegram = {
    telegramEntryCountsRef: { current: new Map<number, number>() },
    coordinatorRef: { current: coordinator },
    stoppedTelegramTurnKeysRef: { current: new Set<string>() },
  };
  const expand = vi.fn<(text: string, cwd: string) => Promise<{ enhancedMessage: string; mentionedFiles: string[] }>>();
  const host = { mentions: { expand }, models: { getProvider: vi.fn() } };
  const recordPrompt = vi.fn();
  const serverMode = {
    remoteFront: null as null | { client: { abort: (session: string) => void }; sessionId: string; url: string },
  };
  return {
    serverMode,
    inputText,
    input,
    inputRef,
    conv,
    queue,
    composer,
    agents,
    approval,
    coordinator,
    telegram,
    expand,
    host,
    recordPrompt,
  };
});

vi.mock("../context/conversation-state-context.js", () => ({ useConversationState: () => h.conv }));
vi.mock("../context/queue-context.js", () => ({ useQueue: () => h.queue }));
vi.mock("../context/composer-context.js", () => ({ useComposer: () => h.composer }));
vi.mock("../context/running-agents-context.js", () => ({ useRunningAgents: () => h.agents }));
vi.mock("../context/approval-context.js", () => ({ useApproval: () => h.approval }));
vi.mock("../context/telegram-context.js", () => ({ useTelegram: () => h.telegram }));
vi.mock("../context/server-mode-context.js", () => ({ useServerMode: () => h.serverMode }));
vi.mock("../context/model-context.js", () => ({
  useModel: () => ({ contextStatsRef: { current: null } }),
}));
vi.mock("../../core/plugins", () => ({ getHostServices: () => h.host }));
vi.mock("../../storage/prompt-history", () => ({
  loadPromptHistory: () => [],
  recordPrompt: (options: unknown) => h.recordPrompt(options),
}));

import { useComposerActions } from "./use-composer-actions";
import { useQueueActions } from "./use-queue-actions";
import { useTurnStream } from "./use-turn-stream";
import { usePromptHistory } from "./usePromptHistory";

type ProcessMessage = (text: string, displayText?: string, options?: ProcessMessageOptions) => void;

function deferredExpansion() {
  let resolve!: (enhancedMessage: string) => void;
  const promise = new Promise<{ enhancedMessage: string; mentionedFiles: string[] }>((res) => {
    resolve = (enhancedMessage) => res({ enhancedMessage, mentionedFiles: [] });
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

const agent = { getCwd: () => "/repo", abort: vi.fn(), getSessionId: () => "s9" } as unknown as Agent;

// Named as a hook: it composes the real hooks under test (rules-of-hooks lint).
function useHarness() {
  const processMessage = vi.fn<ProcessMessage>();
  const processMessageRef = { current: processMessage };
  h.composer.promptHistory = usePromptHistory(
    h.inputRef as unknown as RefObject<TextareaRenderable | null>,
    "workspace-test",
  );
  const stream = useTurnStream(processMessageRef);
  const queueActions = useQueueActions({ agent, clearLiveTurnUi: stream.clearLiveTurnUi, processMessageRef });
  const composerActions = useComposerActions(
    agent,
    processMessage,
    () => false,
    () => {},
    {
      dispatchQueueHead: queueActions.dispatchQueueHead,
      dispatchQueueAt: queueActions.dispatchQueueAt,
      openAgentsPopup: vi.fn(),
      openApiKeyModal: vi.fn(),
      scrollToBottom: vi.fn(),
      spawnInlineTerminal: vi.fn(),
      activeModelAdapterId: "claude",
      activeModelCanRun: true,
    },
  );
  return {
    processMessage,
    handleSubmit: composerActions.handleSubmit,
    finishTurnProcessing: stream.finishTurnProcessing,
    dispatchQueueHead: queueActions.dispatchQueueHead,
    promptHistory: h.composer.promptHistory,
  };
}

const queuedTexts = () => h.queue.queuedMessagesRef.current.map((m) => m.text);

beforeEach(() => {
  h.inputText.current = "";
  h.conv.isProcessingRef.current = false;
  h.conv.activeRunIdRef.current = 0;
  h.conv.interruptedRunIdRef.current = null;
  h.conv.cancelledRunIdsRef.current = new Set();
  h.conv.activeTurnRef.current = null;
  h.conv.pasteBlocksRef.current = [];
  h.conv.pasteCounterRef.current = 0;
  h.composer.fileMentionBlocksRef.current = [];
  h.queue.queuedMessagesRef.current = [];
  h.queue.nextQueueIdRef.current = 0;
  h.queue.queueFocusId = null;
  h.expand.mockReset();
  h.recordPrompt.mockReset();
  h.conv.setIsProcessing.mockReset();
  h.queue.setQueuedMessages.mockReset();
  h.approval.pendingToolApprovalRef.current = null;
  h.approval.pendingEditApprovalRef.current = null;
  h.approval.pendingPaymentApprovalRef.current = null;
  h.coordinator.reset.mockReset();
  h.serverMode.remoteFront = null;
});

describe("UI1 — queued submissions reserve their slot before mention expansion", () => {
  it("starts a submission whose expansion is still pending when the running turn finishes", async () => {
    const t = useHarness();
    h.conv.isProcessingRef.current = true; // A is running
    const b = deferredExpansion();
    h.expand.mockImplementationOnce(() => b.promise);

    h.input.setText("B @src/b.ts");
    t.handleSubmit();

    // The slot is reserved synchronously; the expansion has not resolved.
    expect(queuedTexts()).toEqual(["B @src/b.ts"]);
    expect(h.queue.setQueuedMessages).toHaveBeenCalledWith(h.queue.queuedMessagesRef.current);
    expect(t.processMessage).not.toHaveBeenCalled();

    // A finishes while B is still preparing: B must start automatically.
    t.finishTurnProcessing();

    expect(t.processMessage).toHaveBeenCalledTimes(1);
    const [text, displayText, options] = t.processMessage.mock.calls[0]!;
    expect(text).toBe("B @src/b.ts");
    expect(displayText).toBe("B @src/b.ts");
    expect(h.queue.queuedMessagesRef.current).toEqual([]);
    // Processing did not go idle with B stranded in the queue.
    expect(h.conv.setIsProcessing).not.toHaveBeenCalledWith(false);

    b.resolve("B <expanded b.ts>");
    await expect(options!.prepareText!()).resolves.toBe("B <expanded b.ts>");
    expect(h.expand).toHaveBeenCalledWith("B @src/b.ts", "/repo");
  });

  it("keeps Enter order when a later submission's expansion completes first", async () => {
    const t = useHarness();
    h.conv.isProcessingRef.current = true;
    const b = deferredExpansion();
    const c = deferredExpansion();
    h.expand.mockImplementationOnce(() => b.promise).mockImplementationOnce(() => c.promise);

    h.input.setText("B @b");
    t.handleSubmit();
    h.input.setText("C @c");
    t.handleSubmit();
    expect(h.queue.queuedMessagesRef.current.map((m) => m.id)).toEqual(["q0", "q1"]);
    expect(queuedTexts()).toEqual(["B @b", "C @c"]);

    // Reverse completion order.
    c.resolve("C expanded");
    await flush();
    b.resolve("B expanded");
    await flush();
    expect(queuedTexts()).toEqual(["B @b", "C @c"]);

    t.finishTurnProcessing(); // A finished -> B
    t.finishTurnProcessing(); // B finished -> C
    expect(t.processMessage.mock.calls.map((call) => call[0])).toEqual(["B @b", "C @c"]);
    await expect(t.processMessage.mock.calls[0]![2]!.prepareText!()).resolves.toBe("B expanded");
    await expect(t.processMessage.mock.calls[1]![2]!.prepareText!()).resolves.toBe("C expanded");
  });

  it("forwards the pending expansion when the user promotes a queued message with send-now", async () => {
    const t = useHarness();
    h.conv.isProcessingRef.current = true;
    const b = deferredExpansion();
    h.expand.mockImplementationOnce(() => b.promise);

    h.input.setText("B @b");
    t.handleSubmit();

    expect(t.dispatchQueueHead()).toBe(true);
    expect(t.processMessage).toHaveBeenCalledTimes(1);
    const [text, , options] = t.processMessage.mock.calls[0]!;
    expect(text).toBe("B @b");
    b.resolve("B expanded");
    await expect(options!.prepareText!()).resolves.toBe("B expanded");
  });

  it("never inserts a submission still preparing at abort/reset into the replacement queue", async () => {
    const t = useHarness();
    h.conv.isProcessingRef.current = true;
    const b = deferredExpansion();
    h.expand.mockImplementationOnce(() => b.promise);

    h.input.setText("B @b");
    t.handleSubmit();
    expect(queuedTexts()).toEqual(["B @b"]);

    // abortActiveRun / resetToNewSession (use-session-lifecycle.ts) replace the
    // queue array and release the processing latch while B is still preparing.
    const replacementQueue: QueuedSubmission[] = [];
    h.queue.queuedMessagesRef.current = replacementQueue;
    h.conv.isProcessingRef.current = false;

    b.resolve("B expanded");
    await flush();
    await flush();

    expect(replacementQueue).toEqual([]);
    expect(h.queue.queuedMessagesRef.current).toBe(replacementQueue);
    expect(t.processMessage).not.toHaveBeenCalled();

    // The next idle transition has nothing to pick up either.
    t.finishTurnProcessing();
    expect(t.processMessage).not.toHaveBeenCalled();
    expect(h.conv.setIsProcessing).toHaveBeenCalledWith(false);
  });

  it("still dispatches directly when nothing is processing", () => {
    const t = useHarness();
    h.expand.mockImplementation(async (text) => ({ enhancedMessage: text, mentionedFiles: [] }));

    h.input.setText("hello");
    t.handleSubmit();

    expect(h.queue.queuedMessagesRef.current).toEqual([]);
    expect(t.processMessage).toHaveBeenCalledTimes(1);
    expect(t.processMessage.mock.calls[0]![0]).toBe("hello");
    expect(typeof t.processMessage.mock.calls[0]![2]?.prepareText).toBe("function");
  });
});

describe("UI3 — history recall replays pasted content and file mentions", () => {
  beforeEach(() => {
    h.expand.mockImplementation(async (text) => ({ enhancedMessage: text, mentionedFiles: [] }));
  });

  async function prepared(t: ReturnType<typeof useHarness>, callIndex: number): Promise<string> {
    const call = t.processMessage.mock.calls[callIndex]!;
    return call[2]?.prepareText ? await call[2].prepareText() : call[0];
  }

  it("resubmits the pasted content, not the placeholder, after Up + Enter", async () => {
    const t = useHarness();
    const pasted = "const a = 1;\nconst b = 2;\nexport { a, b };";
    const block: PasteBlock = { id: 1, content: pasted, lines: 3 };
    h.conv.pasteBlocksRef.current = [block];
    h.input.setText(`Review this: ${getPasteBlockToken(block)}`);

    t.handleSubmit();

    expect(t.processMessage).toHaveBeenCalledTimes(1);
    const first = await prepared(t, 0);
    expect(first).toBe(`Review this: ${pasted}`);
    // The backing block collection is cleared on submit — recall cannot rely on it.
    expect(h.conv.pasteBlocksRef.current).toEqual([]);
    expect(h.recordPrompt).toHaveBeenCalledWith({ workspaceId: "workspace-test", text: first });

    // Up recalls the previous prompt, Enter submits it again.
    expect(t.promptHistory.recallPrev()).toBe(true);
    expect(h.input.plainText).toBe(first);
    t.handleSubmit();

    expect(t.processMessage).toHaveBeenCalledTimes(2);
    const second = await prepared(t, 1);
    expect(second).toBe(first);
    expect(second).not.toContain("[Pasted #");
  });

  it("keeps the full path of a dropped file after Up + Enter", async () => {
    const t = useHarness();
    const fileBlock: FileMentionBlock = { id: 1, path: "/repo/src/deep/dir/config.ts" };
    h.composer.fileMentionBlocksRef.current = [fileBlock];
    h.input.setText(`Explain ${getFileMentionToken(fileBlock)} please`);

    t.handleSubmit();

    const first = await prepared(t, 0);
    expect(first).toBe("Explain @/repo/src/deep/dir/config.ts please");
    expect(h.composer.fileMentionBlocksRef.current).toEqual([]);

    expect(t.promptHistory.recallPrev()).toBe(true);
    t.handleSubmit();

    expect(t.processMessage).toHaveBeenCalledTimes(2);
    const second = await prepared(t, 1);
    expect(second).toBe(first);
    expect(second).toContain("@/repo/src/deep/dir/config.ts");
    expect(second).not.toContain("[File:");
  });

  it("records the replayable form for queued submissions too", () => {
    const t = useHarness();
    h.conv.isProcessingRef.current = true;
    const fileBlock: FileMentionBlock = { id: 2, path: "/repo/README.md" };
    h.composer.fileMentionBlocksRef.current = [fileBlock];
    h.input.setText(`Summarize ${getFileMentionToken(fileBlock)}`);

    t.handleSubmit();

    expect(queuedTexts()).toEqual(["Summarize @/repo/README.md"]);
    expect(h.recordPrompt).toHaveBeenCalledWith({ workspaceId: "workspace-test", text: "Summarize @/repo/README.md" });
  });
});

describe("queue drain vs pending tool approval", () => {
  it("holds the queue while a tool approval awaits its continuation, then drains after it", () => {
    const t = useHarness();
    h.expand.mockImplementation(async (text) => ({ enhancedMessage: text, mentionedFiles: [] }));
    h.conv.isProcessingRef.current = true;
    h.input.setText("next prompt");
    t.handleSubmit();
    expect(queuedTexts()).toEqual(["next prompt"]);

    // The ai-sdk turn ended on a tool-approval request.
    h.approval.pendingToolApprovalRef.current = { approvalId: "ap1" };
    t.finishTurnProcessing();

    expect(t.processMessage).not.toHaveBeenCalled();
    expect(queuedTexts()).toEqual(["next prompt"]);
    expect(h.conv.isProcessingRef.current).toBe(false);

    // User approves -> continuation turn runs and finishes -> queue drains.
    h.approval.pendingToolApprovalRef.current = null;
    h.conv.isProcessingRef.current = true;
    t.finishTurnProcessing();

    expect(t.processMessage).toHaveBeenCalledTimes(1);
    expect(t.processMessage.mock.calls[0]![0]).toBe("next prompt");
  });

  it("holds the queue for pending edit and payment approvals too", () => {
    const t = useHarness();
    h.expand.mockImplementation(async (text) => ({ enhancedMessage: text, mentionedFiles: [] }));
    h.conv.isProcessingRef.current = true;
    h.input.setText("queued");
    t.handleSubmit();

    h.approval.pendingEditApprovalRef.current = { approvalId: "e1" };
    t.finishTurnProcessing();
    h.approval.pendingEditApprovalRef.current = null;
    h.approval.pendingPaymentApprovalRef.current = { approvalId: "p1" };
    h.conv.isProcessingRef.current = true;
    t.finishTurnProcessing();

    expect(t.processMessage).not.toHaveBeenCalled();
    expect(queuedTexts()).toEqual(["queued"]);
  });
});

describe("send-now", () => {
  it("resets the turn coordinator like Ctrl+X", () => {
    const t = useHarness();
    h.expand.mockImplementation(async (text) => ({ enhancedMessage: text, mentionedFiles: [] }));
    h.conv.isProcessingRef.current = true;
    h.input.setText("urgent");
    t.handleSubmit();

    expect(t.dispatchQueueHead()).toBe(true);
    expect(h.coordinator.reset).toHaveBeenCalledTimes(1);
    expect(t.processMessage.mock.calls[0]![0]).toBe("urgent");
  });

  // Attached to a server the replaced turn runs on the node; stopping only
  // the local agent left it running and the steer was refused as busy.
  it("stops the replaced turn on the node before sending the steer", () => {
    const order: string[] = [];
    h.serverMode.remoteFront = {
      client: { abort: (session) => order.push(`node.abort:${session}`) },
      sessionId: "attach-session",
      url: "ws://node",
    };
    const t = useHarness();
    t.processMessage.mockImplementation((text) => {
      order.push(`send:${text}`);
    });
    h.expand.mockImplementation(async (text) => ({ enhancedMessage: text, mentionedFiles: [] }));
    h.conv.isProcessingRef.current = true;
    h.input.setText("do not push");
    t.handleSubmit();

    expect(t.dispatchQueueHead()).toBe(true);

    expect(order).toEqual(["node.abort:s9", "send:do not push"]);
  });
});
