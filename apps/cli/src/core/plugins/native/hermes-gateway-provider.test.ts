import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent, ProviderTurnInput, RegisteredModelProvider, RegisteredSetting } from "../api";
import {
  decodeHermesModelSelection,
  docsUrl,
  endpointUrl,
  gatewayRootUrl,
  HermesGatewaySession,
  healthUrl,
  hermesGatewayProviderPlugin,
  inferProviderFromModelId,
  normalizeBaseUrl,
  normalizeHermesModelProvider,
  parseHermesAuthJson,
  parseHermesAuthProviderIds,
  parseHermesModelsJson,
  parseHermesPythonSettings,
  parseHermesRustSettings,
  parseModels,
} from "./hermes-gateway-provider";

interface RegisteredCommand {
  name: string;
  aliases?: string[];
  handler: (ctx: { args: string; services: StubServices }) => void | Promise<void>;
}

interface StubServices {
  chat: {
    appendAssistant: ReturnType<typeof vi.fn>;
  };
  settings: {
    get: <T>(key: string, fallback?: T) => T | undefined;
    set: (key: string, value: unknown) => void;
    list: () => RegisteredSetting[];
    subscribe: (key: string, listener: (value: unknown, previous: unknown) => void) => () => void;
  };
}

interface StubApi {
  mount: () => Promise<void>;
  commands: RegisteredCommand[];
  providers: RegisteredModelProvider[];
  settings: RegisteredSetting[];
  services: StubServices;
  store: Map<string, unknown>;
}

function makeStubApi(): StubApi {
  const commands: RegisteredCommand[] = [];
  const providers: RegisteredModelProvider[] = [];
  const settings: RegisteredSetting[] = [];
  const store = new Map<string, unknown>();

  const services: StubServices = {
    chat: { appendAssistant: vi.fn() },
    settings: {
      get: <T>(key: string, fallback?: T): T | undefined => {
        if (store.has(key)) return store.get(key) as T;
        const settingDefault = settings.find((setting) => setting.key === key)?.default;
        if (settingDefault !== undefined) return settingDefault as T;
        return fallback;
      },
      set: (key, value) => {
        const previous = store.get(key);
        store.set(key, value);
        void previous;
      },
      list: () => settings,
      subscribe: () => () => {},
    },
  };

  const api = {
    services,
    onDispose: vi.fn(),
    registerCommand: (command: unknown) => {
      commands.push(command as RegisteredCommand);
      return () => {};
    },
    registerModelProvider: (provider: unknown) => {
      providers.push(provider as RegisteredModelProvider);
      return () => {};
    },
    registerSetting: (setting: unknown) => {
      settings.push(setting as RegisteredSetting);
      return () => {};
    },
    registerTool: vi.fn(),
    registerCommandResolver: vi.fn(),
    registerMentionsService: vi.fn(),
    registerModel: vi.fn(),
    registerScreen: vi.fn(),
    registerStatusIndicator: vi.fn(),
  } as Record<string, unknown>;

  // A native plugin has no `activate`: mount it on a real root whose bindings
  // forward into the same recorders the stub api used.
  const mount = async () => {
    const root = createCodesurfRoot({
      registerCommand: (spec) => {
        commands.push(spec as never);
        return () => {};
      },
      registerModelProvider: (spec) => {
        providers.push(spec as never);
        return () => {};
      },
      registerSetting: (spec) => {
        settings.push(spec as never);
        return () => {};
      },
      getSetting: <T>(key: string, fallback?: T): T | undefined => services.settings.get(key, fallback),
      setSetting: (key: string, value: unknown) => services.settings.set(key, value),
      listSettings: () => settings as never,
      appendAssistant: (text: string) => {
        (services.chat.appendAssistant as (t: string) => void)(text);
      },
      subscribeSetting: () => () => {},
    });
    await mountPlugin(root, hermesGatewayProviderPlugin);
  };
  void api;

  return { mount, commands, providers, settings, services, store };
}

