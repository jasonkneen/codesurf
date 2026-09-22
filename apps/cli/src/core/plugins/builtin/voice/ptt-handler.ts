// Push-to-talk hold-detection state machine.
//
// Terminals don't fire keyup events. They fire repeated `data` events while
// a key is held (OS auto-repeat ~30-80ms). Hold is inferred from event
// cadence: rapid presses + release timer.
//
// Two activation modes, picked automatically by inspecting the configured
// keystroke:
//
// 1. **Bare-char hold** (e.g. `space`): require N rapid presses before
//    activating. The first M presses flow through to the textarea so a
//    single tap types normally; on activation we strip those leaked chars
//    from the input. Without flow-through, a single space tap would be
//    invisible to the user (we'd swallow it but only later realise it
//    wasn't a hold).
//
// 2. **Modifier combo** (e.g. `ctrl+v`): activate on the first press —
//    a modifier combo is unambiguous intent (can't be typed accidentally),
//    so no warmup. The textarea ignores ctrl+key entirely so there's
//    nothing to strip.
//
// Release detection: any gap > RELEASE_TIMEOUT_MS is interpreted as
// release. Auto-repeat keeps presses arriving every 30-80ms while held;
// 200ms covers OS jitter without being so long the user feels lag.

import type { InputKey } from "../../api";

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Max gap (ms) between presses to count as held. Typing is 100-300ms. */
export const RAPID_KEY_GAP_MS = 120;
/** Rapid presses required to activate a bare-char binding. */
export const HOLD_THRESHOLD = 5;
/** First N presses that flow through to the textarea (so single tap types). */
export const WARMUP_THRESHOLD = 2;
/** No keypress within this → key released → finish recording. */
export const RELEASE_TIMEOUT_MS = 250;
/**
 * Fallback for modifier-combo first-press activation. macOS initial repeat
 * delay can be ~2s on the "Long" slider setting, so we can't use the
 * 300ms repeat-rate timer until at least one auto-repeat arrives.
 */
