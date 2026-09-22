/**
 * Serialize async turns (local TUI + Telegram) so only one Agent.processMessage runs at a time.
 */

/** Thrown into a queued turn that was dropped by `reset()` (an abort). */
export class TurnAbandonedError extends Error {
  constructor() {
    super("Turn abandoned before it started");
    this.name = "TurnAbandonedError";
  }
}

/** Handed to every running turn: `signal` aborts when `reset()` fences the turn out. */
export interface TurnContext {
  signal: AbortSignal;
}

export function createTurnCoordinator() {
  let chain: Promise<unknown> = Promise.resolve();
  // Bumped by reset(). A turn that was queued under an older generation must
  // never execute: if the turn wedging the chain eventually settles, its
  // successor would otherwise spring to life as a zombie turn long after the
  // user aborted.
  let generation = 0;
  // One fence per generation. reset() aborts the current fence so a turn that
  // is *already running* learns it lost ownership — a queued turn is dropped
  // by the generation check, but a running one would otherwise keep sending
  // into a destination a newer turn now owns.
  let fence = new AbortController();

  return {
    run<T>(fn: (turn: TurnContext) => Promise<T>): Promise<T> {
      const gen = generation;
      const turnFence = fence;
      const result = chain.then(() => {
        if (gen !== generation) throw new TurnAbandonedError();
        return fn({ signal: turnFence.signal });
      });
      chain = result.then(
        () => {},
        () => {},
      );
      return result;
    },

    /**
     * Drop the queue and start a fresh chain.
     *
     * A turn whose promise never settles — a Telegram turn whose stream never
     * closes, a provider that ignores `abort()` — otherwise wedges every later
     * turn forever. That is not a hypothetical: the UI latches
     * `isProcessing = true` *before* awaiting the coordinator, and
     * `processMessage` early-returns on `if (isProcessingRef.current) return`,
     * so a wedged chain locks the user out of the app entirely ("Waiting... Ns"
     * with no turn actually running). Abort calls this so there is always a way
     * back.
     */
    reset(): void {
      generation++;
      chain = Promise.resolve();
      const previous = fence;
      fence = new AbortController();
      previous.abort(new TurnAbandonedError());
    },
  };
}

export type TurnCoordinator = ReturnType<typeof createTurnCoordinator>;
