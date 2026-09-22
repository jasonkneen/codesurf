// Enable/disable churn across the whole catalog (plan phase 5).
//
// The conversion shipped a twelve-site disposer leak: `api.onDispose(fn)` became
// `ctx.effect(() => () => fn)`, whose disposer names `fn` and never calls it.
// Per-plugin regression tests cover four of the five plugins that had it — this
// test found the fifth. voice.ts used the ASYNC variant,
// `ctx.effect(async () => () => fn)`, which the regex that fixed the sync form
// did not match, and nothing behavioural exposed it because those handlers are
// idempotent. The leak class is structural — any plugin can subscribe to
// something and fail to release it — so this is the systematic check the
// per-plugin tests are not.
//
// The assertion is a return to baseline, not an absolute number: boot, record
// what the registry and the agent event bus hold, then churn every non-protected
// plugin off and on repeatedly and require both to come back to exactly that.
// Anything that accumulates — a listener, a command, a setting, a model — moves
// one of these counts and fails here regardless of which plugin caused it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_EVENTS } from "../../../hooks/types";
import { loadBuiltinPlugins } from "../builtin/index";
import { __agentEventListenerCountForTests } from "../event-bus";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  disablePlugin,
  enablePlugin,
  listPlugins,
  shutdownPlugins,
} from "../loader";
import { getRegistrySnapshot } from "../registry";
import { __resetNativeRuntimeForTests } from "./host";

const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
let configDir = "";

/** Everything a leaked registration or subscription would move. */
function fingerprint() {
  const snapshot = getRegistrySnapshot();
  return {
    commands: snapshot.commands.length,
    tools: snapshot.tools.length,
    models: snapshot.models.length,
    providers: snapshot.modelProviders.length,
    settings: snapshot.settings.length,
    screens: snapshot.screens.length,
    indicators: snapshot.statusIndicators.length,
    listeners: Object.fromEntries(HOOK_EVENTS.map((event) => [event, __agentEventListenerCountForTests(event)])),
  };
}

/**
 * Wait until the fingerprint stops changing.
 *
 * `await fiber` resolves once `apply` has run, but an ASYNC `ctx.effect` inside
 * apply settles after that — a plugin that mounts a child and republishes what
 * it registered (the deepseek-harness adapters do) therefore lands its
 * contributions just after bootstrap returns. Sampling immediately raced that
 * and read a baseline that churn then legitimately exceeded.
 */
async function settledFingerprint(): Promise<ReturnType<typeof fingerprint>> {
  let previous = JSON.stringify(fingerprint());
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = JSON.stringify(fingerprint());
    if (current === previous) return fingerprint();
    previous = current;
  }
  return fingerprint();
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-catalog-churn-"));
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

describe("catalog enable/disable churn", () => {
  it("returns every registry count and event listener to baseline after repeated churn", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const baseline = await settledFingerprint();
    // Sanity: the catalog really did register something, so a passing test
    // cannot be "nothing was ever there".
    expect(baseline.commands).toBeGreaterThan(0);
    expect(baseline.tools).toBeGreaterThan(0);

    // Protected plugins cannot be disabled through this path; churn the rest.
    const churnable = listPlugins()
      .filter((entry) => entry.enabled && !entry.protected)
      .map((entry) => entry.id);
    expect(churnable.length).toBeGreaterThan(0);

    for (let round = 0; round < 3; round += 1) {
      for (const id of churnable) await disablePlugin(id);
      for (const id of churnable) await enablePlugin(id);
    }

    expect(await settledFingerprint()).toEqual(baseline);
  }, 60_000);

  it("leaves nothing behind once every plugin is disabled", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());

    const churnable = listPlugins()
      .filter((entry) => entry.enabled && !entry.protected)
      .map((entry) => entry.id);
    for (const id of churnable) await disablePlugin(id);

    // Whatever remains must belong to a still-enabled (protected) plugin —
    // never to one that is now off.
    const disabled = new Set(churnable);
    const snapshot = getRegistrySnapshot();
    const orphans = [
      ...snapshot.commands.map((c) => c.pluginId),
      ...snapshot.tools.map((t) => t.pluginId),
      ...snapshot.settings.map((s) => s.pluginId),
      ...snapshot.models.map((m) => m.pluginId),
      ...snapshot.statusIndicators.map((i) => i.pluginId),
      ...snapshot.screens.map((s) => s.pluginId),
    ].filter((id) => disabled.has(id));

    expect([...new Set(orphans)]).toEqual([]);
  }, 60_000);
});