function makeTurn(modelId = "hermes-gateway"): ProviderTurnInput {
  return {
    conversationId: "conv-1",
    providerId: "hermes",
    adapterId: "hermes.gateway",
    modelId,
    prompt: "Hello Hermes",
    messages: [{ role: "user", content: "Hello Hermes" }],
    metadata: {},
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("builtin.provider-hermes-gateway", () => {
  it("declares the expected extension manifest", () => {
    expect(hermesGatewayProviderPlugin.manifest).toMatchObject({
      id: "builtin.provider-hermes-gateway",
      enabledByDefault: false,
      capabilities: ["provider-adapters", "models", "settings", "commands"],
    });
  });

  it("normalizes gateway URLs without guessing direct-vs-gateway routing", () => {
    expect(normalizeBaseUrl(" http://127.0.0.1:8642/v1/ ")).toBe("http://127.0.0.1:8642/v1");
    expect(gatewayRootUrl("http://127.0.0.1:8642/v1")).toBe("http://127.0.0.1:8642");
    expect(endpointUrl("http://127.0.0.1:8642/v1/", "/chat/completions")).toBe(
      "http://127.0.0.1:8642/v1/chat/completions",
    );
    expect(healthUrl("http://127.0.0.1:8642/v1")).toBe("http://127.0.0.1:8642/health");
    expect(docsUrl("http://127.0.0.1:8642/v1")).toBe("http://127.0.0.1:8642/docs");
  });

  it("parses standard /v1/models payloads from the Hermes gateway", () => {
    expect(parseModels({ data: [{ id: "hermes-agent", context_window: 128000 }, { name: "local/dev" }] })).toEqual([
      expect.objectContaining({ id: "hermes-agent", label: "hermes-agent", contextWindow: 128000 }),
      expect.objectContaining({ id: "local/dev", label: "local/dev" }),
    ]);
    expect(parseModels(["one", "two"]).map((model) => model.id)).toEqual(["one", "two"]);
  });

  it("registers settings, model provider, and slash command on activation", async () => {
    const stub = makeStubApi();
    await stub.mount();

    expect(stub.settings.map((setting) => setting.key)).toEqual(
      expect.arrayContaining([
        "hermes.gateway.baseUrl",
        "hermes.gateway.apiKey",
        "hermes.gateway.defaultModel",
        "hermes.gateway.hermesHome",
        "hermes.gateway.configPath",
        "hermes.gateway.rustConfigPath",
        "hermes.gateway.readHermesConfig",
        "hermes.gateway.timeoutMs",
        "hermes.gateway.verbose",
      ]),
    );

    const provider = stub.providers.find((item) => item.id === "hermes.gateway");
    expect(provider).toBeDefined();
    expect(provider?.providerId).toBe("hermes");
    expect(provider?.transport).toBe("http");
    expect(provider?.connectionMode).toBe("stateless");
    expect(provider?.capabilities).toMatchObject({ streaming: true, tools: true, reasoning: true });
    expect(provider?.models?.[0]?.id).toBe("hermes-gateway");

    const command = stub.commands.find((item) => item.name === "/hermes-gateway");
    expect(command).toBeDefined();
    expect(command?.aliases).toContain("/hermes");
  });

  it("treats blank base URL settings as valid because Hermes config/default discovery fills them", async () => {
    const stub = makeStubApi();
    stub.store.set("hermes.gateway.readHermesConfig", false);
    await stub.mount();
    const provider = stub.providers.find((item) => item.id === "hermes.gateway");
    if (!provider?.auth?.check) throw new Error("provider auth check not registered");

    expect(
      provider.auth.check({
        conversationId: "conv-1",
        adapterId: "hermes.gateway",
        providerId: "hermes",
        settings: stub.services.settings,
      }),
    ).toEqual({ ok: true });
  });

  it("lists live gateway models when /v1/models is available", async () => {
    const stub = makeStubApi();
    stub.store.set("hermes.gateway.readHermesConfig", false);
    await stub.mount();
    const provider = stub.providers.find((item) => item.id === "hermes.gateway");
    if (!provider?.listModels) throw new Error("provider listModels not registered");

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8642/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "hermes-agent" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const models = await provider.listModels({
      conversationId: "conv-1",
      adapterId: "hermes.gateway",
      providerId: "hermes",
      settings: stub.services.settings,
    });

    expect(models.map((model) => model.id)).toEqual(["hermes-provider:auto:hermes-agent"]);
  });

  it("/hermes-gateway docs writes the configured docs URL", async () => {
    const stub = makeStubApi();
    stub.store.set("hermes.gateway.baseUrl", "http://localhost:8642/v1");
    await stub.mount();
    const command = stub.commands.find((item) => item.name === "/hermes-gateway");
    if (!command) throw new Error("command not registered");

    await command.handler({ args: "docs", services: stub.services });

    expect(stub.services.chat.appendAssistant).toHaveBeenCalledWith("Hermes Gateway docs: http://localhost:8642/docs");
  });

  it("/hermes-gateway status reads root /health and reports ok", async () => {
    const stub = makeStubApi();
    stub.store.set("hermes.gateway.readHermesConfig", false);
    await stub.mount();
    const command = stub.commands.find((item) => item.name === "/hermes-gateway");
    if (!command) throw new Error("command not registered");

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8642/health");
      return new Response(JSON.stringify({ status: "ok", platform: "hermes-agent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await command.handler({ args: "status", services: stub.services });

    const output = String(stub.services.chat.appendAssistant.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("Base URL: http://127.0.0.1:8642/v1");
    expect(output).toContain("Health: ok");
    expect(output).toContain('platform: "hermes-agent"');
  });

  it("sendTurn posts OpenAI chat-completions payloads to the configured Hermes gateway", async () => {
    const events: ProviderStreamEvent[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8642/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "hermes-agent",
        stream: true,
        messages: [{ role: "user", content: "Hello Hermes" }],
      });
      expect(body).not.toHaveProperty("tools");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Gateway response" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = new HermesGatewaySession({
      baseUrl: () => "http://127.0.0.1:8642/v1",
      apiKey: () => "test-key",
      defaultModel: () => "hermes-agent",
      timeoutMs: () => 5000,
      verbose: () => false,
    });

    const result = await session.sendTurn(makeTurn(), { emit: (event) => events.push(event) });

    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "status", status: "connecting" }),
        expect.objectContaining({ type: "status", status: "streaming" }),
        expect.objectContaining({ type: "text-delta", delta: "Gateway response" }),
        expect.objectContaining({ type: "done", stopReason: "stop" }),
      ]),
    );
  });

  it("does not forward CodeSurf host tools to the Hermes gateway", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty("tools");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = new HermesGatewaySession({
      baseUrl: () => "http://127.0.0.1:8642/v1",
      apiKey: () => "",
      defaultModel: () => "hermes-agent",
      timeoutMs: () => 5000,
      verbose: () => false,
    });

    await session.sendTurn(
      {
        ...makeTurn(),
        tools: {
          invalidForSomeUpstreams: {
            description: "Host tool schema should stay in CodeSurf, not cross the Hermes gateway boundary.",
            parameters: { type: "object", properties: {} },
          },
        },
      } as unknown as ProviderTurnInput,
      { emit: vi.fn() },
    );
  });

  it("streams Hermes tool-progress SSE events as tool-call and tool-result", async () => {
    const events: ProviderStreamEvent[] = [];
    // Hermes gateway emits a named SSE event for tool lifecycle alongside
    // regular OpenAI chat.completion.chunk data events. The extension must
    // surface both so the UI shows tool activity while the gateway-side
    // agent runs tools, instead of sitting in silence until the final text.
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `event: hermes.tool.progress\ndata: ${JSON.stringify({
        tool: "git_apply",
        emoji: "tool",
        label: "git_apply(path=README.md)",
        toolCallId: "call_abc123",
        status: "running",
      })}\n\n`,
      `event: hermes.tool.progress\ndata: ${JSON.stringify({
        tool: "git_apply",
        toolCallId: "call_abc123",
        status: "completed",
      })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Patched." }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4 } })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    const fetchMock = vi.fn(
      async () => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = new HermesGatewaySession({
      baseUrl: () => "http://127.0.0.1:8642/v1",
      apiKey: () => "",
      defaultModel: () => "hermes-agent",
      timeoutMs: () => 5000,
      verbose: () => false,
    });

    await session.sendTurn(makeTurn(), { emit: (event) => events.push(event) });

    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      id: "call_abc123",
      toolName: "git_apply",
      args: { label: "git_apply(path=README.md)", emoji: "tool" },
    });

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({ type: "tool-result", id: "call_abc123" });

    expect(events.some((e) => e.type === "text-delta" && e.delta === "Patched.")).toBe(true);

    // Tool-call must arrive before the final text so the UI can show it while
    // the agent is still working, not after the whole turn finishes.
    const toolCallIdx = events.findIndex((e) => e.type === "tool-call");
    const textDeltaIdx = events.findIndex((e) => e.type === "text-delta" && e.delta === "Patched.");
    expect(toolCallIdx).toBeGreaterThanOrEqual(0);
    expect(toolCallIdx).toBeLessThan(textDeltaIdx);
  });

  it("accepts snake_case Hermes tool progress payloads defensively", async () => {
    const events: ProviderStreamEvent[] = [];
    const sseBody = [
      `event: hermes.tool.progress\ndata: ${JSON.stringify({
        name: "terminal",
        preview: "ls -la",
        tool_call_id: "call_snake_1",
        status: "started",
      })}\n\n`,
      `event: hermes.tool.progress\ndata: ${JSON.stringify({
        name: "terminal",
        tool_call_id: "call_snake_1",
        status: "finished",
      })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    globalThis.fetch = vi.fn(
      async () => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const session = new HermesGatewaySession({
      baseUrl: () => "http://127.0.0.1:8642/v1",
      apiKey: () => "",
      defaultModel: () => "hermes-agent",
      timeoutMs: () => 5000,
      verbose: () => false,
    });

    await session.sendTurn(makeTurn(), { emit: (event) => events.push(event) });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-call", id: "call_snake_1", toolName: "terminal" }),
        expect.objectContaining({ type: "tool-result", id: "call_snake_1" }),
      ]),
    );
  });

  it("times out a stalled Hermes SSE stream after headers arrive", async () => {
    const events: ProviderStreamEvent[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
          ),
        );
      },
    });

    globalThis.fetch = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const session = new HermesGatewaySession({
      baseUrl: () => "http://127.0.0.1:8642/v1",
      apiKey: () => "",
      defaultModel: () => "",
      timeoutMs: () => 10,
      verbose: () => false,
    });

    await expect(
      session.sendTurn(makeTurn("hermes-provider:auto:hermes-agent"), {
        emit: (event) => events.push(event),
      }),
    ).rejects.toThrow("Hermes gateway timed out after 10ms");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "status", status: "streaming" })]));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "error" })]));
  });

  it("keeps a turn that streams for longer than the timeout alive (idle, not wall clock) (M7)", async () => {
    const events: ProviderStreamEvent[] = [];
    const encoder = new TextEncoder();
    const chunk = (text: string) =>
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Six chunks 30ms apart: 180ms total against a 100ms timeout, but
        // never more than 30ms of silence.
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          controller.enqueue(chunk(`c${i}`));
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const session = new HermesGatewaySession({
      baseUrl: () => "http://127.0.0.1:8642/v1",
      apiKey: () => "",
      defaultModel: () => "",
      timeoutMs: () => 100,
      verbose: () => false,
    });

    await session.sendTurn(makeTurn("hermes-provider:auto:hermes-agent"), { emit: (event) => events.push(event) });
    const text = events
      .filter((event): event is Extract<ProviderStreamEvent, { type: "text-delta" }> => event.type === "text-delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("c0c1c2c3c4c5");
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("abortTurn cancels an active Hermes SSE stream", async () => {
    const events: ProviderStreamEvent[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
          ),
        );
      },
    });

    globalThis.fetch = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const session = new HermesGatewaySession({
      baseUrl: () => "http://127.0.0.1:8642/v1",
      apiKey: () => "",
      defaultModel: () => "",
      timeoutMs: () => 5000,
      verbose: () => false,
    });

    const turnPromise = session.sendTurn(makeTurn("hermes-provider:auto:hermes-agent"), {
      emit: (event) => events.push(event),
    });
    await Promise.resolve();
    await Promise.resolve();

    await session.abortTurn();

    await expect(turnPromise).rejects.toThrow("Hermes gateway turn aborted");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "error" })]));
  });

  it("reads Python Hermes config.yaml model, gateway, and custom provider settings", () => {
    const parsed = parseHermesPythonSettings(`
model:
  default: "claude-opus-4-7"
  provider: "openai"
custom_providers:
  - name: local-llm
    base_url: "http://127.0.0.1:1234/v1"
    model: "local-model"
platforms:
  api_server:
    enabled: true
    extra:
      port: 8642
      host: "127.0.0.1"
`);

    expect(parsed.defaultModel).toBe("claude-opus-4-7");
    expect(parsed.defaultProvider).toBe("openai");
    expect(parsed.gatewayBaseUrl).toBe("http://127.0.0.1:8642/v1");
    expect(parsed.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "claude-opus-4-7",
        "local-model",
        "hermes-provider:openai:gpt-5.4",
        "hermes-provider:openai:gpt-4o-mini",
      ]),
    );
    expect(parsed.models[0]).toEqual(expect.objectContaining({ provider: "openai" }));
    expect(parsed.providers[0]).toEqual(
      expect.objectContaining({ id: "local-llm", baseUrl: "http://127.0.0.1:1234/v1" }),
    );
  });

  it("reads hermes-rs TOML client and agent settings", () => {
    const parsed = parseHermesRustSettings(`
[client]
base_url = "http://127.0.0.1:11434/v1"

[agent]
model = "qwen3-coder"
`);

    expect(parsed.defaultModel).toBe("qwen3-coder");
    expect(parsed.models[0]).toEqual(
      expect.objectContaining({ id: "qwen3-coder", provider: "hermes-rs", baseUrl: "http://127.0.0.1:11434/v1" }),
    );
    expect(parsed.providers[0]).toEqual(expect.objectContaining({ baseUrl: "http://127.0.0.1:11434/v1" }));
  });

  it("reads Hermes models.json and auth.json without exposing secret values", () => {
    expect(
      parseHermesModelsJson(
        JSON.stringify([{ name: "Claude Opus", provider: "openai", model: "claude-opus-4-7", baseUrl: "" }]),
      )[0],
    ).toEqual(expect.objectContaining({ id: "claude-opus-4-7", provider: "openai" }));

    const providers = parseHermesAuthJson(
      JSON.stringify({
        credential_pool: {
          openrouter: [
            {
              label: "OPENROUTER_API_KEY",
              auth_type: "api_key",
              value: "secret",
              base_url: "https://openrouter.ai/api/v1",
            },
          ],
        },
      }),
    );

    expect(providers).toEqual([
      expect.objectContaining({
        label: "openrouter (OPENROUTER_API_KEY)",
        auth: "api_key",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ]);
    expect(JSON.stringify(providers)).not.toContain("secret");
    expect(
      parseHermesAuthProviderIds(
        JSON.stringify({ active_provider: "openai-codex", credential_pool: { openrouter: [], anthropic: [] } }),
      ),
    ).toEqual(["openai-codex", "openrouter", "anthropic"]);
  });

  it("normalizes stale provider labels while preserving real route providers", () => {
    expect(inferProviderFromModelId("claude-opus-4-7")).toBe("anthropic");
    expect(normalizeHermesModelProvider("claude-opus-4-7", "openai")).toBe("openai");
    expect(normalizeHermesModelProvider("anthropic/claude-sonnet-4-20250514", "openrouter")).toBe("openrouter");
    expect(normalizeHermesModelProvider("gpt-4.1", "openai")).toBe("openai");
    expect(decodeHermesModelSelection("hermes-provider:auto:claude-opus-4-7")).toEqual({
      model: "claude-opus-4-7",
    });
    expect(decodeHermesModelSelection("hermes-provider:openai:gpt-5.4")).toEqual({
      model: "gpt-5.4",
      provider: "openai",
    });
  });
});
