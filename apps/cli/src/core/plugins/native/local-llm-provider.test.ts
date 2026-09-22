import type { ModelProviderSpec, ProviderStreamEvent, SettingSpec } from "@codesurf/plugin-api";
import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
// The turn fixture is fed to the HOST transport, so it carries the host's own
// turn type rather than the structural one the plugin contract exposes.
import type { ProviderTurnInput } from "../api";
import { OpenAiHttpSession } from "../builtin/openai-http-session";
import {
  checkCredential,
  discoverModels,
  localLlmProviderPlugin,
  parseLocalModels,
  presetBaseUrl,
  resolveBaseUrlFrom,
} from "./local-llm-provider";

interface MountedPlugin {
  providers: ModelProviderSpec[];
  settings: SettingSpec[];
  store: Map<string, unknown>;
  dispose: () => Promise<void>;
}

/**
 * Mount the plugin on a real Cordis root and capture what it registers.
 *
 * The V1 suite drove `activate(api)` with a stub; the native plugin has no
 * `activate`, so the equivalent is a root whose HostBindings record the
 * registrations. Settings resolve against a live store so the provider's
 * `resolve*` closures behave as they do in the app.
 */
async function mountLocalLlm(): Promise<MountedPlugin> {
  const providers: ModelProviderSpec[] = [];
  const settings: SettingSpec[] = [];
  const store = new Map<string, unknown>();

  const root = createCodesurfRoot({
    registerModelProvider: (spec) => {
      providers.push(spec);
      return () => {};
    },
    registerSetting: (spec) => {
      settings.push(spec);
      return () => {};
    },
    getSetting: <T>(key: string, fallback?: T): T | undefined => {
      if (store.has(key)) return store.get(key) as T;
      const declared = settings.find((setting) => setting.key === key)?.default;
      if (declared !== undefined) return declared as T;
      return fallback;
    },
    setSetting: (key, value) => {
      store.set(key, value);
    },
    listSettings: () => settings,
    subscribeSetting: () => () => {},
  });

  const fiber = mountPlugin(root, localLlmProviderPlugin);
  await fiber;
  return { providers, settings, store, dispose: async () => void (await fiber.dispose()) };
}

/** The settings view `checkCredential` expects, backed by the mounted store. */
function settingsView(mounted: MountedPlugin) {
  return {
    get: <T>(key: string, fallback?: T): T | undefined => {
      if (mounted.store.has(key)) return mounted.store.get(key) as T;
      const declared = mounted.settings.find((setting) => setting.key === key)?.default;
      if (declared !== undefined) return declared as T;
      return fallback;
    },
    set: (key: string, value: unknown) => mounted.store.set(key, value),
    subscribe: () => () => {},
    list: () => mounted.settings,
  };
}

