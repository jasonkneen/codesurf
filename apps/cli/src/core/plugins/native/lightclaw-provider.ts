// Native Cordis plugin: the Lightclaw OpenAI-compatible provider.
//
// Converted from the V1 entry with identical behaviour: the same four settings
// (base URL, key, timeout, verbose), the same adapter and model ids, and the
// same shared `OpenAiHttpSession` transport, which now carries a whole-body
// timeout and a turn-owned abort controller.

import type {
  CodesurfPlugin,
  CredentialStatus,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
} from "@codesurf/plugin-api";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";
import { normalizeOpenAiMessages } from "../builtin/openai-chat-utils";
import { OpenAiHttpSession } from "../builtin/openai-http-session";

const EXTENSION_ID = "builtin.provider-lightclaw";
const PROVIDER_ID = "lightclaw";
const ADAPTER_ID = "lightclaw.http";

const BASE_URL_SETTING = `${ADAPTER_ID}.baseUrl`;
const API_KEY_SETTING = `${ADAPTER_ID}.apiKey`;
const TIMEOUT_MS_SETTING = `${ADAPTER_ID}.timeoutMs`;
const VERBOSE_SETTING = `${ADAPTER_ID}.verbose`;

const DEFAULT_BASE_URL = "";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_API_KEY = "";

// ── Models ───────────────────────────────────────────────────────────────────

interface LightclawModelSpec {
  id: string;
  label: string;
  description: string;
  contextWindow: number;
  maxOutputTokens?: number;
  aliases?: string[];
  capabilities?: { tools?: boolean; reasoning?: boolean; images?: boolean };
}

const LIGHTCLAW_MODELS: LightclawModelSpec[] = [
  {
    id: "owl-alpha",
    label: "OWL Alpha (Lightclaw)",
    description:
      "Lightclaw default agent model. High-reasoning, tool-capable. Routed through the lightclaw HTTP gateway.",
    contextWindow: 128_000,
    aliases: ["owl", "lightclaw-default"],
    capabilities: { tools: true, reasoning: false, images: false },
  },
  {
    id: "openrouter/owl-alpha",
    label: "OWL Alpha (Lightclaw via OpenRouter)",
    description: "Lightclaw default routed through OpenRouter. Same model, OpenRouter transport.",
    contextWindow: 128_000,
    aliases: ["or-owl", "owl-or"],
    capabilities: { tools: true, reasoning: false, images: false },
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5 (Lightclaw)",
    description: "Anthropic Claude Sonnet 5 via lightclaw. Latest balanced flagship with tool support.",
    contextWindow: 1_000_000,
    aliases: ["lc-sonnet"],
    capabilities: { tools: true, reasoning: true, images: false },
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 (Lightclaw)",
    description: "Anthropic Claude Sonnet 4.6 via lightclaw. Balanced flagship with tool support.",
    contextWindow: 1_000_000,
    aliases: [],
    capabilities: { tools: true, reasoning: true, images: false },
  },
  {
    id: "anthropic/claude-opus-4-7",
    label: "Claude Opus 4.7 (Lightclaw)",
    description: "Anthropic Claude Opus 4.7 via lightclaw. Flagship reasoning model.",
    contextWindow: 1_000_000,
    aliases: ["lc-opus"],
    capabilities: { tools: true, reasoning: true, images: false },
  },
];

function toModelSpecs(): ModelSpec[] {
  return LIGHTCLAW_MODELS.map((m) => ({
    id: m.id,
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: m.label,
    description: m.description,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    aliases: m.aliases,
    capabilities: m.capabilities,
  }));
}

// OpenAI-shaped SSE consumer moved to `./openai-sse-consumer.ts` — shared
// with hermes-gateway. The previous in-file consumer was a near-verbatim
// duplicate of hermes's, minus that adapter's `hermes.tool.progress`
// branch (the shared module exposes an `onNamedEvent` hook for that
// pattern). The session itself lives in `./openai-http-session.ts`
// (`OpenAiHttpSession`), shared with local-llm.

// ── Auth check ───────────────────────────────────────────────────────────────

