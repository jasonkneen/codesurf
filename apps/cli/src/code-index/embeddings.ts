import { join } from "node:path";
import { getCodesurfConfigDir } from "../utils/config-dir.js";
import type { EmbeddingBackend, EmbeddingBackendRef, SemanticIndexSettings } from "./types.js";

const DEFAULT_LOCAL_DIMENSIONS = 384;
const LOCAL_BATCH_SIZE = 16; // Cap WASM memory pressure on transformers.js mean-pool.
const OPENAI_BATCH_SIZE = 96; // OpenAI accepts up to 2048; 96 is a polite default.
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  // Common local OpenAI-compatible embedding models (Ollama, LM Studio).
  // The real vector length comes from the API response, so this map is just
  // a metadata hint and never affects correctness.
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "bge-m3": 1024,
  "all-minilm": 384,
};

export interface EmbeddingBackendFailure {
  id: "local" | "openai";
  modelId: string;
  message: string;
}

export interface EmbeddingBackendsResult {
  backends: EmbeddingBackend[];
  failures: EmbeddingBackendFailure[];
}

/** Error raised when an AbortSignal fires; `name` follows the DOM `AbortError` convention. */
export function abortError(message = "Embedding aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined, message?: string): void {
  if (signal?.aborted) throw abortError(message);
}

/**
 * Build the configured embedding backends, returning successes and failures
 * separately so callers can surface "tried local, transformers failed" instead
 * of silently degrading to zero backends.
 */
export async function tryCreateEmbeddingBackends(
  settings: SemanticIndexSettings,
  signal?: AbortSignal,
): Promise<EmbeddingBackendsResult> {
  if (!settings.enabled || settings.backend === "off") return { backends: [], failures: [] };
  const backends: EmbeddingBackend[] = [];
  const failures: EmbeddingBackendFailure[] = [];

  if (settings.backend === "auto" || settings.backend === "local") {
    throwIfAborted(signal);
    try {
      backends.push(await createLocalEmbeddingBackend(settings.localModel));
    } catch (err) {
      // An abort while the model loads is a cancellation, not a backend failure.
      throwIfAborted(signal);
      failures.push({
        id: "local",
        modelId: settings.localModel,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if ((settings.backend === "auto" || settings.backend === "openai") && settings.openaiApiKey.trim()) {
    throwIfAborted(signal);
    backends.push(
      createOpenAIEmbeddingBackend(
        settings.openaiModel,
        settings.openaiApiKey.trim(),
        resolveOpenAIBaseUrl(settings.openaiBaseUrl),
      ),
    );
  }

  return { backends, failures };
}

function resolveOpenAIBaseUrl(url: string | undefined): string {
  const trimmed = (url ?? "").trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_OPENAI_BASE_URL;
}

/**
 * The default endpoint keeps the bare model id so existing on-disk stores stay
 * valid; any other endpoint is part of the identity because the same model
 * name on another server is a different embedding space.
 */
function openaiIdentity(modelId: string, baseUrl: string): string {
  return baseUrl === DEFAULT_OPENAI_BASE_URL ? modelId : `${modelId}@${baseUrl}`;
}

/**
 * Backwards-compatible thin wrapper. Existing callers that don't need to
 * surface failures still get the same behavior (silent drop on backend creation
 * errors).
 */
export async function createEmbeddingBackends(
  settings: SemanticIndexSettings,
  signal?: AbortSignal,
): Promise<EmbeddingBackend[]> {
  const { backends } = await tryCreateEmbeddingBackends(settings, signal);
  return backends;
}

export function configuredEmbeddingBackendRefs(settings: SemanticIndexSettings): EmbeddingBackendRef[] {
  if (!settings.enabled || settings.backend === "off") return [];
  const refs: EmbeddingBackendRef[] = [];
  if (settings.backend === "auto" || settings.backend === "local") {
    refs.push({ id: "local", modelId: settings.localModel, identity: settings.localModel });
  }
  if ((settings.backend === "auto" || settings.backend === "openai") && settings.openaiApiKey.trim()) {
    refs.push({
      id: "openai",
      modelId: settings.openaiModel,
      identity: openaiIdentity(settings.openaiModel, resolveOpenAIBaseUrl(settings.openaiBaseUrl)),
    });
  }
  return refs;
}

async function createLocalEmbeddingBackend(modelId: string): Promise<EmbeddingBackend> {
  const transformers = await import("@xenova/transformers");
  transformers.env.cacheDir = join(getCodesurfConfigDir(), "indexes", "models");
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = true;
  const extractor = await transformers.pipeline("feature-extraction", modelId);

  // Single code path for one or many inputs. Transformers.js mean-pools across
  // padded tokens, so identical text in a batch vs alone produces vectors that
  // are *close* but not bit-identical (delta ~1e-2 on normalized vectors).
  // We always go through the array form so query embeddings and stored
  // embeddings share the same padding/pooling semantics — keeps cosine
  // similarities comparable.
  async function embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const truncated = texts.map(truncateForLocal);
    const result = await extractor(truncated, { pooling: "mean", normalize: true });
    return sliceEmbeddings(result, truncated.length, DEFAULT_LOCAL_DIMENSIONS);
  }

  const label = `local/${modelId}`;
  return {
    id: "local",
    modelId,
    identity: modelId,
    dimensions: DEFAULT_LOCAL_DIMENSIONS,
    embed: async (text, signal) => (await embedInBatches([text], LOCAL_BATCH_SIZE, embedTexts, label, signal))[0]!,
    embedBatch: async (texts, signal) => embedInBatches(texts, LOCAL_BATCH_SIZE, embedTexts, label, signal),
  };
}

function createOpenAIEmbeddingBackend(modelId: string, apiKey: string, baseUrl: string): EmbeddingBackend {
  const endpoint = `${baseUrl}/embeddings`;
  async function embedOne(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, input: texts }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Embeddings call failed (${response.status} ${endpoint}): ${body.slice(0, 240)}`);
    }
    const json = (await response.json()) as { data?: unknown };
    return mapEmbeddingRows(json.data, texts.length, endpoint);
  }

  return {
    id: "openai",
    modelId,
    identity: openaiIdentity(modelId, baseUrl),
    dimensions: OPENAI_DIMENSIONS[modelId] ?? 1536,
    embed: async (text, signal) => (await embedInBatches([text], OPENAI_BATCH_SIZE, embedOne, endpoint, signal))[0]!,
    embedBatch: async (texts, signal) => embedInBatches(texts, OPENAI_BATCH_SIZE, embedOne, endpoint, signal),
  };
}

/**
 * Places OpenAI-style `{ index, embedding }` rows by their declared index and
 * refuses anything short of exactly one row per input: a missing, duplicate or
 * out-of-range index would otherwise pair chunks with the wrong text or drop
 * them, and the caller would still record the file as fully indexed.
 */
export function mapEmbeddingRows(data: unknown, expected: number, source: string): number[][] {
  if (!Array.isArray(data)) throw new Error(`Embeddings response from ${source} has no data array`);
  if (data.length !== expected) {
    throw new Error(`Embeddings response from ${source} returned ${data.length} rows for ${expected} inputs`);
  }
  const vectors: Array<number[] | undefined> = new Array(expected).fill(undefined);
  const seen = new Set<number>();
  for (const row of data as Array<{ index?: unknown; embedding?: unknown } | null>) {
    const index = row?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= expected) {
      throw new Error(`Embeddings response from ${source} has row index ${String(index)} outside 0..${expected - 1}`);
    }
    if (seen.has(index)) throw new Error(`Embeddings response from ${source} has duplicate row index ${index}`);
    seen.add(index);
    vectors[index] = row?.embedding as number[] | undefined;
  }
  return validateEmbeddings(vectors, expected, source);
}

/**
 * Asserts exactly one non-empty vector of finite numbers per input, all of one
 * dimension, and returns the narrowed array. Every embedding path runs through
 * this before a file revision can be committed on top of the vectors.
 */
export function validateEmbeddings(
  vectors: ReadonlyArray<number[] | undefined>,
  expected: number,
  source: string,
): number[][] {
  if (vectors.length !== expected) {
    throw new Error(`${source} returned ${vectors.length} embeddings for ${expected} inputs`);
  }
  let dimensions = 0;
  for (let i = 0; i < expected; i++) {
    const vector = vectors[i];
    if (!Array.isArray(vector) || vector.length === 0)
      throw new Error(`${source} returned no embedding for input ${i}`);
    if (dimensions === 0) dimensions = vector.length;
    if (vector.length !== dimensions) {
      throw new Error(
        `${source} returned a ${vector.length}-dimensional embedding for input ${i}, expected ${dimensions}`,
      );
    }
    for (const value of vector) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${source} returned a non-finite embedding for input ${i}`);
      }
    }
  }
  return vectors as number[][];
}

