import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("ChainOfThought layout", () => {
  it("renders the reasoning header as a compact THINKING chip", () => {
    const source = readFileSync(fileURLToPath(new URL("./chain-of-thought.tsx", import.meta.url)), "utf8");

    expect(source).toContain('<b>{"THINKING"}</b>');
    expect(source).toContain("backgroundColor={chipBg}");
    expect(source).toContain("paddingLeft={1}");
    expect(source).not.toContain('<box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1}>');
    expect(source).not.toContain('{isThinking ? "◌ " : "- "}');
    expect(source).not.toContain('<b>{" Thinking"}</b>');
  });

  it("hides the expand/collapse affordance while there are no thoughts", () => {
    const source = readFileSync(fileURLToPath(new URL("./chain-of-thought.tsx", import.meta.url)), "utf8");

    // The "waiting" placeholder must not advertise an expansion that has no
    // body — gate both the affordance text and the header toggle on hasThoughts.
    expect(source).toContain("const hasThoughts = thoughts.length > 0;");
    expect(source).toContain("onMouseDown={hasThoughts ? () => setCollapsed((c) => !c) : undefined}");
    expect(source).toContain("{hasThoughts && (");
  });

  it("keeps a real spacer between thought status glyphs and text", () => {
    const source = readFileSync(fileURLToPath(new URL("./chain-of-thought.tsx", import.meta.url)), "utf8");

    expect(source).toContain("<box width={3} flexShrink={0}>");
    expect((source.match(/width=\{1\} flexShrink=\{0\}/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('{"  ✓"}');
    expect(source).toContain('{"  ◌"}');
    expect(source).toContain('{"  ○"}');
    expect(source).not.toContain("STATUS_PREFIX");
  });
});
