import { describe, expect, it } from "vitest";
import { type DiscoveredSkill, formatSkillsForPrompt } from "./skills";

const skill: DiscoveredSkill = {
  name: "demo",
  description: "A demo skill",
  skillMdPath: "/abs/.agents/skills/demo/SKILL.md",
  rootDir: "/abs/.agents/skills/demo",
  scope: "project",
};

describe("formatSkillsForPrompt with overlays", () => {
  it("renders learned_examples for skills that have an overlay", () => {
    const overlays = new Map([["demo", { fewShot: [{ query: "do the demo thing", result: "did the demo thing" }] }]]);
    const out = formatSkillsForPrompt([skill], overlays);
    expect(out).toContain("<learned_examples>");
    expect(out).toContain("do the demo thing");
    expect(out).toContain("did the demo thing");
  });

  it("omits learned_examples when there is no overlay", () => {
    const out = formatSkillsForPrompt([skill]);
    expect(out).not.toContain("<learned_examples>");
    expect(out).toContain("<name>demo</name>");
  });

  it("truncates long example results", () => {
    const overlays = new Map([["demo", { fewShot: [{ query: "q", result: "x".repeat(1000) }] }]]);
    const out = formatSkillsForPrompt([skill], overlays) ?? "";
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(1000 + 800); // result was truncated, not included whole
  });
});
