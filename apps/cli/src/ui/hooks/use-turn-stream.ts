// Turn stream functions — the live-turn streaming/token-accumulation layer
// extracted from use-turn-engine.ts.
//
// This hook owns the per-turn streaming mechanics: scrolling, clearing live
// UI, beginning a turn, flushing/accumulating assistant deltas, showing tool
// calls and results, syncing Telegram entries, and finalizing the turn
// (DB rebuild for local turns, entry sync for Telegram). The higher-level
// processMessage loop (owned by useTurnEngine) drives these functions.
//
// processMessageRef is passed in from useTurnEngine so finishTurnProcessing
// can dispatch the next queued message without a circular dependency.

import { type RefObject, useCallback, useRef } from "react";
import type { ToolCall, ToolResult } from "../../types/index";
import { isPlanComplete } from "../ai-output/plan-update.js";
import type { ActiveTurnState } from "../app-helpers";
import { useApproval } from "../context/approval-context.js";
import { useConversationState } from "../context/conversation-state-context.js";
import { useModel } from "../context/model-context.js";
import { useQueue } from "../context/queue-context.js";
import { useTelegram } from "../context/telegram-context.js";
import { initialPlanQuestionsState } from "../plan";
import {
  getStreamReasoningStartedAt,
  setStreamContent,
  setStreamPhase,
  setStreamReasoning,
  setStreamReasoningStartedAt,
} from "../stream-store.js";
import {
  buildAssistantEntry,
  buildSystemEntry,
  buildToolResultEntry,
  decorateTelegramEntries,
  replaceTurnEntries,
} from "../telegram-turn-ui";
import { reconcileRebuiltTranscript } from "../transcript-reconcile.js";
import { collectTurnStats, formatTurnSummary } from "../turn-summary.js";
import { createAssistantStreamPreview, sanitizeAssistantContent } from "../utils/sanitize-content.js";
import { finishToolTimer, removeActiveToolCall, startToolTimers } from "./tool-timing.js";
import type { ProcessMessageOptions } from "./use-turn-engine.js";

export type ProcessMessageRef = RefObject<
  (text: string, displayText?: string, options?: ProcessMessageOptions) => Promise<void> | void
>;

