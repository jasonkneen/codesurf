import * as fs from "fs";
import * as path from "path";
import { getCodesurfConfigDir } from "../../utils/config-dir";
import { writeFileAtomic } from "./atomic-write";

/** What the file was called before the plugins rename. */
const LEGACY_FILE = "extensions.json";
const FILE = "plugins.json";

/**
 * Resolve the persistence file path at call time. Respects
 * `CODESURF_CONFIG_DIR` so tests can redirect
 * writes away from the user's real config dir, and falls back to
 * `~/.codesurf/plugins.json` (or `~/.grok/plugins.json` when only the legacy
 * directory is present).
 */
function resolveConfigPaths(): { dir: string; file: string; legacyFile: string } {
  const dir = getCodesurfConfigDir();
  return { dir, file: path.join(dir, FILE), legacyFile: path.join(dir, LEGACY_FILE) };
}

/**
 * Move `extensions.json` to `plugins.json` on first touch after the rename.
 *
 * Copy-then-verify rather than `rename`: the old file is only removed once the
 * new one is readable, so a crash mid-migration leaves the user with their
 * original preferences intact rather than neither file. Losing this file
 * silently re-enables everything the user turned off, which is exactly the
 * failure the dead MCP opt-out already demonstrated.
 *
 * Best-effort: a read-only config dir keeps working off the legacy file.
 */
function migrateLegacyFile(): void {
  const { file, legacyFile } = resolveConfigPaths();
  try {
    if (fs.existsSync(file) || !fs.existsSync(legacyFile)) return;
    fs.copyFileSync(legacyFile, file);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === fs.readFileSync(legacyFile, "utf-8")) {
      fs.unlinkSync(legacyFile);
    }
  } catch {
    // Read-only or racing config dir: `readFile` still falls back to the
    // legacy path below, so preferences are honoured either way.
  }
}

interface PluginsPersistence {
  /** Null ⇒ no preference recorded yet (fall back to manifest.enabledByDefault). */
  enabled: string[] | null;
  /**
   * Explicit user opt-outs. When an id appears here it stays disabled even
   * if its manifest sets `enabledByDefault: true`. This lets new builtins
   * shipped in updates auto-activate (additive defaults) while honouring
   * any extension the user has deliberately turned off.
   */
  disabled: string[];
  /** Map of toolName -> enabled. Absence means "use default". */
  tools: Record<string, boolean>;
  /** Plugin-owned settings keyed by the setting's `key`. */
  settings: Record<string, unknown>;
}

const EMPTY: PluginsPersistence = { enabled: null, disabled: [], tools: {}, settings: {} };

