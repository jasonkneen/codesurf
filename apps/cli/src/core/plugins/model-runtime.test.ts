import type { PluginContext } from "@codesurf/plugin-api";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { loadBuiltinPlugins } from "./builtin";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  disablePlugin,
  disposeAllProviderSessions,
  disposeProviderSession,
  enablePlugin,
  resolveModelRuntimeViaKernel,
  setCwdProvider,
} from "./index";
import { createNativePluginModule } from "./native/host";

let tempDir: string;
let originalConfigDir: string | undefined;
let originalAnthropicKey: string | undefined;
let originalCodeSurfKey: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-runtime-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  originalCodeSurfKey = process.env.CODESURF_API_KEY;
  process.env.CODESURF_CONFIG_DIR = tempDir;
  process.env.CODESURF_API_KEY = "test-key";
});

afterAll(async () => {
  await disposeAllProviderSessions();
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  if (originalCodeSurfKey === undefined) delete process.env.CODESURF_API_KEY;
  else process.env.CODESURF_API_KEY = originalCodeSurfKey;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(async () => {
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  const credsFile = path.join(tempDir, "credentials.json");
  if (fs.existsSync(credsFile)) fs.unlinkSync(credsFile);
  delete process.env.ANTHROPIC_API_KEY;
  await disposeAllProviderSessions();
  __resetPluginsForTests();
});

afterEach(async () => {
  await disposeAllProviderSessions();
  __resetPluginsForTests();
});

describe("resolveModelRuntimeViaKernel", () => {
  // A provider that spawns a CLI must run it in the agent's workspace, which
  // drifts from process.cwd() once the shell changes directory. The connect
  // context has to carry the workspace for that to be readable.
  it("hands connect() the host workspace", async () => {
    const workspaceDir = path.join(tempDir, "drifted-workspace");
    setCwdProvider(() => workspaceDir);
    let seenCwd: string | undefined;
    await bootstrapPlugins([
      createNativePluginModule({
        name: "extension",
        inject: ["contributions"],
        manifest: {
          id: "test.runtime-workspace",
          name: "Runtime workspace",
          version: "1.0.0",
          capabilities: ["provider-adapters", "models"],
        },
        apply(ctx: PluginContext) {
          ctx.contributions.registerModelProvider({
            id: "workspace.adapter",
            label: "Workspace adapter",
            providerId: "workspace",
            shape: "provider-family",
            transport: "custom",
            connectionMode: "stateless",
            capabilities: { streaming: true },
            auth: { mode: "none", check: () => ({ ok: true }) },
            adapter: {
              connect: async (connectCtx) => {
                seenCwd = connectCtx.workspace?.cwd();
                return {
                  adapterId: "workspace.adapter",
                  providerId: "workspace",
                  mode: "stateless",
                  getModel: () => null as never,
                };
              },
            },
            model: { id: "workspace-model", providerId: "workspace", label: "Workspace model" },
          });
        },
      }),
    ]);

    await resolveModelRuntimeViaKernel("workspace-model", "workspace-conversation");
    expect(seenCwd).toBe(workspaceDir);
  });

  it("routes xAI models through the existing xAI client (preserves batch/responses paths)", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    // grok-code-fast-1 is a retired alias of the grok-4.3 flagship (see
    // MODELS in src/grok/models.ts); the kernel canonicalizes it.
    const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-a");
    expect(runtime.modelId).toBe("grok-4.6");
    // xAI runtime populates modelInfo from the static MODELS list; non-xAI
    // providers leave it undefined.
    expect(runtime.modelInfo).toBeDefined();
    expect(runtime.modelInfo?.id).toBe("grok-4.6");
  });

  it("resolves xAI aliases through the kernel", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const runtime = await resolveModelRuntimeViaKernel("grok-4-1-fast", "session-b");
    expect(runtime.modelId).toBe("grok-4.6");
  });

  it("routes unknown model ids to the xAI fallback (legacy behavior)", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const runtime = await resolveModelRuntimeViaKernel("some-unknown-model", "session-c");
    expect(runtime.modelId).toBe("some-unknown-model");
  });

  it("xAI session getModel dispatches chat vs responses based on responsesOnly metadata", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-chat");
    expect(runtime.session?.getModel).toBeDefined();
    // Calling session.getModel on a non-responsesOnly model should return a chat model.
    const chatModel = runtime.session?.getModel?.("grok-code-fast-1");
    expect(chatModel).toBeDefined();
    // grok-4.20-multi-agent-0309 is responsesOnly: true. getModel on it should
    // return a structurally distinct object (the responses endpoint, not the
    // callable chat provider).
    const responsesModel = runtime.session?.getModel?.("grok-4.20-multi-agent-0309");
    expect(responsesModel).toBeDefined();
    // The chat model is a plain function call result (provider(id)); the
    // responses model is provider.responses(id). They should not be equal.
    expect(responsesModel).not.toBe(chatModel);
  });

  it("xAI session getResponsesModel returns the responses endpoint regardless of metadata", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-resp");
    expect(runtime.session?.getResponsesModel).toBeDefined();
    const responses = runtime.session?.getResponsesModel?.("grok-code-fast-1");
    expect(responses).toBeDefined();
  });

  it("xAI session getResponsesModel and getModel return distinct objects for chat models (vision routing contract)", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-vision-contract");
    expect(runtime.session?.getModel).toBeDefined();
    expect(runtime.session?.getResponsesModel).toBeDefined();
    const chat = runtime.session?.getModel?.("grok-code-fast-1");
    const responses = runtime.session?.getResponsesModel?.("grok-code-fast-1");
    expect(chat).toBeDefined();
    expect(responses).toBeDefined();
    // For a non-responsesOnly model, getModel returns the chat endpoint and
    // getResponsesModel returns the responses endpoint. They MUST be distinct
    // objects — vision sub-agent relies on this divergence.
    expect(responses).not.toBe(chat);
  });

  it("non-xAI sessions do not expose getResponsesModel (vision routing throw precondition)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");
    const runtime = await resolveModelRuntimeViaKernel("claude-sonnet-4-6", "session-non-xai-vision");
    expect(runtime.modelId).toBe("claude-sonnet-4-6");
    // Anthropic API-key adapter only implements getModel; getResponsesModel
    // is xAI-only. The Agent's vision sub-agent path checks this exact
    // condition and throws — see runTaskRequest in agent.ts.
    expect(runtime.session?.getResponsesModel).toBeUndefined();
  });

  it("xAI session getRawProvider returns the underlying XaiProvider", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-raw");
    const raw = runtime.session?.getRawProvider?.();
    expect(raw).toBeDefined();
    // XaiProvider exposes .responses(modelId), .image(modelId), .video(modelId),
    // and is itself callable for chat models. Asserting one of those is enough
    // to confirm it's structurally an XaiProvider rather than e.g. a session
    // closure.
    const xaiLike = raw as { responses: (id: string) => unknown };
    expect(typeof xaiLike.responses).toBe("function");
  });

  it("resolves claude models to the Claude Agent SDK adapter without requiring an API key", async () => {
    // claude-* models are owned by the agent-sdk provider, which defers auth
    // to the Claude CLI (subscription login) — no ANTHROPIC_API_KEY needed at
    // resolve time. The API-key-based builtin.provider-anthropic only applies
    // when explicitly selected as the adapter.
    await bootstrapPlugins(await loadBuiltinPlugins());
    const runtime = await resolveModelRuntimeViaKernel("claude-sonnet-4-6", "session-d");
    expect(runtime.modelId).toBe("claude-sonnet-4-6");
    expect(runtime.adapterId).toBe("anthropic.agent-sdk");
    expect(runtime.session).toBeDefined();
  });

  it("returns a valid LanguageModel for Anthropic models when the key is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");
    const runtime = await resolveModelRuntimeViaKernel("claude-sonnet-4-6", "session-e");
    expect(runtime.modelId).toBe("claude-sonnet-4-6");
    // Non-xAI providers produce no modelInfo / providerOptions — the Agent
    // loop's xAI-specific code paths must skip when those are undefined.
    expect(runtime.modelInfo).toBeUndefined();
    expect(runtime.providerOptions).toBeUndefined();
    expect(runtime.model).toBeDefined();
  });

  it("prefers the Agent SDK (persistent) adapter over the API-key adapter when both pass the credential check", async () => {
    // Regression: previously, setting ANTHROPIC_API_KEY silently took
    // routing away from the enabled Agent SDK extension because the loop
    // picked the first `ok` adapter in registration order (API-key first).
    // A bad key then surfaced as "invalid key" — the Agent SDK path was
    // never tried even though the user had explicitly opted in to it.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");
    await enablePlugin("builtin.provider-claude-agent");
    const runtime = await resolveModelRuntimeViaKernel("claude-sonnet-4-6", "session-both");
    expect(runtime.adapterId).toBe("anthropic.agent-sdk");
    // Persistent-mode sessions expose sendTurn instead of getModel.
    expect(runtime.session?.sendTurn).toBeDefined();
  });

  it("honors an explicitly selected API-key adapter even when a persistent adapter is also available", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");
    await enablePlugin("builtin.provider-claude-agent");

    const runtime = await resolveModelRuntimeViaKernel("claude-haiku-4-5", "session-explicit-api-key", {
      adapterId: "anthropic.api-key",
    });

    expect(runtime.adapterId).toBe("anthropic.api-key");
    expect(runtime.session?.getModel).toBeDefined();
    expect(runtime.session?.sendTurn).toBeUndefined();
  });

  it("reuses the cached provider session across turns within the same conversation", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");

    const first = await resolveModelRuntimeViaKernel("claude-sonnet-4-6", "session-shared");
    const second = await resolveModelRuntimeViaKernel("claude-haiku-4-5", "session-shared");
    expect(first.modelId).toBe("claude-sonnet-4-6");
    expect(second.modelId).toBe("claude-haiku-4-5");
  });

  it("does not cache a connection that finishes after its provider was disabled", async () => {
    let releaseFirstConnect!: () => void;
    const firstConnectGate = new Promise<void>((resolve) => {
      releaseFirstConnect = resolve;
    });
    let signalFirstConnect!: () => void;
    const firstConnectStarted = new Promise<void>((resolve) => {
      signalFirstConnect = resolve;
    });
    const staleDisconnect = vi.fn();
    let connectCount = 0;

    const extension = createNativePluginModule({
      name: "extension",
      inject: ["contributions"],
      manifest: {
        id: "test.runtime-generation",
        name: "Runtime generation",
        version: "1.0.0",
        capabilities: ["provider-adapters", "models"],
      },
      apply(ctx: PluginContext) {
        ctx.contributions.registerModelProvider({
          id: "generation.adapter",
          label: "Generation adapter",
          providerId: "generation",
          shape: "provider-family",
          transport: "custom",
          connectionMode: "stateless",
          capabilities: { streaming: true },
          auth: { mode: "none", check: () => ({ ok: true }) },
          adapter: {
            connect: async () => {
              connectCount += 1;
              if (connectCount === 1) {
                signalFirstConnect();
                await firstConnectGate;
                return {
                  adapterId: "generation.adapter",
                  providerId: "generation",
                  mode: "stateless",
                  getModel: () => null as never,
                  disconnect: staleDisconnect,
                };
              }
              return {
                adapterId: "generation.adapter",
                providerId: "generation",
                mode: "stateless",
                getModel: () => null as never,
              };
            },
          },
          model: { id: "generation-model", providerId: "generation", label: "Generation model" },
        });
      },
    });

    await bootstrapPlugins([extension]);
    const staleResolution = resolveModelRuntimeViaKernel("generation-model", "generation-conversation");
    await firstConnectStarted;

    await disablePlugin("test.runtime-generation");
    await enablePlugin("test.runtime-generation");
    releaseFirstConnect();

    await expect(staleResolution).rejects.toThrow(/disabled or reconfigured while connecting/);
    expect(staleDisconnect).toHaveBeenCalledTimes(1);

    await resolveModelRuntimeViaKernel("generation-model", "generation-conversation");
    expect(connectCount).toBe(2);
  });
});

