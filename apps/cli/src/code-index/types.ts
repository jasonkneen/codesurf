export type SemanticBackendSetting = "auto" | "local" | "openai" | "off";

export interface CodeChunkMetadata {
  startLine: number;
  endLine: number;
  language: string;
  functionName?: string;
}

export interface CodeChunk {
  content: string;
  metadata: CodeChunkMetadata;
}

/**
 * Identifies one embedding space. `identity` is the model plus any endpoint
 * configuration that changes the vectors it produces (an OpenAI-compatible
 * base URL, for instance). Vector stores are keyed on it, so retargeting the
 * endpoint while keeping the model name never reuses the old embeddings.
 */
export interface EmbeddingBackendRef {
  id: "local" | "openai";
  modelId: string;
  identity: string;
}

export interface EmbeddingBackend extends EmbeddingBackendRef {
  dimensions: number;
  /** Rejects with an `AbortError`-named error once `signal` fires. */
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  /**
   * Resolves to exactly one finite vector per input, in input order, all of
   * one dimension. Rejects on any partial or malformed response and on abort.
   */
  embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface SemanticIndexSettings {
  enabled: boolean;
  backend: SemanticBackendSetting;
  localModel: string;
  openaiModel: string;
  openaiApiKey: string;
  /**
   * Base URL for the OpenAI-compatible embeddings endpoint. Defaults to
   * OpenAI's public API. Point at `http://localhost:11434/v1` to use Ollama
   * or `http://localhost:1234/v1` to use LM Studio with whichever embedding
   * model is loaded there.
   */
  openaiBaseUrl: string;
}

export interface SemanticIndexStats {
  backendId: string;
  modelId: string;
  totalFiles: number;
  totalChunks: number;
  ready: boolean;
  error?: string;
}

export interface SemanticSearchHit {
  filePath: string;
  chunkIndex: number;
  content: string;
  similarity: number;
  metadata: CodeChunkMetadata;
  backendId: string;
  modelId: string;
}

export interface SemanticRefreshResult {
  /** True only when no backend failed and the refresh was not cancelled. */
  success: boolean;
  /** True when the caller's AbortSignal stopped the refresh before it completed. */
  cancelled: boolean;
  filesIndexed: number;
  chunksIndexed: number;
  backends: SemanticIndexStats[];
  error?: string;
}
