// Regression tests for extension disposal ordering (Cordis plan, P1
// "Disposal is synchronous and forward ordered").
//
// The loader must await promises returned from `api.onDispose` callbacks, run
// them in reverse registration order, isolate a failing callback from the
// rest, run each callback at most once across repeated disposal, and make a
// replacement activation wait for an in-flight teardown.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodesurfPlugin, PluginContext } from "@codesurf/plugin-api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginModule } from "./index";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  disablePlugin,
  enablePlugin,
  getHostServices,
  getRegistrySnapshot,
  shutdownPlugins,
} from "./index";
import { disposeProviderSessionsByAdapter } from "./model-runtime";
import { __setDisposeTimeoutForTests, createNativePluginModule, getNativeRoot } from "./native/host";

// Observe provider-session disposal without needing a live provider session.
// The loader reaches model-runtime through a dynamic import, which vi.mock
// also covers.
vi.mock("./model-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-runtime")>();
  return { ...actual, disposeProviderSessionsByAdapter: vi.fn(async () => {}) };
});

let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-ext-disposal-"));
  originalEnv = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalEnv;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every queued microtask and one macrotask run so pending loader steps progress. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A native Cordis plugin behind the loader's module shape.
 *
 * Disposal is what this file tests, and it now runs through Cordis effects:
 * `ctx.effect(() => cleanup)` replaces the V1 `api.onDispose(cleanup)`.
 */
function makeExtension(id: string, apply: CodesurfPlugin["apply"]): PluginModule {
  return createNativePluginModule({
    name: id,
    manifest: { id, name: id, version: "1.0.0", capabilities: ["commands"] },
    inject: ["contributions"],
    apply,
  });
}

