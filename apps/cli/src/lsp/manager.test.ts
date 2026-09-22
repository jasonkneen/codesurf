import { getEventListeners } from "events";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, ConnectionErrors, ErrorCodes, ResponseError } from "vscode-jsonrpc/node";
import type { LspClientSession } from "./client";
import { createWorkspaceLspManager } from "./manager";
import type { NormalizedLspSettings } from "./types";

const BASE_SETTINGS: NormalizedLspSettings = {
  enabled: true,
  tool: true,
  autoInstall: false,
  startupTimeoutMs: 5_000,
  diagnosticsDebounceMs: 0,
  builtins: {
    typescript: {
      enabled: false,
    },
  },
  servers: [
    {
      id: "fake-ts",
      command: "fake-lsp",
      extensions: [".ts"],
      languageIds: {
        ".ts": "typescript",
      },
      rootMarkers: [".git"],
    },
  ],
};

const LSP_REQUEST_CANCELLED = -32800;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createWorkspaceLspManager", () => {
  it("routes queries through the matching LSP client", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const sendRequest = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe("textDocument/definition");
      expect(params).toMatchObject({
        position: {
          line: 4,
          character: 2,
        },
      });
      return [{ uri: "file:///demo.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } }];
    });
    const client = createFakeClient({ sendRequest });

    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, {
      createClient: async () => client,
    });

    const result = await manager.query({
      operation: "goToDefinition",
      filePath,
      line: 5,
      character: 3,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("file:///demo.ts");
    expect(client.openOrChangeFile).toHaveBeenCalledWith(filePath, "typescript", "const demo = 1;\n");
    expect(client.waitForDiagnostics).toHaveBeenCalledWith(filePath);

    await manager.close();
    expect(client.stop).toHaveBeenCalled();
  });

  it("returns diagnostics after syncing a saved file", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    const diagnostics = [
      {
        filePath,
        serverId: "fake-ts",
        diagnostics: [
          {
            message: "Type error",
            severity: 1,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 4 },
            },
          },
        ],
      },
    ];

    const client = createFakeClient({
      diagnostics: diagnostics[0].diagnostics,
    });

    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, {
      createClient: async () => client,
    });

    const result = await manager.syncFile(filePath, "const broken = true;\n", true, true);

    expect(result).toEqual(diagnostics);
    expect(client.saveFile).toHaveBeenCalledWith(filePath);
    expect(client.waitForDiagnostics).toHaveBeenCalledWith(filePath);

    await manager.close();
  });

  it("reports when no matching server exists", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.rb");
    await writeFile(filePath, "puts 'hello'\n");

    const manager = createWorkspaceLspManager(root, { ...BASE_SETTINGS, servers: [] });
    const result = await manager.query({
      operation: "hover",
      filePath,
      line: 1,
      character: 1,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("No LSP server available");

    await manager.close();
  });
});

