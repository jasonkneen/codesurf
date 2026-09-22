// Smoke tests for the computer-tools extension.
//
// Phase 2 #4 migration of the kernel-extensibility plan. Verifies that the
// 12 macOS desktop-automation tools register correctly with the kernel and
// honor the `modes: ["agent"]` filter.
//
// We don't actually invoke any of the underlying agent-desktop subprocesses
// here — that requires a host with macOS accessibility entitlements. The
// goal is the registration shape, the mode metadata, and the filter
// integration with `setKernelMode`.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  EXTENSIONS_V1_API_VERSION,
  getEnabledToolSet,
  getRegistrySnapshot,
  setKernelMode,
} from "../index";
import { computerToolsPlugin } from "./computer-tools";
import { createNativePluginModule } from "./host";

let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-computer-test-"));
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

const EXPECTED_TOOL_NAMES = [
  "computer_click",
  "computer_focus_window",
  "computer_get",
  "computer_launch",
  "computer_list_windows",
  "computer_mouse_move",
  "computer_press",
  "computer_screenshot",
  "computer_scroll",
  "computer_snapshot",
  "computer_type",
  "computer_wait",
];

describe("computer-tools extension", () => {
  it("declares the expected manifest shape", () => {
    expect(computerToolsPlugin.manifest.id).toBe("builtin.tools.computer");
    // The loader-facing fields are supplied by the adapter, so assert them on
    // the adapted module rather than the plugin's own manifest.
    const adapted = createNativePluginModule(computerToolsPlugin);
    expect(adapted.manifest.kind).toBe("builtin");
    expect(adapted.manifest.hostApiVersion).toBe(EXTENSIONS_V1_API_VERSION);
    expect(adapted.manifest.capabilities).toContain("tools");
  });

  it("registers all 12 computer_* tools as kernel-owned with mode=agent", async () => {
    await bootstrapPlugins([createNativePluginModule(computerToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const toolNames = snapshot.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(EXPECTED_TOOL_NAMES);

    for (const entry of snapshot.tools) {
      // Each must be fully kernel-owned (has an ai-sdk tool def).
      expect(entry.tool, `${entry.name} should have a tool def`).toBeDefined();
      // Each must be mode-gated to "agent" only.
      expect(entry.modes, `${entry.name} should have modes set`).toEqual(["agent"]);
      // Each must declare the shared group for /extensions display.
      expect(entry.group).toBe("computer");
    }
  });

  it("includes all 12 tools in the active ToolSet when kernel mode is agent", async () => {
    await bootstrapPlugins([createNativePluginModule(computerToolsPlugin)]);
    setKernelMode("agent");
    const set = getEnabledToolSet();
    expect(Object.keys(set).sort()).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("strips all 12 tools from the active ToolSet in plan mode", async () => {
    await bootstrapPlugins([createNativePluginModule(computerToolsPlugin)]);
    setKernelMode("plan");
    const set = getEnabledToolSet();
    expect(Object.keys(set)).toEqual([]);
  });

  it("strips all 12 tools from the active ToolSet in ask mode", async () => {
    await bootstrapPlugins([createNativePluginModule(computerToolsPlugin)]);
    setKernelMode("ask");
    const set = getEnabledToolSet();
    expect(Object.keys(set)).toEqual([]);
  });

  it("falls back to the pre-Phase-2 'all available' behavior when kernel mode is null", async () => {
    await bootstrapPlugins([createNativePluginModule(computerToolsPlugin)]);
    // No setKernelMode call — currentKernelMode stays null.
    const set = getEnabledToolSet();
    expect(Object.keys(set).sort()).toEqual(EXPECTED_TOOL_NAMES);
  });
});
