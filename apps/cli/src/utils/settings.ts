import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_MODEL, getEffectiveReasoningEffort, getModelIds, normalizeModelId } from "../grok/models";
import type { HooksConfig } from "../hooks/types";
import type {
  LspBuiltInServerId,
  LspBuiltInServerSettings,
  LspCustomServerConfig,
  LspSettings,
  NormalizedLspSettings,
} from "../lsp/types";
import type { AgentMode, ReasoningEffort } from "../types/index";
import { getCodesurfConfigDir } from "./config-dir";
import { workspaceRoot } from "./workspace-scope";

export type TelegramStreamingMode = "off" | "partial";
export type SandboxMode = "off" | "shuru";
export type PaymentChain = "base" | "base-sepolia";

export interface PaymentApprovalSettings {
  autoApprove?: boolean;
}

export interface PaymentSettings {
  enabled?: boolean;
  chain?: PaymentChain;
  approval?: PaymentApprovalSettings;
}

const DEFAULT_PAYMENT_SETTINGS: Required<PaymentSettings> = {
  enabled: false,
  chain: "base-sepolia",
  approval: {
    autoApprove: false,
  },
};

const DEFAULT_LSP_SETTINGS: NormalizedLspSettings = {
  enabled: true,
  tool: true,
  autoInstall: false,
  startupTimeoutMs: 30_000,
  diagnosticsDebounceMs: 200,
  builtins: {},
  servers: [],
};

export interface SandboxSecretConfig {
  name: string;
  fromEnv: string;
  hosts: string[];
}

export interface SandboxSettings {
  allowNet?: boolean;
  allowedHosts?: string[];
  ports?: string[];
  cpus?: number;
  memory?: number;
  diskSize?: number;
  secrets?: SandboxSecretConfig[];
  from?: string;
  allowEphemeralInstall?: boolean;
  guestWorkdir?: string;
  syncHostWorkspace?: boolean;
  verifyBaseFrom?: string;
  shellInit?: string[];
  hostBrowserCommandsOnHost?: boolean;
}

export interface TelegramAudioInputSettings {
  /** Enable Telegram voice/audio transcription before sending text to the agent. Default: true. */
  enabled?: boolean;
  /** Language code (e.g. `en`, `fr`) forwarded to the Grok STT endpoint. Default: en. */
  language?: string;
}

export interface TelegramSettings {
  botToken?: string;
  approvedUserIds?: number[];
  sessionsByUserId?: Record<string, string>;
  /** Live preview while generating. Default: partial (send + edit). Use `off` for buffer-then-send only. */
  streaming?: TelegramStreamingMode;
  /** Send `typing` chat action on an interval while the agent runs. Default: true. */
  typingIndicator?: boolean;
  /** Reserved: Bot API `sendMessageDraft` for private DMs (not implemented yet). */
  nativeDrafts?: boolean;
  audioInput?: TelegramAudioInputSettings;
}

export type McpRemoteTransport = "http" | "sse";

