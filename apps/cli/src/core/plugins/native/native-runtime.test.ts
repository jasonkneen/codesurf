// Phase 1 acceptance for the native Cordis runtime.
//
// Covers the scenarios the migration plan names for the first slice: mount,
// unmount, remount, a missing injected dependency, an `apply` that throws,
// awaited async disposal, and two-root isolation. These run against the real
// `@deepseek-ai/cordis` fiber lifecycle — nothing here is a stand-in.

import type { CodesurfPlugin, CommandSpec, PluginManifest } from "@codesurf/plugin-api";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { describe, expect, it, vi } from "vitest";
import { contextCommandPlugin } from "./context-command";

const FiberState = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4 } as const;

const manifest: PluginManifest = {
  id: "test.plugin",
  name: "Test Plugin",
  version: "1.0.0",
  enabledByDefault: true,
  capabilities: ["commands"],
};

function makePlugin(overrides: Partial<CodesurfPlugin> = {}, log: string[] = []): CodesurfPlugin {
  return {
    name: "test-plugin",
    manifest,
    inject: ["contributions"],
    apply(ctx) {
      log.push("apply");
      ctx.effect(() => {
        const off = ctx.contributions.registerCommand({
          name: "/test",
          description: "test command",
          handler: () => {},
        });
        log.push("register");
        return async () => {
          // A real async teardown: disposal must await this before resolving.
          await new Promise((resolve) => setTimeout(resolve, 20));
          off();
          log.push("unregister");
        };
      });
    },
    ...overrides,
  };
}

