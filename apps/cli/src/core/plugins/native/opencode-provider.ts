// Builtin OpenCode SDK provider.
//
// This is an owning adapter: CodeSurf sends each turn to an OpenCode session
// through @opencode-ai/sdk and lets OpenCode run its own tools, permissions,
// model routing, and project config.

import type {
  CodesurfPlugin,
  CredentialStatus,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
  ProviderStreamController,
  ProviderTurnInput,
  ProviderUsageSnapshot,
} from "@codesurf/plugin-api";
import { createOpencodeClient, createOpencodeServer, type Part, type Provider } from "@opencode-ai/sdk";
import { isBinaryInstalled } from "../../../utils/binary-on-path";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";

const EXTENSION_ID = "builtin.provider-opencode-sdk";
const PROVIDER_ID = "opencode";
const ADAPTER_ID = "opencode.sdk";
const MODEL_PREFIX = "opencode:";
const FALLBACK_MODEL_ID = "opencode:default";

const BASE_URL_SETTING = `${ADAPTER_ID}.baseUrl`;
const HOSTNAME_SETTING = `${ADAPTER_ID}.hostname`;
const PORT_SETTING = `${ADAPTER_ID}.port`;
const TIMEOUT_SETTING = `${ADAPTER_ID}.timeoutMs`;
const AUTO_START_SETTING = `${ADAPTER_ID}.autoStart`;
const AGENT_SETTING = `${ADAPTER_ID}.agent`;

const DEFAULT_HOSTNAME = "127.0.0.1";
// Deliberately not 4096. The `opencode` TUI (and its internal server) commonly listens
// on 4096. Using a different default lets the SDK auto-start path coexist with a
// running opencode session without instant "port in use" fights. Users can still
// point at an existing server on 4096 by setting opencode.sdk.baseUrl or by changing
// the port setting.
const DEFAULT_PORT = 54321;
const DEFAULT_TIMEOUT_MS = 5000;

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

interface OpenCodeModelSelection {
  providerID?: string;
  modelID?: string;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function modelIdFor(providerID: string, modelID: string): string {
  return `${MODEL_PREFIX}${providerID}:${modelID}`;
}

function decodeModelId(modelId: string): OpenCodeModelSelection {
  if (modelId === FALLBACK_MODEL_ID || !modelId.startsWith(MODEL_PREFIX)) return {};
  const rest = modelId.slice(MODEL_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0) return {};
  const providerID = rest.slice(0, split);
  const modelID = rest.slice(split + 1);
  return providerID && modelID ? { providerID, modelID } : {};
}

function toRegisteredModel(providerID: string, modelID: string, provider: Provider): ModelSpec {
  const model = provider.models[modelID];
  return {
    id: modelIdFor(providerID, modelID),
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: model?.name || `${provider.name || providerID} ${modelID}`,
    description: `OpenCode SDK model ${providerID}/${modelID}.`,
    contextWindow: model?.limit?.context,
    maxOutputTokens: model?.limit?.output,
    inputPrice: model?.cost?.input,
    outputPrice: model?.cost?.output,
    capabilities: {
      tools: model?.capabilities?.toolcall !== false,
      images: model?.capabilities?.input?.image === true,
      reasoning: model?.capabilities?.reasoning === true,
    },
    aliases: [`${providerID}/${modelID}`],
  };
}

function fallbackModel(): ModelSpec {
  return {
    id: FALLBACK_MODEL_ID,
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: "OpenCode default",
    description: "OpenCode SDK using the active/default OpenCode model configuration.",
    capabilities: { tools: true, reasoning: true, images: true },
  };
}

function modelsFromProviders(payload: unknown): ModelSpec[] {
  const data = payload as { providers?: Provider[]; default?: Record<string, string> } | undefined;
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  const models: ModelSpec[] = [];

  for (const provider of providers) {
    if (!provider?.id || !provider.models) continue;
    const modelIDs = Object.keys(provider.models);
    for (const modelID of modelIDs) models.push(toRegisteredModel(provider.id, modelID, provider));
  }

  return models.length > 0 ? models : [fallbackModel()];
}

function emitPart(part: Part, controller: ProviderStreamController): void {
  if (part.type === "text" && part.text) {
    controller.emit({ type: "text-delta", delta: part.text });
    return;
  }
  if (part.type === "reasoning" && part.text) {
    controller.emit({ type: "reasoning-delta", delta: part.text });
    return;
  }
  if (part.type !== "tool") return;

  const id = part.callID || part.id;
  if (part.state.status === "pending" || part.state.status === "running") {
    controller.emit({ type: "tool-call", id, toolName: part.tool, args: part.state.input });
    return;
  }
  if (part.state.status === "completed") {
    controller.emit({ type: "tool-result", id, result: part.state.output, isError: false });
    return;
  }
  if (part.state.status === "error") {
    controller.emit({ type: "tool-result", id, result: part.state.error, isError: true });
  }
}

function usageFromMessage(message: {
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}): ProviderUsageSnapshot {
  const tokens = message.tokens;
  if (!tokens) return {};
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cache.read,
    cacheWriteTokens: tokens.cache.write,
  };
}

