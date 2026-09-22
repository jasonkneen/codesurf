import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeChunkMetadata, SemanticIndexStats, SemanticSearchHit } from "./types.js";

interface VectorRecord {
  id: string;
  file_path: string;
  chunk_index: number;
  content: string;
  vector: number[];
  start_line: number;
  end_line: number;
  language: string;
  function_name: string;
  created_at: string;
}

interface MetaFile {
  files: Record<string, { hash: string; chunks: number }>;
}

export class SemanticVectorStore {
  private db: unknown | null = null;
  private table: unknown | null = null;
  private meta: MetaFile = { files: {} };
  /** Tail of the mutation queue; see `serialize`. */
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly backendId: string,
    private readonly modelId: string,
  ) {}

  async initialize(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    this.meta = this.readMeta();
    const lancedb = await import("@lancedb/lancedb");
    this.db = await lancedb.connect(this.dir);
    const names = await (this.db as { tableNames: () => Promise<string[]> }).tableNames();
    if (names.includes("chunks")) {
      this.table = await (this.db as { openTable: (name: string) => Promise<unknown> }).openTable("chunks");
    }
  }

  getFileHash(filePath: string): string | undefined {
    return this.meta.files[filePath]?.hash;
  }

  listFiles(): string[] {
    return Object.keys(this.meta.files);
  }

  /**
   * Runs one mutation after every previously queued one. Two refreshes that
   * share a store (tool call plus slash command, say) otherwise interleave
   * delete/add/metadata writes and publish a metadata file that disagrees with
   * the table.
   */
  private serialize<T>(mutation: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(mutation, mutation);
    this.mutations = run.catch(() => undefined);
    return run;
  }

  replaceFile(
    filePath: string,
    hash: string,
    chunks: Array<{ content: string; embedding: number[]; metadata: CodeChunkMetadata }>,
  ): Promise<void> {
    return this.serialize(() => this.replaceFileUnlocked(filePath, hash, chunks));
  }

  deleteFile(filePath: string): Promise<void> {
    return this.serialize(() => this.deleteFileUnlocked(filePath));
  }

  private async replaceFileUnlocked(
    filePath: string,
    hash: string,
    chunks: Array<{ content: string; embedding: number[]; metadata: CodeChunkMetadata }>,
  ): Promise<void> {
    await this.deleteFileUnlocked(filePath);
    if (chunks.length === 0) {
      delete this.meta.files[filePath];
      this.writeMeta();
      return;
    }

    const records: VectorRecord[] = chunks.map((chunk, chunkIndex) => ({
      id: `${filePath}:${chunkIndex}:${hash}`,
      file_path: filePath,
      chunk_index: chunkIndex,
      content: chunk.content,
      vector: chunk.embedding,
      start_line: chunk.metadata.startLine,
      end_line: chunk.metadata.endLine,
      language: chunk.metadata.language,
      function_name: chunk.metadata.functionName ?? "",
      created_at: new Date().toISOString(),
    }));

    if (!this.table) {
      this.table = await (
        this.db as { createTable: (name: string, records: VectorRecord[]) => Promise<unknown> }
      ).createTable("chunks", records);
    } else {
      await (this.table as { add: (records: VectorRecord[]) => Promise<void> }).add(records);
    }
    this.meta.files[filePath] = { hash, chunks: chunks.length };
    this.writeMeta();
  }

  private async deleteFileUnlocked(filePath: string): Promise<void> {
    if (this.table) {
      const escaped = filePath.replace(/'/g, "''");
      await (this.table as { delete: (where: string) => Promise<void> }).delete(`file_path = '${escaped}'`);
    }
    delete this.meta.files[filePath];
    this.writeMeta();
  }

  async search(queryEmbedding: number[], limit: number, threshold: number): Promise<SemanticSearchHit[]> {
    if (!this.table) return [];
    const rows = await (
      this.table as {
        vectorSearch: (embedding: number[]) => {
          limit: (limit: number) => { toArray: () => Promise<Array<Record<string, unknown>>> };
        };
      }
    )
      .vectorSearch(queryEmbedding)
      .limit(limit * 2)
      .toArray();

    const hits: SemanticSearchHit[] = [];
    for (const row of rows) {
      const distance = typeof row._distance === "number" ? row._distance : 0;
      const similarity = 1 / (1 + distance);
      if (similarity < threshold) continue;
      hits.push({
        filePath: row.file_path as string,
        chunkIndex: row.chunk_index as number,
        content: row.content as string,
        similarity,
        metadata: {
          startLine: row.start_line as number,
          endLine: row.end_line as number,
          language: row.language as string,
          functionName: (row.function_name as string | undefined) || undefined,
        },
        backendId: this.backendId,
        modelId: this.modelId,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  stats(error?: string): SemanticIndexStats {
    const totalFiles = Object.keys(this.meta.files).length;
    const totalChunks = Object.values(this.meta.files).reduce((sum, file) => sum + file.chunks, 0);
    return {
      backendId: this.backendId,
      modelId: this.modelId,
      totalFiles,
      totalChunks,
      ready: totalChunks > 0 && !error,
      ...(error ? { error } : {}),
    };
  }

  clear(): void {
    if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
    this.db = null;
    this.table = null;
    this.meta = { files: {} };
  }

  private readMeta(): MetaFile {
    const file = this.metaPath();
    try {
      if (!existsSync(file) || !statSync(file).isFile()) return { files: {} };
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<MetaFile>;
      return parsed.files && typeof parsed.files === "object" ? { files: parsed.files } : { files: {} };
    } catch {
      return { files: {} };
    }
  }

  private writeMeta(): void {
    const file = this.metaPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(this.meta, null, 2)}\n`, "utf-8");
  }

  private metaPath(): string {
    return join(this.dir, "metadata.json");
  }
}