/**
 * A provider whose `connect()` is gated by the test. Every connect call is
 * recorded with its resolve/reject handles so the test controls exactly when
 * (and whether) each in-flight connection settles.
 */
function createGatedProviderExtension() {
  const connects: Array<{
    resolve: (session: GatedSession) => void;
    reject: (error: Error) => void;
  }> = [];
  const extension = createNativePluginModule({
    name: "extension",
    inject: ["contributions"],
    manifest: {
      id: "test.runtime-gated",
      name: "Gated runtime",
      version: "1.0.0",
      capabilities: ["provider-adapters", "models"],
    },
    apply(ctx: PluginContext) {
      ctx.contributions.registerModelProvider({
        id: "gated.adapter",
        label: "Gated adapter",
        providerId: "gated",
        shape: "provider-family",
        transport: "custom",
        connectionMode: "stateless",
        capabilities: { streaming: true },
        auth: { mode: "none", check: () => ({ ok: true }) },
        adapter: {
          connect: () =>
            new Promise<GatedSession>((resolve, reject) => {
              connects.push({ resolve, reject });
            }),
        },
        model: { id: "gated-model", providerId: "gated", label: "Gated model" },
      });
    },
  });
  return { extension, connects };
}

interface GatedSession {
  adapterId: string;
  providerId: string;
  mode: "stateless";
  getModel: () => never;
  disconnect: Mock<() => void | Promise<void>>;
}

