// Builtin Hermes Gateway provider.
//
// Routes CodeSurf chat turns through a running Hermes gateway using the
// OpenAI-compatible HTTP chat-completions endpoint. This intentionally does
// not auto-start or auto-discover Hermes. Normal CodeSurf/Hermes commands stay
// direct unless the user explicitly selects this provider or points settings at
// a gateway URL.

import { homedir } from "node:os";
import { join } from "node:path";
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
import { anthropicContextWindow } from "../builtin/anthropic-models-catalog";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";
// Pure config discovery + parsing lives in ./hermes-config (extracted
// 2026-06-22). This module keeps the HTTP session / credential / registry
// concerns and re-imports the config surface it needs.
import {
  DEFAULT_BASE_URL,
  decodeHermesModelSelection,
  dedupeModels,
  discoverHermesConfig,
  docsUrl,
  endpointUrl,
  FALLBACK_MODEL_ID,
  FALLBACK_MODELS,
  formatDiscoveredConfig,
  gatewayRootUrl,
  type HermesDiscoveredConfig,
  type HermesModelSpec,
  healthUrl,
  inferProviderFromModelId,
  normalizeBaseUrl,
  normalizeHermesModelProvider,
  parseHermesAuthJson,
  parseHermesAuthProviderIds,
  parseHermesModelsJson,
  parseHermesPythonSettings,
  parseHermesRustSettings,
  registeredHermesModelId,
} from "../builtin/hermes-config";
import { normalizeOpenAiMessages } from "../builtin/openai-chat-utils";
import { consumeOpenAiSseStream } from "../builtin/openai-sse-consumer";

const EXTENSION_ID = "builtin.provider-hermes-gateway";
const PROVIDER_ID = "hermes";
const ADAPTER_ID = "hermes.gateway";

const BASE_URL_SETTING = `${ADAPTER_ID}.baseUrl`;
const API_KEY_SETTING = `${ADAPTER_ID}.apiKey`;
const DEFAULT_MODEL_SETTING = `${ADAPTER_ID}.defaultModel`;
const HERMES_HOME_SETTING = `${ADAPTER_ID}.hermesHome`;
const HERMES_CONFIG_PATH_SETTING = `${ADAPTER_ID}.configPath`;
const HERMES_RS_CONFIG_PATH_SETTING = `${ADAPTER_ID}.rustConfigPath`;
const READ_HERMES_CONFIG_SETTING = `${ADAPTER_ID}.readHermesConfig`;
const TIMEOUT_MS_SETTING = `${ADAPTER_ID}.timeoutMs`;
const VERBOSE_SETTING = `${ADAPTER_ID}.verbose`;

const DEFAULT_MODEL = "hermes-agent";
const DEFAULT_TIMEOUT_MS = 120_000;
type HermesAbortReason = "host" | "session" | "timeout";

type SettingsService = ProviderConnectionContext["settings"];

