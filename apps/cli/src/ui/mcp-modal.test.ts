import { describe, expect, it } from "vitest";
import { formatMcpResourceContent, formatMcpResourceTitle, formatMcpStats } from "./mcp-modal";

describe("formatMcpStats", () => {
  it("returns an em-dash placeholder when stats are absent", () => {
    expect(formatMcpStats(undefined)).toBe("—");
  });

  it("formats a server that advertises everything", () => {
    expect(formatMcpStats({ tools: 3, resources: 2, prompts: 1 })).toBe("3 tools · 2 resources · 1 prompt");
  });

  it("handles singular vs plural counts correctly", () => {
    expect(formatMcpStats({ tools: 1, resources: 1, prompts: 1 })).toBe("1 tool · 1 resource · 1 prompt");
  });

  it("omits zero-count categories", () => {
    expect(formatMcpStats({ tools: 5, resources: 0, prompts: 0 })).toBe("5 tools");
    expect(formatMcpStats({ tools: 0, resources: 4, prompts: 0 })).toBe("4 resources");
    expect(formatMcpStats({ tools: 0, resources: 0, prompts: 2 })).toBe("2 prompts");
  });

  it("falls back to a clear message when the server advertises nothing", () => {
    expect(formatMcpStats({ tools: 0, resources: 0, prompts: 0 })).toBe("no capabilities advertised");
  });
});

describe("formatMcpResourceTitle", () => {
  it("appends the mime type when known", () => {
    expect(formatMcpResourceTitle({ uri: "fixture://greeting", name: "Greeting", mimeType: "text/plain" })).toBe(
      "Greeting (text/plain)",
    );
  });

  it("returns just the name when mime type is unknown", () => {
    expect(formatMcpResourceTitle({ uri: "fixture://x", name: "Bare" })).toBe("Bare");
  });
});

describe("formatMcpResourceContent", () => {
  it("returns text content verbatim", () => {
    expect(formatMcpResourceContent({ uri: "x", mimeType: "text/plain", text: "hello world" })).toBe("hello world");
  });

  it("summarizes binary blob content", () => {
    // 8 base64 chars → ~6 bytes
    const result = formatMcpResourceContent({ uri: "x", mimeType: "image/png", blob: "AAAAAAAA" });
    expect(result).toContain("[binary image/png");
    expect(result).toContain("6 bytes");
  });

  it("handles missing mime type on a blob", () => {
    expect(formatMcpResourceContent({ uri: "x", blob: "AAAA" })).toContain("application/octet-stream");
  });

  it("returns a placeholder for null/empty content", () => {
    expect(formatMcpResourceContent(null)).toBe("(no content)");
    expect(formatMcpResourceContent(undefined)).toBe("(no content)");
    expect(formatMcpResourceContent({ uri: "x" })).toBe("(no content)");
  });
});