// T4: a failed request must not silently orphan a running server, and the
// outcome must be reported honestly instead of as "No results found".
describe("createWorkspaceLspManager request failures", () => {
  it("keeps the client and reports cancellation when the request is cancelled", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const pending = createDeferred<unknown>();
    const sendRequest = vi.fn(async (_method: string, _params: unknown, token?: unknown) => {
      const cancellation = token as { onCancellationRequested: (listener: () => void) => void } | undefined;
      cancellation?.onCancellationRequested(() => {
        pending.reject(new ResponseError(LSP_REQUEST_CANCELLED, "Request cancelled"));
      });
      return pending.promise;
    });
    const client = createFakeClient({ sendRequest });
    const createClient = vi.fn(async () => client);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    const controller = new AbortController();
    const query = manager.query({ operation: "hover", filePath, line: 1, character: 1 }, controller.signal);
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await query;

    expect(result.success).toBe(false);
    expect(result.output).toContain("cancelled");
    expect(client.stop).not.toHaveBeenCalled();

    // The server is still owned: the next query reuses it instead of starting another.
    sendRequest.mockResolvedValueOnce([]);
    await manager.query({ operation: "hover", filePath, line: 1, character: 1 });
    expect(createClient).toHaveBeenCalledTimes(1);

    await manager.close();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the client and reports failure when the server rejects an unsupported method", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const sendRequest = vi.fn(async (method: string) => {
      if (method === "textDocument/implementation") {
        throw new ResponseError(ErrorCodes.MethodNotFound, `Unhandled method ${method}`);
      }
      return [{ uri: "file:///demo.ts" }];
    });
    const client = createFakeClient({ sendRequest });
    const createClient = vi.fn(async () => client);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    const failed = await manager.query({ operation: "goToImplementation", filePath, line: 1, character: 1 });
    expect(failed.success).toBe(false);
    expect(failed.output).toContain("Unhandled method textDocument/implementation");
    expect(failed.output).not.toContain("No results found");
    expect(client.stop).not.toHaveBeenCalled();

    const succeeded = await manager.query({ operation: "goToDefinition", filePath, line: 1, character: 1 });
    expect(succeeded.success).toBe(true);
    expect(succeeded.output).toContain("file:///demo.ts");
    expect(createClient).toHaveBeenCalledTimes(1);

    await manager.close();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("stops and replaces a client whose transport died", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const dead = createFakeClient({
      sendRequest: async () => {
        throw new ConnectionError(ConnectionErrors.Closed, "Connection is closed.");
      },
    });
    const healthy = createFakeClient({ sendRequest: async () => [{ uri: "file:///demo.ts" }] });
    const instances = [dead, healthy];
    const createClient = vi.fn(async () => instances.shift() ?? null);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    const failed = await manager.query({ operation: "hover", filePath, line: 1, character: 1 });
    expect(failed.success).toBe(false);
    expect(failed.output).toContain("Connection is closed.");
    // The dead instance is explicitly stopped, not merely forgotten.
    expect(dead.stop).toHaveBeenCalledTimes(1);

    const recovered = await manager.query({ operation: "hover", filePath, line: 1, character: 1 });
    expect(recovered.success).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(2);

    await manager.close();
    expect(healthy.stop).toHaveBeenCalledTimes(1);
    expect(dead.stop).toHaveBeenCalledTimes(1);
  });

  it("does not evict a replacement when a stale request on the replaced client fails", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    // Each in-flight request on A is bound to its query by position (line 1 ->
    // position.line 0, line 2 -> position.line 1) so the test does not depend
    // on which query reaches sendRequest first: both pass through filesystem
    // awaits (root probes, readFile) before the request is sent.
    const pendingOne = createDeferred<unknown>();
    const pendingTwo = createDeferred<unknown>();
    const pendingByLine = new Map<number, Promise<unknown>>([
      [0, pendingOne.promise],
      [1, pendingTwo.promise],
    ]);
    const clientA = createFakeClient({
      sendRequest: async (_method, params) => {
        const line = (params as { position: { line: number } }).position.line;
        const pending = pendingByLine.get(line);
        if (!pending) throw new Error(`unexpected request at position.line ${line}`);
        return pending;
      },
    });
    const clientB = createFakeClient({ sendRequest: async () => [{ uri: "file:///demo.ts" }] });
    const instances = [clientA, clientB];
    const createClient = vi.fn(async () => instances.shift() ?? null);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    const queryOne = manager.query({ operation: "hover", filePath, line: 1, character: 1 });
    const queryTwo = manager.query({ operation: "hover", filePath, line: 2, character: 1 });
    await vi.waitFor(() => expect(clientA.sendRequest).toHaveBeenCalledTimes(2));

    // A's transport dies while both requests are in flight; queryOne's failure evicts A.
    pendingOne.reject(new ConnectionError(ConnectionErrors.Closed, "Connection is closed."));
    expect((await queryOne).success).toBe(false);
    expect(clientA.stop).toHaveBeenCalled();

    // B replaces A.
    const replaced = await manager.query({ operation: "hover", filePath, line: 1, character: 1 });
    expect(replaced.success).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(2);

    // The stale failure from A (queryTwo's request) must not evict B.
    pendingTwo.reject(new ConnectionError(ConnectionErrors.Closed, "Connection is closed."));
    expect((await queryTwo).success).toBe(false);
    expect(clientB.stop).not.toHaveBeenCalled();

    const reused = await manager.query({ operation: "hover", filePath, line: 1, character: 1 });
    expect(reused.success).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(2);

    await manager.close();
    expect(clientB.stop).toHaveBeenCalledTimes(1);
  });
});

