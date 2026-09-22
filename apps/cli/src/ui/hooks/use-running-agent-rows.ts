import { useEffect, useMemo } from "react";
import type { Agent } from "../../agent/agent";
import type { DelegationRun, DelegationStatus, SubagentStatus } from "../../types/index";
import { sameRunningDelegations } from "../app-helpers";
import { useConversationState } from "../context/conversation-state-context.js";
import { useRunningAgents } from "../context/running-agents-context.js";
import { useTelegram } from "../context/telegram-context.js";
import type { RunningAgentRow } from "../running-agents";
import { INLINE_AGENT_ID } from "../running-agents";
import { buildSystemEntry } from "../telegram-turn-ui";

export const ACTIVE_DELEGATION_POLL_MS = 1_500;
export const IDLE_DELEGATION_POLL_MS = 10_000;

type DelegationPollAgent = Pick<Agent, "consumeBackgroundNotifications" | "getDelegationRuns">;

export interface DelegationPollSnapshot {
  runningDelegations: DelegationRun[] | null;
  notifications: string[];
}

/** Project the live inline sub-agent and the polled delegations into footer
 *  rows. The inline row carries its own `startedAt` so its elapsed clock reads
 *  the same as a delegation's instead of staying blank. */
export function buildRunningAgentRows(
  activeSubagent: SubagentStatus | null,
  runningDelegations: DelegationRun[],
): RunningAgentRow[] {
  const rows: RunningAgentRow[] = [];
  if (activeSubagent) {
    rows.push({
      id: INLINE_AGENT_ID,
      kind: "inline",
      agent: activeSubagent.agent,
      description: activeSubagent.description,
      detail: activeSubagent.detail,
      status: "running",
      startedAt: activeSubagent.startedAt,
    });
  }
  for (const run of runningDelegations) {
    rows.push({
      id: run.id,
      kind: "delegation",
      agent: run.agent,
      description: run.description,
      status: run.status,
      title: run.title,
      startedAt: run.startedAt,
    });
  }
  return rows;
}

/** Keep running task feedback prompt, but stop both filesystem scans from
 * repeatedly waking the idle TUI. */
export function getDelegationPollInterval({
  isProcessing,
  hasRunningDelegations,
  hasOpenDelegationModal,
}: {
  isProcessing: boolean;
  hasRunningDelegations: boolean;
  hasOpenDelegationModal: boolean;
}): number {
  return isProcessing || hasRunningDelegations || hasOpenDelegationModal
    ? ACTIVE_DELEGATION_POLL_MS
    : IDLE_DELEGATION_POLL_MS;
}

/**
 * Read the two delegation surfaces together. They intentionally settle
 * independently so a transient run-list failure cannot suppress a completed
 * task notification (or vice versa).
 */
export async function pollDelegationState(agent: DelegationPollAgent): Promise<DelegationPollSnapshot> {
  const [runsResult, notificationsResult] = await Promise.allSettled([
    agent.getDelegationRuns(),
    agent.consumeBackgroundNotifications(),
  ]);

  return {
    runningDelegations:
      runsResult.status === "fulfilled" ? runsResult.value.filter((run) => run.status === "running") : null,
    notifications: notificationsResult.status === "fulfilled" ? notificationsResult.value : [],
  };
}