export interface McpServerConfig {
  id: string;
  label: string;
  enabled: boolean;
  transport: McpRemoteTransport | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpSettings {
  servers?: McpServerConfig[];
}

export interface CustomSubagentConfig {
  name: string;
  model: string;
  instruction: string;
}

const RESERVED_SUBAGENT_NAMES = new Set([
  "general",
  "explore",
  "vision",
  "verify",
  "verify-detect",
  "verify-manifest",
  "computer",
]);

export function isReservedSubagentName(name: string): boolean {
  return RESERVED_SUBAGENT_NAMES.has(name.trim().toLowerCase());
}

export function parseSubAgentsRawList(raw: unknown): CustomSubagentConfig[] {
  if (!Array.isArray(raw)) return [];

  const validModels = new Set(getModelIds());
  const seen = new Set<string>();
  const agents: CustomSubagentConfig[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;

    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const model = typeof entry.model === "string" ? normalizeModelId(entry.model) : "";
    const instruction = typeof entry.instruction === "string" ? entry.instruction : "";

    if (!name || isReservedSubagentName(name) || !validModels.has(model)) {
      continue;
    }

    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    agents.push({ name, model, instruction });
  }

  return agents;
}

export function loadValidSubAgents(): CustomSubagentConfig[] {
  return parseSubAgentsRawList(loadUserSettings().subAgents);
}

export type UiMode = "opencode" | "claude-code";

/** Edit-approval policy for the kernel `write_file` and `edit_file` tools.
 *  - "accept-all" (default): edits apply immediately, transcript shows the
 *     applied diff. Preserves historical behaviour.
 *  - "ask-always": every edit pauses for an inline Accept/Reject panel with
 *     a diff preview, plus in-session escape hatches (accept-all-this-session,
 *     accept-this-path). The persistent setting itself stays "ask-always". */
export type EditApprovalMode = "ask-always" | "accept-all";

export interface UserSettings {
  apiKey?: string;
  defaultModel?: string;
  /** Adapter selected for defaultModel when multiple adapters expose the same id. */
  defaultModelAdapterId?: string;
  recapsEnabled?: boolean;
  sandboxMode?: SandboxMode;
  sandbox?: SandboxSettings;
  lsp?: LspSettings;
  reasoningEffortByModel?: Record<string, ReasoningEffort>;
  telegram?: TelegramSettings;
  mcp?: McpSettings;
  subAgents?: CustomSubagentConfig[];
  hooks?: HooksConfig;
  payments?: PaymentSettings;
  modeModels?: Partial<Record<AgentMode, string>>;
  modeModelAdapters?: Partial<Record<AgentMode, string>>;
  theme?: string;
  /** Tool-chip name aliases (upper tool name -> short chip label), e.g. { COMMAND: "RUN" }. */
  chipAliases?: Record<string, string>;
  /** Namespace heads that collapse to the org alone in tool chips (e.g. BUDDY.* -> BUDDY). */
  chipOrgHeads?: string[];
  /** Category label per tool name for top-level chip collapse (e.g. { bash: "Shell", read_file: "Files" }). */
  chipCategories?: Record<string, string>;
  /** Extra hosts to probe for reachable `codesurf node` servers (network discovery). */
  serverHosts?: string[];
  /** Purely cosmetic. "opencode" = current wide flat layout; "claude-code" =
   *  termcast/Claude-Code-style bordered prompt with a top title bar and a
   *  rule above the composer. No functional behavior depends on this. */
  uiMode?: UiMode;
  /** See {@link EditApprovalMode}. Defaults to "accept-all" when unset. */
  editApproval?: EditApprovalMode;
  /**
   * Selected terminal pet id, or `"disabled"` to hide. Resolved against the
   * pets registry in `core/plugins/builtin/pets`. Unset = no pet shown
   * (same as `"disabled"`, but lets a future onboarding flow distinguish
   * "never chosen" from "explicitly off"). */
  tuiPet?: string;
  /** Background server (`codesurf server`) behaviour for interactive launches. */
  server?: ServerSettings;
}

export interface KnownServer {
  name?: string;
  lastConnectedAt: string;
}

export interface ServerSettings {
  /** Start the default background server when the TUI launches and none is running. Default true. */
  autoStart?: boolean;
  /** Servers this user started or connected to, keyed by ws:// url; attached without asking. */
  known?: Record<string, KnownServer>;
}

export interface ProjectSettings {
  model?: string;
  modelAdapterId?: string;
  sandboxMode?: SandboxMode;
  sandbox?: SandboxSettings;
  lsp?: LspSettings;
}

export interface ModelSelection {
  model: string;
  adapterId?: string;
}

// Migration notes (CLI rebrand from grok-cli -> codesurf): user settings used
// to live unconditionally at ~/.grok/user-settings.json. Everything else in
// the app (extensions.json, credentials.json, the terminal db, the telegram
// poller lock) has since moved to ~/.codesurf, resolved via
// getCodesurfConfigDir(). This was the one holdout -- disabling an extension
// in ~/.codesurf/extensions.json had zero effect on settings that only ever
// lived in the legacy ~/.grok/user-settings.json (API keys, telegram tokens,
// sandbox mode, etc.), because nothing here ever looked there.
const USER_DIR = getCodesurfConfigDir();
const USER_SETTINGS_PATH = path.join(USER_DIR, "user-settings.json");
const LEGACY_USER_SETTINGS_PATH = path.join(os.homedir(), ".grok", "user-settings.json");
const USER_SETTINGS_MIGRATION_MARKER = path.join(USER_DIR, ".user-settings-migrated-from-grok");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Returns the on-disk path user settings are read from / written to.
 *  Exported so other modules that need to check the same file (e.g.
 *  `file-tools-approval.ts`'s preflight parse check) don't duplicate the
 *  legacy-vs-new resolution logic and drift out of sync. */
export function getUserSettingsPath(): string {
  return USER_SETTINGS_PATH;
}

let userSettingsMigrationChecked = false;

/** One-time, best-effort copy of ~/.grok/user-settings.json forward to the
 *  resolved ~/.codesurf location, mirroring the marker-file pattern already
 *  used for the sqlite db migration in `storage/db.ts`. Copies (never moves)
 *  so the legacy file survives as a safety net, and never re-runs once a
 *  marker or a real file exists at the new path -- so an intentional reset
 *  (deleting the new file) doesn't get silently undone by re-copying stale
 *  legacy data on the next launch. */
function migrateLegacyUserSettingsOnce(): void {
  if (userSettingsMigrationChecked) return;
  userSettingsMigrationChecked = true;

  // An explicit config-dir override (tests, sandboxed installs) is a fresh
  // location by design -- don't pull the real ~/.grok settings into it.
  if (process.env.CODESURF_CONFIG_DIR?.trim()) return;
  // Already resolved to the legacy home itself (no ~/.codesurf on disk yet) --
  // nothing to migrate, source and destination are the same file.
  if (USER_SETTINGS_PATH === LEGACY_USER_SETTINGS_PATH) return;
  if (fs.existsSync(USER_SETTINGS_MIGRATION_MARKER) || fs.existsSync(USER_SETTINGS_PATH)) return;

  if (!fs.existsSync(LEGACY_USER_SETTINGS_PATH)) {
    try {
      ensureDir(USER_DIR);
      fs.writeFileSync(USER_SETTINGS_MIGRATION_MARKER, new Date().toISOString(), { mode: 0o600 });
    } catch {
      /* non-fatal -- worst case we re-check next time */
    }
    return;
  }

  try {
    ensureDir(USER_DIR);
    fs.copyFileSync(LEGACY_USER_SETTINGS_PATH, USER_SETTINGS_PATH);
    fs.chmodSync(USER_SETTINGS_PATH, 0o600);
    fs.writeFileSync(
      USER_SETTINGS_MIGRATION_MARKER,
      `migrated-from=${LEGACY_USER_SETTINGS_PATH}\nmigrated-at=${new Date().toISOString()}\n`,
      { mode: 0o600 },
    );
    process.stderr.write(
      `[codesurf] migrated user settings from ${LEGACY_USER_SETTINGS_PATH} to ${USER_SETTINGS_PATH} (legacy file preserved).\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[codesurf] user-settings migration from ${LEGACY_USER_SETTINGS_PATH} failed: ${(err as Error).message}. Falling back to defaults at ${USER_SETTINGS_PATH}.\n`,
    );
  }
}

// Memoize settings JSON reads keyed by mtime+size. `loadUserSettings` /
// `loadProjectSettings` are called from per-tool-call, per-turn, and
// per-render paths; uncached, every call is a synchronous read+parse that
// blocks the event loop the TUI's input handling shares (same class of
// problem as `cli-check-cache.ts`). A hit costs one statSync; misses and
// external edits re-read via the single code path below. In-process writes
// invalidate in `writeJson`.
const jsonReadCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

/** Test-only: drop all cached settings reads. */
export function __resetSettingsReadCacheForTests(): void {
  jsonReadCache.clear();
}

function readJson<T>(filePath: string): T | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    jsonReadCache.delete(filePath);
    return null;
  }
  const cached = jsonReadCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value as T;
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    jsonReadCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    jsonReadCache.delete(filePath);
    return null;
  }
}