function makeGatedSession(
  disconnect: Mock<() => void | Promise<void>> = vi.fn<() => void | Promise<void>>(),
): GatedSession {
  return {
    adapterId: "gated.adapter",
    providerId: "gated",
    mode: "stateless",
    getModel: () => null as never,
    disconnect,
  };
}

describe("provider session connect/dispose ownership", () => {
  it("shares one in-flight connection between concurrent lookups for the same conversation", async () => {
    const { extension, connects } = createGatedProviderExtension();
    await bootstrapPlugins([extension]);

    const first = resolveModelRuntimeViaKernel("gated-model", "shared-conversation");
    const second = resolveModelRuntimeViaKernel("gated-model", "shared-conversation");
    await vi.waitFor(() => expect(connects.length).toBe(1));

    const session = makeGatedSession();
    connects[0]!.resolve(session);
    const [a, b] = await Promise.all([first, second]);

    expect(connects.length).toBe(1);
    expect(a.session).toBe(session);
    expect(b.session).toBe(session);
    expect(session.disconnect).not.toHaveBeenCalled();
  });

  it("does not cache or reuse a connection that finishes after its conversation was disposed", async () => {
    const { extension, connects } = createGatedProviderExtension();
    await bootstrapPlugins([extension]);

    const stale = resolveModelRuntimeViaKernel("gated-model", "switched-conversation");
    await vi.waitFor(() => expect(connects.length).toBe(1));

    await disposeProviderSession("switched-conversation");

    const lateSession = makeGatedSession();
    connects[0]!.resolve(lateSession);
    await expect(stale).rejects.toThrow(/disposed while "gated.adapter" was connecting/);
    // The late result must be torn down, never parked in the cache.
    expect(lateSession.disconnect).toHaveBeenCalledTimes(1);

    // A fresh lookup after the dispose starts a brand-new connection instead of
    // joining (or reusing) the invalidated one.
    const fresh = resolveModelRuntimeViaKernel("gated-model", "switched-conversation");
    await vi.waitFor(() => expect(connects.length).toBe(2));
    const freshSession = makeGatedSession();
    connects[1]!.resolve(freshSession);
    expect((await fresh).session).toBe(freshSession);
  });

  it("lets a lookup retry after a failed connect instead of joining the rejected attempt", async () => {
    const { extension, connects } = createGatedProviderExtension();
    await bootstrapPlugins([extension]);

    const failing = resolveModelRuntimeViaKernel("gated-model", "retry-conversation");
    await vi.waitFor(() => expect(connects.length).toBe(1));
    connects[0]!.reject(new Error("boom"));
    await expect(failing).rejects.toThrow("boom");

    const retry = resolveModelRuntimeViaKernel("gated-model", "retry-conversation");
    await vi.waitFor(() => expect(connects.length).toBe(2));
    const session = makeGatedSession();
    connects[1]!.resolve(session);
    expect((await retry).session).toBe(session);
  });

  it("removes a session from the cache before awaiting its disconnect", async () => {
    const { extension, connects } = createGatedProviderExtension();
    await bootstrapPlugins([extension]);

    let releaseDisconnect!: () => void;
    const disconnect = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          releaseDisconnect = resolve;
        }),
    );
    const initial = resolveModelRuntimeViaKernel("gated-model", "reconnect-conversation");
    await vi.waitFor(() => expect(connects.length).toBe(1));
    connects[0]!.resolve(makeGatedSession(disconnect));
    await initial;

    // Disposal is in progress (disconnect pending). A lookup arriving now must
    // not observe the disconnecting session; it must start a new connection.
    const disposing = disposeProviderSession("reconnect-conversation");
    expect(disconnect).toHaveBeenCalledTimes(1);
    const reconnect = resolveModelRuntimeViaKernel("gated-model", "reconnect-conversation");
    await vi.waitFor(() => expect(connects.length).toBe(2));

    releaseDisconnect();
    await disposing;
    const replacement = makeGatedSession();
    connects[1]!.resolve(replacement);
    expect((await reconnect).session).toBe(replacement);
  });
});
