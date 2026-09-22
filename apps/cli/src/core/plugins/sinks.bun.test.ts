// NET-6's turn scope, on the runtime that actually ships.
//
// `runInTelegramTurn` is built on `AsyncLocalStorage`. The Vitest suite runs on
// Node; CodeSurf runs on Bun. If Bun ever drops the store across an await, the
// fence fails OPEN — `callerOwnsTelegramSink()` sees no ambient turn and allows
// the send — so the bug would be silent and would only ever show up as a file
// delivered into the wrong chat. This file is the check, in Bun.

import { afterEach, describe, expect, it } from "bun:test";
import {
  acquireTelegramSink,
  callerOwnsTelegramSink,
  resetSinkState,
  runInTelegramTurn,
  type TelegramSink,
} from "./sinks";

const noop: TelegramSink = async () => ({ success: true, output: "" });

afterEach(() => {
  resetSinkState();
});

describe("telegram turn scope under Bun", () => {
  it("keeps the ambient turn across timers, microtasks and Promise.all", async () => {
    const token = acquireTelegramSink(noop);

    const owned = await runInTelegramTurn(token, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await Promise.all([Promise.resolve(), new Promise((resolve) => queueMicrotask(resolve as () => void))]);
      await Promise.resolve();
      return callerOwnsTelegramSink();
    });

    expect(owned).toBe(true);
  });

  it("still sees the handover when a newer turn takes the sink mid-flight", async () => {
    const token = acquireTelegramSink(noop);

    const owned = await runInTelegramTurn(token, async () => {
      acquireTelegramSink(noop);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return callerOwnsTelegramSink();
    });

    // A dropped store would report `true` here — the fence failing open.
    expect(owned).toBe(false);
  });
});
