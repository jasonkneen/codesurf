// Smoke tests for the payments-tools extension.
//
// Phase 2 #5 migration of the kernel-extensibility plan. Verifies that the
// 4 wallet/payments tools register correctly with the kernel, that
// `paid_request.needsApproval` survives the registry round-trip, and that
// `paid_request.execute` reads the active session id via
// `services.session.id()` (not via constructor closure).
//
// We don't exercise the actual `WalletManager` / `PaymentHistory` /
// `X402Service` networking — those are dynamic-imported inside each
// `execute()`. The "no wallet" branch of `wallet_info` is exercised because
// it triggers without any network access in the temp config dir.
//
// `wallet_history` is exercised against the empty audit log (which writes
// to `tempDir/payments/history.jsonl`) and asserts the empty-state output.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  EXTENSIONS_V1_API_VERSION,
  getRegistrySnapshot,
  setSessionIdProvider,
} from "../index";
import { createNativePluginModule } from "./host";
import { paymentsToolsPlugin } from "./payments-tools";

let tempDir: string;
let originalEnv: string | undefined;
let originalHomeEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-payments-test-"));
  originalEnv = process.env.CODESURF_CONFIG_DIR;
  originalHomeEnv = process.env.HOME;
  process.env.CODESURF_CONFIG_DIR = tempDir;
  // Force WalletManager and PaymentHistory to look at the temp dir.
  process.env.HOME = tempDir;
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalEnv;
  if (originalHomeEnv === undefined) delete process.env.HOME;
  else process.env.HOME = originalHomeEnv;
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
  setSessionIdProvider(null);
});

const EXPECTED_TOOL_NAMES = ["fetch_payment_info", "paid_request", "wallet_history", "wallet_info"];

describe("payments-tools extension", () => {
  it("declares the expected manifest shape", () => {
    expect(paymentsToolsPlugin.manifest.id).toBe("builtin.tools.payments");
    expect(paymentsToolsPlugin.manifest.capabilities).toContain("tools");
    expect(paymentsToolsPlugin.manifest.enabledByDefault).toBe(true);
    // kind and hostApiVersion are the loader's fields, supplied by the adapter.
    const adapted = createNativePluginModule(paymentsToolsPlugin);
    expect(adapted.manifest.kind).toBe("builtin");
    expect(adapted.manifest.hostApiVersion).toBe(EXTENSIONS_V1_API_VERSION);
  });

  it("registers all 4 payment tools as kernel-owned with the 'payments' group", async () => {
    await bootstrapPlugins([createNativePluginModule(paymentsToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const toolNames = snapshot.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(EXPECTED_TOOL_NAMES);

    for (const entry of snapshot.tools) {
      expect(entry.tool, `${entry.name} should have a kernel-owned tool def`).toBeDefined();
      expect(entry.group).toBe("payments");
      // paid_request is gated to agent mode — crypto spend is too dangerous to
      // expose in plan/ask. The other three (fetch_payment_info, wallet_info,
      // wallet_history) are read-only and available in every mode.
      if (entry.name === "paid_request") {
        expect(entry.modes).toEqual(["agent"]);
      } else {
        expect(entry.modes ?? []).toEqual([]);
      }
    }
  });

  it("preserves paid_request.needsApproval through the registry round-trip", async () => {
    await bootstrapPlugins([createNativePluginModule(paymentsToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const paidRequest = snapshot.tools.find((t) => t.name === "paid_request");
    expect(paidRequest).toBeDefined();
    expect(paidRequest!.tool).toBeDefined();
    // The ai-sdk tool({...}) call places needsApproval onto the resulting
    // tool object. With no payment-settings file in the temp config dir,
    // loadPaymentSettings() throws or returns autoApprove=false (default),
    // so the catch branch returns true.
    const tool = paidRequest!.tool as unknown as { needsApproval?: () => boolean | Promise<boolean> };
    expect(typeof tool.needsApproval).toBe("function");
    expect(await tool.needsApproval!()).toBe(true);
  });

  it("paid_request.execute reads the active session id via services.session.id()", async () => {
    await bootstrapPlugins([createNativePluginModule(paymentsToolsPlugin)]);
    let sessionIdReadCount = 0;
    setSessionIdProvider(() => {
      sessionIdReadCount += 1;
      return "test-session-42";
    });

    const snapshot = getRegistrySnapshot();
    const paidRequest = snapshot.tools.find((t) => t.name === "paid_request")!;
    const tool = paidRequest.tool as unknown as {
      execute: (args: unknown) => Promise<{ success: boolean; output: string }>;
    };

    // Calling execute will fail (the URL doesn't exist / no wallet) — we don't
    // care about the outcome; we care that the session-id provider was hit
    // before the dynamic import resolves and the call escapes to the
    // network layer. The provider runs synchronously on the first
    // `services.session.id()` call inside execute().
    const result = await tool.execute({
      url: "http://127.0.0.1:1/nonexistent-payment-target",
      method: "GET",
    });

    // The catch branch returns success=false; we just confirm it didn't throw.
    expect(result.success).toBe(false);
    // The provider must have been read at least once during the execute path.
    expect(sessionIdReadCount).toBeGreaterThanOrEqual(1);
  });

  it("wallet_info returns a graceful 'no wallet' error when none exists", async () => {
    await bootstrapPlugins([createNativePluginModule(paymentsToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const walletInfo = snapshot.tools.find((t) => t.name === "wallet_info")!;
    const tool = walletInfo.tool as unknown as {
      execute: (args: unknown) => Promise<{ success: boolean; output: string }>;
    };
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.output.toLowerCase()).toContain("wallet");
  });

  it("wallet_history returns the empty-state message with no recorded payments", async () => {
    await bootstrapPlugins([createNativePluginModule(paymentsToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const walletHistory = snapshot.tools.find((t) => t.name === "wallet_history")!;
    const tool = walletHistory.tool as unknown as {
      execute: (args: unknown) => Promise<{ success: boolean; output: string }>;
    };
    const result = await tool.execute({ limit: 5 });
    expect(result.success).toBe(true);
    expect(result.output).toBe("No payment history yet.");
  });
});
