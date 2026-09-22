// In-process agent event bus.
//
// Companion to the shell-hook system in src/hooks. The hook system fires
// user-configured shell commands on events like PreToolUse / Stop /
// UserPromptSubmit. This module gives in-process consumers (builtin
// extensions, UI surfaces) a way to subscribe to the same events without
// spawning a subprocess.
//
// Wired by `executeEventHooks` in src/hooks/index.ts — every event that
// reaches the shell-hook executor also reaches in-process listeners,
// regardless of whether any shell hooks actually match. That means an
// extension can react to `Stop` even when the user has no `Stop` hook
// configured.
//
// Listener errors are swallowed so a broken extension can't crash the
// agent. Listeners run synchronously in registration order; they should
// not do meaningful work on the calling thread — schedule async work
// via setTimeout / Promise.resolve().then if you need to.
//
// Posture: same as `services.hooks` — builtin-only surface today, with a
// permission model planned for third-party extensions in a later phase.

import type { HookEvent, HookInput } from "../../hooks/types.js";

/**
 * Map an event name to the specific HookInput variant the listener will
 * receive. Mirrors the discriminated union in src/hooks/types.ts.
 */
type HookInputFor<E extends HookEvent> = Extract<HookInput, { hook_event_name: E }>;

export type AgentEventHandler<E extends HookEvent = HookEvent> = (input: HookInputFor<E>) => void;

const listeners = new Map<HookEvent, Set<AgentEventHandler>>();

/**
 * Subscribe to an in-process agent event. Returns a disposer that
 * removes the handler. Calling the disposer is idempotent.
 *
 * Multiple subscriptions to the same event are allowed and run in
 * registration order on emit.
 */
export function subscribeAgentEvent<E extends HookEvent>(event: E, handler: AgentEventHandler<E>): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  // Cast through unknown: the storage Set is heterogeneous across event
  // types, but the per-event invariant in `emitAgentEvent` guarantees
  // handlers only ever receive their declared event's payload.
  set.add(handler as unknown as AgentEventHandler);
  return () => {
    const current = listeners.get(event);
    if (!current) return;
    current.delete(handler as unknown as AgentEventHandler);
    if (current.size === 0) listeners.delete(event);
  };
}

/**
 * Fire an event to all subscribed in-process listeners. Called by
 * `executeEventHooks` so listeners and shell hooks see the same event
 * stream. Errors thrown by individual listeners are caught and ignored.
 */
export function emitAgentEvent(input: HookInput): void {
  const set = listeners.get(input.hook_event_name);
  if (!set || set.size === 0) return;
  for (const handler of set) {
    try {
      handler(input as HookInputFor<typeof input.hook_event_name>);
    } catch {
      // Listener errors must not break the agent or other listeners.
    }
  }
}

/**
 * Test-only helper. Drops every subscription so tests don't leak state
 * across cases.
 */
export function __resetAgentEventBusForTests(): void {
  listeners.clear();
}

/** Test-only helper — exposes the listener count for assertions. */
export function __agentEventListenerCountForTests(event: HookEvent): number {
  return listeners.get(event)?.size ?? 0;
}