function makeTurn(modelId = "local-model"): ProviderTurnInput {
  return {
    conversationId: "conv-1",
    providerId: "local-llm",
    adapterId: "local-llm.http",
    modelId,
    prompt: "Hello local",
    messages: [{ role: "user", content: "Hello local" }],
    metadata: {},
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("builtin.provider-local-llm", () => {
  it("declares the expected plugin manifest", () => {
    expect(localLlmProviderPlugin.manifest).toMatchObject({
      id: "builtin.provider-local-llm",
      enabledByDefault: false,
      capabilities: ["provider-adapters", "models", "settings"],
    });
    expect(localLlmProviderPlugin.manifest.group?.id).toBe("codesurf.providers");
  });

  it("maps presets to their localhost base URLs", () => {
    expect(presetBaseUrl("LM Studio")).toBe("http://localhost:1234/v1");
    expect(presetBaseUrl("Ollama")).toBe("http://localhost:11434/v1");
    expect(presetBaseUrl("vLLM")).toBe("http://localhost:8000/v1");
    expect(presetBaseUrl("Custom")).toBe("");
  });

  it("resolves the base URL from preset, with Custom using the override and trailing slashes stripped", () => {
    expect(resolveBaseUrlFrom("Ollama", "")).toBe("http://localhost:11434/v1");
    // Non-Custom presets ignore the custom base URL entirely.
    expect(resolveBaseUrlFrom("LM Studio", "http://example/v1")).toBe("http://localhost:1234/v1");
    // Custom uses the override and strips trailing slashes.
    expect(resolveBaseUrlFrom("Custom", "http://localhost:9999/v1/")).toBe("http://localhost:9999/v1");
    // Custom with no override is unconfigured.
    expect(resolveBaseUrlFrom("Custom", "")).toBe("");
  });

  it("parses OpenAI-compatible /v1/models payloads (object, array, dedupe)", () => {
    const fromData = parseLocalModels({ data: [{ id: "qwen2.5" }, { id: "llama3.1" }, { id: "qwen2.5" }] });
    expect(fromData.map((m) => m.id)).toEqual(["qwen2.5", "llama3.1"]);
    expect(fromData[0]).toMatchObject({
      id: "qwen2.5",
      providerId: "local-llm",
      adapterId: "local-llm.http",
      label: "qwen2.5",
    });

    expect(parseLocalModels(["a", "b"]).map((m) => m.id)).toEqual(["a", "b"]);
    expect(parseLocalModels({ models: [{ name: "fallback-name" }] }).map((m) => m.id)).toEqual(["fallback-name"]);
    expect(parseLocalModels({ nonsense: true })).toEqual([]);
  });

  it("registers settings and the model provider on mount", async () => {
    const mounted = await mountLocalLlm();

    expect(mounted.settings.map((s) => s.key)).toEqual(
      expect.arrayContaining([
        "local-llm.http.preset",
        "local-llm.http.baseUrl",
        "local-llm.http.apiKey",
        "local-llm.http.timeoutMs",
        "local-llm.http.verbose",
      ]),
    );
    // API key must be a secret so it is masked and not given a baked-in default.
    expect(mounted.settings.find((s) => s.key === "local-llm.http.apiKey")?.type).toBe("secret");

    const provider = mounted.providers.find((p) => p.id === "local-llm.http");
    expect(provider).toBeDefined();
    expect(provider?.providerId).toBe("local-llm");
    expect(provider?.transport).toBe("http");
    expect(provider?.connectionMode).toBe("stateless");
    expect(provider?.capabilities).toMatchObject({ streaming: true, tools: true });
    expect(provider?.auth.mode).toBe("none");
    await mounted.dispose();
  });

  it("treats a resolvable preset as valid auth (no key required for local servers)", async () => {
    const mounted = await mountLocalLlm();
    expect(
      checkCredential({
        conversationId: "c",
        adapterId: "local-llm.http",
        providerId: "local-llm",
        settings: settingsView(mounted),
      }),
    ).toEqual({ ok: true });
    await mounted.dispose();
  });

  it("reports unconfigured auth when preset is Custom with no base URL", async () => {
    const mounted = await mountLocalLlm();
    mounted.store.set("local-llm.http.preset", "Custom");
    const status = checkCredential({
      conversationId: "c",
      adapterId: "local-llm.http",
      providerId: "local-llm",
      settings: settingsView(mounted),
    });
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/base URL/i);
  });

  it("discovers models from /v1/models, and returns [] when the server is offline", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://localhost:1234/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "phi-4" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect((await discoverModels("http://localhost:1234/v1", "")).map((m) => m.id)).toEqual(["phi-4"]);

    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await discoverModels("http://localhost:1234/v1", "")).toEqual([]);

    expect(await discoverModels("", "")).toEqual([]);
  });

  it("sendTurn posts an OpenAI streaming chat-completions request and forwards host tools", async () => {
    const events: ProviderStreamEvent[] = [];
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from local" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://localhost:1234/v1/chat/completions");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "local-model", stream: true });
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "echo" } });
      return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = new OpenAiHttpSession(
      "local-llm",
      {
        baseUrl: () => "http://localhost:1234/v1",
        apiKey: () => "",
        timeoutMs: () => 5000,
        verbose: () => false,
      },
      { adapterId: "local-llm.http", providerId: "local-llm" },
    );

    const result = await session.sendTurn(
      {
        ...makeTurn(),
        tools: { echo: { description: "Echo text", parameters: { type: "object", properties: {} } } },
      } as unknown as ProviderTurnInput,
      { emit: (event) => events.push(event) },
    );

    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "status", status: "connecting" }),
        expect.objectContaining({ type: "status", status: "streaming" }),
        expect.objectContaining({ type: "text-delta", delta: "Hello from local" }),
        expect.objectContaining({ type: "done", stopReason: "stop" }),
      ]),
    );
  });

  it("omits the Authorization header when no API key is set", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = new OpenAiHttpSession(
      "local-llm",
      {
        baseUrl: () => "http://localhost:1234/v1",
        apiKey: () => "",
        timeoutMs: () => 5000,
        verbose: () => false,
      },
      { adapterId: "local-llm.http", providerId: "local-llm" },
    );
    await session.sendTurn(makeTurn(), { emit: vi.fn() });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
