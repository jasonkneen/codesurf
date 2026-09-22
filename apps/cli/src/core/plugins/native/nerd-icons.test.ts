// Smoke tests for the nerd-icons extension and the icon-resolver sink.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetIconResolverForTests,
  __resetPluginsForTests,
  bootstrapPlugins,
  EXTENSIONS_V1_API_VERSION,
  enablePlugin,
  getHostServices,
  getIcon,
  getRegistrySnapshot,
  setIconResolver,
} from "../index";
import { __resetNativeRuntimeForTests, createNativePluginModule } from "./host";
import { nerdIconsPlugin } from "./nerd-icons";

// Isolate persisted settings: without this the suite reads the developer's
// real config dir, where nerdIcons.enabled may be true — flipping the
// "defaults to false" assertions.
let configDir: string;
let originalConfigDir: string | undefined;

beforeAll(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-nerd-icons-config-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = configDir;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("icon-resolver sink", () => {
  afterEach(() => {
    __resetIconResolverForTests();
  });

  it("returns empty string when no resolver is bound", () => {
    expect(getIcon("bash")).toBe("");
  });

  it("forwards lookups to a bound resolver", () => {
    setIconResolver((name) => (name === "bash" ? "" : null));
    expect(getIcon("bash")).toBe("");
    expect(getIcon("grep")).toBe("");
  });

  it("swallows resolver exceptions", () => {
    setIconResolver(() => {
      throw new Error("boom");
    });
    expect(getIcon("anything")).toBe("");
  });

  it("clears icons when resolver is unbound", () => {
    setIconResolver(() => "");
    expect(getIcon("grep")).toBe("");
    setIconResolver(null);
    expect(getIcon("grep")).toBe("");
  });
});

describe("nerd-icons plugin", () => {
  beforeEach(async () => {
    __resetPluginsForTests();
    __resetNativeRuntimeForTests();
    __resetIconResolverForTests();
    await bootstrapPlugins([createNativePluginModule(nerdIconsPlugin)]);
  });

  afterEach(() => {
    // The setting is PERSISTED, and every test in this file shares one config
    // dir, so a test that flips it on must put it back or the next test's
    // "defaults to false" assertion reads the previous test's value.
    try {
      getHostServices().settings.set("nerdIcons.enabled", false);
    } catch {
      // host services already torn down; nothing persisted to undo
    }
    __resetIconResolverForTests();
    __resetPluginsForTests();
    __resetNativeRuntimeForTests();
  });

  it("has the expected manifest shape", () => {
    // Adapted for the loader by createNativePluginModule, so the V1 fields the
    // host reads are still exactly what they were.
    expect(createNativePluginModule(nerdIconsPlugin).manifest).toMatchObject({
      id: "builtin.icons.nerd-fonts",
      kind: "builtin",
      hostApiVersion: EXTENSIONS_V1_API_VERSION,
      enabledByDefault: false,
    });
  });

  it("clears the icon resolver when the plugin is disabled", async () => {
    const { disablePlugin } = await import("../index");
    await enablePlugin("builtin.icons.nerd-fonts");
    getHostServices().settings.set("nerdIcons.enabled", true);
    expect(getIcon("bash").length).toBeGreaterThan(0);

    // The effect that set the resolver is what clears it: disabling must leave
    // no glyphs behind, or the plugin outlives its own lifetime.
    await disablePlugin("builtin.icons.nerd-fonts");
    expect(getIcon("bash")).toBe("");
  });

  it("registers the /nerd-icons command and the nerdIcons.enabled setting", async () => {
    // Disabled-by-default means it's not active at bootstrap; activate it.
    await enablePlugin("builtin.icons.nerd-fonts");
    const snap = getRegistrySnapshot();
    expect(snap.commands.find((c) => c.name === "/nerd-icons")).toBeDefined();
    expect(snap.settings.find((s) => s.key === "nerdIcons.enabled")).toBeDefined();
  });

  it("keeps the resolver unbound while the setting is false", async () => {
    await enablePlugin("builtin.icons.nerd-fonts");
    // Setting defaults to false → resolver should still be null.
    expect(getIcon("bash")).toBe("");
  });

  it("binds the resolver when the setting flips to true and clears on false", async () => {
    await enablePlugin("builtin.icons.nerd-fonts");
    const services = getHostServices();
    expect(getIcon("bash")).toBe("");
    services.settings.set("nerdIcons.enabled", true);
    expect(getIcon("bash").length).toBeGreaterThan(0);
    expect(getIcon("codesurf").length).toBeGreaterThan(0);
    expect(getIcon("context_meter").length).toBeGreaterThan(0);
    expect(getIcon("progress_full").length).toBeGreaterThan(0);
    expect(getIcon("progress_empty").length).toBeGreaterThan(0);
    expect(getIcon("voice").length).toBeGreaterThan(0);
    expect(getIcon("close").length).toBeGreaterThan(0);
    expect(getIcon("not-a-real-tool")).toBe("");
    services.settings.set("nerdIcons.enabled", false);
    expect(getIcon("bash")).toBe("");
  });
});
