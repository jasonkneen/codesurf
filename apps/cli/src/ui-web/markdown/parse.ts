// Markdown → a line model, for the DOM host.
//
// `<markdown>` is the one OpenTUI renderable with no DOM twin: it is an
// incremental tree-sitter renderer drawing onto the cell grid. Only two call
// sites use it, but between them they render the entire transcript — including
// partial code fences and tables mid-stream — so the spec (§6.1) calls it a real
// implementation rather than a shim, and this is it.
//
// The output model is LINES, not a DOM tree. That is deliberate: the terminal
// lays markdown out on a cell grid, one row at a time, and a model shaped the
// same way can be compared against it row by row by the parity harness. A
// conventional nested-element AST would render fine and be impossible to check.
//
// Scope names match the terminal's syntax-style scopes (`markup.heading`,
// `markup.bold`, `code`, …) so both hosts colour from one theme.

export type Scope =
  | "default"
  | "markup.heading"
  | "markup.bold"
  | "markup.italic"
  | "markup.raw"
  | "markup.link"
  | "markup.link.label"
  | "markup.list"
  | "markup.quote"
  | "markup.separator"
  | "code";

export interface Segment {
  text: string;
  scope: Scope;
}

export interface Line {
  segments: Segment[];
  /** Code lines take the code background across the full width. */
  code?: boolean;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
/** A closing fence carries no info string (CommonMark §4.5). */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const HR = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * Inline markers, in precedence order.
 *
 * Code first: a backtick span is literal, so `**not bold**` inside one must stay
 * literal. Links before emphasis for the same reason — a URL can contain
 * underscores and asterisks.
 */
const INLINE = [
  { scope: "markup.raw" as const, re: /`([^`]+)`/ },
  { scope: "link" as const, re: /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
  // Underscore emphasis never opens or closes inside a word (CommonMark), so
  // `snake_case_name` stays literal. Asterisks may be intraword.
  { scope: "markup.bold" as const, re: /\*\*([^*]+)\*\*|(?<![\p{L}\p{N}_])__([^_]+)__(?![\p{L}\p{N}_])/u },
  { scope: "markup.italic" as const, re: /\*([^*]+)\*|(?<![\p{L}\p{N}_])_([^_]+)_(?![\p{L}\p{N}_])/u },
];

/**
 * Split one line of text into styled segments.
 *
 * Markers are concealed, matching the terminal's `conceal` mode: `**bold**`
 * renders as `bold`, not as `**bold**`. A link renders as its label followed by
 * the URL in parentheses, which is what the terminal draws — the URL has to stay
 * visible because a cell grid has nowhere to hide a href.
 */
export function parseInline(text: string, scope: Scope = "default"): Segment[] {
  if (!text) return [];

  let earliest: { index: number; match: RegExpMatchArray; kind: (typeof INLINE)[number] } | null = null;
  for (const kind of INLINE) {
    const match = text.match(kind.re);
    if (match?.index === undefined) continue;
    if (!earliest || match.index < earliest.index) earliest = { index: match.index, match, kind };
  }

  if (!earliest) return [{ text, scope }];

  const { index, match, kind } = earliest;
  const before = text.slice(0, index);
  const after = text.slice(index + match[0].length);
  const segments: Segment[] = [];

  if (before) segments.push({ text: before, scope });

  if (kind.scope === "link") {
    const label = match[1] || match[2];
    segments.push({ text: label, scope: "markup.link.label" });
    segments.push({ text: ` (${match[2]})`, scope: "markup.link" });
  } else {
    const inner = match[1] ?? match[2] ?? "";
    // Emphasis nests; code does not — its content is literal by definition.
    segments.push(
      ...(kind.scope === "markup.raw" ? [{ text: inner, scope: kind.scope }] : parseInline(inner, kind.scope)),
    );
  }

  segments.push(...parseInline(after, scope));
  return segments;
}

/**
 * Terminal cell width of one code point: 0 for combining marks / zero-width
 * joiners and variation selectors, 2 for East Asian wide and emoji, else 1.
 */
function codePointWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Truncate/pad `text` to exactly `width` cells, never splitting a code point. */
export function fitCells(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = codePointWidth(ch.codePointAt(0) ?? 0);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out + " ".repeat(Math.max(0, width - used));
}

/** Render a table's cells as a box-drawn grid, sized to `width` columns. */
function tableLines(rows: string[][], width: number): Line[] {
  const columns = Math.max(...rows.map((r) => r.length));
  // Balanced fit: every column the same width, which is what the terminal's
  // "balanced" columnFitter does at full width.
  const inner = Math.max(0, width - (columns + 1));
  const base = Math.floor(inner / columns);
  const widths = Array.from({ length: columns }, (_, i) => base + (i < inner - base * columns ? 1 : 0));

  const rule = (left: string, mid: string, right: string): Line => ({
    segments: [{ text: left + widths.map((w) => "─".repeat(w)).join(mid) + right, scope: "markup.separator" }],
  });

  const cells = (row: string[]): Line => ({
    segments: [
      {
        text: `│${widths.map((w, i) => fitCells(row[i] ?? "", w)).join("│")}│`,
        scope: "default",
      },
    ],
  });

  const lines: Line[] = [rule("╭", "┬", "╮")];
  rows.forEach((row, index) => {
    lines.push(cells(row));
    if (index < rows.length - 1) lines.push(rule("├", "┼", "┤"));
  });
  lines.push(rule("╰", "┴", "╯"));
  return lines;
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Parse a markdown document into rendered lines.
 *
 * `width` is the available cell width, needed because tables are laid out to it.
 *
 * There is deliberately no `streaming` parameter, unlike the terminal
 * renderable. That flag exists there to keep an incremental tree-sitter parse
 * from re-lexing a stable prefix; this parser is a single linear pass with no
 * retained state, so re-parsing a growing buffer is already correct and a flag
 * would only be a parameter that changed nothing. A half-typed fence renders as
 * code in both cases, which is the behaviour the flag was protecting.
 */
export function parseMarkdown(content: string, width: number): Line[] {
  const source = content.replace(/\s+$/, "").split("\n");
  const lines: Line[] = [];
  let index = 0;

  while (index < source.length) {
    const raw = source[index];

    const fence = raw.match(FENCE);
    if (fence) {
      const marker = fence[1];
      index += 1;
      const body: string[] = [];
      while (index < source.length) {
        // Closes only on the same fence character, at least as long as the
        // opener, with no info string — so a ```` ```ts ```` line or a shorter
        // run inside a longer fence stays part of the code.
        const close = source[index].match(FENCE_CLOSE);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
          index += 1;
          break;
        }
        body.push(source[index]);
        index += 1;
      }
      // Whether the fence closed or the stream just has not reached the closing
      // marker yet, the body so far is code — which is the point of telling the
      // parser it is streaming: a half-typed fence renders as code immediately
      // instead of flickering as paragraph text until the fence completes.
      for (const codeLine of body) lines.push({ segments: [{ text: codeLine, scope: "code" }], code: true });
      continue;
    }

    const heading = raw.match(HEADING);
    if (heading) {
      lines.push({ segments: parseInline(heading[2], "markup.heading") });
      index += 1;
      continue;
    }

    if (HR.test(raw)) {
      lines.push({ segments: [{ text: raw.trim(), scope: "markup.separator" }] });
      index += 1;
      continue;
    }

    const quote = raw.match(QUOTE);
    if (quote) {
      // The terminal renderable drops the blank line before a blockquote —
      // always, not only after a list — while keeping the one after it and the
      // separators around every other block. That is inconsistent and is not
      // what CommonMark says, but the two fronts render the same transcript and
      // a blank line that appears in one and not the other is a visible
      // difference between them, so this matches the terminal on purpose.
      // Verified against the real renderable; pinned by parse.test.ts.
      const previous = lines[lines.length - 1];
      const startsQuote = previous && previous.segments[0]?.scope !== "markup.quote";
      if (startsQuote && previous.segments.length === 0) lines.pop();

      lines.push({ segments: [{ text: "> ", scope: "markup.quote" }, ...parseInline(quote[1], "markup.quote")] });
      index += 1;
      continue;
    }

    // A table is a run of pipe rows; its divider row is structure, not content.
    if (TABLE_ROW.test(raw) && index + 1 < source.length && TABLE_DIVIDER.test(source[index + 1])) {
      const rows: string[][] = [splitRow(raw)];
      index += 2;
      while (index < source.length && TABLE_ROW.test(source[index])) {
        rows.push(splitRow(source[index]));
        index += 1;
      }
      lines.push(...tableLines(rows, width));
      continue;
    }

    const bullet = raw.match(BULLET);
    if (bullet) {
      lines.push({
        segments: [{ text: `${bullet[1]}${bullet[2]} `, scope: "markup.list" }, ...parseInline(bullet[3])],
      });
      index += 1;
      continue;
    }

    const ordered = raw.match(ORDERED);
    if (ordered) {
      lines.push({
        segments: [{ text: `${ordered[1]}${ordered[2]} `, scope: "markup.list" }, ...parseInline(ordered[3])],
      });
      index += 1;
      continue;
    }

    lines.push({ segments: parseInline(raw) });
    index += 1;
  }

  return lines;
}
