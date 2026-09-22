import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { getCodesurfConfigDir } from "../utils/config-dir.js";
import type { FileIndex } from "../utils/file-index.js";
import { chunkCode } from "./chunker.js";
import {
  configuredEmbeddingBackendRefs,
  createEmbeddingBackends,
  throwIfAborted,
  tryCreateEmbeddingBackends,
  validateEmbeddings,
} from "./embeddings.js";
import type {
  EmbeddingBackend,
  EmbeddingBackendRef,
  SemanticIndexSettings,
  SemanticIndexStats,
  SemanticRefreshResult,
  SemanticSearchHit,
} from "./types.js";
import { SemanticVectorStore } from "./vector-store.js";

const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const DEFAULT_THRESHOLD = 0.3;
const ABORT_MESSAGE = "Semantic refresh aborted";

/**
 * One vector store per backend identity. `pending` is set synchronously on
 * first access so concurrent callers share one initialization; `store` is
 * filled in by the first caller to observe that initialization complete.
 */
interface StoreEntry {
  pending: Promise<SemanticVectorStore>;
  store?: SemanticVectorStore;
}

/**
 * Progress event for a semantic refresh. `phase` lets a UI distinguish "we
 * loaded backends" from "we're embedding file 42/384" so it can render a
 * coherent status line without spamming the transcript.
 */
export interface SemanticRefreshProgress {
  /** `cancelled` replaces `done` when the caller's AbortSignal stopped the refresh. */
  phase: "start" | "file" | "skip" | "delete" | "backend-done" | "done" | "cancelled";
  backendId?: string;
  modelId?: string;
  /** 1-based file index for "file" / "skip" events. */
  fileIndex?: number;
  /** Total files this backend will visit (set on `start` and onward). */
  totalFiles?: number;
  /** File path being processed, when applicable. */
  filePath?: string;
  /** Chunks embedded for this file (file events). */
  chunks?: number;
  /** Aggregate so far for this backend. */
  filesIndexed?: number;
  chunksIndexed?: number;
}

export interface SemanticRefreshOptions {
  onProgress?: (event: SemanticRefreshProgress) => void;
  /** AbortSignal so the host can cancel a long-running refresh. */
  signal?: AbortSignal;
}

export class SemanticCodeIndex {
  private stores = new Map<string, StoreEntry>();
  /** Bumped by `clear()` so a store still initializing across the wipe is never published. */
  private generation = 0;

  constructor(private readonly cwd: string) {}

