import type { Api } from "grammy";

/** Telegram clears typing after ~5s; refresh before that so the indicator stays visible. */
const TYPING_REFRESH_MS = 3500;

/** grammy types its `signal` parameter against the `abort-controller` polyfill; runtime-identical to the global. */
type GrammySignal = Parameters<Api["sendChatAction"]>[3];

/**
 * Repeats `sendChatAction(typing)` until `stop()` is called or `signal` aborts.
 * No-op when `enabled` is false. A tick is skipped while the previous request
 * is still in flight, so a slow API never stacks overlapping requests; stopping
 * cancels the in-flight request.
 */
export function startTypingRefresh(
  api: Api,
  chatId: number | string,
  messageThreadId: number | undefined,
  enabled: boolean,
  signal?: AbortSignal,
): () => void {
  if (!enabled || signal?.aborted) return () => {};
  const controller = new AbortController();
  let inFlight = false;
  const tick = () => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = true;
    void api
      .sendChatAction(chatId, "typing", { message_thread_id: messageThreadId }, controller.signal as GrammySignal)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  const id = setInterval(tick, TYPING_REFRESH_MS);
  const stop = () => {
    clearInterval(id);
    signal?.removeEventListener("abort", stop);
    controller.abort();
  };
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}
