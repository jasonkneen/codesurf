import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "../../types/index";
import { initialPlanQuestionsState, type PlanQuestionsState } from "../plan";

// Render-free harness: useCallback becomes identity and the conversation
// context returns a controlled snapshot, which models React's closure
// semantics (a scheduled setPqs is NOT visible to callbacks created from the
// current render).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useCallback: <T>(fn: T) => fn };
});

const snapshot = vi.hoisted(() => ({
  activePlan: null as Plan | null,
  pqs: null as unknown as PlanQuestionsState,
  setPqs: vi.fn(),
  setActivePlan: vi.fn(),
  setTodoPlan: vi.fn(),
  setPendingQuestionnaire: vi.fn(),
  setAgentRoster: vi.fn(),
  isProcessingRef: { current: false },
}));

const queue = vi.hoisted(() => ({
  queuedMessagesRef: { current: [] as Array<{ id: string; text: string }> },
  nextQueueIdRef: { current: 0 },
  setQueuedMessages: vi.fn(),
}));

vi.mock("../context/conversation-state-context.js", () => ({
  useConversationState: () => snapshot,
}));
vi.mock("../context/queue-context.js", () => ({ useQueue: () => queue }));

import { usePlanActions } from "./use-plan-actions";

const singleSelectPlan: Plan = {
  title: "Plan",
  summary: "",
  steps: [],
  questions: [
    {
      id: "proceed",
      question: "Proceed with the migration?",
      type: "select",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
  ],
};

describe("usePlanActions single-question submission", () => {
  beforeEach(() => {
    snapshot.activePlan = singleSelectPlan;
    snapshot.pqs = initialPlanQuestionsState();
    snapshot.setPqs.mockReset();
    snapshot.setActivePlan.mockReset();
    snapshot.isProcessingRef.current = false;
    queue.queuedMessagesRef.current = [];
    queue.setQueuedMessages.mockReset();
  });

  it("submits the option that was just selected, not the previous answer state", () => {
    const processMessage = vi.fn();
    const { handlePlanSelect, isSinglePlan } = usePlanActions({ processMessage });
    expect(isSinglePlan).toBe(true);

    const question = singleSelectPlan.questions![0]!;
    handlePlanSelect(question, 0, question.options!, false);

    expect(processMessage).toHaveBeenCalledTimes(1);
    const submitted = processMessage.mock.calls[0]![0] as string;
    expect(submitted).toContain("Proceed with the migration?: Yes");
    expect(submitted).not.toContain("(not answered)");
    expect(snapshot.setActivePlan).toHaveBeenCalledWith(null);
  });

  it("submits a changed selection over a previously recorded answer", () => {
    snapshot.pqs = { ...initialPlanQuestionsState(), answers: { proceed: "yes" } };
    const processMessage = vi.fn();
    const { handlePlanSelect } = usePlanActions({ processMessage });

    const question = singleSelectPlan.questions![0]!;
    handlePlanSelect(question, 1, question.options!, false);

    const submitted = processMessage.mock.calls[0]![0] as string;
    expect(submitted).toContain("Proceed with the migration?: No");
  });

  it("queues the answer instead of dropping it when a turn is still running", () => {
    snapshot.isProcessingRef.current = true;
    const processMessage = vi.fn();
    const { handlePlanSelect } = usePlanActions({ processMessage });

    const question = singleSelectPlan.questions![0]!;
    handlePlanSelect(question, 0, question.options!, false);

    expect(processMessage).not.toHaveBeenCalled();
    expect(queue.queuedMessagesRef.current.map((m) => m.text)).toEqual([
      expect.stringContaining("Proceed with the migration?: Yes"),
    ]);
    expect(queue.setQueuedMessages).toHaveBeenCalledTimes(1);
  });
});