describe("extension disposal", () => {
  it("awaits a slow async dispose callback before disablePlugin resolves", async () => {
    const gate = deferred();
    const log: string[] = [];
    await bootstrapPlugins([
      makeExtension("test.slow", (ctx: PluginContext) => {
        ctx.effect(() => async () => {
          await gate.promise;
          log.push("closed");
        });
      }),
    ]);

    let settled = false;
    const disabling = disablePlugin("test.slow").then(() => {
      settled = true;
    });
    await flush();
    await flush();
    expect(settled).toBe(false);
    expect(log).toEqual([]);
    expect(getRegistrySnapshot().extensions[0]!.status).not.toBe("inactive");

    gate.resolve();
    await disabling;
    expect(settled).toBe(true);
    expect(log).toEqual(["closed"]);
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ enabled: false, active: false, status: "inactive" });
  });

  it("awaits slow async dispose callbacks before shutdownPlugins resolves", async () => {
    const gate = deferred();
    const log: string[] = [];
    await bootstrapPlugins([
      makeExtension("test.slow-shutdown", (ctx: PluginContext) => {
        ctx.effect(() => async () => {
          await gate.promise;
          log.push("closed");
        });
      }),
    ]);

    let settled = false;
    const shutdown = shutdownPlugins().then(() => {
      settled = true;
    });
    await flush();
    await flush();
    expect(settled).toBe(false);
    expect(log).toEqual([]);

    gate.resolve();
    await shutdown;
    expect(settled).toBe(true);
    expect(log).toEqual(["closed"]);
  });

  // Disposal ordering is CORDIS's contract now, not the loader's, and it is not
  // the V1 contract. Cordis starts the disposers of separate `ctx.effect` calls
  // in reverse registration order but runs them CONCURRENTLY (`Promise.all`);
  // only disposers yielded by a single generator effect run reverse AND
  // sequentially. A plugin that needs strict sequential teardown must collect
  // them into one generator effect — that choice belongs to the plugin, which
  // knows whether its own cleanups depend on each other. The loader used to
  // impose sequencing on everyone.
  it("starts dispose callbacks in reverse registration order", async () => {
    const gate = deferred();
    const log: string[] = [];
    await bootstrapPlugins([
      makeExtension("test.order", (ctx: PluginContext) => {
        ctx.effect(() => () => {
          log.push("first");
        });
        ctx.effect(() => async () => {
          log.push("second:start");
          await gate.promise;
          log.push("second:end");
        });
        ctx.effect(() => () => {
          log.push("third");
        });
      }),
    ]);

    const disabling = disablePlugin("test.order");
    await flush();
    await flush();
    // Reverse START order — but "first" does not wait for the async "second".
    expect(log).toEqual(["third", "second:start", "first"]);

    gate.resolve();
    await disabling;
    // Every disposer ran, and the disable awaited the slow one before settling.
    expect(log).toContain("second:end");
    expect(new Set(log)).toEqual(new Set(["third", "second:start", "first", "second:end"]));
  });

  // A throwing disposer must not stop the others. Cordis reports it through its
  // own logger rather than `console.error`, so this asserts the property that
  // matters — everything else still ran and the plugin still went inactive —
  // instead of asserting where the message was printed.
  it("keeps running the remaining dispose callbacks when one throws", async () => {
    const log: string[] = [];
    await bootstrapPlugins([
      makeExtension("test.errors", (ctx: PluginContext) => {
        ctx.effect(() => () => {
          log.push("first");
        });
        ctx.effect(() => () => {
          throw new Error("sync boom");
        });
        ctx.effect(() => async () => {
          throw new Error("async boom");
        });
        ctx.effect(() => () => {
          log.push("last");
        });
      }),
    ]);

    await disablePlugin("test.errors");

    expect(log).toEqual(["last", "first"]);
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ enabled: false, active: false, status: "inactive" });
  });

  it("runs each dispose callback once across repeated disposal", async () => {
    const gate = deferred();
    let runs = 0;
    await bootstrapPlugins([
      makeExtension("test.once", (ctx: PluginContext) => {
        ctx.effect(() => async () => {
          runs += 1;
          await gate.promise;
        });
      }),
    ]);

    const first = disablePlugin("test.once");
    const second = disablePlugin("test.once");
    await flush();
    expect(runs).toBe(1);

    gate.resolve();
    await Promise.all([first, second]);
    await disablePlugin("test.once");
    await shutdownPlugins();
    expect(runs).toBe(1);
  });

  // A disable issued while `apply` is still awaiting.
  //
  // The V1 loader owned dispose callbacks, so it could run them while the
  // activation was still blocked. Cordis owns them now, and `fiber.dispose()`
  // cannot settle until the fiber does — so the disposer runs when the
  // activation finally completes, not before. What must hold regardless is that
  // the disable does not HANG on a stuck plugin, and that the disposer runs
  // exactly once when it does run.
  it("does not hang when disabled mid-activation, and disposes once afterwards", async () => {
    const activationGate = deferred();
    let runs = 0;
    const ext = makeExtension("test.stale", async (ctx: PluginContext) => {
      ctx.effect(() => () => {
        runs += 1;
      });
      await activationGate.promise;
    });

    const boot = bootstrapPlugins([ext]);
    await flush();
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ status: "activating" });

    // Bounded: this resolves even though `apply` is still parked.
    await disablePlugin("test.stale");
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ enabled: false });

    activationGate.resolve();
    await boot;
    await flush();
    await flush();

    expect(runs).toBe(1);
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ enabled: false, active: false });
    // Nothing the stale activation registered survived.
    expect(getRegistrySnapshot().commands).toEqual([]);
  });

  it("makes a re-enable during in-flight disposal wait for the previous instance to close", async () => {
    const gate = deferred();
    const log: string[] = [];
    let activations = 0;
    await bootstrapPlugins([
      makeExtension("test.reenable", (ctx: PluginContext) => {
        activations += 1;
        const generation = activations;
        ctx.contributions.registerCommand({ name: `cmd-${generation}`, description: "", handler: () => {} });
        ctx.effect(() => async () => {
          log.push(`dispose:${generation}:start`);
          await gate.promise;
          log.push(`dispose:${generation}:end`);
        });
      }),
    ]);

    const disabling = disablePlugin("test.reenable");
    await flush();
    expect(log).toEqual(["dispose:1:start"]);

    let enableSettled = false;
    const enabling = enablePlugin("test.reenable").then(() => {
      enableSettled = true;
    });
    await flush();
    await flush();
    expect(activations).toBe(1);
    expect(enableSettled).toBe(false);

    gate.resolve();
    await Promise.all([disabling, enabling]);
    expect(activations).toBe(2);
    expect(log).toEqual(["dispose:1:start", "dispose:1:end"]);
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ enabled: true, active: true, status: "active" });
    expect(getRegistrySnapshot().commands.map((c) => c.name)).toEqual(["cmd-2"]);
  });

  // A registration that lands after the user already disabled the plugin.
  //
  // `apply` awaits, the user disables, and only then does the plugin come back
  // and register. That contribution must NOT reach the registry — the V1 loader
  // guarded this with an `isCurrentActivation()` check inside every
  // registration shim, and the native bridge keeps the guard
  // (`acceptsRegistrations`). Without it a slow plugin could resurrect itself
  // after being switched off.
  it("refuses contributions registered after the plugin was disabled", async () => {
    const activationGate = deferred();
    const ext = makeExtension("test.late", async (ctx: PluginContext) => {
      await activationGate.promise;
      ctx.contributions.registerCommand({ name: "too-late", description: "Late", handler: () => {} });
    });

    const boot = bootstrapPlugins([ext]);
    await flush();
    await disablePlugin("test.late");

    activationGate.resolve();
    await boot;
    await flush();

    expect(getRegistrySnapshot().commands.map((c) => c.name)).not.toContain("too-late");
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ enabled: false, active: false });
  });

  it("shuts extensions down in reverse boot order", async () => {
    const log: string[] = [];
    await bootstrapPlugins([
      makeExtension("test.first", (ctx: PluginContext) => {
        ctx.effect(() => () => {
          log.push("first");
        });
      }),
      makeExtension("test.second", (ctx: PluginContext) => {
        ctx.effect(() => () => {
          log.push("second");
        });
      }),
    ]);

    await shutdownPlugins();
    expect(log).toEqual(["second", "first"]);
  });
});