export function useRunningAgentRows(agent: Agent, scrollToBottom: () => void) {
  const {
    runningDelegations,
    setRunningDelegations,
    agentsFooterFocused,
    setAgentsFooterFocused,
    agentsFooterFocusedRef,
    showAgentsPopup,
    setShowAgentsPopup,
    showAgentsPopupRef,
    agentModalId,
    agentModalIdRef,
    agentsPopupIndex,
    agentsPopupIndexRef,
    setAgentsPopupIndex,
    setAgentsNow,
    agentModalSnapshot,
    agentModalOutput,
    setAgentModalOutput,
    setAgentModalLoading,
    runningAgentRowsRef,
  } = useRunningAgents();
  const { activeSubagent, setActiveSubagent, activeTurnRef, isProcessing, setMessages } = useConversationState();
  const { telegramSubagentUnsubsRef } = useTelegram();

  useEffect(
    () =>
      agent.onSubagentStatus((status) => {
        if (activeTurnRef.current?.agent !== agent) return;
        setActiveSubagent(status);
      }),
    [agent, activeTurnRef.current?.agent, setActiveSubagent],
  );

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      const delay = getDelegationPollInterval({
        isProcessing,
        hasRunningDelegations: runningDelegations.length > 0,
        hasOpenDelegationModal: agentModalId !== null,
      });
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };

    const tick = async () => {
      const snapshot = await pollDelegationState(agent);
      if (!active) return;

      if (snapshot.runningDelegations) {
        const nextRunningDelegations = snapshot.runningDelegations;
        setRunningDelegations((prev) =>
          sameRunningDelegations(prev, nextRunningDelegations) ? prev : nextRunningDelegations,
        );
      }

      if (snapshot.notifications.length > 0) {
        // Background completions are notices, not answers: render them as
        // system rows so they read as status rather than model prose.
        setMessages((prev) => [...prev, ...snapshot.notifications.map((message) => buildSystemEntry(message, "info"))]);
        setTimeout(scrollToBottom, 10);
      }

      scheduleNext();
    };

    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [
    agent,
    agentModalId,
    isProcessing,
    runningDelegations.length,
    scrollToBottom,
    setMessages,
    setRunningDelegations,
  ]);

  const runningAgentRows = useMemo<RunningAgentRow[]>(
    () => buildRunningAgentRows(activeSubagent, runningDelegations),
    [activeSubagent, runningDelegations],
  );

  useEffect(() => {
    runningAgentRowsRef.current = runningAgentRows;
  }, [runningAgentRows, runningAgentRowsRef]);

  useEffect(() => {
    if (runningAgentRows.length === 0) {
      setAgentsFooterFocused(false);
      setShowAgentsPopup(false);
    }
  }, [runningAgentRows.length, setAgentsFooterFocused, setShowAgentsPopup]);

  useEffect(() => {
    agentsFooterFocusedRef.current = agentsFooterFocused;
  }, [agentsFooterFocused, agentsFooterFocusedRef]);

  useEffect(() => {
    showAgentsPopupRef.current = showAgentsPopup;
  }, [showAgentsPopup, showAgentsPopupRef]);

  useEffect(() => {
    agentModalIdRef.current = agentModalId;
  }, [agentModalId, agentModalIdRef]);

  useEffect(() => {
    agentsPopupIndexRef.current = agentsPopupIndex;
  }, [agentsPopupIndex, agentsPopupIndexRef]);

  useEffect(() => {
    if (agentsPopupIndex > 0 && agentsPopupIndex >= runningAgentRows.length) {
      setAgentsPopupIndex(Math.max(0, runningAgentRows.length - 1));
    }
  }, [agentsPopupIndex, runningAgentRows.length, setAgentsPopupIndex]);

  useEffect(() => {
    if (!showAgentsPopup && agentModalId === null) return;
    setAgentsNow(Date.now());
    const id = setInterval(() => setAgentsNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [showAgentsPopup, agentModalId, setAgentsNow]);

  useEffect(() => {
    if (agentModalId === null || agentModalId === INLINE_AGENT_ID) {
      setAgentModalOutput(null);
      setAgentModalLoading(false);
      return;
    }
    let active = true;
    setAgentModalLoading(true);
    const id = agentModalId;
    const poll = () => {
      agent
        .getDelegationOutput(id)
        .then((out) => {
          if (!active) return;
          setAgentModalOutput(out);
          setAgentModalLoading(false);
        })
        .catch(() => {
          if (active) setAgentModalLoading(false);
        });
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [agent, agentModalId, setAgentModalLoading, setAgentModalOutput]);

  const agentModalRow = useMemo<RunningAgentRow | null>(() => {
    if (agentModalId === null) return null;
    const live = runningAgentRows.find((row) => row.id === agentModalId);
    if (live) return live;
    if (!agentModalSnapshot) return null;
    const status: DelegationStatus =
      agentModalOutput && /\*\*Status:\*\*\s*error/i.test(agentModalOutput) ? "error" : "complete";
    return { ...agentModalSnapshot, status };
  }, [agentModalId, runningAgentRows, agentModalSnapshot, agentModalOutput]);

  useEffect(
    () => () => {
      for (const unsubscribe of telegramSubagentUnsubsRef.current.values()) {
        unsubscribe();
      }
      telegramSubagentUnsubsRef.current.clear();
    },
    [telegramSubagentUnsubsRef.current.values, telegramSubagentUnsubsRef.current.clear],
  );

  return { runningAgentRows, agentModalRow };
}