/**
 * Replace a settings file atomically: write a sibling temp file (mode 0600,
 * these files hold API keys and bot tokens), fsync it, then rename over the
 * target, so a crash mid-write leaves the old file intact instead of a
 * truncated one.
 *
 * Refuses to write when the existing file cannot be parsed. Every caller
 * merges its update into the loaded contents, and a parse failure loads as
 * `{}` — writing would replace the user's keys, MCP servers and hooks with
 * just the one field being saved.
 */
function writeJson(filePath: string, data: unknown): void {
  if (fs.existsSync(filePath) && readJson(filePath) === null) {
    throw new Error(
      `Refusing to overwrite ${filePath}: the existing file is not valid JSON. Fix or remove it, then try again.`,
    );
  }
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    const fd = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
  // Delete rather than update: the next read re-stats and re-parses, keeping
  // one code path for cache population.
  jsonReadCache.delete(filePath);
}

export function loadUserSettings(): UserSettings {
  migrateLegacyUserSettingsOnce();
  return readJson<UserSettings>(USER_SETTINGS_PATH) || {};
}

export function saveUserSettings(partial: Partial<UserSettings>): void {
  const current = loadUserSettings();
  const next: UserSettings = {
    ...current,
    ...partial,
    ...(partial.apiKey !== undefined ? { apiKey: partial.apiKey } : {}),
    ...(partial.defaultModel !== undefined ? { defaultModel: normalizeModelId(partial.defaultModel) } : {}),
    ...(partial.defaultModel !== undefined && partial.defaultModelAdapterId === undefined
      ? { defaultModelAdapterId: undefined }
      : {}),
    ...(partial.defaultModelAdapterId !== undefined
      ? { defaultModelAdapterId: normalizeModelAdapterId(partial.defaultModelAdapterId) }
      : {}),
    ...(partial.sandboxMode !== undefined ? { sandboxMode: normalizeSandboxMode(partial.sandboxMode) } : {}),
    ...(partial.reasoningEffortByModel !== undefined
      ? {
          reasoningEffortByModel: Object.fromEntries(
            Object.entries(partial.reasoningEffortByModel).map(([modelId, effort]) => [
              normalizeModelId(modelId),
              effort,
            ]),
          ),
        }
      : {}),
    ...(partial.telegram !== undefined
      ? {
          telegram: {
            ...current.telegram,
            ...partial.telegram,
            audioInput: {
              ...current.telegram?.audioInput,
              ...partial.telegram?.audioInput,
            },
            sessionsByUserId: {
              ...current.telegram?.sessionsByUserId,
              ...partial.telegram?.sessionsByUserId,
            },
          },
        }
      : {}),
    ...(partial.mcp !== undefined
      ? {
          mcp: {
            ...current.mcp,
            ...partial.mcp,
            servers: partial.mcp.servers ?? current.mcp?.servers ?? [],
          },
        }
      : {}),
    ...(partial.server !== undefined
      ? {
          server: {
            ...current.server,
            ...partial.server,
            known: { ...current.server?.known, ...partial.server.known },
          },
        }
      : {}),
    ...(partial.subAgents !== undefined
      ? {
          subAgents: partial.subAgents.map((agent) => ({
            ...agent,
            model: normalizeModelId(agent.model),
          })),
        }
      : {}),
    ...(partial.sandbox !== undefined
      ? { sandbox: normalizeSandboxSettings({ ...current.sandbox, ...partial.sandbox }) }
      : {}),
    ...(partial.lsp !== undefined
      ? {
          lsp: mergeLspSettings(current.lsp, partial.lsp),
        }
      : {}),
    ...(partial.payments !== undefined
      ? {
          payments: {
            ...current.payments,
            ...partial.payments,
            approval: {
              ...current.payments?.approval,
              ...partial.payments?.approval,
            },
          },
        }
      : {}),
  };

  writeJson(USER_SETTINGS_PATH, next);
}

