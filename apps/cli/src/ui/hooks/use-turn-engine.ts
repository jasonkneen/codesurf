// Turn engine — the top-level turn lifecycle hook, now a thin composer.
//
// This hook wires together the streaming layer (useTurnStream), the session
// lifecycle layer (useSessionLifecycle), and defines processMessage — the
// main agent turn loop that consumes content/reasoning/tool chunks from the
// agent generator and dispatches them to the stream functions.
//
// Sanitization helpers now live in ui/utils/sanitize-content.ts.
// Stream functions (scrollToBottom, beginLiveTurn, finalizeActiveTurn, etc.)
// live in use-turn-stream.ts.
// Session management (abort, new, resume, delete) lives in use-session-lifecycle.ts.

import { flushSync } from "@opentui/react";
import { useCallback, useEffect, useRef } from "react";
import type { Agent } from "../../agent/agent";
import { createRemoteSessionTurn } from "../../relay/session-stream";
import { TurnAbandonedError } from "../../telegram/turn-coordinator.js";
import { truncate } from "../../utils/text";
import type { AgentRosterEntry } from "../ai-output/agent-roster";
import type { PlanItemStatus } from "../ai-output/plan-update";
import {
  formatToolApprovalDetail,
  mapQuestionsToQuestionnaire,
  type RawQuestionnaire,
  riskLabelForTool,
} from "../app-helpers";
import { useApproval } from "../context/approval-context.js";
import { useConversationState } from "../context/conversation-state-context.js";
import { useModalVisibility } from "../context/modal-context.js";
import { useModel } from "../context/model-context.js";
import { useServerMode } from "../context/server-mode-context.js";
import { useTelegram } from "../context/telegram-context.js";
import {
  getStreamPhase,
  getStreamReasoningStartedAt,
  setStreamContent,
  setStreamPhase,
  setStreamReasoning,
  setStreamReasoningStartedAt,
} from "../stream-store.js";
import { buildUserEntry } from "../telegram-turn-ui";
import { resolveTurnInput } from "./turn-ownership.js";
import { useSessionLifecycle } from "./use-session-lifecycle.js";
import { useTurnStream } from "./use-turn-stream.js";

export interface ProcessMessageOptions {
  continuation?: boolean;
  /**
   * Deferred prompt preparation, such as expanding @file references. The UI
   * records the visible user message before this asynchronous work begins.
   */
  prepareText?: () => Promise<string>;
}

