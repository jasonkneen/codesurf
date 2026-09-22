// The UI-side plugin catalog, through the host loader.
//
// These two were the last V1 `PluginModule`s in the tree and had no tests at
// all. They are also the reason the compatibility gate used during the
// conversion was checking a subset of production: it booted
// `loadBuiltinPlugins()` only, while `src/index.ts` boots that catalog PLUS
// this one. So this file asserts the production boot — both catalogs together —
// and not just the half that was previously measured.
//
// The screen ids are the contract: `host-action-dispatch.ts` fires
// `open-screen` with them, so a rename here silently breaks the wallet and
// sandbox pickers with nothing failing to compile.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBuiltinPlugins } from "../../core/plugins/builtin/index";
import { __resetPluginsForTests, bootstrapPlugins, listPlugins, shutdownPlugins } from "../../core/plugins/loader";
import { __resetNativeRuntimeForTests } from "../../core/plugins/native/host";
import { getRegistrySnapshot } from "../../core/plugins/registry";
import { loadBuiltinUiPlugins, SANDBOX_SCREEN_ID, WALLET_SCREEN_ID } from "./index";
import { sandboxScreenPlugin } from "./sandbox-screen";
import { walletScreenPlugin } from "./wallet-screen";

const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
let configDir = "";

/** Exactly what `src/index.ts` boots. */
async function bootProductionCatalog() {
  await bootstrapPlugins([...(await loadBuiltinPlugins()), ...(await loadBuiltinUiPlugins())]);
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-ui-screens-"));
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

describe("UI screen plugins", () => {
  it("keeps the manifest identity persisted enable state is keyed by", () => {
    expect(walletScreenPlugin.manifest.id).toBe("builtin.screens.wallet");
    expect(sandboxScreenPlugin.manifest.id).toBe("builtin.screens.sandbox");

    for (const plugin of [walletScreenPlugin, sandboxScreenPlugin]) {
      // Protected and hidden: the host drives these, so a user must not be able
      // to disable them from /extensions and strand the picker.
      expect(plugin.manifest.protected).toBe(true);
      expect(plugin.manifest.hidden).toBe(true);
      expect(plugin.manifest.enabledByDefault).toBe(true);
      expect(plugin.manifest.capabilities).toEqual(["screens"]);
    }
  });

  it("registers both screens under the ids the host fires open-screen with", async () => {
    await bootProductionCatalog();
    const screens = getRegistrySnapshot().screens;

    const wallet = screens.find((s) => s.id === WALLET_SCREEN_ID);
    expect(wallet?.pluginId).toBe("builtin.screens.wallet");
    expect(wallet?.label).toBe("Wallet & Payments");

    const sandbox = screens.find((s) => s.id === SANDBOX_SCREEN_ID);
    expect(sandbox?.pluginId).toBe("builtin.screens.sandbox");
    expect(sandbox?.label).toBe("Sandbox settings");
  });

  it("boots the full production catalog with nothing failed", async () => {
    await bootProductionCatalog();
    const list = listPlugins();

    // 48 core + claude-plugins + 2 UI + 4 external harness plugins. A total, so
    // adding to either catalog without updating the gate is visible here.
    expect(list).toHaveLength(55);
    expect(list.filter((entry) => entry.status === "failed")).toEqual([]);
    // The 4 harness plugins and the /pets-arch explainer ship disabled.
    expect(list.filter((entry) => entry.status === "active")).toHaveLength(38);
  });

  it("releases both screens on shutdown", async () => {
    await bootProductionCatalog();
    expect(getRegistrySnapshot().screens).toHaveLength(8);

    await shutdownPlugins();

    const remaining = getRegistrySnapshot().screens.map((s) => s.id);
    expect(remaining).not.toContain(WALLET_SCREEN_ID);
    expect(remaining).not.toContain(SANDBOX_SCREEN_ID);
  });
});
