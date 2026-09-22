import type { CSSProperties } from "react";

// props-to-style.ts — the load-bearing P0 module: maps OpenTUI/yoga layout props
// to CSS. widths/heights are character CELLS (1ch horizontal, one --row vertical),
// matching the terminal's cell grid so existing arithmetic holds.

export type BorderEdge = "top" | "right" | "bottom" | "left";

export interface CellProps {
  flexDirection?: string;
  flexGrow?: number;
  flexShrink?: number;
  flexWrap?: string;
  alignItems?: string;
  justifyContent?: string;
  width?: number | string;
  height?: number | string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  gap?: number | string;
  fg?: string;
  bg?: string;
  /** The components' own spelling; OpenTUI accepts both. */
  backgroundColor?: string;
  wrapMode?: string;
  /** `true` = all four edges, or the subset to draw. */
  border?: boolean | readonly string[];
  borderStyle?: string;
  borderColor?: string;
}

const ALL_EDGES: readonly BorderEdge[] = ["top", "right", "bottom", "left"];

const cell = (n: number) => `calc(${n} * 1ch)`;
const row = (n: number) => `calc(${n} * var(--row))`;

/** Which edges a box draws. */
export function borderEdges(border: CellProps["border"]): Set<BorderEdge> {
  if (border === true) return new Set(ALL_EDGES);
  if (Array.isArray(border)) return new Set(border.filter((e): e is BorderEdge => ALL_EDGES.includes(e as BorderEdge)));
  return new Set();
}

/**
 * Draw the box's border edges as thin rules, each centred inside a reserved cell.
 *
 * A terminal border is made of characters, so it OCCUPIES a cell on every edge
 * it draws: a bordered panel's inner width is two columns narrower than its
 * outer width, and every `width - 2` in the component tree assumes exactly that.
 * A CSS `border` sits between cells and occupies none, so using one would make
 * every bordered panel two columns and two rows bigger on web than in the
 * terminal, and the shared cell arithmetic — the entire premise of reusing these
 * components — would quietly stop holding.
 *
 * So the cell is reserved with padding (see `propsToStyle`) and the rule is
 * painted as a background layer through the middle of it. Geometry matches the
 * terminal exactly; the glyphs do not, because box-drawing characters would only
 * matter if the web target were trying to look like a terminal rather than to
 * lay out like one. Recorded as the §9 decision in the phase 5 spec.
 */
function borderLayers(edges: Set<BorderEdge>, color: string): CSSProperties {
  if (edges.size === 0) return {};
  const line = `linear-gradient(${color}, ${color})`;
  const images: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];

  // Half a pixel back so the 1px rule straddles the cell's centre line rather
  // than sitting one device pixel below it.
  const midRow = "calc(var(--row) / 2 - 0.5px)";
  const midCell = "calc(0.5ch - 0.5px)";

  const push = (size: string, position: string) => {
    images.push(line);
    sizes.push(size);
    positions.push(position);
  };

  if (edges.has("top")) push("100% 1px", `left 0 top ${midRow}`);
  if (edges.has("bottom")) push("100% 1px", `left 0 bottom ${midRow}`);
  if (edges.has("left")) push("1px 100%", `left ${midCell} top 0`);
  if (edges.has("right")) push("1px 100%", `right ${midCell} top 0`);

  return {
    backgroundImage: images.join(", "),
    backgroundSize: sizes.join(", "),
    backgroundPosition: positions.join(", "),
    backgroundRepeat: "no-repeat",
  };
}

/**
 * How text wraps.
 *
 * `pre-wrap` rather than the browser default, because HTML collapses runs of
 * spaces and a terminal does not. The component tree aligns columns by writing
 * literal spaces into strings (`  ${done}/${total}`), so under the default every
 * such gap silently vanishes and the two hosts disagree on nearly every row.
 */
export function whiteSpaceFor(wrapMode: string | undefined): CSSProperties["whiteSpace"] {
  return wrapMode === "none" ? "pre" : "pre-wrap";
}

export function propsToStyle(p: CellProps): CSSProperties {
  const s: CSSProperties = { display: "flex", flexDirection: "column", boxSizing: "border-box" };
  if (p.flexDirection) s.flexDirection = p.flexDirection as never;
  if (p.flexGrow !== undefined) s.flexGrow = p.flexGrow;
  if (p.flexShrink !== undefined) s.flexShrink = p.flexShrink;
  if (p.flexWrap) s.flexWrap = p.flexWrap as never;
  if (p.alignItems) s.alignItems = p.alignItems as never;
  if (p.justifyContent) s.justifyContent = p.justifyContent as never;
  if (typeof p.width === "number") s.width = cell(p.width);
  else if (typeof p.width === "string") s.width = p.width;
  if (typeof p.height === "number") s.height = row(p.height);
  else if (typeof p.height === "string") s.height = p.height;

  // Each drawn edge eats one cell, exactly as its characters do in the terminal.
  const edges = borderEdges(p.border);
  const padCells = (declared: number | undefined, edge: BorderEdge) => (declared ?? 0) + (edges.has(edge) ? 1 : 0);

  const paddingLeft = padCells(p.paddingLeft, "left");
  const paddingRight = padCells(p.paddingRight, "right");
  const paddingTop = padCells(p.paddingTop, "top");
  const paddingBottom = padCells(p.paddingBottom, "bottom");
  if (paddingLeft) s.paddingLeft = cell(paddingLeft);
  if (paddingRight) s.paddingRight = cell(paddingRight);
  if (paddingTop) s.paddingTop = row(paddingTop);
  if (paddingBottom) s.paddingBottom = row(paddingBottom);

  // Horizontal spacing uses the character width (1ch); vertical uses one row.
  if (p.marginLeft !== undefined) s.marginLeft = cell(p.marginLeft);
  if (p.marginRight !== undefined) s.marginRight = cell(p.marginRight);
  if (p.marginTop !== undefined) s.marginTop = row(p.marginTop);
  if (p.marginBottom !== undefined) s.marginBottom = row(p.marginBottom);

  if (p.gap !== undefined) {
    // gap follows the flex direction: column → vertical (row), row → horizontal (ch).
    s.gap = typeof p.gap === "number" ? (p.flexDirection === "row" ? cell(p.gap) : row(p.gap)) : p.gap;
  }
  if (p.fg) s.color = p.fg;
  const background = p.bg ?? p.backgroundColor;
  if (background) s.backgroundColor = background;
  if (p.wrapMode) s.whiteSpace = whiteSpaceFor(p.wrapMode);
  Object.assign(s, borderLayers(edges, p.borderColor ?? "currentColor"));
  return s;
}
