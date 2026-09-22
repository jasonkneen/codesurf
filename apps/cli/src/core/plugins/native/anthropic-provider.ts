// Native Cordis plugin: Anthropic Claude via a standard API key.
//
// Converted from the V1 entry unchanged in behaviour: the same adapter and
// model ids, the same lazily-imported SDK, and the same session shape (a
// `getModel` session, so the host drives the turn). OAuth and Agent-SDK modes
// are separate adapters and are not touched here.

import type {
  CodesurfPlugin,
  CredentialStatus,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
} from "@codesurf/plugin-api";
import { resolveApiKey } from "../../persistence/credentials";
import { ANTHROPIC_MODEL_PRICING, ANTHROPIC_MODELS } from "../builtin/anthropic-models-catalog";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";

const EXTENSION_ID = "builtin.provider-anthropic";
const PROVIDER_ID = "anthropic";
const ADAPTER_ID = "anthropic.api-key";
const ENV_VAR = "ANTHROPIC_API_KEY";

// API-key adapter's per-model label/description overlay. Keyed by canonical
// model id from ANTHROPIC_MODELS. New Claude releases land in
// `./anthropic-models-catalog.ts` first, then get a row here for prose.
const LABELS: Record<string, { label: string; description: string }> = {
  "claude-fable-5": { label: "Claude Fable 5", description: "Most capable model. 1M context." },
  "claude-opus-5": { label: "Claude Opus 5", description: "Flagship reasoning model. 1M context." },
  "claude-opus-4-8": { label: "Claude Opus 4.8", description: "Opus 4.8. 1M context." },
  "claude-opus-4-7": { label: "Claude Opus 4.7", description: "Opus 4.7. 1M context." },
  "claude-opus-4-6": { label: "Claude Opus 4.6", description: "Opus 4.6. 1M context." },
  "claude-sonnet-5": { label: "Claude Sonnet 5", description: "Latest balanced flagship. 1M context." },
  "claude-sonnet-4-6": { label: "Claude Sonnet 4.6", description: "Balanced flagship. 1M context." },
  "claude-haiku-4-5": { label: "Claude Haiku 4.5", description: "Fast, budget-friendly. 200K context." },
};

function toModelSpecs(): ModelSpec[] {
  return ANTHROPIC_MODELS.map((model) => {
    const labels = LABELS[model.id] ?? { label: model.id, description: "" };
    const pricing = ANTHROPIC_MODEL_PRICING[model.id];
    return {
      id: model.id,
      providerId: PROVIDER_ID,
      adapterId: ADAPTER_ID,
      label: labels.label,
      description: labels.description,
      contextWindow: model.contextWindow,
      inputPrice: pricing?.inputPrice,
      outputPrice: pricing?.outputPrice,
      aliases: model.aliases.length > 0 ? [...model.aliases] : undefined,
      capabilities: {
        tools: true,
        reasoning: model.reasoning,
        images: model.images,
      },
    };
  });
}

function checkCredential(): CredentialStatus {
  const key = resolveApiKey(ADAPTER_ID, ENV_VAR);
  if (!key) {
    return {
      ok: false,
      reason: `Missing Anthropic API key. Set ${ENV_VAR} or paste one via /models.`,
      needsUserAction: "paste-api-key",
    };
  }
  return { ok: true };
}

let createAnthropicPromise: Promise<typeof import("@ai-sdk/anthropic")> | null = null;
function loadAnthropicSdk() {
  createAnthropicPromise ??= import("@ai-sdk/anthropic");
  return createAnthropicPromise;
}

async function createSession(ctx: ProviderConnectionContext): Promise<ProviderSession> {
  const apiKey = resolveApiKey(ADAPTER_ID, ENV_VAR);
  if (!apiKey) {
    throw new Error(`Anthropic API key not configured. Set ${ENV_VAR} or paste one via /models.`);
  }

  // Construct once per session; the SDK client is stateless and cheap.
  const { createAnthropic } = await loadAnthropicSdk();
  const anthropic = createAnthropic({ apiKey });

  return {
    adapterId: ctx.adapterId,
    providerId: ctx.providerId,
    mode: "stateless",
    strategy: "per-turn",
    getModel: (modelId) => anthropic(modelId),
  };
}

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Anthropic (API key)",
  version: "1.0.0",
  description: "Anthropic Claude via standard API key. Claude-opus / claude-sonnet / claude-haiku.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: false,
  enabledByDefault: true,
  capabilities: ["provider-adapters", "models"],
};

export const anthropicProviderPlugin: CodesurfPlugin = {
  name: "codesurf-anthropic-provider",
  manifest,
  inject: ["contributions"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Anthropic (API key)",
        description:
          "Standard Anthropic API key auth via @ai-sdk/anthropic. Requires ANTHROPIC_API_KEY or a pasted key.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "sdk",
        connectionMode: "stateless",
        sessionStrategy: "per-turn",
        capabilities: { streaming: true, tools: true, images: true, reasoning: true },
        models: toModelSpecs(),
        auth: { mode: "api-key", check: checkCredential },
        adapter: { connect: createSession },
      }),
    );
  },
};
