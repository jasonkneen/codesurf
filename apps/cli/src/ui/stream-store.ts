// Leaf-isolated store for the live streaming buffers (assistant text + reasoning).
//
// WHY THIS EXISTS
// ----------------
// These two values update once per streamed token (tens of times per second).
// They used to live in `useState` at the top of the 7,800-line `App`
// component, so every token triggered a full reconcile of all ~311 hooks —
// which, on the single JS thread, starved keyboard input during a turn
// ("keyboard very slow when processing").
//
// By moving them into a module-level store, the token hot path notifies ONLY
// the small leaf components that subscribe (the streaming text box + the live
// reasoning block, both inside MessageList's scrollbox). `App` no longer
// re-renders per token; it reads a non-reactive snapshot (`getStreamContent`)
// during its normal ~10Hz status-tick renders, which is plenty fresh for the
// context meter / status line.
//
// SUBSCRIPTION MODEL
// ------------------
// The React hooks use `useState` + `useEffect` rather than
// `useSyncExternalStore` on purpose: OpenTUI ships a custom React reconciler
// (@opentui/react), and `useState`/`useEffect` are proven working throughout
// this app, whereas a silent no-op from a less-exercised core hook would
// freeze the live stream. Conservative beats clever on the hot path.
//
// Content and reasoning have SEPARATE listener sets so a content delta does
// not wake the reasoning leaf, and vice versa.

import { useEffect, useState } from "react";

let content = "";
let reasoning = "";

/** What the live turn is doing right now, from the most recent stream event.
 *  `connecting` = provider reported it is still spawning/attaching; `waiting`
 *  = between events (before the first token, or after a tool result);
 *  `thinking` = reasoning deltas arriving; `writing` = text deltas arriving. */
export type StreamPhase = "connecting" | "waiting" | "thinking" | "writing";
let phase: StreamPhase | null = null;
/** Epoch ms of the first reasoning delta in the live turn, or null. */
let reasoningStartedAt: number | null = null;

const contentListeners = new Set<() => void>();
const reasoningListeners = new Set<() => void>();
const phaseListeners = new Set<() => void>();

export function getStreamContent(): string {
  return content;
}

export function getStreamReasoning(): string {
  return reasoning;
}

/** Set the live assistant text. No-op (no notify) when unchanged so repeated
 *  clears don't wake subscribers needlessly. */
export function setStreamContent(next: string): void {
  if (next === content) return;
  content = next;
  for (const listener of contentListeners) listener();
}

/** Set the live reasoning/thinking trace. No-op when unchanged. */
export function setStreamReasoning(next: string): void {
  if (next === reasoning) return;
  reasoning = next;
  for (const listener of reasoningListeners) listener();
}

export function subscribeStreamContent(listener: () => void): () => void {
  contentListeners.add(listener);
  return () => {
    contentListeners.delete(listener);
  };
}

export function subscribeStreamReasoning(listener: () => void): () => void {
  reasoningListeners.add(listener);
  return () => {
    reasoningListeners.delete(listener);
  };
}

/** Subscribe a leaf component to the live assistant text. Re-renders only the
 *  caller on each token — never the parent tree. */
export function useStreamContent(): string {
  const [value, setValue] = useState(getStreamContent);
  useEffect(() => {
    // Sync any delta that landed between the initial render and this effect,
    // then track all subsequent updates.
    setValue(getStreamContent());
    return subscribeStreamContent(() => setValue(getStreamContent()));
  }, []);
  return value;
}

/** Subscribe a leaf component to the live reasoning trace. */
export function useStreamReasoning(): string {
  const [value, setValue] = useState(getStreamReasoning);
  useEffect(() => {
    setValue(getStreamReasoning());
    return subscribeStreamReasoning(() => setValue(getStreamReasoning()));
  }, []);
  return value;
}

export function getStreamPhase(): StreamPhase | null {
  return phase;
}

/** Set the live phase. No-op when unchanged. */
export function setStreamPhase(next: StreamPhase | null): void {
  if (next === phase) return;
  phase = next;
  for (const listener of phaseListeners) listener();
}

export function subscribeStreamPhase(listener: () => void): () => void {
  phaseListeners.add(listener);
  return () => {
    phaseListeners.delete(listener);
  };
}

/** Subscribe a leaf component to the live phase (status line). */
export function useStreamPhase(): StreamPhase | null {
  const [value, setValue] = useState(getStreamPhase);
  useEffect(() => {
    setValue(getStreamPhase());
    return subscribeStreamPhase(() => setValue(getStreamPhase()));
  }, []);
  return value;
}

export function getStreamReasoningStartedAt(): number | null {
  return reasoningStartedAt;
}

/** Record when reasoning began; notifies the reasoning leaf so its clock starts. */
export function setStreamReasoningStartedAt(next: number | null): void {
  if (next === reasoningStartedAt) return;
  reasoningStartedAt = next;
  for (const listener of reasoningListeners) listener();
}

/** Subscribe a leaf component to the reasoning start time. */
export function useStreamReasoningStartedAt(): number | null {
  const [value, setValue] = useState(getStreamReasoningStartedAt);
  useEffect(() => {
    setValue(getStreamReasoningStartedAt());
    return subscribeStreamReasoning(() => setValue(getStreamReasoningStartedAt()));
  }, []);
  return value;
}