  async refresh(
    fileIndex: FileIndex,
    settings: SemanticIndexSettings,
    options: SemanticRefreshOptions = {},
  ): Promise<SemanticRefreshResult> {
    const onProgress = options.onProgress;
    const signal = options.signal;
    const backendsStats: SemanticIndexStats[] = [];

    let backends: EmbeddingBackend[];
    try {
      throwIfAborted(signal, ABORT_MESSAGE);
      const created = await tryCreateEmbeddingBackends(settings, signal);
      backends = created.backends;
      // Surface backend-creation failures (e.g. transformers.js failed to load,
      // model download blocked) instead of silently returning 0/0.
      for (const failure of created.failures) {
        backendsStats.push({
          backendId: failure.id,
          modelId: failure.modelId,
          totalFiles: 0,
          totalChunks: 0,
          ready: false,
          error: failure.message,
        });
      }
    } catch (err) {
      if (!signal?.aborted) throw err;
      // Cancelled before any backend could start: nothing was touched.
      onProgress?.({ phase: "cancelled", filesIndexed: 0, chunksIndexed: 0 });
      return {
        success: false,
        cancelled: true,
        filesIndexed: 0,
        chunksIndexed: 0,
        backends: backendsStats,
        error: ABORT_MESSAGE,
      };
    }

    if (backends.length === 0) {
      const success = backendsStats.length === 0;
      return {
        success,
        cancelled: false,
        filesIndexed: 0,
        chunksIndexed: 0,
        backends: backendsStats,
        ...(success ? {} : { error: backendsStats[0]!.error }),
      };
    }

    const files = await fileIndex.list();
    const live = new Set(files);
    let filesIndexed = 0;
    let chunksIndexed = 0;
    let cancelled = false;

    for (const backend of backends) {
      try {
        throwIfAborted(signal, ABORT_MESSAGE);
        const store = await this.getStore(backend);

        // Phase 1: delete stale files. A capped (truncated) listing omits real
        // files, so there only delete vectors whose file is actually gone.
        for (const stale of store.listFiles()) {
          throwIfAborted(signal, ABORT_MESSAGE);
          if (!live.has(stale) && (!fileIndex.truncated || !existsSync(fileIndex.resolvePath(stale)))) {
            await store.deleteFile(stale);
            onProgress?.({ phase: "delete", backendId: backend.id, modelId: backend.modelId, filePath: stale });
          }
        }

        onProgress?.({
          phase: "start",
          backendId: backend.id,
          modelId: backend.modelId,
          totalFiles: files.length,
        });

        // Phase 2: embed live files
        let backendFiles = 0;
        let backendChunks = 0;
        for (let i = 0; i < files.length; i++) {
          throwIfAborted(signal, ABORT_MESSAGE);
          const relPath = files[i]!;
          const absPath = fileIndex.resolvePath(relPath);
          const content = readIndexableFile(absPath);
          if (content === null) {
            onProgress?.({
              phase: "skip",
              backendId: backend.id,
              modelId: backend.modelId,
              fileIndex: i + 1,
              totalFiles: files.length,
              filePath: relPath,
            });
            continue;
          }
          const hash = hashContent(content);
          if (store.getFileHash(relPath) === hash) {
            onProgress?.({
              phase: "skip",
              backendId: backend.id,
              modelId: backend.modelId,
              fileIndex: i + 1,
              totalFiles: files.length,
              filePath: relPath,
              filesIndexed: backendFiles,
              chunksIndexed: backendChunks,
            });
            continue;
          }
          const chunks = chunkCode(content, relPath);
          if (chunks.length === 0) {
            // Empty/whitespace-only file. Still clear any prior rows.
            await store.replaceFile(relPath, hash, []);
            continue;
          }
          // Use real batching here: the local backend caps batch size
          // internally, OpenAI sends in one request when small. The file's
          // revision is only recorded once every chunk has a valid vector;
          // a partial response throws and leaves the previous rows in place
          // so the next refresh retries the file.
          const embeddings = validateEmbeddings(
            await backend.embedBatch(
              chunks.map((chunk) => chunk.content),
              signal,
            ),
            chunks.length,
            `${backend.id}/${backend.modelId}`,
          );
          // A cancellation that lands after embedding must not publish rows.
          throwIfAborted(signal, ABORT_MESSAGE);
          const rows = chunks.map((chunk, index) => ({
            content: chunk.content,
            metadata: chunk.metadata,
            embedding: embeddings[index]!,
          }));
          await store.replaceFile(relPath, hash, rows);
          filesIndexed++;
          backendFiles++;
          chunksIndexed += rows.length;
          backendChunks += rows.length;
          onProgress?.({
            phase: "file",
            backendId: backend.id,
            modelId: backend.modelId,
            fileIndex: i + 1,
            totalFiles: files.length,
            filePath: relPath,
            chunks: rows.length,
            filesIndexed: backendFiles,
            chunksIndexed: backendChunks,
          });
        }
        const stats = store.stats();
        backendsStats.push(stats);
        onProgress?.({
          phase: "backend-done",
          backendId: backend.id,
          modelId: backend.modelId,
          filesIndexed: stats.totalFiles,
          chunksIndexed: stats.totalChunks,
        });
      } catch (err) {
        backendsStats.push({
          backendId: backend.id,
          modelId: backend.modelId,
          totalFiles: 0,
          totalChunks: 0,
          ready: false,
          error: err instanceof Error ? err.message : String(err),
        });
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
      }
    }

    // Success is earned by completed work only: a cancelled or failed backend
    // must not be reported as a finished refresh.
    const firstError = cancelled ? ABORT_MESSAGE : backendsStats.find((stats) => stats.error)?.error;
    onProgress?.({ phase: cancelled ? "cancelled" : "done", filesIndexed, chunksIndexed });
    return {
      success: firstError === undefined,
      cancelled,
      filesIndexed,
      chunksIndexed,
      backends: backendsStats,
      ...(firstError === undefined ? {} : { error: firstError }),
    };
  }

