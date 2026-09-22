import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { QuestionnaireTab } from "../ai-output/questionnaire-tabs";
import { applyQuestionnaireAnswer, inlinePromptKeyOwner } from "./inline-prompt-keys";

const none = { modalOpen: false, questionnaire: false, payment: false, tool: false, edit: false };

describe("inlinePromptKeyOwner", () => {
  it("gives no card the keyboard while a modal is open", () => {
    expect(inlinePromptKeyOwner({ ...none, modalOpen: true, tool: true })).toBe("none");
    expect(inlinePromptKeyOwner({ ...none, modalOpen: true, edit: true })).toBe("none");
  });

  it("gives the keyboard only to the visible card, in render order", () => {
    // Tool approval arriving during a questionnaire: its card is hidden.
    expect(inlinePromptKeyOwner({ ...none, questionnaire: true, tool: true })).toBe("questionnaire");
    // Render order is payment > tool > edit; the handler used to check edit first.
    expect(inlinePromptKeyOwner({ ...none, tool: true, edit: true })).toBe("tool");
    expect(inlinePromptKeyOwner({ ...none, payment: true, tool: true })).toBe("payment");
    expect(inlinePromptKeyOwner({ ...none, edit: true })).toBe("edit");
    expect(inlinePromptKeyOwner(none)).toBe("none");
  });

  it("matches the trailingSlot render order in session-route", () => {
    const source = readFileSync(fileURLToPath(new URL("./session-route.tsx", import.meta.url)), "utf8");
    const slot = source.slice(source.indexOf("trailingSlot={"));
    const order = [
      "pendingQuestionnaire ?",
      "pendingPaymentApproval ?",
      "pendingToolApproval ?",
      "pendingEditApproval ?",
    ];
    const positions = order.map((marker) => slot.indexOf(marker));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The approval handler consults the owner before acting.
    expect(source).toContain('if (owner === "edit" && pendingEditApproval)');
    expect(source).toContain('if (owner === "payment" && pendingPaymentApproval)');
    expect(source).toContain('if (owner === "tool" && pendingToolApproval)');
  });
});

function tab(id: string): QuestionnaireTab {
  return {
    id,
    title: id,
    status: "pending",
    question: { prompt: `${id}?`, options: [{ label: `${id}-a` }, { label: `${id}-b`, answerLabel: `${id} B` }] },
  };
}

describe("applyQuestionnaireAnswer", () => {
  it("records a partial answer without submitting", () => {
    const { next, submitText } = applyQuestionnaireAnswer({ tabs: [tab("x"), tab("y")] }, "x", 1);
    expect(submitText).toBeUndefined();
    expect(next?.tabs[0]).toMatchObject({ status: "answered", question: { selectedIndex: 1, answer: "x B" } });
    expect(next?.tabs[1]?.status).toBe("pending");
  });

  it("closes and returns the submit text once every tab is answered", () => {
    const first = applyQuestionnaireAnswer({ tabs: [tab("x"), tab("y")] }, "x", 0).next!;
    const { next, submitText } = applyQuestionnaireAnswer(first, "y", 1);
    expect(next).toBeNull();
    expect(submitText).toBe("Answered:\n- x: x-a\n- y: y B");
  });
});
