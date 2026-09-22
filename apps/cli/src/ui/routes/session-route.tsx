import type { KeyEvent, PasteEvent, TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import os from "os";
import { memo, type RefObject, useMemo, useRef } from "react";
import type { Agent } from "../../agent/agent";
import { getModelInfo } from "../../grok/models";
import type { PlanQuestion } from "../../types/index";
import { MODES } from "../../types/index";
import { deriveFollowupSuggestions } from "../../utils/followup-suggestions";
import { Suggestion, Suggestions } from "../ai-elements/suggestion.js";
import { AgentRoster } from "../ai-output/agent-roster.js";
import { ApprovalCard } from "../ai-output/approval-card.js";
import { PlanUpdate } from "../ai-output/plan-update.js";
import { QuestionnaireTabs } from "../ai-output/questionnaire-tabs.js";
import type { RuntimeMode } from "../app-helpers";
import { STARTER_SUGGESTIONS } from "../app-helpers.js";
import { BtwOverlay } from "../components/btw-overlay.js";
import { ClaudeCodeStatusLine } from "../components/claude-code-status-line.js";
import type { ShortcutHint } from "../components/composer-shortcut-hints.js";
import { MessageList } from "../components/message-list.js";
import { SubagentActivity } from "../components/message-views.js";
import { useApproval } from "../context/approval-context.js";
import { useBtw } from "../context/btw-context.js";
import { useConversationState } from "../context/conversation-state-context.js";
import { useModalNav, useModalVisibility } from "../context/modal-context.js";
import { useModel } from "../context/model-context.js";
import { useQueue } from "../context/queue-context.js";
import { useRunningAgents } from "../context/running-agents-context.js";
import { useServerMode } from "../context/server-mode-context.js";
import { useTheme } from "../context/theme-context.js";
import { type EditApprovalDecision, EditApprovalPanel } from "../edit-approval-panel.js";
import { submitOrQueue } from "../hooks/queue-submissions.js";
import { earliestToolStart } from "../hooks/tool-timing.js";
import { useFlushedKeyboard } from "../hooks/use-flushed-keyboard.js";
import type { ProcessMessageOptions } from "../hooks/use-turn-engine.js";
import type { TypeaheadState } from "../hooks/useTypeahead.js";
import { getLayout, type LayoutContext } from "../layouts/registry.js";
import type { LocalFileLinkTarget } from "../markdown-links";
import { formatPaymentApprovalDetail } from "../payment-approval-detail.js";
import { PlanQuestionsPanel } from "../plan.js";
import type { RunningAgentRow } from "../running-agents.js";
import { filterVisibleSlashItems, type SlashMenuItem } from "../slash-menu";
import { applyQuestionnaireAnswer, inlinePromptKeyOwner } from "./inline-prompt-keys.js";

export interface SessionRouteProps {
  agent: Agent;
  processMessage: (text: string, displayText?: string, options?: ProcessMessageOptions) => Promise<void>;
  dispatchExtensionCommand: (commandName: string) => void;
  openTerminalManager: (sessionId?: string) => void;
  openFileLinkInNavigator: (target: LocalFileLinkTarget) => void;
  handleTranscriptAutoFollowChange: (enabled: boolean) => void;
  abortActiveRun: (key?: KeyEvent) => boolean | undefined;
  markPathApprovedThisSession: (absolutePath: string) => void;
  markAcceptAllThisSession: () => void;
  getFeatureFlag: (id: string) => boolean;
  inputRef: RefObject<TextareaRenderable | null>;
  typeahead: TypeaheadState;
  captureOpen: boolean;
  /** A modal/overlay sits above the inline prompt cards; they ignore keys. */
  modalOpen: boolean;
  handleSubmit: () => void;
  handlePaste: (event: PasteEvent) => void;
  runningAgentRows: RunningAgentRow[];
  footerPermissionMode: string | null;
  runtimeMode: RuntimeMode;
  composerShortcutHints: ShortcutHint[];
  composerChromeBottomTitle: string;
  compactFooterHints: boolean;
  footerRightMaxWidth: number;
  cwdIcon: string;
  shellIcon: string;
  sandboxIcon: string;
  showPlanPanel: boolean;
  planQuestions: PlanQuestion[];
  visibleSlashItems: SlashMenuItem[];
}

function SessionRouteImpl({
  agent,
  processMessage,
  dispatchExtensionCommand,
  openTerminalManager,
  openFileLinkInNavigator,
  handleTranscriptAutoFollowChange,
  abortActiveRun,
  markPathApprovedThisSession,
  markAcceptAllThisSession,
  getFeatureFlag,
  inputRef,
  typeahead,
  captureOpen,
  modalOpen,
  handleSubmit,
  handlePaste,
  runningAgentRows,
  footerPermissionMode,
  runtimeMode,
  composerShortcutHints,
  composerChromeBottomTitle,
  compactFooterHints,
  footerRightMaxWidth,
  cwdIcon,
  shellIcon,
  sandboxIcon,
  showPlanPanel,
  planQuestions,
  visibleSlashItems,
}: SessionRouteProps) {
  const {
    messages,
    expandedMessages,
    isProcessing,
    liveTurnSourceLabel,
    todoPlan,
    agentRoster,
    suggestionsDismissedAtLength,
    setSuggestionsDismissedAtLength,
    pendingQuestionnaire,
    setPendingQuestionnaire,
    scrollRef,
    toolStartTimesRef,
    startTimeRef,
    justStopped,
    setJustStopped,
    justStoppedTimerRef,
    pqs,
    showTodoPanel,
    setShowTodoPanel,
    pasteBlocks,
    shellMode,
    activeSubagent,
    isProcessingRef,
  } = useConversationState();

  const { t, uiMode } = useTheme();

  const { model, mode, sandboxMode, contextStatsRef } = useModel();
  const { openPicker: openServerPicker, remoteFront } = useServerMode();
  const modelInfo = getModelInfo(model);
  const modeInfo = MODES.find((m) => m.id === mode)!;
  const contextStats = contextStatsRef.current;
  // Re-read once per processing transition rather than per render: the line only
  // changes when a turn reports usage, and it is the only prefix-cache instrument.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed on turn boundaries, not on agent identity
  const cacheStatsLine = useMemo(() => agent.getLastCacheStatsLine(), [isProcessing]);

  const {
    pendingPaymentApproval,
    setPendingPaymentApproval,
    pendingToolApproval,
    setPendingToolApproval,
    pendingEditApproval,
    setPendingEditApproval,
    activeToolCalls,
  } = useApproval();

  const { queuedMessages, queueFocusId, queuedMessagesRef, nextQueueIdRef, setQueuedMessages } = useQueue();
  const { agentsFooterFocused } = useRunningAgents();
  const { showSlashMenu } = useModalVisibility();
  const { slashSearchQuery } = useModalNav();
  const { btwState } = useBtw();
  const { width } = useTerminalDimensions();

  const slashDisplayItems = filterVisibleSlashItems(visibleSlashItems, slashSearchQuery);

  // ── Approval key handling (moved from app.tsx handleKey) ──────────────
  // When any approval panel is open in the trailingSlot, it owns the keyboard.
  // Uses a ref so useKeyboard registers once with a stable callback; the ref
  // is updated on every render with fresh closures.
  const approvalKeyHandlerRef = useRef<(key: KeyEvent) => void>(() => {});
  approvalKeyHandlerRef.current = (key: KeyEvent) => {
    // Only the card that is actually visible may act, and none of them while
    // a modal (palette, pickers…) sits above: typing "a" into the command
    // palette used to approve the hidden tool / enable accept-all. The
    // questionnaire handles its own keys (QuestionnaireTabs keyboardActive).
    const owner = inlinePromptKeyOwner({
      modalOpen,
      questionnaire: !!pendingQuestionnaire,
      payment: !!pendingPaymentApproval,
      tool: !!pendingToolApproval,
      edit: !!pendingEditApproval,
    });
    if (owner === "edit" && pendingEditApproval) {
      if (isEscapeKey(key)) {
        const aid = pendingEditApproval.approvalId;
        setPendingEditApproval(null);
        agent.respondToToolApproval(aid, false);
        processMessage("", undefined, { continuation: true });
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.name === "up" || key.name === "down") {
        setPendingEditApproval((p) =>
          p
            ? {
                ...p,
                selected: key.name === "up" ? (p.selected + 3) % 4 : (p.selected + 1) % 4,
              }
            : p,
        );
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.name === "return") {
        const sel = pendingEditApproval.selected;
        const aid = pendingEditApproval.approvalId;
        const abs = pendingEditApproval.precheck?.absolutePath;
        setPendingEditApproval(null);
        if (sel === 3) {
          agent.respondToToolApproval(aid, false);
        } else {
          if (sel === 1 && abs) markPathApprovedThisSession(abs);
          else if (sel === 2) markAcceptAllThisSession();
          agent.respondToToolApproval(aid, true);
        }
        processMessage("", undefined, { continuation: true });
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.sequence === "p" && pendingEditApproval.precheck?.absolutePath) {
        const aid = pendingEditApproval.approvalId;
        const abs = pendingEditApproval.precheck.absolutePath;
        setPendingEditApproval(null);
        markPathApprovedThisSession(abs);
        agent.respondToToolApproval(aid, true);
        processMessage("", undefined, { continuation: true });
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.sequence === "a") {
        const aid = pendingEditApproval.approvalId;
        setPendingEditApproval(null);
        markAcceptAllThisSession();
        agent.respondToToolApproval(aid, true);
        processMessage("", undefined, { continuation: true });
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      return;
    }
    if (owner === "payment" && pendingPaymentApproval) {
      if (isEscapeKey(key)) {
        const aid = pendingPaymentApproval.approvalId;
        setPendingPaymentApproval(null);
        if (aid) {
          agent.respondToToolApproval(aid, false);
          // ai-sdk path: re-enter streamText so the denial is consumed. Owning
          // adapters are still mid-turn (isProcessing), so the continuation
          // early-returns as a no-op.
          processMessage("", undefined, { continuation: true });
        }
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.name === "up" || key.name === "down") {
        setPendingPaymentApproval((p) => (p ? { ...p, selected: p.selected === 0 ? 1 : 0 } : p));
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.name === "return") {
        const approved = pendingPaymentApproval.selected === 0;
        const aid = pendingPaymentApproval.approvalId;
        setPendingPaymentApproval(null);
        if (aid) {
          agent.respondToToolApproval(aid, approved);
          processMessage("", undefined, { continuation: true });
        }
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      return;
    }
    if (owner === "tool" && pendingToolApproval) {
      // Owning-adapter path (Claude/Codex): respondToToolApproval unblocks
      // canUseTool and the turn keeps running. ai-sdk path: also needs a
      // continuation so streamText re-runs with the tool-approval-response.
      // processMessage early-returns when isProcessing, so both paths are safe.
      const resolveToolApproval = (approved: boolean) => {
        const aid = pendingToolApproval.approvalId;
        setPendingToolApproval(null);
        if (remoteFront) {
          // Wire mode: send the decision back over the channel; the node resumes.
          remoteFront.client.approve(remoteFront.sessionId, aid, approved);
        } else {
          agent.respondToToolApproval(aid, approved);
          processMessage("", undefined, { continuation: true });
        }
      };
      if (isEscapeKey(key)) {
        resolveToolApproval(false);
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right") {
        setPendingToolApproval((p) => (p ? { ...p, selected: p.selected === 0 ? 1 : 0 } : p));
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.sequence === "a") {
        resolveToolApproval(true);
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.sequence === "d") {
        resolveToolApproval(false);
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.name === "return") {
        resolveToolApproval(pendingToolApproval.selected === 0);
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      return;
    }
  };
  useFlushedKeyboard((key: KeyEvent) => approvalKeyHandlerRef.current(key));

  const center = (
    <box
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      flexDirection="column"
      paddingBottom={1}
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <MessageList
        messages={messages}
        t={t}
        modeColor={modeInfo.color}
        expandedMessages={expandedMessages}
        onOpenTerminal={openTerminalManager}
        onOpenFileLink={openFileLinkInNavigator}
        scrollRef={scrollRef}
        onAutoFollowChange={handleTranscriptAutoFollowChange}
        liveTurnSourceLabel={liveTurnSourceLabel}
        activeToolCalls={activeToolCalls}
        isProcessing={isProcessing}
        virtualize={getFeatureFlag("render.virtualMessages")}
        showThinking={getFeatureFlag("render.thinkingBlock")}
        showLiveTools={getFeatureFlag("render.liveTools")}
        compactLiveStatus={uiMode === "claude-code"}
        liveReasoningChainOfThought={getFeatureFlag("render.reasoning.liveChainOfThought")}
        toolCallsPanel={getFeatureFlag("render.toolCalls.panel")}
        dimToolChips={getFeatureFlag("render.toolChips.dim")}
        pinnedTopSlot={
          todoPlan || agentRoster.length > 0 ? (
            <box flexDirection="column">
              {todoPlan ? <PlanUpdate t={t} plan={todoPlan} /> : null}
              {agentRoster.length > 0 ? (
                <AgentRoster
                  t={t}
                  roster={{
                    title: "session subagents",
                    entries: agentRoster,
                  }}
                />
              ) : null}
            </box>
          ) : null
        }
        idleSuggestionsSlot={(() => {
          if (suggestionsDismissedAtLength === messages.length) return null;
          const dismiss = () => setSuggestionsDismissedAtLength(messages.length);
          if (messages.length === 0) {
            return (
              <Suggestions t={t} onDismiss={dismiss}>
                {STARTER_SUGGESTIONS.map((s) => (
                  <Suggestion
                    key={s}
                    t={t}
                    suggestion={s}
                    onClick={(text) => {
                      if (text.startsWith("/")) {
                        dispatchExtensionCommand(text);
                      } else {
                        void processMessage(text);
                      }
                    }}
                  >
                    {s}
                  </Suggestion>
                ))}
              </Suggestions>
            );
          }
          const last = messages[messages.length - 1];
          if (last?.type !== "assistant") return null;
          const suggestions = deriveFollowupSuggestions(last);
          if (suggestions.length === 0) return null;
          return (
            <Suggestions t={t} onDismiss={dismiss}>
              {suggestions.map((s) => (
                <Suggestion key={s} t={t} suggestion={s} onClick={(text) => void processMessage(text)}>
                  {s}
                </Suggestion>
              ))}
            </Suggestions>
          );
        })()}
        trailingSlot={
          pendingQuestionnaire ? (
            <QuestionnaireTabs
              t={t}
              title={pendingQuestionnaire.title}
              tabs={pendingQuestionnaire.tabs}
              keyboardActive={!modalOpen}
              onDismiss={() => setPendingQuestionnaire(null)}
              onAnswer={(tabId, optionIndex) => {
                // Computed from the rendered questionnaire, not inside a
                // setState updater: the send is a side effect, and updaters
                // can run twice (StrictMode / concurrent re-render).
                const { next, submitText } = applyQuestionnaireAnswer(pendingQuestionnaire, tabId, optionIndex);
                setPendingQuestionnaire(next);
                if (submitText) {
                  // Queued behind a still-running turn instead of dropped.
                  submitOrQueue(
                    { isProcessingRef, queuedMessagesRef, nextQueueIdRef, setQueuedMessages, processMessage },
                    submitText,
                  );
                }
              }}
            />
          ) : pendingPaymentApproval ? (
            <ApprovalCard
              t={t}
              request={{
                title: pendingPaymentApproval.url || "Payment required",
                summary: pendingPaymentApproval.description || undefined,
                detail: formatPaymentApprovalDetail(pendingPaymentApproval),
                riskLabel: pendingPaymentApproval.securityLabel || undefined,
                status: "pending",
                actions: [
                  {
                    label: "Approve payment",
                    shortcut: "enter",
                    tone: pendingPaymentApproval.selected === 0 ? "safe" : "default",
                  },
                  {
                    label: "Reject",
                    shortcut: "esc",
                    tone: pendingPaymentApproval.selected === 1 ? "danger" : "default",
                  },
                ],
              }}
              onAction={(label) => {
                if (!pendingPaymentApproval.approvalId) return;
                const aid = pendingPaymentApproval.approvalId;
                const approved = label === "Approve payment";
                setPendingPaymentApproval(null);
                agent.respondToToolApproval(aid, approved);
                processMessage("", undefined, { continuation: true });
              }}
            />
          ) : pendingToolApproval ? (
            <ApprovalCard
              t={t}
              request={{
                title: `Allow ${pendingToolApproval.toolName}?`,
                detail: pendingToolApproval.detail,
                riskLabel: pendingToolApproval.riskLabel,
                status: "pending",
                actions: [
                  {
                    label: "Approve",
                    shortcut: "enter",
                    tone: pendingToolApproval.selected === 0 ? "safe" : "default",
                  },
                  {
                    label: "Deny",
                    shortcut: "esc",
                    tone: pendingToolApproval.selected === 1 ? "danger" : "default",
                  },
                ],
              }}
              onAction={(label) => {
                const aid = pendingToolApproval.approvalId;
                const approved = label === "Approve";
                setPendingToolApproval(null);
                agent.respondToToolApproval(aid, approved);
                processMessage("", undefined, { continuation: true });
              }}
            />
          ) : pendingEditApproval ? (
            <EditApprovalPanel
              t={t}
              toolName={pendingEditApproval.toolName}
              precheck={pendingEditApproval.precheck}
              fallbackPath={pendingEditApproval.fallbackPath || undefined}
              selected={pendingEditApproval.selected}
              onAction={(decision: EditApprovalDecision) => {
                const aid = pendingEditApproval.approvalId;
                const abs = pendingEditApproval.precheck?.absolutePath;
                setPendingEditApproval(null);
                if (decision === "reject") {
                  agent.respondToToolApproval(aid, false);
                  processMessage("", undefined, { continuation: true });
                  return;
                }
                if (decision === "accept-path" && abs) {
                  markPathApprovedThisSession(abs);
                } else if (decision === "accept-session") {
                  markAcceptAllThisSession();
                }
                agent.respondToToolApproval(aid, true);
                processMessage("", undefined, { continuation: true });
              }}
            />
          ) : btwState ? (
            <BtwOverlay state={btwState} theme={t} />
          ) : null
        }
      />
    </box>
  );
  const statusSlot = (
    <>
      {activeSubagent && <SubagentActivity t={t} status={activeSubagent} />}
      {/* Live status line — both layouts. The component subscribes to the
          stream phase itself so it flips thinking/writing per token without
          re-rendering this route. */}
      <ClaudeCodeStatusLine
        t={t}
        inputs={{
          activeToolCalls,
          isProcessing,
          justStopped,
          elapsedMs: startTimeRef.current > 0 ? Date.now() - startTimeRef.current : 0,
          startedAtMs: startTimeRef.current > 0 ? startTimeRef.current : undefined,
          toolStartedAtMs: activeToolCalls.length > 0 ? earliestToolStart(toolStartTimesRef.current) : undefined,
          homeDir: os.homedir(),
        }}
        onCancel={() => {
          if (isProcessing) {
            abortActiveRun();
            return;
          }
          if (justStoppedTimerRef.current) {
            clearTimeout(justStoppedTimerRef.current);
            justStoppedTimerRef.current = null;
          }
          setJustStopped(false);
        }}
      />
      {showPlanPanel && <PlanQuestionsPanel t={t} questions={planQuestions} state={pqs} />}
    </>
  );
  const layout = getLayout(uiMode);
  const ctx: LayoutContext = {
    t,
    agent,
    width,
    model,
    modelInfo,
    modeInfo,
    isProcessing,
    inputRef,
    shellMode,
    captureOpen,
    pasteBlocks,
    typeahead,
    contextStats,
    cacheStatsLine,
    onSubmit: handleSubmit,
    onPaste: handlePaste,
    statusSlot,
    queuedMessages,
    queueFocusId,
    todoPlan,
    showTodoPanel,
    onToggleTodoPanel: () => setShowTodoPanel((v) => !v),
    runningAgentRows,
    agentsFooterFocused,
    sandboxMode,
    runtimeMode,
    openServerPicker,
    footerPermissionMode,
    showSlashMenu,
    slashDisplayItems,
    composerShortcutHints,
    composerChromeBottomTitle,
    compactFooterHints,
    footerRightMaxWidth,
    cwdIcon,
    shellIcon,
    sandboxIcon,
  };
  return (
    <box flexGrow={1} flexDirection="column">
      {layout ? layout.render({ ctx, center }) : center}
    </box>
  );
}

export const SessionRoute = memo(SessionRouteImpl);

function isEscapeKey(key: KeyEvent): boolean {
  return (
    key.name === "escape" ||
    key.code === "Escape" ||
    key.baseCode === 27 ||
    key.sequence === "\u001b" ||
    key.raw === "\u001b"
  );
}