// T8: cancellation has to cover discovery/startup and document sync, and the
// abort listener must not accumulate across queries sharing one signal.
describe("createWorkspaceLspManager cancellation", () => {
  it("does not start a server for an already-aborted query", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const client = createFakeClient({});
    const createClient = vi.fn(async () => client);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    const controller = new AbortController();
    controller.abort();
    const result = await manager.query({ operation: "hover", filePath, line: 1, character: 1 }, controller.signal);

    expect(result.success).toBe(false);
    expect(result.output).toContain("cancelled");
    expect(createClient).not.toHaveBeenCalled();
    expect(client.sendRequest).not.toHaveBeenCalled();

    await manager.close();
  });

  it("reports cancellation after an abort during startup while keeping the started server owned", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const client = createFakeClient({});
    const startup = createDeferred<LspClientSession>();
    const createClient = vi.fn(() => startup.promise);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    const controller = new AbortController();
    const query = manager.query({ operation: "hover", filePath, line: 1, character: 1 }, controller.signal);
    await vi.waitFor(() => expect(createClient).toHaveBeenCalledTimes(1));
    controller.abort();
    startup.resolve(client);
    const result = await query;

    expect(result.success).toBe(false);
    expect(result.output).toContain("cancelled");
    expect(client.openOrChangeFile).not.toHaveBeenCalled();
    expect(client.sendRequest).not.toHaveBeenCalled();

    // Startup ownership is shared: the server stays cached and is closed with the manager.
    await manager.close();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("reports cancellation after an abort during diagnostics without sending the request", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const diagnosticsWait = createDeferred<never[]>();
    const client = createFakeClient({});
    client.waitForDiagnostics.mockImplementation(() => diagnosticsWait.promise);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const controller = new AbortController();
    const query = manager.query({ operation: "hover", filePath, line: 1, character: 1 }, controller.signal);
    await vi.waitFor(() => expect(client.waitForDiagnostics).toHaveBeenCalledTimes(1));
    controller.abort();
    diagnosticsWait.resolve([]);
    const result = await query;

    expect(result.success).toBe(false);
    expect(result.output).toContain("cancelled");
    expect(client.sendRequest).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();

    await manager.close();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("stops waiting on a startup that never settles", async () => {
    // The discriminating case for the last T8 gap. The two tests above resolve
    // the deferred AFTER aborting, so they pass even when the wait is un-raced.
    // Here the startup never settles: if the abort is not raced against the
    // wait, this query hangs forever and the test times out.
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const startup = createDeferred<LspClientSession>();
    const createClient = vi.fn(() => startup.promise);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    const controller = new AbortController();
    const query = manager.query({ operation: "hover", filePath, line: 1, character: 1 }, controller.signal);
    await vi.waitFor(() => expect(createClient).toHaveBeenCalledTimes(1));
    controller.abort();

    const result = await query;
    expect(result.success).toBe(false);
    expect(result.output).toContain("cancelled");

    // The abandoned startup is still owned by the cache, so settling it late
    // must not throw into an unattached promise.
    const client = createFakeClient({});
    startup.resolve(client);
    await manager.close();
  });

  it("stops waiting on a diagnostics wait that never settles", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const diagnosticsWait = createDeferred<never[]>();
    const client = createFakeClient({});
    client.waitForDiagnostics.mockImplementation(() => diagnosticsWait.promise);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const controller = new AbortController();
    const query = manager.query({ operation: "hover", filePath, line: 1, character: 1 }, controller.signal);
    await vi.waitFor(() => expect(client.waitForDiagnostics).toHaveBeenCalledTimes(1));
    controller.abort();

    const result = await query;
    expect(result.success).toBe(false);
    expect(result.output).toContain("cancelled");
    expect(client.sendRequest).not.toHaveBeenCalled();

    diagnosticsWait.resolve([]);
    await manager.close();
  });

  it("removes its abort listener once a query completes", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const client = createFakeClient({ sendRequest: async () => [] });
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient: async () => client });

    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;
    for (let i = 0; i < 5; i += 1) {
      await manager.query({ operation: "hover", filePath, line: 1, character: 1 }, controller.signal);
    }

    expect(getEventListeners(controller.signal, "abort").length).toBe(before);

    await manager.close();
  });
});

describe("createWorkspaceLspManager close", () => {
  it("does not admit a client whose root resolution was in flight when close ran", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const client = createFakeClient({});
    const createClient = vi.fn(async () => client);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    // Root resolution awaits filesystem probes; close() snapshots synchronously
    // before any of them settle.
    const query = manager.query({ operation: "hover", filePath, line: 1, character: 1 });
    const closing = manager.close();
    await Promise.all([query, closing]);

    expect(createClient).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("stops a startup that completes after close instead of leaking it", async () => {
    const root = await createTempWorkspace();
    const filePath = await createSourceFile(root);

    const client = createFakeClient({});
    const startup = createDeferred<LspClientSession>();
    const createClient = vi.fn(() => startup.promise);
    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, { createClient });

    const query = manager.query({ operation: "hover", filePath, line: 1, character: 1 });
    await vi.waitFor(() => expect(createClient).toHaveBeenCalledTimes(1));
    const closing = manager.close();
    startup.resolve(client);
    await Promise.all([query, closing]);

    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(client.sendRequest).not.toHaveBeenCalled();
  });
});

async function createTempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-lsp-manager-"));
  tempDirs.push(root);
  await mkdir(path.join(root, ".git"), { recursive: true });
  return root;
}

async function createSourceFile(root: string): Promise<string> {
  const filePath = path.join(root, "src", "demo.ts");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "const demo = 1;\n");
  return filePath;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeClient(input: {
  diagnostics?: LspClientSession["getDiagnostics"] extends (filePath: string) => infer TResult ? TResult : never;
  sendRequest?: (method: string, params: unknown, token?: unknown) => Promise<unknown>;
}): LspClientSession & {
  openOrChangeFile: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
  sendRequest: ReturnType<typeof vi.fn>;
  waitForDiagnostics: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const diagnostics = input.diagnostics ?? [];
  return {
    serverId: "fake-ts",
    root: "/tmp",
    openOrChangeFile: vi.fn(async () => {}),
    saveFile: vi.fn(async () => {}),
    closeFile: vi.fn(async () => {}),
    sendRequest: vi.fn(async (method: string, params: unknown, token?: unknown) =>
      input.sendRequest ? await input.sendRequest(method, params, token) : [],
    ) as LspClientSession["sendRequest"] & ReturnType<typeof vi.fn>,
    waitForDiagnostics: vi.fn(async () => diagnostics),
    getDiagnostics: vi.fn(() => diagnostics),
    stop: vi.fn(async () => {}),
  };
}
