// QuestionnaireTabs — tabbed steering questions with radio-style options
// per tab. Ported from termcast's questionnaire-tabs.tsx. Keeps its own
// state for the active tab + selected option per tab because the navigation
// is inherent to the widget; exposes an optional onAnswer callback so the
// caller can react when the selection changes.
//
// Submit mode: pass `onSubmit` and the widget appends a synthetic final tab
// (SUBMIT_TAB_ID) that reviews every pending answer and commits them in one
// go. In that mode `onAnswer` is advisory only — callers must persist from
// `onSubmit`, so that closing without submitting discards the changes.

import type { KeyEvent } from "@opentui/core";
import { useEffect, useState } from "react";
import { useFlushedKeyboard } from "../hooks/use-flushed-keyboard";
import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

/** Id of the synthetic review/confirm tab appended when `onSubmit` is set. */
export const SUBMIT_TAB_ID = "__submit";

export type QuestionnaireTabStatus = "pending" | "answered" | "recommended";

export interface QuestionnaireOption {
  id?: string;
  label: string;
  description?: string;
  recommended?: boolean;
  answerLabel?: string;
}

export interface QuestionnaireQuestion {
  prompt: string;
  options: QuestionnaireOption[];
  selectedIndex?: number;
  answer?: string;
}

export interface QuestionnaireTab {
  id: string;
  title: string;
  description?: string;
  status?: QuestionnaireTabStatus;
  question: QuestionnaireQuestion;
}

export interface QuestionnaireSummaryRow {
  tabId: string;
  title: string;
  answer: string;
}

interface QuestionnaireTabsProps {
  t: Theme;
  tabs: QuestionnaireTab[];
  title?: string;
  onAnswer?: (tabId: string, optionIndex: number) => void;
  /**
   * When provided, a synthetic review/confirm tab is appended. Fires once with
   * every answer keyed by tab id, using each option's raw `label` so the value
   * round-trips through the settings layer. Nothing is emitted until confirm.
   */
  onSubmit?: (answers: Record<string, string>) => void;
  submitLabel?: string;
  /**
   * When true the widget handles the keyboard: ←/→ (or tab/shift+tab) switch
   * tabs, ↑/↓ move the option, enter answers (or submits on the review tab),
   * esc / ctrl+c call onDismiss. Consumed keys stop propagating. Off by
   * default so embedded/showcase instances stay mouse-only.
   */
  keyboardActive?: boolean;
  onDismiss?: () => void;
}

export type QuestionnaireKeyAction =
  | { kind: "tab"; delta: 1 | -1 }
  | { kind: "option"; delta: 1 | -1 }
  | { kind: "confirm" }
  | { kind: "dismiss" };

/** Map a key to a questionnaire action, or null when the widget ignores it. */
export function questionnaireKeyAction(key: {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  sequence?: string;
}): QuestionnaireKeyAction | null {
  if (key.name === "escape" || key.sequence === "\u001b" || (key.ctrl && key.name === "c")) {
    return { kind: "dismiss" };
  }
  if (key.name === "left" || (key.name === "tab" && key.shift)) return { kind: "tab", delta: -1 };
  if (key.name === "right" || key.name === "tab") return { kind: "tab", delta: 1 };
  if (key.name === "up") return { kind: "option", delta: -1 };
  if (key.name === "down") return { kind: "option", delta: 1 };
  if (key.name === "return" || key.name === "enter" || key.name === "space") return { kind: "confirm" };
  return null;
}

export function buildSelectedOptionMap(tabs: QuestionnaireTab[]): Record<string, number> {
  return Object.fromEntries(
    tabs.map((tab) => {
      const selectedIndex =
        tab.question.selectedIndex ??
        Math.max(
          0,
          tab.question.options.findIndex((opt) => opt.recommended),
        );
      return [tab.id, selectedIndex];
    }),
  );
}

/** Resolve the option a tab currently sits on, clamped and defaulted. */
function activeOptionFor(
  tab: QuestionnaireTab,
  selected: Record<string, number>,
  defaults: Record<string, number>,
): QuestionnaireOption | undefined {
  const options = tab.question.options;
  if (options.length === 0) return undefined;
  const raw = selected[tab.id] ?? defaults[tab.id] ?? 0;
  return options[Math.max(0, Math.min(raw, options.length - 1))];
}

function realTabs(tabs: QuestionnaireTab[]): QuestionnaireTab[] {
  return tabs.filter((tab) => tab.id !== SUBMIT_TAB_ID);
}

/**
 * Rows for the review tab. Uses `answerLabel` when set because this is display
 * text — contrast with resolveAnswerLabels, which persists the raw label.
 */
