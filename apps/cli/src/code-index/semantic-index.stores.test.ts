import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticCodeIndex } from "./semantic-index.js";
import type { SemanticIndexSettings } from "./types.js";

// Store lifetime is exercised against a fake SemanticVectorStore whose
// initialization is gated by the test, so the interleavings the review names
// (concurrent first access, backend change, clear during a pending init) are
// deterministic rather than timing-dependent on LanceDB.
const fake = vi.hoisted(() => {
  interface Gate {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
  }
  function gate(): Gate {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  class FakeStore {
    static created: FakeStore[] = [];
    readonly gate = gate();
    initialized = false;
    cleared = false;
    /** Stands in for the metadata this instance read from disk. */
    files = 0;
    constructor(
      readonly dir: string,
      readonly backendId: string,
      readonly modelId: string,
    ) {
      FakeStore.created.push(this);
    }
    async initialize(): Promise<void> {
      await this.gate.promise;
      this.initialized = true;
    }
    stats() {
      return {
        backendId: this.backendId,
        modelId: this.modelId,
        totalFiles: this.files,
        totalChunks: this.files,
        ready: this.files > 0,
      };
    }
    clear(): void {
      this.cleared = true;
    }
  }
  return { FakeStore };
});

vi.mock("./vector-store.js", () => ({ SemanticVectorStore: fake.FakeStore }));

const { FakeStore } = fake;

function openaiSettings(partial: Partial<SemanticIndexSettings> = {}): SemanticIndexSettings {
  return {
    enabled: true,
    backend: "openai",
    localModel: "Xenova/all-MiniLM-L6-v2",
    openaiModel: "text-embedding-3-small",
    openaiApiKey: "sk-test",
    openaiBaseUrl: "",
    ...partial,
  };
}

describe("SemanticCodeIndex store ownership (I4)", () => {
  let configDir: string;
  let priorConfigDir: string | undefined;
  const workspace = "/virtual/workspace";

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-sem-stores-"));
    priorConfigDir = process.env.CODESURF_CONFIG_DIR;
    process.env.CODESURF_CONFIG_DIR = configDir;
    FakeStore.created.length = 0;
  });

  afterEach(() => {
    if (priorConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
    else process.env.CODESURF_CONFIG_DIR = priorConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("shares one in-flight initialization between concurrent first accesses", async () => {
    const index = new SemanticCodeIndex(workspace);
    const first = index.status(openaiSettings());
    const second = index.status(openaiSettings());

    expect(FakeStore.created).toHaveLength(1);
    const store = FakeStore.created[0]!;
    expect(store.initialized).toBe(false);
    store.files = 2;
    store.gate.resolve();

    const [a, b] = await Promise.all([first, second]);
    expect(FakeStore.created).toHaveLength(1);
    expect(a[0]).toMatchObject({ backendId: "openai", totalFiles: 2, ready: true });
    expect(b[0]).toMatchObject({ backendId: "openai", totalFiles: 2, ready: true });

    // Later accesses reuse the same instance.
    await index.status(openaiSettings());
    expect(FakeStore.created).toHaveLength(1);
  });

  it("opens a separate store when the endpoint changes but the model name does not", async () => {
    const index = new SemanticCodeIndex(workspace);
    const byDefault = index.status(openaiSettings());
    FakeStore.created[0]!.gate.resolve();
    await byDefault;

    const retargeted = index.status(openaiSettings({ openaiBaseUrl: "http://localhost:11434/v1" }));
    expect(FakeStore.created).toHaveLength(2);
    const [legacy, custom] = FakeStore.created as [InstanceType<typeof FakeStore>, InstanceType<typeof FakeStore>];
    expect(custom.dir).not.toBe(legacy.dir);
    // The default endpoint keeps the pre-existing <backend>/<model> layout.
    expect(legacy.dir.endsWith(path.join("openai", "text-embedding-3-small"))).toBe(true);
    expect(path.basename(custom.dir)).toBe("text-embedding-3-small_http_localhost_11434_v1");
    custom.gate.resolve();
    await retargeted;

    // The same endpoint (trailing slash notwithstanding) reuses its store.
    await index.status(openaiSettings({ openaiBaseUrl: "http://localhost:11434/v1/" }));
    expect(FakeStore.created).toHaveLength(2);
  });

  it("discards a store whose initialization straddles clear() instead of publishing it", async () => {
    const index = new SemanticCodeIndex(workspace);
    const pending = index.status(openaiSettings());
    const orphan = FakeStore.created[0]!;
    // Metadata the orphan read before the wipe.
    orphan.files = 7;

    index.clear();
    orphan.gate.resolve();

    await vi.waitFor(() => expect(FakeStore.created).toHaveLength(2));
    const fresh = FakeStore.created[1]!;
    expect(fresh).not.toBe(orphan);
    fresh.gate.resolve();

    const result = await pending;
    expect(result[0]).toMatchObject({ totalFiles: 0, ready: false });

    // The fresh store is now the owner; nothing else is constructed.
    await index.status(openaiSettings());
    expect(FakeStore.created).toHaveLength(2);
  });

  it("clears resolved stores and drops them so the next access starts fresh", async () => {
    const index = new SemanticCodeIndex(workspace);
    const first = index.status(openaiSettings());
    FakeStore.created[0]!.gate.resolve();
    await first;

    index.clear();
    expect(FakeStore.created[0]!.cleared).toBe(true);

    const second = index.status(openaiSettings());
    expect(FakeStore.created).toHaveLength(2);
    FakeStore.created[1]!.gate.resolve();
    await second;
  });

  it("retries initialization after a failure instead of caching the rejection", async () => {
    const index = new SemanticCodeIndex(workspace);
    const first = index.status(openaiSettings());
    FakeStore.created[0]!.gate.reject(new Error("lance exploded"));
    expect((await first)[0]).toMatchObject({ ready: false, error: "lance exploded" });

    const second = index.status(openaiSettings());
    expect(FakeStore.created).toHaveLength(2);
    FakeStore.created[1]!.files = 1;
    FakeStore.created[1]!.gate.resolve();
    expect((await second)[0]).toMatchObject({ ready: true, totalFiles: 1 });
  });
});