export const FIRST_PRESS_FALLBACK_MS = 2_000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface HoldKeystroke {
  /** Key name (e.g. `"space"`, `"v"`). */
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Whether the keystroke is a bare unmodified key (single char or "space").
 *  Used to pick the warmup-and-strip path — bare keys can be typed by
 *  accident, so they need rapid-press confirmation. */
export function isBareChar(ks: HoldKeystroke): boolean {
  if (ks.ctrl || ks.meta || ks.shift) return false;
  return ks.key.length === 1 || ks.key === "space";
}

export function matchesKeystroke(key: InputKey, ks: HoldKeystroke): boolean {
  // For bare-char bindings we match on key.name when the key produced a
  // single sequence char. Some terminals report `name="space"` for ` `
  // — handle both.
  const wantBare = isBareChar(ks);
  if (wantBare) {
    if (key.ctrl || key.meta || key.shift) return false;
    if (ks.key === " " || ks.key === "space") {
      return key.name === "space" || key.sequence === " ";
    }
    return key.name === ks.key || key.sequence === ks.key;
  }
  // Modifier combos: match by name + each modifier exactly.
  if (key.name !== ks.key) return false;
  if (Boolean(key.ctrl) !== Boolean(ks.ctrl)) return false;
  if (Boolean(key.meta) !== Boolean(ks.meta)) return false;
  if (Boolean(key.shift) !== Boolean(ks.shift)) return false;
  return true;
}

export interface PttCallbacks {
  /** Called when visible warmup begins after typed-through taps. */
  onWarmupBegin?: () => void;
  /** Called on visible warmup ticks so the indicator can show progress. */
  onWarmupTick?: (count: number) => void;
  /** Called when internal warmup is abandoned (timed out before activating). */
  onWarmupAbandoned?: () => void;
  /** Called on activation. `flowThroughChars` = how many of `keystroke.key`
   *  leaked into the input during warmup; the caller should strip them. */
  onActivate: (flowThroughChars: number) => void;
  /** Called on release. */
  onRelease: () => void;
}

export interface PttHandlerOptions {
  keystroke: HoldKeystroke;
  callbacks: PttCallbacks;
  /** Inject for testing. Defaults to `globalThis.setTimeout`. */
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface PttHandler {
  /** Process a key event. Returns `true` if the key was swallowed. */
  handleKey: (key: InputKey) => boolean;
  /** Force-release. */
  reset: () => void;
  /** Whether currently in active recording state (post-activation). */
  isActive: () => boolean;
}

// ── Implementation ────────────────────────────────────────────────────────────

export function createPttHandler(opts: PttHandlerOptions): PttHandler {
  const setTimeoutFn = opts.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimeoutFn = opts.clearTimeoutImpl ?? globalThis.clearTimeout;

  type Phase = "idle" | "warmup" | "active";
  let phase: Phase = "idle";
  let warmupCount = 0;
  let warmupResetTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let firstPressFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Number of warmup chars that flowed through to the input. We track this
   *  so on activation the caller knows how many to strip. */
  let charsLeaked = 0;

  const bare = isBareChar(opts.keystroke);

  function clearAllTimers(): void {
    if (warmupResetTimer) {
      clearTimeoutFn(warmupResetTimer);
      warmupResetTimer = null;
    }
    if (releaseTimer) {
      clearTimeoutFn(releaseTimer);
      releaseTimer = null;
    }
    if (firstPressFallbackTimer) {
      clearTimeoutFn(firstPressFallbackTimer);
      firstPressFallbackTimer = null;
    }
  }

  function resetToIdle(): void {
    clearAllTimers();
    phase = "idle";
    warmupCount = 0;
    charsLeaked = 0;
  }

  function armReleaseTimer(): void {
    if (releaseTimer) clearTimeoutFn(releaseTimer);
    releaseTimer = setTimeoutFn(() => {
      releaseTimer = null;
      if (phase === "active") {
        phase = "idle";
        clearAllTimers();
        opts.callbacks.onRelease();
      }
    }, RELEASE_TIMEOUT_MS);
  }

  function activate(): void {
    clearAllTimers();
    phase = "active";
    const flow = charsLeaked;
    charsLeaked = 0;
    warmupCount = 0;
    opts.callbacks.onActivate(flow);
    // After activation, arm an initial release timer using the modifier-combo
    // fallback duration so a single-press activation doesn't immediately
    // fire onRelease before the OS auto-repeat kicks in.
    if (releaseTimer) clearTimeoutFn(releaseTimer);
    releaseTimer = setTimeoutFn(
      () => {
        releaseTimer = null;
        if (phase === "active") {
          phase = "idle";
          clearAllTimers();
          opts.callbacks.onRelease();
        }
      },
      bare ? RELEASE_TIMEOUT_MS : FIRST_PRESS_FALLBACK_MS,
    );
  }

  function handleKey(key: InputKey): boolean {
    if (!matchesKeystroke(key, opts.keystroke)) {
      // Different key — not relevant to PTT. If we were warming up, abandon.
      if (phase === "warmup") {
        const cb = opts.callbacks.onWarmupAbandoned;
        resetToIdle();
        cb?.();
      }
      return false;
    }

    if (phase === "active") {
      // Already recording — every press resets the release timer.
      armReleaseTimer();
      // Bare chars must be swallowed during recording; modifier combos
      // don't insert text so swallowing is harmless.
      return true;
    }

    if (!bare) {
      // Modifier combo: activate on first press, no warmup.
      activate();
      return true;
    }

    // Bare char: warmup path.
    if (phase === "idle") {
      phase = "warmup";
      warmupCount = 0;
      charsLeaked = 0;
    }

    warmupCount += 1;

    // Refresh the warmup-abandon timer.
    if (warmupResetTimer) clearTimeoutFn(warmupResetTimer);
    warmupResetTimer = setTimeoutFn(() => {
      warmupResetTimer = null;
      if (phase === "warmup") {
        const cb = opts.callbacks.onWarmupAbandoned;
        resetToIdle();
        cb?.();
      }
    }, RAPID_KEY_GAP_MS);

    if (warmupCount >= HOLD_THRESHOLD) {
      // Activation. Don't swallow this last press — it already leaked
      // through some terminals, and our caller will strip flow-through
      // chars from the input. The previous (warmupCount - 1) presses
      // have either flowed through or been swallowed already.
      activate();
      return true;
    }

    // First WARMUP_THRESHOLD presses flow through to the textarea so a
    // single-press tap types normally. Keep those presses invisible to the
    // indicator too; otherwise a normal space tap flashes the voice chip
    // until the warmup-abandon timer fires.
    if (warmupCount <= WARMUP_THRESHOLD) {
      charsLeaked += 1;
      return false; // let the textarea see it
    }

    if (warmupCount === WARMUP_THRESHOLD + 1) {
      opts.callbacks.onWarmupBegin?.();
    }
    opts.callbacks.onWarmupTick?.(warmupCount);

    // Subsequent rapid presses are swallowed so the input stays aligned with
    // the warmup UI.
    return true; // swallow
  }

  return {
    handleKey,
    reset: resetToIdle,
    isActive: () => phase === "active",
  };
}
