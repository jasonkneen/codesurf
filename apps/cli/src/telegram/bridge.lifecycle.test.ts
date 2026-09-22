// NET-4 / NET-5 regressions for the bridge lifecycle.
//
// Before: a non-conflict polling failure left `reportConflict` registered in
// the module-global conflict handler set (stop() early-returned when not
// running, so it could never be removed), and a rejecting `bot.stop()`
// skipped both `running = false` and the poller-lock release. stop() also
// left in-flight turns running.
//
// The poller lock defaults to `~/.codesurf/telegram-poller.lock` and ignores
// CODESURF_CONFIG_DIR, so it is mocked here — never touch the real home.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSinkState } from "../core/plugins/sinks";
import { createTelegramBridge } from "./bridge";
import { createTurnCoordinator } from "./turn-coordinator";

interface FakeBot {
  api: Record<string, ReturnType<typeof vi.fn>>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  catch: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

const harness = vi.hoisted(() => ({
  bots: [] as Array<{
    api: Record<string, unknown>;
    start: unknown;
    stop: unknown;
    catch: unknown;
    command: unknown;
    on: unknown;
  }>,
  nextStart: (): Promise<void> => new Promise<void>(() => {}),
  nextStop: (): Promise<void> => Promise.resolve(),
  acquire: 0,
  release: 0,
  interceptors: [] as Array<(reason: unknown) => boolean>,
}));

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function BotMock() {
    const bot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        sendChatAction: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      },
      start: vi.fn(() => harness.nextStart()),
      stop: vi.fn(() => harness.nextStop()),
      catch: vi.fn(),
      command: vi.fn(),
      on: vi.fn(),
    };
    harness.bots.push(bot);
    return bot;
  }),
  GrammyError: class GrammyErrorMock extends Error {},
}));

vi.mock("./poller-lock", () => ({
  acquireTelegramPollerLock: () => {
    harness.acquire++;
    return {
      acquired: true,
      release: () => {
        harness.release++;
      },
    };
  },
}));

vi.mock("../utils/process-guards", () => ({
  registerRejectionInterceptor: (fn: (reason: unknown) => boolean) => {
    harness.interceptors.push(fn);
  },
}));

const tick = () => new Promise((r) => setTimeout(r, 0));
const lastBot = () => harness.bots[harness.bots.length - 1] as unknown as FakeBot;
const totalStopCalls = () => harness.bots.reduce((n, bot) => n + (bot as unknown as FakeBot).stop.mock.calls.length, 0);
/** Simulate grammy's fire-and-forget getUpdates 409 reaching the process-level interceptor. */
const fire409 = () => {
  for (const fn of harness.interceptors) fn({ error_code: 409, description: "Conflict" });
};

function makeBridge(onError = vi.fn()) {
  const bridge = createTelegramBridge({
    token: "test-token",
    getApprovedUserIds: () => [42],
    coordinator: createTurnCoordinator(),
    getTelegramAgent: vi.fn(),
    onError,
  });
  return { bridge, onError };
}

beforeEach(() => {
  harness.bots.length = 0;
  harness.acquire = 0;
  harness.release = 0;
  harness.nextStart = () => new Promise<void>(() => {});
  harness.nextStop = () => Promise.resolve();
});

afterEach(() => {
  resetSinkState();
});

describe("createTelegramBridge lifecycle (NET-4)", () => {
  it("a normal start rejection releases the lock and the conflict handler, and stop() afterwards resolves", async () => {
    harness.nextStart = () => Promise.reject(new Error("network down"));
    const { bridge, onError } = makeBridge();

    bridge.start();
    await tick();
    expect(onError).toHaveBeenCalledWith("network down");
    expect(harness.acquire).toBe(1);
    expect(harness.release).toBe(1);

    // The handler is gone: a later 409 must not reach this bot.
    fire409();
    expect(lastBot().stop).not.toHaveBeenCalled();

    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(harness.release).toBe(1);
    expect(lastBot().stop).not.toHaveBeenCalled();
  });

  it("a rejecting bot.stop() still releases the lock and handler, and the bridge can start again", async () => {
    harness.nextStop = () => Promise.reject(new Error("stop failed"));
    const { bridge } = makeBridge();

    bridge.start();
    expect(harness.acquire).toBe(1);
    await expect(bridge.stop()).rejects.toThrow("stop failed");
    expect(lastBot().stop).toHaveBeenCalledTimes(1);
    expect(harness.release).toBe(1);

    fire409();
    expect(lastBot().stop).toHaveBeenCalledTimes(1);

    harness.nextStop = () => Promise.resolve();
    bridge.start();
    expect(harness.acquire).toBe(2);
    await bridge.stop();
    expect(harness.release).toBe(2);
  });

  it("concurrent stop() calls share one shutdown and start() is refused while stopping", async () => {
    let finishStop: () => void = () => {};
    harness.nextStop = () => new Promise<void>((resolve) => (finishStop = resolve));
    const { bridge } = makeBridge();

    bridge.start();
    const first = bridge.stop();
    const second = bridge.stop();
    expect(second).toBe(first);
    bridge.start();
    expect(harness.acquire).toBe(1);

    finishStop();
    await Promise.all([first, second]);
    expect(lastBot().stop).toHaveBeenCalledTimes(1);
    expect(harness.release).toBe(1);
  });

  it("repeated create/start/fail/dispose retains no handler and no lock", async () => {
    harness.nextStart = () => Promise.reject(new Error("boom"));
    for (let i = 0; i < 3; i++) {
      const { bridge } = makeBridge();
      bridge.start();
      await tick();
      await bridge.stop();
    }
    expect(harness.acquire).toBe(3);
    expect(harness.release).toBe(3);

    fire409();
    expect(totalStopCalls()).toBe(0);
  });

  it("a polling exit after a normal stop does not release a newer session's lock", async () => {
    let endPolling: () => void = () => {};
    harness.nextStart = () => new Promise<void>((resolve) => (endPolling = resolve));
    const { bridge } = makeBridge();

    bridge.start();
    const endFirstSession = endPolling;
    await bridge.stop();
    expect(harness.release).toBe(1);

    bridge.start();
    expect(harness.acquire).toBe(2);
    // The first session's bot.start() promise settles late.
    endFirstSession();
    await tick();
    expect(harness.release).toBe(1);

    await bridge.stop();
    expect(harness.release).toBe(2);
  });
});

