// plugins.json is shared by every CodeSurf process on the machine (TUIs,
// bridges, builds of other branches). These pin the two ways one process used
// to lose another's preferences: rewriting the whole enabled list from its own
// view, and reading settings once at boot so later changes never arrived.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodesurfPlugin } from "@codesurf/plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginModule } from "./index";
import { __resetPluginsForTests, bootstrapPlugins, disablePlugin, enablePlugin, getHostServices } from "./index";
import { createNativePluginModule } from "./native/host";

let tempDir: string;
let originalEnv: string | undefined;

function configFile(): string {
  return path.join(tempDir, "plugins.json");
}

function writeConfig(value: unknown): void {
  fs.writeFileSync(configFile(), `${JSON.stringify(value, null, 2)}\n`);
}

function readConfig(): { enabled: string[] | null; disabled: string[]; settings: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(configFile(), "utf-8"));
}

function makePlugin(id: string, enabledByDefault = true): PluginModule {
  return createNativePluginModule({
    name: id,
    manifest: { id, name: id, version: "1.0.0", capabilities: ["commands"], enabledByDefault },
    inject: ["contributions"],
    apply: (() => {}) as CodesurfPlugin["apply"],
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-shared-prefs-"));
  originalEnv = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
  if (originalEnv === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalEnv;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("shared enabled list", () => {
  it("keeps opt-ins for plugins this build does not know about", async () => {
    writeConfig({
      enabled: ["test.known", "builtin.from-another-build"],
      disabled: [],
      tools: {},
      settings: {},
    });

    await bootstrapPlugins([makePlugin("test.known"), makePlugin("test.default-on")]);

    const { enabled } = readConfig();
    expect(enabled).toContain("builtin.from-another-build");
    expect(enabled).toEqual(expect.arrayContaining(["test.known", "test.default-on"]));
  });

  it("disabling one plugin removes only that id", async () => {
    writeConfig({ enabled: ["test.a", "test.b", "builtin.elsewhere"], disabled: [], tools: {}, settings: {} });
    await bootstrapPlugins([makePlugin("test.a"), makePlugin("test.b")]);

    await disablePlugin("test.a");

    const { enabled, disabled } = readConfig();
    expect(enabled).not.toContain("test.a");
    expect(enabled).toEqual(expect.arrayContaining(["test.b", "builtin.elsewhere"]));
    expect(disabled).toContain("test.a");
  });

  it("an opt-in made by another process after this one booted survives this one's toggles", async () => {
    writeConfig({ enabled: ["test.a"], disabled: [], tools: {}, settings: {} });
    await bootstrapPlugins([makePlugin("test.a"), makePlugin("test.off", false)]);

    // Another process turns on a default-off plugin.
    const current = readConfig();
    writeConfig({ ...current, enabled: [...(current.enabled ?? []), "test.off"] });

    // This process then toggles something unrelated.
    await disablePlugin("test.a");
    await enablePlugin("test.a");

    expect(readConfig().enabled).toContain("test.off");
  });
});

describe("live settings", () => {
  it("applies a setting another process wrote, and notifies subscribers", async () => {
    writeConfig({ enabled: null, disabled: [], tools: {}, settings: { "test.theme": "dark" } });
    await bootstrapPlugins([makePlugin("test.a")]);
    const settings = getHostServices().settings;
    const seen: unknown[] = [];
    settings.subscribe("test.theme", (value) => seen.push(value));
    expect(settings.get("test.theme")).toBe("dark");

    const current = readConfig();
    writeConfig({ ...current, settings: { ...current.settings, "test.theme": "light" } });

    await vi.waitFor(() => expect(settings.get("test.theme")).toBe("light"), { timeout: 3_000 });
    expect(seen).toEqual(["light"]);
  });

  it("keeps settings in memory when the file is briefly unreadable", async () => {
    writeConfig({ enabled: null, disabled: [], tools: {}, settings: { "test.key": 1 } });
    await bootstrapPlugins([makePlugin("test.a")]);
    const settings = getHostServices().settings;

    fs.writeFileSync(configFile(), "{ torn");
    // Give the watcher time to fire and (correctly) ignore the torn read.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(settings.get("test.key")).toBe(1);
  });
});
