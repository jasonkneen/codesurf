import process from "node:process";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_INITIAL_POLL_MS = 2_000;
const DEFAULT_MAX_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BATCH_PAGE_SIZE = 100;
const DEFAULT_RATE_LIMIT_RETRIES = 5;

export interface BatchClientOptions {
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
}

export interface BatchState {
  num_requests: number;
  num_pending: number;
  num_success: number;
  num_error: number;
  num_cancelled: number;
}

export interface BatchCostBreakdown {
  total_cost_usd_ticks?: number;
}

export interface BatchInfo {
  batch_id: string;
  name?: string;
  expires_at?: string;
  state: BatchState;
  cost_breakdown?: BatchCostBreakdown;
}

export interface BatchFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
    strict?: boolean;
  };
}

export interface BatchToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface BatchChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  tool_calls?: BatchToolCall[];
  tool_call_id?: string;
}

export interface BatchChatCompletionRequest {
  model: string;
  messages: BatchChatMessage[];
  temperature?: number;
  max_completion_tokens?: number;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  tools?: BatchFunctionTool[];
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | {
        type: "function";
        function: {
          name: string;
        };
      };
}

export interface BatchRequestEntry {
  batch_request_id: string;
  batch_request: {
    chat_get_completion: BatchChatCompletionRequest;
  };
}

export interface BatchChatCompletionChoice {
  index?: number;
  finish_reason?: string | null;
  message: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: BatchToolCall[];
  };
}

export interface BatchChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_in_usd_ticks?: number;
}

export interface BatchChatCompletionResponse {
  id?: string;
  model?: string;
  choices: BatchChatCompletionChoice[];
  usage?: BatchChatCompletionUsage;
}

export interface BatchResultEntry {
  batch_request_id: string;
  error_message?: string;
  batch_result?: {
    error?: string;
    response?: {
      chat_get_completion?: BatchChatCompletionResponse;
    };
  };
}

export interface BatchResultsPage {
  results: BatchResultEntry[];
  pagination_token?: string | null;
}

export interface PollBatchRequestOptions extends BatchClientOptions {
  batchId: string;
  batchRequestId: string;
  timeoutMs?: number;
  initialPollMs?: number;
  maxPollMs?: number;
  pageSize?: number;
}

export async function createBatch(
  options: BatchClientOptions & {
    name: string;
    inputFileId?: string;
  },
): Promise<BatchInfo> {
  return requestJson<BatchInfo>({
    ...options,
    method: "POST",
    path: "/batches",
    body: {
      name: options.name,
      ...(options.inputFileId ? { input_file_id: options.inputFileId } : {}),
    },
    retryRateLimit: true,
  });
}

export async function addBatchRequests(
  options: BatchClientOptions & {
    batchId: string;
    batchRequests: BatchRequestEntry[];
  },
): Promise<void> {
  await requestJson<unknown>({
    ...options,
    method: "POST",
    path: `/batches/${encodeURIComponent(options.batchId)}/requests`,
    body: {
      batch_requests: options.batchRequests,
    },
  });
}

/**
 * Stop a batch's outstanding requests (`POST /v1/batches/{id}:cancel`).
 * Requests already processed stay billed; the rest are never run.
 */
export async function cancelBatch(
  options: BatchClientOptions & {
    batchId: string;
  },
): Promise<BatchInfo> {
  return requestJson<BatchInfo>({
    ...options,
    method: "POST",
    path: `/batches/${encodeURIComponent(options.batchId)}:cancel`,
  });
}

export async function getBatchStatus(
  options: BatchClientOptions & {
    batchId: string;
  },
): Promise<BatchInfo> {
  return requestJson<BatchInfo>({
    ...options,
    method: "GET",
    path: `/batches/${encodeURIComponent(options.batchId)}`,
  });
}

export async function listBatchResults(
  options: BatchClientOptions & {
    batchId: string;
    pageSize?: number;
    paginationToken?: string;
  },
): Promise<BatchResultsPage> {
  const search = new URLSearchParams();
  search.set("page_size", String(options.pageSize ?? DEFAULT_BATCH_PAGE_SIZE));
  if (options.paginationToken) {
    search.set("pagination_token", options.paginationToken);
  }

  return requestJson<BatchResultsPage>({
    ...options,
    method: "GET",
    path: `/batches/${encodeURIComponent(options.batchId)}/results?${search.toString()}`,
  });
}

