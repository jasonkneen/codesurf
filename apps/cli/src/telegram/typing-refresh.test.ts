// NET-5 regression: `startTypingRefresh` fired `sendChatAction` on a fixed
// interval regardless of whether the previous request had returned, so an API
// slower than the 3.5s refresh stacked overlapping requests. It also had no
// way to cancel the in-flight request when the turn stopped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTypingRefresh } from "./typing-refresh";

interface Deferred {
  resolve: () => void;
  signal: AbortSignal | undefined;
}

function slowApi() {
  const pending: Deferred[] = [];
  const sendChatAction = vi.fn(
    (_chatId: unknown, _action: unknown, _other: unknown, signal?: AbortSignal) =>
      new Promise<true>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        pending.push({ resolve: () => resolve(true), signal });
      }),
  );
  return { api: { sendChatAction } as never, sendChatAction, pending };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startTypingRefresh", () => {
  it("does not overlap requests when the typing API is slower than the refresh interval", async () => {
    const { api, sendChatAction, pending } = slowApi();
    const stop = startTypingRefresh(api, 42, undefined, true);
    expect(sendChatAction).toHaveBeenCalledTimes(1);

    // Three refresh intervals pass while the first request is still pending.
    await vi.advanceTimersByTimeAsync(3500 * 3);
    expect(sendChatAction).toHaveBeenCalledTimes(1);

    // Once it returns, the next tick sends again.
    pending[0]!.resolve();
    await vi.advanceTimersByTimeAsync(3500);
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(3500 * 3);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels the in-flight request and a parent signal stops the refresh", async () => {
    const { api, sendChatAction, pending } = slowApi();
    const stop = startTypingRefresh(api, 42, undefined, true);
    expect(pending[0]!.signal?.aborted).toBe(false);
    stop();
    expect(pending[0]!.signal?.aborted).toBe(true);

    const parent = new AbortController();
    const { api: api2, sendChatAction: send2, pending: pending2 } = slowApi();
    startTypingRefresh(api2, 42, undefined, true, parent.signal);
    expect(send2).toHaveBeenCalledTimes(1);
    parent.abort();
    expect(pending2[0]!.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3500 * 2);
    expect(send2).toHaveBeenCalledTimes(1);
    expect(sendChatAction).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when disabled or when the signal is already aborted", () => {
    const { api, sendChatAction } = slowApi();
    startTypingRefresh(api, 42, undefined, false)();
    const aborted = new AbortController();
    aborted.abort();
    startTypingRefresh(api, 42, undefined, true, aborted.signal)();
    expect(sendChatAction).not.toHaveBeenCalled();
  });
});
