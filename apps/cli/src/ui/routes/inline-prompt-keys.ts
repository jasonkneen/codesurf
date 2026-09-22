// Keyboard ownership for the inline prompt cards rendered in the transcript's
// trailing slot (questionnaire, payment / tool / edit approvals).
//
// Only one card is visible at a time, so only that card may act on keys. The
// order below MUST match the render order in session-route.tsx's trailingSlot:
// a key handler that checked approvals in a different order used to act on a
// hidden card (e.g. approve a tool that was queued behind the questionnaire).

import type { QuestionnaireTab } from "../ai-output/questionnaire-tabs";

export type InlinePromptOwner = "none" | "questionnaire" | "payment" | "tool" | "edit";

export function inlinePromptKeyOwner(state: {
  /** A modal/overlay above the cards is open; it owns the keyboard. */
  modalOpen: boolean;
  questionnaire: boolean;
  payment: boolean;
  tool: boolean;
  edit: boolean;
}): InlinePromptOwner {
  if (state.modalOpen) return "none";
  if (state.questionnaire) return "questionnaire";
  if (state.payment) return "payment";
  if (state.tool) return "tool";
  if (state.edit) return "edit";
  return "none";
}

export interface PendingQuestionnaire {
  tabs: QuestionnaireTab[];
  title?: string;
}

/**
 * Record an answer on one tab. When every tab is answered the questionnaire
 * closes (`next: null`) and `submitText` carries the message to send. Pure, so
 * the caller performs the send outside any setState updater.
 */
export function applyQuestionnaireAnswer(
  questionnaire: PendingQuestionnaire,
  tabId: string,
  optionIndex: number,
): { next: PendingQuestionnaire | null; submitText?: string } {
  const nextTabs = questionnaire.tabs.map((tab) => {
    if (tab.id !== tabId) return tab;
    const opt = tab.question.options[optionIndex];
    return {
      ...tab,
      status: "answered" as const,
      question: {
        ...tab.question,
        selectedIndex: optionIndex,
        answer: opt?.answerLabel ?? opt?.label ?? "",
      },
    };
  });
  if (nextTabs.every((tab) => tab.status === "answered")) {
    const lines = nextTabs.map((tab) => `- ${tab.title}: ${tab.question.answer ?? "(no answer)"}`);
    return { next: null, submitText: `Answered:\n${lines.join("\n")}` };
  }
  return { next: { ...questionnaire, tabs: nextTabs } };
}
