// Voice extension state store.
//
// A tiny subscribable store, deliberately not React context. The state
// is read by:
//   - The push-to-talk handler (synchronously, inside an input interceptor)
//   - The status indicator (via useSyncExternalStore)
//   - The recording subprocess wrapper (synchronously when finalising)
//
// Using context would force the indicator to remount every state transition,
// which the prompt footer can't tolerate at 80ms cadence. The store API
// matches the registry's existing pattern (subscribe + getSnapshot).

export type VoicePhase = "idle" | "warming" | "recording" | "processing" | "error";

export interface VoiceState {
  /** Master enabled flag — mirrors the voice.enabled setting. */
  enabled: boolean;
  phase: VoicePhase;
  /** Tick counter incremented on every press during warmup. */
  warmupCount: number;
  /** Wall-clock ms when recording started; used for the duration display. */
  recordingStartedAt: number | null;
  /** Last error message, cleared on the next state transition out of `error`. */
  errorMessage: string | null;
}

const INITIAL: VoiceState = {
  enabled: false,
  phase: "idle",
  warmupCount: 0,
  recordingStartedAt: null,
  errorMessage: null,
};

let current: VoiceState = INITIAL;
const subscribers = new Set<() => void>();

export function getVoiceState(): VoiceState {
  return current;
}

export function setVoiceState(updater: (prev: VoiceState) => VoiceState): void {
  const next = updater(current);
  if (next === current) return;
  current = next;
  for (const cb of subscribers) cb();
}

export function subscribeVoiceState(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function resetVoiceState(): void {
  current = INITIAL;
  for (const cb of subscribers) cb();
}
