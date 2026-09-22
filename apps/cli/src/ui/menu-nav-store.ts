// Leaf-isolated selection-index stores for popup menus (slash menu, command
// palette, agents popup, …).
//
// WHY THIS EXISTS
// ----------------
// Menu selection indices used to live in `useState` at the top of the
// 7,800-line `App` component. Each arrow-key press called the setter, which
// reconciled all ~311 App hooks and re-evaluated the entire render tree just to
// move a highlight by one row — felt as janky menu navigation.
//
// Moving the index into a tiny external store means an arrow-key updates only
// the leaf component that subscribes (via `useIndexStore`), never App. The
// key handler reads the current value synchronously with `.get()` and writes
// with `.set()`, so it needs no React state at all. This mirrors the existing
// `agentsPopupIndexRef` ref-mirror pattern, and the stream-store leaf-isolation
// already shipped for streaming buffers.
//
// Reset-on-open is the caller's responsibility (call `.set(0)` when opening the
// menu), exactly as the old `setIndex(0)` calls did.

import { useEffect, useState } from "react";

type IndexUpdater = number | ((prev: number) => number);

export interface IndexStore {
  /** Current selection index. Safe to call at any time (e.g. key-handler time). */
  get(): number;
  /** Set the index directly or via an updater. No-ops (and skips notify) when unchanged. */
  set(next: IndexUpdater): void;
  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
}

export function createIndexStore(): IndexStore {
  let value = 0;
  const subscribers = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const v = typeof next === "function" ? next(value) : next;
      if (v === value) return;
      value = v;
      for (const cb of subscribers) cb();
    },
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}

/**
 * Subscribe a leaf component to a selection-index store. Re-renders only this
 * component on change — never the App above it.
 */
export function useIndexStore(store: IndexStore): number {
  const [value, setValue] = useState(store.get());
  useEffect(() => {
    // Sync in case the value changed between the initial render and effect
    // (e.g. the menu's open handler reset it to 0 just before mount).
    setValue(store.get());
    return store.subscribe(() => setValue(store.get()));
  }, [store]);
  return value;
}

/** Slash-menu selection index, isolated from App's useState. */
export const slashMenuIndexStore = createIndexStore();
