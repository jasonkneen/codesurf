import type { KeyEvent } from "@opentui/core";
import { flushSync, useKeyboard } from "@opentui/react";
import { useCallback, useRef } from "react";

/**
 * useKeyboard variant that flushes React synchronously after the handler.
 *
 * OpenTUI dispatches keypresses from a native (FFI) stdin callback. Under Bun,
 * React's scheduled work (microtask/macrotask hops from `setState`) is NOT
 * drained at the end of that callback — it stays queued until the next event
 * loop wakeup, which in practice is the NEXT keypress. Every modal list,
 * search filter, and selection highlight therefore rendered one key behind
 * ("keyboard very slow"). Solid-based TUIs (opencode) don't hit this because
 * signals update synchronously inside the handler.
 *
 * Wrapping the handler in `flushSync` forces the reconciler to commit the
 * state updates before the callback returns, so the frame rendered after this
 * keypress reflects this keypress.
 *
 * The handler is kept in a ref (fresh closures every render) while the
 * registered callback stays stable, so `useKeyboard` subscribes exactly once.
 */
export function useFlushedKeyboard(handler: (key: KeyEvent) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useKeyboard(
    useCallback((key: KeyEvent) => {
      flushSync(() => {
        handlerRef.current(key);
      });
    }, []),
  );
}
