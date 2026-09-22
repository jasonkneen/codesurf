import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredEmbeddingBackendRefs, tryCreateEmbeddingBackends, validateEmbeddings } from "./embeddings.js";
import type { SemanticIndexSettings } from "./types.js";

function settings(partial: Partial<SemanticIndexSettings> = {}): SemanticIndexSettings {
  return {
    enabled: true,
    backend: "auto",
    localModel: "Xenova/all-MiniLM-L6-v2",
    openaiModel: "text-embedding-3-small",
    openaiApiKey: "",
    openaiBaseUrl: "",
    ...partial,
  };
}

describe("embedding backend configuration", () => {
  it("uses local only in auto mode when no OpenAI key is configured", () => {
    expect(configuredEmbeddingBackendRefs(settings())).toEqual([
      { id: "local", modelId: "Xenova/all-MiniLM-L6-v2", identity: "Xenova/all-MiniLM-L6-v2" },
    ]);
  });

  it("uses local and OpenAI in auto mode when OpenAI is configured", () => {
    expect(configuredEmbeddingBackendRefs(settings({ openaiApiKey: "sk-test" }))).toEqual([
      { id: "local", modelId: "Xenova/all-MiniLM-L6-v2", identity: "Xenova/all-MiniLM-L6-v2" },
      { id: "openai", modelId: "text-embedding-3-small", identity: "text-embedding-3-small" },
    ]);
  });

  it("folds a non-default OpenAI-compatible endpoint into the backend identity", () => {
    const custom = settings({
      backend: "openai",
      openaiApiKey: "ollama",
      openaiModel: "nomic-embed-text",
      openaiBaseUrl: "http://localhost:11434/v1/",
    });
    expect(configuredEmbeddingBackendRefs(custom)).toEqual([
      { id: "openai", modelId: "nomic-embed-text", identity: "nomic-embed-text@http://localhost:11434/v1" },
    ]);
    // Same model on another server is a different embedding space.
    const other = configuredEmbeddingBackendRefs(settings({ ...custom, openaiBaseUrl: "http://localhost:1234/v1" }));
    expect(other[0]?.identity).toBe("nomic-embed-text@http://localhost:1234/v1");
    // The default endpoint keeps the bare model id so existing stores stay valid.
    expect(configuredEmbeddingBackendRefs(settings({ ...custom, openaiBaseUrl: "" }))[0]?.identity).toBe(
      "nomic-embed-text",
    );
  });

  it("returns no backends when semantic indexing is disabled or off", () => {
    expect(configuredEmbeddingBackendRefs(settings({ enabled: false }))).toEqual([]);
    expect(configuredEmbeddingBackendRefs(settings({ backend: "off" }))).toEqual([]);
  });
});

