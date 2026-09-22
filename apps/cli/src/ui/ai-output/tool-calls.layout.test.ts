import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Tool chip layout", () => {
  it("keeps chip labels non-selectable while still handling expansion clicks", () => {
    const source = readFileSync(fileURLToPath(new URL("./tool-calls.tsx", import.meta.url)), "utf8");

    expect(source).toContain("function handleChipMouseDown");
    expect(source).toContain("event?.preventDefault?.();");
    expect(source.match(/selectable={false}/g)?.length).toBeGreaterThanOrEqual(6);
    expect(source).toContain("onToggle(call.id);");
    expect(source).toContain("onToggle(id);");
  });
});

describe("Tool output rendering", () => {
  it("renders raw tool output literally instead of through concealing markdown", () => {
    const toolCalls = readFileSync(fileURLToPath(new URL("./tool-calls.tsx", import.meta.url)), "utf8");
    const messageViews = readFileSync(
      fileURLToPath(new URL("../components/message-views.tsx", import.meta.url)),
      "utf8",
    );
    const markdown = readFileSync(fileURLToPath(new URL("../markdown.tsx", import.meta.url)), "utf8");

    expect(toolCalls.match(/<Markdown content=\{(call|c)\.output\}[^>]*>/g)).toEqual([
      "<Markdown content={call.output} t={t} raw onOpenFileLink={onOpenFileLink} />",
      "<Markdown content={c.output} t={t} raw onOpenFileLink={onOpenFileLink} />",
    ]);
    expect(messageViews).toContain(
      "<Markdown content={toolResult.output} t={t} raw onOpenFileLink={onOpenFileLink} />",
    );
    // The raw branch returns before any <markdown conceal> renderable is built.
    expect(markdown.indexOf("if (raw) {")).toBeGreaterThan(-1);
    expect(markdown.indexOf("if (raw) {")).toBeLessThan(markdown.indexOf("conceal={true}"));
  });
});