export async function pollBatchRequestResult(options: PollBatchRequestOptions): Promise<BatchResultEntry> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const initialPollMs = options.initialPollMs ?? DEFAULT_INITIAL_POLL_MS;
  const maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  const pageSize = options.pageSize ?? DEFAULT_BATCH_PAGE_SIZE;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  // One absolute deadline bounds every request, body read, pagination step
  // and sleep below. The caller's signal is composed in so either can cancel;
  // the catch block keeps the two causes distinguishable.
  const scope = createDeadlineScope(options.signal, timeoutMs);
  const timeoutError = () =>
    new Error(
      `Timed out waiting for batch request "${options.batchRequestId}" in batch "${options.batchId}" after ${Math.round(timeoutMs / 1000)}s.`,
    );
  let delayMs = initialPollMs;

  try {
    while (true) {
      throwIfAborted(scope.signal);

      const match = await findBatchResult({
        ...options,
        signal: scope.signal,
        pageSize,
      });
      if (match && isBatchResultReady(match)) {
        return match;
      }

      await getBatchStatus({ ...options, signal: scope.signal });

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw timeoutError();
      }

      await sleep(Math.min(delayMs, remainingMs), scope.signal);
      delayMs = Math.min(Math.round(delayMs * 1.5), maxPollMs);
    }
  } catch (error: unknown) {
    if (isAbortError(error)) {
      if (options.signal?.aborted) {
        throw new Error("Request aborted");
      }
      if (scope.timedOut() || Date.now() >= deadline) {
        throw timeoutError();
      }
    }
    throw error;
  } finally {
    scope.dispose();
  }
}

export function getBatchChatCompletion(result: BatchResultEntry): BatchChatCompletionResponse {
  if (result.error_message) {
    throw new Error(`Batch request "${result.batch_request_id}" failed: ${result.error_message}`);
  }

  if (result.batch_result?.error) {
    throw new Error(`Batch request "${result.batch_request_id}" failed: ${result.batch_result.error}`);
  }

  const response = result.batch_result?.response?.chat_get_completion;
  if (!response) {
    throw new Error(`Batch request "${result.batch_request_id}" did not return a chat completion result.`);
  }

  return response;
}

async function findBatchResult(
  options: BatchClientOptions & {
    batchId: string;
    batchRequestId: string;
    pageSize: number;
  },
): Promise<BatchResultEntry | null> {
  let paginationToken: string | undefined;
  const seenTokens = new Set<string>();

  while (true) {
    const page = await listBatchResults({
      ...options,
      pageSize: options.pageSize,
      paginationToken,
    });
    const match = page.results.find((entry) => entry.batch_request_id === options.batchRequestId);
    if (match) {
      return match;
    }

    paginationToken = page.pagination_token ?? undefined;
    if (!paginationToken) {
      return null;
    }
    if (seenTokens.has(paginationToken)) {
      throw new Error(
        `Batch API returned a repeated pagination token while listing results for batch "${options.batchId}".`,
      );
    }
    seenTokens.add(paginationToken);
  }
}

function isBatchResultReady(result: BatchResultEntry): boolean {
  if (result.error_message) {
    return true;
  }
  if (result.batch_result?.response?.chat_get_completion) {
    return true;
  }
  if (result.batch_result?.error && !isTransientBatchResultError(result.batch_result.error)) {
    return true;
  }
  return false;
}

function isTransientBatchResultError(message: string): boolean {
  return message.includes("not yet visible in ClickHouse");
}

async function requestJson<T>(
  options: BatchClientOptions & {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    retryRateLimit?: boolean;
  },
): Promise<T> {
  const url = `${normalizeBaseUrl(options.baseURL)}${options.path.startsWith("/") ? options.path : `/${options.path}`}`;
  let attempt = 0;
  let delayMs = 500;

  while (true) {
    throwIfAborted(options.signal);

    const response = await raceAbort(
      fetch(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      }),
      options.signal,
    );

    if (response.ok) {
      return readJson<T>(response, options.signal);
    }

    if (options.retryRateLimit && response.status === 429 && attempt < DEFAULT_RATE_LIMIT_RETRIES) {
      const retryAfterMs = getRetryAfterMs(response) ?? delayMs;
      await sleep(retryAfterMs, options.signal);
      attempt += 1;
      delayMs = Math.min(delayMs * 2, 5_000);
      continue;
    }

    const errorText = await raceAbort(response.text(), options.signal);
    const suffix = errorText.trim() ? `: ${errorText.trim()}` : "";
    throw new Error(`Batch API ${options.method} ${options.path} failed (${response.status})${suffix}`);
  }
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  const text = await raceAbort(response.text(), signal);
  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Batch API returned invalid JSON: ${message}`);
  }
}

function normalizeBaseUrl(baseURL?: string): string {
  return (baseURL || process.env.CODESURF_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Request aborted");
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === "AbortError" || message === "Request aborted";
}

/**
 * Settle as soon as either the wrapped promise settles or the signal aborts.
 * fetch implementations are expected to honour their signal, but a stalled
 * socket or body stream that does not must still not outlive the deadline.
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new Error("Request aborted"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

interface DeadlineScope {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

const MAX_TIMER_MS = 2_147_483_647;

/** Compose the caller's signal with an absolute deadline into one signal. */
function createDeadlineScope(callerSignal: AbortSignal | undefined, timeoutMs: number): DeadlineScope {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.min(Math.max(0, timeoutMs), MAX_TIMER_MS),
  );

  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Request aborted"));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