/**
 * Splits `texts` into chunks of `batchSize` and concatenates the validated
 * per-batch outputs in order. Checks `signal` before every batch so a cancelled
 * refresh stops issuing requests instead of finishing the whole file.
 */
async function embedInBatches(
  texts: string[],
  batchSize: number,
  runBatch: (slice: string[], signal?: AbortSignal) => Promise<number[][]>,
  source: string,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    throwIfAborted(signal);
    const slice = texts.slice(i, i + batchSize);
    const vectors = validateEmbeddings(await runBatch(slice, signal), slice.length, source);
    if (out.length > 0 && vectors[0]!.length !== out[0]!.length) {
      throw new Error(`${source} changed embedding dimensions between batches`);
    }
    for (const v of vectors) out.push(v);
  }
  return out;
}

/**
 * The transformers.js feature-extraction pipeline returns one flat Float32Array
 * of shape `[batch, hidden]` (or sometimes `[batch, 1, hidden]`). Slice it back
 * into per-input rows.
 */
function sliceEmbeddings(result: unknown, expectedRows: number, fallbackDim: number): number[][] {
  const tensor = result as { data: Float32Array; dims: number[] };
  const data = tensor.data;
  const dims = tensor.dims ?? [];
  // Pick the trailing non-1 dimension as the hidden size. For mean-pooled
  // feature-extraction output the shape is [batch, hidden]; older builds
  // return [batch, 1, hidden]. Both reduce to "last axis is hidden size."
  const hidden = dims.length > 0 ? dims[dims.length - 1]! : fallbackDim;
  if (!Number.isFinite(hidden) || hidden <= 0) return [];

  const rows: number[][] = [];
  for (let r = 0; r < expectedRows; r++) {
    const start = r * hidden;
    const end = start + hidden;
    if (end > data.length) break;
    rows.push(Array.from(data.subarray(start, end)));
  }
  return rows;
}

function truncateForLocal(text: string): string {
  return text.length <= 1_024 ? text : text.slice(0, 1_024);
}
