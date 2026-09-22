// Parity for the first converted provider.
//
// A provider's identity is compatibility surface twice over: the extension id
// keys persisted enable/disable state, and the adapter and model ids key the
// user's saved model selection. A conversion that changes either silently
// switches which model someone's next turn runs on.

import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { describe, expect, it, vi } from "vitest";
import { MODELS } from "../../../grok/models";
import { xaiProviderPlugin } from "./xai-provider";

const ADAPTER_ID = "xai.default";

function bootRoot() {
  const providers: Array<{ id: string; providerId: string }> = [];
  const released: string[] = [];
  const root = createCodesurfRoot({
    registerModelProvider: (spec) => {
      providers.push(spec);
      return () => released.push(spec.id);
    },
  });
  return { root, providers, released };
}

describe("native xAI provider", () => {
  it("keeps the manifest identity that persisted state is keyed by", () => {
    expect(xaiProviderPlugin.manifest.id).toBe("builtin.provider-xai");
    expect(xaiProviderPlugin.manifest.name).toBe("xAI Provider");
    expect(xaiProviderPlugin.manifest.version).toBe("1.1.0");
    // Protected and default-on: this is the provider the CLI falls back to.
    expect(xaiProviderPlugin.manifest.protected).toBe(true);
    expect(xaiProviderPlugin.manifest.enabledByDefault).toBe(true);
    expect(xaiProviderPlugin.manifest.capabilities).toEqual(["provider-adapters", "models"]);
    expect(xaiProviderPlugin.manifest.group?.id).toBeDefined();
  });

  it("registers the adapter with its transport and capability declaration", async () => {
    const { root, providers } = bootRoot();
    const fiber = mountPlugin(root, xaiProviderPlugin);
    await fiber;

    expect(providers).toHaveLength(1);
    const spec = providers[0] as unknown as Record<string, unknown>;
    expect(spec.id).toBe(ADAPTER_ID);
    expect(spec.providerId).toBe("xai");
    expect(spec.label).toBe("xAI (Grok)");
    expect(spec.shape).toBe("provider-family");
    expect(spec.transport).toBe("sdk");
    expect(spec.connectionMode).toBe("stateless");
    expect(spec.sessionStrategy).toBe("per-turn");
    expect(spec.capabilities).toEqual({ streaming: true, tools: true, images: true, reasoning: true });
    await fiber.dispose();
  });

  it("contributes every model in the lineup, with ids and aliases intact", async () => {
    const { root, providers } = bootRoot();
    const fiber = mountPlugin(root, xaiProviderPlugin);
    await fiber;

    const models = (providers[0] as unknown as { models: Array<{ id: string; aliases?: string[] }> }).models;
    // Model ids are what a saved model selection stores, so the set must match
    // the catalogue exactly — not merely have the same length.
    expect(models.map((m) => m.id).sort()).toEqual(MODELS.map((m) => m.id).sort());
    for (const model of models) {
      const source = MODELS.find((m) => m.id === model.id);
      expect(model.aliases).toEqual(source?.aliases);
    }
    await fiber.dispose();
  });

  it("reports a missing API key as an actionable credential failure", async () => {
    const { root, providers } = bootRoot();
    const fiber = mountPlugin(root, xaiProviderPlugin);
    await fiber;

    const auth = (providers[0] as unknown as { auth: { mode: string; check: () => { ok: boolean } } }).auth;
    expect(auth.mode).toBe("api-key");

    const settings = await import("../../../utils/settings");
    const spy = vi.spyOn(settings, "getApiKey").mockReturnValue("");
    try {
      const status = auth.check() as { ok: boolean; reason?: string; needsUserAction?: string };
      expect(status.ok).toBe(false);
      expect(status.reason).toBe("Missing Grok API key (CODESURF_API_KEY).");
      // The UI routes on this to open the key prompt rather than a dead end.
      expect(status.needsUserAction).toBe("paste-api-key");
    } finally {
      spy.mockRestore();
    }
    await fiber.dispose();
  });

  it("releases the adapter when the fiber is disposed", async () => {
    const { root, providers, released } = bootRoot();
    const fiber = mountPlugin(root, xaiProviderPlugin);
    await fiber;
    expect(providers).toHaveLength(1);
    expect(released).toEqual([]);

    await fiber.dispose();
    // Disposal is what removes the contribution — the loader no longer sweeps it.
    expect(released).toEqual([ADAPTER_ID]);
  });
});
