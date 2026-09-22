/** @jsxImportSource react */
// The DOM host's `<markdown>`: the web implementation §6.1 asks for.
//
// Renders the line model from ./parse.ts onto the cell grid — one <div> per
// row, one <span> per styled segment. Line-per-row rather than a nested
// element tree because the terminal lays markdown out row by row on a cell
// grid, and a model shaped the same way is the only one the parity harness can
// check against it.
//
// Colours come from the SyntaxStyle the component tree already builds from the
// theme (src/ui/markdown.tsx), so both hosts paint from one source and the web
// transcript is themed rather than default-black.

import { type CSSProperties, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SyntaxStyle, SyntaxStyleEntry } from "../opentui-dom/core-shim.js";
import { type Line, parseMarkdown, type Scope } from "./parse.js";

/** Enough of a fallback that an unthemed render is still readable. */
const FALLBACK: Partial<Record<Scope, CSSProperties>> = {
  "markup.heading": { fontWeight: 700 },
  "markup.bold": { fontWeight: 700 },
  "markup.italic": { fontStyle: "italic" },
  "markup.link": { textDecoration: "underline" },
};

function styleFor(scope: Scope, syntaxStyle?: SyntaxStyle): CSSProperties {
  const entry: SyntaxStyleEntry | undefined = syntaxStyle?.get(scope);
  const style: CSSProperties = { ...FALLBACK[scope] };
  if (!entry) return style;
  if (entry.fg) style.color = String(entry.fg);
  if (entry.bg) style.backgroundColor = String(entry.bg);
  if (entry.bold) style.fontWeight = 700;
  if (entry.italic) style.fontStyle = "italic";
  if (entry.underline) style.textDecoration = "underline";
  return style;
}

/**
 * The element's width in character cells.
 *
 * Tables are laid out to the available width, and the terminal renderable gets
 * that for free by filling its flex parent. On web it has to be measured, so
 * this reads the laid-out box and divides by a measured character advance —
 * measured rather than assumed, because `1ch` depends on the resolved font and
 * a hardcoded 8px is wrong the moment anyone changes the font size.
 *
 * Returns `null` until the first layout, so the caller can avoid laying out a
 * table at a guessed width and then visibly reflowing it.
 */
function useCellWidth(ref: React.RefObject<HTMLDivElement | null>): number | null {
  const [cells, setCells] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const probe = document.createElement("span");
      probe.textContent = "M".repeat(100);
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
      element.appendChild(probe);
      const advance = probe.getBoundingClientRect().width / 100;
      probe.remove();
      if (advance <= 0) return;
      // getBoundingClientRect, not clientWidth, and round rather than floor:
      // clientWidth is an integer, so a box of 69 cells at 8.036px measures 554
      // instead of 554.48 and floors to 68 — one column short, which showed up
      // as every table being one cell narrower than the terminal's.
      setCells(Math.max(1, Math.round(element.getBoundingClientRect().width / advance)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return cells;
}

export interface WebMarkdownProps {
  content: string;
  syntaxStyle?: SyntaxStyle;
  /** Cell width for layout. Measured from the element when not given. */
  width?: number;
}

export function WebMarkdown({ content, syntaxStyle, width }: WebMarkdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const measured = useCellWidth(ref);
  const columns = width ?? measured;
  const codeBackground = syntaxStyle?.get("code").bg;

  // Nothing is rendered until a width is known, because the only thing that
  // depends on it — table layout — would otherwise be drawn at a guess and then
  // jump. The gap is one frame.
  const lines: Line[] = useMemo(
    () => (columns === null ? [] : parseMarkdown(content ?? "", columns)),
    [content, columns],
  );

  return (
    <div
      ref={ref}
      style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        // Take the parent's width, not the content's: a table wider than the
        // parent would otherwise stretch this box and measure itself.
        width: "100%",
        minWidth: 0,
      }}
    >
      {lines.map((line, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional rows, not identities.
          key={index}
          style={{
            // `pre` not `pre-wrap`: a markdown row is already laid out to the
            // cell grid by the parser, so letting the browser re-wrap it would
            // put content in rows the terminal does not have.
            whiteSpace: "pre",
            // A blank line still occupies a row; without this an empty div
            // collapses and every row below it shifts up one cell.
            minHeight: "var(--row)",
            ...(line.code && codeBackground ? { backgroundColor: String(codeBackground) } : {}),
          }}
        >
          {line.segments.map((segment, segmentIndex) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within a row.
              key={segmentIndex}
              style={styleFor(segment.scope, syntaxStyle)}
            >
              {segment.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
