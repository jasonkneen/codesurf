import { describe, expect, it } from "bun:test";
import { titleBarBrandGlyph } from "./claude-code-title-bar";

describe("titleBarBrandGlyph", () => {
  it("uses nerd font glyph when provided", () => {
    expect(titleBarBrandGlyph("\uf0e7")).toBe("\uf0e7 ");
  });

  it("falls back to emoji when nerd fonts are off", () => {
    expect(titleBarBrandGlyph("")).toBe("⚡ ");
  });
});
