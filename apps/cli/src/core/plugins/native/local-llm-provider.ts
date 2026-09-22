// Builtin Local LLM provider.
//
// Streams chat turns to any OpenAI-compatible local server — LM Studio, Ollama,
// or vLLM — via the `/chat/completions` endpoint with server-sent streaming
// (`stream: true`). All three speak the same OpenAI wire format, so a single
// adapter with a configurable base URL covers them; a `preset` setting picks
// the well-known localhost URL, with a Custom escape hatch.
//
// Like `lightclaw-provider.ts`, delegates streaming to the shared
// `OpenAiHttpSession` (`./openai-http-session.ts`): each `sendTurn` POSTs one
// streaming request and pipes the SSE response through the shared
// `consumeOpenAiSseStream`, which decodes content, `reasoning_content`, and
// tool-call deltas into `ProviderStreamEvent`s. Host tools are forwarded
// (local models that support tool-calling can use them); models that don't
// simply never emit tool-call deltas.
//
// Models are discovered dynamically from `GET /v1/models` (`listModels`) with an
// empty fallback when the server is offline.
//
// Settings:
//   - `local-llm.http.preset`    — LM Studio | Ollama | vLLM | Custom
//   - `local-llm.http.baseUrl`   — OpenAI-compatible base URL (used when preset = Custom)
//   - `local-llm.http.apiKey`    — optional bearer token (blank for no-auth servers)
//   - `local-llm.http.timeoutMs` — request timeout in milliseconds
//   - `local-llm.http.verbose`   — surface SSE parse errors for debugging

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
import { OpenAiHttpSession } from "../builtin/openai-http-session";

const EXTENSION_ID = "builtin.provider-local-llm";
const PROVIDER_ID = "local-llm";
const ADAPTER_ID = "local-llm.http";

const PRESET_SETTING = `${ADAPTER_ID}.preset`;
const BASE_URL_SETTING = `${ADAPTER_ID}.baseUrl`;
const API_KEY_SETTING = `${ADAPTER_ID}.apiKey`;
const TIMEOUT_MS_SETTING = `${ADAPTER_ID}.timeoutMs`;
const VERBOSE_SETTING = `${ADAPTER_ID}.verbose`;

// ── Presets ──────────────────────────────────────────────────────────────────

const PRESET_LM_STUDIO = "LM Studio";
const PRESET_OLLAMA = "Ollama";
const PRESET_VLLM = "vLLM";
const PRESET_CUSTOM = "Custom";

const DEFAULT_PRESET = PRESET_LM_STUDIO;
const DEFAULT_TIMEOUT_MS = 120_000;
const DISCOVERY_TIMEOUT_MS = 2_000;

/** Well-known localhost base URL for each preset. Custom → "" (use the baseUrl
 *  setting). */
export function presetBaseUrl(preset: string): string {
  switch (preset) {
    case PRESET_OLLAMA:
      return "http://localhost:11434/v1";
    case PRESET_VLLM:
      return "http://localhost:8000/v1";
    case PRESET_CUSTOM:
      return "";
    default:
      return "http://localhost:1234/v1"; // LM Studio
  }
}

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Effective base URL: the preset's URL, or the custom base URL when preset is
 *  Custom. Trailing slashes are stripped so `${baseUrl}/chat/completions`
 *  composes cleanly. Returns "" when nothing is configured (→ auth fails). */
export function resolveBaseUrlFrom(preset: string, customBaseUrl: string): string {
  const raw = preset === PRESET_CUSTOM ? customBaseUrl : presetBaseUrl(preset);
  return stripTrailingSlash(raw ?? "");
}

// ── Model discovery ──────────────────────────────────────────────────────────

function modelIdOf(item: unknown): string {
  if (typeof item === "string") return item;
  const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
  if (typeof row?.id === "string") return row.id;
  if (typeof row?.name === "string") return row.name;
  return "";
}

/** Parse an OpenAI-compatible `/v1/models` payload into RegisteredModels.
 *  Tolerates `{ data: [...] }`, `{ models: [...] }`, and a bare array, with
 *  either object (`{ id }` / `{ name }`) or plain-string entries. */
export function parseLocalModels(payload: unknown): ModelSpec[] {
  const asRecord =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord.data)
      ? asRecord.data
      : Array.isArray(asRecord.models)
        ? asRecord.models
        : [];

  const out: ModelSpec[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const id = modelIdOf(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      providerId: PROVIDER_ID,
      adapterId: ADAPTER_ID,
      label: id,
      description: "Local model served via an OpenAI-compatible endpoint.",
      // reasoning is left false: the catalog can't tell which local models
      // reason. Live reasoning still renders — the SSE consumer surfaces
      // `reasoning_content` regardless of this flag; it only gates the picker's
      // reasoning-effort control.
      capabilities: { tools: true, reasoning: false, images: false },
    });
  }
  return out;
}

