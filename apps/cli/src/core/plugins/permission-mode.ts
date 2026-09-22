// Shared permission-mode discovery and apply helpers.
//
// Several owning-adapter providers register a select setting whose key ends in
// `.permissionMode` (Claude Agent SDK, Codesurf daemon, Claude CLI, Claude+Claude Skills
// skills, …). Historically `/permissions` and the Claude-agent modal only wrote
// two hard-coded keys, so switching model/provider silently left the active
// adapter on its old mode. These helpers discover every registered
// permissionMode setting and apply a value to all of them (or to one adapter).

import type { RegisteredSetting } from "./api";

/** Canonical suffix every permission-mode setting key must end with. */
export const PERMISSION_MODE_KEY_SUFFIX = ".permissionMode";

/** Minimal settings surface these helpers need — matches PluginHostServices.settings. */
export interface PermissionModeSettings {
  get: <T = unknown>(key: string, fallback?: T) => T | undefined;
  set: <T = unknown>(key: string, value: T) => void;
  list: () => RegisteredSetting[];
}

/** True when a registered setting is a permission-mode select. */
export function isPermissionModeSetting(setting: RegisteredSetting): boolean {
  return setting.type === "select" && setting.key.endsWith(PERMISSION_MODE_KEY_SUFFIX);
}

/** Every currently-registered permission-mode select setting. */
export function listPermissionModeSettings(settings: PermissionModeSettings): RegisteredSetting[] {
  return settings.list().filter(isPermissionModeSetting);
}

/** Setting key an adapter is expected to use for permission mode. */
export function permissionModeKeyForAdapter(adapterId: string): string {
  return `${adapterId}${PERMISSION_MODE_KEY_SUFFIX}`;
}

/**
 * Resolve the permission-mode setting for an adapter id, if that adapter
 * registered one. Falls back to a key-suffix match when the extension is
 * enabled but the list is empty (tests / partial bootstrap).
 */
export function findPermissionModeSetting(
  settings: PermissionModeSettings,
  adapterId: string | null | undefined,
): RegisteredSetting | undefined {
  if (!adapterId) return undefined;
  const key = permissionModeKeyForAdapter(adapterId);
  return listPermissionModeSettings(settings).find((s) => s.key === key);
}

/**
 * Read the live permission mode for an adapter. Returns null when the adapter
 * has no permission-mode setting (plain API providers, etc.).
 */
export function readPermissionModeForAdapter(
  settings: PermissionModeSettings,
  adapterId: string | null | undefined,
): string | null {
  const setting = findPermissionModeSetting(settings, adapterId);
  if (!setting) return null;
  const raw = settings.get<unknown>(setting.key, setting.default);
  return typeof raw === "string" && raw.length > 0 ? raw : String(setting.default);
}

/**
 * Map Claude-style permission modes onto Codex's `approvalPolicy` vocabulary.
 * Codex does not use `*.permissionMode`; without this bridge `/permissions
 * bypass` would leave the native Codex adapter on `on-request`.
 */
export const CODEX_APPROVAL_FROM_PERMISSION: Record<string, string> = {
  default: "on-request",
  bypassPermissions: "never",
  dontAsk: "never",
  acceptEdits: "on-request",
  plan: "untrusted",
  auto: "on-request",
};

const CODEX_APPROVAL_KEY = "openai.codex-app-server.approvalPolicy";

/**
 * Apply a permission mode value to every registered permission-mode setting.
 *
 * When `options` is provided on a setting, only write if the value is listed
 * (or if the setting has no options, treat as open). Returns the keys that
 * were written so callers can log / assert.
 */
export function applyPermissionMode(
  settings: PermissionModeSettings,
  mode: string,
  opts?: { onlyAdapterId?: string },
): string[] {
  const targets = opts?.onlyAdapterId
    ? listPermissionModeSettings(settings).filter((s) => s.key === permissionModeKeyForAdapter(opts.onlyAdapterId!))
    : listPermissionModeSettings(settings);

  // Fallback for hosts that boot host-actions before provider settings are
  // registered (or for unit tests that only exercise the slash command). Keep
  // the historical keys in the write set so behaviour matches the prior
  // dual-write contract even when the registry is empty.
  const fallbackKeys = [
    "anthropic.agent-sdk.permissionMode",
    "codesurf.daemon.permissionMode",
    "grok.cli.permissionMode",
    "anthropic.agent-sdk-claude-skills.permissionMode",
  ];

  const written: string[] = [];
  const seen = new Set<string>();

  for (const setting of targets) {
    if (seen.has(setting.key)) continue;
    if (setting.options && setting.options.length > 0) {
      if (!setting.options.some((o) => o.value === mode)) continue;
    }
    settings.set(setting.key, mode);
    written.push(setting.key);
    seen.add(setting.key);
  }

  if (written.length === 0 || !opts?.onlyAdapterId) {
    for (const key of fallbackKeys) {
      if (seen.has(key)) continue;
      if (opts?.onlyAdapterId && key !== permissionModeKeyForAdapter(opts.onlyAdapterId)) continue;
      // Only fall back-write when the registry had no matching setting for that
      // key, so we don't overwrite a select that rejected the value above.
      if (targets.some((s) => s.key === key)) continue;
      settings.set(key, mode);
      written.push(key);
      seen.add(key);
    }
  }

  // Bridge to Codex native approval policy when not scoping to a single non-codex adapter.
  if (!opts?.onlyAdapterId || opts.onlyAdapterId === "openai.codex" || opts.onlyAdapterId?.includes("codex")) {
    const codexApproval = CODEX_APPROVAL_FROM_PERMISSION[mode];
    if (codexApproval) {
      // Prefer the registered key if present (extension may rename); fall back
      // to the known default so the write still lands before Codex activates.
      const registered = settings.list().find((s) => s.key.endsWith(".approvalPolicy") && s.key.includes("codex"));
      const key = registered?.key ?? CODEX_APPROVAL_KEY;
      if (registered?.options && registered.options.length > 0) {
        if (registered.options.some((o) => o.value === codexApproval)) {
          settings.set(key, codexApproval);
          if (!seen.has(key)) {
            written.push(key);
            seen.add(key);
          }
        }
      } else {
        settings.set(key, codexApproval);
        if (!seen.has(key)) {
          written.push(key);
          seen.add(key);
        }
      }
    }
  }

  return written;
}

/**
 * Snapshot of every registered permission-mode key → current value. Used by
 * the footer / modal so React can subscribe once and resolve the active
 * adapter cheaply.
 */
export function readPermissionModeSnapshot(settings: PermissionModeSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const setting of listPermissionModeSettings(settings)) {
    const raw = settings.get<unknown>(setting.key, setting.default);
    out[setting.key] = typeof raw === "string" && raw.length > 0 ? raw : String(setting.default);
  }
  // Seed fallbacks so the footer still works before provider extensions load.
  for (const key of [
    "anthropic.agent-sdk.permissionMode",
    "codesurf.daemon.permissionMode",
    "grok.cli.permissionMode",
    "anthropic.agent-sdk-claude-skills.permissionMode",
  ]) {
    if (key in out) continue;
    const raw = settings.get<unknown>(key, "default");
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}