describe("native Cordis runtime — plugin lifecycle", () => {
  it("mounts a plugin, registers its contribution, and unmounts it again", async () => {
    const log: string[] = [];
    const root = createCodesurfRoot();
    const fiber = mountPlugin(root, makePlugin({}, log));

    await fiber;
    expect(fiber.state).toBe(FiberState.ACTIVE);
    expect(root.contributions.listCommands().map((c) => c.name)).toEqual(["/test"]);
    expect(log).toEqual(["apply", "register"]);

    await fiber.dispose();
    expect(fiber.state).toBe(FiberState.DISPOSED);
    expect(root.contributions.listCommands()).toEqual([]);
    expect(log).toEqual(["apply", "register", "unregister"]);
  });

  it("awaits an async disposer before disposal resolves", async () => {
    const log: string[] = [];
    const root = createCodesurfRoot();
    const fiber = mountPlugin(root, makePlugin({}, log));
    await fiber;

    const pending = fiber.dispose();
    // Synchronously after dispose() the async teardown has not run yet, so the
    // contribution is still present — the point of awaiting.
    expect(root.contributions.listCommands()).toHaveLength(1);
    expect(log).not.toContain("unregister");

    await pending;
    expect(log).toContain("unregister");
    expect(root.contributions.listCommands()).toEqual([]);
  });

  it("remounts after disposal with a fresh runtime record", async () => {
    const log: string[] = [];
    const root = createCodesurfRoot();
    const plugin = makePlugin({}, log);

    const first = mountPlugin(root, plugin);
    await first;
    const firstUid = first.uid;
    await first.dispose();
    expect(root.contributions.listCommands()).toEqual([]);

    const second = mountPlugin(root, plugin);
    await second;
    expect(second.uid).not.toBe(firstUid);
    expect(root.contributions.listCommands().map((c) => c.name)).toEqual(["/test"]);
    expect(log).toEqual(["apply", "register", "unregister", "apply", "register"]);

    await second.dispose();
  });

  it("does not run a plugin whose injected service is missing, and runs it once provided", async () => {
    const root = createCodesurfRoot();
    let applied = 0;
    const fiber = mountPlugin(root, {
      name: "needs-missing",
      manifest: { ...manifest, id: "test.needs-missing" },
      inject: ["contributions", "somethingAbsent"],
      apply() {
        applied += 1;
      },
    });

    await fiber;
    expect(applied).toBe(0);
    expect(fiber.state).toBe(FiberState.PENDING);

    const unprovide = root.provide("somethingAbsent", { ok: true });
    await fiber;
    expect(applied).toBe(1);
    expect(fiber.state).toBe(FiberState.ACTIVE);

    // Removing the dependency unloads the dependent again.
    await unprovide();
    await fiber;
    expect(fiber.state).toBe(FiberState.PENDING);
    await fiber.dispose();
  });

  it("surfaces a throwing apply as a failed fiber and leaves the root usable", async () => {
    const root = createCodesurfRoot();
    const fiber = mountPlugin(root, {
      name: "boom",
      manifest: { ...manifest, id: "test.boom" },
      apply() {
        throw new Error("apply exploded");
      },
    });

    await expect(fiber).rejects.toThrow("apply exploded");
    expect(fiber.state).toBe(FiberState.FAILED);

    // The root still works: a healthy plugin mounts afterwards.
    const healthy = mountPlugin(root, makePlugin());
    await healthy;
    expect(root.contributions.listCommands()).toHaveLength(1);
    await healthy.dispose();
    await fiber.dispose();
  });

  it("keeps two roots isolated: services, contributions and teardown", async () => {
    const rootA = createCodesurfRoot();
    const rootB = createCodesurfRoot();
    expect(rootA.get("contributions")).not.toBe(rootB.get("contributions"));

    const fiberA = mountPlugin(rootA, makePlugin());
    await fiberA;
    expect(rootA.contributions.listCommands()).toHaveLength(1);
    expect(rootB.contributions.listCommands()).toEqual([]);

    await fiberA.dispose();
    expect(rootA.contributions.listCommands()).toEqual([]);
    // B was never touched by A's lifecycle.
    const fiberB = mountPlugin(rootB, makePlugin());
    await fiberB;
    expect(rootB.contributions.listCommands()).toHaveLength(1);
    expect(rootA.contributions.listCommands()).toEqual([]);
    await fiberB.dispose();
  });

  it("mirrors registrations into the host and releases them on disposal", async () => {
    const registered: Array<{ spec: CommandSpec; manifest: PluginManifest }> = [];
    const release = vi.fn();
    const bindings: HostBindings = {
      registerCommand: (spec, pluginManifest) => {
        registered.push({ spec, manifest: pluginManifest });
        return release;
      },
    };
    const root = createCodesurfRoot(bindings);
    const fiber = mountPlugin(root, makePlugin());
    await fiber;

    // The manifest travels with the registration so the host can attribute it.
    expect(registered).toHaveLength(1);
    expect(registered[0]?.manifest.id).toBe("test.plugin");
    expect(release).not.toHaveBeenCalled();

    await fiber.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("native Cordis runtime — the converted /context command", () => {
  function bootContextRoot(overrides: Partial<HostBindings> = {}): {
    root: Context;
    appended: string[];
  } {
    const appended: string[] = [];
    const root = createCodesurfRoot({
      appendAssistant: (text) => appended.push(text),
      ...overrides,
    });
    return { root, appended };
  }

  it("keeps the V1 command identity", async () => {
    const { root } = bootContextRoot();
    const fiber = mountPlugin(root, contextCommandPlugin);
    await fiber;

    const command = root.contributions.listCommands()[0];
    expect(command?.name).toBe("/context");
    expect(command?.argsHint).toBe("[compact|compress|help]");
    expect(contextCommandPlugin.manifest.id).toBe("builtin.commands.context");
    expect(contextCommandPlugin.manifest.enabledByDefault).toBe(true);
    expect(contextCommandPlugin.manifest.protected).toBe(false);
    expect(contextCommandPlugin.manifest.capabilities).toEqual(["commands"]);
    await fiber.dispose();
  });

  it("prints the breakdown, compacts on request, and explains bad arguments", async () => {
    const compact = vi.fn(async () => ({ compacted: true, message: "compacted 12 turns" }));
    const { root, appended } = bootContextRoot({
      compactContext: compact,
      getContextBreakdown: () => ({
        usedTokens: 1000,
        contextWindow: 4000,
        remainingTokens: 3000,
        ratioUsed: 0.25,
        ratioRemaining: 0.75,
        systemTokens: 100,
        inFlightTokens: 50,
        compactionSummaryTokens: 200,
        historyTokens: 650,
      }),
    });
    const fiber = mountPlugin(root, contextCommandPlugin);
    await fiber;
    const command = root.contributions.listCommands()[0];
    if (!command) throw new Error("command not registered");

    await command.handler({ args: "" });
    expect(appended[0]).toContain("Context window usage: 1,000 / 4,000 tokens (25.0%)");
    expect(appended[0]).toContain("Compaction summary: ~200");

    await command.handler({ args: "compact" });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(appended[1]).toBe("compacted 12 turns");

    await command.handler({ args: "nonsense" });
    expect(appended[2]).toContain('Unknown /context argument: "nonsense"');

    await command.handler({ args: "help" });
    expect(appended[3]).toContain("/context compact   Force manual compaction now");

    await fiber.dispose();
  });

  it("reports missing stats instead of throwing", async () => {
    const { root, appended } = bootContextRoot({ getContextBreakdown: () => null });
    const fiber = mountPlugin(root, contextCommandPlugin);
    await fiber;
    const command = root.contributions.listCommands()[0];
    await command?.handler({ args: "" });
    expect(appended[0]).toBe("No active session or context stats not available yet. Send a message first.");
    await fiber.dispose();
  });
});
