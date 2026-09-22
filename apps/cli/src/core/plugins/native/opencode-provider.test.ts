import type { ModelProviderSpec, ProviderSession, ProviderStreamEvent } from "@codesurf/plugin-api";
import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import type { Part, Provider } from "@opencode-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderTurnInput, RegisteredCommand, RegisteredSetting } from "../api";
import {
  decodeModelId,
  emitPart,
  modelsFromProviders,
  normalizeOpenCodeBaseUrl,
  OPENCODE_SDK_BASE_URL_SETTING,
  OPENCODE_SDK_FALLBACK_MODEL_ID,
  opencodeProviderPlugin,
} from "./opencode-provider";

const childProcessMock = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

const sdkMock = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(),
  createOpencodeServer: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMock.execFileSync,
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: sdkMock.createOpencodeClient,
  createOpencodeServer: sdkMock.createOpencodeServer,
}));

interface StubServices {
  chat: {
    appendAssistant: ReturnType<typeof vi.fn>;
  };
  session: {
    id: () => string | null;
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
  providers: ModelProviderSpec[];
  settings: RegisteredSetting[];
  services: StubServices;
  store: Map<string, unknown>;
}

function makeStubApi(): StubApi {
  const commands: RegisteredCommand[] = [];
  const providers: ModelProviderSpec[] = [];
  const settings: RegisteredSetting[] = [];
  const store = new Map<string, unknown>();

  const services: StubServices = {
    chat: { appendAssistant: vi.fn() },
    session: { id: () => "session-1" },
    settings: {
      get: <T>(key: string, fallback?: T): T | undefined => {
        if (store.has(key)) return store.get(key) as T;
        const settingDefault = settings.find((setting) => setting.key === key)?.default;
        if (settingDefault !== undefined) return settingDefault as T;
        return fallback;
      },
      set: (key, value) => {
        store.set(key, value);
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
      providers.push(provider as ModelProviderSpec);
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
        commands.push(spec as unknown as RegisteredCommand);
        return () => {};
      },
      registerModelProvider: (spec) => {
        providers.push(spec as ModelProviderSpec);
        return () => {};
      },
      registerSetting: (spec) => {
        settings.push(spec as unknown as RegisteredSetting);
        return () => {};
      },
      getSetting: <T>(key: string, fallback?: T): T | undefined => services.settings.get(key, fallback),
      setSetting: (key: string, value: unknown) => services.settings.set(key, value),
      listSettings: () => settings as never,
      subscribeSetting: () => () => {},
      cwd: () => process.cwd(),
      // The plugin now writes through ctx.chat and reads ctx.session, so route
      // both at the same recorders the stub api used.
      appendAssistant: (text: string) => {
        (services.chat.appendAssistant as (t: string) => void)(text);
      },
      sessionId: () => services.session.id(),
    });
    await mountPlugin(root, opencodeProviderPlugin);
  };
  void api;

  return { mount, commands, providers, settings, services, store };
}

async function connectSession(stub: StubApi, workspaceCwd?: string): Promise<ProviderSession> {
  await stub.mount();
  const provider = stub.providers.find((item) => item.id === "opencode.sdk");
  if (!provider) throw new Error("OpenCode provider was not registered");
  return await provider.adapter.connect({
    conversationId: "session-1",
    adapterId: "opencode.sdk",
    providerId: "opencode",
    settings: stub.services.settings,
    workspace: workspaceCwd === undefined ? undefined : { cwd: () => workspaceCwd },
  });
}

