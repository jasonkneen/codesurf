// The plugins.json migration.
//
// This file holds the user's enable/disable preferences. Losing it silently
// re-enables everything they turned off — the exact failure the dead
// `builtin.commands.mcpPrompts` opt-out already demonstrated, from an id rename
// back in May. So the rename from `extensions.json` migrates rather than
// starting fresh, and it copies-then-verifies rather than renaming: a crash
// mid-migration must leave the original readable, never neither file.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDisabledPluginId,
  loadDisabledPluginIds,
  loadEnabledPluginIds,
  loadPluginSettings,
  saveEnabledPluginIds,
  savePluginSetting,
} from "./plugins";

const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
let configDir = "";

const LEGACY = {
  enabled: ["builtin.tools.bash", "builtin.provider-xai"],
  disabled: ["builtin.mcp"],
  tools: { grep: false },
  settings: { "voice.enabled": true },
};

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-plugins-persist-"));
  process.env.CODESURF_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

const legacyPath = () => path.join(configDir, "extensions.json");
const currentPath = () => path.join(configDir, "plugins.json");

describe("plugins.json migration from extensions.json", () => {
  it("carries every preference across and removes the old file", () => {
    fs.writeFileSync(legacyPath(), JSON.stringify(LEGACY), "utf-8");

    expect(loadEnabledPluginIds()).toEqual(LEGACY.enabled);
    expect(loadDisabledPluginIds()).toEqual(LEGACY.disabled);
    expect(loadPluginSettings()).toEqual(LEGACY.settings);

    expect(fs.existsSync(currentPath())).toBe(true);
    // Only removed after the copy read back identical.
    expect(fs.existsSync(legacyPath())).toBe(false);
  });

  it("prefers an existing plugins.json and leaves a stale legacy file alone", () => {
    // Both present means a previous version wrote the new file; the old one is
    // history and must not overwrite it.
    fs.writeFileSync(legacyPath(), JSON.stringify(LEGACY), "utf-8");
    fs.writeFileSync(currentPath(), JSON.stringify({ ...LEGACY, enabled: ["only.this"] }), "utf-8");

    expect(loadEnabledPluginIds()).toEqual(["only.this"]);
    expect(fs.existsSync(legacyPath())).toBe(true);
  });

  it("is a no-op on a fresh config with neither file", () => {
    expect(loadEnabledPluginIds()).toBeNull();
    expect(loadDisabledPluginIds()).toEqual([]);
    expect(fs.existsSync(currentPath())).toBe(false);
  });

  it("writes to plugins.json after migrating, not back to the old name", () => {
    fs.writeFileSync(legacyPath(), JSON.stringify(LEGACY), "utf-8");

    saveEnabledPluginIds(["builtin.tools.bash"]);

    expect(JSON.parse(fs.readFileSync(currentPath(), "utf-8")).enabled).toEqual(["builtin.tools.bash"]);
    expect(fs.existsSync(legacyPath())).toBe(false);
    // The rest of the legacy payload survived the write.
    expect(loadDisabledPluginIds()).toEqual(LEGACY.disabled);
    expect(loadPluginSettings()).toEqual(LEGACY.settings);
  });

  it("still honours the legacy file when the config dir cannot be written", () => {
    fs.writeFileSync(legacyPath(), JSON.stringify(LEGACY), "utf-8");
    fs.chmodSync(configDir, 0o500); // read + execute, no write
    try {
      // Migration fails silently; the read falls back rather than reporting
      // "no preferences", which would re-enable what the user disabled.
      expect(loadEnabledPluginIds()).toEqual(LEGACY.enabled);
      expect(loadDisabledPluginIds()).toEqual(LEGACY.disabled);
    } finally {
      fs.chmodSync(configDir, 0o700);
    }
  });
});

describe("plugins.json writes", () => {
  const backups = () => fs.readdirSync(configDir).filter((entry) => entry.startsWith("plugins.json.corrupt-"));

  // A torn or hand-mangled file used to read as "no preferences", and the
  // next write (bootstrap always writes) replaced it with defaults — wiping
  // the user's disabled list, tool overrides and settings.
  it("refuses to overwrite an unreadable file and preserves a copy", () => {
    const torn = '{"disabled":["builtin.mcp"],"settings":{"voice.enabled":tr';
    fs.writeFileSync(currentPath(), torn, "utf-8");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Reads fall back to defaults so the app still boots…
      expect(loadEnabledPluginIds()).toBeNull();
      expect(loadDisabledPluginIds()).toEqual([]);
      // …but writes refuse rather than replace the user's file.
      expect(() => saveEnabledPluginIds(["builtin.tools.bash"])).toThrow(/refusing to overwrite/);
      expect(() => addDisabledPluginId("x")).toThrow(/refusing to overwrite/);
      expect(() => savePluginSetting("k", 1)).toThrow(/refusing to overwrite/);
      expect(fs.readFileSync(currentPath(), "utf-8")).toBe(torn);

      // One backup however many times it was read.
      expect(backups()).toHaveLength(1);
      expect(fs.readFileSync(path.join(configDir, backups()[0]!), "utf-8")).toBe(torn);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("replaces the file atomically with owner-only permissions", () => {
    if (process.platform === "win32") return;
    fs.writeFileSync(currentPath(), JSON.stringify(LEGACY), { encoding: "utf-8", mode: 0o644 });
    fs.chmodSync(currentPath(), 0o644);
    const inodeBefore = fs.statSync(currentPath()).ino;

    savePluginSetting("knowledge.openai.apiKey", "sk-test");

    const stat = fs.statSync(currentPath());
    // A new inode means the file was renamed into place, never truncated.
    expect(stat.ino).not.toBe(inodeBefore);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(loadPluginSettings()).toEqual({ ...LEGACY.settings, "knowledge.openai.apiKey": "sk-test" });
    expect(fs.readdirSync(configDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