export function useTurnEngine(agent: Agent) {
  const { remoteFront } = useServerMode();
  const {
    setMessages,
    setIsProcessing,
    setJustStopped,
    justStoppedTimerRef,
    setTodoPlan,
    setPendingQuestionnaire,
    setAgentRoster,
    setSessionTitle,
    sessionTitle,
    contentAccRef,
    reasoningAccRef,
    activeRunIdRef,
    interruptedRunIdRef,
    isProcessingRef,
  } = useConversationState();

  const { setPendingEditApproval, setPendingPaymentApproval, setPendingToolApproval } = useApproval();

  // Wire-mode tool approvals: the node broadcasts an approval_request frame; the
  // client surfaces it as a pending tool approval so the same ApprovalCard path
  // the serverless TUI uses renders and the decision goes back over the wire.
  const { setShowApiKeyModal, setApiKeyError, showApiKeyModalRef } = useModalVisibility();

  const { modeInfoRef } = useModel();

  const { coordinatorRef } = useTelegram();

  const processMessageRef = useRef<(text: string, displayText?: string) => Promise<void> | void>(() => {});

  const {
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
  } = useTurnStream(processMessageRef);

  const { abortActiveRun, resetToNewSession, resumeSessionFromModal, deleteSessionFromModal } = useSessionLifecycle(
    agent,
    clearLiveTurnUi,
  );

  // Approvals and questionnaires render as the MessageList trailing slot.
  // They deliberately capture input, so they must also take focus visually;
  // otherwise an off-screen gate looks like a frozen composer. Bypass the
  // normal manual-scroll protection only for these explicit user decisions.
  const revealInlinePrompt = useCallback(() => {
    setTimeout(() => scrollToBottom(true), 16);
  }, [scrollToBottom]);

  // Wire-mode tool approvals: the node broadcasts an approval_request frame; the
  // client surfaces it as a pending tool approval so the same ApprovalCard path
  // the serverless TUI uses renders, and the decision goes back over the wire.
  const client = remoteFront?.client ?? null;
  useEffect(() => {
    if (!client) return;
    client.onApprovalRequest = (_sessionId, approvalId, toolName, input) => {
      setPendingToolApproval({
        toolName,
        approvalId,
        detail: formatToolApprovalDetail(toolName, (input ?? {}) as Record<string, unknown>),
        riskLabel: riskLabelForTool(toolName),
        selected: 0,
      });
      revealInlinePrompt();
    };
    return () => {
      client.onApprovalRequest = undefined;
    };
  }, [client, setPendingToolApproval, revealInlinePrompt]);

  // ── processMessage ────────────────────────────────────────────────────

  const processMessage = useCallback(
    async (text: string, displayText?: string, options?: ProcessMessageOptions) => {
      const isContinuation = !!options?.continuation;
      // For a continuation (post tool-approval), there is no user input — the
      // turn resumes from the existing message history. Skip the empty-text
      // guard, the user-entry display push, and the title-generation call.
      if (!isContinuation && !text.trim()) return;
      if (isProcessingRef.current) return;
      const runId = ++activeRunIdRef.current;
      const isStale = () => activeRunIdRef.current !== runId;
      const color = modeInfoRef.current.color;
      isProcessingRef.current = true;
      // New turn supersedes any lingering "Run stopped" banner.
      if (justStoppedTimerRef.current) {
        clearTimeout(justStoppedTimerRef.current);
        justStoppedTimerRef.current = null;
      }
      // Show the submitted message before joining the shared local/Telegram
      // turn coordinator. That coordinator can be waiting on a remote turn,
      // and putting this state update inside it made Enter appear to do
      // nothing for several seconds. OpenTUI receives input through a native
      // callback, so force this small optimistic update to commit now instead
      // of waiting for its next event-loop wake-up.
      flushSync(() => {
        setIsProcessing(true);
        setJustStopped(false);
        if (!isContinuation) {
          setMessages((prev) => [...prev, buildUserEntry((displayText ?? text).trim(), { modeColor: color, runId })]);
        }
      });
      if (!isContinuation && !sessionTitle && !remoteFront)
        agent
          .generateTitle((displayText ?? text).trim())
          .then(setSessionTitle)
          .catch(() => {});
      const turn = coordinatorRef.current.run(async () => {
        if (isStale()) return;
        beginLiveTurn({ kind: "local", agent, modeColor: color, runId });
        setTimeout(scrollToBottom, 50);
        await new Promise((r) => setTimeout(r, 0));
        let turnHadError = false;
        let turnHadAuthError = false;
        try {
          // Deferred preparation (@file expansion) can outlive an abort, and
          // `agent.abort()` only cancels a turn that has already started. A run
          // that lost ownership while preparing must never reach
          // processMessage, or it would start a fresh, un-aborted turn (tools
          // included) after the user stopped it.
          const preparedText = await resolveTurnInput({
            text,
            isContinuation,
            prepareText: options?.prepareText,
            isStale,
          });
          if (preparedText === null) return;
          // Remote turns run on the session this screen shows, so the node
          // continues it (history included) instead of a separate relay-only
          // session whose reply vanished when the turn finalized.
          const remoteSessionId = remoteFront
            ? await remoteFront.client.ensureSession(agent.getSessionId() ?? remoteFront.sessionId, {
                cwd: process.cwd(),
              })
            : null;
          // Stopped during that round trip: the node already got the abort,
          // so sending now would start the turn the user just stopped.
          if (isStale()) return;
          const turnGenerator = remoteFront
            ? createRemoteSessionTurn(remoteFront.client, remoteSessionId!, isContinuation ? "" : preparedText.trim())
            : isContinuation
              ? agent.continueAfterToolApproval()
              : agent.processMessage(preparedText.trim());
          for await (const chunk of turnGenerator) {
            if (isStale()) {
              break;
            }

            switch (chunk.type) {
              case "content":
                applyLocalAssistantDelta(chunk.content || "");
                // Yield to the event loop so React can paint between deltas.
                // Without this, fast providers (cached responses, Grok-fast,
                // local models) yield all deltas in one synchronous microtask
                // burst — React 18 auto-batching collapses every
                // setStreamContent call into a single render at end-of-burst,
                // which is why the whole response appeared "all at once" with
                // one flicker. setImmediate is a macrotask, so React commits
                // each batch separately and the user sees text flow in.
                await new Promise<void>((r) => setImmediate(r));
                break;
              case "reasoning":
                if (getStreamReasoningStartedAt() === null) setStreamReasoningStartedAt(Date.now());
                reasoningAccRef.current += chunk.content || "";
                setStreamReasoning(reasoningAccRef.current);
                setStreamPhase("thinking");
                await new Promise<void>((r) => setImmediate(r));
                break;
              case "tool_calls":
                if (chunk.toolCalls) {
                  showLiveToolCalls(chunk.toolCalls);
                  // Roster: every task/delegate call adds (or refreshes) a
                  // subagent entry keyed by tool-call id. The panel renders
                  // while at least one subagent has been spawned in this
                  // session.
                  for (const tc of chunk.toolCalls) {
                    if (tc.function.name !== "task" && tc.function.name !== "delegate") continue;
                    const args = (() => {
                      try {
                        return JSON.parse(tc.function.arguments) as {
                          agent?: string;
                          description?: string;
                        };
                      } catch {
                        return {} as { agent?: string; description?: string };
                      }
                    })();
                    const role: AgentRosterEntry["kind"] = tc.function.name === "task" ? "worker" : "builtin";
                    const name = args.agent || (tc.function.name === "task" ? "sub-agent" : "explore");
                    const description = args.description ? truncate(args.description, 100) : undefined;
                    setAgentRoster((prev) => {
                      const next = prev.filter((e) => e.id !== tc.id);
                      next.push({
                        id: tc.id,
                        name,
                        role: tc.function.name,
                        kind: role,
                        description,
                        status: "running",
                      });
                      return next;
                    });
                  }
                  // TodoWrite (Claude Agent SDK builtin) carries the plan
                  // in `input.todos: [{content, status, activeForm}]`. We
                  // mirror it into activePlan so the pinned PlanUpdate
                  // panel reflects the model's current task list in real
                  // time, with no roundtrip through the tool_result chunk.
                  for (const tc of chunk.toolCalls) {
                    if (tc.function.name !== "TodoWrite") continue;
                    const parsed = (() => {
                      try {
                        return JSON.parse(tc.function.arguments) as {
                          todos?: Array<{
                            content?: string;
                            status?: string;
                            activeForm?: string;
                          }>;
                        };
                      } catch {
                        return null;
                      }
                    })();
                    if (!parsed?.todos) continue;
                    if (parsed.todos.length === 0) {
                      setTodoPlan(null);
                      continue;
                    }
                    const items = parsed.todos.map((todo) => {
                      const raw = (todo.status ?? "pending").toLowerCase();
                      const status: PlanItemStatus =
                        raw === "completed" || raw === "done"
                          ? "completed"
                          : raw === "in_progress" || raw === "active" || raw === "running"
                            ? "in_progress"
                            : "pending";
                      // While running, the SDK includes `activeForm` — a
                      // present-tense rephrasing (e.g. "Refactoring auth").
                      // Prefer it for the in-progress row so the panel reads
                      // like a live status, not a static checklist.
                      const label =
                        status === "in_progress" && todo.activeForm ? todo.activeForm : (todo.content ?? "");
                      return { label, status };
                    });
                    // A finished checklist stays on screen with every row
                    // ticked; finalizeActiveTurn clears it at turn end. Nulling
                    // it here made the plan vanish at the moment it completed.
                    setTodoPlan({ items });
                  }
                  // ask_user_structured (kernel tool) — map the model's
                  // questions into the QuestionnaireTabs surface. The submit
                  // path (trailingSlot onAnswer) sends the answers back as a
                  // follow-up message, so we only populate state here.
                  for (const tc of chunk.toolCalls) {
                    if (tc.function.name !== "ask_user_structured") continue;
                    const parsed = (() => {
                      try {
                        return JSON.parse(tc.function.arguments) as RawQuestionnaire;
                      } catch {
                        return null;
                      }
                    })();
                    const mapped = mapQuestionsToQuestionnaire(parsed);
                    if (mapped) {
                      setPendingQuestionnaire(mapped);
                      revealInlinePrompt();
                    }
                  }
                }
                // Hermes can emit running/completed lifecycle events in the
                // same buffered SSE burst. Yield once so the running chip has
                // a paint opportunity before a following result clears it.
                await new Promise<void>((r) => setImmediate(r));
                break;
              case "questionnaire":
                // Owning-adapter structured questionnaire (Claude Agent SDK's
                // built-in `AskUserQuestion`). The adapter has already ended
                // the turn; render the questions in QuestionnaireTabs so the
                // user can answer — their selections submit as a follow-up
                // "Answered: …" message on the next turn.
                if (chunk.questionnaire) {
                  const mapped = mapQuestionsToQuestionnaire(chunk.questionnaire as RawQuestionnaire);
                  if (mapped) {
                    setPendingQuestionnaire(mapped);
                    revealInlinePrompt();
                  }
                }
                break;
              case "tool_result":
                if (chunk.toolCall && chunk.toolResult) {
                  appendLiveToolResult(chunk.toolCall, chunk.toolResult);
                  // A roster row keyed by this tool-call id has finished; mark
                  // it so a completed sub-agent stops looking like a live one.
                  const finishedId = chunk.toolCall.id;
                  const finishedOk = chunk.toolResult.success !== false;
                  setAgentRoster((prev) =>
                    prev.some((e) => e.id === finishedId)
                      ? prev.map((e) => (e.id === finishedId ? { ...e, status: finishedOk ? "done" : "error" } : e))
                      : prev,
                  );
                }
                await new Promise<void>((r) => setImmediate(r));
                break;
              case "tool_approval_request":
                if (chunk.toolCall && chunk.approvalId) {
                  let args: Record<string, unknown> = {};
                  try {
                    args = JSON.parse(chunk.toolCall.function.arguments) as Record<string, unknown>;
                  } catch {
                    /* ignore */
                  }
                  const toolName = chunk.toolCall.function.name;
                  if (toolName === "write_file" || toolName === "edit_file") {
                    setPendingEditApproval({
                      toolName,
                      approvalId: chunk.approvalId,
                      fallbackPath:
                        typeof args?.path === "string"
                          ? args.path
                          : typeof args?.file_path === "string"
                            ? args.file_path
                            : "",
                      precheck: chunk.editPrecheck,
                      selected: 0,
                    });
                    revealInlinePrompt();
                    break;
                  }
                  if (toolName === "paid_request") {
                    const pc = chunk.paymentPrecheck;
                    setPendingPaymentApproval({
                      toolName,
                      url: typeof args?.url === "string" ? args.url : "",
                      description: pc?.description ?? "",
                      security: pc?.security ?? "",
                      securityLabel: pc?.securityLabel ?? "",
                      securityUrl: pc?.securityUrl ?? "",
                      amount: pc?.amount ?? "",
                      network: pc?.network ?? "",
                      asset: pc?.asset ?? "",
                      payTo: pc?.payTo ?? "",
                      approvalId: chunk.approvalId,
                      selected: 0,
                    });
                    revealInlinePrompt();
                    break;
                  }
                  // Generic owning-adapter tool gate — render via ApprovalCard
                  // with a one-line command preview that mirrors the showcase.
                  setPendingToolApproval({
                    toolName,
                    approvalId: chunk.approvalId,
                    detail: formatToolApprovalDetail(toolName, args),
                    riskLabel: riskLabelForTool(toolName),
                    selected: 0,
                  });
                  revealInlinePrompt();
                }
                break;
              case "error":
                turnHadError = true;
                if (chunk.isAuthError) {
                  turnHadAuthError = true;
                }
                // Keep whatever the model had said so far as its own row, then
                // show the failure as a distinct system row — never as prose.
                flushPendingAssistantMessage();
                pushSystemRow(chunk.content || "Unknown error", "error");
                await new Promise<void>((r) => setImmediate(r));
                break;
              case "warning":
                // Fabrication detector flagged the model's claim. Append inline
                // so the user sees the warning attached to the message that
                // triggered it.
                contentAccRef.current += chunk.content || "";
                setStreamContent(contentAccRef.current);
                // Yield to event loop for consistent batching with content chunks
                await new Promise<void>((r) => setImmediate(r));
                break;
              case "status":
                // `connecting` is the provider spawn/attach window (1.8–3s on
                // CLI adapters) that used to read as a generic wait. Any later
                // lifecycle status hands the phase back to the stream events.
                if (chunk.status === "compacted") {
                  pushSystemRow(chunk.content || "Context compacted", "info");
                } else if (chunk.status === "connecting") {
                  setStreamPhase("connecting");
                } else if (getStreamPhase() === "connecting") {
                  setStreamPhase("waiting");
                }
                break;
              case "done":
                break;
            }
          }
        } catch (err: unknown) {
          turnHadError = true;
          if (!isStale()) {
            const message = err instanceof Error ? err.message : String(err);
            flushPendingAssistantMessage();
            pushSystemRow(message || "An unexpected error occurred.", "error");
            // Also surface the stack in stderr for diagnostics — the TUI
            // prints it to the scrollback once the agent is torn down.
            if (err instanceof Error && err.stack) {
              console.error("[grok] agent turn failed:", err.stack);
            }
          }
        }
        const wasInterrupted = interruptedRunIdRef.current === runId;
        if (isStale()) {
          // Lost ownership (abort, or queue send-now replaced us). The
          // successor run owns the shared accumulators now — clearing them here
          // used to wipe text the replacement had already streamed.
          return;
        }

        if (turnHadAuthError) {
          setApiKeyError("Your API key is invalid or expired. Please enter a new key.");
          setShowApiKeyModal(true);
          showApiKeyModalRef.current = true;
        }

        // A server-node turn wrote this session from another process; pick
        // it up before the finalize rebuild reads the transcript.
        if (remoteFront) agent.reloadTranscript();
        if (!isStale()) {
          finalizeActiveTurn({ wasInterrupted, hadError: turnHadError });
        }
        if (wasInterrupted) {
          interruptedRunIdRef.current = null;
        }
      });

      // `isProcessing` is latched true (flushSync, above) BEFORE we join the
      // coordinator, but used to be cleared only on the happy path, deep inside
      // finalizeActiveTurn. Every other exit — a throw, an abandoned queue slot,
      // the stale early-return above, a turn that simply never settles — left it
      // stuck true forever. And since processMessage early-returns on
      // `if (isProcessingRef.current) return`, a stuck latch locks the user out
      // of *every* future turn: the "Waiting... 105s" state, with no turn
      // actually running and no way back. Releasing here makes that unreachable.
      await turn
        .catch((err: unknown) => {
          // TurnAbandonedError just means abort dropped us from the coordinator
          // queue before we ever started — expected, not worth surfacing.
          if (err instanceof TurnAbandonedError) return;
          const message = err instanceof Error ? err.message : String(err);
          console.error("[grok] turn dispatch failed:", message);
        })
        .finally(() => {
          // Guarded on ownership, not just the boolean. finishTurnProcessing also
          // dispatches the next queued message, so calling it twice would shift
          // the queue again and silently drop one. By now the latch may rightly
          // belong to someone else:
          //   finalized, no queue         -> ref already false      -> skip
          //   finalized, queue dispatched -> next turn bumped runId -> stale -> skip
          //   aborted                     -> abort cleared it       -> skip
          //   hung / threw / abandoned    -> still ours             -> release
          if (!isStale() && isProcessingRef.current) {
            finishTurnProcessing();
          }
        });
    },
    [
      agent,
      appendLiveToolResult,
      applyLocalAssistantDelta,
      beginLiveTurn,
      finalizeActiveTurn,
      finishTurnProcessing,
      flushPendingAssistantMessage,
      pushSystemRow,
      scrollToBottom,
      sessionTitle,
      showLiveToolCalls,
      showApiKeyModalRef,
      setShowApiKeyModal,
      setApiKeyError,
      modeInfoRef.current.color,
      // with a one-line command preview that mirrors the showcase.
      setPendingToolApproval,
      setPendingPaymentApproval,
      setPendingEditApproval,
      setPendingQuestionnaire,
      setIsProcessing,
      contentAccRef,
      setTodoPlan,
      activeRunIdRef.current,
      setJustStopped,
      justStoppedTimerRef.current,
      activeRunIdRef,
      setAgentRoster,
      reasoningAccRef.current,
      setMessages,
      isProcessingRef.current,
      reasoningAccRef,
      revealInlinePrompt,
      isProcessingRef,
      justStoppedTimerRef,
      setSessionTitle,
      interruptedRunIdRef.current,
      interruptedRunIdRef,
      coordinatorRef.current.run,
      remoteFront?.sessionId,
      remoteFront,
    ],
  );

  // Keep processMessageRef in sync so queue dispatch and finishTurnProcessing
  // always call the latest closure.
  useEffect(() => {
    processMessageRef.current = processMessage;
  }, [processMessage]);

  return {
    processMessage,
    abortActiveRun,
    resetToNewSession,
    resumeSessionFromModal,
    deleteSessionFromModal,
    clearLiveTurnUi,
    scrollToBottom,
    beginLiveTurn,
    finalizeActiveTurn,
    showLiveToolCalls,
    appendLiveToolResult,
    processMessageRef,
  };
}
