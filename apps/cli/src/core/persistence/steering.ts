// Steering preferences — persistence + prompt projection.
//
// The `/steer` builtin (src/core/plugins/builtin/steer-command.tsx) lets the
// user pick a scope / risk / verification posture. Selections are stored as
// extension settings (keys `steer.<id>`) in ~/.codesurf/extensions.json via the
// host `services.settings` surface, and projected into the agent's system
// prompt by `loadCustomInstructions` (src/utils/instructions.ts).
//
// This module is the shared, dependency-light contract between those two sides:
// it owns the key namespace, the dimension catalog, and the formatting of the
// instruction block. It deliberately imports nothing from the UI layer so it
// stays trivially unit-testable.
import { loadPluginSettings } from "./plugins";

export interface SteerDimension {
  /** Matches the questionnaire tab id (see makeExampleQuestionnaireTabs). */
  id: string;
  /** Persisted extension-setting key. */
  settingKey: string;
  /** Human label used when projecting the preference into the system prompt. */
  promptLabel: string;
}

/** Canonical steering dimensions, in display + projection order. */
export const STEER_DIMENSIONS: SteerDimension[] = [
  { id: "scope", settingKey: "steer.scope", promptLabel: "Scope of change" },
  { id: "risk", settingKey: "steer.risk", promptLabel: "Risk tolerance" },
  { id: "verify", settingKey: "steer.verify", promptLabel: "Verification depth" },
];

/** Map a dimension id to its persisted setting key. */
export function steerSettingKey(id: string): string {
  return `steer.${id}`;
}

/** Selected option label per dimension id (only set dimensions are present). */
export type SteeringPreferences = Record<string, string>;

/**
 * Read persisted steering selections from extension settings. Only non-blank
 * string values are returned, keyed by dimension id.
 */
export function loadSteeringPreferences(): SteeringPreferences {
  const settings = loadPluginSettings();
  const prefs: SteeringPreferences = {};
  for (const dim of STEER_DIMENSIONS) {
    const value = settings[dim.settingKey];
    if (typeof value === "string" && value.trim().length > 0) {
      prefs[dim.id] = value;
    }
  }
  return prefs;
}

/**
 * Render the steering preferences as a system-prompt block, or null when no
 * preference is set (so callers can skip the segment entirely).
 */
export function formatSteeringInstructions(prefs: SteeringPreferences): string | null {
  const lines = STEER_DIMENSIONS.filter((dim) => prefs[dim.id]).map((dim) => `- ${dim.promptLabel}: ${prefs[dim.id]}`);
  if (lines.length === 0) return null;
  return [
    "# Active Steering Preferences",
    "",
    "Honor these steering selections (set via `/steer`) for this session:",
    ...lines,
  ].join("\n");
}

/**
 * Index of `value` within `optionLabels`, or -1 when absent. Used to restore a
 * persisted selection into the questionnaire widget on open.
 */
export function optionIndexForValue(optionLabels: string[], value: string | undefined): number {
  if (value === undefined) return -1;
  return optionLabels.indexOf(value);
}
