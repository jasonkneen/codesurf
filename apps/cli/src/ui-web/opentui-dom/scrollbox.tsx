/** @jsxImportSource react */
// `<scrollbox>` with a ScrollBoxRenderable-shaped ref.
//
// 21 call sites use the tag and several reach through its ref:
// `sb.scrollTo(sb.scrollHeight)` to pin the transcript to the bottom,
// `sb.scrollTop` / `sb.scrollHeight` / `sb.viewport.height` in message-list to
// decide whether the user has scrolled away from the tail.
//
// The unit is the load-bearing detail. OpenTUI measures scroll in CELLS; the
// DOM measures it in pixels. A shim that forwarded the numbers unconverted
// would be wrong by a factor of the row height — and silently so, because every
// value involved is a plausible-looking number. Everything crossing this
// boundary is converted.

import { type CSSProperties, type ReactNode, useImperativeHandle, useRef } from "react";
import { propsToStyle } from "./props-to-style.js";

/** The subset of ScrollBoxRenderable the component tree actually reaches for. */
export interface ScrollBoxHandle {
  /** Rows scrolled from the top. */
  scrollTop: number;
  scrollLeft: number;
  /** Total content height in rows. */
  scrollHeight: number;
  scrollWidth: number;
  /** Visible area, in rows and screen rows. */
  viewport: { height: number; width: number; screenY: number; screenX: number };
  screenY: number;
  scrollTo(position: number | { x: number; y: number }): void;
  scrollBy(delta: number | { x: number; y: number }): void;
  /** The underlying element, for anything this adapter does not cover. */
  element: HTMLElement | null;
}

/** The pixel size of one cell, and the scrollable box to apply it to. */
export interface ScrollMetrics {
  row: number;
  column: number;
}

/**
 * The scrollable box, reduced to the properties the adapter reads.
 *
 * An interface rather than HTMLElement so the conversion arithmetic can be
 * tested against known dimensions — jsdom does not lay out, so a real element
 * reports every dimension as zero and a test against one asserts nothing.
 */
export interface ScrollNode {
  scrollTop: number;
  scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
  getBoundingClientRect(): { top: number; left: number };
}

/**
 * Build the cell-unit handle over a pixel-unit node.
 *
 * Exported separately from the component so the conversion — the part that can
 * be wrong — is reachable by tests without a renderer.
 */
export function makeScrollBoxHandle(node: () => ScrollNode | null, metrics: () => ScrollMetrics): ScrollBoxHandle {
  const rows = () => metrics().row || 16;
  const cols = () => metrics().column || 8;

  return {
    get scrollTop() {
      const element = node();
      return element ? element.scrollTop / rows() : 0;
    },
    set scrollTop(value: number) {
      const element = node();
      if (element) element.scrollTop = value * rows();
    },
    get scrollLeft() {
      const element = node();
      return element ? element.scrollLeft / cols() : 0;
    },
    set scrollLeft(value: number) {
      const element = node();
      if (element) element.scrollLeft = value * cols();
    },
    get scrollHeight() {
      const element = node();
      return element ? element.scrollHeight / rows() : 0;
    },
    get scrollWidth() {
      const element = node();
      return element ? element.scrollWidth / cols() : 0;
    },
    get viewport() {
      const element = node();
      if (!element) return { height: 0, width: 0, screenY: 0, screenX: 0 };
      const box = element.getBoundingClientRect();
      return {
        height: Math.round(element.clientHeight / rows()),
        width: Math.round(element.clientWidth / cols()),
        // Screen position in rows, which is what message-list uses to clip
        // inline images to the visible area.
        screenY: Math.round(box.top / rows()),
        screenX: Math.round(box.left / cols()),
      };
    },
    get screenY() {
      const element = node();
      return element ? Math.round(element.getBoundingClientRect().top / rows()) : 0;
    },
    scrollTo(position) {
      const element = node();
      if (!element) return;
      // `scrollTo(sb.scrollHeight)` is the pin-to-bottom idiom, and it passes a
      // number meaning ROWS — not a DOM ScrollToOptions.
      if (typeof position === "number") element.scrollTop = position * rows();
      else {
        element.scrollTop = position.y * rows();
        element.scrollLeft = position.x * cols();
      }
    },
    scrollBy(delta) {
      const element = node();
      if (!element) return;
      if (typeof delta === "number") element.scrollTop += delta * rows();
      else {
        element.scrollTop += delta.y * rows();
        element.scrollLeft += delta.x * cols();
      }
    },
    get element() {
      return node() as HTMLElement | null;
    },
  };
}

/** Row height in pixels, from the cell grid the page declares. */
export function rowHeight(element: HTMLElement): number {
  const declared = getComputedStyle(element).getPropertyValue("--row").trim();
  const parsed = declared.endsWith("px") ? Number.parseFloat(declared) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

export function cellWidth(element: HTMLElement): number {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
  element.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return width > 0 ? width : 8;
}

type ScrollBoxProps = {
  children?: ReactNode;
  ref?: React.Ref<ScrollBoxHandle>;
} & Record<string, unknown>;

export function ScrollBox({ children, ref, ...props }: ScrollBoxProps) {
  const element = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () =>
      makeScrollBoxHandle(
        () => element.current,
        () => {
          const node = element.current;
          return node ? { row: rowHeight(node), column: cellWidth(node) } : { row: 16, column: 8 };
        },
      ),
    [],
  );

  const style: CSSProperties = { ...propsToStyle(props as never), overflow: "auto" };
  return (
    <div ref={element} style={style}>
      {children}
    </div>
  );
}

export const scrollbox = ScrollBox;
