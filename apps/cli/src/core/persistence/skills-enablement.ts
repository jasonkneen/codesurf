// Skill enablement — global (persisted) + session (in-memory) disable overrides.
//
// The `/skills` builtin (src/core/plugins/builtin/skills-listing.tsx) lets
// the user disable a discovered Agent Skill either globally (persisted to the
// extension-settings file under the `skills.disabled` key) or for the current
// session only (in-memory, process-lifetime). Both the host prompt builder
// (src/agent/agent.ts) and the isolated Claude adapter
// (claude-skills-provider.ts) run discovered skills through
// `filterEnabledSkills` before injecting them, so a disabled skill never
// reaches the model.
//
// This module is the shared, dependency-light contract between the UI side and
// the prompt builders. It imports nothing from the UI layer so it stays
// trivially unit-testable.

import type { DiscoveredSkill } from "../../utils/skills";
import { loadPluginSettings } from "./plugins";

/** Setting key holding the JSON array of globally-disabled skill names. */
export const SKILLS_DISABLED_SETTING_KEY = "skills.disabled";

export type SkillEnablement = "enabled" | "disabled-global" | "disabled-session";

// Session-scoped disabled names. Module-level so the UI screen and the prompt
// builders share one process-lifetime set. Cleared by resetSessionSkillOverrides.
const sessionDisabled = new Set<string>();

/** Read the persisted set of globally-disabled skill names from disk. */
export function loadGlobalDisabledSkills(): Set<string> {
  const raw = loadPluginSettings()[SKILLS_DISABLED_SETTING_KEY];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

/** Current enablement state for a skill name. */
export function skillEnablement(name: string, globalDisabled = loadGlobalDisabledSkills()): SkillEnablement {
  if (globalDisabled.has(name)) return "disabled-global";
  if (sessionDisabled.has(name)) return "disabled-session";
  return "enabled";
}

/** True when the skill should be injected into the model prompt. */
export function isSkillEnabled(name: string, globalDisabled = loadGlobalDisabledSkills()): boolean {
  return skillEnablement(name, globalDisabled) === "enabled";
}

/** Drop globally- or session-disabled skills from a discovered list. */
export function filterEnabledSkills(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const globalDisabled = loadGlobalDisabledSkills();
  return skills.filter((skill) => isSkillEnabled(skill.name, globalDisabled));
}

/** Toggle a skill's session-scoped disable override (in-memory only). */
export function setSessionSkillDisabled(name: string, disabled: boolean): void {
  if (disabled) sessionDisabled.add(name);
  else sessionDisabled.delete(name);
}

export function isSessionSkillDisabled(name: string): boolean {
  return sessionDisabled.has(name);
}

/** Clear all session-scoped overrides (call on session reset). */
export function resetSessionSkillOverrides(): void {
  sessionDisabled.clear();
}
