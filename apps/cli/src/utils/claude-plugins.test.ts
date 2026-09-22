// Discovery of Claude Code plugins.
//
// Everything here runs against temp directories, never the machine's real
// ~/.claude — a test that reads the developer's own plugins passes or fails
// depending on what they happen to have installed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverClaudePlugins,
  expandClaudePluginRoot,
  nativeEquivalentFor,
  readClaudePlugin,
  readClaudePluginManifest,
  summariseClaudePlugin,
} from "./claude-plugins";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-claude-plugins-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Build a plugin directory. `nested` picks which manifest location to use. */
function makePlugin(
  dir: string,
  manifest: Record<string, unknown>,
  parts: { commands?: string[]; skills?: string[]; agents?: string[]; hooks?: boolean; mcp?: boolean } = {},
  nested = true,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const manifestDir = nested ? path.join(dir, ".claude-plugin") : dir;
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, "plugin.json"), JSON.stringify(manifest), "utf-8");

  for (const name of parts.commands ?? []) {
    fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir, "commands", `${name}.md`), `Do ${name} with $ARGUMENTS`, "utf-8");
  }
  for (const name of parts.skills ?? []) {
    fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), "---\nname: x\n---\nbody", "utf-8");
  }
  for (const name of parts.agents ?? []) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", `${name}.md`), "agent", "utf-8");
  }
  if (parts.hooks) fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  if (parts.mcp) fs.writeFileSync(path.join(dir, ".mcp.json"), "{}", "utf-8");
  return dir;
}

describe("readClaudePluginManifest", () => {
  it("reads the canonical .claude-plugin/plugin.json", () => {
    const dir = makePlugin(path.join(root, "a"), { name: "alpha", version: "1.2.3" });
    expect(readClaudePluginManifest(dir)?.name).toBe("alpha");
  });

  it("also reads a root plugin.json, which older plugins ship", () => {
    const dir = makePlugin(path.join(root, "b"), { name: "beta" }, {}, false);
    expect(readClaudePluginManifest(dir)?.name).toBe("beta");
  });

  it("returns null for a directory that is not a plugin", () => {
    const dir = path.join(root, "c");
    fs.mkdirSync(dir, { recursive: true });
    expect(readClaudePluginManifest(dir)).toBeNull();
  });

  it("returns null for a manifest with no name", () => {
    const dir = makePlugin(path.join(root, "d"), { version: "1.0.0" });
    expect(readClaudePluginManifest(dir)).toBeNull();
  });

  it("returns null rather than throwing on malformed JSON", () => {
    const dir = path.join(root, "e", ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), "{ not json", "utf-8");
    expect(readClaudePluginManifest(path.join(root, "e"))).toBeNull();
  });
});

describe("readClaudePlugin", () => {
  it("reports every contribution folder", () => {
    const dir = makePlugin(
      path.join(root, "full"),
      { name: "full", version: "2.0.0", description: "Everything" },
      { commands: ["build", "test"], skills: ["analysis"], agents: ["reviewer"], hooks: true, mcp: true },
    );
    const plugin = readClaudePlugin(dir, "user");

    expect(plugin?.id).toBe("claude.full");
    expect(plugin?.version).toBe("2.0.0");
    expect(plugin?.commands.map((c) => c.slug)).toEqual(["build", "test"]);
    expect(plugin?.skills).toEqual(["analysis"]);
    expect(plugin?.agents).toEqual(["reviewer"]);
    expect(plugin?.hasHooks).toBe(true);
    expect(plugin?.hasMcp).toBe(true);
  });

  it("ignores a skills subdirectory with no SKILL.md", () => {
    const dir = makePlugin(path.join(root, "partial"), { name: "partial" });
    fs.mkdirSync(path.join(dir, "skills", "empty"), { recursive: true });
    expect(readClaudePlugin(dir, "user")?.skills).toEqual([]);
  });

  it("defaults a missing version and description rather than failing", () => {
    const dir = makePlugin(path.join(root, "bare"), { name: "bare" });
    const plugin = readClaudePlugin(dir, "user");
    expect(plugin?.version).toBe("0.0.0");
    expect(plugin?.description).toBe("");
  });
});

