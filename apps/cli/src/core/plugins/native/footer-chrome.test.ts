// Footer chrome through the host loader.
//
// Ported from the V1 suite, but deliberately NOT a like-for-like port. The V1
// stub reimplemented `registerToggleableIndicator`'s expansion itself — the
// settings defaulting, the OR-then-flip, the toast text — so the toggle
// assertions tested the stub's copy of that logic, not the host's. Booting
// through `bootstrapPlugins` tests the real bridge expansion, which no
// plugin had exercised before this conversion.
//
// The pure-function suites below are unchanged.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeFilledCells, formatContextBarSegments } from "../builtin/footer-chrome/context-bar-indicator";
import { __resetPluginsForTests, bootstrapPlugins, getHostServices, shutdownPlugins } from "../loader";
import { getRegistrySnapshot } from "../registry";
import { setToastSink } from "../sinks";
import { footerChromePlugin } from "./footer-chrome";
import { __resetNativeRuntimeForTests, createNativePluginModule } from "./host";

const CONTEXT_BAR_KEYS = ["contextBar.show.bar", "contextBar.show.percent", "contextBar.show.tokens"];
const COUNTER_KEYS = ["resourceCounter.show.extensions", "resourceCounter.show.commands", "resourceCounter.show.tools"];

const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
let configDir = "";

async function boot() {
  await bootstrapPlugins([createNativePluginModule(footerChromePlugin)]);
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-footer-chrome-"));
  process.env.CODESURF_CONFIG_DIR = configDir;
  __resetPluginsForTests();
  __resetNativeRuntimeForTests();
});

afterEach(async () => {
  await shutdownPlugins();
  setToastSink(null);
  __resetPluginsForTests();
  __resetNativeRuntimeForTests();
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("builtin.footer-chrome through the host loader", () => {
  it("declares the V1 manifest identity that persisted enable state is keyed by", () => {
    const m = footerChromePlugin.manifest;
    expect(m.id).toBe("builtin.footer-chrome");
    expect(m.enabledByDefault).toBe(true);
    expect(m.capabilities).toEqual(expect.arrayContaining(["commands", "settings"]));
  });

  it("registers both footer indicators with their placements", async () => {
    await boot();
    const indicators = getRegistrySnapshot().statusIndicators;

    expect(indicators.find((i) => i.id === "context-bar.usage")?.placement).toBe("mode-line");
    expect(indicators.find((i) => i.id === "resource-counter.counts")?.placement).toBe("mode-line-left");
  });

  it("registers both slash commands into the registry the TUI reads", async () => {
    await boot();
    const commands = getRegistrySnapshot().commands;

    for (const name of ["/context-bar", "/resource-counter"]) {
      const command = commands.find((c) => c.name === name);
      expect(command).toBeDefined();
      expect(command?.pluginId).toBe("builtin.footer-chrome");
    }
  });

  it("expands all six visibility settings as booleans defaulting true", async () => {
    await boot();
    const settings = getRegistrySnapshot().settings.filter((s) => s.pluginId === "builtin.footer-chrome");

    expect(settings.map((s) => s.key).sort()).toEqual([...CONTEXT_BAR_KEYS, ...COUNTER_KEYS].sort());
    for (const setting of settings) {
      expect(setting.type).toBe("boolean");
      expect(setting.default).toBe(true);
    }
  });

  it("/context-bar flips only the contextBar.* flags, and toasts what it did", async () => {
    const toasts: Array<{ title?: string }> = [];
    setToastSink((toast) => toasts.push(toast));
    await boot();

    const services = getHostServices();
    const resolution = services.commands.resolveInput("/context-bar");
    expect(resolution?.command.name).toBe("/context-bar");
    await Promise.resolve(resolution?.command.handler({ args: "", services }));

    // All three were true (the registered default), so one press turns the
    // whole chip off.
    for (const key of CONTEXT_BAR_KEYS) expect(services.settings.get<boolean>(key)).toBe(false);
    // The other chip's flags are a separate toggle group.
    for (const key of COUNTER_KEYS) expect(services.settings.get<boolean>(key, true)).toBe(true);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toContain("Context bar");
  });

  it("/context-bar toggles back on from the all-off state", async () => {
    await boot();
    const services = getHostServices();
    const press = async () => {
      const resolution = services.commands.resolveInput("/context-bar");
      await Promise.resolve(resolution?.command.handler({ args: "", services }));
    };

    await press();
    await press();

    for (const key of CONTEXT_BAR_KEYS) expect(services.settings.get<boolean>(key)).toBe(true);
  });

  it("releases its commands, settings and indicators on shutdown", async () => {
    await boot();
    await shutdownPlugins();

    const snapshot = getRegistrySnapshot();
    expect(snapshot.commands.filter((c) => c.pluginId === "builtin.footer-chrome")).toEqual([]);
    expect(snapshot.settings.filter((s) => s.pluginId === "builtin.footer-chrome")).toEqual([]);
    expect(snapshot.statusIndicators.filter((i) => i.pluginId === "builtin.footer-chrome")).toEqual([]);
  });
});

describe("formatContextBarSegments", () => {
  it("uses terminal-safe fallback block glyphs", () => {
    expect(formatContextBarSegments(3, 5)).toEqual({
      filledStr: "███",
      emptyStr: "░░",
    });
  });

  it("uses Nerd Font progress glyphs when provided", () => {
    expect(formatContextBarSegments(2, 4, { full: "", empty: "" })).toEqual({
      filledStr: "",
      emptyStr: "",
    });
  });
});

describe("computeFilledCells", () => {
  it("shows zero cells only at exactly 0% usage", () => {
    expect(computeFilledCells(0, 10)).toBe(0);
  });

  it("shows at least one pip the moment usage is non-zero", () => {
    // round(0.001 * 10) = 0, but any non-zero usage must light one pip.
    expect(computeFilledCells(0.001, 10)).toBe(1);
    expect(computeFilledCells(0.03, 10)).toBe(1); // the 3% screenshot case
    expect(computeFilledCells(0.04, 10)).toBe(1);
  });

  it("rounds proportionally above the first pip", () => {
    expect(computeFilledCells(0.05, 10)).toBe(1); // round(0.5) = 0 → clamped to 1
    expect(computeFilledCells(0.5, 10)).toBe(5);
    expect(computeFilledCells(1, 10)).toBe(10);
  });

  it("clamps out-of-range input", () => {
    expect(computeFilledCells(-0.2, 10)).toBe(0);
    expect(computeFilledCells(1.5, 10)).toBe(10);
  });
});
