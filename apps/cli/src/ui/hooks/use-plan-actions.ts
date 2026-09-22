import { useCallback } from "react";
import type { PlanQuestion } from "../../types/index";
import { useConversationState } from "../context/conversation-state-context.js";
import { useQueue } from "../context/queue-context.js";
import { formatPlanAnswers, initialPlanQuestionsState, type PlanAnswers } from "../plan.js";
import { submitOrQueue } from "./queue-submissions.js";

export interface UsePlanActionsParams {
  processMessage: (text: string) => void;
}

export function usePlanActions({ processMessage }: UsePlanActionsParams) {
  const {
    activePlan,
    setActivePlan,
    pqs,
    setPqs,
    setTodoPlan,
    setPendingQuestionnaire,
    setAgentRoster,
    isProcessingRef,
  } = useConversationState();
  const { queuedMessagesRef, nextQueueIdRef, setQueuedMessages } = useQueue();

  const planQuestions = activePlan?.questions ?? [];
  const isSinglePlan = planQuestions.length === 1 && planQuestions[0]?.type !== "multiselect";

  const dismissPlan = useCallback(() => {
    setActivePlan(null);
    setTodoPlan(null);
    setAgentRoster([]);
    setPendingQuestionnaire(null);
    setPqs(initialPlanQuestionsState());
  }, [setPqs, setTodoPlan, setPendingQuestionnaire, setAgentRoster, setActivePlan]);

  /**
   * Submit the plan answers. `answersOverride` lets a caller that has just
   * chosen an option submit in the same tick: this callback closes over the
   * current render's `pqs.answers`, so a `setPqs` scheduled a moment earlier
   * is not visible here yet. Reading the closure alone submitted the previous
   * answer state — for a single-question plan, `(not answered)`.
   */
  const submitPlanAnswers = useCallback(
    (answersOverride?: PlanAnswers) => {
      if (!activePlan?.questions?.length) return;
      const answers = answersOverride && typeof answersOverride === "object" ? answersOverride : pqs.answers;
      const text = formatPlanAnswers(activePlan.questions, answers);
      setActivePlan(null);
      setTodoPlan(null);
      setAgentRoster([]);
      setPendingQuestionnaire(null);
      setPqs(initialPlanQuestionsState());
      // Answers given while a turn is still running are queued behind it;
      // processMessage alone would drop them on the busy latch.
      submitOrQueue({ isProcessingRef, queuedMessagesRef, nextQueueIdRef, setQueuedMessages, processMessage }, text);
    },
    [
      activePlan,
      pqs.answers,
      processMessage,
      isProcessingRef,
      queuedMessagesRef,
      nextQueueIdRef,
      setQueuedMessages,
      setPqs,
      setTodoPlan,
      setPendingQuestionnaire,
      setAgentRoster,
      setActivePlan,
    ],
  );

  const handlePlanSelect = useCallback(
    (q: PlanQuestion, idx: number, options: { id: string; label: string }[], showCustom: boolean) => {
      const isCustom = showCustom && idx === options.length;
      if (isCustom) {
        if (q.type === "multiselect") {
          const customVal = pqs.customInputs[q.id] ?? "";
          if (customVal) {
            const existing = (pqs.answers[q.id] as string[] | undefined) ?? [];
            if (existing.includes(customVal)) {
              setPqs((s) => ({
                ...s,
                answers: {
                  ...s.answers,
                  [q.id]: existing.filter((x) => x !== customVal),
                },
              }));
            } else {
              setPqs((s) => ({ ...s, editing: true }));
            }
          } else {
            setPqs((s) => ({ ...s, editing: true }));
          }
        } else {
          setPqs((s) => ({ ...s, editing: true }));
        }
        return;
      }
      const opt = options[idx];
      if (!opt) return;

      if (q.type === "multiselect") {
        setPqs((s) => {
          const existing = (s.answers[q.id] as string[] | undefined) ?? [];
          const next = existing.includes(opt.id) ? existing.filter((x) => x !== opt.id) : [...existing, opt.id];
          return { ...s, answers: { ...s.answers, [q.id]: next } };
        });
      } else {
        if (isSinglePlan) {
          // Compute the answers once and hand them to submission explicitly;
          // a scheduled setPqs is not visible to submitPlanAnswers' closure.
          submitPlanAnswers({ ...pqs.answers, [q.id]: opt.id });
          return;
        }
        setPqs((s) => ({ ...s, answers: { ...s.answers, [q.id]: opt.id }, tab: s.tab + 1, selected: 0 }));
      }
    },
    [pqs, isSinglePlan, submitPlanAnswers, setPqs],
  );

  return { dismissPlan, submitPlanAnswers, handlePlanSelect, isSinglePlan };
}
