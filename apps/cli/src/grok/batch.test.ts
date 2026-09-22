import { afterEach, describe, expect, it, vi } from "vitest";
import { getBatchChatCompletion, pollBatchRequestResult } from "./batch";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("getBatchChatCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("extracts the chat completion payload from a batch result", () => {
    const response = getBatchChatCompletion({
      batch_request_id: "req-1",
      batch_result: {
        response: {
          chat_get_completion: {
            id: "chatcmpl-1",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "done",
                },
              },
            ],
            usage: {
              total_tokens: 12,
            },
          },
        },
      },
    });

    expect(response.choices[0]?.message.content).toBe("done");
    expect(response.usage?.total_tokens).toBe(12);
  });

  it("throws when the batch result is an error", () => {
    expect(() =>
      getBatchChatCompletion({
        batch_request_id: "req-2",
        error_message: "boom",
      }),
    ).toThrow('Batch request "req-2" failed: boom');
  });

  it("waits through transient ClickHouse visibility errors before returning a result", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              batch_request_id: "req-3",
              batch_result: {
                error: "Batch request not yet visible in ClickHouse",
              },
            },
          ],
          pagination_token: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          batch_id: "batch-1",
          state: {
            num_requests: 1,
            num_pending: 1,
            num_success: 0,
            num_error: 0,
            num_cancelled: 0,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              batch_request_id: "req-3",
              batch_result: {
                response: {
                  chat_get_completion: {
                    choices: [{ message: { content: "done" } }],
                  },
                },
              },
            },
          ],
          pagination_token: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollBatchRequestResult({
      apiKey: "test-key",
      batchId: "batch-1",
      batchRequestId: "req-3",
      initialPollMs: 0,
      maxPollMs: 0,
      timeoutMs: 1000,
    });

    expect(result.batch_result?.response?.chat_get_completion?.choices[0]?.message.content).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps polling after batch completion until the result row becomes visible", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [],
          pagination_token: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          batch_id: "batch-2",
          state: {
            num_requests: 1,
            num_pending: 0,
            num_success: 1,
            num_error: 0,
            num_cancelled: 0,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              batch_request_id: "req-4",
              batch_result: {
                response: {
                  chat_get_completion: {
                    choices: [{ message: { content: "visible now" } }],
                  },
                },
              },
            },
          ],
          pagination_token: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollBatchRequestResult({
      apiKey: "test-key",
      batchId: "batch-2",
      batchRequestId: "req-4",
      initialPollMs: 0,
      maxPollMs: 0,
      timeoutMs: 1000,
    });

    expect(result.batch_result?.response?.chat_get_completion?.choices[0]?.message.content).toBe("visible now");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("pollBatchRequestResult deadline", () => {
  const baseOptions = {
    apiKey: "test-key",
    batchId: "batch-deadline",
    batchRequestId: "req-deadline",
    initialPollMs: 0,
    maxPollMs: 0,
  };

  function pendingBatchStatus(): Response {
    return jsonResponse({
      batch_id: "batch-deadline",
      state: { num_requests: 1, num_pending: 1, num_success: 0, num_error: 0, num_cancelled: 0 },
    });
  }

  function abortError(): Error {
    return new DOMException("This operation was aborted", "AbortError");
  }

  /** A fetch that never settles and ignores its signal entirely. */
  function hangingFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
    return vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
  }

  /** A fetch that never settles unless its signal aborts, like a real socket that stalls. */
  function stalledSocketFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
    return vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
    );
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("times out a hanging fetch at the configured deadline even when fetch ignores its signal", async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = pollBatchRequestResult({ ...baseOptions, timeoutMs: 10 }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(await outcome).toContain('Timed out waiting for batch request "req-deadline"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a deadline abort surfaced by fetch as a timeout, not a caller abort", async () => {
    vi.useFakeTimers();
    const fetchMock = stalledSocketFetch();
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();

    const outcome = pollBatchRequestResult({ ...baseOptions, timeoutMs: 10, signal: caller.signal }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(await outcome).toContain("Timed out waiting for batch request");
    expect(caller.signal.aborted).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("bounds response body consumption by the same deadline", async () => {
    vi.useFakeTimers();
    const neverEndingBody = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(neverEndingBody, { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = pollBatchRequestResult({ ...baseOptions, timeoutMs: 10 }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(await outcome).toContain("Timed out waiting for batch request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a repeating pagination cursor instead of looping forever", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ results: [], pagination_token: "same" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollBatchRequestResult({ ...baseOptions, timeoutMs: 10_000 })).rejects.toThrow(
      /repeated pagination token/,
    );
    // First page (no token) then the page fetched with "same", which returned "same" again.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("pagination_token=same");
  });

  it("walks a large valid pagination chain to the matching entry", async () => {
    const pageCount = 60;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const token = url.searchParams.get("pagination_token");
      const pageIndex = token ? Number(token.replace("page-", "")) : 0;
      if (pageIndex === pageCount - 1) {
        return jsonResponse({
          results: [
            {
              batch_request_id: "req-deadline",
              batch_result: { response: { chat_get_completion: { choices: [{ message: { content: "last page" } }] } } },
            },
          ],
          pagination_token: null,
        });
      }
      return jsonResponse({
        results: [{ batch_request_id: `other-${pageIndex}` }],
        pagination_token: `page-${pageIndex + 1}`,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollBatchRequestResult({ ...baseOptions, timeoutMs: 10_000 });

    expect(result.batch_result?.response?.chat_get_completion?.choices[0]?.message.content).toBe("last page");
    expect(fetchMock).toHaveBeenCalledTimes(pageCount);
  });

  it("caps the poll sleep at the remaining budget so a near-deadline sleep cannot overshoot", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ results: [], pagination_token: null }))
      .mockResolvedValueOnce(pendingBatchStatus());
    vi.stubGlobal("fetch", fetchMock);
    const startedAt = Date.now();

    const outcome = pollBatchRequestResult({
      ...baseOptions,
      timeoutMs: 100,
      initialPollMs: 30_000,
      maxPollMs: 30_000,
    }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(await outcome).toContain("Timed out waiting for batch request");
    expect(Date.now() - startedAt).toBe(100);
    // list + status only: no further request was issued after the deadline.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a caller abort as a caller abort, not a timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ results: [], pagination_token: null }))
      .mockResolvedValueOnce(pendingBatchStatus());
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();

    const outcome = pollBatchRequestResult({
      ...baseOptions,
      timeoutMs: 60_000,
      initialPollMs: 5_000,
      maxPollMs: 5_000,
      signal: caller.signal,
    }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toBe("Request aborted");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a caller abort during an in-flight request as a caller abort", async () => {
    vi.useFakeTimers();
    const fetchMock = stalledSocketFetch();
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();

    const outcome = pollBatchRequestResult({ ...baseOptions, timeoutMs: 60_000, signal: caller.signal }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toBe("Request aborted");
  });
});