function turnInput(): ProviderTurnInput {
  return {
    conversationId: "session-1",
    providerId: "opencode",
    adapterId: "opencode.sdk",
    modelId: OPENCODE_SDK_FALLBACK_MODEL_ID,
    prompt: "hello",
    messages: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

describe("builtin.provider-opencode-sdk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childProcessMock.execFileSync.mockReturnValue(Buffer.from("opencode 1.0.0"));
  });

  it("declares the expected extension manifest", () => {
    expect(opencodeProviderPlugin.manifest).toMatchObject({
      id: "builtin.provider-opencode-sdk",
      enabledByDefault: false,
      capabilities: ["provider-adapters", "models", "settings", "commands"],
    });
    // `kind` belongs to the loader-facing manifest the adapter builds; asserting
    // it here would pull the whole loader into a suite that mocks
    // node:child_process. native-boot.test.ts covers the adapter.
  });

  it("normalizes configured base URLs", () => {
    expect(normalizeOpenCodeBaseUrl(" http://127.0.0.1:4096/// ")).toBe("http://127.0.0.1:4096");
    expect(normalizeOpenCodeBaseUrl("")).toBe("");
  });

  it("registers settings, provider, fallback model, and slash command", async () => {
    const stub = makeStubApi();
    await stub.mount();

    expect(stub.settings.map((setting) => setting.key)).toEqual(
      expect.arrayContaining([
        "opencode.sdk.baseUrl",
        "opencode.sdk.autoStart",
        "opencode.sdk.hostname",
        "opencode.sdk.port",
        "opencode.sdk.timeoutMs",
        "opencode.sdk.agent",
      ]),
    );

    const provider = stub.providers.find((item) => item.id === "opencode.sdk");
    expect(provider).toBeDefined();
    expect(provider?.providerId).toBe("opencode");
    expect(provider?.transport).toBe("sdk");
    expect(provider?.connectionMode).toBe("persistent");
    expect(provider?.capabilities).toMatchObject({ tools: true, images: true, reasoning: true });
    expect(provider?.models?.[0]?.id).toBe(OPENCODE_SDK_FALLBACK_MODEL_ID);

    const command = stub.commands.find((item) => item.name === "/opencode-sdk");
    expect(command).toBeDefined();
    expect(command?.aliases).toContain("/opencode");
  });

  it("decodes OpenCode model ids without assuming provider/model names", () => {
    expect(decodeModelId("opencode:anthropic:claude-custom")).toEqual({
      providerID: "anthropic",
      modelID: "claude-custom",
    });
    expect(decodeModelId(OPENCODE_SDK_FALLBACK_MODEL_ID)).toEqual({});
    expect(decodeModelId("grok-4")).toEqual({});
  });

  it("maps OpenCode provider payloads into CodeSurf registered models", () => {
    const provider: Provider = {
      id: "acme",
      name: "Acme",
      source: "config",
      env: [],
      options: {},
      models: {
        "fast-model": {
          id: "upstream-fast",
          name: "Fast Model",
          providerID: "acme",
          api: { id: "acme", url: "https://example.test", npm: "@ai-sdk/openai-compatible" },
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
          },
          limit: { context: 123, output: 45 },
          cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
          status: "active",
          options: {},
          headers: {},
        },
      },
    };

    expect(modelsFromProviders({ providers: [provider], default: { acme: "fast-model" } })).toEqual([
      expect.objectContaining({
        id: "opencode:acme:fast-model",
        label: "Fast Model",
        contextWindow: 123,
        maxOutputTokens: 45,
        inputPrice: 1,
        outputPrice: 2,
        capabilities: { tools: true, images: true, reasoning: true },
        aliases: ["acme/fast-model"],
      }),
    ]);

    expect(modelsFromProviders({ providers: [] })[0]?.id).toBe(OPENCODE_SDK_FALLBACK_MODEL_ID);
  });

  it("listModels auto-starts OpenCode when no base URL is configured", async () => {
    const stub = makeStubApi();
    const close = vi.fn();
    const provider: Provider = {
      id: "anthropic",
      name: "Anthropic",
      source: "config",
      env: [],
      options: {},
      models: {
        "claude-test": {
          id: "claude-test",
          name: "Claude Test",
          providerID: "anthropic",
          api: { id: "anthropic", url: "https://example.test", npm: "@ai-sdk/anthropic" },
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
          },
          limit: { context: 200, output: 20 },
          cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
          status: "active",
          options: {},
          headers: {},
        },
      },
    };

    sdkMock.createOpencodeServer.mockResolvedValueOnce({ url: "http://127.0.0.1:54321", close });
    sdkMock.createOpencodeClient.mockReturnValueOnce({
      config: {
        providers: vi.fn().mockResolvedValueOnce({
          data: { providers: [provider] },
          response: new Response(null, { status: 200 }),
        }),
      },
    });

    await stub.mount();
    const modelProvider = stub.providers.find((item) => item.id === "opencode.sdk");
    if (!modelProvider?.listModels) throw new Error("OpenCode provider listModels was not registered");

    const models = await modelProvider.listModels({
      conversationId: "session-1",
      adapterId: "opencode.sdk",
      providerId: "opencode",
      settings: stub.services.settings,
    });

    // Port 0, not the configured 54321: discovery's throwaway server must not
    // fight the session server (or the user's own `opencode serve`) for the
    // configured listener.
    expect(sdkMock.createOpencodeServer).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 5000,
    });
    expect(sdkMock.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:54321",
      directory: process.cwd(),
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(models).toEqual([expect.objectContaining({ id: "opencode:anthropic:claude-test" })]);
  });

  it("maps OpenCode response parts to provider stream events", () => {
    const events: ProviderStreamEvent[] = [];
    const controller = { emit: (event: ProviderStreamEvent) => events.push(event) };

    emitPart(
      {
        id: "text-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text: "hello",
      },
      controller,
    );
    emitPart(
      {
        id: "reason-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "reasoning",
        text: "thinking",
        time: { start: 1 },
      },
      controller,
    );
    emitPart(
      {
        id: "tool-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "pwd" },
          output: "/tmp",
          title: "pwd",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      } satisfies Part,
      controller,
    );

    expect(events).toEqual([
      { type: "text-delta", delta: "hello" },
      { type: "reasoning-delta", delta: "thinking" },
      { type: "tool-result", id: "call-1", result: "/tmp", isError: false },
    ]);
  });

  it("/opencode-sdk status reports configured mode without starting a server", async () => {
    const stub = makeStubApi();
    stub.store.set(OPENCODE_SDK_BASE_URL_SETTING, "");
    stub.store.set("opencode.sdk.autoStart", false);
    await stub.mount();

    const command = stub.commands.find((item) => item.name === "/opencode-sdk");
    if (!command) throw new Error("OpenCode command not registered");
    await command.handler({ args: "status", services: stub.services as never });

    expect(stub.services.chat.appendAssistant).toHaveBeenCalledWith(
      expect.stringContaining("OpenCode SDK base URL is empty and auto-start is disabled."),
    );
  });

  it("hands the turn's abort signal to the server boot", async () => {
    // Without this the SDK boots un-cancellably: a Stop during a cold start is
    // honoured only once the start timeout expires.
    const stub = makeStubApi();
    const close = vi.fn();
    sdkMock.createOpencodeServer.mockResolvedValueOnce({ url: "http://127.0.0.1:54321", close });

    const session = await connectSession(stub);
    if (!session.sendTurn) throw new Error("OpenCode session exposes no sendTurn");
    await session.sendTurn(turnInput(), { emit: () => {} }).catch(() => {});

    // The signal is the session's own per-turn controller — the one
    // `abortTurn()` fires — so a Stop reaches the SDK's boot wait.
    const options = sdkMock.createOpencodeServer.mock.calls.at(0)?.[0] as { signal?: AbortSignal };
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
  });

  it("a Stop after the server is up never reaches the server's lifetime signal (H1)", async () => {
    // The SDK keeps its signal bound to the server process until it exits, so
    // handing it the turn's signal meant the first Esc after boot killed the
    // server for good.
    const stub = makeStubApi();
    const close = vi.fn();
    sdkMock.createOpencodeServer.mockResolvedValueOnce({ url: "http://127.0.0.1:54321", close });
    const create = vi.fn().mockResolvedValue({ data: { id: "ses-1" }, response: okResponse() });
    const prompt = vi.fn(
      (options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
        }),
    );
    const abort = vi.fn().mockResolvedValue({ data: true, response: okResponse() });
    sdkMock.createOpencodeClient.mockReturnValueOnce({ session: { create, prompt, abort } });

    const session = await connectSession(stub);
    if (!session.sendTurn) throw new Error("OpenCode session exposes no sendTurn");
    const turnAbort = new AbortController();
    const outcome = session.sendTurn({ ...turnInput(), abortSignal: turnAbort.signal }, { emit: () => {} }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    turnAbort.abort();
    expect(await outcome).toBeInstanceOf(Error);

    const options = sdkMock.createOpencodeServer.mock.calls.at(0)?.[0] as { signal?: AbortSignal };
    expect(options?.signal?.aborted).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("a Stop during a cold boot still aborts the server start (H1)", async () => {
    const stub = makeStubApi();
    const startup = deferred<{ url: string; close: () => void }>();
    sdkMock.createOpencodeServer.mockReturnValueOnce(startup.promise);
    const session = await connectSession(stub);
    if (!session.sendTurn) throw new Error("OpenCode session exposes no sendTurn");
    const turnAbort = new AbortController();
    void session.sendTurn({ ...turnInput(), abortSignal: turnAbort.signal }, { emit: () => {} }).catch(() => {});
    turnAbort.abort();
    const options = sdkMock.createOpencodeServer.mock.calls.at(0)?.[0] as { signal?: AbortSignal };
    expect(options?.signal?.aborted).toBe(true);
    startup.resolve({ url: "http://127.0.0.1:54321", close: vi.fn() });
  });

  it("restarts the owned server on the next turn after it dies (H1)", async () => {
    const stub = makeStubApi();
    const firstClose = vi.fn();
    sdkMock.createOpencodeServer
      .mockResolvedValueOnce({ url: "http://127.0.0.1:54321", close: firstClose })
      .mockResolvedValueOnce({ url: "http://127.0.0.1:54322", close: vi.fn() });
    const create = vi.fn().mockResolvedValue({ data: { id: "ses-1" }, response: okResponse() });
    const prompt = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const abort = vi.fn().mockResolvedValue({ data: true, response: okResponse() });
    sdkMock.createOpencodeClient.mockReturnValue({ session: { create, prompt, abort } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    try {
      const session = await connectSession(stub);
      if (!session.sendTurn) throw new Error("OpenCode session exposes no sendTurn");
      await expect(session.sendTurn(turnInput(), { emit: () => {} })).rejects.toThrow("fetch failed");
      expect(firstClose).toHaveBeenCalledTimes(1);

      await session.sendTurn(turnInput(), { emit: () => {} }).catch(() => {});
      expect(sdkMock.createOpencodeServer).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      sdkMock.createOpencodeClient.mockReset();
    }
  });

  it("waits for the owned server to stop answering before disconnect resolves", async () => {
    // The SDK's `close()` only sends a kill; it returns void and never exposes
    // the child. Disposal now polls the server's URL until nothing answers, so
    // a disable/enable cycle cannot race the dying process for its port.
    const stub = makeStubApi();
    let listening = true;
    const close = vi.fn(() => {
      // Real teardown is not instantaneous: keep answering for a beat.
      setTimeout(() => {
        listening = false;
      }, 60);
    });
    sdkMock.createOpencodeServer.mockResolvedValueOnce({ url: "http://127.0.0.1:54321", close });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (listening) return new Response(null, { status: 200 });
      throw new Error("ECONNREFUSED");
    });

    try {
      const session = await connectSession(stub);
      if (!session.sendTurn) throw new Error("OpenCode session exposes no sendTurn");
      await session.sendTurn(turnInput(), { emit: () => {} }).catch(() => {});

      await session.disconnect?.();

      expect(close).toHaveBeenCalledTimes(1);
      // It polled rather than returning the instant close() was called.
      expect(fetchSpy).toHaveBeenCalled();
      expect(listening).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("closes a server that finishes starting after disconnect and never prompts", async () => {
    const stub = makeStubApi();
    const close = vi.fn();
    const startup = deferred<{ url: string; close: () => void }>();
    sdkMock.createOpencodeServer.mockReturnValueOnce(startup.promise);

    const session = await connectSession(stub);
    if (!session.sendTurn) throw new Error("OpenCode session exposes no sendTurn");
    const sendTurn = session.sendTurn.bind(session);
    const events: ProviderStreamEvent[] = [];
    const outcome = sendTurn(turnInput(), { emit: (event) => events.push(event) }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(sdkMock.createOpencodeServer).toHaveBeenCalledTimes(1);

    // Disconnect while the server is still booting, then let startup finish.
    await session.disconnect?.();
    startup.resolve({ url: "http://127.0.0.1:54321", close });

    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/disconnected/);
    expect(close).toHaveBeenCalledTimes(1);
    expect(sdkMock.createOpencodeClient).not.toHaveBeenCalled();
    expect(events[events.length - 1]).toMatchObject({ type: "error" });
    await expect(sendTurn(turnInput(), { emit: () => {} })).rejects.toThrow(/disconnected/);
  });

  it("disconnect aborts an in-flight prompt on an externally configured server, locally and remotely", async () => {
    const stub = makeStubApi();
    stub.store.set(OPENCODE_SDK_BASE_URL_SETTING, "http://127.0.0.1:4096");
    const create = vi.fn().mockResolvedValue({ data: { id: "ses-1" }, response: okResponse() });
    const seen: { signal: AbortSignal | null } = { signal: null };
    const prompt = vi.fn(
      (options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          seen.signal = options.signal;
          options.signal.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
        }),
    );
    const abort = vi.fn().mockResolvedValue({ data: true, response: okResponse() });
    sdkMock.createOpencodeClient.mockReturnValueOnce({ session: { create, prompt, abort } });

    const session = await connectSession(stub);
    if (!session.sendTurn) throw new Error("OpenCode session exposes no sendTurn");
    const outcome = session.sendTurn(turnInput(), { emit: () => {} }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

    await session.disconnect?.();

    expect(seen.signal?.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "ses-1" } }));
    expect(sdkMock.createOpencodeServer).not.toHaveBeenCalled();
    expect(await outcome).toBeInstanceOf(Error);
  });

  it("resolves the OpenCode directory through the host workspace, not process.cwd()", async () => {
    const stub = makeStubApi();
    stub.store.set(OPENCODE_SDK_BASE_URL_SETTING, "http://127.0.0.1:4096");
    const hostCwd = "/host/workspace-elsewhere";
    expect(hostCwd).not.toBe(process.cwd());
    const create = vi.fn().mockResolvedValue({ data: { id: "ses-2" }, response: okResponse() });
    const prompt = vi.fn().mockResolvedValue({
      data: {
        info: { finish: "stop", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ id: "p1", sessionID: "ses-2", messageID: "m1", type: "text", text: "hi" }],
      },
      response: okResponse(),
    });
    const abort = vi.fn().mockResolvedValue({ data: true, response: okResponse() });
    sdkMock.createOpencodeClient.mockReturnValueOnce({ session: { create, prompt, abort } });
    const session = await connectSession(stub, hostCwd);
    if (!session.sendTurn) throw new Error("OpenCode session exposes no sendTurn");
    const events: ProviderStreamEvent[] = [];
    const result = await session.sendTurn(turnInput(), { emit: (event) => events.push(event) });

    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
    expect(events.filter((event) => event.type === "text-delta")).toEqual([{ type: "text-delta", delta: "hi" }]);
    expect(sdkMock.createOpencodeClient).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:4096", directory: hostCwd });
    expect(create).toHaveBeenCalledWith({ query: { directory: hostCwd } });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ query: { directory: hostCwd } }));

    await session.abortTurn?.();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ query: { directory: hostCwd } }));
  });
});
