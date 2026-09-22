// Run ownership for the TUI turn loop.
//
// `processMessage` (use-turn-engine.ts) tags every turn with a run id and
// treats the turn as stale once `activeRunIdRef` moves past it. Abort paths
// used to record the interrupted id without moving the counter, which left
// the aborted run "current": deferred prompt preparation could still start
// the agent after Ctrl+X, and a late-finishing run could clear accumulators
// its replacement was already writing to. Every abort path now invalidates
// the run through `invalidateActiveRun`, and the turn loop re-checks
// ownership after every await that precedes a side effect.

import type { RefObject } from "react";

export interface RunOwnershipRefs {
  activeRunIdRef: RefObject<number>;
  interruptedRunIdRef: RefObject<number | null>;
  /**
   * Runs whose optimistic transcript rows (user prompt, partial assistant
   * text, tool results) were never persisted. The post-turn DB rebuild uses
   * this to skip them when pairing previous rows with persisted rows — see
   * `reconcileRebuiltTranscript`. Optional so structural callers (the input
   * router) can omit it.
   */
  cancelledRunIdsRef?: RefObject<Set<number>>;
}

/**
 * Take ownership away from the run currently in flight. After this call
 * `isRunStale(activeRunIdRef, id)` is true for the invalidated run, so it can
 * neither start the agent (if it was still preparing) nor touch shared UI
 * state (if it finishes late). Returns the invalidated run id.
 */
export function invalidateActiveRun(refs: RunOwnershipRefs): number {
  const invalidated = refs.activeRunIdRef.current;
  refs.interruptedRunIdRef.current = invalidated;
  refs.cancelledRunIdsRef?.current.add(invalidated);
  refs.activeRunIdRef.current = invalidated + 1;
  return invalidated;
}

export function isRunStale(activeRunIdRef: RefObject<number>, runId: number): boolean {
  return activeRunIdRef.current !== runId;
}

/**
 * Resolve the text a turn should send to the agent, honoring deferred
 * preparation (for example `@file` expansion). Returns null when the run lost
 * ownership before or while preparing: the caller must then NOT start the
 * agent turn, because `Agent.abort()` only cancels a turn that has already
 * begun and a late `processMessage` would run to completion — tools
 * included — after the user stopped it.
 */
export async function resolveTurnInput(args: {
  text: string;
  isContinuation: boolean;
  prepareText?: () => Promise<string>;
  isStale: () => boolean;
}): Promise<string | null> {
  if (args.isStale()) return null;
  const prepared = args.isContinuation ? args.text : await (args.prepareText?.() ?? Promise.resolve(args.text));
  if (args.isStale()) return null;
  return prepared;
}
