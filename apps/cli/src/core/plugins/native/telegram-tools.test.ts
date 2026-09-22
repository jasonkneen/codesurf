// Smoke tests for the telegram-tools extension.
//
// Phase 2 step 3 of the kernel-extensibility plan. Verifies that the single
// `telegram_send_file` tool registers correctly with the kernel, that
// `services.telegram.sendFile` returns a friendly error when the bridge sink
// is unbound (no bot running), and that when the bridge binds the sink via
// `setTelegramSink(...)` the tool forwards the resolved file path through to
// the sink at execute time.
//
// We don't exercise grammy / the Bot.api — `setTelegramSink` accepts an
// arbitrary async function, so we install a spy that records calls and
// returns canned ToolResults.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPluginsForTests,
  acquireTelegramSink,
  bootstrapPlugins,
  EXTENSIONS_V1_API_VERSION,
  getRegistrySnapshot,
  runInTelegramTurn,
  setCwdProvider,
  setTelegramSink,
} from "../index";
import { createNativePluginModule } from "./host";
import { telegramToolsPlugin } from "./telegram-tools";

let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-telegram-test-"));
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
  setTelegramSink(null);
  setCwdProvider(null);
});

interface ToolResultLike {
  success: boolean;
  output?: string;
  error?: string;
}

interface ExecutableTool {
  execute: (args: unknown) => Promise<ToolResultLike>;
}

describe("telegram-tools extension", () => {
  it("declares the expected manifest shape", () => {
    expect(telegramToolsPlugin.manifest.id).toBe("builtin.tools.telegram");
    expect(createNativePluginModule(telegramToolsPlugin).manifest.kind).toBe("builtin");
    expect(createNativePluginModule(telegramToolsPlugin).manifest.hostApiVersion).toBe(EXTENSIONS_V1_API_VERSION);
    expect(telegramToolsPlugin.manifest.capabilities).toContain("tools");
    expect(telegramToolsPlugin.manifest.enabledByDefault).toBe(true);
  });

  it("registers telegram_send_file as kernel-owned with the 'telegram' group", async () => {
    await bootstrapPlugins([createNativePluginModule(telegramToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    expect(snapshot.tools.map((t) => t.name)).toEqual(["telegram_send_file"]);
    const entry = snapshot.tools[0]!;
    expect(entry.tool, "telegram_send_file should have a kernel-owned tool def").toBeDefined();
    expect(entry.group).toBe("telegram");
    // Not mode-gated — available in all modes (matches original createTools behavior).
    expect(entry.modes ?? []).toEqual([]);
  });

  it("returns a friendly error when the bridge sink is unbound", async () => {
    await bootstrapPlugins([createNativePluginModule(telegramToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const entry = snapshot.tools.find((t) => t.name === "telegram_send_file")!;
    const tool = entry.tool as unknown as ExecutableTool;
    // sink is unbound by default after __resetPluginsForTests
    const result = await tool.execute({ path: "/tmp/some-file.txt" });
    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/telegram bridge is not active/i);
  });

  it("forwards the resolved path through the sink when bound", async () => {
    await bootstrapPlugins([createNativePluginModule(telegramToolsPlugin)]);
    const calls: string[] = [];
    setTelegramSink(async (filePath) => {
      calls.push(filePath);
      return { success: true, output: `sent: ${filePath}` };
    });

    const snapshot = getRegistrySnapshot();
    const entry = snapshot.tools.find((t) => t.name === "telegram_send_file")!;
    const tool = entry.tool as unknown as ExecutableTool;

    // Absolute path passes through verbatim.
    const absResult = await tool.execute({ path: "/var/log/some.log" });
    expect(absResult.success).toBe(true);
    expect(calls).toEqual(["/var/log/some.log"]);

    // cwd-relative path is resolved against services.workspace.cwd().
    setCwdProvider(() => "/workspace/proj");
    const relResult = await tool.execute({ path: "out/result.png" });
    expect(relResult.success).toBe(true);
    expect(calls[1]).toBe("/workspace/proj/out/result.png");
  });

  it("refuses a send from a turn a newer turn has superseded (NET-6)", async () => {
    // The scenario the review names: turn A's tool call is still in flight
    // (its caller passed no abort signal, or its provider ignored
    // `agent.abort()`) when turn B takes the destination. Reading the globally
    // installed sink would deliver A's file into B's chat.
    await bootstrapPlugins([createNativePluginModule(telegramToolsPlugin)]);
    const delivered: string[] = [];
    const tokenA = acquireTelegramSink(async (filePath) => {
      delivered.push(`A:${filePath}`);
      return { success: true, output: "A" };
    });

    const snapshot = getRegistrySnapshot();
    const entry = snapshot.tools.find((t) => t.name === "telegram_send_file")!;
    const tool = entry.tool as unknown as ExecutableTool;

    // While A still owns the sink, its send goes through.
    const owned = await runInTelegramTurn(tokenA, () => tool.execute({ path: "/tmp/a.png" }));
    expect(owned.success).toBe(true);
    expect(delivered).toEqual(["A:/tmp/a.png"]);

    // B takes over. A's next send must be refused, not redirected.
    acquireTelegramSink(async (filePath) => {
      delivered.push(`B:${filePath}`);
      return { success: true, output: "B" };
    });
    const stale = await runInTelegramTurn(tokenA, () => tool.execute({ path: "/tmp/late.png" }));

    expect(stale.success).toBe(false);
    expect(stale.error ?? "").toMatch(/no longer owns the Telegram destination/i);
    // Nothing reached B's chat.
    expect(delivered).toEqual(["A:/tmp/a.png"]);
  });

  it("propagates sink rejections as a friendly error result instead of throwing", async () => {
    await bootstrapPlugins([createNativePluginModule(telegramToolsPlugin)]);
    setTelegramSink(async () => {
      throw new Error("network down");
    });
    const snapshot = getRegistrySnapshot();
    const entry = snapshot.tools.find((t) => t.name === "telegram_send_file")!;
    const tool = entry.tool as unknown as ExecutableTool;

    const result = await tool.execute({ path: "/tmp/x.txt" });
    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("network down");
  });

  it("treats setTelegramSink(null) as 'unbound again' after a previous bind", async () => {
    await bootstrapPlugins([createNativePluginModule(telegramToolsPlugin)]);
    setTelegramSink(async () => ({ success: true, output: "ok" }));
    setTelegramSink(null);

    const snapshot = getRegistrySnapshot();
    const entry = snapshot.tools.find((t) => t.name === "telegram_send_file")!;
    const tool = entry.tool as unknown as ExecutableTool;

    const result = await tool.execute({ path: "/tmp/anything" });
    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/telegram bridge is not active/i);
  });
});