  async search(settings: SemanticIndexSettings, query: string, limit = 12): Promise<SemanticSearchHit[]> {
    const backends = await createEmbeddingBackends(settings);
    const hits: SemanticSearchHit[] = [];
    for (const backend of backends) {
      try {
        const store = await this.getStore(backend);
        const queryEmbedding = await backend.embed(query);
        hits.push(...(await store.search(queryEmbedding, limit, DEFAULT_THRESHOLD)));
      } catch {
        // Semantic retrieval is opportunistic; caller will fall back to path index.
      }
    }
    return mergeHits(hits, limit);
  }

  async status(settings: SemanticIndexSettings): Promise<SemanticIndexStats[]> {
    const backends = configuredEmbeddingBackendRefs(settings);
    const stats: SemanticIndexStats[] = [];
    for (const backend of backends) {
      try {
        const store = await this.getStore(backend);
        stats.push(store.stats());
      } catch (err) {
        stats.push({
          backendId: backend.id,
          modelId: backend.modelId,
          totalFiles: 0,
          totalChunks: 0,
          ready: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return stats;
  }

  clear(): void {
    // Bump first: a store whose initialization straddles this wipe read its
    // metadata before the delete, so getStore discards it instead of publishing it.
    this.generation++;
    const entries = [...this.stores.values()];
    this.stores.clear();
    for (const entry of entries) entry.store?.clear();
    const base = workspaceIndexDir(this.cwd);
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  }

  private async getStore(backend: EmbeddingBackendRef): Promise<SemanticVectorStore> {
    const key = `${backend.id}:${backend.identity}`;
    const generation = this.generation;
    let entry = this.stores.get(key);
    if (!entry) {
      const dir = join(workspaceIndexDir(this.cwd), safeSegment(backend.id), safeSegment(backend.identity));
      const created: StoreEntry = {
        pending: (async () => {
          const store = new SemanticVectorStore(dir, backend.id, backend.modelId);
          await store.initialize();
          return store;
        })(),
      };
      this.stores.set(key, created);
      entry = created;
    }
    try {
      const store = await entry.pending;
      entry.store = store;
      if (this.generation === generation) return store;
    } catch (err) {
      // A failed initialization must not poison the cache; the next caller retries.
      if (this.stores.get(key) === entry) this.stores.delete(key);
      throw err;
    }
    // clear() ran while this store was initializing. Its metadata predates the
    // wipe, so build a fresh one against the now-empty directory.
    return this.getStore(backend);
  }
}

export function semanticSettingsFrom(
  get: <T = unknown>(key: string, fallback?: T) => T | undefined,
): SemanticIndexSettings {
  return {
    enabled: get<boolean>("knowledge.semantic.enabled", true) ?? true,
    backend: get<SemanticIndexSettings["backend"]>("knowledge.semantic.backend", "auto") ?? "auto",
    localModel: get<string>("knowledge.semantic.localModel", "Xenova/all-MiniLM-L6-v2") ?? "Xenova/all-MiniLM-L6-v2",
    openaiModel: get<string>("knowledge.semantic.openaiModel", "text-embedding-3-small") ?? "text-embedding-3-small",
    openaiApiKey: process.env.OPENAI_API_KEY || get<string>("knowledge.openai.apiKey", "") || "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL || get<string>("knowledge.semantic.openaiBaseUrl", "") || "",
  };
}

function readIndexableFile(filePath: string): string | null {
  try {
    // lstat, not stat: a committed symlink may point at secrets outside the
    // repo, and indexed content is sent to the embedding provider.
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_INDEXED_FILE_BYTES) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function mergeHits(hits: SemanticSearchHit[], limit: number): SemanticSearchHit[] {
  const best = new Map<string, SemanticSearchHit>();
  for (const hit of hits) {
    const key = `${hit.filePath}:${hit.metadata.startLine}:${hit.metadata.endLine}`;
    const current = best.get(key);
    if (!current || hit.similarity > current.similarity) best.set(key, hit);
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

function workspaceIndexDir(cwd: string): string {
  return join(getCodesurfConfigDir(), "indexes", workspaceHash(cwd));
}

function workspaceHash(cwd: string): string {
  return createHash("sha256")
    .update(relative("/", cwd) || cwd)
    .digest("hex")
    .slice(0, 16);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
