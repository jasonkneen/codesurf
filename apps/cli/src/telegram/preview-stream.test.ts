import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTelegramPartialReply } from "./preview-stream";

async function* emptyStream() {
  yield { type: "done" } as never;
}

async function* helloStream() {
  yield { type: "content", content: "hello" } as never;
}

function tooManyRequests(retryAfterSeconds: number): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed! (429: Too Many Requests)",
    {
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfterSeconds}`,
      parameters: { retry_after: retryAfterSeconds },
    },
    "sendMessage",
    {},
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runTelegramPartialReply cancellation (NET-5)", () => {
  it("aborting during a 429 back-off settles immediately instead of sleeping out the retry", async () => {
    vi.useFakeTimers();
    let reachedFirstSend: () => void = () => {};
    const firstSend = new Promise<void>((resolve) => (reachedFirstSend = resolve));
    const sendMessage = vi.fn((_chatId: unknown, _text: unknown, _other: unknown, _signal?: AbortSignal) => {
      reachedFirstSend();
      return Promise.reject(tooManyRequests(30));
    });
    const api = { sendMessage, editMessageText: vi.fn(), sendChatAction: vi.fn() };
    const controller = new AbortController();

    const run = runTelegramPartialReply(api as never, {
      chatId: 42,
      typingIndicator: false,
      stream: helloStream(),
      signal: controller.signal,
    });
    await firstSend;
    await vi.advanceTimersByTimeAsync(0); // let the 429 rejection reach the back-off sleep
    expect(vi.getTimerCount()).toBe(1); // the 30s back-off sleep

    controller.abort(new Error("turn stopped"));
    await expect(run).rejects.toThrow("turn stopped");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // The in-flight request was handed the turn signal so a stop cancels it.
    expect(sendMessage.mock.calls[0]?.[3]).toBe(controller.signal);
  });

  it("does not start any request once the signal is already aborted", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const api = { sendMessage, editMessageText: vi.fn(), sendChatAction: vi.fn() };
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));

    await expect(
      runTelegramPartialReply(api as never, {
        chatId: 42,
        typingIndicator: true,
        stream: helloStream(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("already stopped");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(api.sendChatAction).not.toHaveBeenCalled();
  });
});

describe("runTelegramPartialReply", () => {
  it("uses finalTextFallback when stream emits no content", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
      editMessageText: vi.fn().mockResolvedValue({}),
      sendChatAction: vi.fn().mockResolvedValue({}),
    };
    const onAssistantMessage = vi.fn();

    await runTelegramPartialReply(api as never, {
      chatId: 42,
      typingIndicator: false,
      stream: emptyStream(),
      finalTextFallback: () => "Recovered transcript answer",
      onAssistantMessage,
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      42,
      "Recovered transcript answer",
      { message_thread_id: undefined },
      undefined,
    );
    expect(onAssistantMessage).toHaveBeenCalledWith({ content: "Recovered transcript answer", done: true });
  });
});
