import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent, ProviderTurnInput } from "../api";
import { type OpenAiHttpResolvers, OpenAiHttpSession } from "./openai-http-session";

const encoder = new TextEncoder();

function makeResolvers(overrides: Partial<OpenAiHttpResolvers> = {}): OpenAiHttpResolvers {
  return {
    baseUrl: () => "http://localhost:1234/v1",
    apiKey: () => "",
    timeoutMs: () => 5000,
    verbose: () => false,
    ...overrides,
  };
}

function makeTurn(providerId: string, adapterId: string, abortSignal?: AbortSignal): ProviderTurnInput {
  return {
    conversationId: "conv-1",
    providerId,
    adapterId,
    modelId: "some-model",
    prompt: "Hello",
    messages: [{ role: "user", content: "Hello" }],
    metadata: {},
    ...(abortSignal ? { abortSignal } : {}),
  };
}

const IDS = { adapterId: "local-llm.http", providerId: "local-llm" };

/** An SSE body that delivers `chunks` and then never closes unless `close` is set. */
function sseBody(chunks: string[], options: { close?: boolean } = {}) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.close) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

/** Install a fetch that answers 200 with `body` and records the request signal. */
function installFetch(body: ReadableStream<Uint8Array>) {
  const seen: { signal?: AbortSignal } = {};
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen.signal = init?.signal ?? undefined;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return seen;
}

function trackSettled<T>(promise: Promise<T>) {
  const state = { value: "pending" as "pending" | "resolved" | "rejected" };
  promise.then(
    () => {
      state.value = "resolved";
    },
    () => {
      state.value = "rejected";
    },
  );
  return state;
}

