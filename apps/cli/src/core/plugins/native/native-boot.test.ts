// The native plugin as the host actually boots it.
//
// `native-runtime.test.ts` exercises the Cordis lifecycle directly; this file
// goes through the real loader — `bootstrapPlugins`, `disablePlugin`,
// `enablePlugin`, `shutdownPlugins` — and asserts what the TUI reads (the
// registry snapshot) and what a user toggling the plugin in `/extensions` sees.
// It is the compatibility gate for the conversion: the command must be
// indistinguishable from the V1 entry it replaced.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  disablePlugin,
  enablePlugin,
  listPlugins,
  shutdownPlugins,
} from "../loader";
import { getRegistrySnapshot } from "../registry";
import { contextCommandPlugin } from "./context-command";
import { __resetNativeRuntimeForTests, createNativePluginModule } from "./host";

const ID = "builtin.commands.context";

// Own config dir per test: `bootstrapPlugins` reads persisted enable/disable
// lists, and a shared dir would let one run's opt-out decide another's result.
const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
let configDir = "";

function contextCommand() {
  return getRegistrySnapshot().commands.find((command) => command.name === "/context");
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-native-boot-"));
  process.env.CODESURF_CONFIG_DIR = configDir;
  __resetPluginsForTests();
  __resetNativeRuntimeForTests();
});

afterEach(async () => {
  await shutdownPlugins();
  __resetPluginsForTests();
  __resetNativeRuntimeForTests();
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("native /context through the host loader", () => {
  it("registers into the registry the TUI reads, with the V1 identity", async () => {
    await bootstrapPlugins([createNativePluginModule(contextCommandPlugin)]);

    const command = contextCommand();
    expect(command).toBeDefined();
    expect(command?.pluginId).toBe(ID);
    expect(command?.argsHint).toBe("[compact|compress|help]");
    expect(command?.description).toContain("Show context token breakdown");

    const listed = listPlugins().find((entry) => entry.id === ID);
    expect(listed?.title).toBe("Context Inspector");
    expect(listed?.source).toBe("builtin");
    expect(listed?.protected).toBe(false);
    expect(listed?.enabled).toBe(true);
    expect(listed?.active).toBe(true);
    expect(listed?.status).toBe("active");
    // The registry counts the contribution against the plugin's extension id.
    expect(listed?.commands).toBe(1);
  });

  it("disabling removes the command through fiber disposal, and enabling restores it", async () => {
    await bootstrapPlugins([createNativePluginModule(contextCommandPlugin)]);
    expect(contextCommand()).toBeDefined();

    await disablePlugin(ID);
    // The registry entry is gone because the fiber's effect disposer ran, not
    // because the loader swept the extension id.
    expect(contextCommand()).toBeUndefined();
    expect(listPlugins().find((entry) => entry.id === ID)?.status).toBe("inactive");

    await enablePlugin(ID);
    expect(contextCommand()).toBeDefined();
    expect(listPlugins().find((entry) => entry.id === ID)?.status).toBe("active");

    // A second cycle proves remount is repeatable, not a one-shot.
    await disablePlugin(ID);
    expect(contextCommand()).toBeUndefined();
    await enablePlugin(ID);
    expect(contextCommand()).toBeDefined();
  });

  it("shutdown removes the command and disposes the root", async () => {
    await bootstrapPlugins([createNativePluginModule(contextCommandPlugin)]);
    expect(contextCommand()).toBeDefined();

    await shutdownPlugins();
    expect(contextCommand()).toBeUndefined();
    // `shutdownPlugins` deactivates instances but leaves the registry's
    // records for the listing UI; what matters is that the contribution is
    // gone and the entry no longer claims to be active.
    expect(listPlugins().find((entry) => entry.id === ID)?.active).toBe(false);
  });

  it("is present in the shipped built-in catalog exactly once", async () => {
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const modules = await loadBuiltinPlugins();
    const entries = modules.filter((module) => module.manifest.id === ID);
    expect(entries).toHaveLength(1);
    // The catalog entry is the native module, so no V1 `activate(api)` path
    // remains for this command.
    expect(entries[0]?.manifest.kind).toBe("builtin");
  });
});
