import { readFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import {
  type CancellationToken,
  CancellationTokenSource,
  ConnectionError,
  ErrorCodes,
  ResponseError,
} from "vscode-jsonrpc/node";
import { createRuntimeLspDefinitions, type RuntimeLspServerDefinition } from "./builtins";
import { createLspClientSession, type LspClientSession } from "./client";
import type { LspDiagnosticFile, LspQueryInput, LspToolResponse, NormalizedLspSettings } from "./types";

interface ManagedClient {
  key: string;
  definition: RuntimeLspServerDefinition;
  root: string;
  client: LspClientSession;
  /**
   * The cache entry this record came from. Eviction compares against it so a
   * stale failure from an already-replaced instance cannot remove its
   * replacement.
   */
  entry: Promise<ManagedClient | null>;
}

interface WorkspaceLspManagerOptions {
  createClient?: (input: {
    serverId: string;
    root: string;
    definition: RuntimeLspServerDefinition;
    settings: NormalizedLspSettings;
  }) => Promise<LspClientSession | null>;
}

export interface WorkspaceLspManager {
  touchFile(filePath: string, waitForDiagnostics?: boolean): Promise<LspDiagnosticFile[]>;
  syncFile(
    filePath: string,
    content: string,
    save?: boolean,
    waitForDiagnostics?: boolean,
  ): Promise<LspDiagnosticFile[]>;
  query(input: LspQueryInput, abortSignal?: AbortSignal): Promise<LspToolResponse>;
  close(): Promise<void>;
}

// LSP-level error codes (vscode-jsonrpc only ships the JSON-RPC base set).
const LSP_REQUEST_CANCELLED = -32800;
const LSP_SERVER_CANCELLED = -32802;

/**
 * Why an operation against a client failed:
 * - `cancelled`: the caller's token fired or the server reported cancellation.
 * - `request`: the server answered with an error (unsupported method, bad
 *   params, ...); the transport is healthy and the client stays owned.
 * - `transport`: the connection is closed/disposed or the client is already
 *   stopped; the instance is evicted and explicitly stopped.
 */
type FailureKind = "cancelled" | "request" | "transport";

type OperationOutcome =
  | { kind: "ok"; results: unknown[] }
  | { kind: "cancelled"; serverId: string }
  | { kind: "failed"; serverId: string; message: string };

export function createWorkspaceLspManager(
  cwd: string,
  settings: NormalizedLspSettings,
  options: WorkspaceLspManagerOptions = {},
): WorkspaceLspManager {
  const definitions = createRuntimeLspDefinitions(cwd, settings);
  const clients = new Map<string, Promise<ManagedClient | null>>();
  // Bumped by close(). Startups that observe a different epoch after an await
  // were admitted before a close snapshot and must not be inserted/kept.
  let closeEpoch = 0;

  const createClient =
    options.createClient ??
    (async ({ serverId, root, definition, settings: normalizedSettings }) => {
      const launch = await definition.resolveLaunch(root, normalizedSettings);
      if (!launch?.command) return null;
      return createLspClientSession({
        serverId,
        root,
        launch,
        startupTimeoutMs: normalizedSettings.startupTimeoutMs,
        diagnosticsDebounceMs: normalizedSettings.diagnosticsDebounceMs,
      });
    });

  function evict(record: ManagedClient): void {
    if (clients.get(record.key) === record.entry) {
      clients.delete(record.key);
    }
    // A transport-dead instance is unowned once removed from the cache; stop it
    // explicitly instead of leaving the process running. stop() is idempotent.
    void record.client.stop().catch(() => {});
  }

  async function getClientsForFile(filePath: string): Promise<ManagedClient[]> {
    if (!settings.enabled) return [];

    const epoch = closeEpoch;
    const normalizedPath = path.resolve(filePath);
    const extension = path.extname(normalizedPath).toLowerCase();
    const matches = definitions.filter((definition) => definition.extensions.includes(extension));
    if (matches.length === 0) return [];

    const resolved = await Promise.all(
      matches.map(async (definition) => {
        const root = await definition.resolveRoot(normalizedPath, cwd);
        if (!root) return null;
        // close() ran while the root was resolving: it never snapshotted this
        // startup, so it must not be admitted now.
        if (epoch !== closeEpoch) return null;

        const cacheKey = `${definition.id}:${root}`;
        const inflight = clients.get(cacheKey);
        if (inflight) return inflight;

        // Declared ahead of the startup closure so the record can carry its own
        // cache entry as the eviction identity (only read after the first await).
        let entry!: Promise<ManagedClient | null>;
        entry = (async () => {
          const client = await createClient({
            serverId: definition.id,
            root,
            definition,
            settings,
          });
          if (!client) return null;
          if (epoch !== closeEpoch) {
            // Startup outlived close(); dispose it rather than leak a server
            // nobody owns.
            void client.stop().catch(() => {});
            return null;
          }
          return { key: cacheKey, definition, root, client, entry };
        })();

        clients.set(cacheKey, entry);
        try {
          const value = await entry;
          if (!value && clients.get(cacheKey) === entry) {
            clients.delete(cacheKey);
          }
          return value;
        } catch (err) {
          if (clients.get(cacheKey) === entry) {
            clients.delete(cacheKey);
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[lsp] Failed to start ${definition.id} for ${cacheKey}: ${msg}`);
          return null;
        }
      }),
    );

    return resolved.filter((value): value is ManagedClient => value !== null);
  }

  async function touchFile(filePath: string, waitForDiagnostics = true): Promise<LspDiagnosticFile[]> {
    const content = await readFile(filePath, "utf8");
    return syncFile(filePath, content, false, waitForDiagnostics);
  }

  async function syncFile(
    filePath: string,
    content: string,
    save = true,
    waitForDiagnostics = true,
  ): Promise<LspDiagnosticFile[]> {
    const records = await getClientsForFile(filePath);
    if (records.length === 0) return [];

    const extension = path.extname(filePath).toLowerCase();
    const diagnostics = await Promise.all(
      records.map(async (record) => {
        const { definition, client } = record;
        const languageId = definition.languageIds[extension] ?? (extension.slice(1) || "plaintext");
        try {
          await client.openOrChangeFile(filePath, languageId, content);
          if (save) {
            await client.saveFile(filePath);
          }
          if (waitForDiagnostics) {
            await client.waitForDiagnostics(filePath);
          }
          return {
            filePath,
            serverId: client.serverId,
            diagnostics: client.getDiagnostics(filePath),
          };
        } catch (error) {
          if (classifyFailure(error) === "transport") {
            evict(record);
          }
          return null;
        }
      }),
    );

    return diagnostics.filter((entry): entry is LspDiagnosticFile => entry !== null && entry.diagnostics.length > 0);
  }

  async function runOperation(
    record: ManagedClient,
    input: LspQueryInput,
    params: Record<string, unknown>,
    token: CancellationToken | undefined,
  ): Promise<OperationOutcome> {
    const { client } = record;
    try {
      let result: unknown;
      if (input.operation === "incomingCalls" || input.operation === "outgoingCalls") {
        const items = await client.sendRequest<unknown[]>("textDocument/prepareCallHierarchy", params, token);
        const firstItem = Array.isArray(items) ? items[0] : undefined;
        result = firstItem
          ? await client.sendRequest<unknown[]>(
              input.operation === "incomingCalls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
              { item: firstItem },
              token,
            )
          : [];
      } else {
        result = await client.sendRequest<unknown>(getOperationMethod(input.operation), params, token);
      }
      return { kind: "ok", results: toResultList(result) };
    } catch (error) {
      const kind = classifyFailure(error, token);
      if (kind === "transport") {
        evict(record);
      }
      if (kind === "cancelled") {
        return { kind: "cancelled", serverId: client.serverId };
      }
      return { kind: "failed", serverId: client.serverId, message: describeError(error) };
    }
  }

  async function query(input: LspQueryInput, abortSignal?: AbortSignal): Promise<LspToolResponse> {
    const normalizedPath = path.resolve(cwd, input.filePath);
    // An already-aborted request must not discover, auto-install or start a
    // server on the caller's behalf.
    if (abortSignal?.aborted) return cancelledResponse(input);

    // Startup is shared with other live callers and stays owned by the cache;
    // only this request's wait is abandoned — including WHILE it is in flight,
    // not merely once it settles.
    const records = await raceAbort(getClientsForFile(normalizedPath), abortSignal);
    if (records === ABORTED) return cancelledResponse(input);
    if (records.length === 0) {
      return {
        success: false,
        output: `No LSP server available for ${path.extname(normalizedPath) || "this file type"}.`,
      };
    }

    // Bridge the host AbortSignal (fired on Stop) to a JSON-RPC cancellation
    // token so an in-flight LSP request emits `$/cancelRequest` to the server
    // instead of running to completion after the turn is aborted. The
    // listener is removed in `finally`: disposing the token source does not
    // detach it, and many queries share one turn-scoped signal.
    const cts = abortSignal ? new CancellationTokenSource() : undefined;
    const onAbort = cts ? () => cts.cancel() : undefined;
    if (abortSignal && onAbort) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    const token = cts?.token;

    try {
      // Same for the document sync + diagnostics wait: a Stop during it returns
      // now rather than after the language server gets around to replying.
      const lspDiagnostics = await raceAbort(touchFile(normalizedPath, true), abortSignal);
      if (lspDiagnostics === ABORTED) return cancelledResponse(input);

      const params = createOperationParams(input, normalizedPath);
      const outcomes = await Promise.all(records.map((record) => runOperation(record, input, params, token)));
      return summarizeOutcomes(input, outcomes, lspDiagnostics);
    } finally {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      cts?.dispose();
    }
  }

  async function close(): Promise<void> {
    closeEpoch += 1;
    const snapshot = [...clients.entries()];
    const entries = await Promise.allSettled(snapshot.map(([, entry]) => entry));
    const active = entries
      .filter((entry): entry is PromiseFulfilledResult<ManagedClient | null> => entry.status === "fulfilled")
      .map((entry) => entry.value)
      .filter((value): value is ManagedClient => value !== null);
    await Promise.allSettled(active.map((entry) => entry.client.stop()));
    // Only drop what this close owned; a client admitted under the new epoch
    // while we were awaiting stays owned by the cache.
    for (const [key, entry] of snapshot) {
      if (clients.get(key) === entry) {
        clients.delete(key);
      }
    }
  }

  return {
    touchFile,
    syncFile,
    query,
    close,
  };
}

function classifyFailure(error: unknown, token?: CancellationToken): FailureKind {
  if (token?.isCancellationRequested) return "cancelled";
  if (error instanceof ConnectionError) return "transport";
  if (error instanceof ResponseError) {
    switch (error.code) {
      case LSP_REQUEST_CANCELLED:
      case LSP_SERVER_CANCELLED:
        return "cancelled";
      case ErrorCodes.PendingResponseRejected:
      case ErrorCodes.ConnectionInactive:
      case ErrorCodes.MessageWriteError:
      case ErrorCodes.MessageReadError:
        return "transport";
      default:
        return "request";
    }
  }
  return "transport";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toResultList(result: unknown): unknown[] {
  if (Array.isArray(result)) return result.filter(Boolean);
  return result ? [result] : [];
}

/**
 * A wait that ends when the signal fires.
 *
 * Closes the last T8 gap: an in-progress server startup or diagnostics wait
 * used to be un-raced, so a Stop mid-wait was honoured only once that await
 * settled — which for a cold server install is seconds.
 *
 * The underlying promise is deliberately NOT cancelled. Startup is shared and
 * owned by the client cache, so other live callers keep their server; only
 * THIS request stops waiting. A rejection handler is always attached, so an
 * abandoned wait can never surface as an unhandled rejection.
 */
const ABORTED = Symbol("lsp-wait-aborted");

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      void work.catch(() => {});
      resolve(ABORTED);
      return;
    }
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancelledResponse(input: LspQueryInput, lspDiagnostics?: LspDiagnosticFile[]): LspToolResponse {
  return {
    success: false,
    output: `LSP ${input.operation} was cancelled.`,
    ...(lspDiagnostics ? { lspDiagnostics } : {}),
  };
}

function summarizeOutcomes(
  input: LspQueryInput,
  outcomes: OperationOutcome[],
  lspDiagnostics: LspDiagnosticFile[],
): LspToolResponse {
  if (outcomes.some((outcome) => outcome.kind === "cancelled")) {
    return cancelledResponse(input, lspDiagnostics);
  }

  const failures = outcomes.filter((outcome): outcome is Extract<OperationOutcome, { kind: "failed" }> => {
    return outcome.kind === "failed";
  });
  const failureText = failures.map((failure) => `${failure.serverId}: ${failure.message}`).join("; ");
  if (failures.length === outcomes.length) {
    return {
      success: false,
      output: `LSP ${input.operation} failed: ${failureText}`,
      lspDiagnostics,
    };
  }

  const results = outcomes.flatMap((outcome) => (outcome.kind === "ok" ? outcome.results : []));
  const lines = [results.length > 0 ? JSON.stringify(results, null, 2) : `No results found for ${input.operation}.`];
  if (failures.length > 0) {
    lines.push(`Note: some servers failed: ${failureText}`);
  }
  return {
    success: true,
    output: lines.join("\n"),
    lspDiagnostics,
  };
}

function getOperationMethod(operation: LspQueryInput["operation"]): string {
  switch (operation) {
    case "goToDefinition":
      return "textDocument/definition";
    case "findReferences":
      return "textDocument/references";
    case "hover":
      return "textDocument/hover";
    case "documentSymbol":
      return "textDocument/documentSymbol";
    case "workspaceSymbol":
      return "workspace/symbol";
    case "goToImplementation":
      return "textDocument/implementation";
    case "prepareCallHierarchy":
      return "textDocument/prepareCallHierarchy";
    case "incomingCalls":
    case "outgoingCalls":
      return "textDocument/prepareCallHierarchy";
  }
}

function createOperationParams(input: LspQueryInput, absolutePath: string): Record<string, unknown> {
  const uri = pathToFileURL(absolutePath).href;
  const position = {
    line: (input.line ?? 1) - 1,
    character: (input.character ?? 1) - 1,
  };

  switch (input.operation) {
    case "goToDefinition":
    case "hover":
    case "goToImplementation":
    case "prepareCallHierarchy":
    case "incomingCalls":
    case "outgoingCalls":
      return {
        textDocument: { uri },
        position,
      };
    case "findReferences":
      return {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      };
    case "documentSymbol":
      return {
        textDocument: { uri },
      };
    case "workspaceSymbol":
      return {
        query: input.query ?? "",
      };
  }
}

export function summarizeLspDiagnostics(diagnostics: LspDiagnosticFile[]): string | null {
  const counts = diagnostics
    .flatMap((entry) => entry.diagnostics)
    .reduce(
      (acc, diagnostic) => {
        const severity = diagnostic.severity ?? 1;
        if (severity === 1) acc.errors += 1;
        else if (severity === 2) acc.warnings += 1;
        else acc.infos += 1;
        return acc;
      },
      { errors: 0, warnings: 0, infos: 0 },
    );

  const total = counts.errors + counts.warnings + counts.infos;
  if (total === 0) return null;

  const parts = [`${total} LSP issue${total === 1 ? "" : "s"}`];
  if (counts.errors > 0) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
  if (counts.warnings > 0) parts.push(`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`);
  if (counts.infos > 0) parts.push(`${counts.infos} info`);
  return parts.join(" · ");
}
