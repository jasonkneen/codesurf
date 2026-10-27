// Session lifecycle functions — abort, new session, resume, delete —
// extracted from use-turn-engine.ts.
//
// These are session-management operations that don't need the stream
// functions directly, except for clearLiveTurnUi which is passed in
// from useTurnStream.

import type { KeyEvent } from "@opentui/core";
import { useCallback } from "react";
import type { Agent } from "../../agent/agent";
import { resetEditApprovalSession } from "../../core/plugins/builtin/file-tools-approval";
import { abortRemoteTurn } from "../../server/attach";
import { useApproval } from "../context/approval-context.js";
import { useComposer } from "../context/composer-context.js";
import { useConversationState } from "../context/conversation-state-context.js";
import { useModalVisibility } from "../context/modal-context.js";
import { useModel } from "../context/model-context.js";
import { useQueue } from "../context/queue-context.js";
import { useRunningAgents } from "../context/running-agents-context.js";
import { useServerMode } from "../context/server-mode-context.js";
import { useTelegram } from "../context/telegram-context.js";
import { initialPlanQuestionsState } from "../plan";
import { buildAssistantEntry, buildSystemEntry, markTelegramTurnStopped } from "../telegram-turn-ui";
import { collectTurnStats, formatTurnSummary } from "../turn-summary.js";
import { invalidateActiveRun } from "./turn-ownership.js";

