// Keypress-latency probe for diagnosing idle input lag.
//
// Enable with `CODESURF_PERF_KEYS=1` (optionally `CODESURF_PERF_KEYS_FILE=/path.log`).
// When unset, every entry point below is a single boolean check and a return —
// zero behavioural impact on the running app.
//
// It discriminates the two idle-lag suspects:
//   • handleKeyMs        — synchronous cost of the App's `handleKey` handler.
//                          High here = the handler itself is the bottleneck.
//   • rendersSincePrevKey— App re-renders observed between two keystrokes.
//                          >0 per key = some state churn re-renders the whole
//                          311-hook App on each keystroke. ~0 = the cost is in
//                          OpenTUI's paint path, not React (next probe target).
//
// Lines are buffered and flushed on a short timer so the file write never sits
// on the keypress hot path it's trying to measure.

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const keyPerfEnabled = !!process.env.CODESURF_PERF_KEYS;
const LOG_FILE = process.env.CODESURF_PERF_KEYS_FILE || join(tmpdir(), "grok-key-perf.log");

let renderCount = 0;
let rendersAtLastKey = 0;
let keyStart = 0;
let keyName = "";

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function emit(line: string): void {
  buffer.push(`${new Date().toISOString()} ${line}`);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (buffer.length === 0) return;
      try {
        appendFileSync(LOG_FILE, `${buffer.join("\n")}\n`);
      } catch {
        // Logging must never break the app; drop the batch on failure.
      }
      buffer = [];
    }, 250);
  }
}

/** Call once per App render (gated internally). */
export function notePerfRender(): void {
  if (!keyPerfEnabled) return;
  renderCount++;
}

/** Call at the top of the keyboard handler. */
export function notePerfKeyStart(name: string): void {
  if (!keyPerfEnabled) return;
  keyName = name;
  keyStart = performance.now();
}

/** Call when the keyboard handler returns. */
export function notePerfKeyEnd(): void {
  if (!keyPerfEnabled) return;
  const handleKeyMs = performance.now() - keyStart;
  const rendersSincePrevKey = renderCount - rendersAtLastKey;
  rendersAtLastKey = renderCount;
  emit(
    `key=${keyName} handleKeyMs=${handleKeyMs.toFixed(2)} rendersSincePrevKey=${rendersSincePrevKey} totalRenders=${renderCount}`,
  );
}