export function loadProjectSettings(): ProjectSettings {
  const projectPath = path.join(workspaceRoot(), ".grok", "settings.json");
  return readJson<ProjectSettings>(projectPath) || {};
}

export function saveProjectSettings(partial: Partial<ProjectSettings>): void {
  const projectPath = path.join(workspaceRoot(), ".grok", "settings.json");
  const current = loadProjectSettings();
  writeJson(projectPath, {
    ...current,
    ...partial,
    ...(partial.model !== undefined ? { model: normalizeModelId(partial.model) } : {}),
    ...(partial.model !== undefined && partial.modelAdapterId === undefined ? { modelAdapterId: undefined } : {}),
    ...(partial.modelAdapterId !== undefined
      ? { modelAdapterId: normalizeModelAdapterId(partial.modelAdapterId) }
      : {}),
    ...(partial.sandboxMode !== undefined ? { sandboxMode: normalizeSandboxMode(partial.sandboxMode) } : {}),
    ...(partial.sandbox !== undefined
      ? { sandbox: normalizeSandboxSettings({ ...current.sandbox, ...partial.sandbox }) }
      : {}),
    ...(partial.lsp !== undefined
      ? {
          lsp: mergeLspSettings(current.lsp, partial.lsp),
        }
      : {}),
  });
}

export function getApiKey(): string | undefined {
  return (
    process.env.CODESURF_API_KEY ||
    process.env.MINIMAX_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    loadUserSettings().apiKey
  );
}

export function getBaseURL(): string {
  return process.env.CODESURF_BASE_URL || "https://api.x.ai/v1";
}

function getModelEnvOverride(): string | undefined {
  return process.env.CODESURF_MODEL;
}

function getModelAdapterEnvOverride(): string | undefined {
  return process.env.CODESURF_MODEL_ADAPTER;
}

export function normalizeModelAdapterId(adapterId: unknown): string | undefined {
  return typeof adapterId === "string" && adapterId.trim() ? adapterId.trim() : undefined;
}

export function getCurrentModelSelection(mode?: AgentMode): ModelSelection {
  const envModel = getModelEnvOverride();
  if (envModel) {
    return { model: normalizeModelId(envModel), adapterId: normalizeModelAdapterId(getModelAdapterEnvOverride()) };
  }

  const project = loadProjectSettings();
  if (project.model) {
    return { model: normalizeModelId(project.model), adapterId: normalizeModelAdapterId(project.modelAdapterId) };
  }

  const user = loadUserSettings();
  if (mode) {
    const modeModel = user.modeModels?.[mode];
    if (modeModel) {
      return {
        model: normalizeModelId(modeModel),
        adapterId: normalizeModelAdapterId(user.modeModelAdapters?.[mode]),
      };
    }
  }

  return {
    model: user.defaultModel ? normalizeModelId(user.defaultModel) : DEFAULT_MODEL,
    adapterId: normalizeModelAdapterId(user.defaultModelAdapterId),
  };
}

