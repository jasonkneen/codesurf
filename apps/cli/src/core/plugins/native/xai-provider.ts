// Native Cordis plugin: the default Grok / xAI model provider.
//
// The first converted provider, and the shape the other thirteen follow. It
// owns provider construction and contributes the Grok model lineup; the session
// it returns is a `getModel` session, so the host drives the turn with the AI
// SDK model this hands back.
//
// The plugin imports the SDK client directly, as the V1 entry did. That is not
// a boundary violation: a provider's whole job is to speak to a backend. The
// boundary is that `@codesurf/plugin-api` itself stays free of the SDK, which
// is why `ProviderSession.getModel` is typed `unknown` there and the concrete
// model is cast at this call site.

import type {
  CodesurfPlugin,
  CredentialStatus,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
} from "@codesurf/plugin-api";
import { createProvider, type XaiProvider } from "../../../grok/client";
import { getModelInfo, MODELS } from "../../../grok/models";
import { getApiKey } from "../../../utils/settings";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";

const EXTENSION_ID = "builtin.provider-xai";
const PROVIDER_ID = "xai";
const ADAPTER_ID = "xai.default";

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "xAI Provider",
  version: "1.1.0",
  description:
    "Default Grok / xAI model provider. Owns provider construction and contributes the full Grok model lineup.",
  group: CODESURF_PROVIDERS_GROUP,
  protected: true,
  enabledByDefault: true,
  capabilities: ["provider-adapters", "models"],
};

function toModelSpecs(): ModelSpec[] {
  return MODELS.map((model) => ({
    id: model.id,
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: model.name,
    description: model.description,
    contextWindow: model.contextWindow,
    inputPrice: model.inputPrice,
    outputPrice: model.outputPrice,
    capabilities: {
      tools: model.supportsClientTools !== false,
      reasoning: model.reasoning === true,
    },
    aliases: model.aliases,
  }));
}

function checkCredential(): CredentialStatus {
  const key = getApiKey();
  if (!key) {
    return {
      ok: false,
      reason: "Missing Grok API key (CODESURF_API_KEY).",
      needsUserAction: "paste-api-key",
    };
  }
  return { ok: true };
}

function createSession(ctx: ProviderConnectionContext): ProviderSession {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "xAI provider session requested without a configured API key. Set CODESURF_API_KEY or paste one via /models.",
    );
  }
  // baseURL is read by createProvider() from CODESURF_BASE_URL
  // env vars; no per-session override is needed at the kernel boundary today.
  const provider: XaiProvider = createProvider(apiKey);

  return {
    adapterId: ctx.adapterId,
    providerId: ctx.providerId,
    mode: "stateless",
    strategy: "per-turn",
    getModel: (modelId: string) => {
      // Mirror the dispatch in resolveXaiRuntime (grok/client.ts): a
      // responsesOnly model MUST go through the responses endpoint.
      const info = getModelInfo(modelId);
      return info?.responsesOnly ? provider.responses(modelId) : provider(modelId);
    },
    getResponsesModel: (modelId: string) => provider.responses(modelId),
    getRawProvider: () => provider,
  };
}

export const xaiProviderPlugin: CodesurfPlugin = {
  name: "codesurf-xai-provider",
  manifest,
  inject: ["contributions"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "xAI (Grok)",
        description:
          "Official xAI provider via @ai-sdk/xai. Owns provider construction; sessions exposed to the kernel resolver.",
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
