import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../types/index.js";
import { isReusableTextEntry, preserveStableEntryIdentities } from "./transcript-identity.js";

const ts = new Date("2026-06-14T00:00:00.000Z");

function entry(type: ChatEntry["type"], content: string, extra: Partial<ChatEntry> = {}): ChatEntry {
  return { type, content, timestamp: ts, ...extra };
}

describe("isReusableTextEntry", () => {
  it("reuses identical user/assistant rows", () => {
    expect(isReusableTextEntry(entry("user", "hi"), entry("user", "hi"))).toBe(true);
    expect(isReusableTextEntry(entry("assistant", "yo"), entry("assistant", "yo"))).toBe(true);
  });

  it("rejects when rendered content differs", () => {
    expect(isReusableTextEntry(entry("assistant", "a"), entry("assistant", "a "))).toBe(false);
    expect(isReusableTextEntry(entry("user", "hi"), entry("assistant", "hi"))).toBe(false);
  });

  it("rejects when reasoningText differs", () => {
    expect(
      isReusableTextEntry(
        entry("assistant", "x", { reasoningText: "r1" }),
        entry("assistant", "x", { reasoningText: "r2" }),
      ),
    ).toBe(false);
    expect(
      isReusableTextEntry(
        entry("assistant", "x", { reasoningText: "r" }),
        entry("assistant", "x", { reasoningText: "r" }),
      ),
    ).toBe(true);
  });

  it("rejects when follow-up suggestions differ", () => {
    expect(
      isReusableTextEntry(
        entry("assistant", "x", { followupSuggestions: ["Run tests"] }),
        entry("assistant", "x", { followupSuggestions: ["Open files"] }),
      ),
    ).toBe(false);
  });

  it("never reuses tool rows", () => {
    const tc = entry("tool_call", "ls", { toolCall: { id: "1", name: "ls" } as unknown as ChatEntry["toolCall"] });
    expect(isReusableTextEntry(tc, tc)).toBe(false);
    expect(isReusableTextEntry(entry("tool_result", "out"), entry("tool_result", "out"))).toBe(false);
  });

  it("does not reuse text rows carrying in-memory payloads (sources/artifacts)", () => {
    const withSources = entry("assistant", "x", { sources: [{ url: "https://e.com" }] });
    expect(isReusableTextEntry(withSources, entry("assistant", "x"))).toBe(false);
    const withArtifacts = entry("assistant", "x", {
      artifacts: [{ kind: "file", path: "/tmp/a" }] as unknown as ChatEntry["artifacts"],
    });
    expect(isReusableTextEntry(withArtifacts, entry("assistant", "x"))).toBe(false);
  });

  it("rejects when decoration fields differ", () => {
    expect(
      isReusableTextEntry(
        entry("assistant", "x", { modeColor: "#111" }),
        entry("assistant", "x", { modeColor: "#222" }),
      ),
    ).toBe(false);
    expect(isReusableTextEntry(entry("user", "x", { remoteKey: "a" }), entry("user", "x", { remoteKey: "b" }))).toBe(
      false,
    );
  });
});

describe("preserveStableEntryIdentities", () => {
  it("swaps unchanged rows back to the previous object reference", () => {
    const prev = [entry("user", "q1"), entry("assistant", "a1")];
    const fresh = [entry("user", "q1"), entry("assistant", "a1")];
    const out = preserveStableEntryIdentities(prev, fresh);
    expect(out[0]).toBe(prev[0]); // reference reused → memo(MessageView) skips
    expect(out[1]).toBe(prev[1]);
  });

  it("keeps the fresh object for a genuinely changed row", () => {
    const prev = [entry("user", "q1"), entry("assistant", "old")];
    const fresh = [entry("user", "q1"), entry("assistant", "new")];
    const out = preserveStableEntryIdentities(prev, fresh);
    expect(out[0]).toBe(prev[0]); // unchanged → reused
    expect(out[1]).toBe(fresh[1]); // changed → fresh reference, will re-render
    expect(out[1]).not.toBe(prev[1]);
  });

  it("pairs by type ordinal, not absolute index", () => {
    // A new assistant row appended shifts indices but ordinal pairing still
    // matches the earlier rows to their previous references.
    const prev = [entry("user", "q1"), entry("assistant", "a1")];
    const fresh = [entry("user", "q1"), entry("assistant", "a1"), entry("assistant", "a2")];
    const out = preserveStableEntryIdentities(prev, fresh);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
    expect(out[2]).toBe(fresh[2]); // brand-new row, no prev pair
  });

  it("never reuses tool rows even when identical", () => {
    const prev = [entry("tool_result", "same")];
    const fresh = [entry("tool_result", "same")];
    const out = preserveStableEntryIdentities(prev, fresh);
    expect(out[0]).toBe(fresh[0]);
    expect(out[0]).not.toBe(prev[0]);
  });

  it("returns the same (mutated) fresh array", () => {
    const fresh = [entry("user", "q1")];
    expect(preserveStableEntryIdentities([entry("user", "q1")], fresh)).toBe(fresh);
  });
});
