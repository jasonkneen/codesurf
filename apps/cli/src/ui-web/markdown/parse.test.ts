// The markdown line model.
//
// Every expectation here was checked against the REAL terminal renderable via
// `bun run parity markdown` — these are not guesses about what markdown "should"
// do, they are what the other host draws. Changing one changes what the web
// front renders relative to the terminal.

import { describe, expect, it } from "vitest";
import { fitCells, type Line, parseInline, parseMarkdown } from "./parse.js";

const text = (lines: Line[]) => lines.map((line) => line.segments.map((s) => s.text).join(""));

describe("inline", () => {
  it("conceals emphasis markers", () => {
    // The terminal renders `**bold**` as `bold`; the markers are styling, not
    // content, and a cell grid has nowhere to put them.
    expect(parseInline("a **b** c").map((s) => s.text)).toEqual(["a ", "b", " c"]);
    expect(parseInline("a **b** c").map((s) => s.scope)).toEqual(["default", "markup.bold", "default"]);
    expect(parseInline("_i_").map((s) => s.scope)).toEqual(["markup.italic"]);
  });

  it("keeps code spans literal", () => {
    // A backtick span is literal by definition, so emphasis inside one must not
    // be interpreted — otherwise `**x**` in a code sample renders as bold x.
    const segments = parseInline("use `a **b** c` here");
    expect(segments.map((s) => s.text)).toEqual(["use ", "a **b** c", " here"]);
    expect(segments[1].scope).toBe("markup.raw");
  });

  it("renders a link as label then URL", () => {
    // The URL stays visible because a cell grid cannot hide an href behind a
    // label. This is what the terminal draws.
    expect(parseInline("see [docs](https://x.dev) now").map((s) => s.text)).toEqual([
      "see ",
      "docs",
      " (https://x.dev)",
      " now",
    ]);
  });

  it("does not mistake a URL's punctuation for emphasis", () => {
    // Links are matched before emphasis for exactly this reason.
    expect(parseInline("[a](https://x.dev/a_b_c)").map((s) => s.text)).toEqual(["a", " (https://x.dev/a_b_c)"]);
  });
});

describe("blocks", () => {
  it("conceals heading markers", () => {
    expect(text(parseMarkdown("# Title", 40))).toEqual(["Title"]);
    expect(parseMarkdown("## Sub", 40)[0].segments[0].scope).toBe("markup.heading");
  });

  it("keeps list markers and indentation", () => {
    // Unlike emphasis, the bullet IS content on a cell grid — the terminal
    // draws it, so dropping it would shift every list item two cells left.
    expect(text(parseMarkdown("- one\n- two\n  - nested", 40))).toEqual(["- one", "- two", "  - nested"]);
    expect(text(parseMarkdown("1. one\n2. two", 40))).toEqual(["1. one", "2. two"]);
  });

  it("renders a fenced code block without its fences", () => {
    const lines = parseMarkdown("```ts\nconst a = 1;\n```", 40);
    expect(text(lines)).toEqual(["const a = 1;"]);
    expect(lines[0].code).toBe(true);
  });

  it("treats an unterminated fence as code", () => {
    // Mid-stream this is a fence being typed. Rendering the body as paragraph
    // text until the closing fence arrives would make it flicker.
    const lines = parseMarkdown("```ts\nconst a = 1;", 40);
    expect(lines[0].code).toBe(true);
    expect(text(lines)).toEqual(["const a = 1;"]);
  });

  it("drops the blank line before a blockquote, matching the terminal", () => {
    // Deliberate quirk-matching, not CommonMark. The terminal renderable drops
    // the separator before a quote — always, verified after both a paragraph
    // and a list — while keeping every other block's. The two fronts render the
    // same transcript, so a blank line in one and not the other is a visible
    // difference between them.
    expect(text(parseMarkdown("para\n\n> quote", 40))).toEqual(["para", "> quote"]);
    expect(text(parseMarkdown("- item\n\n> quote", 40))).toEqual(["- item", "> quote"]);
    // The blank line AFTER the quote is kept.
    expect(text(parseMarkdown("> quote\n\npara", 40))).toEqual(["> quote", "", "para"]);
  });

  it("keeps blank separators around every other block", () => {
    expect(text(parseMarkdown("# T\n\npara", 40))).toEqual(["T", "", "para"]);
  });
});

describe("tables", () => {
  const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

  it("draws a box-drawn grid fitted to the width", () => {
    const lines = text(parseMarkdown(TABLE, 21));
    expect(lines).toEqual([
      "╭─────────┬─────────╮",
      "│a        │b        │",
      "├─────────┼─────────┤",
      "│1        │2        │",
      "╰─────────┴─────────╯",
    ]);
    // Every row is exactly the requested width, or the grid tears.
    for (const line of lines) expect(line.length).toBe(21);
  });

  it("distributes an uneven remainder without losing a column", () => {
    // 22 cells over 2 columns leaves one spare; it goes to the first column
    // rather than being dropped, which would leave the row a cell short.
    for (const line of text(parseMarkdown(TABLE, 22))) expect(line.length).toBe(22);
  });

  it("does not treat a lone pipe row as a table", () => {
    // Without a divider row it is just text containing pipes.
    expect(text(parseMarkdown("| not | a table |", 40))).toEqual(["| not | a table |"]);
  });
});

describe("intraword underscores", () => {
  it("does not treat underscores inside a word as emphasis", () => {
    expect(parseInline("call snake_case_name now")).toEqual([{ text: "call snake_case_name now", scope: "default" }]);
    expect(parseInline("x = my__var__name")).toEqual([{ text: "x = my__var__name", scope: "default" }]);
  });

  it("still treats word-bounded underscores as emphasis", () => {
    expect(parseInline("a _b_ c").map((s) => s.scope)).toEqual(["default", "markup.italic", "default"]);
    expect(parseInline("a __b__ c").map((s) => s.scope)).toEqual(["default", "markup.bold", "default"]);
  });
});

describe("table cell width", () => {
  it("fits wide characters by display width without splitting surrogate pairs", () => {
    expect(fitCells("😀x", 2)).toBe("😀");
    expect(fitCells("😀x", 1)).toBe(" ");
    expect(fitCells("日本", 5)).toBe("日本 ");
  });

  it("keeps every table row the requested display width with wide cells", () => {
    const lines = text(parseMarkdown("| 名前 | b |\n|---|---|\n| 😀😀😀😀😀 | 2 |", 13));
    const displayWidth = (line: string) =>
      [...line].reduce((sum, ch) => sum + (/[\u3000-\u9fff]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0);
    for (const line of lines) expect(displayWidth(line)).toBe(13);
    for (const line of lines) expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("fence closing", () => {
  it("does not close on a line with an info string or a different/shorter marker", () => {
    const md = ["````md", "```ts", "x", "```", "~~~~", "````", "after"].join("\n");
    expect(text(parseMarkdown(md, 40))).toEqual(["```ts", "x", "```", "~~~~", "after"]);
  });
});
