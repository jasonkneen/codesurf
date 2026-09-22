// The cell→CSS mapping, which is where terminal/browser parity is won or lost.
//
// These assertions are not style preferences. Each one pins a rule that the
// terminal host enforces implicitly and CSS does not, and each was written
// after a real difference showed up in a terminal-vs-browser capture
// (`bun run parity`). Changing an expectation here changes the layout contract.

import { describe, expect, it } from "vitest";
import { borderEdges, propsToStyle, whiteSpaceFor } from "./props-to-style.js";

describe("cell units", () => {
  it("maps flexbox props and cell dimensions to CSS", () => {
    const s = propsToStyle({ flexDirection: "row", width: 12, gap: 1, fg: "#fff", paddingLeft: 2 });
    expect(s.width).toBe("calc(12 * 1ch)");
    expect(s.gap).toBe("calc(1 * 1ch)");
    expect(s.paddingLeft).toBe("calc(2 * 1ch)");
    expect(s.flexDirection).toBe("row");
    expect(s.color).toBe("#fff");
    expect(s.display).toBe("flex");
    expect(s.boxSizing).toBe("border-box");
  });

  it("measures height in rows and width in characters", () => {
    const s = propsToStyle({ width: 3, height: 3, marginTop: 1, marginLeft: 1 });
    expect(s.width).toBe("calc(3 * 1ch)");
    expect(s.height).toBe("calc(3 * var(--row))");
    expect(s.marginTop).toBe("calc(1 * var(--row))");
    expect(s.marginLeft).toBe("calc(1 * 1ch)");
  });

  it("resolves gap against the flex direction", () => {
    // A terminal's gap is one cell either way, but a cell is not square: the
    // same number means 1ch across and one row down.
    expect(propsToStyle({ flexDirection: "row", gap: 2 }).gap).toBe("calc(2 * 1ch)");
    expect(propsToStyle({ flexDirection: "column", gap: 2 }).gap).toBe("calc(2 * var(--row))");
  });

  it("accepts backgroundColor, the spelling the component tree uses", () => {
    // panel-frame.tsx and every widget under ai-output/ write backgroundColor,
    // not bg. Reading only `bg` silently dropped every panel background.
    expect(propsToStyle({ backgroundColor: "#123" }).backgroundColor).toBe("#123");
    expect(propsToStyle({ bg: "#456" }).backgroundColor).toBe("#456");
  });
});

describe("whitespace", () => {
  it("preserves runs of spaces by default", () => {
    // The tree aligns columns with literal spaces inside strings, e.g.
    // `  ${done}/${total}`. HTML collapses those by default, which moved text
    // by one or more cells on nearly every row of the first capture.
    expect(whiteSpaceFor(undefined)).toBe("pre-wrap");
    expect(propsToStyle({}).whiteSpace).toBeUndefined();
  });

  it("stops wrapping when wrapMode is none", () => {
    expect(whiteSpaceFor("none")).toBe("pre");
    expect(propsToStyle({ wrapMode: "none" }).whiteSpace).toBe("pre");
  });
});

describe("borders reserve a cell", () => {
  it("reads both border spellings", () => {
    expect([...borderEdges(true)].sort()).toEqual(["bottom", "left", "right", "top"]);
    expect([...borderEdges(["top", "left"])].sort()).toEqual(["left", "top"]);
    expect(borderEdges(undefined).size).toBe(0);
    expect(borderEdges(false).size).toBe(0);
  });

  it("consumes one cell per drawn edge, on top of declared padding", () => {
    // This is the §9 decision. A terminal border is made of characters and so
    // occupies a cell; a CSS border sits between cells and occupies none. If
    // the cell were not reserved, every bordered panel would be two columns
    // wider and two rows taller on web than in the terminal, and every
    // `width - 2` in the component tree would stop agreeing with what is drawn.
    const s = propsToStyle({ border: true, paddingLeft: 1, paddingTop: 1 });
    expect(s.paddingLeft).toBe("calc(2 * 1ch)");
    expect(s.paddingTop).toBe("calc(2 * var(--row))");
    expect(s.paddingRight).toBe("calc(1 * 1ch)");
    expect(s.paddingBottom).toBe("calc(1 * var(--row))");
  });

  it("reserves nothing on edges it does not draw", () => {
    const s = propsToStyle({ border: ["left"] });
    expect(s.paddingLeft).toBe("calc(1 * 1ch)");
    expect(s.paddingRight).toBeUndefined();
    expect(s.paddingTop).toBeUndefined();
  });

  it("paints one rule per drawn edge and none without a border", () => {
    // Count gradients, not commas: each layer is `linear-gradient(c, c)` and
    // carries a comma of its own.
    const layers = (style: { backgroundImage?: string }) =>
      style.backgroundImage?.match(/linear-gradient/g)?.length ?? 0;

    const all = propsToStyle({ border: true, borderColor: "#888" });
    expect(layers(all)).toBe(4);
    expect(all.backgroundImage).toContain("#888");
    // One size and one position per layer, or the rules land on wrong edges.
    expect(all.backgroundSize?.split(",").length).toBe(4);
    expect(all.backgroundPosition?.split(",").length).toBe(4);

    expect(layers(propsToStyle({ border: ["top"], borderColor: "#888" }))).toBe(1);

    // A plain box must not acquire a background layer — that would paint over
    // the backgroundColor of every unbordered panel in the tree.
    expect(propsToStyle({ backgroundColor: "#123" }).backgroundImage).toBeUndefined();
  });
});