function toRegisteredModels(models: HermesModelSpec[] = FALLBACK_MODELS): ModelSpec[] {
  return models.map((model) => ({
    id: registeredHermesModelId(model),
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: model.label,
    description: [
      model.description,
      model.provider ? `Provider: ${model.provider}.` : "",
      model.source ? `Source: ${model.source}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    contextWindow: model.contextWindow ?? anthropicContextWindow(model.id),
    capabilities: model.capabilities,
  }));
}

// Message stringification + normalization moved to `./openai-chat-utils`
// (shared with the other OpenAI-shaped providers).

// OpenAI-shaped SSE consumer + tool-call assembly moved to
// `./openai-sse-consumer.ts` (shared with lightclaw). Hermes's
// `hermes.tool.progress` branch is now passed via the consumer's
// `onNamedEvent` hook in sendTurn. The custom branch parses
// { tool, emoji, label, toolCallId, status } payloads emitted when the
// gateway-side agent starts/finishes a server-side tool call.

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeHermesToolStatus(status: string | undefined): "running" | "completed" | "failed" | null {
  switch ((status ?? "").trim().toLowerCase()) {
    case "running":
    case "started":
    case "start":
    case "tool.started":
      return "running";
    case "completed":
    case "complete":
    case "finished":
    case "done":
    case "tool.completed":
      return "completed";
    case "failed":
    case "error":
    case "errored":
    case "tool.failed":
      return "failed";
    default:
      return null;
  }
}

async function consumeOpenAiJsonResponse(
  response: Response,
  controller: ProviderStreamController,
): Promise<ProviderUsageSnapshot | undefined> {
  const payload = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string; reasoning?: string; reasoning_content?: string };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = payload.choices?.[0]?.message;
  if (typeof message?.reasoning === "string") controller.emit({ type: "reasoning-delta", delta: message.reasoning });
  if (typeof message?.reasoning_content === "string") {
    controller.emit({ type: "reasoning-delta", delta: message.reasoning_content });
  }
  if (typeof message?.content === "string") controller.emit({ type: "text-delta", delta: message.content });
  const usage = payload.usage
    ? {
        inputTokens: payload.usage.prompt_tokens,
        outputTokens: payload.usage.completion_tokens,
      }
    : undefined;
  controller.emit({ type: "usage", usage: usage ?? {} });
  controller.emit({ type: "done", stopReason: payload.choices?.[0]?.finish_reason ?? "stop" });
  return usage;
}

class HermesGatewaySession implements ProviderSession {
  readonly adapterId: string = ADAPTER_ID;
  readonly providerId: string = PROVIDER_ID;
  readonly mode = "stateless" as const;
  readonly strategy = "per-turn" as const;

  private readonly resolvers: {
    baseUrl: () => string;
    apiKey: () => string;
    defaultModel: () => string;
    timeoutMs: () => number;
    verbose: () => boolean;
  };
  private activeAbort: ((reason: HermesAbortReason) => void) | null = null;

  constructor(resolvers: {
    baseUrl: () => string;
    apiKey: () => string;
    defaultModel: () => string;
    timeoutMs: () => number;
    verbose: () => boolean;
  }) {
    this.resolvers = resolvers;
    // Fire-and-forget warmup of the default model with reasoning disabled.
    // Codex/GPT-5.x models have a multi-second cold-start before the first
    // SSE byte arrives; a tiny no-reasoning request loads the upstream client
    // on the gateway so the user's first real turn streams immediately.
    void warmHermesModel(this.resolvers).catch(() => {
      // Best-effort; warmup failure should never break the session.
    });
  }

  sendTurn = async (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> => {
    const baseUrl = this.resolvers.baseUrl();
    const apiKey = this.resolvers.apiKey();
    const timeoutMs = this.resolvers.timeoutMs();
    const verbose = this.resolvers.verbose();
    const rawSelectedModel = input.modelId === FALLBACK_MODEL_ID ? this.resolvers.defaultModel() : input.modelId;
    const selectedModel = decodeHermesModelSelection(rawSelectedModel);

    const body: Record<string, unknown> = {
      model: selectedModel.model || DEFAULT_MODEL,
      messages: normalizeOpenAiMessages(input as never),
      stream: true,
    };
    if (selectedModel.provider) body.provider = selectedModel.provider;
    // Do not forward CodeSurf host tools to Hermes. The gateway creates its
    // own AIAgent with Hermes-native tools; forwarding host tool schemas can
    // break upstream providers with incompatible tool formats.

    controller.emit({ type: "status", status: "connecting", message: "Connecting to Hermes gateway" });

    const abortController = new AbortController();
    let abortReason: HermesAbortReason | null = null;
    const abort = (reason: HermesAbortReason) => {
      abortReason ??= reason;
      abortController.abort();
    };
    this.activeAbort = abort;
    // An idle timeout, not a wall clock: a long agent turn that keeps streaming
    // is healthy however long it runs. Re-armed on headers and on every chunk.
    let timeout = setTimeout(() => abort("timeout"), timeoutMs);
    const touch = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => abort("timeout"), timeoutMs);
    };
    const abortFromHost = () => abort("host");
    if (input.abortSignal) {
      if (input.abortSignal.aborted) abortFromHost();
      else input.abortSignal.addEventListener("abort", abortFromHost, { once: true });
    }

    try {
      const response = await fetch(endpointUrl(baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `Hermes gateway /chat/completions returned ${response.status}`);
      }

      touch();
      controller.emit({ type: "status", status: "streaming", message: "Hermes gateway streaming" });

      const contentType = response.headers.get("content-type") ?? "";
      if (response.body && /text\/event-stream/i.test(contentType)) {
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, stream) {
              touch();
              stream.enqueue(chunk);
            },
          }),
        );
        const usage = await consumeOpenAiSseStream(body, {
          controller,
          verbose,
          abortSignal: abortController.signal,
          // Hermes layers `event: hermes.tool.progress` on top of standard
          // OpenAI SSE to surface gateway-side tool lifecycle. Translate
          // running/completed into matching tool-call/tool-result events
          // so the transcript shows what the server-side agent did.
          onNamedEvent: (eventName, data) => {
            if (eventName !== "hermes.tool.progress") return false;
            let payload: Record<string, unknown> = {};
            try {
              payload = JSON.parse(data);
            } catch {
              if (verbose) {
                controller.emit({
                  type: "error",
                  message: `Failed to parse Hermes tool progress chunk: ${data.slice(0, 120)}`,
                });
              }
              return true;
            }
            const id =
              stringField(payload, "toolCallId") ?? stringField(payload, "tool_call_id") ?? stringField(payload, "id");
            const status = normalizeHermesToolStatus(stringField(payload, "status") ?? stringField(payload, "event"));
            if (id && status === "running") {
              controller.emit({
                type: "tool-call",
                id,
                toolName:
                  stringField(payload, "tool") ??
                  stringField(payload, "name") ??
                  stringField(payload, "tool_name") ??
                  "unknown",
                args: {
                  label: stringField(payload, "label") ?? stringField(payload, "preview") ?? "",
                  emoji: stringField(payload, "emoji") ?? "",
                },
              });
            } else if (id && status === "completed") {
              controller.emit({ type: "tool-result", id, result: {} });
            } else if (id && status === "failed") {
              controller.emit({
                type: "tool-result",
                id,
                result: {
                  success: false,
                  error: stringField(payload, "error") ?? stringField(payload, "message") ?? "Hermes tool failed.",
                },
              });
            }
            return true;
          },
        });
        return { usage };
      }
      const usage = await consumeOpenAiJsonResponse(response, controller);
      return { usage };
    } catch (err) {
      const message =
        abortReason === "timeout"
          ? `Hermes gateway timed out after ${timeoutMs}ms without output`
          : abortReason === "host" || abortReason === "session"
            ? "Hermes gateway turn aborted"
            : err instanceof Error
              ? err.message
              : String(err);
      controller.emit({ type: "error", message });
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
      if (input.abortSignal) input.abortSignal.removeEventListener("abort", abortFromHost);
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  };

  abortTurn = async (): Promise<void> => {
    this.activeAbort?.("session");
  };

  disconnect = async (): Promise<void> => {
    await this.abortTurn();
  };
}

// Track which (baseUrl, model, provider) tuples have been warmed during the
// life of this process so we don't re-warm on every connect().
const warmedHermesTargets = new Set<string>();

async function warmHermesModel(resolvers: {
  baseUrl: () => string;
  apiKey: () => string;
  defaultModel: () => string;
  timeoutMs: () => number;
}): Promise<void> {
  const baseUrl = resolvers.baseUrl();
  const apiKey = resolvers.apiKey();
  const rawDefault = resolvers.defaultModel();
  if (!rawDefault) return;
  const selection = decodeHermesModelSelection(rawDefault);
  const model = selection.model || DEFAULT_MODEL;
  const provider = selection.provider ?? "";
  const key = `${baseUrl}|${provider}|${model}`;
  if (warmedHermesTargets.has(key)) return;
  warmedHermesTargets.add(key);

  // 15s cap is enough for cold-start across upstreams; longer than that and
  // the user's first real turn will reach the gateway anyway.
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);

  // Reasoning-disabled, single-token throwaway. We forward both the OpenAI
  // chat-completions `reasoning_effort` field (gpt-5 / o-series) and the
  // newer `reasoning: {effort}` shape so whichever upstream Hermes maps
  // through honors it.
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: "." }],
    stream: false,
    max_tokens: 1,
    max_completion_tokens: 1,
    reasoning_effort: "minimal",
    reasoning: { effort: "minimal" },
  };
  if (provider) body.provider = provider;

  try {
    await fetch(endpointUrl(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function resolveHermesHomeFromSettings(settings: SettingsService): string {
  const configured = settings.get<string>(HERMES_HOME_SETTING, "")?.trim();
  if (configured) return configured;
  const envHome = process.env.HERMES_HOME?.trim();
  if (envHome) return envHome;
  return join(homedir(), ".hermes");
}

function resolveRustConfigPathFromSettings(settings: SettingsService): string {
  return settings.get<string>(HERMES_RS_CONFIG_PATH_SETTING, "")?.trim() ?? "";
}

function resolvePythonConfigPathFromSettings(settings: SettingsService): string {
  return settings.get<string>(HERMES_CONFIG_PATH_SETTING, "")?.trim() ?? "";
}

function resolveReadHermesConfigFromSettings(settings: SettingsService): boolean {
  return settings.get<boolean>(READ_HERMES_CONFIG_SETTING, true) !== false;
}

function discoverHermesConfigFromSettings(settings: SettingsService): HermesDiscoveredConfig {
  return discoverHermesConfig({
    hermesHome: resolveHermesHomeFromSettings(settings),
    pythonConfigPath: resolvePythonConfigPathFromSettings(settings),
    rustConfigPath: resolveRustConfigPathFromSettings(settings),
    readConfig: resolveReadHermesConfigFromSettings(settings),
  });
}

function resolveGatewayBaseUrlFromSettings(settings: SettingsService): string {
  const configured = settings.get<string>(BASE_URL_SETTING, "")?.trim() ?? "";
  if (configured) return normalizeBaseUrl(configured);
  return normalizeBaseUrl(discoverHermesConfigFromSettings(settings).gatewayBaseUrl ?? DEFAULT_BASE_URL);
}

function checkCredential(ctx: ProviderConnectionContext): CredentialStatus {
  const baseUrl = resolveGatewayBaseUrlFromSettings(ctx.settings);
  if (!baseUrl) {
    return {
      ok: false,
      reason: "Hermes gateway base URL is not configured. Set hermes.gateway.baseUrl in /plugins.",
    };
  }
  return { ok: true };
}

async function fetchGatewayJson(baseUrl: string, path: string, apiKey: string, timeoutMs: number): Promise<unknown> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(endpointUrl(baseUrl, path), {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: abortController.signal,
    });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseModels(payload: unknown): HermesModelSpec[] {
  const asRecord =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord.data)
      ? asRecord.data
      : Array.isArray(asRecord.models)
        ? asRecord.models
        : [];
  return source
    .map((item): HermesModelSpec | null => {
      if (typeof item === "string") {
        return {
          id: item,
          label: item,
          description: "Model advertised by the Hermes gateway.",
          capabilities: { tools: true, reasoning: true, images: false },
        };
      }
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      const id = typeof row?.id === "string" ? row.id : typeof row?.name === "string" ? row.name : "";
      if (!id) return null;
      const label = typeof row?.label === "string" ? row.label : id;
      const contextWindow = typeof row?.context_window === "number" ? row.context_window : undefined;
      return {
        id,
        label,
        description: "Model advertised by the Hermes gateway.",
        contextWindow,
        capabilities: { tools: true, reasoning: true, images: false },
      };
    })
    .filter((item): item is HermesModelSpec => item !== null);
}

function formatJsonSummary(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "ok");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 8);
  if (keys.length === 0) return "{}";
  return keys.map((key) => `${key}: ${JSON.stringify(record[key])}`).join("\n");
}

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Hermes Gateway",
  version: "1.0.0",
  description:
    "OpenAI-compatible provider adapter for a running Hermes gateway. Adds model routing and gateway health/status commands.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: false,
  enabledByDefault: false,
  capabilities: ["provider-adapters", "models", "settings", "commands"],
};

export const hermesGatewayProviderPlugin: CodesurfPlugin = {
  name: "codesurf-hermes-gateway-provider",
  manifest,
  inject: ["contributions", "settings", "chat", "ui", "session"],
  apply(ctx: PluginContext) {
    const settings = ctx.settings;

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BASE_URL_SETTING,
        title: "Hermes Gateway base URL",
        description: `OpenAI-compatible Hermes gateway base URL. Leave blank to read platforms.api_server from Hermes config, then fall back to ${DEFAULT_BASE_URL}.`,
        type: "string",
        default: "",
        section: "Hermes Gateway",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: API_KEY_SETTING,
        title: "Hermes Gateway API key",
        description:
          "Optional bearer token for gateways that require API authentication. Leave blank for local no-auth gateways.",
        type: "secret",
        default: "",
        section: "Hermes Gateway",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: DEFAULT_MODEL_SETTING,
        title: "Hermes Gateway default model",
        description: "Model sent when the fallback Hermes Gateway row is selected. Leave blank to read Hermes config.",
        type: "string",
        default: "",
        section: "Hermes Gateway",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: HERMES_HOME_SETTING,
        title: "Hermes home directory",
        description:
          "Hermes home containing config.yaml, models.json, and auth.json. Leave blank for $HERMES_HOME or ~/.hermes.",
        type: "string",
        default: "",
        section: "Hermes Gateway",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: HERMES_CONFIG_PATH_SETTING,
        title: "Hermes config.yaml path",
        description: "Optional explicit Python Hermes config path. Leave blank for <Hermes home>/config.yaml.",
        type: "string",
        default: "",
        section: "Hermes Gateway",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: HERMES_RS_CONFIG_PATH_SETTING,
        title: "hermes-rs config.toml path",
        description: "Optional hermes-rs TOML config path. Leave blank to skip rust config discovery.",
        type: "string",
        default: "",
        section: "Hermes Gateway",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: READ_HERMES_CONFIG_SETTING,
        title: "Read local Hermes config",
        description:
          "Read local Hermes config/model/provider files to populate the model picker. Secrets are never displayed.",
        type: "boolean",
        default: true,
        section: "Hermes Gateway",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: TIMEOUT_MS_SETTING,
        title: "Hermes Gateway timeout (ms)",
        description: "HTTP timeout for gateway chat and status calls.",
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        section: "Hermes Gateway",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: VERBOSE_SETTING,
        title: "Hermes Gateway verbose streaming",
        description: "Surface malformed SSE chunks as stream errors for debugging.",
        type: "boolean",
        default: false,
        section: "Hermes Gateway",
      }),
    );

    const resolveDiscoveredConfig = (): HermesDiscoveredConfig => discoverHermesConfigFromSettings(settings);
    const resolveBaseUrl = (): string => resolveGatewayBaseUrlFromSettings(settings);
    const resolveApiKey = (): string => settings.get<string>(API_KEY_SETTING, "") ?? "";
    const resolveDefaultModel = (): string =>
      settings.get<string>(DEFAULT_MODEL_SETTING, "")?.trim() ||
      resolveDiscoveredConfig().defaultModel ||
      DEFAULT_MODEL;
    const resolveTimeoutMs = (): number => {
      const raw = settings.get<unknown>(TIMEOUT_MS_SETTING, DEFAULT_TIMEOUT_MS);
      return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
    };
    const resolveVerbose = (): boolean => settings.get<boolean>(VERBOSE_SETTING, false) === true;

    ctx.effect(async () =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Hermes Gateway",
        description:
          "HTTP/SSE bridge to a running Hermes OpenAI-compatible gateway. Uses /v1/chat/completions for turns and optional /health / /v1/capabilities for diagnostics.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "http",
        connectionMode: "stateless",
        sessionStrategy: "per-turn",
        capabilities: { streaming: true, tools: true, images: false, reasoning: true },
        models: toRegisteredModels(),
        listModels: async () => {
          const discovered = resolveDiscoveredConfig().models;
          try {
            const payload = await fetchGatewayJson(resolveBaseUrl(), "/models", resolveApiKey(), resolveTimeoutMs());
            const models = parseModels(payload);
            return toRegisteredModels(dedupeModels([...models, ...discovered]));
          } catch {
            return toRegisteredModels(discovered);
          }
        },
        auth: { mode: "none", check: checkCredential },
        adapter: {
          connect: (): ProviderSession =>
            new HermesGatewaySession({
              baseUrl: resolveBaseUrl,
              apiKey: resolveApiKey,
              defaultModel: resolveDefaultModel,
              timeoutMs: resolveTimeoutMs,
              verbose: resolveVerbose,
            }),
        },
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerCommand({
        name: "/hermes-gateway",
        aliases: ["/hermes"],
        description: "Show Hermes gateway status, capabilities, or docs URL.",
        argsHint: "[status|capabilities|config|docs]",
        handler: async ({ args }) => {
          const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
          const baseUrl = resolveBaseUrl();
          const apiKey = resolveApiKey();
          const timeoutMs = resolveTimeoutMs();

          if (subcommand === "docs") {
            ctx.chat.appendAssistant(`Hermes Gateway docs: ${docsUrl(baseUrl)}`);
            return;
          }

          if (subcommand === "config" || subcommand === "settings") {
            ctx.chat.appendAssistant(formatDiscoveredConfig(resolveDiscoveredConfig(), baseUrl));
            return;
          }

          if (subcommand === "capabilities") {
            try {
              const capabilities = await fetchGatewayJson(baseUrl, "/capabilities", apiKey, timeoutMs);
              ctx.chat.appendAssistant(`Hermes Gateway capabilities\n${formatJsonSummary(capabilities)}`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              ctx.chat.appendAssistant(`Hermes Gateway capabilities unavailable: ${message}`);
            }
            return;
          }

          if (subcommand !== "status") {
            ctx.chat.appendAssistant("Usage: /hermes-gateway [status|capabilities|config|docs]");
            return;
          }

          const lines = [`Hermes Gateway`, `Base URL: ${baseUrl}`, `Docs: ${docsUrl(baseUrl)}`];
          try {
            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), timeoutMs);
            const response = await fetch(healthUrl(baseUrl), {
              headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
              signal: abortController.signal,
            });
            clearTimeout(timeout);
            lines.push(`Health: ${response.ok ? "ok" : `HTTP ${response.status}`}`);
            const contentType = response.headers.get("content-type") ?? "";
            if (/json/i.test(contentType)) {
              const body = await response.json().catch(() => null);
              if (body) lines.push(formatJsonSummary(body));
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lines.push(`Health: unavailable (${message})`);
          }

          ctx.chat.appendAssistant(lines.join("\n"));
        },
      }),
    );
  },
};

export {
  checkCredential,
  decodeHermesModelSelection,
  discoverHermesConfig,
  docsUrl,
  endpointUrl,
  formatDiscoveredConfig,
  gatewayRootUrl,
  HermesGatewaySession,
  healthUrl,
  inferProviderFromModelId,
  normalizeBaseUrl,
  normalizeHermesModelProvider,
  parseHermesAuthJson,
  parseHermesAuthProviderIds,
  parseHermesModelsJson,
  parseHermesPythonSettings,
  parseHermesRustSettings,
  parseModels,
  toRegisteredModels,
};