describe("tryCreateEmbeddingBackends", () => {
  it("returns the OpenAI backend without contacting the network at construction time", async () => {
    const { backends, failures } = await tryCreateEmbeddingBackends(
      settings({ backend: "openai", openaiApiKey: "sk-test" }),
    );
    expect(failures).toEqual([]);
    expect(backends).toHaveLength(1);
    expect(backends[0]?.id).toBe("openai");
    expect(backends[0]?.dimensions).toBe(1536);
    expect(backends[0]?.identity).toBe("text-embedding-3-small");
  });

  it("rejects with AbortError before loading the local pipeline when the signal is already aborted", async () => {
    vi.resetModules();
    const pipeline = vi.fn(() => {
      throw new Error("pipeline must not be reached");
    });
    vi.doMock("@xenova/transformers", () => ({
      env: { cacheDir: "", allowLocalModels: false, allowRemoteModels: false },
      pipeline,
    }));
    try {
      const { tryCreateEmbeddingBackends: freshTry } = await import("./embeddings.js");
      const controller = new AbortController();
      controller.abort();
      await expect(freshTry(settings({ backend: "local" }), controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(pipeline).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@xenova/transformers");
      vi.resetModules();
    }
  });

  it("reports an abort during model load as a cancellation, not a backend failure", async () => {
    vi.resetModules();
    const controller = new AbortController();
    vi.doMock("@xenova/transformers", () => ({
      env: { cacheDir: "", allowLocalModels: false, allowRemoteModels: false },
      pipeline: async () => {
        controller.abort();
        throw new Error("download interrupted");
      },
    }));
    try {
      const { tryCreateEmbeddingBackends: freshTry } = await import("./embeddings.js");
      await expect(freshTry(settings({ backend: "local" }), controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      vi.doUnmock("@xenova/transformers");
      vi.resetModules();
    }
  });

  it("surfaces a backend failure when the local pipeline blows up", async () => {
    vi.resetModules();
    vi.doMock("@xenova/transformers", () => ({
      env: { cacheDir: "", allowLocalModels: false, allowRemoteModels: false },
      pipeline: () => {
        throw new Error("simulated transformers init failure");
      },
    }));

    const { tryCreateEmbeddingBackends: freshTry } = await import("./embeddings.js");
    try {
      const result = await freshTry(settings({ backend: "local" }));
      expect(result.backends).toEqual([]);
      expect(result.failures).toEqual([
        {
          id: "local",
          modelId: "Xenova/all-MiniLM-L6-v2",
          message: "simulated transformers init failure",
        },
      ]);
    } finally {
      vi.doUnmock("@xenova/transformers");
      vi.resetModules();
    }
  });

  it("returns no backends and no failures when semantic indexing is off", async () => {
    const result = await tryCreateEmbeddingBackends(settings({ backend: "off" }));
    expect(result).toEqual({ backends: [], failures: [] });
  });
});

describe("openai backend batching", () => {
  const originalFetch = globalThis.fetch;
  function makeFetch(captured: Array<{ inputCount: number }>): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      captured.push({ inputCount: body.input.length });
      const data = body.input.map((_, i) => ({
        embedding: Array.from({ length: 1536 }, (_, k) => (i + 1) * 0.01 + k * 0.0001),
        index: i,
      }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("routes calls to a custom OpenAI-compatible base URL (Ollama / LM Studio)", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requestedUrls.push(url);
      const body = JSON.parse(init?.body as string) as { input: string[]; model: string };
      const data = body.input.map((_, i) => ({
        embedding: Array.from({ length: 768 }, () => 0.05),
        index: i,
      }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const { backends } = await tryCreateEmbeddingBackends(
        settings({
          backend: "openai",
          openaiApiKey: "ollama",
          openaiBaseUrl: "http://localhost:11434/v1",
          openaiModel: "nomic-embed-text",
        }),
      );
      expect(backends).toHaveLength(1);
      const vectors = await backends[0]!.embedBatch(["a", "b"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(768);
      expect(requestedUrls).toEqual(["http://localhost:11434/v1/embeddings"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("strips trailing slashes from a custom base URL", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requestedUrls.push(url);
      const body = JSON.parse(init?.body as string) as { input: string[] };
      const data = body.input.map((_, i) => ({ embedding: [0.1], index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { backends } = await tryCreateEmbeddingBackends(
        settings({
          backend: "openai",
          openaiApiKey: "key",
          openaiBaseUrl: "http://localhost:1234/v1//",
        }),
      );
      await backends[0]!.embed("x");
      expect(requestedUrls).toEqual(["http://localhost:1234/v1/embeddings"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("splits large batches into OpenAI-sized chunks and concatenates results in order", async () => {
    const captured: Array<{ inputCount: number }> = [];
    globalThis.fetch = makeFetch(captured);
    try {
      const { backends } = await tryCreateEmbeddingBackends(settings({ backend: "openai", openaiApiKey: "sk-test" }));
      const backend = backends[0]!;
      const inputs = Array.from({ length: 200 }, (_, i) => `chunk-${i}`);
      const vectors = await backend.embedBatch(inputs);
      expect(vectors).toHaveLength(200);
      // OPENAI_BATCH_SIZE is 96, so 200 inputs -> [96, 96, 8]
      expect(captured.map((c) => c.inputCount)).toEqual([96, 96, 8]);
      expect(vectors[0]).toHaveLength(1536);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards the caller's signal to fetch and issues no further batches once aborted", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      const body = JSON.parse(init?.body as string) as { input: string[] };
      const data = body.input.map((_, i) => ({ embedding: [0.5], index: i }));
      // Abort while the first batch is still in flight.
      controller.abort();
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { backends } = await tryCreateEmbeddingBackends(settings({ backend: "openai", openaiApiKey: "sk-test" }));
      const inputs = Array.from({ length: 200 }, (_, i) => `chunk-${i}`);
      await expect(backends[0]!.embedBatch(inputs, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(signals).toEqual([controller.signal]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("openai embedding response validation (I3)", () => {
  const originalFetch = globalThis.fetch;

  function respondWith(data: unknown): void {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof fetch;
  }

  async function openaiBackend() {
    const { backends } = await tryCreateEmbeddingBackends(settings({ backend: "openai", openaiApiKey: "sk-test" }));
    return backends[0]!;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("places rows by their declared index rather than response order", async () => {
    respondWith([
      { index: 1, embedding: [0.2, 0.2] },
      { index: 0, embedding: [0.1, 0.1] },
    ]);
    await expect((await openaiBackend()).embedBatch(["first", "second"])).resolves.toEqual([
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
  });

  it("rejects a response with fewer rows than inputs", async () => {
    respondWith([{ index: 0, embedding: [0.1] }]);
    await expect((await openaiBackend()).embedBatch(["a", "b"])).rejects.toThrow(/returned 1 rows for 2 inputs/);
  });

  it("rejects duplicate row indices even when the row count matches", async () => {
    respondWith([
      { index: 0, embedding: [0.1] },
      { index: 0, embedding: [0.2] },
    ]);
    await expect((await openaiBackend()).embedBatch(["a", "b"])).rejects.toThrow(/duplicate row index 0/);
  });

  it("rejects out-of-range and non-integer row indices", async () => {
    respondWith([
      { index: 0, embedding: [0.1] },
      { index: 5, embedding: [0.2] },
    ]);
    await expect((await openaiBackend()).embedBatch(["a", "b"])).rejects.toThrow(/index 5 outside 0\.\.1/);
    respondWith([{ index: "0", embedding: [0.1] }]);
    await expect((await openaiBackend()).embedBatch(["a"])).rejects.toThrow(/outside 0\.\.0/);
  });

  it("rejects missing, empty and non-finite vectors", async () => {
    respondWith([{ index: 0 }, { index: 1, embedding: [0.1] }]);
    await expect((await openaiBackend()).embedBatch(["a", "b"])).rejects.toThrow(/no embedding for input 0/);
    respondWith([{ index: 0, embedding: [] }]);
    await expect((await openaiBackend()).embedBatch(["a"])).rejects.toThrow(/no embedding for input 0/);
    respondWith([
      { index: 0, embedding: [0.1, 0.2] },
      { index: 1, embedding: [0.1, null] },
    ]);
    await expect((await openaiBackend()).embedBatch(["a", "b"])).rejects.toThrow(/non-finite embedding for input 1/);
  });

  it("rejects vectors of inconsistent dimension", async () => {
    respondWith([
      { index: 0, embedding: [0.1, 0.2] },
      { index: 1, embedding: [0.3] },
    ]);
    await expect((await openaiBackend()).embedBatch(["a", "b"])).rejects.toThrow(/1-dimensional .* expected 2/);
  });

  it("rejects a response without a data array", async () => {
    respondWith(undefined);
    await expect((await openaiBackend()).embed("a")).rejects.toThrow(/no data array/);
  });

  it("validateEmbeddings refuses a count mismatch or an undefined entry", () => {
    expect(() => validateEmbeddings([[1]], 2, "test")).toThrow(/1 embeddings for 2 inputs/);
    expect(() => validateEmbeddings([[1], undefined], 2, "test")).toThrow(/no embedding for input 1/);
    expect(validateEmbeddings([[1], [2]], 2, "test")).toEqual([[1], [2]]);
  });
});
