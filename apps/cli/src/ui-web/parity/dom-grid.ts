// Browser-side capture for the phase 5 P0 exit criterion.
//
// The terminal reference is a character grid — which glyph landed in which
// cell. To compare against it honestly, the browser has to produce the same
// kind of artifact, so this projects the rendered DOM back onto a cell grid
// rather than comparing screenshots. A pixel diff of a monospace layout reports
// font hinting; a cell diff reports layout.
//
// Every character is measured individually via a Range. That is slower than
// measuring elements, but it is the only approach that survives text wrapping:
// a wrapped <text> is one DOM node occupying several rows, and only per-glyph
// rects say where each row started.

export interface GridCapture {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  text: string;
  /** Characters that fell outside the grid — a real overflow, not a rounding blip. */
  clipped: number;
}

/** Measure one cell from the live font rather than assuming 8x16. */
export function measureCell(root: HTMLElement): { width: number; height: number } {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
  root.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 100;
  probe.remove();

  const declared = getComputedStyle(root).getPropertyValue("--row").trim();
  const height = declared.endsWith("px") ? Number.parseFloat(declared) : 16;
  return { width, height };
}

function* characterRects(root: Node): Generator<{ char: string; rect: DOMRect }> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];
      if (char === " " || char === "\n" || char === "\t") continue;
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect();
      // A zero-area rect means the glyph is not laid out (display:none, an
      // empty inline). Placing it would invent content that is not on screen.
      if (rect.width === 0 && rect.height === 0) continue;
      yield { char, rect };
    }
  }
}

/**
 * Project the rendered tree onto a `columns` x `rows` character grid.
 *
 * Cell assignment rounds the glyph's own left/top against the grid origin, so a
 * sub-pixel layout difference stays in the same cell and a genuine one-cell
 * shift shows up as one.
 */
export function captureGrid(root: HTMLElement, columns: number, rows: number): GridCapture {
  const cell = measureCell(root);
  const origin = root.getBoundingClientRect();
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "));
  let clipped = 0;

  for (const { char, rect } of characterRects(root)) {
    const col = Math.round((rect.left - origin.left) / cell.width);
    const row = Math.round((rect.top - origin.top) / cell.height);
    if (row < 0 || row >= rows || col < 0 || col >= columns) {
      clipped += 1;
      continue;
    }
    grid[row][col] = char;
  }

  return {
    columns,
    rows,
    cellWidth: cell.width,
    cellHeight: cell.height,
    clipped,
    text: grid.map((line) => line.join("").replace(/ +$/, "")).join("\n"),
  };
}
