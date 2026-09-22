import { describe, expect, it } from "vitest";
import { detectClaimWithoutTool, formatFabricationWarning } from "./fabrication-detector";

describe("detectClaimWithoutTool", () => {
  it("returns null when at least one tool call was made", () => {
    expect(detectClaimWithoutTool("I implemented the new table renderer.", 1)).toBeNull();
  });

  it("returns null on empty text", () => {
    expect(detectClaimWithoutTool("", 0)).toBeNull();
    expect(detectClaimWithoutTool("   \n\t  ", 0)).toBeNull();
  });

  it("flags first-person past-tense claim with no tool calls", () => {
    // The exact failure mode that motivated this detector: a CodeSurf turn
    // claims an edit happened with zero tool calls. The original transcript
    // (~/.grok/grok.db session 67e0ab4b536c) was a Claude turn; the detector
    // is model-agnostic — any model on any provider can fail this way.
    const finding = detectClaimWithoutTool("I implemented the table format and committed it.", 0);
    expect(finding).not.toBeNull();
    expect(finding?.source).toBe("first-person");
  });

  it("flags 'I've fixed' contraction", () => {
    const finding = detectClaimWithoutTool("I've fixed the issue and pushed.", 0);
    expect(finding).not.toBeNull();
    expect(finding?.source).toBe("first-person");
  });

  it("flags bold declaration like '**Fixed.**'", () => {
    const finding = detectClaimWithoutTool("**Fixed.** The previous response only showed mock output.", 0);
    expect(finding).not.toBeNull();
    expect(finding?.source).toBe("bold-declaration");
  });

  it("flags sentence-initial 'Implemented:' header", () => {
    const finding = detectClaimWithoutTool("Implemented: tabular skills registry for /skills.", 0);
    expect(finding).not.toBeNull();
    expect(finding?.source).toBe("sentence-start");
  });

  it("does NOT flag future intent ('I will implement')", () => {
    expect(detectClaimWithoutTool("I will implement this next.", 0)).toBeNull();
  });

  it("does NOT flag conditional / hypothetical phrasing", () => {
    expect(detectClaimWithoutTool("If we implemented X this way, ...", 0)).toBeNull();
  });

  it("does NOT flag plain prose without claim verbs", () => {
    expect(detectClaimWithoutTool("Here is what the table will look like.", 0)).toBeNull();
  });

  it("captures the matched phrase for diagnostics", () => {
    const finding = detectClaimWithoutTool("I just committed the change.", 0);
    expect(finding?.matched.toLowerCase()).toContain("committed");
  });
});

describe("formatFabricationWarning", () => {
  it("includes the matched verb and a verification hint", () => {
    const msg = formatFabricationWarning({ matched: "I implemented", source: "first-person" });
    expect(msg).toContain("Grounding check");
    expect(msg).toContain("I implemented");
    expect(msg).toContain("git status");
  });
});