async function unwrapResponse<T>(promise: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const result = await promise;
  if (result.error !== undefined) {
    const message =
      typeof result.error === "object" && result.error !== null && "message" in result.error
        ? String((result.error as { message?: unknown }).message)
        : JSON.stringify(result.error);
    throw new Error(message || `OpenCode SDK request failed with ${result.response.status}`);
  }
  if (result.data === undefined) throw new Error(`OpenCode SDK request returned no data (${result.response.status})`);
  return result.data;
}

class OpenCodeSdkSession implements ProviderSession {
  readonly adapterId = ADAPTER_ID;
  readonly providerId = PROVIDER_ID;
  readonly mode = "persistent" as const;
  readonly strategy = "singleton" as const;

  private client: OpenCodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  /** Ownership epoch. `disconnect()` advances it; a startup that was suspended
   *  across that boundary must close what it created instead of storing it. */
  private epoch = 0;
  private disconnected = false;

  constructor(private readonly ctx: ProviderConnectionContext) {}

  /** The host's workspace, which can drift from `process.cwd()` after `cd`
   *  inside the bash tool. `services` is always supplied on `connect()`. */
  private directory(): string {
    return this.ctx.workspace?.cwd() ?? process.cwd();
  }

  private assertOwned(epoch: number): void {
    if (epoch !== this.epoch) throw new Error("OpenCode SDK session was disconnected during startup.");
  }

