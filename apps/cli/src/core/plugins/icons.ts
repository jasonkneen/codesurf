// Icon resolver sink.
//
// Singleton, last-bind-wins. Same shape as `setCwdProvider` /
// `setSessionIdProvider` — a host (here: the `builtin.icons.nerd-fonts`
// extension when its setting is on) binds a resolver, and UI components
// read it lazily at render time via `useIcon(name)`. When no resolver is
// bound, `getIcon` returns the empty string and the UI degrades to the
// pre-icons rendering with zero visual cost.
//
// We don't use a multi-contributor registry (like statusIndicators) because
// icons are a theme decision — one set wins. If a future need arises for
// stacked / themed icon packs, the resolver can dispatch internally.

import { useSyncExternalStore } from "react";

export type IconResolver = (name: string) => string | null;

let resolver: IconResolver | null = null;
const subscribers = new Set<() => void>();

/**
 * Bind (or clear) the active icon resolver. Pass `null` to disable icons
 * entirely. Triggers a re-render of every component using `useIcon`.
 */
export function setIconResolver(next: IconResolver | null): void {
  resolver = next;
  for (const cb of subscribers) cb();
}

/** The currently bound resolver, so a releaser can compare before clearing. */
export function getIconResolver(): IconResolver | null {
  return resolver;
}

/**
 * Synchronous icon lookup. Returns the empty string when no resolver is
 * bound or the resolver returns `null`. Never throws — a resolver that
 * throws is caught and treated as "no icon for this name."
 */
export function getIcon(name: string): string {
  if (!resolver) return "";
  try {
    return resolver(name) ?? "";
  } catch {
    return "";
  }
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * React hook for icon lookup. Re-renders the calling component whenever the
 * resolver is rebound (e.g. the user toggles `nerdIcons.enabled`).
 */
export function useIcon(name: string): string {
  return useSyncExternalStore(
    subscribe,
    () => getIcon(name),
    () => getIcon(name),
  );
}

/** Test-only reset. */
export function __resetIconResolverForTests(): void {
  resolver = null;
  subscribers.clear();
}