async function discoverModels(baseUrl: string, apiKey: string): Promise<ModelSpec[]> {
  if (!baseUrl) return [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: abort.signal,
    });
    if (!response.ok) return [];
    return parseLocalModels(await response.json());
  } catch {
    // Server offline / unreachable — fall back to no models (the user can start
    // the server and re-scan).
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── Auth check ───────────────────────────────────────────────────────────────

function checkCredential(ctx: ProviderConnectionContext): CredentialStatus {
  const preset = ctx.settings.get<string>(PRESET_SETTING, DEFAULT_PRESET) ?? DEFAULT_PRESET;
  const customBaseUrl = ctx.settings.get<string>(BASE_URL_SETTING, "") ?? "";
  const baseUrl = resolveBaseUrlFrom(preset, customBaseUrl);

  if (!baseUrl) {
    return {
      ok: false,
      reason:
        "Local LLM base URL is not set. Pick a preset, or choose Custom and set local-llm.http.baseUrl in /plugins.",
    };
  }
  return { ok: true };
}

// ── Extension module ─────────────────────────────────────────────────────────

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Local LLM (LM Studio / Ollama / vLLM)",
  version: "1.0.0",
  description:
    "OpenAI-compatible local LLM provider. Streams turns to any /v1/chat/completions endpoint (LM Studio, Ollama, vLLM), discovers models from /v1/models, and forwards host tools.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: false,
  enabledByDefault: false,
  capabilities: ["provider-adapters", "models", "settings"],
};

export const localLlmProviderPlugin: CodesurfPlugin = {
  name: "codesurf-local-llm-provider",
  manifest,
  inject: ["contributions", "settings"],
  apply(ctx: PluginContext) {
    const settings = ctx.settings;

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: PRESET_SETTING,
        title: "Server preset",
        description: "Which local server to target. Sets the base URL automatically. Choose Custom to enter your own.",
        type: "select",
        default: DEFAULT_PRESET,
        section: "Local LLM",
        options: [
          { value: PRESET_LM_STUDIO, label: "LM Studio (localhost:1234)" },
          { value: PRESET_OLLAMA, label: "Ollama (localhost:11434)" },
          { value: PRESET_VLLM, label: "vLLM (localhost:8000)" },
          { value: PRESET_CUSTOM, label: "Custom (use base URL below)" },
        ],
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BASE_URL_SETTING,
        title: "Custom base URL",
        description: "OpenAI-compatible base URL, used when Preset = Custom (e.g. http://localhost:1234/v1).",
        type: "string",
        default: "",
        section: "Local LLM",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: API_KEY_SETTING,
        title: "API key",
        description:
          "Optional bearer token. Leave blank for unauthenticated local servers (LM Studio, Ollama); set it for a secured vLLM.",
        type: "secret",
        default: "",
        section: "Local LLM",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: TIMEOUT_MS_SETTING,
        title: "Request timeout (ms)",
        description: "HTTP request timeout for /chat/completions. Increase for slow local hardware.",
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        section: "Local LLM",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: VERBOSE_SETTING,
        title: "Verbose streaming",
        description: "Surface parse errors for individual SSE chunks as error events (for debugging).",
        type: "boolean",
        default: false,
        section: "Local LLM",
      }),
    );

    const resolvePreset = (): string => settings.get<string>(PRESET_SETTING, DEFAULT_PRESET) ?? DEFAULT_PRESET;
    const resolveCustomBaseUrl = (): string => settings.get<string>(BASE_URL_SETTING, "") ?? "";
    const resolveBaseUrl = (): string => resolveBaseUrlFrom(resolvePreset(), resolveCustomBaseUrl());
    const resolveApiKey = (): string => settings.get<string>(API_KEY_SETTING, "") ?? "";
    const resolveTimeoutMs = (): number => {
      const raw = settings.get<unknown>(TIMEOUT_MS_SETTING, DEFAULT_TIMEOUT_MS);
      return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
    };
    const resolveVerbose = (): boolean => settings.get<boolean>(VERBOSE_SETTING, false) === true;

    ctx.effect(() =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Local LLM",
        description:
          "OpenAI-compatible HTTP streaming for local models (LM Studio, Ollama, vLLM). Each turn POSTs to /chat/completions with stream: true and forwards host tool schemas; models are discovered from /v1/models.",
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
        models: [],
        listModels: async () => discoverModels(resolveBaseUrl(), resolveApiKey()),
        auth: {
          mode: "none",
          check: checkCredential,
        },
        adapter: {
          connect: (_ctx: ProviderConnectionContext): ProviderSession => {
            const session = new OpenAiHttpSession(
              "local-llm",
              {
                baseUrl: resolveBaseUrl,
                apiKey: resolveApiKey,
                timeoutMs: resolveTimeoutMs,
                verbose: resolveVerbose,
              },
              { adapterId: ADAPTER_ID, providerId: PROVIDER_ID },
            );
            // Variance cast: the shared transport declares `tools: ToolSet`
            // where the plugin contract says `unknown`, the deliberate cost of
            // keeping the model SDK out of @codesurf/plugin-api. The value the
            // host passes at runtime IS a ToolSet.
            return session as unknown as ProviderSession;
          },
        },
      }),
    );
  },
};

// Export internals for tests.
export { checkCredential, discoverModels };
