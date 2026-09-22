// Per-tool timing for the live turn.
//
// Each in-flight tool call gets its own start timestamp so a batch of
// concurrent calls reports one duration per call and a completed call
// removes only itself from the active list. Pure helpers — the hooks in
// use-turn-stream.ts own the Map and the state setters.

import type { ToolCall } from "../../types/index";

/** Record `now` as the start of every call that is not already timed. */
export function startToolTimers(map: Map<string, number>, calls: ToolCall[], now: number): void {
  for (const call of calls) {
    if (!map.has(call.id)) map.set(call.id, now);
  }
}

/** Stop the timer for `id` and return its duration, or undefined when unknown. */
export function finishToolTimer(map: Map<string, number>, id: string, now: number): number | undefined {
  const started = map.get(id);
  if (started === undefined) return undefined;
  map.delete(id);
  return Math.max(0, now - started);
}

/** Drop the finished call and keep every other call still running. */
export function removeActiveToolCall(calls: ToolCall[], id: string): ToolCall[] {
  return calls.filter((call) => call.id !== id);
}

/** Earliest start among the in-flight calls, for the status line's tool clock. */
export function earliestToolStart(map: Map<string, number>): number | undefined {
  let min: number | undefined;
  for (const started of map.values()) {
    if (min === undefined || started < min) min = started;
  }
  return min;
}
