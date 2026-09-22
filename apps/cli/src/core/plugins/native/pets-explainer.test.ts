// Parity acceptance for the converted `/pets-arch` plugin.
//
// The V1 builtin was a documentation surface with exactly two branches: open
// the doc-viewer screen, or explain that it is unavailable. This file mounts
// the native plugin on its own root with fake `HostBindings` and pins the
// command identity, both branches' user-visible output, and that disposing the
// fiber actually releases the contribution — the things a user would notice if
// the conversion drifted.

import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { describe, expect, it, vi } from "vitest";
import { PETS_ARCH_DOC } from "../builtin/pets-arch-doc";
import { petsExplainerPlugin } from "./pets-explainer";

const ID = "builtin.commands.pets-explainer";

type Screen = { id: string; label?: string; pluginId: string };

function bootRoot(screens: Screen[]): {
  root: Context;
  appended: string[];
  actions: Array<Record<string, unknown>>;
} {
  const appended: string[] = [];
  const actions: Array<Record<string, unknown>> = [];
  const root = createCodesurfRoot({
    appendAssistant: (text) => appended.push(text),
    ui: {
      action: (payload) => actions.push(payload),
      terminalSize: () => ({ columns: 80, rows: 24 }),
      screens: { list: () => screens },
    },
  });
  return { root, appended, actions };
}

const DOC_VIEWER_SCREEN: Screen = { id: "screen.doc-viewer", pluginId: "builtin.ui.doc-viewer" };

describe("native /pets-arch — manifest identity", () => {
  it("carries the V1 manifest byte-for-byte", () => {
    expect(petsExplainerPlugin.manifest.id).toBe(ID);
    expect(petsExplainerPlugin.manifest.name).toBe("Codex /pets Architecture Explainer");
    expect(petsExplainerPlugin.manifest.version).toBe("1.0.0");
    expect(petsExplainerPlugin.manifest.description).toBe(
      "Slash command `/pets-arch` opens a read-only explainer of how the upstream Codex Rust TUI implements `/pets`. Rendered via the generic `doc-viewer` builtin.",
    );
    // Off by default since 2026-09-22: a developer explainer, opted into from /plugins.
    expect(petsExplainerPlugin.manifest.enabledByDefault).toBe(false);
    expect(petsExplainerPlugin.manifest.protected).toBe(false);
    expect(petsExplainerPlugin.manifest.capabilities).toEqual(["commands"]);
    // V1 declared neither, and adding either would change `/extensions`.
    expect(petsExplainerPlugin.manifest.hidden).toBeUndefined();
    expect(petsExplainerPlugin.manifest.group).toBeUndefined();
  });
});

describe("native /pets-arch — command identity", () => {
  it("registers exactly the V1 command", async () => {
    const { root } = bootRoot([DOC_VIEWER_SCREEN]);
    const fiber = mountPlugin(root, petsExplainerPlugin);
    await fiber;

    const commands = root.contributions.listCommands();
    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command?.name).toBe("/pets-arch");
    expect(command?.description).toBe("Open the Codex /pets architecture explainer (read-only overlay).");
    // V1 had no argument surface; the slash menu must not grow one.
    expect(command?.argsHint).toBeUndefined();
    expect(command?.aliases).toBeUndefined();

    await fiber.dispose();
  });
});

describe("native /pets-arch — behaviour", () => {
  it("opens the doc-viewer screen with the unchanged doc payload", async () => {
    const { root, appended, actions } = bootRoot([
      { id: "screen.something-else", pluginId: "builtin.ui.other" },
      DOC_VIEWER_SCREEN,
    ]);
    const fiber = mountPlugin(root, petsExplainerPlugin);
    await fiber;

    const command = root.contributions.listCommands()[0];
    if (!command) throw new Error("command not registered");
    await command.handler({ args: "" });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("open-screen");
    expect(actions[0]?.id).toBe("screen.doc-viewer");
    // Identity, not a structural copy: the screen receives the same doc object.
    expect(actions[0]?.props).toBe(PETS_ARCH_DOC);
    expect(appended).toEqual([]);

    await fiber.dispose();
  });

  it("ignores arguments, exactly as V1 did", async () => {
    const { root, actions } = bootRoot([DOC_VIEWER_SCREEN]);
    const fiber = mountPlugin(root, petsExplainerPlugin);
    await fiber;

    const command = root.contributions.listCommands()[0];
    await command?.handler({ args: "anything at all" });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.id).toBe("screen.doc-viewer");

    await fiber.dispose();
  });

  it("explains that the doc viewer is unavailable when no screen is registered", async () => {
    const { root, appended, actions } = bootRoot([]);
    const fiber = mountPlugin(root, petsExplainerPlugin);
    await fiber;

    const command = root.contributions.listCommands()[0];
    await command?.handler({ args: "" });

    expect(appended).toEqual(["Doc viewer is unavailable — enable the doc-viewer extension to view this."]);
    expect(actions).toEqual([]);

    await fiber.dispose();
  });

  it("does not fall back to an unrelated screen", async () => {
    const { root, appended, actions } = bootRoot([{ id: "screen.doc-viewer-v2", pluginId: "builtin.ui.other" }]);
    const fiber = mountPlugin(root, petsExplainerPlugin);
    await fiber;

    const command = root.contributions.listCommands()[0];
    await command?.handler({ args: "" });

    expect(appended).toEqual(["Doc viewer is unavailable — enable the doc-viewer extension to view this."]);
    expect(actions).toEqual([]);

    await fiber.dispose();
  });
});

describe("native /pets-arch — lifecycle", () => {
  it("releases the host registration when the fiber is disposed", async () => {
    const release = vi.fn();
    const registered: Array<{ name: string; pluginId: string }> = [];
    const bindings: HostBindings = {
      registerCommand: (spec, pluginManifest) => {
        registered.push({ name: spec.name, pluginId: pluginManifest.id });
        return release;
      },
      ui: {
        action: () => {},
        terminalSize: () => ({ columns: 80, rows: 24 }),
        screens: { list: () => [DOC_VIEWER_SCREEN] },
      },
    };
    const root = createCodesurfRoot(bindings);
    const fiber = mountPlugin(root, petsExplainerPlugin);
    await fiber;

    expect(registered).toEqual([{ name: "/pets-arch", pluginId: ID }]);
    expect(release).not.toHaveBeenCalled();
    expect(root.contributions.listCommands()).toHaveLength(1);

    await fiber.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(root.contributions.listCommands()).toEqual([]);
  });
});

describe("native /pets-arch — shipped catalog", () => {
  // Importing the catalog pulls in every builtin's module graph; the default
  // 5s budget is not enough for that cold transform on a loaded machine.
  it("is present in the built-in catalog exactly once, as the native module", async () => {
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const modules = await loadBuiltinPlugins();
    const entries = modules.filter((module) => module.manifest.id === ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.manifest.kind).toBe("builtin");
    expect(entries[0]?.manifest.name).toBe("Codex /pets Architecture Explainer");
    expect(entries[0]?.manifest.enabledByDefault).toBe(false);
    expect(entries[0]?.manifest.protected).toBe(false);
    expect(entries[0]?.manifest.capabilities).toEqual(["commands"]);
  }, 60_000);
});
