import { describe, expect, it } from "vitest";
import { formatContextStatusText } from "./claude-code-context-count";

const stats = {
  contextWindow: 200_000,
  usedTokens: 73_000,
  remainingTokens: 127_000,
  ratioUsed: 0.365,
  ratioRemaining: 0.635,
};

describe("formatContextStatusText", () => {
  it("formats title variant", () => {
    expect(formatContextStatusText(stats, 0, "title")).toBe("73K / 200K");
  });

  it("formats footer with pending messages", () => {
    expect(formatContextStatusText(stats, 3, "footer")).toBe("| 73K / 200K | +3 |");
  });

  it("formats footer without pending messages", () => {
    expect(formatContextStatusText(stats, 0, "footer")).toBe("| 73K / 200K |");
  });
});
