import { describe, expect, it } from "vitest";
import type { QuestionnaireTab } from "./questionnaire-tabs";
import {
  buildSelectedOptionMap,
  questionnaireKeyAction,
  resolveAnswerLabels,
  SUBMIT_TAB_ID,
  summariseAnswers,
} from "./questionnaire-tabs";

function tab(
  id: string,
  options: QuestionnaireTab["question"]["options"],
  extra?: Partial<QuestionnaireTab>,
): QuestionnaireTab {
  return {
    id,
    title: id,
    question: { prompt: `${id}?`, options },
    ...extra,
  };
}

describe("buildSelectedOptionMap", () => {
  it("honours an explicit selectedIndex over the recommended option", () => {
    const tabs = [
      tab("scope", [{ label: "a" }, { label: "b", recommended: true }, { label: "c" }], {
        question: {
          prompt: "scope?",
          selectedIndex: 2,
          options: [{ label: "a" }, { label: "b", recommended: true }, { label: "c" }],
        },
      }),
    ];
    expect(buildSelectedOptionMap(tabs)).toEqual({ scope: 2 });
  });

  it("falls back to the recommended option when no selectedIndex is set", () => {
    const tabs = [tab("risk", [{ label: "low" }, { label: "med", recommended: true }])];
    expect(buildSelectedOptionMap(tabs)).toEqual({ risk: 1 });
  });

  it("falls back to the first option when nothing is recommended", () => {
    const tabs = [tab("verify", [{ label: "targeted" }, { label: "full" }])];
    expect(buildSelectedOptionMap(tabs)).toEqual({ verify: 0 });
  });

  it("maps every tab independently", () => {
    const tabs = [
      tab("a", [{ label: "a1" }, { label: "a2", recommended: true }]),
      tab("b", [{ label: "b1", recommended: true }, { label: "b2" }]),
    ];
    expect(buildSelectedOptionMap(tabs)).toEqual({ a: 1, b: 0 });
  });
});

describe("summariseAnswers", () => {
  it("reports the live selection, not a stale recorded answer", () => {
    // Regression guard: the `answer` field is a previously-recorded value.
    // The submit summary must show what will actually be sent.
    const tabs = [
      tab("verify", [{ label: "Targeted" }, { label: "Standard" }], {
        title: "Verify",
        question: {
          prompt: "how much?",
          answer: "Standard validation before reporting back",
          options: [{ label: "Targeted" }, { label: "Standard" }],
        },
      }),
    ];
    expect(summariseAnswers(tabs, { verify: 0 })).toEqual([{ tabId: "verify", title: "Verify", answer: "Targeted" }]);
  });

  it("prefers answerLabel over label when present", () => {
    const tabs = [tab("scope", [{ label: "Tight fix", answerLabel: "Tight fix only" }], { title: "Scope" })];
    expect(summariseAnswers(tabs, { scope: 0 })).toEqual([
      { tabId: "scope", title: "Scope", answer: "Tight fix only" },
    ]);
  });

  it("excludes the synthetic submit tab from the summary", () => {
    const tabs = [tab("scope", [{ label: "Tight" }], { title: "Scope" }), tab(SUBMIT_TAB_ID, [], { title: "Submit" })];
    expect(summariseAnswers(tabs, { scope: 0 })).toEqual([{ tabId: "scope", title: "Scope", answer: "Tight" }]);
  });

  it("falls back to the default selection when a tab has no entry in the map", () => {
    const tabs = [tab("risk", [{ label: "Low" }, { label: "High", recommended: true }], { title: "Risk" })];
    expect(summariseAnswers(tabs, {})).toEqual([{ tabId: "risk", title: "Risk", answer: "High" }]);
  });

  it("clamps an out-of-range index instead of returning undefined", () => {
    const tabs = [tab("risk", [{ label: "Low" }, { label: "High" }], { title: "Risk" })];
    expect(summariseAnswers(tabs, { risk: 99 })).toEqual([{ tabId: "risk", title: "Risk", answer: "High" }]);
  });

  it("skips tabs that have no options at all", () => {
    const tabs = [tab("empty", [], { title: "Empty" })];
    expect(summariseAnswers(tabs, { empty: 0 })).toEqual([]);
  });
});

describe("resolveAnswerLabels", () => {
  it("returns the persistable label per tab, keyed by tab id", () => {
    const tabs = [
      tab("scope", [{ label: "Tight fix" }, { label: "Broad" }], { title: "Scope" }),
      tab("risk", [{ label: "Low" }, { label: "High" }], { title: "Risk" }),
    ];
    expect(resolveAnswerLabels(tabs, { scope: 1, risk: 0 })).toEqual({ scope: "Broad", risk: "Low" });
  });

  it("persists the raw label, not the answerLabel display text", () => {
    // The settings layer round-trips on `label` via optionIndexForValue,
    // so persisting answerLabel would break re-seeding on reopen.
    const tabs = [tab("scope", [{ label: "Tight fix", answerLabel: "Tight fix only" }], { title: "Scope" })];
    expect(resolveAnswerLabels(tabs, { scope: 0 })).toEqual({ scope: "Tight fix" });
  });

  it("omits the synthetic submit tab", () => {
    const tabs = [tab("scope", [{ label: "Tight" }], { title: "Scope" }), tab(SUBMIT_TAB_ID, [], { title: "Submit" })];
    expect(resolveAnswerLabels(tabs, { scope: 0 })).toEqual({ scope: "Tight" });
  });
});

describe("questionnaireKeyAction", () => {
  it("maps navigation, confirm and dismiss keys", () => {
    expect(questionnaireKeyAction({ name: "left" })).toEqual({ kind: "tab", delta: -1 });
    expect(questionnaireKeyAction({ name: "right" })).toEqual({ kind: "tab", delta: 1 });
    expect(questionnaireKeyAction({ name: "tab" })).toEqual({ kind: "tab", delta: 1 });
    expect(questionnaireKeyAction({ name: "tab", shift: true })).toEqual({ kind: "tab", delta: -1 });
    expect(questionnaireKeyAction({ name: "up" })).toEqual({ kind: "option", delta: -1 });
    expect(questionnaireKeyAction({ name: "down" })).toEqual({ kind: "option", delta: 1 });
    expect(questionnaireKeyAction({ name: "return" })).toEqual({ kind: "confirm" });
  });

  it("always offers an exit on esc and ctrl+c", () => {
    expect(questionnaireKeyAction({ name: "escape" })).toEqual({ kind: "dismiss" });
    expect(questionnaireKeyAction({ name: "c", ctrl: true })).toEqual({ kind: "dismiss" });
  });

  it("ignores unrelated keys", () => {
    expect(questionnaireKeyAction({ name: "a", sequence: "a" })).toBeNull();
    expect(questionnaireKeyAction({ name: "c" })).toBeNull();
  });
});
