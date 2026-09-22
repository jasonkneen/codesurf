import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeChunkMetadata } from "./types.js";
import { SemanticVectorStore } from "./vector-store.js";

// LanceDB is replaced by an in-memory table that logs operations and lets the
// test hold one `add` open, so the interleaving of two concurrent mutations is
// observable and deterministic.
const lance = vi.hoisted(() => {
  const ops: string[] = [];
  const state: { addGate: Promise<void> | null; failAddFor: string | null } = { addGate: null, failAddFor: null };
  const table = {
    async delete(where: string): Promise<void> {
      ops.push(`delete ${where}`);
    },
    async add(records: Array<{ file_path: string }>): Promise<void> {
      const file = records[0]!.file_path;
      ops.push(`add ${file}`);
      if (state.failAddFor === file) throw new Error(`add failed for ${file}`);
      if (state.addGate) await state.addGate;
    },
  };
  const db = {
    async tableNames(): Promise<string[]> {
      return ["chunks"];
    },
    async openTable(): Promise<typeof table> {
      return table;
    },
  };
  return { ops, state, db };
});

vi.mock("@lancedb/lancedb", () => ({ connect: async () => lance.db }));

const metadata: CodeChunkMetadata = { startLine: 1, endLine: 1, language: "typescript" };
const row = { content: "export const a = 1;", embedding: [0.1, 0.2], metadata };

describe("SemanticVectorStore mutation serialization (I4)", () => {
  let dir: string;
  let store: SemanticVectorStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-vector-store-"));
    lance.ops.length = 0;
    lance.state.addGate = null;
    lance.state.failAddFor = null;
    store = new SemanticVectorStore(dir, "openai", "text-embedding-3-small");
    await store.initialize();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs concurrent replaceFile calls one after another, never interleaving delete/add/metadata", async () => {
    let release!: () => void;
    lance.state.addGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = store.replaceFile("a.ts", "h1", [row]);
    const second = store.replaceFile("b.ts", "h2", [row]);

    await vi.waitFor(() => expect(lance.ops).toContain("add a.ts"));
    // b.ts has not started while a.ts's add is still open.
    expect(lance.ops).toEqual(["delete file_path = 'a.ts'", "add a.ts"]);
    expect(store.listFiles()).toEqual([]);

    lance.state.addGate = null;
    release();
    await Promise.all([first, second]);

    expect(lance.ops).toEqual(["delete file_path = 'a.ts'", "add a.ts", "delete file_path = 'b.ts'", "add b.ts"]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf-8")) as {
      files: Record<string, { hash: string; chunks: number }>;
    };
    expect(meta.files).toEqual({ "a.ts": { hash: "h1", chunks: 1 }, "b.ts": { hash: "h2", chunks: 1 } });
    expect(store.stats()).toMatchObject({ totalFiles: 2, totalChunks: 2, ready: true });
  });

  it("orders deleteFile behind an in-flight replaceFile", async () => {
    let release!: () => void;
    lance.state.addGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const replace = store.replaceFile("a.ts", "h1", [row]);
    const remove = store.deleteFile("a.ts");
    await vi.waitFor(() => expect(lance.ops).toContain("add a.ts"));
    expect(lance.ops).toEqual(["delete file_path = 'a.ts'", "add a.ts"]);

    lance.state.addGate = null;
    release();
    await Promise.all([replace, remove]);
    expect(lance.ops).toEqual(["delete file_path = 'a.ts'", "add a.ts", "delete file_path = 'a.ts'"]);
    expect(store.getFileHash("a.ts")).toBeUndefined();
  });

  it("does not let a failed mutation block the ones queued behind it", async () => {
    lance.state.failAddFor = "bad.ts";
    const failed = store.replaceFile("bad.ts", "h1", [row]);
    const next = store.replaceFile("ok.ts", "h2", [row]);

    await expect(failed).rejects.toThrow(/add failed for bad.ts/);
    await expect(next).resolves.toBeUndefined();
    expect(store.getFileHash("bad.ts")).toBeUndefined();
    expect(store.getFileHash("ok.ts")).toBe("h2");
  });
});
