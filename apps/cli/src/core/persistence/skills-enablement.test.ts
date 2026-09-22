import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredSkill } from "../../utils/skills";

// Mock the disk-backed extension settings so the global-disabled set is
// deterministic without touching the user's real extensions.json.
let mockSettings: Record<string, unknown> = {};
vi.mock("./plugins", () => ({
  loadPluginSettings: () => mockSettings,
}));

import {
  filterEnabledSkills,
  isSkillEnabled,
  resetSessionSkillOverrides,
  SKILLS_DISABLED_SETTING_KEY,
  setSessionSkillDisabled,
  skillEnablement,
} from "./skills-enablement";

function skill(name: string): DiscoveredSkill {
  return { name, description: "d", skillMdPath: `/x/${name}/SKILL.md`, rootDir: `/x/${name}`, scope: "user" };
}

describe("skills-enablement", () => {
  beforeEach(() => {
    mockSettings = {};
    resetSessionSkillOverrides();
  });
  afterEach(() => {
    resetSessionSkillOverrides();
  });

  it("defaults every skill to enabled", () => {
    expect(skillEnablement("alpha")).toBe("enabled");
    expect(isSkillEnabled("alpha")).toBe(true);
  });

  it("honours a globally-disabled skill from settings", () => {
    mockSettings = { [SKILLS_DISABLED_SETTING_KEY]: ["alpha"] };
    expect(skillEnablement("alpha")).toBe("disabled-global");
    expect(isSkillEnabled("alpha")).toBe(false);
    expect(isSkillEnabled("beta")).toBe(true);
  });

  it("honours a session-disabled skill (in-memory)", () => {
    setSessionSkillDisabled("alpha", true);
    expect(skillEnablement("alpha")).toBe("disabled-session");
    expect(isSkillEnabled("alpha")).toBe(false);
    setSessionSkillDisabled("alpha", false);
    expect(skillEnablement("alpha")).toBe("enabled");
  });

  it("global disable wins over session", () => {
    mockSettings = { [SKILLS_DISABLED_SETTING_KEY]: ["alpha"] };
    setSessionSkillDisabled("alpha", true);
    expect(skillEnablement("alpha")).toBe("disabled-global");
  });

  it("filterEnabledSkills drops disabled skills from a discovered list", () => {
    mockSettings = { [SKILLS_DISABLED_SETTING_KEY]: ["alpha"] };
    setSessionSkillDisabled("gamma", true);
    const out = filterEnabledSkills([skill("alpha"), skill("beta"), skill("gamma")]);
    expect(out.map((s) => s.name)).toEqual(["beta"]);
  });

  it("resetSessionSkillOverrides clears in-memory disables", () => {
    setSessionSkillDisabled("alpha", true);
    resetSessionSkillOverrides();
    expect(isSkillEnabled("alpha")).toBe(true);
  });

  it("ignores non-array / non-string settings values", () => {
    mockSettings = { [SKILLS_DISABLED_SETTING_KEY]: "alpha" };
    expect(isSkillEnabled("alpha")).toBe(true);
    mockSettings = { [SKILLS_DISABLED_SETTING_KEY]: [1, "beta", null] };
    expect(isSkillEnabled("beta")).toBe(false);
    expect(isSkillEnabled("alpha")).toBe(true);
  });
});
