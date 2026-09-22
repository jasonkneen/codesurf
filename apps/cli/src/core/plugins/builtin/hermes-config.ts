// Hermes Gateway — configuration discovery + parsing layer.
//
// Extracted from hermes-gateway-provider.ts (2026-06-22 review, §1.4). This
// module is the pure config surface: reading Hermes' Python (config.yaml),
// Rust (config.toml), models.json, and auth.json files and turning them into
// typed `HermesDiscoveredConfig` / `HermesModelSpec` / `HermesProviderSpec`
// objects, plus the model-id resolution helpers and gateway URL builders.
//
// It depends only on `node:fs` / `node:path` and its own types — no provider
// runtime, no registry, no settings service. The provider extension imports
// from here and layers the HTTP session / credential / registry concerns on
// top.
//
// Add a new Hermes config source or model family here. The provider's session
// class and extension module stay thin.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Identifiers shared with the provider ────────────────────────────────────

/** Prefix used to namespace discovered Hermes models in the model registry. */
export const HERMES_PROVIDER_MODEL_PREFIX = "hermes-provider:";

/** Synthesized model id used when no real upstream model is known. */
export const FALLBACK_MODEL_ID = "hermes-gateway";

/** Default gateway base URL. Used when no override is configured. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8642/v1";

// ── Catalog data (verified against Hermes CLI) ──────────────────────────────

const ROUTE_PROVIDER_IDS = new Set(["openrouter", "nous", "ai-gateway", "custom"]);

const HERMES_PROVIDER_CATALOG_MODELS: Record<string, string[]> = {
  // Verified against the local Hermes CLI catalog in hermes_cli/models.py.
  openai: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5-mini",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-4.1",
    "gpt-4o",
    "gpt-4o-mini",
  ],
  // Verified against the local Hermes CLI Codex catalog in hermes_cli/codex_models.py.
  "openai-codex": [
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
  ],
};

const HERMES_PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface HermesModelSpec {
  id: string;
  label: string;
  description: string;
  contextWindow?: number;
  capabilities?: { tools?: boolean; reasoning?: boolean; images?: boolean };
  provider?: string;
  baseUrl?: string;
  source?: string;
}

export interface HermesProviderSpec {
  id: string;
  label: string;
  baseUrl?: string;
  source: string;
  auth?: string;
}

export interface HermesDiscoveredConfig {
  models: HermesModelSpec[];
  providers: HermesProviderSpec[];
  sources: string[];
  gatewayBaseUrl?: string;
  defaultModel?: string;
  defaultProvider?: string;
}

export const FALLBACK_MODELS: HermesModelSpec[] = [
  {
    id: FALLBACK_MODEL_ID,
    label: "Hermes Gateway",
    description:
      "Route turns through the configured Hermes OpenAI-compatible gateway. The upstream model is read from the Hermes Gateway default model setting.",
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, images: false },
  },
];

// ── Model-id resolution helpers ─────────────────────────────────────────────

export function inferProviderFromModelId(modelId: string): string {
  const lower = modelId.trim().toLowerCase();
  if (!lower) return "";
  if (lower.startsWith("anthropic/") || lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("openai/") || lower.startsWith("gpt-") || /^o[134](?:-|$)/.test(lower)) return "openai";
  if (lower.startsWith("xai/") || lower.startsWith("grok-")) return "xai";
  if (lower.startsWith("google/") || lower.startsWith("gemini-")) return "google";
  if (lower.startsWith("deepseek/") || lower.startsWith("deepseek-")) return "deepseek";
  if (lower.startsWith("mistral/") || lower.startsWith("mistral-")) return "mistral";
  if (lower.startsWith("qwen/") || lower.startsWith("qwen") || lower.startsWith("alibaba/")) return "alibaba";
  return "";
}

export function normalizeHermesModelProvider(modelId: string, configuredProvider: string): string {
  const configured = configuredProvider.trim().toLowerCase();
  const inferred = inferProviderFromModelId(modelId);
  if (!configured) return inferred;
  if (ROUTE_PROVIDER_IDS.has(configured)) return configured;
  return configured;
}

export function modelLabel(name: string, provider: string): string {
  return `${name}${provider ? ` (via ${provider})` : ""}`;
}

export function catalogModelsForProvider(provider: string, source: string): HermesModelSpec[] {
  const normalized = provider.trim().toLowerCase();
  const modelIds = HERMES_PROVIDER_CATALOG_MODELS[normalized] ?? [];
  const label = HERMES_PROVIDER_LABELS[normalized] ?? normalized;
  return modelIds.map((id) => ({
    id: `${HERMES_PROVIDER_MODEL_PREFIX}${normalized}:${id}`,
    label: modelLabel(id, label),
    description: `Hermes ${label} catalog model.`,
    provider: normalized,
    source,
    capabilities: { tools: true, reasoning: true, images: false },
  }));
}

export function registeredHermesModelId(model: HermesModelSpec): string {
  if (model.id === FALLBACK_MODEL_ID || model.id.startsWith(HERMES_PROVIDER_MODEL_PREFIX)) return model.id;
  return `${HERMES_PROVIDER_MODEL_PREFIX}${model.provider || "auto"}:${model.id}`;
}

export function decodeHermesModelSelection(modelId: string): { model: string; provider?: string } {
  if (!modelId.startsWith(HERMES_PROVIDER_MODEL_PREFIX)) return { model: modelId };
  const rest = modelId.slice(HERMES_PROVIDER_MODEL_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return { model: modelId };
  const provider = rest.slice(0, sep).trim();
  const model = rest.slice(sep + 1).trim();
  const routeProvider = provider && provider !== "auto" ? provider : undefined;
  return model ? { model, provider: routeProvider } : { model: modelId };
}

// ── Gateway URL builders ────────────────────────────────────────────────────

export function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeBaseUrl(value: string): string {
  return trimTrailingSlash(value || DEFAULT_BASE_URL);
}

export function gatewayRootUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return base.replace(/\/v1$/i, "");
}

export function endpointUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

export function healthUrl(baseUrl: string): string {
  return `${gatewayRootUrl(baseUrl)}/health`;
}

export function docsUrl(baseUrl: string): string {
  return `${gatewayRootUrl(baseUrl)}/docs`;
}

// ── Text / config parsing ───────────────────────────────────────────────────

export function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "null") return "";
  return trimmed;
}

export function readTextIfExists(path: string): string | null {
  try {
    if (!path || !existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function parseYamlSection(raw: string, sectionName: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  const out: Record<string, string> = {};
  let inSection = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inSection = line.trim() === `${sectionName}:`;
      continue;
    }
    if (!inSection) continue;
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = unquote(match[2] ?? "");
  }
  return out;
}

export function parsePythonGatewayBaseUrl(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  let inPlatforms = false;
  let inApiServer = false;
  let inExtra = false;
  let host = "";
  let port = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\S/.test(line)) {
      inPlatforms = trimmed === "platforms:";
      inApiServer = false;
      inExtra = false;
      continue;
    }
    if (!inPlatforms) continue;
    if (/^ {2}\S/.test(line)) {
      inApiServer = trimmed === "api_server:";
      inExtra = false;
      continue;
    }
    if (!inApiServer) continue;
    if (/^ {4}\S/.test(line)) {
      inExtra = trimmed === "extra:";
      const enabled = trimmed.match(/^enabled:\s*(.*)$/);
      if (enabled && unquote(enabled[1]).toLowerCase() === "false") return undefined;
      continue;
    }
    if (!inExtra) continue;
    const match = line.match(/^ {6}(host|port):\s*(.*)$/);
    if (!match) continue;
    if (match[1] === "host") host = unquote(match[2] ?? "");
    if (match[1] === "port") port = unquote(match[2] ?? "");
  }

  if (!host && !port) return undefined;
  return `http://${host || "127.0.0.1"}:${port || "8642"}/v1`;
}

export function parsePythonCustomProviders(raw: string): {
  models: HermesModelSpec[];
  providers: HermesProviderSpec[];
} {
  const lines = raw.split(/\r?\n/);
  const models: HermesModelSpec[] = [];
  const providers: HermesProviderSpec[] = [];
  let inCustom = false;
  let current: Record<string, string> | null = null;

  const flush = () => {
    if (!current) return;
    const name = current.name || current.provider || current.id || "";
    const provider = current.provider || name || "custom";
    const baseUrl = current.base_url || current.baseUrl || current.api || current.url || "";
    if (name || baseUrl) {
      providers.push({
        id: name || provider,
        label: name || provider,
        baseUrl,
        source: "Hermes custom_providers",
      });
    }
    if (current.model) {
      const modelProvider = normalizeHermesModelProvider(current.model, provider);
      models.push({
        id: current.model,
        label: modelLabel(current.model, modelProvider || name),
        description: `Model from Hermes custom provider${name ? ` ${name}` : ""}.`,
        provider: modelProvider || provider,
        baseUrl,
        source: "Hermes custom_providers",
        capabilities: { tools: true, reasoning: true, images: false },
      });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\S/.test(line)) {
      if (inCustom) flush();
      inCustom = trimmed === "custom_providers:";
      continue;
    }
    if (!inCustom) continue;
    const item = line.match(/^ {2}-\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (item) {
      flush();
      current = { [item[1]]: unquote(item[2] ?? "") };
      continue;
    }
    const field = line.match(/^ {4}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field && current) {
      current[field[1]] = unquote(field[2] ?? "");
    }
  }
  if (inCustom) flush();

  return { models, providers };
}

export function parseHermesModelsJson(raw: string): HermesModelSpec[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [];
    return rows
      .map((row): HermesModelSpec | null => {
        if (!row || typeof row !== "object") return null;
        const record = row as Record<string, unknown>;
        const model = typeof record.model === "string" ? record.model : "";
        if (!model) return null;
        const provider = typeof record.provider === "string" ? record.provider : "";
        const modelProvider = normalizeHermesModelProvider(model, provider);
        const name = typeof record.name === "string" ? record.name : model;
        const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";
        return {
          id: model,
          label: modelLabel(name, modelProvider),
          description: `Saved Hermes model${modelProvider ? ` for provider ${modelProvider}` : ""}.`,
          provider: modelProvider,
          baseUrl,
          source: "Hermes models.json",
          capabilities: { tools: true, reasoning: true, images: false },
        };
      })
      .filter((model): model is HermesModelSpec => model !== null);
  } catch {
    return [];
  }
}

export function parseHermesAuthJson(raw: string): HermesProviderSpec[] {
  try {
    const parsed = JSON.parse(raw) as { credential_pool?: Record<string, Array<Record<string, unknown>>> };
    const pool = parsed.credential_pool ?? {};
    const providers: HermesProviderSpec[] = [];
    for (const [provider, entries] of Object.entries(pool)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const label = typeof entry.label === "string" ? entry.label : provider;
        const baseUrl = typeof entry.base_url === "string" ? entry.base_url : "";
        const auth = typeof entry.auth_type === "string" ? entry.auth_type : undefined;
        providers.push({
          id: `${provider}:${label}`,
          label: `${provider} (${label})`,
          baseUrl,
          auth,
          source: "Hermes auth.json credential_pool",
        });
      }
    }
    return providers;
  } catch {
    return [];
  }
}

export function parseHermesAuthProviderIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as {
      active_provider?: unknown;
      credential_pool?: Record<string, unknown>;
    };
    const ids = new Set<string>();
    if (typeof parsed.active_provider === "string" && parsed.active_provider.trim()) {
      ids.add(parsed.active_provider.trim().toLowerCase());
    }
    for (const provider of Object.keys(parsed.credential_pool ?? {})) {
      if (provider.trim()) ids.add(provider.trim().toLowerCase());
    }
    return Array.from(ids);
  } catch {
    return [];
  }
}

export function parseTomlSection(raw: string, sectionName: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  const out: Record<string, string> = {};
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inSection = section[1] === sectionName;
      continue;
    }
    if (!inSection) continue;
    const pair = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (pair) out[pair[1]] = unquote((pair[2] ?? "").replace(/\s+#.*$/, ""));
  }
  return out;
}

export function parseHermesPythonSettings(raw: string, source = "Hermes config.yaml"): HermesDiscoveredConfig {
  const modelSection = parseYamlSection(raw, "model");
  const currentModel = modelSection.default || modelSection.model || "";
  const currentProvider = modelSection.provider || "";
  const modelProvider = normalizeHermesModelProvider(currentModel, currentProvider);
  const baseUrl = modelSection.base_url || modelSection.baseUrl || "";
  const custom = parsePythonCustomProviders(raw);
  const models: HermesModelSpec[] = [...custom.models];
  if (currentModel) {
    models.unshift({
      id: currentModel,
      label: modelLabel(currentModel, modelProvider),
      description: "Current default model from Hermes config.yaml.",
      provider: modelProvider,
      baseUrl,
      source,
      capabilities: { tools: true, reasoning: true, images: false },
    });
  }
  models.push(...catalogModelsForProvider(currentProvider, `${source} model.provider`));

  return {
    models,
    providers: custom.providers,
    sources: [source],
    gatewayBaseUrl: parsePythonGatewayBaseUrl(raw),
    defaultModel: currentModel,
    defaultProvider: modelProvider,
  };
}

export function parseHermesRustSettings(raw: string, source = "Hermes Rust config.toml"): HermesDiscoveredConfig {
  const client = parseTomlSection(raw, "client");
  const agent = parseTomlSection(raw, "agent");
  const model = agent.model || "";
  const baseUrl = client.base_url || "";
  const models: HermesModelSpec[] = model
    ? [
        {
          id: model,
          label: `${model} (hermes-rs)`,
          description: "Agent model from hermes-rs TOML config.",
          provider: "hermes-rs",
          baseUrl,
          source,
          capabilities: { tools: true, reasoning: true, images: false },
        },
      ]
    : [];
  const providers: HermesProviderSpec[] = baseUrl
    ? [{ id: "hermes-rs-client", label: "hermes-rs client", baseUrl, source }]
    : [];

  return {
    models,
    providers,
    sources: [source],
    defaultModel: model,
    defaultProvider: "hermes-rs",
  };
}

export function dedupeModels(models: HermesModelSpec[]): HermesModelSpec[] {
  const seen = new Set<string>();
  const out: HermesModelSpec[] = [];
  for (const model of models) {
    const key = model.id.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

export function dedupeProviders(providers: HermesProviderSpec[]): HermesProviderSpec[] {
  const seen = new Set<string>();
  const out: HermesProviderSpec[] = [];
  for (const provider of providers) {
    const key = `${provider.id}:${provider.baseUrl ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(provider);
  }
  return out;
}

export function discoverHermesConfig(opts: {
  hermesHome: string;
  pythonConfigPath: string;
  rustConfigPath: string;
  readConfig: boolean;
}): HermesDiscoveredConfig {
  if (!opts.readConfig) return { models: [], providers: [], sources: [] };

  const models: HermesModelSpec[] = [];
  const providers: HermesProviderSpec[] = [];
  const sources: string[] = [];
  let gatewayBaseUrl: string | undefined;
  let defaultModel: string | undefined;
  let defaultProvider: string | undefined;

  const pythonConfigPath = opts.pythonConfigPath || join(opts.hermesHome, "config.yaml");
  const pythonConfig = readTextIfExists(pythonConfigPath);
  if (pythonConfig) {
    const parsed = parseHermesPythonSettings(pythonConfig, pythonConfigPath);
    models.push(...parsed.models);
    providers.push(...parsed.providers);
    sources.push(...parsed.sources);
    gatewayBaseUrl = parsed.gatewayBaseUrl ?? gatewayBaseUrl;
    defaultModel = parsed.defaultModel ?? defaultModel;
    defaultProvider = parsed.defaultProvider ?? defaultProvider;
  }

  const modelsJson = readTextIfExists(join(opts.hermesHome, "models.json"));
  if (modelsJson) {
    models.push(...parseHermesModelsJson(modelsJson));
    sources.push(join(opts.hermesHome, "models.json"));
  }

  const authJson = readTextIfExists(join(opts.hermesHome, "auth.json"));
  if (authJson) {
    providers.push(...parseHermesAuthJson(authJson));
    for (const provider of parseHermesAuthProviderIds(authJson)) {
      models.push(...catalogModelsForProvider(provider, `${join(opts.hermesHome, "auth.json")} credential_pool`));
    }
    sources.push(join(opts.hermesHome, "auth.json"));
  }

  const rustConfig = readTextIfExists(opts.rustConfigPath);
  if (rustConfig) {
    const parsed = parseHermesRustSettings(rustConfig, opts.rustConfigPath);
    models.push(...parsed.models);
    providers.push(...parsed.providers);
    sources.push(...parsed.sources);
    defaultModel = defaultModel ?? parsed.defaultModel;
    defaultProvider = defaultProvider ?? parsed.defaultProvider;
  }

  return {
    models: dedupeModels(models),
    providers: dedupeProviders(providers),
    sources: Array.from(new Set(sources)),
    gatewayBaseUrl,
    defaultModel,
    defaultProvider,
  };
}

export function formatDiscoveredConfig(config: HermesDiscoveredConfig, baseUrl: string): string {
  const lines = [
    "Hermes configuration",
    `Gateway base URL: ${baseUrl}`,
    `Default model: ${config.defaultModel || "unknown"}`,
    `Default provider: ${config.defaultProvider || "unknown"}`,
    `Sources: ${config.sources.length ? config.sources.join(", ") : "none"}`,
    "",
    "Models:",
  ];
  if (config.models.length === 0) lines.push("- none discovered");
  for (const model of config.models.slice(0, 30)) {
    lines.push(
      `- ${model.id}${model.provider ? ` (${model.provider})` : ""}${model.source ? ` from ${model.source}` : ""}`,
    );
  }
  if (config.models.length > 30) lines.push(`- ... ${config.models.length - 30} more`);

  lines.push("", "Providers:");
  if (config.providers.length === 0) lines.push("- none discovered");
  for (const provider of config.providers.slice(0, 30)) {
    const base = provider.baseUrl ? ` -> ${provider.baseUrl}` : "";
    const auth = provider.auth ? ` [${provider.auth}]` : "";
    lines.push(`- ${provider.label}${auth}${base} from ${provider.source}`);
  }
  if (config.providers.length > 30) lines.push(`- ... ${config.providers.length - 30} more`);

  return lines.join("\n");
}
