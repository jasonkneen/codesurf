import type { RefObject } from "react";
import { useCallback } from "react";
import type { Agent } from "../../agent/agent";
import { abortRemoteTurn } from "../../server/attach";
import { useConversationState } from "../context/conversation-state-context.js";
import { useQueue } from "../context/queue-context.js";
import { useServerMode } from "../context/server-mode-context.js";
import { useTelegram } from "../context/telegram-context.js";
import { markTelegramTurnStopped } from "../telegram-turn-ui.js";
import type { QueuedSubmission } from "./queue-submissions.js";
import { invalidateActiveRun } from "./turn-ownership.js";
import type { ProcessMessageOptions } from "./use-turn-engine.js";

export interface UseQueueActionsParams {
  agent: Agent;
  clearLiveTurnUi: () => void;
  processMessageRef: RefObject<(text: string, displayText?: string, options?: ProcessMessageOptions) => void>;
}

export function useQueueActions({ agent, clearLiveTurnUi, processMessageRef }: UseQueueActionsParams) {
  const { queuedMessagesRef, setQueuedMessages, setQueueFocusId } = useQueue();
  const { isProcessingRef, interruptedRunIdRef, activeRunIdRef, cancelledRunIdsRef, activeTurnRef } =
    useConversationState();
  const { coordinatorRef, stoppedTelegramTurnKeysRef } = useTelegram();
  const { remoteFront } = useServerMode();

  const dispatchQueueAt = useCallback(
    (targetId?: string): boolean => {
      if (queuedMessagesRef.current.length === 0 || !isProcessingRef.current) {
        return false;
      }
      let target: QueuedSubmission | undefined;
      if (targetId === undefined) {
        target = queuedMessagesRef.current.shift();
      } else {
        const idx = queuedMessagesRef.current.findIndex((m) => m.id === targetId);
        if (idx === -1) return false;
        target = queuedMessagesRef.current.splice(idx, 1)[0];
      }
      if (!target) return false;
      setQueuedMessages([...queuedMessagesRef.current]);
      setQueueFocusId(null);

      // Send-now replaces the active run. Invalidate it so its late finish
      // can neither finalize (and tear down) the replacement's live turn nor
      // clear the accumulators the replacement is streaming into.
      invalidateActiveRun({ activeRunIdRef, interruptedRunIdRef, cancelledRunIdsRef });
      const activeAgent = activeTurnRef.current?.agent ?? agent;
      markTelegramTurnStopped(stoppedTelegramTurnKeysRef, {
        kind: activeTurnRef.current?.kind,
        remoteKey: activeTurnRef.current?.remoteKey,
      });
      activeTurnRef.current = null;
      clearLiveTurnUi();
      activeAgent.abort();
      // On a server the replaced turn runs on the node; the node runs the
      // steer once that turn has stopped instead of refusing it as busy.
      abortRemoteTurn(remoteFront, agent.getSessionId());
      // Same as Ctrl+X: drop the coordinator queue so the replaced turn — or
      // one wedged on it and ignoring abort — can't hold the new turn hostage.
      coordinatorRef.current.reset();

      isProcessingRef.current = false;
      // Carry the slot's still-pending @-mention expansion into the turn (see
      // queue-submissions.ts); processMessage awaits it under run ownership.
      void processMessageRef.current(target.text, target.displayText, { prepareText: target.prepareText });
      return true;
    },
    [
      agent,
      clearLiveTurnUi,
      queuedMessagesRef.current.splice,
      queuedMessagesRef.current,
      setQueueFocusId,
      setQueuedMessages,
      activeRunIdRef.current,
      isProcessingRef.current,
      activeTurnRef.current?.agent,
      isProcessingRef,
      interruptedRunIdRef,
      cancelledRunIdsRef,
      activeRunIdRef,
      activeTurnRef,
      coordinatorRef,
      stoppedTelegramTurnKeysRef,
      processMessageRef.current,
      remoteFront,
    ],
  );
  const dispatchQueueHead = useCallback((): boolean => dispatchQueueAt(), [dispatchQueueAt]);

  return { dispatchQueueAt, dispatchQueueHead };
}