function ensureDir() {
  const { dir } = resolveConfigPaths();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy an unreadable preferences file aside before anything can replace it.
 *
 * Reads happen many times per boot, so an identical existing backup is reused
 * rather than stacking one copy per read.
 */
function preserveCorruptFile(source: string, contents: Buffer): string {
  const dir = path.dirname(source);
  const prefix = `${path.basename(source)}.corrupt-`;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(prefix)) continue;
    try {
      if (fs.readFileSync(path.join(dir, entry)).equals(contents)) return path.join(dir, entry);
    } catch {
      // Unreadable sidecar; keep looking.
    }
  }
  const base = `${source}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  for (let attempt = 0; ; attempt += 1) {
    const backupPath = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      fs.writeFileSync(backupPath, contents, { flag: "wx", mode: 0o600 });
      return backupPath;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    }
  }
}

/** Sources already reported this process, so a boot's many reads log once. */
const reportedUnreadable = new Set<string>();

/**
 * The preferences file exists but cannot be understood.
 *
 * Reads fall back to defaults so the app still boots; writes refuse, because
 * writing back a default-shaped file would silently re-enable everything the
 * user turned off and drop their tool overrides and settings.
 */
function unreadable(
  source: string,
  reason: string,
  contents: Buffer | undefined,
  mode: "lenient" | "strict",
): PluginsPersistence {
  let backupMessage = "";
  if (contents) {
    try {
      backupMessage = ` Preserved a copy at ${preserveCorruptFile(source, contents)}.`;
    } catch (error) {
      backupMessage = ` Failed to create a backup: ${errorMessage(error)}.`;
    }
  }
  const message = `[plugins] Cannot read plugin preferences ${source}: ${reason}.${backupMessage} Using defaults for this session and refusing to overwrite the file; fix or delete it to save preferences again.`;
  if (mode === "strict") throw new Error(message);
  if (!reportedUnreadable.has(source)) {
    reportedUnreadable.add(source);
    console.error(message);
  }
  return { ...EMPTY };
}

function readFile(mode: "lenient" | "strict" = "lenient"): PluginsPersistence {
  try {
    migrateLegacyFile();
  } catch {
    // Best effort; see migrateLegacyFile.
  }
  const { file, legacyFile } = resolveConfigPaths();
  // Fall back to the pre-rename file when migration could not write.
  const source = fs.existsSync(file) ? file : legacyFile;
  if (!fs.existsSync(source)) return { ...EMPTY };

  let raw: Buffer;
  try {
    raw = fs.readFileSync(source);
  } catch (error) {
    return unreadable(source, `could not read file: ${errorMessage(error)}`, undefined, mode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch (error) {
    return unreadable(source, `invalid JSON: ${errorMessage(error)}`, raw, mode);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return unreadable(source, "expected a JSON object", raw, mode);
  }
  const data = parsed as Partial<PluginsPersistence>;
  return {
    enabled: Array.isArray(data.enabled) ? data.enabled : null,
    disabled: Array.isArray(data.disabled) ? data.disabled : [],
    tools: data.tools && typeof data.tools === "object" ? { ...data.tools } : {},
    settings: data.settings && typeof data.settings === "object" ? { ...data.settings } : {},
  };
}

/**
 * Read for a read-modify-write. Throws instead of returning defaults when the
 * file is unreadable, so the caller's write never replaces it.
 */
function readForUpdate(): PluginsPersistence {
  return readFile("strict");
}

function writeFile(data: PluginsPersistence) {
  ensureDir();
  migrateLegacyFile();
  const { file } = resolveConfigPaths();
  // Atomic so a crash never leaves a torn file, and owner-only because
  // secret-typed plugin settings (API keys) are stored here.
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
}

export function loadEnabledPluginIds(): string[] | null {
  return readFile().enabled;
}

export function saveEnabledPluginIds(ids: string[]) {
  const current = readForUpdate();
  writeFile({ ...current, enabled: [...ids] });
}

/**
 * Record one opt-in without touching anyone else's.
 *
 * Several CodeSurf processes (TUIs, bridges, builds of different branches)
 * share this file. Rewriting the whole list from one process's view dropped
 * ids that process did not know and undid opt-ins made elsewhere; editing a
 * single id keeps every other entry as the file has it.
 */
export function addEnabledPluginId(id: string) {
  const current = readForUpdate();
  const enabled = current.enabled ?? [];
  if (enabled.includes(id)) return;
  writeFile({ ...current, enabled: [...enabled, id] });
}

export function removeEnabledPluginId(id: string) {
  const current = readForUpdate();
  if (!current.enabled?.includes(id)) return;
  writeFile({ ...current, enabled: current.enabled.filter((x) => x !== id) });
}

/** Add `ids` to the persisted opt-ins. Never removes one. */
export function mergeEnabledPluginIds(ids: string[]) {
  const current = readForUpdate();
  const enabled = current.enabled ?? [];
  const missing = ids.filter((id) => !enabled.includes(id));
  if (missing.length === 0 && current.enabled !== null) return;
  writeFile({ ...current, enabled: [...enabled, ...missing] });
}

/**
 * The whole file, or a throw when it exists but cannot be read — for callers
 * that must not mistake "unreadable" for "empty" (a live reload that treated
 * a torn read as {} would delete every setting in memory).
 */
export function readPluginPreferencesStrict(): {
  enabled: string[] | null;
  disabled: string[];
  tools: Record<string, boolean>;
  settings: Record<string, unknown>;
} {
  return readFile("strict");
}

/** The preferences file this process reads and writes. */
export function pluginPreferencesFile(): string {
  return resolveConfigPaths().file;
}

export function loadDisabledPluginIds(): string[] {
  return readFile().disabled;
}

export function addDisabledPluginId(id: string) {
  const current = readForUpdate();
  if (current.disabled.includes(id)) return;
  writeFile({ ...current, disabled: [...current.disabled, id] });
}

export function removeDisabledPluginId(id: string) {
  const current = readForUpdate();
  if (!current.disabled.includes(id)) return;
  writeFile({ ...current, disabled: current.disabled.filter((x) => x !== id) });
}

export function loadToolOverrides(): Record<string, boolean> {
  return readFile().tools;
}

export function saveToolOverride(toolName: string, enabled: boolean) {
  const current = readForUpdate();
  writeFile({ ...current, tools: { ...current.tools, [toolName]: enabled } });
}

export function clearToolOverride(toolName: string) {
  const current = readForUpdate();
  const next = { ...current.tools };
  delete next[toolName];
  writeFile({ ...current, tools: next });
}

export function loadPluginSettings(): Record<string, unknown> {
  return readFile().settings;
}

export function savePluginSetting(key: string, value: unknown) {
  const current = readForUpdate();
  writeFile({ ...current, settings: { ...current.settings, [key]: value } });
}

export function clearPluginSetting(key: string) {
  const current = readForUpdate();
  const next = { ...current.settings };
  delete next[key];
  writeFile({ ...current, settings: next });
}
