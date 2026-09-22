// Queue slot reservation for composer submissions made while a turn is running.
//
// The composer used to await @-mention expansion BEFORE appending to the
// queue. That left a window in which the running turn could finish and drain
// an empty queue (stranding the submission with nothing to dispatch it), two
// overlapping expansions could land in completion order instead of Enter
// order, and a session reset could be followed by an insertion into the
// replacement session's freshly cleared queue.
//
// `reserveQueuedSubmission` claims the id and the queue position synchronously
// and carries the still-pending preparation on the entry. Whoever drains the
// slot (finishTurnProcessing, queue send-now) forwards it to processMessage as
// `prepareText`, where `resolveTurnInput` awaits it under run ownership.

import type { RefObject } from "react";
import type { QueuedMessage } from "../app-helpers";

export interface QueuedSubmission extends QueuedMessage {
  /**
   * Deferred prompt preparation (for example @-mention expansion) reserved
   * together with the slot. Absent for submissions that need none (kernel
   * chat sink).
   */
  prepareText?: () => Promise<string>;
}

export interface QueueReservationRefs {
  queuedMessagesRef: RefObject<QueuedSubmission[]>;
  nextQueueIdRef: RefObject<number>;
}

export interface QueueSubmissionInput {
  /** Prompt text as typed (paste blocks and file mentions already expanded). */
  text: string;
  displayText: string;
  /**
   * Starts preparation immediately so it overlaps the running turn. The
   * result is memoized on the entry; the slot may still be dropped (abort,
   * reset, send-now of another row) before anything awaits it.
   */
  prepare?: () => Promise<string>;
}

/**
 * Append a submission to the queue synchronously, in Enter order, and start
 * its preparation now. Returns the reserved entry.
 */
export function reserveQueuedSubmission(refs: QueueReservationRefs, input: QueueSubmissionInput): QueuedSubmission {
  const id = `q${refs.nextQueueIdRef.current++}`;
  const entry: QueuedSubmission = { id, text: input.text, displayText: input.displayText };
  if (input.prepare) {
    const prepared = input.prepare();
    // A slot dropped before dispatch would otherwise surface a failed
    // expansion as an unhandled rejection. The dispatched turn still sees the
    // rejection through `prepareText` (it re-awaits the same promise).
    prepared.catch(() => {});
    entry.prepareText = () => prepared;
  }
  refs.queuedMessagesRef.current.push(entry);
  return entry;
}

export interface SubmitOrQueueDeps extends QueueReservationRefs {
  isProcessingRef: RefObject<boolean>;
  setQueuedMessages: (messages: QueuedSubmission[]) => void;
  processMessage: (text: string) => unknown;
}

/**
 * Send `text` as a new turn, or — when a turn is running — queue it behind
 * that turn. `processMessage` silently drops input while the processing latch
 * is held, so UI answers (questionnaire, plan questions) submitted mid-turn
 * must go through here instead of calling it directly.
 */
export function submitOrQueue(deps: SubmitOrQueueDeps, text: string): "sent" | "queued" {
  if (deps.isProcessingRef.current) {
    reserveQueuedSubmission(deps, { text, displayText: text });
    deps.setQueuedMessages([...deps.queuedMessagesRef.current]);
    return "queued";
  }
  void deps.processMessage(text);
  return "sent";
}