describe("createTelegramBridge stop cancels in-flight ingress (NET-5)", () => {
  it("stop() aborts a running turn and the turn does not reply afterwards", async () => {
    let releaseTurn: () => void = () => {};
    const agent = {
      abort: vi.fn(() => releaseTurn()),
      getChatEntries: () => [],
      processMessage: async function* () {
        yield { type: "content", content: "partial" };
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        throw new Error("aborted by provider");
      },
    };
    const onError = vi.fn();
    const bridgeWithAgent = createTelegramBridge({
      token: "test-token",
      getApprovedUserIds: () => [42],
      coordinator: createTurnCoordinator(),
      getTelegramAgent: () => agent as never,
      onError,
    });
    const bot = lastBot();
    const onText = bot.on.mock.calls.find(([name]) => name === "message:text")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const reply = vi.fn().mockResolvedValue(undefined);

    bridgeWithAgent.start();
    const turn = onText({
      chat: { id: 42, type: "private" },
      from: { id: 42 },
      message: { message_id: 1, text: "hello" },
      reply,
    });
    await vi.waitFor(() => expect(bot.api.sendMessage).toHaveBeenCalledTimes(1));

    await bridgeWithAgent.stop();
    expect(agent.abort).toHaveBeenCalledTimes(1);
    await turn;
    // No "Error: ..." reply for a turn the bridge itself cancelled.
    expect(reply).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("createTelegramBridge polling-stopped signal (M11)", () => {
  it("reports a fatal polling error once via onPollingStopped", async () => {
    harness.nextStart = () => Promise.reject(new Error("getUpdates failed"));
    const onPollingStopped = vi.fn();
    const bridge = createTelegramBridge({
      token: "test-token",
      getApprovedUserIds: () => [42],
      coordinator: createTurnCoordinator(),
      getTelegramAgent: vi.fn(),
      onPollingStopped,
    });
    bridge.start();
    await tick();
    expect(onPollingStopped).toHaveBeenCalledWith("error", "getUpdates failed");
    await bridge.stop();
  });

  it("reports a 409 conflict via onPollingStopped", async () => {
    const onPollingStopped = vi.fn();
    const bridge = createTelegramBridge({
      token: "test-token",
      getApprovedUserIds: () => [42],
      coordinator: createTurnCoordinator(),
      getTelegramAgent: vi.fn(),
      onPollingStopped,
    });
    bridge.start();
    fire409();
    fire409();
    expect(onPollingStopped).toHaveBeenCalledTimes(1);
    expect(onPollingStopped.mock.calls[0]?.[0]).toBe("conflict");
    await bridge.stop();
  });

  it("a normal stop does not report polling stopped", async () => {
    let endPolling: () => void = () => {};
    harness.nextStart = () => new Promise<void>((resolve) => (endPolling = resolve));
    harness.nextStop = () => {
      endPolling();
      return Promise.resolve();
    };
    const onPollingStopped = vi.fn();
    const bridge = createTelegramBridge({
      token: "test-token",
      getApprovedUserIds: () => [42],
      coordinator: createTurnCoordinator(),
      getTelegramAgent: vi.fn(),
      onPollingStopped,
    });
    bridge.start();
    await bridge.stop();
    await tick();
    expect(onPollingStopped).not.toHaveBeenCalled();
  });
});
