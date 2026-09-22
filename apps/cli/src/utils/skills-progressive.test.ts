import { describe, expect, it } from "vitest";
import { type DiscoveredSkill, formatSkillsTiered, isConversationalOpener, selectSkillsForPrompt } from "./skills";

const skill = (name: string, description: string): DiscoveredSkill => ({
  name,
  description,
  skillMdPath: `/skills/${name}/SKILL.md`,
  rootDir: `/skills/${name}`,
  scope: "user",
});

const CATALOG = [
  skill("pixijs", "PixiJS v8 rendering, sprites, and the scene graph"),
  skill("frontend-design", "Build distinctive production-grade web interfaces"),
  skill("systematic-debugging", "Root cause investigation before proposing fixes"),
  skill("blender-modeling", "Model meshes and topology in Blender"),
  skill("telegram", "Send and receive Telegram messages"),
];

describe("isConversationalOpener", () => {
  it("treats bare greetings and acknowledgements as non-work", () => {
    for (const m of ["hi", "hello", "hey!", "thanks", "ok", "yes", "good morning", "cheers"]) {
      expect(isConversationalOpener(m), m).toBe(true);
    }
  });

  it("treats a greeting carrying a request as work", () => {
    // The whole point: "hi" must not suppress skills when a task rides along.
    expect(isConversationalOpener("hi, can you fix the pixijs renderer")).toBe(false);
  });

  it("treats anything substantial as work even without a verb", () => {
    expect(isConversationalOpener("the blender export is broken")).toBe(false);
  });

  it("treats empty input as non-work", () => {
    expect(isConversationalOpener("   ")).toBe(true);
  });
});

describe("selectSkillsForPrompt", () => {
  it("sends ZERO full descriptions for a greeting", () => {
    const sel = selectSkillsForPrompt(CATALOG, "hello");
    // This is what makes the first response instant.
    expect(sel.full).toEqual([]);
    expect(sel.indexed).toHaveLength(CATALOG.length);
  });

  it("promotes the relevant skill on a real request", () => {
    const sel = selectSkillsForPrompt(CATALOG, "the pixijs sprites are not rendering");
    expect(sel.full.map((s) => s.name)).toContain("pixijs");
    expect(sel.indexed.map((s) => s.name)).not.toContain("pixijs");
  });

  it("scores a name match above a description-only match", () => {
    const sel = selectSkillsForPrompt(CATALOG, "blender topology", { maxFull: 1 });
    expect(sel.full.map((s) => s.name)).toEqual(["blender-modeling"]);
  });

  it("caps full descriptions at maxFull and indexes the remainder", () => {
    const sel = selectSkillsForPrompt(CATALOG, "rendering design debugging blender telegram", { maxFull: 2 });
    expect(sel.full).toHaveLength(2);
    expect(sel.full.length + sel.indexed.length).toBe(CATALOG.length);
  });

  it("indexes everything when nothing matches, losing no skill", () => {
    const sel = selectSkillsForPrompt(CATALOG, "refactor the payroll ledger");
    expect(sel.full).toEqual([]);
    expect(sel.indexed).toHaveLength(CATALOG.length);
  });

  it("forceAll bypasses tiering", () => {
    const sel = selectSkillsForPrompt(CATALOG, "hello", { forceAll: true });
    expect(sel.full).toHaveLength(CATALOG.length);
    expect(sel.indexed).toEqual([]);
  });
});

describe("formatSkillsTiered", () => {
  it("returns null for a greeting with no skills at all", () => {
    expect(formatSkillsTiered({ full: [], indexed: [] })).toBeNull();
  });

  it("lists indexed skills by name only — no descriptions", () => {
    const out = formatSkillsTiered({ full: [], indexed: CATALOG }) ?? "";
    expect(out).toContain("<other_skills>");
    expect(out).toContain("pixijs");
    // The token saving depends on descriptions NOT being present.
    expect(out).not.toContain("PixiJS v8 rendering");
  });

  it("includes full descriptions only for promoted skills", () => {
    const sel = selectSkillsForPrompt(CATALOG, "pixijs sprites");
    const out = formatSkillsTiered(sel) ?? "";
    expect(out).toContain("PixiJS v8 rendering");
    expect(out).toContain("<other_skills>");
    expect(out).not.toContain("Model meshes and topology");
  });

  it("is dramatically smaller than full disclosure at scale", () => {
    const many = Array.from({ length: 258 }, (_, i) =>
      skill(`skill-${i}`, "A reasonably wordy description ".repeat(10)),
    );
    const greeting = formatSkillsTiered(selectSkillsForPrompt(many, "hi")) ?? "";
    const full = formatSkillsTiered({ full: many, indexed: [] }) ?? "";
    // Real install measured 134k chars full; the index must be an order of
    // magnitude smaller or this whole exercise is pointless.
    expect(greeting.length).toBeLessThan(full.length / 10);
  });
});
