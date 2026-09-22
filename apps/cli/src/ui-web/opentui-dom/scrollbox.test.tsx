// The scrollbox ref adapter's unit conversion.
//
// OpenTUI measures scroll in CELLS; the DOM measures it in pixels. Every value
// crossing this boundary is converted, and a missing conversion would be wrong
// by the row height while still looking like a plausible number.
//
// These drive the REAL `makeScrollBoxHandle` over a stand-in node. Not a
// rendered <div>: jsdom does not lay out, so a real element reports every
// dimension as zero and the assertions would pass against nothing.

import { describe, expect, it } from "vitest";
import { makeScrollBoxHandle, type ScrollNode } from "./scrollbox.js";

const ROW = 16;
const COLUMN = 8;

function node(overrides: Partial<ScrollNode> = {}) {
  const element = {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 100 * ROW,
    scrollWidth: 80 * COLUMN,
    clientHeight: 20 * ROW,
    clientWidth: 80 * COLUMN,
    getBoundingClientRect: () => ({ top: 5 * ROW, left: 0 }),
    ...overrides,
  } as ScrollNode;
  return {
    element,
    handle: makeScrollBoxHandle(
      () => element,
      () => ({ row: ROW, column: COLUMN }),
    ),
  };
}

describe("scrollbox units", () => {
  it("reports scroll position and content height in rows", () => {
    const { element, handle } = node();
    element.scrollTop = 10 * ROW;
    expect(handle.scrollTop).toBe(10);
    expect(handle.scrollHeight).toBe(100);
    expect(handle.scrollWidth).toBe(80);
  });

  it("accepts scrollTo in rows, not pixels", () => {
    // `sb.scrollTo(sb.scrollHeight)` is the pin-to-bottom idiom in
    // use-turn-stream.ts; the argument is a row count, and passing it straight
    // to a DOM scrollTop would scroll 1/16th as far.
    const { element, handle } = node();
    handle.scrollTo(handle.scrollHeight);
    expect(element.scrollTop).toBe(100 * ROW);
  });

  it("accepts a two-axis scrollTo", () => {
    const { element, handle } = node();
    handle.scrollTo({ x: 4, y: 9 });
    expect(element.scrollTop).toBe(9 * ROW);
    expect(element.scrollLeft).toBe(4 * COLUMN);
  });

  it("scrolls by a relative row count", () => {
    const { element, handle } = node();
    element.scrollTop = 3 * ROW;
    handle.scrollBy(2);
    expect(element.scrollTop).toBe(5 * ROW);
  });

  it("reports the viewport in rows and screen rows", () => {
    // message-list.tsx compares `top + viewport.height >= scrollHeight - 3`,
    // all in rows. Mixing units there makes "at the bottom" never true, and the
    // transcript stops auto-following the stream.
    const { handle } = node();
    expect(handle.viewport.height).toBe(20);
    expect(handle.viewport.width).toBe(80);
    expect(handle.viewport.screenY).toBe(5);
    expect(handle.screenY).toBe(5);
  });

  it("round-trips a set through the getter", () => {
    const { element, handle } = node();
    handle.scrollTop = 7;
    expect(element.scrollTop).toBe(7 * ROW);
    expect(handle.scrollTop).toBe(7);
  });

  it("reads zeroes rather than throwing when the element is gone", () => {
    // Refs are null before mount and after unmount, and callers reach through
    // them from effects and timers.
    const handle = makeScrollBoxHandle(
      () => null,
      () => ({ row: ROW, column: COLUMN }),
    );
    expect(handle.scrollTop).toBe(0);
    expect(handle.scrollHeight).toBe(0);
    expect(handle.viewport).toEqual({ height: 0, width: 0, screenY: 0, screenX: 0 });
    expect(() => handle.scrollTo(10)).not.toThrow();
  });

  it("falls back to a sane cell size rather than dividing by zero", () => {
    // getComputedStyle can return nothing useful before the stylesheet applies.
    const element = { ...node().element };
    const handle = makeScrollBoxHandle(
      () => element,
      () => ({ row: 0, column: 0 }),
    );
    expect(Number.isFinite(handle.scrollHeight)).toBe(true);
  });
});
