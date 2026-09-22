import { describe, expect, it } from "bun:test";
import { buildQueuedPreviewText, formatPendingMessageIndex } from "./claude-code-pending-messages";

describe("formatPendingMessageIndex", () => {
  it("formats 1-based indices", () => {
    expect(formatPendingMessageIndex(0)).toBe("#1");
    expect(formatPendingMessageIndex(2)).toBe("#3");
  });
});

describe("buildQueuedPreviewText", () => {
  it("keeps image tokens as placeholders (no path)", () => {
    const raw = "check this [Image #1] please";
    const blocks = [{ id: 1, content: "/tmp/shot.png", lines: 1, isImage: true }];
    expect(buildQueuedPreviewText(raw, blocks)).toBe("check this [Image #1] please");
  });

  it("keeps pasted block chips", () => {
    const raw = "fix [Pasted #2 5+ lines]";
    const blocks = [{ id: 2, content: "line\nline", lines: 5 }];
    expect(buildQueuedPreviewText(raw, blocks)).toBe("fix [Pasted #2 5+ lines]");
  });

  it("expands file mention tokens", () => {
    const raw = "read [File: app.tsx]";
    const files = [{ path: "/proj/src/app.tsx" }];
    expect(buildQueuedPreviewText(raw, [], files)).toBe("read @/proj/src/app.tsx");
  });

  it("handles image-only queue entries", () => {
    const blocks = [
      {
        id: 1,
        content:
          "/Users/jkneen/.grok/sessions/%2FUsers%2Fjkneen%2FDocuments%2FGitHub%2Fgrok-cli/019e9e62/assets/image.jpg",
        lines: 1,
        isImage: true,
      },
    ];
    expect(buildQueuedPreviewText("[Image #1]", blocks)).toBe("[Image #1]");
  });
});
