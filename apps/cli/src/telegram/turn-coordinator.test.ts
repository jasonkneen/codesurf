import { describe, expect, it } from "vitest";
import { createTurnCoordinator, TurnAbandonedError } from "./turn-coordinator.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createTurnCoordinator", () => {
  it("serializes turns so only one runs at a time", async () => {
    const coord = createTurnCoordinator();
    const order: string[] = [];

    const a = coord.run(async () => {
      order.push("a:start");
      await tick();
      order.push("a:end");
    });
    const b = coord.run(async () => {
      order.push("b:start");
      order.push("b:end");
    });

    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("keeps the chain alive when a turn throws", async () => {
    const coord = createTurnCoordinator();
    const failed = coord.run(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");

    await expect(coord.run(async () => "ok")).resolves.toBe("ok");
  });

  // The bug behind "Waiting... 105s with nothing running": a turn whose promise
  // never settles (a Telegram turn whose stream never closes, a provider that
  // ignores abort) wedges the chain forever. The UI has already latched
  // isProcessing=true before awaiting us, and `processMessage` early-returns on
  // `if (isProcessingRef.current) return`, so every future turn is locked out.
  it("reset() unwedges the queue when a turn never settles", async () => {
    const coord = createTurnCoordinator();

    coord.run(() => new Promise<void>(() => {})); // hangs forever

    let ranAfterHang = false;
    coord.run(async () => {
      ranAfterHang = true;
    });
    await tick();
    expect(ranAfterHang).toBe(false); // wedged, as expected

    coord.reset();

    await expect(coord.run(async () => "recovered")).resolves.toBe("recovered");
  });

  // NET-6: reset() only ever dropped *queued* turns. A turn already running
  // kept full authority — it could still send into (and later unbind) the
  // destination of the turn that replaced it. The fence signal tells a running
  // turn it lost ownership; the successor gets a fresh, un-aborted fence.
  it("reset() fences the running turn and hands the next turn a fresh signal", async () => {
    const coord = createTurnCoordinator();

    let releaseA: () => void = () => {};
    let signalA: AbortSignal | undefined;
    const a = coord.run(({ signal }) => {
      signalA = signal;
      return new Promise<void>((resolve) => (releaseA = resolve));
    });
    await tick();
    expect(signalA?.aborted).toBe(false);

    coord.reset();
    expect(signalA?.aborted).toBe(true);
    expect(signalA?.reason).toBeInstanceOf(TurnAbandonedError);

    let signalB: AbortSignal | undefined;
    await coord.run(async ({ signal }) => {
      signalB = signal;
    });
    expect(signalB?.aborted).toBe(false);
    expect(signalB).not.toBe(signalA);

    // A finishing late must not disturb B's fence.
    releaseA();
    await a;
    expect(signalB?.aborted).toBe(false);
  });

  // reset() must also make sure the abandoned turn can never spring back to
  // life. If the hung promise later settles, its queued successor must NOT
  // start a zombie turn behind the user's back.
  it("reset() abandons queued turns instead of running them later", async () => {
    const coord = createTurnCoordinator();

    let releaseHang: () => void = () => {};
    coord.run(() => new Promise<void>((resolve) => (releaseHang = resolve)));

    let zombieRan = false;
    const queued = coord.run(async () => {
      zombieRan = true;
    });

    coord.reset();

    // The hung turn finally settles. Its successor must not execute.
    releaseHang();
    await expect(queued).rejects.toBeInstanceOf(TurnAbandonedError);
    await tick();
    expect(zombieRan).toBe(false);
  });
});