export function useTurnStream(processMessageRef: ProcessMessageRef) {
  const assistantPreviewRef = useRef(createAssistantStreamPreview());
  const {
    scrollRef,
    transcriptAutoFollowRef,
    setMessages,
    setIsProcessing,
    setLiveTurnSourceLabel,
    setSessionTitle,
    setSessionId,
    setSessionRecap,
    setActivePlan,
    setTodoPlan,
    setActiveSubagent,
    setPqs,
    contentAccRef,
    reasoningAccRef,
    startTimeRef,
    toolStartTimesRef,
    isProcessingRef,
    activeTurnRef,
    cancelledRunIdsRef,
  } = useConversationState();

  const { setActiveToolCalls, pendingToolApprovalRef, pendingEditApprovalRef, pendingPaymentApprovalRef } =
    useApproval();

  const { contextStatsRef } = useModel();
  // Context tokens at turn start, so the summary can report the turn's delta.
  const turnStartTokensRef = useRef<number | null>(null);
  // First text token of the turn, for the reasoning duration.
  const firstContentAtRef = useRef<number | null>(null);

  const { setQueuedMessages, setQueueFocusId, queuedMessagesRef } = useQueue();

  const { telegramEntryCountsRef } = useTelegram();

  // ── scrollToBottom ────────────────────────────────────────────────────

  const scrollToBottom = useCallback(
    (force = false) => {
      if (!force && !transcriptAutoFollowRef.current) return;
      try {
        scrollRef.current?.scrollTo(scrollRef.current?.scrollHeight ?? 99999);
      } catch {
        /* */
      }
    },
    [scrollRef.current?.scrollHeight, scrollRef.current?.scrollTo, transcriptAutoFollowRef.current],
  );

  // ── clearLiveTurnUi ───────────────────────────────────────────────────

  const clearLiveTurnUi = useCallback(() => {
    setStreamContent("");
    setStreamReasoning("");
    setStreamPhase(null);
    setStreamReasoningStartedAt(null);
    setActiveToolCalls([]);
    toolStartTimesRef.current.clear();
    setActiveSubagent(null);
    setLiveTurnSourceLabel(null);
    contentAccRef.current = "";
    reasoningAccRef.current = "";
    assistantPreviewRef.current.reset();
  }, [
    setActiveToolCalls,
    reasoningAccRef,
    setActiveSubagent,
    setLiveTurnSourceLabel,
    contentAccRef,
    toolStartTimesRef,
  ]);

  // ── finishTurnProcessing ──────────────────────────────────────────────

  // biome-ignore lint/correctness/useExhaustiveDependencies: the ref intentionally resolves the latest queue dispatcher at invocation time.
  const finishTurnProcessing = useCallback(() => {
    // A turn that ended on a tool-approval request (ai-sdk path) is not done:
    // the user's decision resumes it via a continuation processMessage call.
    // Dispatching a queued message now would start a new turn first, and the
    // continuation would then early-return on the busy latch — the approved
    // tool never runs. Leave the queue for the continuation's own finish.
    const approvalPending =
      !!pendingToolApprovalRef.current ||
      !!pendingEditApprovalRef.current ||
      !!pendingPaymentApprovalRef.current?.approvalId;
    const nextQueued = approvalPending ? undefined : queuedMessagesRef.current.shift();
    if (nextQueued) {
      setQueuedMessages([...queuedMessagesRef.current]);
      // Focus is bound to the queue snapshot the user was navigating; any shift
      // invalidates it. Bail out so we don't keep a stale highlight pointing at
      // a row that scrolled past, or worse, at the dispatched message.
      setQueueFocusId(null);
      isProcessingRef.current = false;
      // The slot was reserved synchronously at submit time; its @-mention
      // expansion may still be pending. Hand it to the turn as deferred
      // preparation so `resolveTurnInput` awaits it under run ownership.
      void processMessageRef.current(nextQueued.text, nextQueued.displayText, { prepareText: nextQueued.prepareText });
      return;
    }

    isProcessingRef.current = false;
    setIsProcessing(false);
  }, [
    setQueuedMessages,
    queuedMessagesRef.current,
    // invalidates it. Bail out so we don't keep a stale highlight pointing at
    // a row that scrolled past, or worse, at the dispatched message.
    setQueueFocusId,
    isProcessingRef,
    setIsProcessing,
    pendingToolApprovalRef,
    pendingEditApprovalRef,
    pendingPaymentApprovalRef,
  ]);

  // ── beginLiveTurn ─────────────────────────────────────────────────────

  const beginLiveTurn = useCallback(
    (turn: Omit<ActiveTurnState, "latestAssistantText" | "flushedAssistantChars">) => {
      clearLiveTurnUi();
      activeTurnRef.current = {
        ...turn,
        latestAssistantText: "",
        flushedAssistantChars: 0,
      };
      isProcessingRef.current = true;
      setIsProcessing(true);
      setLiveTurnSourceLabel(turn.sourceLabel ?? null);
      startTimeRef.current = Date.now();
      setStreamPhase("waiting");
      turnStartTokensRef.current = contextStatsRef.current?.usedTokens ?? null;
      firstContentAtRef.current = null;
    },
    [
      clearLiveTurnUi,
      isProcessingRef,
      activeTurnRef,
      startTimeRef,
      setIsProcessing,
      setLiveTurnSourceLabel,
      contextStatsRef,
    ],
  );

  // ── flushPendingAssistantMessage ──────────────────────────────────────

  const flushPendingAssistantMessage = useCallback(() => {
    const activeTurn = activeTurnRef.current;
    if (!activeTurn) return;

    const parsedContent = sanitizeAssistantContent(contentAccRef.current);
    if (!parsedContent.content) {
      contentAccRef.current = "";
      assistantPreviewRef.current.reset();
      setStreamContent("");
      if (activeTurn.kind === "telegram") {
        activeTurn.flushedAssistantChars = activeTurn.latestAssistantText.length;
      }
      return;
    }

    setMessages((prev) => [
      ...prev,
      buildAssistantEntry(parsedContent.content, {
        modeColor: activeTurn.modeColor,
        remoteKey: activeTurn.remoteKey,
        sourceLabel: activeTurn.sourceLabel,
        followupSuggestions: parsedContent.followupSuggestions,
        runId: activeTurn.runId,
      }),
    ]);

    if (activeTurn.kind === "telegram") {
      activeTurn.flushedAssistantChars = activeTurn.latestAssistantText.length;
    }

    contentAccRef.current = "";
    assistantPreviewRef.current.reset();
    setStreamContent("");
  }, [contentAccRef, activeTurnRef.current, setMessages]);

  // ── applyLocalAssistantDelta ──────────────────────────────────────────

  // Stream deltas commit per-chunk so the user sees text flow in token by
  // token. OpenTUI already throttles *paints* to its frame rate
  // (CliRenderer.requestRender schedules ≤1 paint per minTargetFrameTime), so
  // committing per delta does NOT cause a paint per token — it only drives one
  // React reconcile per delta. Cross-tick throttling of the React commit was
  // tried twice and reverted both times: a setTimeout window made fast/cached
  // responses appear "all at once", and a per-frame commit coalescer collapsed
  // fast bursts into a single delayed flush — i.e. "not streaming". The right
  // lever is making each commit cheap (keep the streamed text in a small
  // subtree), not committing less often.
  //
  // Manual scrollToBottom on each delta is still dropped — the scrollbox
  // uses stickyScroll={true} so it's redundant and was forcing extra layout.
  const applyLocalAssistantDelta = useCallback(
    (delta: string) => {
      if (firstContentAtRef.current === null) firstContentAtRef.current = Date.now();
      contentAccRef.current += delta;
      setStreamContent(assistantPreviewRef.current.append(delta));
      setStreamPhase("writing");
    },
    [contentAccRef.current, contentAccRef],
  );

  // ── showLiveToolCalls ─────────────────────────────────────────────────

  const showLiveToolCalls = useCallback(
    (toolCalls: ToolCall[]) => {
      flushPendingAssistantMessage();
      // One timer per call: concurrent calls each report their own duration,
      // and a batch arriving while another call is still running extends the
      // active list instead of replacing it.
      startToolTimers(toolStartTimesRef.current, toolCalls, Date.now());
      setActiveToolCalls((prev) => [...prev, ...toolCalls.filter((tc) => !prev.some((p) => p.id === tc.id))]);
      setTimeout(scrollToBottom, 10);
    },
    [flushPendingAssistantMessage, scrollToBottom, setActiveToolCalls, toolStartTimesRef],
  );

  // ── appendLiveToolResult ──────────────────────────────────────────────

  const appendLiveToolResult = useCallback(
    (toolCall: ToolCall, toolResult: ToolResult) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn) return;

      const durationMs = finishToolTimer(toolStartTimesRef.current, toolCall.id, Date.now());
      setMessages((prev) => [
        ...prev,
        buildToolResultEntry(toolCall, toolResult, {
          modeColor: activeTurn.modeColor,
          remoteKey: activeTurn.remoteKey,
          sourceLabel: activeTurn.sourceLabel,
          runId: activeTurn.runId,
          durationMs,
        }),
      ]);

      if (toolResult.plan?.questions?.length) {
        setActivePlan(toolResult.plan);
        setPqs(initialPlanQuestionsState());
      }

      // Only the finished call leaves the live list; results arrive one per
      // tool, so clearing everything here blanked the chips of calls that
      // were still running.
      setActiveToolCalls((prev) => removeActiveToolCall(prev, toolCall.id));
      // Between a tool result and the model's next token we are waiting on
      // the model again, whatever it was doing before the tool ran.
      setStreamPhase("waiting");
      setTimeout(scrollToBottom, 10);
    },
    [scrollToBottom, setActiveToolCalls, activeTurnRef.current, toolStartTimesRef, setPqs, setMessages, setActivePlan],
  );

  // ── pushSystemRow ─────────────────────────────────────────────────────

  // UI-only notice row (error / summary / info) tagged with the live run so
  // the post-turn rebuild can keep it under the right turn.
  const pushSystemRow = useCallback(
    (content: string, kind: "error" | "info" | "summary") => {
      const activeTurn = activeTurnRef.current;
      setMessages((prev) => [
        ...prev,
        buildSystemEntry(content, kind, {
          modeColor: activeTurn?.modeColor,
          remoteKey: activeTurn?.remoteKey,
          runId: activeTurn?.runId,
        }),
      ]);
    },
    [activeTurnRef, setMessages],
  );

  // ── syncTelegramTurnEntries ───────────────────────────────────────────

  const syncTelegramTurnEntries = useCallback(
    (activeTurn: ActiveTurnState) => {
      if (activeTurn.kind !== "telegram" || activeTurn.userId === undefined || !activeTurn.remoteKey) return;

      const currentEntries = activeTurn.agent.getChatEntries();
      const syncedCount = telegramEntryCountsRef.current.get(activeTurn.userId) ?? 0;
      if (currentEntries.length <= syncedCount) return;

      const delta = decorateTelegramEntries(currentEntries.slice(syncedCount), activeTurn.userId, activeTurn.remoteKey);
      telegramEntryCountsRef.current.set(activeTurn.userId, currentEntries.length);
      setMessages((prev) => replaceTurnEntries(prev, activeTurn.remoteKey!, delta));
    },
    [setMessages, telegramEntryCountsRef.current.set, telegramEntryCountsRef.current.get],
  );

  // ── finalizeActiveTurn ────────────────────────────────────────────────

  const finalizeActiveTurn = useCallback(
    ({ wasInterrupted = false, hadError = false }: { wasInterrupted?: boolean; hadError?: boolean } = {}) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn) {
        finishTurnProcessing();
        return;
      }

      const finalAssistant = sanitizeAssistantContent(contentAccRef.current);
      const finalContent = finalAssistant.content;
      const finalReasoning = reasoningAccRef.current;
      const reasoningStartedAt = getStreamReasoningStartedAt();
      const reasoningDurationMs =
        reasoningStartedAt !== null
          ? Math.max(0, (firstContentAtRef.current ?? Date.now()) - reasoningStartedAt)
          : undefined;
      if (!wasInterrupted && finalContent) {
        setMessages((prev) => [
          ...prev,
          buildAssistantEntry(finalContent, {
            modeColor: activeTurn.modeColor,
            remoteKey: activeTurn.remoteKey,
            sourceLabel: activeTurn.sourceLabel,
            reasoningText: finalReasoning,
            reasoningDurationMs,
            followupSuggestions: finalAssistant.followupSuggestions,
            runId: activeTurn.runId,
          }),
        ]);
      }

      // Turn-end summary. Errors already produced their own row and an
      // interrupt is summarised by the abort path, so only a completed local
      // turn gets the ✓ line. Token delta comes from the agent's own context
      // accounting now that the turn's messages are appended.
      if (!wasInterrupted && !hadError && activeTurn.kind === "local") {
        const elapsedMs = startTimeRef.current > 0 ? Date.now() - startTimeRef.current : 0;
        const contextWindow = contextStatsRef.current?.contextWindow;
        const before = turnStartTokensRef.current;
        let tokenDelta: number | undefined;
        if (contextWindow && before !== null) {
          try {
            tokenDelta = activeTurn.agent.getContextStats(contextWindow).usedTokens - before;
          } catch {
            tokenDelta = undefined;
          }
        }
        setMessages((prev) => [
          ...prev,
          buildSystemEntry(
            formatTurnSummary({ outcome: "done", elapsedMs, ...collectTurnStats(prev, activeTurn.runId), tokenDelta }),
            "summary",
            { modeColor: activeTurn.modeColor, runId: activeTurn.runId },
          ),
        ]);
      }

      if (!wasInterrupted && !hadError) {
        if (activeTurn.kind === "local" && activeTurn.agent.getSessionId()) {
          setMessages((prev) =>
            // Carry in-memory display text / reasoning forward onto the
            // DB-rebuilt rows, skipping rows left behind by cancelled runs so
            // the ordinal pairing cannot attribute a cancelled prompt or its
            // reasoning to this turn. See transcript-reconcile.ts.
            reconcileRebuiltTranscript(prev, activeTurn.agent.getChatEntries(), cancelledRunIdsRef.current),
          );
          setSessionTitle(activeTurn.agent.getSessionTitle());
          setSessionId(activeTurn.agent.getSessionId());
          setSessionRecap(activeTurn.agent.getSessionRecap());
        } else if (activeTurn.kind === "telegram") {
          syncTelegramTurnEntries(activeTurn);
        }
      }

      activeTurnRef.current = null;
      // The completed checklist has been visible through the end of the turn;
      // drop it now so the next turn starts clean.
      setTodoPlan((plan) => (plan && isPlanComplete(plan.items) ? null : plan));
      clearLiveTurnUi();
      finishTurnProcessing();
      setTimeout(scrollToBottom, 50);
    },
    [
      clearLiveTurnUi,
      finishTurnProcessing,
      scrollToBottom,
      syncTelegramTurnEntries,
      setSessionRecap,
      setSessionTitle,
      contentAccRef.current,
      reasoningAccRef.current,
      setSessionId,
      activeTurnRef.current,
      activeTurnRef,
      setMessages,
      cancelledRunIdsRef.current,
      contextStatsRef,
      startTimeRef,
      setTodoPlan,
    ],
  );

  return {
    scrollToBottom,
    clearLiveTurnUi,
    beginLiveTurn,
    showLiveToolCalls,
    appendLiveToolResult,
    finalizeActiveTurn,
    finishTurnProcessing,
    applyLocalAssistantDelta,
    flushPendingAssistantMessage,
    pushSystemRow,
  };
}