function checkCredential(ctx: ProviderConnectionContext): CredentialStatus {
  const baseUrl = ctx.settings.get<string>(BASE_URL_SETTING, DEFAULT_BASE_URL);
  const apiKey = ctx.settings.get<string>(API_KEY_SETTING, DEFAULT_API_KEY);

  if (!baseUrl?.trim()) {
    return {
      ok: false,
      reason: "Lightclaw base URL is not configured. Set lightclaw.http.baseUrl in /plugins.",
      needsUserAction: "paste-api-key",
    };
  }
  if (!apiKey?.trim()) {
    return {
      ok: false,
      reason: "Lightclaw API key is not configured. Set lightclaw.http.apiKey in /plugins.",
      needsUserAction: "paste-api-key",
    };
  }
  return { ok: true };
}

// ── Extension module ─────────────────────────────────────────────────────────

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Lightclaw",
  version: "1.0.0",
  description:
    "AI agent streaming via lightclaw's OpenAI-compatible /chat/completions endpoint. Routes agent turns through a running lightclaw instance with tool-calling support.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: false,
  enabledByDefault: false,
  capabilities: ["provider-adapters", "models", "settings"],
};

export const lightclawProviderPlugin: CodesurfPlugin = {
  name: "codesurf-lightclaw-provider",
  manifest,
  inject: ["contributions", "settings"],
  apply(ctx: PluginContext) {
    const settings = ctx.settings;

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BASE_URL_SETTING,
        title: "Lightclaw base URL",
        description: "Base URL for the lightclaw OpenAI-compatible endpoint. Required.",
        type: "string",
        default: DEFAULT_BASE_URL,
        section: "Lightclaw",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: API_KEY_SETTING,
        title: "Lightclaw API key",
        description: "Bearer token / API key for the lightclaw endpoint. Required.",
        type: "secret",
        default: DEFAULT_API_KEY,
        section: "Lightclaw",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: TIMEOUT_MS_SETTING,
        title: "Request timeout (ms)",
        description: "HTTP request timeout for /chat/completions. Increase for long-running agent turns.",
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        section: "Lightclaw",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: VERBOSE_SETTING,
        title: "Verbose streaming",
        description: "Surface parse errors for individual SSE chunks as error events (for debugging).",
        type: "boolean",
        default: false,
        section: "Lightclaw",
      }),
    );

    const resolveBaseUrl = (): string => settings.get<string>(BASE_URL_SETTING, DEFAULT_BASE_URL) || DEFAULT_BASE_URL;

    const resolveApiKey = (): string => settings.get<string>(API_KEY_SETTING, DEFAULT_API_KEY) || DEFAULT_API_KEY;

    const resolveTimeoutMs = (): number => {
      const raw = settings.get<unknown>(TIMEOUT_MS_SETTING, DEFAULT_TIMEOUT_MS);
      return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
    };

    const resolveVerbose = (): boolean => settings.get<boolean>(VERBOSE_SETTING, false) === true;

    ctx.effect(() =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Lightclaw",
        description:
          "OpenAI-compatible HTTP streaming via a running lightclaw instance. Each turn POSTs to /chat/completions with stream: true and parses SSE delta events. Tool calls are forwarded and streamed back.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "http",
        connectionMode: "stateless",
        sessionStrategy: "per-turn",
        capabilities: {
          streaming: true,
          tools: true,
          images: false,
          reasoning: false,
        },
        models: toModelSpecs(),
        auth: {
          mode: "api-key",
          check: checkCredential,
        },
        adapter: {
          connect: (_ctx: ProviderConnectionContext): ProviderSession => {
            const session = new OpenAiHttpSession(
              "lightclaw",
              {
                baseUrl: resolveBaseUrl,
                apiKey: resolveApiKey,
                timeoutMs: resolveTimeoutMs,
                verbose: resolveVerbose,
              },
              { adapterId: ADAPTER_ID, providerId: PROVIDER_ID },
            );
            // The shared transport declares `tools: ToolSet` where the plugin
            // contract says `unknown` — the deliberate cost of keeping the model
            // SDK out of @codesurf/plugin-api. The value the host passes at
            // runtime IS a ToolSet, so this is a variance cast, not a lie.
            return session as unknown as ProviderSession;
          },
        },
      }),
    );
  },
};

// Export internals for tests.
export { checkCredential, normalizeOpenAiMessages, toModelSpecs };