  private async ensureClient(epoch: number, signal?: AbortSignal): Promise<OpenCodeClient> {
    if (this.client) return this.client;
    const directory = this.directory();

    const configuredBaseUrl = normalizeBaseUrl(this.ctx.settings.get<string>(BASE_URL_SETTING, "") ?? "");
    if (configuredBaseUrl) {
      this.client = createOpencodeClient({ baseUrl: configuredBaseUrl, directory });
      return this.client;
    }

    const autoStart = this.ctx.settings.get<boolean>(AUTO_START_SETTING, true) !== false;
    if (!autoStart) {
      throw new Error("OpenCode SDK base URL is empty and auto-start is disabled.");
    }

    const hostname = this.ctx.settings.get<string>(HOSTNAME_SETTING, DEFAULT_HOSTNAME) || DEFAULT_HOSTNAME;
    const requestedPort = this.ctx.settings.get<number>(PORT_SETTING, DEFAULT_PORT) ?? DEFAULT_PORT;
    const timeout = this.ctx.settings.get<number>(TIMEOUT_SETTING, DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

    let server: { url: string; close(): void };
    // The SDK binds its signal to the server process for the server's whole
    // life (bindAbort is only cleared on exit). Hand it a startup-only signal
    // that the turn aborts while booting and is detached from afterwards, so a
    // Stop during a cold boot ends the wait but a later Esc never kills the
    // long-lived server.
    const startup = new AbortController();
    const onTurnAbort = () => startup.abort(signal?.reason);
    if (signal?.aborted) startup.abort(signal.reason);
    else signal?.addEventListener("abort", onTurnAbort, { once: true });
    try {
      server = await createOpencodeServer({ hostname, port: requestedPort, timeout, signal: startup.signal });
    } catch (err) {
      if (startup.signal.aborted) throw new Error("OpenCode server start was cancelled.");
      throw improveOpenCodeServerStartError(err, requestedPort);
    } finally {
      signal?.removeEventListener("abort", onTurnAbort);
    }
    if (epoch !== this.epoch) {
      // Disconnected while the server was booting: it is ours to close, not to keep.
      server.close();
      this.assertOwned(epoch);
    }
    this.server = server;
    this.client = createOpencodeClient({ baseUrl: server.url, directory });
    return this.client;
  }

  private async ensureSession(client: OpenCodeClient, epoch: number): Promise<string> {
    if (this.sessionId) return this.sessionId;
    this.assertOwned(epoch);
    const session = await unwrapResponse(client.session.create({ query: { directory: this.directory() } }));
    // A session that lands after disconnect belongs to nobody; do not adopt it.
    this.assertOwned(epoch);
    this.sessionId = session.id;
    return session.id;
  }

  async sendTurn(
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> {
    if (this.disconnected) throw new Error("OpenCode SDK session has been disconnected.");
    const epoch = this.epoch;

    // Owned before startup, so a disconnect during a pending server/session
    // creation aborts this turn as well as the prompt it never reached.
    const abortController = new AbortController();
    this.abortController = abortController;
    const onHostAbort = () => abortController.abort(input.abortSignal?.reason);
    if (input.abortSignal) {
      if (input.abortSignal.aborted) abortController.abort(input.abortSignal.reason);
      else input.abortSignal.addEventListener("abort", onHostAbort, { once: true });
    }

    controller.emit({ type: "status", status: "connecting", message: "Connecting to OpenCode SDK" });

    try {
      const client = await this.ensureClient(epoch, abortController.signal);
      const sessionId = await this.ensureSession(client, epoch);
      this.assertOwned(epoch);
      abortController.signal.throwIfAborted();

      const selection = decodeModelId(input.modelId);
      const agent = this.ctx.settings.get<string>(AGENT_SETTING, "")?.trim();
      controller.emit({ type: "status", status: "streaming", message: "OpenCode SDK turn running" });

      const body: Parameters<OpenCodeClient["session"]["prompt"]>[0]["body"] = {
        ...(selection.providerID && selection.modelID
          ? { model: { providerID: selection.providerID, modelID: selection.modelID } }
          : {}),
        ...(agent ? { agent } : {}),
        parts: [{ type: "text", text: input.prompt }],
      };

      const result = await unwrapResponse(
        client.session.prompt({
          path: { id: sessionId },
          query: { directory: this.directory() },
          signal: abortController.signal,
          body,
        }),
      );

      for (const part of result.parts) emitPart(part, controller);
      const usage = usageFromMessage(result.info);
      controller.emit({ type: "usage", usage });
      controller.emit({ type: "done", stopReason: result.info.finish ?? "stop" });
      return { usage };
    } catch (err) {
      if (!abortController.signal.aborted) await this.dropDeadServer(epoch);
      const message = err instanceof Error ? err.message : String(err);
      controller.emit({ type: "error", message });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      input.abortSignal?.removeEventListener("abort", onHostAbort);
      if (this.abortController === abortController) this.abortController = null;
    }
  }

  /** A failed turn on a server we started may mean the server died. If its URL
   *  no longer answers, forget it (and the client/session bound to it) so the
   *  next turn boots a fresh one instead of failing against a dead port. */
  private async dropDeadServer(epoch: number): Promise<void> {
    const server = this.server;
    if (!server || epoch !== this.epoch) return;
    if (await serverAnswers(server.url)) return;
    if (this.server !== server || epoch !== this.epoch) return;
    server.close();
    this.server = null;
    this.client = null;
    this.sessionId = null;
  }

  async abortTurn(): Promise<void> {
    this.abortController?.abort();
    if (this.client && this.sessionId) {
      await unwrapResponse(
        this.client.session.abort({ path: { id: this.sessionId }, query: { directory: this.directory() } }),
      ).catch(() => false);
    }
  }

  async disconnect(): Promise<void> {
    // Ownership first, I/O second: advancing the epoch invalidates any startup
    // still in flight before anything it created could be stored.
    this.disconnected = true;
    this.epoch += 1;
    const client = this.client;
    const server = this.server;
    const sessionId = this.sessionId;
    this.server = null;
    this.client = null;
    this.sessionId = null;

    const active = this.abortController;
    this.abortController = null;
    active?.abort();
    if (active && client && sessionId && !server) {
      // An external server keeps running the prompt after the local request
      // is dropped; tell it to stop. Best effort — the owner is gone either way.
      await unwrapResponse(
        client.session.abort({ path: { id: sessionId }, query: { directory: this.directory() } }),
      ).catch(() => false);
    }
    if (server) {
      server.close();
      // Await the process actually going away, not just the kill being sent.
      //
      // The SDK returns `{ url, close(): void }` and never exposes the child,
      // which I previously recorded as "cannot be closed from this side". That
      // was wrong: `close()` calls `proc.kill()`, and the server is an HTTP
      // listener on a URL we know — so its disappearance is observable. Polling
      // the URL until it stops answering is a real completion signal, and it is
      // what stops a disable/enable cycle racing the old process for the port.
      await waitForServerStopped(server.url);
    }
  }
}

/** True when anything at all answers HTTP at `url`. Never throws. */
async function serverAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve once nothing answers at `url`, or after `timeoutMs`.
 *
 * A refused connection is success — that is the port going dead. Any HTTP
 * response at all means the old server is still up. Never throws: teardown must
 * not fail because a probe did.
 */
async function waitForServerStopped(url: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(250) });
    } catch {
      return; // Refused or timed out: the listener is gone.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function opencodeCliInstalled(): boolean {
  // A PATH stat, not a subprocess. This runs in the synchronous prologue of
  // checkOpenCode, which the render-path credential check invokes — spawning
  // `opencode --version` blocked the event loop ~300ms.
  return isBinaryInstalled("opencode");
}

