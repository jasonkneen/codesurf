// Discovery for Claude Code plugins.
//
// A Claude plugin is a DIRECTORY, not a module: a manifest plus conventional
// folders. CodeSurf can read all of it because the pieces are formats it
// already understands — `commands/*.md` are the same markdown slash commands
// `~/.claude/commands` holds, `skills/<name>/SKILL.md` is the same skill shape,
// `agents/*.md` the same sub-agent shape.
//
//   <root>/.claude-plugin/plugin.json   manifest (name, version, description)
//   <root>/commands/*.md                slash commands
//   <root>/skills/<name>/SKILL.md       skills
//   <root>/agents/*.md                  sub-agents
//   <root>/hooks/                       hooks
//   <root>/.mcp.json                    MCP servers
//
// Older plugins put `plugin.json` at the root instead of under
// `.claude-plugin/`; both are accepted because both exist on real machines.
//
// This module only READS. Nothing here activates a plugin or mutates the
// registry — that belongs to the plugin that surfaces them.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where a plugin was found. Shown in `/plugins` so provenance is visible. */
export type ClaudePluginSource = "user" | "project" | "marketplace" | "local";

export interface ClaudePluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string } | string;
  keywords?: string[];
}

export interface DiscoveredClaudePlugin {
  /** Namespaced so it cannot collide with a native `builtin.*` id. */
  id: string;
  name: string;
  version: string;
  description: string;
  root: string;
  source: ClaudePluginSource;
  /** `/<slug>` commands this plugin contributes, with their file paths. */
  commands: Array<{ slug: string; file: string }>;
  /** Skill directory names (each holding a SKILL.md). */
  skills: string[];
  /** Sub-agent names from `agents/*.md`. */
  agents: string[];
  hasHooks: boolean;
  hasMcp: boolean;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function listFiles(dir: string, extension: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith(extension))
      .sort();
  } catch {
    return [];
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The manifest for a plugin root, from either accepted location. */
export function readClaudePluginManifest(root: string): ClaudePluginManifest | null {
  const nested = readJson<ClaudePluginManifest>(path.join(root, ".claude-plugin", "plugin.json"));
  if (nested?.name) return nested;
  const flat = readJson<ClaudePluginManifest>(path.join(root, "plugin.json"));
  return flat?.name ? flat : null;
}

/** Read one plugin directory. Null when it has no usable manifest. */
export function readClaudePlugin(root: string, source: ClaudePluginSource): DiscoveredClaudePlugin | null {
  const manifest = readClaudePluginManifest(root);
  if (!manifest) return null;

  const commandsDir = path.join(root, "commands");
  // `_`-prefixed files are notes shipped beside the commands (e.g. a
  // `_conventions.md` the real commands include), not commands themselves.
  const commands = listFiles(commandsDir, ".md")
    .filter((file) => !file.startsWith("_"))
    .map((file) => ({
      slug: file.replace(/\.md$/, ""),
      file: path.join(commandsDir, file),
    }));

  const skills = listDirs(path.join(root, "skills")).filter((name) =>
    fs.existsSync(path.join(root, "skills", name, "SKILL.md")),
  );

  return {
    id: `claude.${manifest.name}`,
    name: manifest.name,
    version: manifest.version ?? "0.0.0",
    description: manifest.description ?? "",
    root,
    source,
    commands,
    skills,
    agents: listFiles(path.join(root, "agents"), ".md").map((file) => file.replace(/\.md$/, "")),
    hasHooks: fs.existsSync(path.join(root, "hooks")),
    hasMcp: fs.existsSync(path.join(root, ".mcp.json")),
  };
}

/** Roots that hold plugin directories, in precedence order (later wins). */
export function claudePluginRoots(
  projectRoot: string,
  home: string = os.homedir(),
): Array<{ dir: string; source: ClaudePluginSource }> {
  return [
    // Marketplace installs land under cache/<marketplace>/<name>/<version>.
    { dir: path.join(home, ".claude", "plugins", "cache"), source: "marketplace" as const },
    { dir: path.join(home, ".claude", "plugins"), source: "user" as const },
    // CodeSurf's own directory, which `/plugin install` writes to.
    { dir: path.join(home, ".codesurf", "plugins"), source: "local" as const },
    { dir: path.join(projectRoot, ".claude", "plugins"), source: "project" as const },
  ];
}

interface InstalledPluginsFile {
  plugins?: Record<string, Array<{ installPath?: string; scope?: string; projectPath?: string }>>;
}

/**
 * Claude Code's own record of marketplace plugins: which version directory is
 * installed (`installed_plugins.json`) and which are switched off
 * (`enabledPlugins` in its settings, project files overriding the user one).
 * Both are keyed `<plugin>@<marketplace>`.
 */
function readClaudeCodePluginState(projectRoot: string, home: string) {
  const installed = readJson<InstalledPluginsFile>(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const installPaths = new Map<string, string>();
  for (const [key, entries] of Object.entries(installed?.plugins ?? {})) {
    if (!Array.isArray(entries)) continue;
    const entry =
      entries.find(
        (e) => e.scope === "project" && e.projectPath && path.resolve(e.projectPath) === path.resolve(projectRoot),
      ) ?? entries.find((e) => e.scope !== "project");
    if (entry?.installPath) installPaths.set(key, entry.installPath);
  }

  const enabled = new Map<string, boolean>();
  for (const file of [
    path.join(home, ".claude", "settings.json"),
    path.join(projectRoot, ".claude", "settings.json"),
    path.join(projectRoot, ".claude", "settings.local.json"),
  ]) {
    const flags = readJson<{ enabledPlugins?: Record<string, unknown> }>(file)?.enabledPlugins;
    for (const [key, value] of Object.entries(flags ?? {})) {
      if (typeof value === "boolean") enabled.set(key, value);
    }
  }
  return { installPaths, enabled };
}

/**
 * Every Claude plugin visible from this project.
 *
 * The marketplace cache nests two levels deeper
 * (`cache/<marketplace>/<plugin>/<version>`), so it is walked separately rather
 * than assuming one shape fits every root. A later source wins on name
 * collision, so a project-local copy overrides a user-wide one.
 */
export function discoverClaudePlugins(projectRoot: string, home: string = os.homedir()): DiscoveredClaudePlugin[] {
  const byName = new Map<string, DiscoveredClaudePlugin>();
  const claudeCode = readClaudeCodePluginState(projectRoot, home);

  for (const { dir, source } of claudePluginRoots(projectRoot, home)) {
    if (!fs.existsSync(dir)) continue;

    if (source === "marketplace") {
      for (const marketplace of listDirs(dir)) {
        for (const plugin of listDirs(path.join(dir, marketplace))) {
          const key = `${plugin}@${marketplace}`;
          // Switched off in Claude Code: it is off here too, rather than
          // every plugin ever installed crowding the command menu.
          if (claudeCode.enabled.get(key) === false) continue;
          // The version Claude Code actually installed; the lexically last
          // directory is only a fallback (it sorts 0.9 after 0.10).
          const recorded = claudeCode.installPaths.get(key);
          const versions = listDirs(path.join(dir, marketplace, plugin));
          const pluginRoot =
            recorded && fs.existsSync(recorded)
              ? recorded
              : versions.length > 0
                ? path.join(dir, marketplace, plugin, versions[versions.length - 1])
                : null;
          if (!pluginRoot) continue;
          const found = readClaudePlugin(pluginRoot, source);
          if (found) byName.set(found.name, found);
        }
      }
      continue;
    }

    for (const entry of listDirs(dir)) {
      // `cache` is handled above; skip the bookkeeping dirs beside it.
      if (entry === "cache" || entry === "repos" || entry === "marketplaces") continue;
      const found = readClaudePlugin(path.join(dir, entry), source);
      if (found) byName.set(found.name, found);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve `${CLAUDE_PLUGIN_ROOT}` in a plugin command body.
 *
 * Claude Code substitutes it with the plugin's install directory so a command
 * can reach the scripts it ships; left literal, the model is handed a path
 * that does not exist.
 */
export function expandClaudePluginRoot(body: string, pluginRoot: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code placeholder, not a template.
  return body.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
}

/**
 * Plugins whose commands cannot work here and which CodeSurf replaces
 * natively. ralph-loop is driven entirely by a Claude Code `Stop` hook, which
 * CodeSurf does not run, so its commands would start a loop that never loops.
 */
const NATIVE_EQUIVALENTS: Record<string, string> = {
  "ralph-loop": "/loop ralph",
};

/** The native command that replaces a plugin's commands, if there is one. */
export function nativeEquivalentFor(pluginName: string): string | undefined {
  return NATIVE_EQUIVALENTS[pluginName];
}

/** One-line summary of what a plugin contributes, for the `/plugins` list. */
export function summariseClaudePlugin(plugin: DiscoveredClaudePlugin): string {
  const parts: string[] = [];
  if (plugin.commands.length > 0) parts.push(`${plugin.commands.length} cmd`);
  if (plugin.skills.length > 0) parts.push(`${plugin.skills.length} skill`);
  if (plugin.agents.length > 0) parts.push(`${plugin.agents.length} agent`);
  if (plugin.hasHooks) parts.push("hooks");
  if (plugin.hasMcp) parts.push("mcp");
  return parts.length > 0 ? parts.join(" · ") : "no contributions";
}
