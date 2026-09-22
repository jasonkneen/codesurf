// Extension manifest schema (codesurf).
// Intentionally trimmed from the termcast spec: no popup/surface/action contributions.

import semver from "semver";

export const EXTENSIONS_V1_API_VERSION = "1.0.0";
export const EXTENSIONS_V1_API_RANGE = "^1.0.0";

export type PluginKind = "builtin" | "user";

export type HostCapability =
  | "commands"
  | "tools"
  | "settings"
  | "models"
  | "provider-adapters"
  | "screens"
  | "status-indicators"
  | "mentions";

const extensionCapabilities = new Set<HostCapability>([
  "commands",
  "tools",
  "settings",
  "models",
  "provider-adapters",
  "screens",
  "status-indicators",
  "mentions",
]);

export interface PluginPermissions {
  files?: "none" | "read" | "write";
  process?: "none" | "spawn";
  network?: "none" | "request";
  settings?: "read" | "write";
}

export interface HostGroupMetadata {
  /** Stable group id, e.g. "codesurf.providers". */
  id: string;
  /** Human-facing group name shown in `/extensions`. */
  name: string;
  description?: string;
  /** Optional top-level ordering hint for grouped extension browsers. */
  order?: number;
}

export interface HostManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  hostApiVersion: string;
  description?: string;
  kind: PluginKind;
  /** Relative path from the manifest root to the module entry. Informational only. */
  entry?: string;
  /** Protected extensions cannot be disabled by users. */
  protected?: boolean;
  /** Hide from the `/extensions` modal (internal shims). */
  hidden?: boolean;
  /** Default enabled state when no persisted preference exists. */
  enabledByDefault?: boolean;
  /** Optional presentation grouping for extension browsers. */
  group?: HostGroupMetadata;
  capabilities: HostCapability[];
  /**
   * Declarative metadata for extension discovery and review. In-process
   * extension modules are not sandboxed, so this is not a runtime security
   * boundary or permission grant.
   */
  permissions?: PluginPermissions;
}

export function assertManifest(manifest: HostManifest): HostManifest {
  if (!manifest.id.trim()) {
    throw new Error("Extension manifest requires a non-empty id");
  }
  if (!manifest.name.trim()) {
    throw new Error(`Extension ${manifest.id} requires a non-empty name`);
  }
  if (!Array.isArray(manifest.capabilities)) {
    throw new Error(`Extension ${manifest.id} requires a capabilities array`);
  }
  for (const capability of manifest.capabilities) {
    if (!extensionCapabilities.has(capability)) {
      throw new Error(`Extension ${manifest.id} declares unknown capability "${String(capability)}"`);
    }
  }
  const hostApiVersion = semver.valid(manifest.hostApiVersion);
  if (!hostApiVersion || !semver.satisfies(hostApiVersion, EXTENSIONS_V1_API_RANGE, { includePrerelease: true })) {
    throw new Error(
      `Extension ${manifest.id} targets host API ${manifest.hostApiVersion}, expected ${EXTENSIONS_V1_API_RANGE}`,
    );
  }
  return manifest;
}

/**
 * Enforce the manifest-to-registration contract. This validates a declared
 * contribution category; it deliberately does not claim to sandbox
 * in-process JavaScript or enforce `permissions` at runtime.
 */
export function assertManifestCapability(
  manifest: HostManifest,
  capability: HostCapability,
  contribution: string,
): void {
  if (!manifest.capabilities.includes(capability)) {
    throw new Error(
      `Extension ${manifest.id} must declare the "${capability}" capability before registering ${contribution}.`,
    );
  }
}
