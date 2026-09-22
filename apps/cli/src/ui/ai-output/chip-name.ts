// Chip-name shortening for tool/agent call chips.
//
// Tool-call chips show a compact label like `5xSEARCH`, `3xRUN`, or
// `2xBUDDY.BLOUBTEAMCONTROL` and expand (on click) to the full tool/agent
// name + args/output. The shortener:
//   - namespaced names collapse to their org head:  BUDDY.* -> BUDDY
//   - well-known tools get short aliases:           COMMAND -> RUN
//   - everything else keeps its name (truncated only when absurdly long)
//
// Aliases and org heads are editable via user settings (chipAliases /
// chipOrgHeads in ~/.codesurf user-settings), merged over the defaults below.

import { loadUserSettings } from "../../utils/settings";

export const CHIP_MAX = 12;

const DEFAULT_ORG_HEADS = ["BUDDY"];
const DEFAULT_ALIASES: Record<string, string> = { COMMAND: "RUN", COMMANDS: "RUNS" };

/** Pure shortener builder (testable; user overrides merge over defaults). */
export function createChipShortener(options: { aliases?: Record<string, string>; orgHeads?: string[] } = {}) {
  const orgHeads = new Set<string>([...DEFAULT_ORG_HEADS, ...(options.orgHeads ?? [])]);
  const aliases: Record<string, string> = { ...DEFAULT_ALIASES, ...(options.aliases ?? {}) };
  return (name: string): string => {
    const upper = (name ?? "").trim().toUpperCase();
    if (!upper) return upper;
    if (name.includes(".")) {
      const head = upper.split(".")[0];
      if (orgHeads.has(head)) return head;
      const tail = upper.split(".").at(-1) ?? head;
      return tail.length > CHIP_MAX ? tail.slice(0, CHIP_MAX) : tail;
    }
    if (aliases[upper]) return aliases[upper];
    return upper.length > CHIP_MAX ? upper.slice(0, CHIP_MAX) : upper;
  };
}

let defaultShorten = createChipShortener();
let userSettingsLoaded = false;

function ensureUserSettingsLoaded(): void {
  if (userSettingsLoaded) return;
  userSettingsLoaded = true;
  try {
    const settings = loadUserSettings();
    if (settings.chipAliases || settings.chipOrgHeads) {
      defaultShorten = createChipShortener({ aliases: settings.chipAliases, orgHeads: settings.chipOrgHeads });
    }
  } catch {
    defaultShorten = createChipShortener();
  }
}

/** Shorten a tool/agent name for a chip, honoring user-settings aliases. */
export function shortenToolChipName(name: string): string {
  ensureUserSettingsLoaded();
  return defaultShorten(name);
}