export function summariseAnswers(
  tabs: QuestionnaireTab[],
  selected: Record<string, number>,
): QuestionnaireSummaryRow[] {
  const defaults = buildSelectedOptionMap(tabs);
  return realTabs(tabs).flatMap((tab) => {
    const option = activeOptionFor(tab, selected, defaults);
    if (!option) return [];
    return [{ tabId: tab.id, title: tab.title, answer: option.answerLabel ?? option.label }];
  });
}

/**
 * The values to persist on submit. Deliberately the raw `label`, since the
 * settings layer re-seeds selections by matching stored strings against option
 * labels (optionIndexForValue) — storing answerLabel would break reopen.
 */
export function resolveAnswerLabels(
  tabs: QuestionnaireTab[],
  selected: Record<string, number>,
): Record<string, string> {
  const defaults = buildSelectedOptionMap(tabs);
  const out: Record<string, string> = {};
  for (const tab of realTabs(tabs)) {
    const option = activeOptionFor(tab, selected, defaults);
    if (option) out[tab.id] = option.label;
  }
  return out;
}

export function QuestionnaireTabs({
  t,
  title = "steering questions",
  tabs,
  onAnswer,
  onSubmit,
  submitLabel = "submit answers",
  keyboardActive = false,
  onDismiss,
}: QuestionnaireTabsProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [selectedOption, setSelectedOption] = useState<Record<string, number>>(() => buildSelectedOptionMap(tabs));

  useEffect(() => {
    setSelectedOption(buildSelectedOptionMap(tabs));
    setActiveTab((current) => Math.max(0, Math.min(current, Math.max(0, tabs.length - 1))));
  }, [tabs]);

  // The review tab is synthetic: it never appears in `tabs`, carries no
  // options, and is filtered back out by summariseAnswers/resolveAnswerLabels.
  const submitTab: QuestionnaireTab = {
    id: SUBMIT_TAB_ID,
    title: "Submit",
    question: { prompt: "Review your answers", options: [] },
  };
  const displayTabs = onSubmit ? [...realTabs(tabs), submitTab] : realTabs(tabs);

  const clampedTab = Math.max(0, Math.min(activeTab, displayTabs.length - 1));
  const tab = displayTabs[clampedTab];
  // Registered before the early return below so hook order stays stable.
  useFlushedKeyboard((key: KeyEvent) => {
    if (!keyboardActive || !tab) return;
    const action = questionnaireKeyAction(key);
    if (!action) return;
    key.preventDefault?.();
    key.stopPropagation?.();
    const options = tab.question.options;
    const optionIndex = Math.max(0, Math.min(selectedOption[tab.id] ?? 0, Math.max(0, options.length - 1)));
    if (action.kind === "dismiss") {
      onDismiss?.();
    } else if (action.kind === "tab") {
      setActiveTab(Math.max(0, Math.min(displayTabs.length - 1, clampedTab + action.delta)));
    } else if (action.kind === "option") {
      if (options.length === 0) return;
      const next = Math.max(0, Math.min(options.length - 1, optionIndex + action.delta));
      setSelectedOption((prev) => ({ ...prev, [tab.id]: next }));
    } else if (tab.id === SUBMIT_TAB_ID) {
      onSubmit?.(resolveAnswerLabels(tabs, selectedOption));
    } else if (options.length > 0) {
      onAnswer?.(tab.id, optionIndex);
      setActiveTab(Math.min(displayTabs.length - 1, clampedTab + 1));
    }
  });

  if (!tab) return null;

  const isSubmitTab = tab.id === SUBMIT_TAB_ID;
  const summary = summariseAnswers(tabs, selectedOption);
  const summaryTitleWidth = summary.reduce((width, row) => Math.max(width, row.title.length), 0);

  const activeOptionIndex = Math.max(
    0,
    Math.min(selectedOption[tab.id] ?? 0, Math.max(0, tab.question.options.length - 1)),
  );
  const activeOption = tab.question.options[activeOptionIndex];
  const answerText = tab.question.answer ?? activeOption?.answerLabel ?? activeOption?.label;

  const tabStatusColor = (status: QuestionnaireTabStatus | undefined): string => {
    switch (status) {
      case "answered":
        return t.diffAddedFg;
      case "recommended":
        return t.accent;
      default:
        return t.textMuted;
    }
  };

  return (
    <AgentPanel t={t} title={title} meta={`${clampedTab + 1}/${displayTabs.length} tabs`}>
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        {displayTabs.map((item, index) => {
          const active = index === clampedTab;
          const label = item.status ? `${item.title} (${item.status})` : item.title;
          return (
            <box
              key={item.id}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={active ? t.accent : t.backgroundPanel}
              onMouseDown={() => setActiveTab(index)}
            >
              <text fg={active ? t.background : tabStatusColor(item.status)} wrapMode="none">
                {active ? <b>{label}</b> : label}
              </text>
            </box>
          );
        })}
      </box>
      <box flexDirection="column" marginTop={1}>
        <text fg={t.text}>
          <b>{tab.question.prompt}</b>
        </text>
        {tab.description && <text fg={t.textMuted}>{tab.description}</text>}
        <box flexDirection="column" marginTop={1}>
          {tab.question.options.map((option, index) => {
            const selected = activeOptionIndex === index;
            return (
              <box
                key={option.id ?? `${tab.id}-${option.label}`}
                flexDirection="column"
                backgroundColor={selected ? t.backgroundPanel : undefined}
                paddingLeft={1}
                paddingRight={1}
                onMouseDown={() => {
                  setSelectedOption((prev) => ({ ...prev, [tab.id]: index }));
                  onAnswer?.(tab.id, index);
                }}
              >
                <box flexDirection="row" height={1}>
                  <text fg={selected ? t.accent : t.textMuted} wrapMode="none">
                    {selected ? "● " : "○ "}
                  </text>
                  <text fg={t.text} wrapMode="none">
                    {selected ? <b>{option.label}</b> : option.label}
                  </text>
                  {option.recommended && (
                    <box marginLeft={1}>
                      <PanelPill t={t} label="recommended" fg={t.background} bg={t.diffAddedFg} bold />
                    </box>
                  )}
                </box>
                {option.description && (
                  <box paddingLeft={2} marginBottom={1}>
                    <text fg={t.textMuted}>{option.description}</text>
                  </box>
                )}
              </box>
            );
          })}
        </box>
        {isSubmitTab && (
          <box flexDirection="column" marginTop={1}>
            {summary.map((row) => (
              // One <text> per row with spans and an opaque bg: sibling <text>
              // in a flex row lets the transcript bleed through the gaps in
              // this overlay. Pad the full width for the same reason.
              <box key={row.tabId} height={1} backgroundColor={t.backgroundPanel}>
                <text fg={t.textMuted} bg={t.backgroundPanel} wrapMode="none">
                  {` ${row.title.padEnd(summaryTitleWidth)}   `}
                  <span style={{ fg: t.text }}>{row.answer}</span>{" "}
                </text>
              </box>
            ))}
            <box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
              <PanelPill
                t={t}
                label={submitLabel}
                fg={t.background}
                bg={t.diffAddedFg}
                bold
                onSelect={() => onSubmit?.(resolveAnswerLabels(tabs, selectedOption))}
              />
            </box>
          </box>
        )}
        {!isSubmitTab && answerText && (
          <box marginTop={1}>
            <text fg={t.textMuted}>{"current answer: "}</text>
            <text fg={t.text}>
              <b>{answerText}</b>
            </text>
          </box>
        )}
        <box marginTop={1}>
          <text fg={t.textMuted}>
            {onSubmit
              ? isSubmitTab
                ? "click submit to save every answer and close · esc discards"
                : "click a tab to switch · choose an option · nothing saves until you submit"
              : keyboardActive
                ? "←/→ switch tab · ↑/↓ choose · enter answer · esc dismiss"
                : "click a tab to switch and click an option to steer the next run"}
          </text>
        </box>
      </box>
    </AgentPanel>
  );
}