export function getCurrentModel(mode?: AgentMode): string {
  return getCurrentModelSelection(mode).model;
}

export function getCurrentModelAdapterId(mode?: AgentMode): string | undefined {
  return getCurrentModelSelection(mode).adapterId;
}

/**
 * Returns the explicitly configured model for a mode, or undefined if none is set.
 * Only CODESURF_MODEL env vars suppress this (absolute override).
 * Project-level model does NOT suppress — modeModels is an explicit per-mode config
 * that applies on mode switch.
 */
export function getModeSpecificModelSelection(mode: AgentMode): ModelSelection | undefined {
  if (getModelEnvOverride()) return undefined;

  const user = loadUserSettings();
  const modeModel = user.modeModels?.[mode];
  return modeModel
    ? {
        model: normalizeModelId(modeModel),
        adapterId: normalizeModelAdapterId(user.modeModelAdapters?.[mode]),
      }
    : undefined;
}

export function normalizeSandboxMode(value: unknown): SandboxMode {
  return value === "shuru" ? "shuru" : "off";
}

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeSecretConfig(raw: unknown): SandboxSecretConfig | null {
  if (!isNonNullObject(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const fromEnv = typeof raw.fromEnv === "string" ? raw.fromEnv.trim() : "";
  const hosts = Array.isArray(raw.hosts)
    ? raw.hosts.filter((h): h is string => typeof h === "string" && h.trim() !== "")
    : [];
  if (!name || !fromEnv) return null;
  return { name, fromEnv, hosts };
}

export function normalizeSandboxSettings(raw: unknown): SandboxSettings {
  if (!isNonNullObject(raw)) return {};
  const result: SandboxSettings = {};

  if (typeof raw.allowNet === "boolean") result.allowNet = raw.allowNet;
  if (Array.isArray(raw.allowedHosts)) {
    const hosts = raw.allowedHosts.filter((h): h is string => typeof h === "string" && h.trim() !== "");
    if (hosts.length > 0) result.allowedHosts = hosts;
  }
  if (Array.isArray(raw.ports)) {
    const ports = raw.ports.filter((p): p is string => typeof p === "string" && /^\d+:\d+$/.test(p.trim()));
    if (ports.length > 0) result.ports = ports;
  }
  if (typeof raw.cpus === "number" && raw.cpus > 0) result.cpus = raw.cpus;
  if (typeof raw.memory === "number" && raw.memory > 0) result.memory = raw.memory;
  if (typeof raw.diskSize === "number" && raw.diskSize > 0) result.diskSize = raw.diskSize;
  if (Array.isArray(raw.secrets)) {
    const secrets = raw.secrets.map(normalizeSecretConfig).filter((s): s is SandboxSecretConfig => s !== null);
    if (secrets.length > 0) result.secrets = secrets;
  }
  if (typeof raw.from === "string" && raw.from.trim()) result.from = raw.from.trim();
  if (typeof raw.verifyBaseFrom === "string" && raw.verifyBaseFrom.trim())
    result.verifyBaseFrom = raw.verifyBaseFrom.trim();
  if (typeof raw.allowEphemeralInstall === "boolean") result.allowEphemeralInstall = raw.allowEphemeralInstall;
  if (typeof raw.syncHostWorkspace === "boolean") result.syncHostWorkspace = raw.syncHostWorkspace;
  if (typeof raw.guestWorkdir === "string" && raw.guestWorkdir.trim()) result.guestWorkdir = raw.guestWorkdir.trim();
  if (Array.isArray(raw.shellInit)) {
    const shellInit = raw.shellInit.filter((line): line is string => typeof line === "string" && line.trim() !== "");
    if (shellInit.length > 0) result.shellInit = shellInit;
  }
  if (typeof raw.hostBrowserCommandsOnHost === "boolean")
    result.hostBrowserCommandsOnHost = raw.hostBrowserCommandsOnHost;

  return result;
}

export function mergeSandboxSettings(
  base: SandboxSettings | undefined,
  override: SandboxSettings | undefined,
): SandboxSettings {
  if (!base && !override) return {};
  if (!base) return { ...override };
  if (!override) return { ...base };
  return {
    allowNet: override.allowNet ?? base.allowNet,
    allowedHosts: override.allowedHosts ?? base.allowedHosts,
    ports: override.ports ?? base.ports,
    cpus: override.cpus ?? base.cpus,
    memory: override.memory ?? base.memory,
    diskSize: override.diskSize ?? base.diskSize,
    secrets: override.secrets ?? base.secrets,
    from: override.from ?? base.from,
    allowEphemeralInstall: override.allowEphemeralInstall ?? base.allowEphemeralInstall,
    guestWorkdir: override.guestWorkdir ?? base.guestWorkdir,
    syncHostWorkspace: override.syncHostWorkspace ?? base.syncHostWorkspace,
    verifyBaseFrom: override.verifyBaseFrom ?? base.verifyBaseFrom,
    shellInit: override.shellInit ?? base.shellInit,
    hostBrowserCommandsOnHost: override.hostBrowserCommandsOnHost ?? base.hostBrowserCommandsOnHost,
  };
}

function normalizeLspBuiltInServerSettings(raw: unknown): LspBuiltInServerSettings | undefined {
  if (!isNonNullObject(raw)) return undefined;
  const result: LspBuiltInServerSettings = {};

  if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
  if (typeof raw.command === "string" && raw.command.trim()) result.command = raw.command.trim();
  if (Array.isArray(raw.args)) {
    const args = raw.args.filter((value): value is string => typeof value === "string");
    if (args.length > 0) result.args = args;
  }
  if (isNonNullObject(raw.env)) {
    const envEntries = Object.entries(raw.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    const env = Object.fromEntries(envEntries);
    if (Object.keys(env).length > 0) result.env = env;
  }
  if (isNonNullObject(raw.initialization)) {
    result.initialization = raw.initialization;
  }
  if (Array.isArray(raw.rootMarkers)) {
    const rootMarkers = raw.rootMarkers.filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    if (rootMarkers.length > 0) result.rootMarkers = rootMarkers;
  }
  if (Array.isArray(raw.extensions)) {
    const extensions = raw.extensions.filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    if (extensions.length > 0) result.extensions = extensions;
  }

  return result;
}

function normalizeLspCustomServerConfig(raw: unknown): LspCustomServerConfig | null {
  if (!isNonNullObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const extensions = Array.isArray(raw.extensions)
    ? raw.extensions.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : [];
  if (!id || !command || extensions.length === 0) return null;

  const result: LspCustomServerConfig = {
    id,
    command,
    extensions,
  };

  if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
  if (Array.isArray(raw.args)) {
    result.args = raw.args.filter((value): value is string => typeof value === "string");
  }
  if (isNonNullObject(raw.env)) {
    result.env = Object.fromEntries(
      Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  if (isNonNullObject(raw.initialization)) {
    result.initialization = raw.initialization;
  }
  if (Array.isArray(raw.rootMarkers)) {
    result.rootMarkers = raw.rootMarkers.filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
  }
  if (isNonNullObject(raw.languageIds)) {
    result.languageIds = Object.fromEntries(
      Object.entries(raw.languageIds)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].trim() !== "")
        .map(([key, value]) => [key.trim(), value]),
    );
  }

  return result;
}

export function normalizeLspSettings(raw: unknown): NormalizedLspSettings {
  if (!isNonNullObject(raw)) return { ...DEFAULT_LSP_SETTINGS };

  const builtins: Partial<Record<LspBuiltInServerId, LspBuiltInServerSettings>> = {};
  if (isNonNullObject(raw.builtins)) {
    for (const [key, value] of Object.entries(raw.builtins)) {
      const normalized = normalizeLspBuiltInServerSettings(value);
      if (!normalized) continue;
      builtins[key as LspBuiltInServerId] = normalized;
    }
  }

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_LSP_SETTINGS.enabled,
    tool: typeof raw.tool === "boolean" ? raw.tool : DEFAULT_LSP_SETTINGS.tool,
    autoInstall: typeof raw.autoInstall === "boolean" ? raw.autoInstall : DEFAULT_LSP_SETTINGS.autoInstall,
    startupTimeoutMs:
      typeof raw.startupTimeoutMs === "number" && raw.startupTimeoutMs > 0
        ? raw.startupTimeoutMs
        : DEFAULT_LSP_SETTINGS.startupTimeoutMs,
    diagnosticsDebounceMs:
      typeof raw.diagnosticsDebounceMs === "number" && raw.diagnosticsDebounceMs >= 0
        ? raw.diagnosticsDebounceMs
        : DEFAULT_LSP_SETTINGS.diagnosticsDebounceMs,
    builtins,
    servers: Array.isArray(raw.servers)
      ? raw.servers
          .map(normalizeLspCustomServerConfig)
          .filter((value): value is LspCustomServerConfig => value !== null)
      : [],
  };
}

export function mergeLspSettings(
  base: LspSettings | undefined,
  override: LspSettings | undefined,
): NormalizedLspSettings {
  const baseNormalized = normalizeLspSettings(base);
  const overrideNormalized = normalizeLspSettings(override);

  return {
    enabled: override?.enabled ?? base?.enabled ?? DEFAULT_LSP_SETTINGS.enabled,
    tool: override?.tool ?? base?.tool ?? DEFAULT_LSP_SETTINGS.tool,
    autoInstall: override?.autoInstall ?? base?.autoInstall ?? DEFAULT_LSP_SETTINGS.autoInstall,
    startupTimeoutMs: override?.startupTimeoutMs ?? base?.startupTimeoutMs ?? DEFAULT_LSP_SETTINGS.startupTimeoutMs,
    diagnosticsDebounceMs:
      override?.diagnosticsDebounceMs ?? base?.diagnosticsDebounceMs ?? DEFAULT_LSP_SETTINGS.diagnosticsDebounceMs,
    builtins: {
      ...baseNormalized.builtins,
      ...overrideNormalized.builtins,
    },
    servers:
      override?.servers !== undefined
        ? overrideNormalized.servers
        : base?.servers !== undefined
          ? baseNormalized.servers
          : DEFAULT_LSP_SETTINGS.servers,
  };
}

// Trust boundary: `.grok/settings.json` (and a verify `environment.json`) is
// committed to the repository, so a cloned repo controls it. Same reasoning
// as project hooks (hooks/config.ts): anything that decides what runs on the
// host, what leaves the sandbox, or which host secrets are forwarded comes
// from user settings only. A project file may tighten sandboxing (off ->
// shuru) and tune guest-only knobs, never weaken or redirect it.

/** Sandbox fields a repo-controlled file may set: guest resources and layout only. */
export function pickProjectSafeSandboxSettings(raw: unknown): SandboxSettings {
  const normalized = normalizeSandboxSettings(raw);
  const safe: SandboxSettings = {};
  if (normalized.cpus !== undefined) safe.cpus = normalized.cpus;
  if (normalized.memory !== undefined) safe.memory = normalized.memory;
  if (normalized.diskSize !== undefined) safe.diskSize = normalized.diskSize;
  if (normalized.guestWorkdir !== undefined) safe.guestWorkdir = normalized.guestWorkdir;
  if (normalized.syncHostWorkspace !== undefined) safe.syncHostWorkspace = normalized.syncHostWorkspace;
  return safe;
}

/**
 * LSP settings a repo-controlled file may set. Server commands, args, env and
 * custom servers are spawned on the host; `initialization` can carry binary
 * paths (e.g. typescript-language-server's `tsserver.path`); `autoInstall`
 * downloads and runs installers. All of those stay user-only.
 */
export function pickProjectSafeLspSettings(raw: unknown): LspSettings {
  if (!isNonNullObject(raw)) return {};
  const safe: LspSettings = {};
  if (typeof raw.enabled === "boolean") safe.enabled = raw.enabled;
  if (typeof raw.tool === "boolean") safe.tool = raw.tool;
  if (typeof raw.startupTimeoutMs === "number" && raw.startupTimeoutMs > 0)
    safe.startupTimeoutMs = raw.startupTimeoutMs;
  if (typeof raw.diagnosticsDebounceMs === "number" && raw.diagnosticsDebounceMs >= 0)
    safe.diagnosticsDebounceMs = raw.diagnosticsDebounceMs;
  if (isNonNullObject(raw.builtins)) {
    const builtins: Partial<Record<LspBuiltInServerId, LspBuiltInServerSettings>> = {};
    for (const [key, value] of Object.entries(raw.builtins)) {
      const normalized = normalizeLspBuiltInServerSettings(value);
      if (!normalized) continue;
      const entry: LspBuiltInServerSettings = {};
      if (normalized.enabled !== undefined) entry.enabled = normalized.enabled;
      if (normalized.rootMarkers) entry.rootMarkers = normalized.rootMarkers;
      if (normalized.extensions) entry.extensions = normalized.extensions;
      builtins[key as LspBuiltInServerId] = entry;
    }
    safe.builtins = builtins;
  }
  return safe;
}

export function getCurrentSandboxMode(): SandboxMode {
  const project = loadProjectSettings();
  // A project may opt into the sandbox but never out of the user's choice.
  if (normalizeSandboxMode(project.sandboxMode) === "shuru") return "shuru";
  const user = loadUserSettings();
  if (user.sandboxMode) return normalizeSandboxMode(user.sandboxMode);
  return "off";
}

export function getCurrentSandboxSettings(): SandboxSettings {
  const user = loadUserSettings();
  const project = loadProjectSettings();
  return mergeSandboxSettings(normalizeSandboxSettings(user.sandbox), pickProjectSafeSandboxSettings(project.sandbox));
}

export function getCurrentLspSettings(): NormalizedLspSettings {
  const user = loadUserSettings();
  const project = loadProjectSettings();
  const projectLsp = pickProjectSafeLspSettings(project.lsp);
  if (projectLsp.builtins) {
    // mergeLspSettings replaces a builtin entry wholesale; layer the project's
    // safe fields over the user's entry so a user-set command survives.
    const userBuiltins = normalizeLspSettings(user.lsp).builtins;
    projectLsp.builtins = Object.fromEntries(
      Object.entries(projectLsp.builtins).map(([key, entry]) => [
        key,
        { ...userBuiltins[key as LspBuiltInServerId], ...entry },
      ]),
    );
  }
  return mergeLspSettings(user.lsp, projectLsp);
}

// Key-normalized views of `reasoningEffortByModel`, keyed by the settings
// object itself. With the settings read cache above, the same object comes
// back across calls, so this builds the normalized map once instead of
// re-normalizing every key per lookup. First occurrence wins on collisions,
// matching the previous `.find()` semantics.
const normalizedEffortsByObject = new WeakMap<Record<string, ReasoningEffort>, Record<string, ReasoningEffort>>();

function getNormalizedEfforts(savedEfforts: Record<string, ReasoningEffort>): Record<string, ReasoningEffort> {
  let normalized = normalizedEffortsByObject.get(savedEfforts);
  if (!normalized) {
    normalized = {};
    for (const [savedModelId, savedEffort] of Object.entries(savedEfforts)) {
      const key = normalizeModelId(savedModelId);
      if (!(key in normalized)) normalized[key] = savedEffort;
    }
    normalizedEffortsByObject.set(savedEfforts, normalized);
  }
  return normalized;
}

export function getReasoningEffortForModel(modelId: string): ReasoningEffort | undefined {
  const normalizedModelId = normalizeModelId(modelId);
  const savedEfforts = loadUserSettings().reasoningEffortByModel ?? {};
  const effort = savedEfforts[normalizedModelId] ?? getNormalizedEfforts(savedEfforts)[normalizedModelId];
  return getEffectiveReasoningEffort(normalizedModelId, effort);
}

export function loadRecapsEnabled(): boolean {
  return loadUserSettings().recapsEnabled !== false;
}

export function saveRecapsEnabled(enabled: boolean): void {
  saveUserSettings({ recapsEnabled: enabled });
}

export function getTelegramBotToken(): string | undefined {
  const env = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (env) return env;
  return loadUserSettings().telegram?.botToken?.trim();
}

export function saveApprovedTelegramUserId(userId: number): void {
  const settings = loadUserSettings();
  const approvedUserIds = new Set(settings.telegram?.approvedUserIds ?? []);
  approvedUserIds.add(userId);
  saveUserSettings({
    telegram: {
      ...settings.telegram,
      approvedUserIds: [...approvedUserIds],
    },
  });
}

export function resolveTelegramStreamSettings(t: TelegramSettings | undefined): {
  streaming: TelegramStreamingMode;
  typingIndicator: boolean;
  nativeDrafts: boolean;
} {
  return {
    streaming: t?.streaming === "off" ? "off" : "partial",
    typingIndicator: t?.typingIndicator !== false,
    nativeDrafts: t?.nativeDrafts === true,
  };
}

export function resolveTelegramAudioInputSettings(t: TelegramSettings | undefined): {
  enabled: boolean;
  language: string;
} {
  return {
    enabled: t?.audioInput?.enabled !== false,
    language: t?.audioInput?.language?.trim() || "en",
  };
}

export function loadMcpServers(): McpServerConfig[] {
  return loadUserSettings().mcp?.servers ?? [];
}

export function saveMcpServers(servers: McpServerConfig[]): void {
  saveUserSettings({ mcp: { servers } });
}

export function loadPaymentSettings(): Required<PaymentSettings> {
  const payments = loadUserSettings().payments;
  return {
    enabled: payments?.enabled ?? DEFAULT_PAYMENT_SETTINGS.enabled,
    chain:
      payments?.chain === "base" || payments?.chain === "base-sepolia"
        ? payments.chain
        : DEFAULT_PAYMENT_SETTINGS.chain,
    approval: {
      autoApprove: payments?.approval?.autoApprove ?? DEFAULT_PAYMENT_SETTINGS.approval.autoApprove,
    },
  };
}

export function savePaymentSettings(partial: PaymentSettings): void {
  saveUserSettings({ payments: partial });
}

export function loadEditApprovalMode(): EditApprovalMode {
  const v = loadUserSettings().editApproval;
  return v === "ask-always" || v === "accept-all" ? v : "accept-all";
}

export function saveEditApprovalMode(mode: EditApprovalMode): void {
  saveUserSettings({ editApproval: mode });
}

export function isServerAutoStartEnabled(): boolean {
  return loadUserSettings().server?.autoStart !== false;
}

export function isKnownServer(url: string): boolean {
  return Boolean(loadUserSettings().server?.known?.[url]);
}

/** Remember a server so later launches attach to it without asking. */
export function rememberKnownServer(url: string, name?: string): void {
  const previous = loadUserSettings().server?.known?.[url];
  saveUserSettings({
    server: {
      known: { [url]: { name: name ?? previous?.name, lastConnectedAt: new Date().toISOString() } },
    },
  });
}
