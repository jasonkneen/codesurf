// M11: a headless bridge whose polling dies (409 conflict / fatal getUpdates
// error) must shut down and reject so `codesurf telegram-bridge` exits non-zero
// and a supervisor restarts it — not idle forever as a zombie.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramBridgeOptions } from "./bridge";

const harness = vi.hoisted(() => ({
  options: undefined as TelegramBridgeOptions | undefined,
  stop: vi.fn(async () => {}),
  onStart: (_opts: TelegramBridgeOptions) => {},
}));

vi.mock("./bridge", () => ({
  createTelegramBridge: (options: TelegramBridgeOptions) => {
    harness.options = options;
    return {
      start: () => harness.onStart(options),
      stop: harness.stop,
      sendDm: vi.fn(),
    };
  },
}));

vi.mock("../utils/settings", () => ({
  getApiKey: () => "key",
  getBaseURL: () => "https://api.example",
  getCurrentModelSelection: () => ({ model: "m" }),
  getCurrentSandboxMode: () => "off",
  getCurrentSandboxSettings: () => ({}),
  getTelegramBotToken: () => "bot-token",
  loadUserSettings: () => ({ telegram: { approvedUserIds: [] } }),
  saveApprovedTelegramUserId: vi.fn(),
  saveUserSettings: vi.fn(),
}));

vi.mock("../agent/agent", () => ({ Agent: class {} }));

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  harness.stop.mockClear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function paths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-tg-headless-"));
  dirs.push(dir);
  return { logFile: path.join(dir, "bridge.log"), pairCodeFile: path.join(dir, "pair.txt") };
}

describe("runTelegramHeadlessBridge fatal polling (M11)", () => {
  it("rejects after stopping when polling dies asynchronously", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, result: { id: 1, username: "bot" } })),
    );
    harness.onStart = (opts) => {
      setTimeout(() => opts.onPollingStopped?.("error", "getUpdates failed"), 10);
    };
    const { runTelegramHeadlessBridge } = await import("./headless-bridge");
    const files = paths();
    await expect(runTelegramHeadlessBridge(files)).rejects.toThrow(/polling stopped \(error\): getUpdates failed/);
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(files.logFile, "utf8")).toContain("polling_stopped: error");
  });

  it("rejects when polling is refused synchronously at start (conflict)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, result: { id: 1, username: "bot" } })),
    );
    harness.onStart = (opts) => opts.onPollingStopped?.("conflict", "another poller");
    const { runTelegramHeadlessBridge } = await import("./headless-bridge");
    await expect(runTelegramHeadlessBridge(paths())).rejects.toThrow(/polling stopped \(conflict\)/);
  });
});