async function checkOpenCode(ctx: ProviderConnectionContext): Promise<CredentialStatus> {
  const baseUrl = normalizeBaseUrl(ctx.settings.get<string>(BASE_URL_SETTING, "") ?? "");
  if (baseUrl) {
    try {
      const directory = ctx.workspace?.cwd() ?? process.cwd();
      const client = createOpencodeClient({ baseUrl, directory });
      await unwrapResponse(client.config.get({ query: { directory } }));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `OpenCode server at ${baseUrl} is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (ctx.settings.get<boolean>(AUTO_START_SETTING, true) === false) {
    return {
      ok: false,
      reason: "OpenCode SDK base URL is empty and auto-start is disabled.",
    };
  }

  if (!opencodeCliInstalled()) {
    return {
      ok: false,
      reason: "OpenCode CLI not found. Install the `opencode` command or set opencode.sdk.baseUrl.",
      needsUserAction: "install-cli",
    };
  }

  // CLI is present and auto-start is allowed. We don't actually start the server here
  // (that happens on first turn), so we can only say "probably ready". A port conflict
  // or bad opencode config will surface with a clearer message when ensureClient runs.
  return { ok: true };
}

function improveOpenCodeServerStartError(err: unknown, port: number): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (/port .* in use|Failed to start server|address already in use/i.test(raw)) {
    return new Error(
      `OpenCode server failed to listen on port ${port} (already in use).\n` +
        `This usually means another opencode process (the TUI, a previous serve, or another codesurf session) is using it.\n` +
        `Quick fixes:\n` +
        `  • /opencode-sdk  then change the port setting (e.g. opencode.sdk.port = 54322)\n` +
        `  • kill the other listener (lsof -i :${port})\n` +
        `  • or set opencode.sdk.baseUrl to point at an already-running opencode server.`,
    );
  }
  // Preserve the original output for other failures (missing binary inside the child, bad config, etc.)
  return err instanceof Error ? err : new Error(raw);
}

async function listOpenCodeModels(settings: ProviderConnectionContext["settings"]): Promise<ModelSpec[]> {
  const baseUrl = normalizeBaseUrl(settings.get<string>(BASE_URL_SETTING, "") ?? "");
  let server: { url: string; close(): void } | null = null;

  try {
    let modelBaseUrl = baseUrl;
    if (!modelBaseUrl) {
      const autoStart = settings.get<boolean>(AUTO_START_SETTING, true) !== false;
      if (!autoStart || !opencodeCliInstalled()) return [fallbackModel()];

      const hostname = settings.get<string>(HOSTNAME_SETTING, DEFAULT_HOSTNAME) || DEFAULT_HOSTNAME;
      const requestedPort = settings.get<number>(PORT_SETTING, DEFAULT_PORT) ?? DEFAULT_PORT;
      const timeout = settings.get<number>(TIMEOUT_SETTING, DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
      try {
        // Port 0, not the configured port. Discovery's server is a throwaway
        // used for one `config.providers` read, and starting it on the
        // configured port made it fight the session server (or the user's own
        // `opencode serve`) for the listener. To read models FROM an
        // already-running server, point the base-URL setting at it.
        server = await createOpencodeServer({ hostname, port: 0, timeout });
      } catch (err) {
        throw improveOpenCodeServerStartError(err, requestedPort);
      }
      modelBaseUrl = server.url;
    }

    const client = createOpencodeClient({ baseUrl: modelBaseUrl, directory: process.cwd() });
    const payload = await unwrapResponse(client.config.providers({ query: { directory: process.cwd() } }));
    return modelsFromProviders(payload);
  } finally {
    server?.close();
  }
}

function formatStatus(baseUrl: string, autoStart: boolean, agent: string): string {
  return [
    "OpenCode SDK",
    `Base URL: ${baseUrl || "(auto-start local opencode server)"}`,
    `Auto-start: ${autoStart ? "on" : "off"}`,
    `Agent: ${agent || "(OpenCode default)"}`,
  ].join("\n");
}

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "OpenCode SDK",
  version: "1.0.0",
  description: "OpenCode models via the official @opencode-ai/sdk server client.",
  group: CODESURF_PROVIDERS_GROUP,
  enabledByDefault: false,
  protected: false,
  capabilities: ["provider-adapters", "models", "settings", "commands"],
};

export const opencodeProviderPlugin: CodesurfPlugin = {
  name: "codesurf-opencode-provider",
  manifest,
  inject: ["contributions", "settings", "chat", "workspace", "session"],
  apply(ctx: PluginContext) {
    const settings = ctx.settings;

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BASE_URL_SETTING,
        title: "OpenCode SDK base URL",
        description:
          "Existing OpenCode server URL (e.g. http://127.0.0.1:4096). Leave blank to auto-start a local `opencode serve` on the configured port. Use this to attach to a server already running from the normal `opencode` TUI or `opencode serve`.",
        type: "string",
        default: "",
        section: "OpenCode SDK",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: AUTO_START_SETTING,
        title: "OpenCode SDK auto-start",
        description: "Start `opencode serve` through the SDK when no base URL is configured.",
        type: "boolean",
        default: true,
        section: "OpenCode SDK",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: HOSTNAME_SETTING,
        title: "OpenCode SDK hostname",
        description: "Hostname used when auto-starting the OpenCode server.",
        type: "string",
        default: DEFAULT_HOSTNAME,
        section: "OpenCode SDK",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: PORT_SETTING,
        title: "OpenCode SDK port",
        description: "Port used when auto-starting the OpenCode server.",
        type: "number",
        default: DEFAULT_PORT,
        section: "OpenCode SDK",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: TIMEOUT_SETTING,
        title: "OpenCode SDK startup timeout",
        description: "Milliseconds to wait for an auto-started OpenCode server.",
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        section: "OpenCode SDK",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: AGENT_SETTING,
        title: "OpenCode SDK agent",
        description: "Optional OpenCode agent name to use for prompts. Blank uses OpenCode default.",
        type: "string",
        default: "",
        section: "OpenCode SDK",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "OpenCode SDK",
        description: "Official @opencode-ai/sdk bridge. Auth, tools, permissions, and config are owned by OpenCode.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "sdk",
        connectionMode: "persistent",
        sessionStrategy: "singleton",
        capabilities: { streaming: false, tools: true, images: true, reasoning: true },
        models: [fallbackModel()],
        listModels: () => listOpenCodeModels(settings),
        auth: { mode: "none", check: checkOpenCode },
        adapter: {
          connect: (ctx: ProviderConnectionContext): ProviderSession => new OpenCodeSdkSession(ctx),
        },
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/opencode-sdk",
        aliases: ["/opencode"],
        description: "Show OpenCode SDK provider status and docs URL.",
        argsHint: "[status|docs|models]",
        handler: async ({ args }) => {
          const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
          const baseUrl = normalizeBaseUrl(settings.get<string>(BASE_URL_SETTING, "") ?? "");
          if (subcommand === "docs") {
            ctx.chat.appendAssistant("OpenCode SDK docs: https://opencode.ai/docs/sdk/");
            return;
          }
          if (subcommand === "models") {
            try {
              const models = await listOpenCodeModels(settings);
              ctx.chat.appendAssistant(`OpenCode SDK models\n${models.map((model) => `- ${model.id}`).join("\n")}`);
            } catch (err) {
              ctx.chat.appendAssistant(
                `OpenCode SDK models unavailable: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            return;
          }
          if (subcommand !== "status") {
            ctx.chat.appendAssistant("Usage: /opencode-sdk [status|docs|models]");
            return;
          }
          const autoStart = settings.get<boolean>(AUTO_START_SETTING, true) !== false;
          const agent = settings.get<string>(AGENT_SETTING, "")?.trim() ?? "";
          const status = await checkOpenCode({
            conversationId: ctx.session.id() ?? "ephemeral",
            adapterId: ADAPTER_ID,
            providerId: PROVIDER_ID,
            settings,
          });
          ctx.chat.appendAssistant(
            `${formatStatus(baseUrl, autoStart, agent)}\nStatus: ${status.ok ? "ready" : status.reason}`,
          );
        },
      }),
    );
  },
};

export {
  ADAPTER_ID as OPENCODE_SDK_ADAPTER_ID,
  BASE_URL_SETTING as OPENCODE_SDK_BASE_URL_SETTING,
  decodeModelId,
  emitPart,
  FALLBACK_MODEL_ID as OPENCODE_SDK_FALLBACK_MODEL_ID,
  modelsFromProviders,
  normalizeBaseUrl as normalizeOpenCodeBaseUrl,
};
