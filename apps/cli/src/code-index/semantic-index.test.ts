import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileIndex } from "../utils/file-index.js";
import { SemanticCodeIndex, type SemanticRefreshProgress, semanticSettingsFrom } from "./semantic-index.js";
import type { SemanticIndexSettings } from "./types.js";

describe("semantic index settings", () => {
  it("defaults to auto hybrid with local and OpenAI defaults", () => {
    const settings = semanticSettingsFrom(<T>(_key: string, fallback?: T) => fallback);
    expect(settings).toMatchObject({
      enabled: true,
      backend: "auto",
      localModel: "Xenova/all-MiniLM-L6-v2",
      openaiModel: "text-embedding-3-small",
      openaiApiKey: "",
    });
  });

  it("reads openaiBaseUrl from settings, with OPENAI_BASE_URL env taking precedence", () => {
    const priorBase = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      const fromSetting = semanticSettingsFrom(
        <T>(key: string, fallback?: T) =>
          (key === "knowledge.semantic.openaiBaseUrl" ? "http://localhost:11434/v1" : fallback) as T,
      );
      expect(fromSetting.openaiBaseUrl).toBe("http://localhost:11434/v1");

      process.env.OPENAI_BASE_URL = "http://localhost:1234/v1";
      const fromEnv = semanticSettingsFrom(
        <T>(key: string, fallback?: T) =>
          (key === "knowledge.semantic.openaiBaseUrl" ? "http://localhost:11434/v1" : fallback) as T,
      );
      expect(fromEnv.openaiBaseUrl).toBe("http://localhost:1234/v1");
    } finally {
      if (priorBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = priorBase;
    }
  });

  it("prefers OPENAI_API_KEY over persisted extension setting", () => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-key";
    try {
      const settings = semanticSettingsFrom(
        <T>(key: string, fallback?: T) => (key === "knowledge.openai.apiKey" ? "stored-key" : fallback) as T,
      );
      expect(settings.openaiApiKey).toBe("env-key");
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
    }
  });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function vectorsFor(inputs: string[], dimensions = 1536): Array<{ embedding: number[]; index: number }> {
  return inputs.map((_, i) => ({ embedding: Array.from({ length: dimensions }, () => 0.1), index: i }));
}

// Real LanceDB IO: each test opens a fresh store, so allow for a loaded machine.
describe("SemanticCodeIndex.refresh with injected fake backend", { timeout: 20_000 }, () => {
  let configDir: string;
  let workspaceDir: string;
  let priorConfigDir: string | undefined;

  function fakeOpenAIBackend(captured: { batchSizes: number[] }): void {
    // We pose as an "openai" backend via the existing fetch path so we don't
    // need to monkey-patch tryCreateEmbeddingBackends. The fake API returns
    // deterministic vectors of length 1536.
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      captured.batchSizes.push(body.input.length);
      const data = body.input.map((_, i) => ({
        embedding: Array.from({ length: 1536 }, () => 0.1),
        index: i,
      }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-sem-config-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-sem-workspace-"));
    priorConfigDir = process.env.CODESURF_CONFIG_DIR;
    process.env.CODESURF_CONFIG_DIR = configDir;

    // Make the workspace look like a git repo so FileIndex uses git ls-files.
    execSync("git init -q", { cwd: workspaceDir });
    execSync("git config user.email test@example.com", { cwd: workspaceDir });
    execSync("git config user.name test", { cwd: workspaceDir });
    fs.writeFileSync(path.join(workspaceDir, "a.ts"), "export function a() { return 1; }\n");
    fs.writeFileSync(path.join(workspaceDir, "b.ts"), "export function b() { return 2; }\n");
    fs.writeFileSync(path.join(workspaceDir, "c.ts"), "export function c() { return 3; }\n");
    execSync("git add -A && git commit -q -m init", { cwd: workspaceDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (priorConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
    else process.env.CODESURF_CONFIG_DIR = priorConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function openaiOnly(): SemanticIndexSettings {
    return {
      enabled: true,
      backend: "openai",
      localModel: "Xenova/all-MiniLM-L6-v2",
      openaiModel: "text-embedding-3-small",
      openaiApiKey: "sk-test",
      openaiBaseUrl: "",
    };
  }

  it("emits start, file, and backend-done progress events for each backend", async () => {
    const captured = { batchSizes: [] as number[] };
    fakeOpenAIBackend(captured);

    const semantic = new SemanticCodeIndex(workspaceDir);
    const fileIndex = new FileIndex(workspaceDir);
    await fileIndex.refresh();

    const events: SemanticRefreshProgress[] = [];
    const result = await semantic.refresh(fileIndex, openaiOnly(), {
      onProgress: (e) => events.push(e),
    });

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(3);
    expect(result.chunksIndexed).toBeGreaterThanOrEqual(3);
    expect(result.backends[0]).toMatchObject({ backendId: "openai", ready: true });
    expect(events.find((e) => e.phase === "start")).toBeTruthy();
    expect(events.filter((e) => e.phase === "file")).toHaveLength(3);
    expect(events.find((e) => e.phase === "backend-done")).toBeTruthy();
    expect(events[events.length - 1]?.phase).toBe("done");
    // All chunks for each tiny file fit in a single OpenAI request.
    expect(captured.batchSizes.every((n) => n >= 1)).toBe(true);
  });

  it("skips files whose content hash matches the previous refresh", async () => {
    const captured = { batchSizes: [] as number[] };
    fakeOpenAIBackend(captured);

    const semantic = new SemanticCodeIndex(workspaceDir);
    const fileIndex = new FileIndex(workspaceDir);
    await fileIndex.refresh();
    await semantic.refresh(fileIndex, openaiOnly());

    const events: SemanticRefreshProgress[] = [];
    const result = await semantic.refresh(fileIndex, openaiOnly(), {
      onProgress: (e) => events.push(e),
    });

    // No files re-embedded.
    expect(result.filesIndexed).toBe(0);
    expect(result.chunksIndexed).toBe(0);
    expect(events.filter((e) => e.phase === "file")).toHaveLength(0);
    expect(events.filter((e) => e.phase === "skip").length).toBeGreaterThanOrEqual(3);
  });

  it("reports a distinct cancelled outcome when aborted before initialization", async () => {
    const captured = { batchSizes: [] as number[] };
    fakeOpenAIBackend(captured);
    const semantic = new SemanticCodeIndex(workspaceDir);
    const fileIndex = new FileIndex(workspaceDir);
    await fileIndex.refresh();
    const controller = new AbortController();
    controller.abort();

    const events: SemanticRefreshProgress[] = [];
    const result = await semantic.refresh(fileIndex, openaiOnly(), {
      signal: controller.signal,
      onProgress: (e) => events.push(e),
    });

    expect(result).toMatchObject({ success: false, cancelled: true, filesIndexed: 0, chunksIndexed: 0 });
    expect(result.error).toMatch(/abort/i);
    expect(captured.batchSizes).toEqual([]);
    expect(events.map((e) => e.phase)).toEqual(["cancelled"]);
    expect((await semantic.status(openaiOnly()))[0]).toMatchObject({ totalFiles: 0, ready: false });
  });

  it("cancels an in-flight embedding request and records nothing for the file", async () => {
    const controller = new AbortController();
    const fetchStarted = deferred();
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      seenSignals.push(init?.signal);
      fetchStarted.resolve();
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;

    const semantic = new SemanticCodeIndex(workspaceDir);
    const fileIndex = new FileIndex(workspaceDir);
    await fileIndex.refresh();
    const events: SemanticRefreshProgress[] = [];
    const pending = semantic.refresh(fileIndex, openaiOnly(), {
      signal: controller.signal,
      onProgress: (e) => events.push(e),
    });
    await fetchStarted.promise;
    controller.abort();
    const result = await pending;

    expect(seenSignals).toEqual([controller.signal]);
    expect(result).toMatchObject({ success: false, cancelled: true, filesIndexed: 0, chunksIndexed: 0 });
    expect(result.backends[0]).toMatchObject({ backendId: "openai", ready: false });
    expect(result.backends[0]?.error).toMatch(/abort/i);
    expect(events.filter((e) => e.phase === "file")).toHaveLength(0);
    expect(events.at(-1)?.phase).toBe("cancelled");
    expect((await semantic.status(openaiOnly()))[0]).toMatchObject({ totalFiles: 0, totalChunks: 0 });

    // A later refresh with a healthy endpoint indexes everything.
    fakeOpenAIBackend({ batchSizes: [] });
    const retry = await semantic.refresh(fileIndex, openaiOnly());
    expect(retry).toMatchObject({ success: true, cancelled: false, filesIndexed: 3 });
    expect((await semantic.status(openaiOnly()))[0]).toMatchObject({ totalFiles: 3, ready: true });
  });

  it("does not commit rows when the abort lands after embedding but before the write", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      // The response is complete, but the caller aborted while it was in flight.
      controller.abort();
      return new Response(JSON.stringify({ data: vectorsFor(body.input) }), { status: 200 });
    }) as unknown as typeof fetch;

    const semantic = new SemanticCodeIndex(workspaceDir);
    const fileIndex = new FileIndex(workspaceDir);
    await fileIndex.refresh();
    const events: SemanticRefreshProgress[] = [];
    const result = await semantic.refresh(fileIndex, openaiOnly(), {
      signal: controller.signal,
      onProgress: (e) => events.push(e),
    });

    expect(result).toMatchObject({ success: false, cancelled: true, filesIndexed: 0, chunksIndexed: 0 });
    expect(events.filter((e) => e.phase === "file")).toHaveLength(0);
    expect((await semantic.status(openaiOnly()))[0]).toMatchObject({ totalFiles: 0, totalChunks: 0 });

    fakeOpenAIBackend({ batchSizes: [] });
    const retry = await semantic.refresh(fileIndex, openaiOnly());
    expect(retry).toMatchObject({ success: true, cancelled: false, filesIndexed: 3 });
  });

  it("never records a file whose embedding response is incomplete, and re-embeds it on retry", async () => {
    const requests: string[][] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      requests.push(body.input);
      const data = vectorsFor(body.input);
      // Drop the last row only for the request that carries b.ts.
      if (body.input.some((text) => text.includes("function b"))) data.pop();
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;

    const semantic = new SemanticCodeIndex(workspaceDir);
    const fileIndex = new FileIndex(workspaceDir);
    await fileIndex.refresh();
    const first = await semantic.refresh(fileIndex, openaiOnly());

    expect(first).toMatchObject({ success: false, cancelled: false, filesIndexed: 1 });
    expect(first.backends[0]?.error).toMatch(/rows for/);
    expect(first.error).toMatch(/rows for/);
    // a.ts was committed before b.ts failed; b.ts must not be recorded as current.
    expect((await semantic.status(openaiOnly()))[0]).toMatchObject({ totalFiles: 1 });

    fakeOpenAIBackend({ batchSizes: [] });
    const retry = await semantic.refresh(fileIndex, openaiOnly());
    expect(retry).toMatchObject({ success: true, filesIndexed: 2 });
    const stats = (await semantic.status(openaiOnly()))[0];
    expect(stats).toMatchObject({ totalFiles: 3, ready: true });
    expect(stats?.totalChunks).toBe(first.chunksIndexed + retry.chunksIndexed);
  });

  it("keeps separate stores per endpoint identity so a retargeted model starts empty", async () => {
    fakeOpenAIBackend({ batchSizes: [] });
    const semantic = new SemanticCodeIndex(workspaceDir);
    const fileIndex = new FileIndex(workspaceDir);
    await fileIndex.refresh();
    await semantic.refresh(fileIndex, openaiOnly());

    const retargeted: SemanticIndexSettings = { ...openaiOnly(), openaiBaseUrl: "http://localhost:11434/v1" };
    expect((await semantic.status(retargeted))[0]).toMatchObject({ totalFiles: 0, ready: false });
    expect((await semantic.status(openaiOnly()))[0]).toMatchObject({ totalFiles: 3, ready: true });
    // The default endpoint keeps the legacy on-disk layout.
    expect(fs.existsSync(path.join(configDir, "indexes"))).toBe(true);
    const workspaceDirs = fs.readdirSync(path.join(configDir, "indexes"));
    const modelDirs = fs.readdirSync(path.join(configDir, "indexes", workspaceDirs[0]!, "openai"));
    expect(modelDirs).toContain("text-embedding-3-small");
  });

  it("never reads through a committed symlink, so outside secrets are not sent for embedding (M12)", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      sent.push(...body.input);
      return Response.json({ data: vectorsFor(body.input) });
    }) as unknown as typeof fetch;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-sem-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.ts"), "export const SECRET_TOKEN = 'hunter2';\n");
      fs.symlinkSync(path.join(outside, "secret.ts"), path.join(workspaceDir, "linked.ts"));
      // A FileIndex-shaped source that still lists the link (e.g. an older listing).
      const listing = {
        list: async () => ["a.ts", "linked.ts"],
        resolvePath: (rel: string) => path.join(workspaceDir, rel),
        truncated: false,
      } as unknown as FileIndex;
      const result = await new SemanticCodeIndex(workspaceDir).refresh(listing, openaiOnly());
      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(1);
      expect(sent.join("\n")).not.toContain("SECRET_TOKEN");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps vectors for files a truncated listing omits while they still exist (L15)", async () => {
    fakeOpenAIBackend({ batchSizes: [] });
    const semantic = new SemanticCodeIndex(workspaceDir);
    const full = new FileIndex(workspaceDir);
    await full.refresh();
    await semantic.refresh(full, openaiOnly());

    fs.rmSync(path.join(workspaceDir, "c.ts"));
    const capped = {
      list: async () => ["a.ts"],
      resolvePath: (rel: string) => path.join(workspaceDir, rel),
      truncated: true,
    } as unknown as FileIndex;
    const events: SemanticRefreshProgress[] = [];
    await semantic.refresh(capped, openaiOnly(), { onProgress: (e) => events.push(e) });
    const deleted = events.filter((e) => e.phase === "delete").map((e) => e.filePath);
    // b.ts is beyond the cap but still on disk: kept. c.ts is really gone: deleted.
    expect(deleted).toEqual(["c.ts"]);
  });
});
