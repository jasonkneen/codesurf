// DOM host hooks: the surface src/ui consumes from @opentui/react.
//
// Four symbols across 22 files (spec §2.2): useTerminalDimensions,
// useKeyboard, useRenderer, flushSync. All four must match the real signatures
// — a hook with the wrong shape does not fail loudly here, it just silently
// never fires.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync as domFlushSync } from "react-dom";
import { toKeyEvent, type WebKeyEvent } from "./keys.js";

export interface TermDim {
  width: number;
  height: number;
}

/** The element the app is mounted in, which defines the cell grid. */
function mountRoot(): HTMLElement | null {
  return document.getElementById("root") ?? document.body ?? null;
}

/** Measure the cell from the live font rather than assuming 8x16. */
function measureCell(root: HTMLElement): { width: number; height: number } {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
  root.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 100;
  probe.remove();

  const declared = getComputedStyle(root).getPropertyValue("--row").trim();
  const height = declared.endsWith("px") ? Number.parseFloat(declared) : 16;
  return { width: width || 8, height: height || 16 };
}

/**
 * The viewport in character cells.
 *
 * Everything in the tree sizes itself against this — `Math.min(Math.max(60,
 * width - 4), width)` and friends — so it has to be in cells, not pixels, and
 * it has to be measured. The first version of this hook looked for an element
 * id that does not exist and so returned a hardcoded 80x24 for ever, which
 * every layout then quietly sized itself to.
 */
export function useTerminalDimensions(): TermDim {
  const [dims, setDims] = useState<TermDim>({ width: 80, height: 24 });

  useLayoutEffect(() => {
    const root = mountRoot();
    if (!root || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const cell = measureCell(root);
      const box = root.getBoundingClientRect();
      setDims({
        // Round, not floor: an integer pixel measurement of an exact cell count
        // lands just under it and would report one column short.
        width: Math.max(20, Math.round(box.width / cell.width)),
        height: Math.max(5, Math.round(box.height / cell.height)),
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return dims;
}

export interface UseKeyboardOptions {
  /** Also deliver release events, as `eventType: "release"`. */
  release?: boolean;
}

/**
 * Subscribe to keyboard events, in the terminal's event shape.
 *
 * Listens on `window` in the capture phase because the terminal's handler is
 * global: there is no focused element in a TUI, and the tree's handlers assume
 * they see every key regardless of what the browser thinks is focused.
 *
 * The handler is held in a ref so a fresh closure each render does not
 * re-subscribe — matching the terminal hook, which the tree relies on (see
 * `use-flushed-keyboard.ts`, which exists precisely because subscription
 * identity matters).
 */
export function useKeyboard(handler: (key: WebKeyEvent) => void, options?: UseKeyboardOptions): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const release = options?.release ?? false;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => handlerRef.current(toKeyEvent(event));
    window.addEventListener("keydown", onKey, true);
    if (release) window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (release) window.removeEventListener("keyup", onKey, true);
    };
  }, [release]);
}

/**
 * The renderer handle.
 *
 * The terminal's exposes the draw surface (`OptimizedBuffer`, `renderBefore`)
 * as well as dimensions. Only the dimensions have a DOM meaning; the direct-draw
 * hooks are §6.4's open question and are not stubbed with no-ops here, because
 * a no-op `renderBefore` would let a caller believe it had drawn something.
 */
export function useRenderer(): TermDim {
  return useTerminalDimensions();
}

/**
 * React's own flushSync.
 *
 * Not a pass-through: `use-flushed-keyboard.ts` wraps its handler in this
 * specifically to force a synchronous commit, because without it the TUI
 * rendered one keypress behind. A version that merely called the function would
 * reintroduce exactly that bug on web, silently.
 */
export const flushSync = domFlushSync;
