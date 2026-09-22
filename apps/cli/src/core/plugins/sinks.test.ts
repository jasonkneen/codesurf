// Telegram sink ownership (NET-6 regression).
//
// Two Telegram turns can overlap after `coordinator.reset()`: the older turn's
// `finally` used to run `setTelegramSink(null)` unconditionally, unbinding the
// newer turn's destination. Ownership tokens make release compare-and-swap.

import { afterEach, describe, expect, it } from "vitest";
import {
  acquireTelegramSink,
  callerOwnsTelegramSink,
  releaseTelegramSink,
  resetSinkState,
  runInTelegramTurn,
  setTelegramSink,
  sinks,
  type TelegramSink,
} from "./sinks";

const sinkA: TelegramSink = async () => ({ success: true, output: "A" });
const sinkB: TelegramSink = async () => ({ success: true, output: "B" });

afterEach(() => {
  resetSinkState();
});

describe("telegram sink ownership", () => {
  it("a stale owner cannot release a newer owner's sink", () => {
    const tokenA = acquireTelegramSink(sinkA);
    expect(sinks.telegram).toBe(sinkA);

    const tokenB = acquireTelegramSink(sinkB);
    expect(sinks.telegram).toBe(sinkB);

    expect(releaseTelegramSink(tokenA)).toBe(false);
    expect(sinks.telegram).toBe(sinkB);

    expect(releaseTelegramSink(tokenB)).toBe(true);
    expect(sinks.telegram).toBeNull();

    // Releasing again (or the stale token again) is a no-op.
    expect(releaseTelegramSink(tokenB)).toBe(false);
    expect(releaseTelegramSink(tokenA)).toBe(false);
    expect(sinks.telegram).toBeNull();
  });

  it("the legacy unconditional setter drops ownership", () => {
    const tokenA = acquireTelegramSink(sinkA);
    setTelegramSink(sinkB);
    expect(sinks.telegram).toBe(sinkB);

    // A's token no longer owns anything, so its release leaves sinkB bound.
    expect(releaseTelegramSink(tokenA)).toBe(false);
    expect(sinks.telegram).toBe(sinkB);

    setTelegramSink(null);
    expect(sinks.telegram).toBeNull();
  });

  it("resetSinkState clears the owner so a token from before the reset is inert", () => {
    const tokenA = acquireTelegramSink(sinkA);
    resetSinkState();
    expect(sinks.telegram).toBeNull();

    const tokenB = acquireTelegramSink(sinkB);
    expect(releaseTelegramSink(tokenA)).toBe(false);
    expect(sinks.telegram).toBe(sinkB);
    expect(releaseTelegramSink(tokenB)).toBe(true);
  });
});

// The second half of NET-6: compare-and-release stops a stale turn UNBINDING
// the newer turn's sink, but not a stale turn SENDING through it. The loader
// reads whatever sink is globally installed, so an in-flight tool call from a
// superseded turn would deliver into the newer turn's chat.
describe("telegram turn-context destination dispatch", () => {
  it("refuses a send from a turn that no longer owns the sink", () => {
    const tokenA = acquireTelegramSink(sinkA);
    runInTelegramTurn(tokenA, () => {
      expect(callerOwnsTelegramSink()).toBe(true);
    });

    // A newer turn takes over. Turn A is still running.
    acquireTelegramSink(sinkB);
    runInTelegramTurn(tokenA, () => {
      expect(callerOwnsTelegramSink()).toBe(false);
    });
  });

  it("keeps ownership across an await, which is where the real overlap happens", async () => {
    const tokenA = acquireTelegramSink(sinkA);
    let ownedAfterHandover: boolean | null = null;

    const turnA = runInTelegramTurn(tokenA, async () => {
      // Stand in for a tool call that outlives its turn.
      await new Promise((resolve) => setTimeout(resolve, 0));
      ownedAfterHandover = callerOwnsTelegramSink();
    });

    acquireTelegramSink(sinkB);
    await turnA;

    expect(ownedAfterHandover).toBe(false);
  });

  it("does not fence callers with no ambient turn", () => {
    // The legacy `setTelegramSink` bind and anything not driven by the bridge
    // have no turn to fence against; refusing them would break the surface.
    acquireTelegramSink(sinkA);
    expect(callerOwnsTelegramSink()).toBe(true);
    setTelegramSink(sinkB);
    expect(callerOwnsTelegramSink()).toBe(true);
  });
});
