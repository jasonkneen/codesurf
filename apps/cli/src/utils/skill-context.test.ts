import { describe, expect, it } from "vitest";
import { formatCacheStatsLine, ProgressiveSkillContext } from "./skill-context";
import type { DiscoveredSkill } from "./skills";

const skill = (name: string, description: string): DiscoveredSkill => ({
  name,
  description,
  skillMdPath: `/skills/${name}/SKILL.md`,
  rootDir: `/skills/${name}`,
  scope: "user",
});

const CATALOG = [
  skill("pixijs", "PixiJS v8 rendering, sprites, and the scene graph"),
  skill("blender-modeling", "Model meshes and topology in Blender"),
  skill("telegram", "Send and receive Telegram messages"),
  skill("frontend-design", "Build distinctive production-grade web interfaces"),
];

describe("ProgressiveSkillContext — cache safety invariants", () => {
  it("a greeting discloses nothing, so the block starts minimal", () => {
    const ctx = new ProgressiveSkillContext();
    expect(ctx.update(CATALOG, "hello")).toEqual([]);
    expect(ctx.stats(CATALOG).disclosed).toBe(0);
  });

  it("the rendered block GROWS as a prefix — earlier content is never rewritten", () => {
    const ctx = new ProgressiveSkillContext();
    ctx.update(CATALOG, "fix the pixijs sprites");
    const afterFirst = ctx.render(CATALOG) ?? "";

    ctx.update(CATALOG, "now the blender topology export");
    const afterSecond = ctx.render(CATALOG) ?? "";

    // The <available_skills> span from turn 1 must still appear verbatim and in
    // the same position. If this ever fails, every token after it re-prefills.
    const firstBlock = afterFirst.slice(
      afterFirst.indexOf("<available_skills>"),
      afterFirst.indexOf("</available_skills>"),
    );
    expect(afterSecond).toContain(firstBlock);
    expect(afterSecond.indexOf(firstBlock)).toBe(afterFirst.indexOf(firstBlock));
  });

  it("never removes a disclosed skill, even when later turns are unrelated", () => {
    const ctx = new ProgressiveSkillContext();
    ctx.update(CATALOG, "pixijs sprites");
    expect(ctx.stats(CATALOG).disclosed).toBe(1);
    // Shrinking here would be cache-hostile: cheaper to keep ~130 tokens than
    // to re-prefill the whole conversation.
    ctx.update(CATALOG, "send a telegram message");
    const stats = ctx.stats(CATALOG);
    expect(stats.disclosed).toBe(2);
    expect(ctx.render(CATALOG)).toContain("PixiJS v8 rendering");
  });

  it("re-asking for the same skill appends nothing — byte-identical block", () => {
    const ctx = new ProgressiveSkillContext();
    ctx.update(CATALOG, "pixijs sprites");
    const before = ctx.render(CATALOG);
    const added = ctx.update(CATALOG, "more pixijs sprites work");
    // Empty `added` is the signal that this turn is a guaranteed cache hit.
    expect(added).toEqual([]);
    expect(ctx.render(CATALOG)).toBe(before);
  });

  it("insertion order is stable regardless of later relevance scores", () => {
    const ctx = new ProgressiveSkillContext();
    ctx.update(CATALOG, "telegram");
    ctx.update(CATALOG, "pixijs");
    const rendered = ctx.render(CATALOG) ?? "";
    // telegram was disclosed first, so it must stay first.
    expect(rendered.indexOf("Send and receive Telegram")).toBeLessThan(rendered.indexOf("PixiJS v8 rendering"));
  });

  it("reset clears everything for a fresh cache generation", () => {
    const ctx = new ProgressiveSkillContext();
    ctx.update(CATALOG, "pixijs sprites");
    ctx.reset();
    expect(ctx.stats(CATALOG).disclosed).toBe(0);
  });

  it("undisclosed skills remain reachable by name in the index", () => {
    const ctx = new ProgressiveSkillContext();
    ctx.update(CATALOG, "hello");
    const rendered = ctx.render(CATALOG) ?? "";
    // Nothing is hidden — just not pre-loaded.
    for (const s of CATALOG) expect(rendered).toContain(s.name);
  });
});

describe("formatCacheStatsLine", () => {
  it("reports read/written so an unstable prefix is visible", () => {
    const line = formatCacheStatsLine({ cacheReadTokens: 48102, cacheWriteTokens: 1204, inputTokens: 52000 });
    expect(line).toContain("48,102 read");
    expect(line).toContain("1,204 written");
  });

  it("shows what a turn appended, so cache misses are attributable", () => {
    const line = formatCacheStatsLine(
      { cacheReadTokens: 1000, cacheWriteTokens: 200 },
      { disclosed: 3, indexed: 255, addedLastTurn: 1, addedNames: ["pixijs"] },
    );
    expect(line).toContain("skills 3 full / 255 indexed");
    expect(line).toContain("+1: pixijs");
  });

  it("omits the added clause when the block was untouched", () => {
    const line = formatCacheStatsLine(
      { cacheReadTokens: 1000 },
      { disclosed: 3, indexed: 255, addedLastTurn: 0, addedNames: [] },
    );
    expect(line).not.toContain("+0");
  });
});
