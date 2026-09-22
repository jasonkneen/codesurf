// Feature Flags
//
// Central registry for user-facing boolean toggles that gate optional UI
// behaviour. Each flag is persisted via `kernelServices.settings` (same
// store the Claude-agent settings use) so the choice survives restarts,
// and is also mirrored to `process.env[envVar]` so non-UI code paths can
// branch on the same value.
//
// To add a flag:
//   1. Append an entry to FEATURE_FLAGS below.
//   2. Read it via `getFeatureFlag(id)` or subscribe via
//      `subscribeFeatureFlag(id, cb)`.
//   3. The flags modal auto-renders every entry.
//
// Settings key shape: `featureFlags.<id>` (stored as boolean).
// Env var shape:     uppercase id with non-alnum -> "_" (e.g.
//                    "render.virtualMessages" -> "RENDER_VIRTUAL_MESSAGES").

import { getHostServices as kernelGetHostServices } from "../core/plugins";

export interface FeatureFlagDescriptor {
  id: string;
  label: string;
  description: string;
  default: boolean;
  /** Env var name (auto-derived if omitted). */
  envVar?: string;
  /** Settings key (auto-derived if omitted). */
  settingsKey?: string;
}

export const FEATURE_FLAGS: FeatureFlagDescriptor[] = [
  {
    id: "sessions.scope.global",
    label: "Global sessions list",
    description:
      "Show sessions from every workspace in /sessions. Off = current workspace only. (Tab in /sessions toggles live.)",
    default: false,
  },
  {
    id: "render.thinkingBlock",
    label: "Fixed thinking area",
    description:
      "Render the streaming reasoning (thinking) block pinned above the prompt. Turn off if you see flicker.",
    default: true,
  },
  {
    id: "render.reasoning.liveChainOfThought",
    label: "Live chain-of-thought view",
    description:
      "Use the structured ChainOfThought widget for streaming reasoning instead of ThinkingBlock. Splits the live trace into discrete steps as the model thinks.",
    default: false,
  },
  {
    id: "render.liveTools",
    label: "Fixed tool-call area",
    description: "Render live tool-call chips and active subagent/delegate cards pinned above the prompt.",
    default: true,
  },
  {
    id: "render.toolCalls.panel",
    label: "Tool-call block list",
    description:
      "Render historical tool-call groups as Grok Build-style ◆ rows (tool, path, [hooks: n], skills) instead of compact CAPITAL chips.",
    default: false,
  },
  {
    id: "render.toolChips.dim",
    label: "Subdued tool chips",
    description:
      "Use darker compact tool-call chips with normal text. Turn off to restore the brighter legacy chip colours.",
    default: true,
  },
  {
    id: "render.virtualMessages",
    label: "Virtualized message list",
    description: "Only render messages near the viewport. Turn off if scrolling or height estimates feel wrong.",
    default: true,
  },
  {
    id: "learning.adaptiveModelRouting",
    label: "Adaptive model routing (learned)",
    description:
      "For each turn, route to whichever model has historically scored best for that query class (from /feedback + auto-outcomes). Off by default. When it overrides your selected model, it says so inline. Needs accumulated history before it activates.",
    default: false,
  },
  {
    id: "render.fpsOverlay",
    label: "FPS / perf overlay",
    description:
      "Show a small top-right box with live FPS, paints/sec, frame time, and the renderer's live-request count. paints/sec > 0 or live > 0 while idle means something is pinning continuous render. Off by default.",
    default: false,
  },
];

export function envVarFor(flag: FeatureFlagDescriptor): string {
  if (flag.envVar) return flag.envVar;
  return flag.id
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function settingsKeyFor(flag: FeatureFlagDescriptor): string {
  return flag.settingsKey ?? `featureFlags.${flag.id}`;
}

export function getFlagDescriptor(id: string): FeatureFlagDescriptor | undefined {
  return FEATURE_FLAGS.find((f) => f.id === id);
}

function readEnvBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const norm = v.trim().toLowerCase();
  if (norm === "") return undefined;
  if (["1", "true", "yes", "on", "y"].includes(norm)) return true;
  if (["0", "false", "no", "off", "n"].includes(norm)) return false;
  return undefined;
}

/** Resolve a flag's current value. Order: settings store → env var → default. */
export function getFeatureFlag(id: string): boolean {
  const flag = getFlagDescriptor(id);
  if (!flag) return false;
  try {
    const services = kernelGetHostServices();
    const stored = services.settings.get<boolean>(settingsKeyFor(flag));
    if (typeof stored === "boolean") return stored;
  } catch {
    // Host services not yet wired during very early boot — fall through to env.
  }
  const fromEnv = readEnvBool(envVarFor(flag));
  if (typeof fromEnv === "boolean") return fromEnv;
  return flag.default;
}

/** Set a flag — persists to settings AND mirrors to process.env. */
export function setFeatureFlag(id: string, value: boolean): void {
  const flag = getFlagDescriptor(id);
  if (!flag) return;
  const services = kernelGetHostServices();
  services.settings.set(settingsKeyFor(flag), value);
  process.env[envVarFor(flag)] = value ? "1" : "0";
}

export function toggleFeatureFlag(id: string): boolean {
  const next = !getFeatureFlag(id);
  setFeatureFlag(id, next);
  return next;
}

/** Subscribe to a single flag's settings key. Returns an unsubscribe fn. */
export function subscribeFeatureFlag(id: string, cb: (value: boolean) => void): () => void {
  const flag = getFlagDescriptor(id);
  if (!flag) return () => undefined;
  const services = kernelGetHostServices();
  return services.settings.subscribe(settingsKeyFor(flag), () => {
    cb(getFeatureFlag(id));
  });
}

export interface FeatureFlagRow {
  descriptor: FeatureFlagDescriptor;
  value: boolean;
}

export function buildFeatureFlagRows(query: string): FeatureFlagRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? FEATURE_FLAGS.filter(
        (f) =>
          f.id.toLowerCase().includes(q) ||
          f.label.toLowerCase().includes(q) ||
          f.description.toLowerCase().includes(q),
      )
    : FEATURE_FLAGS;
  return filtered.map((descriptor) => ({ descriptor, value: getFeatureFlag(descriptor.id) }));
}