const HELLO_STREAM =
  'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n' +
  "data: [DONE]\n\n";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OpenAiHttpSession", () => {
  it("carries the identity it was constructed with", () => {
    const session = new OpenAiHttpSession("lightclaw", makeResolvers(), {
      adapterId: "lightclaw.http",
      providerId: "lightclaw",
    });
    expect(session.adapterId).toBe("lightclaw.http");
    expect(session.providerId).toBe("lightclaw");
    expect(session.mode).toBe("stateless");
    expect(session.strategy).toBe("per-turn");
  });

  it.each([
    { label: "lightclaw", adapterId: "lightclaw.http" },
    { label: "local-llm", adapterId: "local-llm.http" },
  ])("labels non-OK response errors with the provider name ($label)", async ({ label, adapterId }) => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;

    const events: ProviderStreamEvent[] = [];
    const session = new OpenAiHttpSession(label, makeResolvers(), {
      adapterId,
      providerId: label,
    });

    await expect(session.sendTurn(makeTurn(label, adapterId), { emit: (event) => events.push(event) })).rejects.toThrow(
      `${label} /chat/completions returned 500`,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          message: `${label} /chat/completions returned 500`,
        }),
      ]),
    );
  });

  it("times out a server that sends headers and then stalls before any body", async () => {
    vi.useFakeTimers();
    const body = sseBody([]);
    const seen = installFetch(body.stream);
    const events: ProviderStreamEvent[] = [];
    const session = new OpenAiHttpSession("local-llm", makeResolvers({ timeoutMs: () => 50 }), IDS);

    const turn = session.sendTurn(makeTurn(IDS.providerId, IDS.adapterId), { emit: (event) => events.push(event) });
    const settled = trackSettled(turn);

    await vi.advanceTimersByTimeAsync(49);
    expect(settled.value).toBe("pending");
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(turn).rejects.toThrow("local-llm timed out after 50ms");
    expect(seen.signal?.aborted).toBe(true);
    expect(body.wasCancelled()).toBe(true);
    expect(events).toContainEqual({ type: "error", message: "local-llm timed out after 50ms" });
    expect(events.filter((event) => event.type === "done")).toHaveLength(0);
  });

  it("times out mid-body after delivering the chunks that did arrive", async () => {
    vi.useFakeTimers();
    const body = sseBody(['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n']);
    const seen = installFetch(body.stream);
    const events: ProviderStreamEvent[] = [];
    const session = new OpenAiHttpSession("local-llm", makeResolvers({ timeoutMs: () => 50 }), IDS);

    const turn = session.sendTurn(makeTurn(IDS.providerId, IDS.adapterId), { emit: (event) => events.push(event) });
    const settled = trackSettled(turn);

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({ type: "text-delta", delta: "partial" });
    expect(settled.value).toBe("pending");

    await vi.advanceTimersByTimeAsync(50);
    await expect(turn).rejects.toThrow("local-llm timed out after 50ms");
    expect(seen.signal?.aborted).toBe(true);
    expect(body.wasCancelled()).toBe(true);
    expect(events.at(-1)).toEqual({ type: "error", message: "local-llm timed out after 50ms" });
    expect(events.filter((event) => event.type === "done")).toHaveLength(0);
  });

  it.each(["disconnect", "abortTurn"] as const)("%s aborts the active turn and cancels the body", async (method) => {
    const body = sseBody([]);
    const seen = installFetch(body.stream);
    const events: ProviderStreamEvent[] = [];
    const session = new OpenAiHttpSession("local-llm", makeResolvers(), IDS);

    const turn = session.sendTurn(makeTurn(IDS.providerId, IDS.adapterId), { emit: (event) => events.push(event) });
    const settled = trackSettled(turn);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled.value).toBe("pending");
    expect(events).toContainEqual({ type: "status", status: "streaming" });

    await session[method]();

    await expect(turn).rejects.toThrow("local-llm turn aborted");
    expect(seen.signal?.aborted).toBe(true);
    expect(body.wasCancelled()).toBe(true);
    expect(events.at(-1)).toEqual({ type: "error", message: "local-llm turn aborted" });
    expect(events.filter((event) => event.type === "done")).toHaveLength(0);
  });

  it("aborts through the host signal and reports the turn as aborted", async () => {
    const body = sseBody([]);
    const seen = installFetch(body.stream);
    const host = new AbortController();
    const events: ProviderStreamEvent[] = [];
    const session = new OpenAiHttpSession("local-llm", makeResolvers(), IDS);

    const turn = session.sendTurn(makeTurn(IDS.providerId, IDS.adapterId, host.signal), {
      emit: (event) => events.push(event),
    });
    await new Promise((resolve) => setImmediate(resolve));
    host.abort();

    await expect(turn).rejects.toThrow("local-llm turn aborted");
    expect(seen.signal?.aborted).toBe(true);
    expect(body.wasCancelled()).toBe(true);
  });

  it("removes its host abort listener once the turn settles, on success and on failure", async () => {
    const host = new AbortController();
    const added = vi.spyOn(host.signal, "addEventListener");
    const removed = vi.spyOn(host.signal, "removeEventListener");
    const session = new OpenAiHttpSession("local-llm", makeResolvers(), IDS);
    const balanced = () => {
      const addedAborts = added.mock.calls.filter(([type]) => type === "abort").map(([, fn]) => fn);
      const removedAborts = removed.mock.calls.filter(([type]) => type === "abort").map(([, fn]) => fn);
      return addedAborts.length > 0 && addedAborts.every((fn, index) => removedAborts[index] === fn);
    };

    // Success: full stream through to [DONE].
    installFetch(sseBody([HELLO_STREAM], { close: true }).stream);
    const events: ProviderStreamEvent[] = [];
    await expect(
      session.sendTurn(makeTurn(IDS.providerId, IDS.adapterId, host.signal), { emit: (event) => events.push(event) }),
    ).resolves.toEqual({ usage: { inputTokens: 3, outputTokens: 1 } });
    expect(events.filter((event) => event.type === "done")).toEqual([{ type: "done", stopReason: "stop" }]);
    expect(balanced()).toBe(true);

    // Failure: non-OK status before any body.
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(
      session.sendTurn(makeTurn(IDS.providerId, IDS.adapterId, host.signal), { emit: () => {} }),
    ).rejects.toThrow("local-llm /chat/completions returned 503");
    expect(added.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2);
    expect(balanced()).toBe(true);

    // With no turn in flight, session-owned termination is a no-op and a
    // late host abort has nothing left to reach.
    await expect(session.abortTurn()).resolves.toBeUndefined();
    await expect(session.disconnect()).resolves.toBeUndefined();
    expect(() => host.abort()).not.toThrow();
  });
});
