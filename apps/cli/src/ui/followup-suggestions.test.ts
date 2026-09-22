import { describe, expect, it } from "vitest";
import { deriveFollowupSuggestions, parseFollowupSuggestionContent } from "../utils/followup-suggestions";

describe("follow-up suggestions", () => {
  it("extracts hidden model-provided suggestions and strips the marker", () => {
    const parsed = parseFollowupSuggestionContent(
      'Done.\n\n<!-- codesurf-followups: ["Open the changed files", "Run the focused tests"] -->',
    );

    expect(parsed.content).toBe("Done.");
    expect(parsed.suggestions).toEqual(["Open the changed files", "Run the focused tests"]);
  });

  it("does not leak malformed markers or generic fallback suggestions", () => {
    const parsed = parseFollowupSuggestionContent("Plain paragraph.\n<!-- codesurf-followups: nope -->");

    expect(parsed.content).toBe("Plain paragraph.");
    expect(deriveFollowupSuggestions({ content: parsed.content })).toEqual([]);
  });

  it("prefers explicit entry suggestions over local text heuristics", () => {
    expect(
      deriveFollowupSuggestions({
        content: "## Implementation",
        followupSuggestions: ["Review the Hermes event path"],
      }),
    ).toEqual(["Review the Hermes event path"]);
  });

  it("still derives specific chips from headings and bullets when no marker exists", () => {
    expect(
      deriveFollowupSuggestions({
        content: ["## Hermes Streaming", "- Run the focused provider tests"].join("\n"),
      }),
    ).toEqual(["Tell me about Hermes Streaming", "the focused provider tests"]);
  });
});
