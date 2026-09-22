import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("MessageList layout", () => {
  it("allows the transcript scrollbox to shrink below its content height", () => {
    const source = readFileSync(fileURLToPath(new URL("./message-list.tsx", import.meta.url)), "utf8");
    const scrollboxOpen = source.match(/<scrollbox[\s\S]*?>/)?.[0] ?? "";

    expect(scrollboxOpen).toContain("flexGrow={1}");
    expect(scrollboxOpen).toContain("flexShrink={1}");
    expect(scrollboxOpen).toContain("minHeight={0}");
  });

  it("does not add an extra blank row before grouped tool blocks", () => {
    const source = readFileSync(fileURLToPath(new URL("./message-list.tsx", import.meta.url)), "utf8");

    expect(source).toContain("const topGap = realGi === 0 ? 0 : 1;");
    expect(source).not.toContain("toolCallsPanel && prevIsTranscriptMessage ? 2 : 1");
  });

  it("renders compact live tool panels inside the scrollbox instead of below it", () => {
    const source = readFileSync(fileURLToPath(new URL("./message-list.tsx", import.meta.url)), "utf8");
    const scrollboxBody = source.match(/<scrollbox[\s\S]*?<\/scrollbox>/)?.[0] ?? "";

    expect(scrollboxBody).toContain("compactLiveStatus && toolCallsPanel && liveRegularToolRecords.length > 0");
    expect(source).toContain("if (compactLiveStatus) return null;");
  });

  it("reserves the chain-of-thought row before live tool panels during active turns", () => {
    const source = readFileSync(fileURLToPath(new URL("./message-list.tsx", import.meta.url)), "utf8");
    const scrollboxBody = source.match(/<scrollbox[\s\S]*?<\/scrollbox>/)?.[0] ?? "";

    expect(source).toContain("if (!reasoning) {");
    expect(source).toContain("if (!isProcessing || !liveReasoningChainOfThought) return null;");
    expect(source).toContain("<ChainOfThought t={t} thoughts={[]} isThinking />");
    expect(scrollboxBody.indexOf("<LiveReasoning")).toBeLessThan(
      scrollboxBody.indexOf("compactLiveStatus && toolCallsPanel && liveRegularToolRecords.length > 0"),
    );
  });

  it("latches auto-follow off after upward manual scrolling until the viewport reaches bottom", () => {
    const source = readFileSync(fileURLToPath(new URL("./message-list.tsx", import.meta.url)), "utf8");

    expect(source).toContain("const [autoFollowEnabled, setAutoFollowEnabled] = useState(true);");
    expect(source).toContain("top < previousTop - 2");
    expect(source).toContain("setAutoFollowEnabledSync(false)");
    expect(source).toContain("measuredAtBottom");
    expect(source).toContain("setAutoFollowEnabledSync(true)");
    expect(source).toContain("const isAtBottom = autoFollowEnabled && measuredIsAtBottom;");
  });

  it("measures visible height from the OpenTUI scrollbox viewport", () => {
    const source = readFileSync(fileURLToPath(new URL("./message-list.tsx", import.meta.url)), "utf8");

    expect(source).toContain("sb.viewport?.height");
    expect(source).not.toContain("clientHeight");
  });

  it("uses binary-search helpers for virtualized visible range lookup", () => {
    const source = readFileSync(fileURLToPath(new URL("./message-list.tsx", import.meta.url)), "utf8");

    expect(source).toContain("function upperBound");
    expect(source).toContain("function lowerBound");
    expect(source).toContain("upperBound(prefix, topLine)");
    expect(source).toContain("lowerBound(prefix, botLine)");
  });
});

describe("cachedImagePaths", () => {
  // Behavioral tests (array identity on repeat calls, recompute on content
  // change) can't run under vitest: importing message-list.tsx transitively
  // imports inline-image.tsx which needs `bun:ffi`. Assert the cache wiring
  // in source instead, matching this file's style.
  const source = readFileSync(fileURLToPath(new URL("./message-list.tsx", import.meta.url)), "utf8");

  it("caches extractImagePaths per entry with a content-equality guard", () => {
    expect(source).toContain("const imagePathsCache = new WeakMap<object, { content: string; paths: string[] }>();");
    expect(source).toContain("if (hit && hit.content === content) return hit.paths;");
  });

  it("routes both transcript-scan sites through the cache", () => {
    expect(source).toContain("messages.some((entry) => cachedImagePaths(entry).length > 0)");
    expect(source).toContain("for (const p of cachedImagePaths(e)) h += estimateInlineImageRows(p) + 1;");
    // The uncached full scans must be gone from MessageList's hot paths.
    expect(source).not.toContain('extractImagePaths(entry.content || "")');
    expect(source).not.toContain('extractImagePaths(e.content || "")');
  });
});