describe("discoverClaudePlugins", () => {
  it("finds project plugins under .claude/plugins", () => {
    const project = path.join(root, "project");
    makePlugin(path.join(project, ".claude", "plugins", "local-one"), { name: "local-one" }, { commands: ["go"] });

    const found = discoverClaudePlugins(project);
    const names = found.map((p) => p.name);
    expect(names).toContain("local-one");
    expect(found.find((p) => p.name === "local-one")?.source).toBe("project");
  });

  it("skips the bookkeeping directories beside the plugin folders", () => {
    const project = path.join(root, "skips");
    const plugins = path.join(project, ".claude", "plugins");
    for (const name of ["cache", "repos", "marketplaces"]) {
      makePlugin(path.join(plugins, name), { name });
    }
    makePlugin(path.join(plugins, "real"), { name: "real" });

    const names = discoverClaudePlugins(project).map((p) => p.name);
    expect(names).toContain("real");
    for (const name of ["cache", "repos", "marketplaces"]) expect(names).not.toContain(name);
  });

  it("returns plugins sorted by name", () => {
    const project = path.join(root, "sorted");
    const plugins = path.join(project, ".claude", "plugins");
    for (const name of ["zebra", "alpha", "mango"]) makePlugin(path.join(plugins, name), { name });

    const names = discoverClaudePlugins(project).map((p) => p.name);
    const projectOnly = names.filter((n) => ["zebra", "alpha", "mango"].includes(n));
    expect(projectOnly).toEqual(["alpha", "mango", "zebra"]);
  });

  it("survives a project with no .claude directory at all", () => {
    expect(() => discoverClaudePlugins(path.join(root, "nothing-here"))).not.toThrow();
  });
});

describe("discoverClaudePlugins with Claude Code's plugin state", () => {
  function home(): string {
    return path.join(root, "home");
  }
  function cachePlugin(market: string, name: string, version: string, commands: string[] = ["go"]): string {
    return makePlugin(
      path.join(home(), ".claude", "plugins", "cache", market, name, version),
      { name, version },
      { commands },
    );
  }
  function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), "utf-8");
  }

  it("leaves out a marketplace plugin switched off in Claude Code", () => {
    cachePlugin("mkt", "on-one", "1.0.0");
    cachePlugin("mkt", "off-one", "1.0.0");
    writeJson(path.join(home(), ".claude", "settings.json"), {
      enabledPlugins: { "on-one@mkt": true, "off-one@mkt": false },
    });

    const names = discoverClaudePlugins(path.join(root, "project"), home()).map((p) => p.name);
    expect(names).toContain("on-one");
    expect(names).not.toContain("off-one");
  });

  it("lets a project settings file switch a plugin back on", () => {
    cachePlugin("mkt", "toggled", "1.0.0");
    const project = path.join(root, "project");
    writeJson(path.join(home(), ".claude", "settings.json"), { enabledPlugins: { "toggled@mkt": false } });
    writeJson(path.join(project, ".claude", "settings.json"), { enabledPlugins: { "toggled@mkt": true } });

    expect(discoverClaudePlugins(project, home()).map((p) => p.name)).toContain("toggled");
  });

  it("loads the version Claude Code installed, not the lexically last directory", () => {
    const installed = cachePlugin("mkt", "versioned", "0.10.3");
    cachePlugin("mkt", "versioned", "0.9.2");
    writeJson(path.join(home(), ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "versioned@mkt": [{ scope: "user", installPath: installed }] },
    });

    const found = discoverClaudePlugins(path.join(root, "project"), home()).find((p) => p.name === "versioned");
    expect(found?.version).toBe("0.10.3");
    expect(found?.root).toBe(installed);
  });

  it("does not list _-prefixed notes as commands", () => {
    cachePlugin("mkt", "noted", "1.0.0", ["deploy", "_conventions"]);

    const found = discoverClaudePlugins(path.join(root, "project"), home()).find((p) => p.name === "noted");
    expect(found?.commands.map((c) => c.slug)).toEqual(["deploy"]);
  });
});

describe("summariseClaudePlugin", () => {
  it("lists only what a plugin actually contributes", () => {
    const dir = makePlugin(path.join(root, "s1"), { name: "s1" }, { commands: ["a", "b"], hooks: true });
    expect(summariseClaudePlugin(readClaudePlugin(dir, "user")!)).toBe("2 cmd · hooks");
  });

  it("says so when a plugin contributes nothing", () => {
    const dir = makePlugin(path.join(root, "s2"), { name: "s2" });
    expect(summariseClaudePlugin(readClaudePlugin(dir, "user")!)).toBe("no contributions");
  });
});

describe("expandClaudePluginRoot", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code placeholder under test.
  it("replaces every ${CLAUDE_PLUGIN_ROOT} with the plugin's directory", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code placeholder under test.
    const body = 'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/a.mjs"` then `${CLAUDE_PLUGIN_ROOT}/b.sh`.';
    expect(expandClaudePluginRoot(body, "/p/codex/1.0.2")).toBe(
      'Run `node "/p/codex/1.0.2/scripts/a.mjs"` then `/p/codex/1.0.2/b.sh`.',
    );
  });

  it("leaves a body without the variable unchanged", () => {
    expect(expandClaudePluginRoot("Do $ARGUMENTS", "/p")).toBe("Do $ARGUMENTS");
  });
});

describe("nativeEquivalentFor", () => {
  it("names the native replacement for ralph-loop", () => {
    expect(nativeEquivalentFor("ralph-loop")).toBe("/loop ralph");
  });

  it("has none for an ordinary plugin", () => {
    expect(nativeEquivalentFor("vercel")).toBeUndefined();
  });
});