export function makeExampleQuestionnaireTabs(): QuestionnaireTab[] {
  return [
    {
      id: "scope",
      title: "Scope",
      description: "Clarify how wide the next change should go.",
      status: "recommended",
      question: {
        prompt: "How broad should this refactor be?",
        options: [
          {
            label: "Tight fix",
            description: "Only patch the current bug surface.",
            recommended: true,
            answerLabel: "Tight fix",
          },
          {
            label: "Module cleanup",
            description: "Fix the bug and tighten nearby code.",
          },
          {
            label: "Broader pass",
            description: "Use this as a larger architecture cleanup.",
          },
        ],
      },
    },
    {
      id: "risk",
      title: "Risk",
      description: "Choose how aggressive the agent can be.",
      status: "pending",
      question: {
        prompt: "What risk level is acceptable for this step?",
        options: [
          {
            label: "Low",
            description: "No destructive actions, minimal code movement.",
            recommended: true,
          },
          {
            label: "Medium",
            description: "Okay to refactor internals if behavior stays stable.",
          },
          {
            label: "High",
            description: "Okay to reshape APIs and migrate call sites.",
          },
        ],
      },
    },
    {
      id: "verify",
      title: "Verify",
      description: "Choose how much validation to run before reporting back.",
      status: "answered",
      question: {
        prompt: "How much verification do you want before the agent stops?",
        answer: "Standard validation before reporting back",
        options: [
          {
            label: "Targeted",
            description: "Run only the relevant focused checks.",
          },
          {
            label: "Standard",
            description: "Run lint and type checks where possible.",
            recommended: true,
          },
          {
            label: "Full",
            description: "Run the broadest practical validation sweep.",
          },
        ],
      },
    },
  ];
}