export function useSessionLifecycle(agent: Agent, clearLiveTurnUi: () => void) {
  const {
    setMessages,
    setJustStopped,
    justStoppedTimerRef,
    startTimeRef,
    setTodoPlan,
    setPendingQuestionnaire,
    setAgentRoster,
    setSessionTitle,
    setSessionId,
    setSessionRecap,
    setActivePlan,
    setExpandedMessages,
    setPqs,
    isProcessingRef,
    setIsProcessing,
    activeRunIdRef,
    interruptedRunIdRef,
    cancelledRunIdsRef,
    activeTurnRef,
  } = useConversationState();

  const { coordinatorRef, stoppedTelegramTurnKeysRef } = useTelegram();

  const { remoteFront } = useServerMode();

  const { setPendingEditApproval } = useApproval();

  const { setShowSessionsModal, setSessionsSearchQuery, setSessionsModalIndex, setSessionsList } = useModalVisibility();

  const { setModel, setModelAdapterId, setModeState } = useModel();

  const { replacePasteBlocks } = useComposer();

  const { setQueuedMessages, setQueueFocusId, queuedMessagesRef } = useQueue();

  const { setAgentsFooterFocused, setShowAgentsPopup, setAgentModalId, setAgentModalSnapshot } = useRunningAgents();

  // ── abortActiveRun ────────────────────────────────────────────────────

  // Ctrl+X stops the active agent run. Decoupled from Esc on purpose: Esc only
  // closes dialogs, Ctrl+X is the deliberate "stop the task" gesture.
  const abortActiveRun = useCallback(
    (key?: KeyEvent) => {
      if (!isProcessingRef.current) return false;
      key?.preventDefault?.();
      key?.stopPropagation?.();
      // Take ownership away from the run first: a turn still awaiting prompt
      // preparation must not start the agent afterwards, and a late finish
      // must not touch the successor's accumulators or transcript.
      const stoppedRunId = activeRunIdRef.current;
      const stoppedTurn = activeTurnRef.current;
      invalidateActiveRun({ activeRunIdRef, interruptedRunIdRef, cancelledRunIdsRef });
      // A stopped Telegram turn can still emit a late chunk; without this the
      // bridge handlers would re-open a live turn no `done` will ever close.
      markTelegramTurnStopped(stoppedTelegramTurnKeysRef, stoppedTurn);
      queuedMessagesRef.current = [];
      setQueuedMessages([]);
      setQueueFocusId(null);
      const activeAgent = activeTurnRef.current?.agent ?? agent;
      activeTurnRef.current = null;
      clearLiveTurnUi();
      // Record the interruption in the transcript: how long it ran and what
      // it managed to do. Tagged with the stopped run so the next rebuild
      // drops it together with that run's other optimistic rows.
      const elapsedMs = startTimeRef.current > 0 ? Date.now() - startTimeRef.current : 0;
      setMessages((prev) => [
        ...prev,
        buildSystemEntry(
          formatTurnSummary({ outcome: "stopped", elapsedMs, ...collectTurnStats(prev, stoppedRunId) }),
          "summary",
          { modeColor: stoppedTurn?.modeColor },
        ),
      ]);
      activeAgent.abort();
      // On a server the turn runs on the node, out of the local agent's reach.
      abortRemoteTurn(remoteFront, agent.getSessionId());
      // Abort must be authoritative, not advisory. Previously this only called
      // agent.abort() and trusted the generator to unwind into finalizeActiveTurn
      // — the one place that released the processing latch. When the turn is
      // wedged that never happens: a provider that ignores the abort signal, or
      // a turn still parked on the coordinator queue that never entered the agent
      // at all. The latch stayed true, and `processMessage` early-returns on
      // `if (isProcessingRef.current) return`, so Ctrl+X left the user
      // permanently locked out. Release it ourselves, and drop the coordinator
      // queue so a wedged turn can't hold the next one hostage.
      coordinatorRef.current.reset();
      isProcessingRef.current = false;
      setIsProcessing(false);
      // Surface the post-stop banner (Resume / Dismiss). Auto-clear after
      // ~8s so it doesn't linger if the user just moves on with a new prompt.
      setJustStopped(true);
      if (justStoppedTimerRef.current) clearTimeout(justStoppedTimerRef.current);
      justStoppedTimerRef.current = setTimeout(() => setJustStopped(false), 8000);
      return true;
    },
    [
      agent,
      clearLiveTurnUi,
      setQueuedMessages,
      setQueueFocusId,
      queuedMessagesRef,
      justStoppedTimerRef.current,
      activeTurnRef,
      justStoppedTimerRef,
      isProcessingRef.current, // Surface the post-stop banner (Resume / Dismiss). Auto-clear after
      // ~8s so it doesn't linger if the user just moves on with a new prompt.
      setJustStopped,
      activeRunIdRef,
      interruptedRunIdRef,
      cancelledRunIdsRef,
      isProcessingRef,
      setIsProcessing,
      coordinatorRef,
      stoppedTelegramTurnKeysRef,
      startTimeRef,
      setMessages,
      remoteFront,
    ],
  );

  // ── haltTurnForSessionSwap ────────────────────────────────────────────

  // /clear, new session and resume replace the transcript under a running
  // turn. Stop that turn first, through the same path as Ctrl+X (take run
  // ownership, abort, drop the coordinator queue, release the processing
  // latch), otherwise the old turn keeps streaming into the new session. No
  // "stopped" summary or Resume banner: the session it belongs to is gone.
  const haltTurnForSessionSwap = useCallback(() => {
    if (!isProcessingRef.current) return;
    const activeAgent = activeTurnRef.current?.agent ?? agent;
    invalidateActiveRun({ activeRunIdRef, interruptedRunIdRef, cancelledRunIdsRef });
    markTelegramTurnStopped(stoppedTelegramTurnKeysRef, activeTurnRef.current);
    activeTurnRef.current = null;
    activeAgent.abort();
    // Before the swap: the node turn belongs to the session being left.
    abortRemoteTurn(remoteFront, agent.getSessionId());
    coordinatorRef.current.reset();
    isProcessingRef.current = false;
    setIsProcessing(false);
  }, [
    agent,
    remoteFront,
    activeTurnRef,
    activeRunIdRef,
    interruptedRunIdRef,
    cancelledRunIdsRef,
    coordinatorRef,
    stoppedTelegramTurnKeysRef,
    isProcessingRef,
    setIsProcessing,
  ]);

  // ── resetToNewSession ─────────────────────────────────────────────────

  const resetToNewSession = useCallback(() => {
    haltTurnForSessionSwap();
    const snapshot = agent.startNewSession();
    setMessages(snapshot?.entries ?? []);
    setExpandedMessages(new Set());
    activeTurnRef.current = null;
    clearLiveTurnUi();
    setSessionTitle(snapshot?.session.title ?? null);
    setSessionId(snapshot?.session.id ?? agent.getSessionId());
    setSessionRecap(agent.getSessionRecap());
    setActivePlan(null);
    setTodoPlan(null);
    setAgentRoster([]);
    setPendingQuestionnaire(null);
    setPqs(initialPlanQuestionsState());
    replacePasteBlocks([]);
    queuedMessagesRef.current = [];
    setQueuedMessages([]);
    setQueueFocusId(null);
    // Drop any running-subagents footer focus / drill-down on session reset.
    setAgentsFooterFocused(false);
    setShowAgentsPopup(false);
    setAgentModalId(null);
    setAgentModalSnapshot(null);
    setPendingEditApproval(null);
    resetEditApprovalSession();
  }, [
    agent,
    haltTurnForSessionSwap,
    clearLiveTurnUi,
    replacePasteBlocks,
    setPendingEditApproval,
    setAgentModalSnapshot,
    setShowAgentsPopup,
    setAgentsFooterFocused,
    setAgentModalId,
    setQueuedMessages,
    setQueueFocusId,
    queuedMessagesRef,
    setSessionRecap,
    setTodoPlan,
    setPendingQuestionnaire,
    setAgentRoster,
    setPqs,
    setSessionTitle,
    setMessages,
    setActivePlan,
    activeTurnRef,
    setExpandedMessages,
    setSessionId,
  ]);

  // ── resumeSessionFromModal ────────────────────────────────────────────

  const resumeSessionFromModal = useCallback(
    (id: string) => {
      try {
        haltTurnForSessionSwap();
        const snapshot = agent.resumeSession(id);
        setMessages(snapshot.entries);
        setExpandedMessages(new Set());
        activeTurnRef.current = null;
        clearLiveTurnUi();
        setSessionTitle(snapshot.session.title ?? null);
        setSessionId(snapshot.session.id);
        setModel(agent.getModel());
        setModelAdapterId(agent.getModelAdapterId());
        setModeState(agent.getMode());
        setActivePlan(null);
        setPqs(initialPlanQuestionsState());
        replacePasteBlocks([]);
        queuedMessagesRef.current = [];
        setQueuedMessages([]);
        setQueueFocusId(null);
        setShowSessionsModal(false);
        setSessionsSearchQuery("");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Refresh the list so a stale daemon-generated ID disappears from view
        const next = agent.listSessions({ limit: 200 });
        setSessionsList(next);
        setSessionsModalIndex((i) => Math.max(0, Math.min(i, next.length - 1)));
        // Surface a clean one-line notice without polluting the transcript
        setMessages((prev) => [
          ...prev,
          buildAssistantEntry(
            `Session resume failed: ${message}. The session may belong to a different workspace or daemon job.`,
          ),
        ]);
      }
    },
    [
      agent,
      haltTurnForSessionSwap,
      clearLiveTurnUi,
      replacePasteBlocks,
      setShowSessionsModal,
      setSessionsSearchQuery,
      setSessionsModalIndex,
      setSessionsList,
      setModelAdapterId,
      setModel,
      setModeState,
      setQueuedMessages,
      setQueueFocusId,
      queuedMessagesRef,
      setExpandedMessages,
      activeTurnRef,
      setSessionId,
      setActivePlan,
      setSessionTitle, // Surface a clean one-line notice without polluting the transcript
      setMessages,
      setPqs,
    ],
  );

  // ── deleteSessionFromModal ────────────────────────────────────────────

  const deleteSessionFromModal = useCallback(
    (id: string) => {
      agent.deleteSession(id);
      const next = agent.listSessions({ limit: 200 });
      setSessionsList(next);
      setSessionsModalIndex((i) => Math.max(0, Math.min(i, next.length - 1)));
      if (id === agent.getSessionId()) {
        const snapshot = agent.getSessionSnapshot();
        if (snapshot) {
          setMessages(snapshot.entries);
          setSessionId(snapshot.session.id);
          setSessionTitle(snapshot.session.title ?? null);
          setModel(agent.getModel());
          setModelAdapterId(agent.getModelAdapterId());
          setModeState(agent.getMode());
        }
      }
    },
    [
      agent,
      setSessionsModalIndex,
      setSessionsList,
      setModelAdapterId,
      setModel,
      setModeState,
      setSessionTitle,
      setSessionId,
      setMessages,
    ],
  );

  return {
    abortActiveRun,
    resetToNewSession,
    resumeSessionFromModal,
    deleteSessionFromModal,
  };
}