describe("extension teardown edge cases", () => {
  afterEach(() => {
    __setDisposeTimeoutForTests();
    vi.mocked(disposeProviderSessionsByAdapter).mockClear();
  });

  // A native plugin's `deactivate` disposes its fiber, which unregisters the
  // provider before the loader clears runtime state. The adapter ids have to
  // be captured first, or the cached provider sessions outlive the disable
  // and are reused on re-enable.
  it("disposes a disabled plugin's provider sessions", async () => {
    await bootstrapPlugins([
      createNativePluginModule({
        name: "test.provider",
        manifest: { id: "test.provider", name: "test.provider", version: "1.0.0", capabilities: ["provider-adapters"] },
        inject: ["contributions"],
        apply: (ctx: PluginContext) => {
          ctx.effect(() =>
            ctx.contributions.registerModelProvider({
              id: "test.adapter",
              label: "Test adapter",
              providerId: "test",
              shape: "provider-family",
              transport: "stdio",
              connectionMode: "persistent",
              capabilities: { streaming: true },
              auth: { mode: "none" } as never,
              adapter: { connect: async () => ({}) as never },
            }),
          );
        },
      }),
    ]);
    expect(getRegistrySnapshot().modelProviders.map((p) => p.id)).toEqual(["test.adapter"]);

    await disablePlugin("test.provider");

    expect(getRegistrySnapshot().modelProviders).toEqual([]);
    expect(disposeProviderSessionsByAdapter).toHaveBeenCalledWith("test.adapter");
  });

  // A disable whose teardown timed out leaves the old fiber running. Once a
  // re-enable mounts a new generation, the old one's late registrations and
  // late disposers must not touch the new one's contributions.
  it("keeps a timed-out generation from clobbering the re-enabled one", async () => {
    __setDisposeTimeoutForTests(20);
    const gate = deferred();
    let activations = 0;
    const ext = makeExtension("test.stale-gen", async (ctx: PluginContext) => {
      activations += 1;
      const generation = activations;
      ctx.effect(() =>
        ctx.contributions.registerCommand({ name: "shared", description: `gen ${generation}`, handler: () => {} }),
      );
      if (generation === 1) {
        await gate.promise;
        ctx.contributions.registerCommand({ name: "too-late", description: "Late", handler: () => {} });
        ctx.contributions.registerPromptSection({ id: "too-late", title: "Late", body: "Late" });
      }
    });

    const boot = bootstrapPlugins([ext]);
    await flush();
    // Bounded by the dispose timeout: generation 1 is still parked in apply.
    await disablePlugin("test.stale-gen");
    await enablePlugin("test.stale-gen");
    expect(activations).toBe(2);
    expect(getRegistrySnapshot().commands.map((c) => c.description)).toEqual(["gen 2"]);

    // Generation 1 wakes up, registers late, then finally disposes.
    gate.resolve();
    await boot;
    for (let i = 0; i < 5; i++) await flush();

    const snapshot = getRegistrySnapshot();
    expect(snapshot.commands.map((c) => c.description)).toEqual(["gen 2"]);
    expect(snapshot.promptSections.map((s) => s.id)).not.toContain("too-late");
    expect(snapshot.extensions[0]).toMatchObject({ enabled: true, active: true, status: "active" });
  });

  it("refuses a prompt section registered after the plugin was disabled", async () => {
    __setDisposeTimeoutForTests(20);
    const gate = deferred();
    const ext = makeExtension("test.late-section", async (ctx: PluginContext) => {
      await gate.promise;
      ctx.contributions.registerPromptSection({ id: "late-section", title: "Late", body: "Late" });
    });

    const boot = bootstrapPlugins([ext]);
    await flush();
    await disablePlugin("test.late-section");
    gate.resolve();
    await boot;
    await flush();

    expect(getRegistrySnapshot().promptSections.map((s) => s.id)).not.toContain("late-section");
  });

  // Cordis leaves a fiber whose `apply` threw on the root in the FAILED
  // state, where a later service change can restart it behind the loader's
  // back. The bridge must dispose it for good and still report the failure.
  it("disposes a failed activation's fiber and reports the plugin failed", async () => {
    const log: string[] = [];
    const runtimesBefore = getNativeRoot().registry.size;
    await bootstrapPlugins([
      makeExtension("test.fails", async (ctx: PluginContext) => {
        ctx.effect(() => () => {
          log.push("disposed");
        });
        await Promise.resolve();
        throw new Error("apply exploded");
      }),
    ]);

    expect(getRegistrySnapshot().extensions[0]).toMatchObject({
      active: false,
      status: "failed",
      error: "apply exploded",
    });
    expect(log).toEqual(["disposed"]);
    expect(getNativeRoot().registry.size).toBe(runtimesBefore);
  });

  // Icon packs are last-bind-wins. An older owner disabled after a newer one
  // bound must not clear the newer resolver on its way out.
  it("does not clear a newer icon resolver when an older owner is disabled", async () => {
    const iconPack = (id: string, glyph: string) =>
      createNativePluginModule({
        name: id,
        manifest: { id, name: id, version: "1.0.0", capabilities: [] },
        inject: ["sinks"],
        apply: (ctx: PluginContext) => {
          ctx.effect(() => ctx.sinks.bind({ icons: () => glyph }));
        },
      });
    await bootstrapPlugins([iconPack("test.icons-a", "A"), iconPack("test.icons-b", "B")]);
    expect(getHostServices().icons.resolve("x")).toBe("B");

    await disablePlugin("test.icons-a");

    expect(getHostServices().icons.resolve("x")).toBe("B");
    await disablePlugin("test.icons-b");
    expect(getHostServices().icons.resolve("x")).toBe("");
  });
});
