import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BashSink, HooksSink, HostAction, HostCapability, InputKey, PluginModule } from "./index";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  clearAllSinks,
  disablePlugin,
  dispatchInputInterceptors,
  disposeAllProviderSessions,
  enablePlugin,
  filterToolSetByEnabled,
  getEnabledToolSet,
  getHostServices,
  getRegistrySnapshot,
  isToolEnabled,
  listPlugins,
  resolveModelRuntimeViaKernel,
  setAssistantSink,
  setBashSink,
  setChatSink,
  setCwdProvider,
  setHooksSink,
  setKernelMode,
  setKeyboardHookProvider,
  setUiActionSink,
} from "./index";
import { createNativePluginModule } from "./native/host";

// Redirect persistence to an isolated temp dir so tests never touch the user's
// real ~/.grok/extensions.json.
let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-test-"));
  originalEnv = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalEnv;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

// A config dir PER TEST. This used to be one dir for the whole file, reset by
// deleting `extensions.json` by name — so when persistence moved to
// `plugins.json` the cleanup silently stopped working and a case that disabled
// the module decided whether later cases booted it at all. Pointing the env var
// at a fresh directory cannot rot the same way.
beforeEach(() => {
  process.env.CODESURF_CONFIG_DIR = fs.mkdtempSync(path.join(tempDir, "case-"));
  __resetPluginsForTests();
});

afterEach(async () => {
  await disposeAllProviderSessions();
  __resetPluginsForTests();
});

/**
 * A native Cordis plugin presented to the loader, which is the only shape the
 * loader takes now — the V1 `activate(api)` surface is gone.
 */
function makeExtension(overrides: Partial<CodesurfPlugin> = {}): PluginModule {
  return createNativePluginModule({
    name: "test-example",
    inject: ["contributions"],
    manifest: {
      id: "test.example",
      name: "Example",
      version: "1.0.0",
      capabilities: ["tools", "commands", "settings"],
    },
    apply(ctx: PluginContext) {
      ctx.contributions.registerCommand({
        name: "example",
        description: "Example command",
        handler: () => {},
      });
      ctx.contributions.registerTool({
        name: "example_tool",
        description: "Example tool",
        tool: tool({
          description: "Example tool",
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
      });
    },
    ...overrides,
  });
}

function makeContractExtension(
  id: string,
  capabilities: PluginManifest["capabilities"],
  register: (ctx: PluginContext) => unknown,
): PluginModule {
  return createNativePluginModule({
    name: id,
    manifest: { id, name: id, version: "1.0.0", capabilities },
    inject: ["contributions"],
    // Discard the return: `register` hands back a disposer, and `apply` is void.
    apply: (ctx: PluginContext) => {
      register(ctx);
    },
  });
}

describe("extension kernel", () => {
  it("registers manifest, commands and tools on activation", async () => {
    await bootstrapPlugins([makeExtension()]);
    const snapshot = getRegistrySnapshot();
    expect(snapshot.extensions).toHaveLength(1);
    expect(snapshot.extensions[0]!.active).toBe(true);
    expect(snapshot.extensions[0]!.status).toBe("active");
    expect(snapshot.commands.map((c) => c.name)).toEqual(["example"]);
    expect(snapshot.tools.map((t) => t.name)).toEqual(["example_tool"]);
    expect(Object.keys(getEnabledToolSet())).toEqual(["example_tool"]);
  });

  it("disables non-protected extensions and removes their contributions", async () => {
    await bootstrapPlugins([makeExtension()]);
    await disablePlugin("test.example");
    const snapshot = getRegistrySnapshot();
    expect(snapshot.extensions[0]!.enabled).toBe(false);
    expect(snapshot.extensions[0]!.active).toBe(false);
    expect(snapshot.extensions[0]!.status).toBe("inactive");
    expect(snapshot.commands).toEqual([]);
    expect(snapshot.tools).toEqual([]);
  });

  it("protects protected extensions from being disabled", async () => {
    await bootstrapPlugins([
      makeExtension({
        manifest: {
          id: "test.protected",
          name: "Protected",
          version: "1.0.0",
          protected: true,
          capabilities: ["tools"],
        },
      }),
    ]);
    await disablePlugin("test.protected");
    expect(getRegistrySnapshot().extensions[0]!.enabled).toBe(true);
  });

  it("re-enables an extension after disabling", async () => {
    await bootstrapPlugins([makeExtension()]);
    await disablePlugin("test.example");
    await enablePlugin("test.example");
    const snapshot = getRegistrySnapshot();
    expect(snapshot.extensions[0]!.enabled).toBe(true);
    expect(snapshot.extensions[0]!.active).toBe(true);
    expect(snapshot.extensions[0]!.status).toBe("active");
    expect(snapshot.tools).toHaveLength(1);
  });

  it("awaits async activation before bootstrap resolves", async () => {
    const ext = makeExtension({
      async apply(ctx: PluginContext) {
        await Promise.resolve();
        ctx.contributions.registerCommand({
          name: "async-command",
          description: "Registered after an await",
          handler: () => {},
        });
      },
    });

    await bootstrapPlugins([ext]);

    const snapshot = getRegistrySnapshot();
    expect(snapshot.extensions[0]).toMatchObject({ active: true, status: "active", error: undefined });
    expect(snapshot.commands.map((cmd) => cmd.name)).toEqual(["async-command"]);
  });

  it("marks failed async activation and cleans up partial contributions", async () => {
    const disposed: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ext = makeExtension({
      async apply(ctx: PluginContext) {
        ctx.effect(() => () => {
          disposed.push("disposed");
        });
        ctx.contributions.registerCommand({
          name: "partial-command",
          description: "Should be removed on failure",
          handler: () => {},
        });
        await Promise.resolve();
        throw new Error("activate boom");
      },
    });

    try {
      await bootstrapPlugins([ext]);
    } finally {
      errSpy.mockRestore();
    }

    const snapshot = getRegistrySnapshot();
    expect(snapshot.extensions[0]).toMatchObject({ active: false, status: "failed", error: "activate boom" });
    expect(snapshot.commands).toEqual([]);
    expect(disposed).toEqual(["disposed"]);
  });

  it("can disable an extension while async activation is still pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ext = makeExtension({
      async apply(ctx: PluginContext) {
        ctx.contributions.registerCommand({
          name: "early-command",
          description: "Registered before the activation await",
          handler: () => {},
        });
        await gate;
        ctx.contributions.registerCommand({
          name: "late-command",
          description: "Registered after disable",
          handler: () => {},
        });
      },
    });

    const boot = bootstrapPlugins([ext]);
    await Promise.resolve();
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ status: "activating", active: false });

    await disablePlugin("test.example");
    release();
    await boot;

    const snapshot = getRegistrySnapshot();
    expect(snapshot.extensions[0]).toMatchObject({ enabled: false, active: false, status: "inactive" });
    expect(snapshot.commands).toEqual([]);
  });

  it.each([
    {
      label: "command names",
      capabilities: ["commands"],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerCommand({ name: "/shared", description: "Shared command", handler: () => {} }),
      read: () => getRegistrySnapshot().commands.map((entry) => entry.name),
    },
    {
      label: "tool names",
      capabilities: ["tools"],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerTool({ name: "shared_tool", description: "Shared tool" }),
      read: () => getRegistrySnapshot().tools.map((entry) => entry.name),
    },
    {
      label: "setting keys",
      capabilities: ["settings"],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerSetting({
          key: "shared.setting",
          title: "Shared setting",
          type: "boolean",
          default: true,
        }),
      read: () => getRegistrySnapshot().settings.map((entry) => entry.key),
    },
    {
      label: "screen ids",
      capabilities: ["screens"],
      register: (ctx: PluginContext) => ctx.screens.registerScreen({ id: "screen.shared", render: () => null }),
      read: () => getRegistrySnapshot().screens.map((entry) => entry.id),
    },
    {
      label: "provider adapter ids",
      capabilities: ["provider-adapters"],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerModelProvider({
          id: "adapter.shared",
          label: "Shared adapter",
          providerId: "shared",
          shape: "provider-family",
          transport: "custom",
          connectionMode: "stateless",
          capabilities: { streaming: true },
          auth: { mode: "none", check: () => ({ ok: true }) },
          adapter: {
            connect: () => ({ adapterId: "adapter.shared", providerId: "shared", mode: "stateless" }),
          },
        }),
      read: () => getRegistrySnapshot().modelProviders.map((entry) => entry.id),
    },
  ])("rejects cross-extension duplicate $label", async ({ capabilities, register, read }) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await bootstrapPlugins([
        makeContractExtension("test.first", capabilities as HostCapability[], register),
        makeContractExtension("test.second", capabilities as HostCapability[], register),
      ]);
    } finally {
      errorSpy.mockRestore();
    }

    const first = getRegistrySnapshot().extensions.find((entry) => entry.manifest.id === "test.first");
    const second = getRegistrySnapshot().extensions.find((entry) => entry.manifest.id === "test.second");
    expect(first).toMatchObject({ active: true, status: "active" });
    expect(second).toMatchObject({ active: false, status: "failed" });
    expect(second?.error).toMatch(/already registered by test\.first/);
    expect(read()).toHaveLength(1);
  });

  it("rejects command aliases that collide with another extension's canonical name", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await bootstrapPlugins([
        makeContractExtension("test.alias-owner", ["commands"], (ctx: PluginContext) => {
          ctx.contributions.registerCommand({
            name: "/first",
            aliases: ["/shared"],
            description: "First",
            handler: () => {},
          });
        }),
        makeContractExtension("test.alias-collision", ["commands"], (ctx: PluginContext) => {
          ctx.contributions.registerCommand({ name: "/shared", description: "Second", handler: () => {} });
        }),
      ]);
    } finally {
      errorSpy.mockRestore();
    }

    const collision = getRegistrySnapshot().extensions.find((entry) => entry.manifest.id === "test.alias-collision");
    expect(collision).toMatchObject({ active: false, status: "failed" });
    expect(collision?.error).toMatch(/command identifier.*already registered by test\.alias-owner/i);
    expect(getRegistrySnapshot().commands.map((command) => command.name)).toEqual(["/first"]);
  });

  it.each([
    {
      label: "commands",
      capabilities: [],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerCommand({ name: "/missing", description: "Missing", handler: () => {} }),
    },
    {
      label: "tools",
      capabilities: [],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerTool({ name: "missing_tool", description: "Missing" }),
    },
    {
      label: "settings",
      capabilities: [],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerSetting({ key: "missing.setting", title: "Missing", type: "string", default: "" }),
    },
    {
      label: "models",
      capabilities: [],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerModel({ id: "missing-model", providerId: "missing", label: "Missing" }),
    },
    {
      label: "provider-adapters",
      capabilities: [],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerModelProvider({
          id: "missing.adapter",
          label: "Missing adapter",
          providerId: "missing",
          shape: "provider-family",
          transport: "custom",
          connectionMode: "stateless",
          capabilities: { streaming: true },
          auth: { mode: "none", check: () => ({ ok: true }) },
          adapter: { connect: () => ({ adapterId: "missing.adapter", providerId: "missing", mode: "stateless" }) },
        }),
    },
    {
      label: "screens",
      capabilities: [],
      register: (ctx: PluginContext) => ctx.screens.registerScreen({ id: "missing.screen", render: () => null }),
    },
    {
      label: "status-indicators",
      capabilities: [],
      register: (ctx: PluginContext) =>
        ctx.screens.registerStatusIndicator({ id: "missing.status", render: () => null }),
    },
    {
      label: "mentions",
      capabilities: [],
      register: (ctx: PluginContext) =>
        ctx.contributions.registerMentionProvider({
          match: async () => [],
          resolvePath: (relativePath) => relativePath,
          expand: async (text) => ({ enhancedMessage: text, mentionedFiles: [] }),
        }),
    },
  ])("requires a declared $label capability before registration", async ({ capabilities, register }) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await bootstrapPlugins([
        makeContractExtension("test.missing-capability", capabilities as HostCapability[], register),
      ]);
    } finally {
      errorSpy.mockRestore();
    }

    const record = getRegistrySnapshot().extensions[0];
    expect(record).toMatchObject({ active: false, status: "failed" });
    expect(record?.error).toMatch(/must declare the .* capability/i);
  });

  it("requires the models capability when a provider adapter contributes an inline model", async () => {
    const ext = makeContractExtension("test.provider-inline-model", ["provider-adapters"], (ctx: PluginContext) => {
      ctx.contributions.registerModelProvider({
        id: "inline.adapter",
        label: "Inline adapter",
        providerId: "inline",
        shape: "provider-family",
        transport: "custom",
        connectionMode: "stateless",
        capabilities: { streaming: true },
        auth: { mode: "none", check: () => ({ ok: true }) },
        adapter: { connect: () => ({ adapterId: "inline.adapter", providerId: "inline", mode: "stateless" }) },
        model: { id: "inline-model", providerId: "inline", label: "Inline model" },
      });
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await bootstrapPlugins([ext]);
    } finally {
      errorSpy.mockRestore();
    }

    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ active: false, status: "failed" });
    expect(getRegistrySnapshot().modelProviders).toEqual([]);
    expect(getRegistrySnapshot().models).toEqual([]);
  });

  it.each([
    { capabilities: ["settings", "status-indicators"], missing: "commands" },
    { capabilities: ["commands", "status-indicators"], missing: "settings" },
    { capabilities: ["commands", "settings"], missing: "status-indicators" },
  ])("requires $missing for a toggleable indicator", async ({ capabilities, missing }) => {
    const ext = makeContractExtension(
      "test.toggleable-indicator",
      capabilities as HostCapability[],
      (ctx: PluginContext) => {
        ctx.screens.registerToggleableIndicator({
          id: "toggleable.status",
          command: { name: "/toggleable", description: "Toggleable" },
          settings: [{ key: "toggleable.visible", title: "Visible" }],
          render: () => null,
        });
      },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await bootstrapPlugins([ext]);
    } finally {
      errorSpy.mockRestore();
    }

    const record = getRegistrySnapshot().extensions[0];
    expect(record).toMatchObject({ active: false, status: "failed" });
    expect(record?.error).toContain(missing);
    expect(getRegistrySnapshot().commands).toEqual([]);
    expect(getRegistrySnapshot().settings).toEqual([]);
    expect(getRegistrySnapshot().statusIndicators).toEqual([]);
  });

  it("waits for provider session disposal before re-enabling a provider", async () => {
    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    let signalDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => {
      signalDisconnectStarted = resolve;
    });
    const disconnect = vi.fn(async () => {
      signalDisconnectStarted();
      await disconnectGate;
    });
    let connectCount = 0;

    const ext = makeContractExtension(
      "test.provider-lifecycle",
      ["provider-adapters", "models"],
      (ctx: PluginContext) => {
        ctx.contributions.registerModelProvider({
          id: "lifecycle.adapter",
          label: "Lifecycle adapter",
          providerId: "lifecycle",
          shape: "provider-family",
          transport: "custom",
          connectionMode: "stateless",
          capabilities: { streaming: true },
          auth: { mode: "none", check: () => ({ ok: true }) },
          adapter: {
            connect: () => {
              connectCount += 1;
              return {
                adapterId: "lifecycle.adapter",
                providerId: "lifecycle",
                mode: "stateless",
                getModel: () => null as never,
                disconnect,
              };
            },
          },
          model: { id: "lifecycle-model", providerId: "lifecycle", label: "Lifecycle model" },
        });
      },
    );

    await bootstrapPlugins([ext]);
    await resolveModelRuntimeViaKernel("lifecycle-model", "conversation-1");
    expect(connectCount).toBe(1);

    const disabling = disablePlugin("test.provider-lifecycle");
    await disconnectStarted;

    let enableSettled = false;
    const enabling = enablePlugin("test.provider-lifecycle").then(() => {
      enableSettled = true;
    });
    await Promise.resolve();
    expect(enableSettled).toBe(false);

    releaseDisconnect();
    await Promise.all([disabling, enabling]);

    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ enabled: true, active: true, status: "active" });
    await resolveModelRuntimeViaKernel("lifecycle-model", "conversation-1");
    expect(connectCount).toBe(2);
  });

  it("toggles individual tool enablement without disabling the extension", async () => {
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    expect(isToolEnabled("example_tool")).toBe(true);
    services.tools.setEnabled("example_tool", false);
    expect(isToolEnabled("example_tool")).toBe(false);
    expect(Object.keys(getEnabledToolSet())).toEqual([]);
    // Registry still has the tool — it's just excluded from the enabled ToolSet.
    expect(getRegistrySnapshot().tools).toHaveLength(1);
  });

  it("persists settings across reads through the host service", async () => {
    const ext: PluginModule = makeExtension({
      apply(ctx: PluginContext) {
        ctx.contributions.registerSetting({
          key: "example.theme",
          title: "Theme",
          description: "Active theme name",
          type: "string",
          default: "nerv",
        });
      },
    });
    await bootstrapPlugins([ext]);
    const services = getHostServices();
    expect(services.settings.get<string>("example.theme")).toBe("nerv");
    services.settings.set("example.theme", "dracula");
    expect(services.settings.get<string>("example.theme")).toBe("dracula");
  });

  it("notifies settings subscribers with previous/next values", async () => {
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    const listener = vi.fn();
    const unsubscribe = services.settings.subscribe("custom.key", listener);
    services.settings.set("custom.key", "one");
    services.settings.set("custom.key", "two");
    unsubscribe();
    services.settings.set("custom.key", "three");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, "one", undefined);
    expect(listener).toHaveBeenNthCalledWith(2, "two", "one");
  });

  it("lists extensions with contribution counts", async () => {
    await bootstrapPlugins([makeExtension()]);
    const list = listPlugins();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "test.example",
      source: "builtin",
      enabled: true,
      active: true,
      commands: 1,
      tools: 1,
      models: 0,
    });
  });

  it("registers models returned by provider listModels", async () => {
    const ext: PluginModule = makeExtension({
      manifest: {
        id: "test.dynamic-models",
        name: "Dynamic Models",
        version: "1.0.0",
        capabilities: ["provider-adapters", "models"],
      },
      apply(ctx: PluginContext) {
        ctx.contributions.registerModelProvider({
          id: "adapter.dynamic",
          label: "Dynamic Adapter",
          providerId: "dynamic",
          shape: "provider-family",
          transport: "sdk",
          connectionMode: "stateless",
          capabilities: { streaming: true },
          auth: { mode: "none", check: () => ({ ok: true }) },
          adapter: { connect: () => ({ adapterId: "adapter.dynamic", providerId: "dynamic", mode: "stateless" }) },
          models: [
            {
              id: "dynamic/bootstrap",
              providerId: "dynamic",
              adapterId: "adapter.dynamic",
              label: "Bootstrap",
            },
          ],
          listModels: async () => [
            {
              id: "dynamic/live",
              providerId: "dynamic",
              adapterId: "adapter.dynamic",
              label: "Live",
            },
          ],
        });
      },
    });

    await bootstrapPlugins([ext]);
    expect(getHostServices().models.get("dynamic/bootstrap")).toBeDefined();
    for (let i = 0; i < 10; i += 1) {
      if (getHostServices().models.get("dynamic/live")) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(getHostServices().models.get("dynamic/live")).toMatchObject({
      id: "dynamic/live",
      providerId: "dynamic",
      adapterId: "adapter.dynamic",
      label: "Live",
    });
  });

  it("routes services.chat.dispatch through the host chat sink", async () => {
    const dispatched: string[] = [];
    setChatSink((prompt) => {
      dispatched.push(prompt);
    });
    const ext: PluginModule = makeExtension({
      apply(ctx: PluginContext) {
        ctx.contributions.registerCommand({
          name: "/echo",
          description: "Pipes its prompt back through chat.dispatch",
          handler: () => {
            ctx.chat.dispatch("hello from extension");
          },
        });
      },
    });
    await bootstrapPlugins([ext]);
    const services = getHostServices();
    const command = services.commands.resolve("/echo");
    expect(command).not.toBeNull();
    await Promise.resolve(command!.handler({ args: "", services }));
    expect(dispatched).toEqual(["hello from extension"]);
  });

  it("falls back to process.cwd when no cwd provider is registered", async () => {
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    expect(services.workspace.cwd()).toBe(process.cwd());
  });

  it("uses the configured cwd provider when set", async () => {
    setCwdProvider(() => "/tmp/fake-agent-cwd");
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    expect(services.workspace.cwd()).toBe("/tmp/fake-agent-cwd");
  });

  it("does not run input interceptors again for extension screen keyboard handlers", async () => {
    let screenKeyboardHandler: ((key: InputKey) => void) | undefined;
    // The injected hook is intentionally a plain test seam rather than the
    // real React hook. The raw host input pipeline owns interception before
    // this callback sees the event.
    setKeyboardHookProvider((handler) => {
      screenKeyboardHandler = handler;
    });
    await bootstrapPlugins([makeExtension()]);

    const interceptor = vi.fn(() => false);
    const disposeInterceptor = getHostServices().input.intercept(interceptor);
    const handler = vi.fn();
    getHostServices().input.useKeyboard(handler);

    const key = { name: "x", sequence: "x", ctrl: false, meta: false, shift: false };
    expect(dispatchInputInterceptors(key)).toBe(false);
    expect(interceptor).toHaveBeenCalledTimes(1);

    expect(screenKeyboardHandler).toBeDefined();
    screenKeyboardHandler!(key);
    expect(handler).toHaveBeenCalledWith(key);
    expect(interceptor).toHaveBeenCalledTimes(1);
    disposeInterceptor();
  });

  it("silently no-ops chat.dispatch when no sink is registered", async () => {
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    expect(() => services.chat.dispatch("orphan prompt")).not.toThrow();
  });

  it("awaits async chat.dispatch sinks (signature is Promise<void>)", async () => {
    // The chat-sink signature widened from `void` to `Promise<void> | void`
    // to let extensions wait for downstream agent work to settle. Guard the
    // `await` inside loader.ts dispatch so a future refactor cannot silently
    // remove it.
    let resolved = false;
    setChatSink(async (_prompt) => {
      await new Promise<void>((r) => setTimeout(r, 10));
      resolved = true;
    });
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    await services.chat.dispatch("await me");
    expect(resolved).toBe(true);
  });

  it("routes services.chat.appendAssistant through the host assistant sink", async () => {
    const appended: string[] = [];
    setAssistantSink((content) => {
      appended.push(content);
    });
    const ext: PluginModule = makeExtension({
      apply(ctx: PluginContext) {
        ctx.contributions.registerCommand({
          name: "/list",
          description: "Writes an assistant message via chat.appendAssistant",
          handler: () => {
            ctx.chat.appendAssistant("hello, assistant");
          },
        });
      },
    });
    await bootstrapPlugins([ext]);
    const services = getHostServices();
    const command = services.commands.resolve("/list");
    expect(command).not.toBeNull();
    await Promise.resolve(command!.handler({ args: "", services }));
    expect(appended).toEqual(["hello, assistant"]);
  });

  it("silently no-ops chat.appendAssistant when no sink is registered", async () => {
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    expect(() => services.chat.appendAssistant("orphan content")).not.toThrow();
  });

  it("isolates chat.dispatch and chat.appendAssistant sinks", async () => {
    const dispatched: string[] = [];
    const appended: string[] = [];
    setChatSink((prompt) => {
      dispatched.push(prompt);
    });
    setAssistantSink((content) => {
      appended.push(content);
    });
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    services.chat.dispatch("user prompt");
    services.chat.appendAssistant("assistant content");
    expect(dispatched).toEqual(["user prompt"]);
    expect(appended).toEqual(["assistant content"]);
  });

  it("routes services.ui.action through the host ui-action sink", async () => {
    const dispatched: HostAction[] = [];
    setUiActionSink((action) => {
      dispatched.push(action);
    });
    const ext: PluginModule = makeExtension({
      apply(ctx: PluginContext) {
        ctx.contributions.registerCommand({
          name: "/open-model",
          description: "Pipes an action through services.ui.action",
          handler: () => {
            ctx.ui.action({ type: "model" });
          },
        });
      },
    });
    await bootstrapPlugins([ext]);
    const services = getHostServices();
    const command = services.commands.resolve("/open-model");
    expect(command).not.toBeNull();
    await Promise.resolve(command!.handler({ args: "", services }));
    expect(dispatched).toEqual([{ type: "model" }]);
  });

  it("silently no-ops services.ui.action when no sink is registered", async () => {
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    expect(() => services.ui.action({ type: "model" })).not.toThrow();
  });

  it("preserves payload shape for arg-carrying actions", async () => {
    const dispatched: HostAction[] = [];
    setUiActionSink((action) => {
      dispatched.push(action);
    });
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    services.ui.action({ type: "claude-agent", focusGroup: "thinking" });
    services.ui.action({ type: "set-ui-mode", mode: "opencode" });
    expect(dispatched).toEqual([
      { type: "claude-agent", focusGroup: "thinking" },
      { type: "set-ui-mode", mode: "opencode" },
    ]);
  });

  it("isolates ui.action from chat sinks", async () => {
    const chat: string[] = [];
    const ui: HostAction[] = [];
    setChatSink((p) => {
      chat.push(p);
    });
    setUiActionSink((a) => {
      ui.push(a);
    });
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    services.chat.dispatch("hi");
    services.ui.action({ type: "quit" });
    expect(chat).toEqual(["hi"]);
    expect(ui).toEqual([{ type: "quit" }]);
  });

  it("resolves dynamic command resolvers when static lookup fails", async () => {
    const dispatched: string[] = [];
    setChatSink((prompt) => {
      dispatched.push(prompt);
    });
    const ext = createNativePluginModule({
      name: "test-resolver",
      manifest: {
        id: "test.resolver",
        name: "Resolver",
        version: "1.0.0",
        capabilities: ["commands"],
      },
      inject: ["contributions"],
      apply(ctx: PluginContext) {
        ctx.contributions.registerCommandResolver({
          resolve(input: string) {
            if (!input.startsWith("/dynamic")) return null;
            const args = input.slice("/dynamic".length).trim();
            return {
              command: {
                pluginId: "test.resolver",
                name: "/dynamic",
                description: "Synthesized",
                handler: ({ args: handlerArgs }) => {
                  ctx.chat.dispatch(`saw:${handlerArgs}`);
                },
              },
              args,
            };
          },
        });
      },
    });
    await bootstrapPlugins([ext]);
    const services = getHostServices();
    const resolution = services.commands.resolveInput("/dynamic hello world");
    expect(resolution).not.toBeNull();
    expect(resolution!.args).toBe("hello world");
    expect(resolution!.command.name).toBe("/dynamic");
    await Promise.resolve(resolution!.command.handler({ args: resolution!.args, services }));
    expect(dispatched).toEqual(["saw:hello world"]);
  });

  it("returns null from resolveInput when no resolver and no static command match", async () => {
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    expect(services.commands.resolveInput("/no-such-command rest")).toBeNull();
    expect(services.commands.resolveInput("")).toBeNull();
  });

  it("resolves static commands with the args portion of the input", async () => {
    await bootstrapPlugins([makeExtension()]);
    const services = getHostServices();
    const resolution = services.commands.resolveInput("example  arg1  arg2");
    expect(resolution).not.toBeNull();
    expect(resolution!.command.name).toBe("example");
    expect(resolution!.args).toBe("arg1  arg2");
  });

  it("prefers static commands over resolvers for the same name", async () => {
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.priority",
        name: "Priority",
        version: "1.0.0",
        capabilities: ["commands"],
      },
      apply(ctx: PluginContext) {
        ctx.contributions.registerCommand({
          name: "/shared",
          description: "Static command",
          handler: () => {},
        });
        ctx.contributions.registerCommandResolver({
          resolve(input: string) {
            if (!input.startsWith("/shared")) return null;
            return {
              command: {
                pluginId: "test.priority",
                name: "/shared",
                description: "From resolver",
                handler: () => {},
              },
              args: "from-resolver",
            };
          },
        });
      },
    });
    await bootstrapPlugins([ext]);
    const services = getHostServices();
    const resolution = services.commands.resolveInput("/shared anything");
    expect(resolution).not.toBeNull();
    expect(resolution!.command.description).toBe("Static command");
    expect(resolution!.args).toBe("anything");
  });

  it("walks resolvers in registration order until one matches", async () => {
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.chain",
        name: "Chain",
        version: "1.0.0",
        capabilities: ["commands"],
      },
      apply(ctx: PluginContext) {
        ctx.contributions.registerCommandResolver({
          resolve: (_input: string) => null, // always declines
        });
        ctx.contributions.registerCommandResolver({
          resolve(input: string) {
            if (!input.startsWith("/two")) return null;
            return {
              command: {
                pluginId: "test.chain",
                name: "/two",
                description: "Second resolver",
                handler: () => {},
              },
              args: input.slice("/two".length).trim(),
            };
          },
        });
      },
    });
    await bootstrapPlugins([ext]);
    const services = getHostServices();
    const resolution = services.commands.resolveInput("/two payload");
    expect(resolution).not.toBeNull();
    expect(resolution!.command.description).toBe("Second resolver");
    expect(resolution!.args).toBe("payload");
  });

  it("drops resolvers when an extension is disabled", async () => {
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.drop",
        name: "Drop",
        version: "1.0.0",
        capabilities: ["commands"],
      },
      apply(ctx: PluginContext) {
        ctx.contributions.registerCommandResolver({
          resolve(input: string) {
            if (!input.startsWith("/dropme")) return null;
            return {
              command: {
                pluginId: "test.drop",
                name: "/dropme",
                description: "Drop target",
                handler: () => {},
              },
              args: "",
            };
          },
        });
      },
    });
    await bootstrapPlugins([ext]);
    const services = getHostServices();
    expect(services.commands.resolveInput("/dropme")).not.toBeNull();
    await disablePlugin("test.drop");
    expect(services.commands.resolveInput("/dropme")).toBeNull();
  });

  it("swallows resolver exceptions and continues the chain", async () => {
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.exceptions",
        name: "Exceptions",
        version: "1.0.0",
        capabilities: ["commands"],
      },
      apply(ctx: PluginContext) {
        ctx.contributions.registerCommandResolver({
          resolve: (_input: string) => {
            throw new Error("resolver boom");
          },
        });
        ctx.contributions.registerCommandResolver({
          resolve(input: string) {
            if (!input.startsWith("/safe")) return null;
            return {
              command: {
                pluginId: "test.exceptions",
                name: "/safe",
                description: "Safe resolver",
                handler: () => {},
              },
              args: "",
            };
          },
        });
      },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await bootstrapPlugins([ext]);
      const services = getHostServices();
      const resolution = services.commands.resolveInput("/safe");
      expect(resolution).not.toBeNull();
      expect(resolution!.command.description).toBe("Safe resolver");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  // `hostApiVersion` is a HOST manifest field. A native plugin cannot set it —
  // the bridge fills it in — so these build the module the loader consumes
  // directly. The loader's version guard still runs on every module, and this
  // is what keeps it covered now that no plugin can express a bad value.
  const rawModule = (id: string, hostApiVersion: string, activate: () => void = () => {}): PluginModule => ({
    manifest: {
      schemaVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      hostApiVersion,
      kind: "builtin",
      capabilities: [],
    },
    activate,
  });

  it("rejects manifests targeting an incompatible host api version", async () => {
    await expect(bootstrapPlugins([rawModule("test.incompat", "9.9.9")])).rejects.toThrow(/host API 9\.9\.9/);
  });

  it("accepts manifests targeting a compatible v1 host api version", async () => {
    let activated = false;
    const compatible = rawModule("test.compat", "1.1.0", () => {
      activated = true;
    });

    await bootstrapPlugins([compatible]);
    expect(activated).toBe(true);
  });

  // The host-action command cases that lived here (payload dispatch, alias
  // resolution, /permissions fan-out, /term + /btw + /help usage text) moved to
  // `native/host-actions.test.ts` when that builtin became a native Cordis
  // plugin: they need `__resetNativeRuntimeForTests()` around each mount, which
  // that suite's hooks provide and this one's do not.

  it("registers screens contributed via the screens capability", async () => {
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.screens",
        name: "Screens",
        version: "1.0.0",
        capabilities: ["screens"],
      },
      apply(ctx: PluginContext) {
        ctx.screens.registerScreen({
          id: "screen.alpha",
          label: "Alpha",
          render: () => null,
        });
      },
    });
    await bootstrapPlugins([ext]);
    const screens = getRegistrySnapshot().screens;
    expect(screens.map((s) => s.id)).toEqual(["screen.alpha"]);
    expect(screens[0]!.pluginId).toBe("test.screens");
    expect(screens[0]!.label).toBe("Alpha");
  });

  it("upserts screens by id (re-registering replaces, doesn't duplicate)", async () => {
    // The registered `render` is a WRAPPER: the bridge narrows the host's
    // services facade before handing it to a plugin's screen. So this asserts
    // which function actually runs, not function identity — identity could
    // never match and would be testing the wrapper, not the upsert.
    const calls: string[] = [];
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.screens.upsert",
        name: "Screens",
        version: "1.0.0",
        capabilities: ["screens"],
      },
      apply(ctx: PluginContext) {
        ctx.screens.registerScreen({
          id: "screen.x",
          label: "First",
          render: () => {
            calls.push("first");
            return null;
          },
        });
        ctx.screens.registerScreen({
          id: "screen.x",
          label: "Second",
          render: () => {
            calls.push("second");
            return null;
          },
        });
      },
    });
    await bootstrapPlugins([ext]);
    const screens = getRegistrySnapshot().screens;
    expect(screens).toHaveLength(1);
    expect(screens[0]!.label).toBe("Second");

    screens[0]!.render({ props: undefined, close: () => {}, services: { input: { useKeyboard: () => {} } } } as never);
    expect(calls).toEqual(["second"]);
  });

  it("preserves screen registration order (no alphabetical sort)", async () => {
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.screens.order",
        name: "Screens",
        version: "1.0.0",
        capabilities: ["screens"],
      },
      apply(ctx: PluginContext) {
        ctx.screens.registerScreen({ id: "screen.zulu", render: () => null });
        ctx.screens.registerScreen({ id: "screen.alpha", render: () => null });
        ctx.screens.registerScreen({ id: "screen.mike", render: () => null });
      },
    });
    await bootstrapPlugins([ext]);
    expect(getRegistrySnapshot().screens.map((s) => s.id)).toEqual(["screen.zulu", "screen.alpha", "screen.mike"]);
  });

  it("drops screen contributions when an extension is disabled, restores on re-enable", async () => {
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.screens.toggle",
        name: "Screens",
        version: "1.0.0",
        capabilities: ["screens"],
      },
      apply(ctx: PluginContext) {
        ctx.screens.registerScreen({ id: "screen.toggle", render: () => null });
      },
    });
    await bootstrapPlugins([ext]);
    expect(getRegistrySnapshot().screens.map((s) => s.id)).toEqual(["screen.toggle"]);

    await disablePlugin("test.screens.toggle");
    expect(getRegistrySnapshot().screens).toEqual([]);

    await enablePlugin("test.screens.toggle");
    expect(getRegistrySnapshot().screens.map((s) => s.id)).toEqual(["screen.toggle"]);
  });

  // ── Mode-filter tests (Phase 2 #4) ─────────────────────────────────────────
  // Covers the `RegisteredTool.modes` + `setKernelMode` filter on both
  // `getEnabledToolSet()` (kernel-owned tools) and `filterToolSetByEnabled()`
  // (Agent's externally-produced ToolSet).

  function makeModeExtension(): PluginModule {
    return createNativePluginModule({
      name: "test-modes",
      inject: ["contributions"],
      manifest: {
        id: "test.modes",
        name: "Modes",
        version: "1.0.0",
        capabilities: ["tools"],
      },
      apply(ctx: PluginContext) {
        // Available in agent mode only.
        ctx.contributions.registerTool({
          name: "agent_only_tool",
          description: "Agent-only",
          modes: ["agent"],
          tool: tool({
            description: "Agent-only",
            inputSchema: z.object({}),
            execute: async () => "ok",
          }),
        });
        // Always available — no `modes` field.
        ctx.contributions.registerTool({
          name: "always_tool",
          description: "Always",
          tool: tool({
            description: "Always",
            inputSchema: z.object({}),
            execute: async () => "ok",
          }),
        });
      },
    });
  }

  it("filters mode-gated tools out of the enabled ToolSet when the kernel mode mismatches", async () => {
    await bootstrapPlugins([makeModeExtension()]);
    setKernelMode("plan");
    const set = getEnabledToolSet();
    expect(Object.keys(set).sort()).toEqual(["always_tool"]);
  });

  it("includes mode-gated tools when the kernel mode matches", async () => {
    await bootstrapPlugins([makeModeExtension()]);
    setKernelMode("agent");
    const set = getEnabledToolSet();
    expect(Object.keys(set).sort()).toEqual(["agent_only_tool", "always_tool"]);
  });

  it("re-filters the ToolSet when the kernel mode changes between turns", async () => {
    await bootstrapPlugins([makeModeExtension()]);
    setKernelMode("agent");
    expect(Object.keys(getEnabledToolSet()).sort()).toEqual(["agent_only_tool", "always_tool"]);
    setKernelMode("ask");
    expect(Object.keys(getEnabledToolSet()).sort()).toEqual(["always_tool"]);
    setKernelMode("agent");
    expect(Object.keys(getEnabledToolSet()).sort()).toEqual(["agent_only_tool", "always_tool"]);
  });

  it("preserves backward compat when the kernel mode is null (pre-Phase-2 behavior)", async () => {
    await bootstrapPlugins([makeModeExtension()]);
    // No setKernelMode call — currentKernelMode stays null.
    expect(Object.keys(getEnabledToolSet()).sort()).toEqual(["agent_only_tool", "always_tool"]);
  });

  it("strips mode-gated tools from filterToolSetByEnabled (Agent's createTools output) when mode mismatches", async () => {
    await bootstrapPlugins([makeModeExtension()]);
    setKernelMode("plan");
    // Simulate the Agent's createTools() output with the same names that the
    // kernel knows about — `filterToolSetByEnabled` should mode-gate them.
    const externalToolSet = {
      agent_only_tool: tool({ description: "x", inputSchema: z.object({}), execute: async () => "ok" }),
      always_tool: tool({ description: "x", inputSchema: z.object({}), execute: async () => "ok" }),
      // An unknown name (e.g. an MCP-provided tool) should pass through.
      mcp_some_tool: tool({ description: "x", inputSchema: z.object({}), execute: async () => "ok" }),
    };
    const filtered = filterToolSetByEnabled(externalToolSet);
    expect(Object.keys(filtered).sort()).toEqual(["always_tool", "mcp_some_tool"]);
  });

  it("clears the kernel mode on shutdown / test reset (currentKernelMode resets to null)", async () => {
    await bootstrapPlugins([makeModeExtension()]);
    setKernelMode("plan");
    expect(Object.keys(getEnabledToolSet()).sort()).toEqual(["always_tool"]);
    // afterEach calls __resetPluginsForTests which should reset
    // currentKernelMode to null. Re-bootstrap and confirm the previous mode
    // didn't leak into the new test scope.
    __resetPluginsForTests();
    await bootstrapPlugins([makeModeExtension()]);
    // Without setKernelMode, mode-gated tools surface again.
    expect(Object.keys(getEnabledToolSet()).sort()).toEqual(["agent_only_tool", "always_tool"]);
  });
});

describe("services.bash sink lifecycle", () => {
  // The kernel exposes `services.bash` as a 12-method proxy whose accessors
  // forward to whatever was last passed to `setBashSink(...)`. The
  // `builtin.tools.bash` extension binds the sink at activation; tests can
  // override with a stub. When the sink is unbound (pre-activation, or after
  // explicit clear / shutdown / test reset) every accessor MUST throw.

  function makeStubBashSink(overrides: Partial<BashSink> = {}): BashSink {
    return {
      cwd: () => "/stub/cwd",
      execute: async () => ({ success: true, output: "stub-execute" }),
      startBackground: async () => ({ success: true, output: "stub-start" }),
      getProcessLogs: async () => ({ success: true, output: "stub-logs" }),
      stopProcess: async () => ({ success: true, output: "stub-stop" }),
      listProcesses: () => ({ success: true, output: "stub-list" }),
      // `BashTool` is not exercised here — tests that need an instance check
      // override `spawnChild` per-test. Throw so unintended callers fail loud.
      spawnChild: () => {
        throw new Error("stub spawnChild");
      },
      cleanup: async () => {},
      getSandboxMode: () => "off",
      setSandboxMode: () => {},
      getSandboxSettings: () => ({}),
      setSandboxSettings: () => {},
      ...overrides,
    };
  }

  it("throws on every accessor when no sink is bound", () => {
    const services = getHostServices();
    expect(() => services.bash.cwd()).toThrowError(/Bash sink is not active/);
    expect(() => services.bash.listProcesses()).toThrowError(/Bash sink is not active/);
    expect(() => services.bash.getSandboxMode()).toThrowError(/Bash sink is not active/);
    expect(() => services.bash.spawnChild("/x")).toThrowError(/Bash sink is not active/);
    // Async accessors throw synchronously from `requireBashSink()` (the
    // throw fires before the proxy function returns its Promise).
    expect(() => services.bash.execute("echo hi")).toThrowError(/Bash sink is not active/);
  });

  it("forwards every accessor to the bound sink", async () => {
    const calls: string[] = [];
    const sink = makeStubBashSink({
      cwd: () => {
        calls.push("cwd");
        return "/forwarded/cwd";
      },
      execute: async (command, timeout) => {
        calls.push(`execute:${command}:${timeout ?? "no-timeout"}`);
        return { success: true, output: "forwarded-execute" };
      },
      startBackground: async (command) => {
        calls.push(`startBackground:${command}`);
        return { success: true, output: "forwarded-start" };
      },
      getProcessLogs: async (id, tail) => {
        calls.push(`getProcessLogs:${id}:${tail ?? "no-tail"}`);
        return { success: true, output: "forwarded-logs" };
      },
      stopProcess: async (id) => {
        calls.push(`stopProcess:${id}`);
        return { success: true, output: "forwarded-stop" };
      },
      listProcesses: () => {
        calls.push("listProcesses");
        return { success: true, output: "forwarded-list" };
      },
      cleanup: async () => {
        calls.push("cleanup");
      },
      getSandboxMode: () => {
        calls.push("getSandboxMode");
        return "shuru";
      },
      setSandboxMode: (mode) => {
        calls.push(`setSandboxMode:${mode}`);
      },
      getSandboxSettings: () => {
        calls.push("getSandboxSettings");
        return { allowNet: true };
      },
      setSandboxSettings: (settings) => {
        calls.push(`setSandboxSettings:${Object.keys(settings).join(",")}`);
      },
    });
    setBashSink(sink);

    const services = getHostServices();
    expect(services.bash.cwd()).toBe("/forwarded/cwd");
    expect((await services.bash.execute("ls", 5000)).output).toBe("forwarded-execute");
    expect((await services.bash.startBackground("npm run dev")).output).toBe("forwarded-start");
    expect((await services.bash.getProcessLogs(7, 25)).output).toBe("forwarded-logs");
    expect((await services.bash.stopProcess(7)).output).toBe("forwarded-stop");
    expect(services.bash.listProcesses().output).toBe("forwarded-list");
    await services.bash.cleanup();
    expect(services.bash.getSandboxMode()).toBe("shuru");
    services.bash.setSandboxMode("off");
    expect(services.bash.getSandboxSettings()).toEqual({ allowNet: true });
    services.bash.setSandboxSettings({ cpus: 2 });

    expect(calls).toEqual([
      "cwd",
      "execute:ls:5000",
      "startBackground:npm run dev",
      "getProcessLogs:7:25",
      "stopProcess:7",
      "listProcesses",
      "cleanup",
      "getSandboxMode",
      "setSandboxMode:off",
      "getSandboxSettings",
      "setSandboxSettings:cpus",
    ]);
  });

  it("replaces the sink when setBashSink is called with a new one", async () => {
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    setBashSink(
      makeStubBashSink({
        execute: async (command) => {
          firstCalls.push(command);
          return { success: true, output: "first" };
        },
      }),
    );
    const services = getHostServices();
    expect((await services.bash.execute("first-call")).output).toBe("first");

    setBashSink(
      makeStubBashSink({
        execute: async (command) => {
          secondCalls.push(command);
          return { success: true, output: "second" };
        },
      }),
    );
    expect((await services.bash.execute("second-call")).output).toBe("second");

    expect(firstCalls).toEqual(["first-call"]);
    expect(secondCalls).toEqual(["second-call"]);
  });

  it("returns to the unbound-throw state when setBashSink(null) clears the sink", () => {
    setBashSink(makeStubBashSink());
    const services = getHostServices();
    expect(services.bash.cwd()).toBe("/stub/cwd");

    setBashSink(null);
    expect(() => services.bash.cwd()).toThrowError(/Bash sink is not active/);
    expect(() => services.bash.listProcesses()).toThrowError(/Bash sink is not active/);
  });
});

describe("services.hooks sink lifecycle", () => {
  // The kernel exposes `services.hooks` as a 4-method proxy whose accessors
  // forward to whatever was last passed to `setHooksSink(...)`. The Agent
  // binds the sink at construction (closing over the hooks-module functions
  // and `services.bash.cwd()`); when no Agent has bound it (headless boot,
  // tests without an Agent) every method MUST resolve to a no-op
  // `AggregatedHookResult` (blocked: false). This is the explicit contract
  // that lets the bash tool work without an Agent constructed.

  function emptyResult() {
    return {
      blocked: false,
      blockingErrors: [],
      preventContinuation: false,
      additionalContexts: [],
      results: [],
    };
  }

  function makeStubHooksSink(overrides: Partial<HooksSink> = {}): HooksSink {
    return {
      runPre: async () => emptyResult(),
      runPost: async () => emptyResult(),
      runFailure: async () => emptyResult(),
      runEvent: async () => emptyResult(),
      ...overrides,
    };
  }

  it("returns a no-op result on every accessor when no sink is bound", async () => {
    const services = getHostServices();
    // No `setHooksSink(...)` here — sink is null after `__resetPluginsForTests`.
    const pre = await services.hooks.runPre("any-tool", { foo: 1 });
    expect(pre.blocked).toBe(false);
    expect(pre.blockingErrors).toEqual([]);

    const post = await services.hooks.runPost("any-tool", {}, {});
    expect(post.blocked).toBe(false);

    const failure = await services.hooks.runFailure("any-tool", {}, "boom");
    expect(failure.blocked).toBe(false);

    const event = await services.hooks.runEvent({
      hook_event_name: "Notification",
      message: "test",
      cwd: "/tmp",
    } as never);
    expect(event.blocked).toBe(false);
  });

  it("forwards every accessor to the bound sink", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const sink = makeStubHooksSink({
      runPre: async (...args) => {
        calls.push({ method: "runPre", args });
        return { ...emptyResult(), additionalContexts: ["pre-ran"] };
      },
      runPost: async (...args) => {
        calls.push({ method: "runPost", args });
        return { ...emptyResult(), additionalContexts: ["post-ran"] };
      },
      runFailure: async (...args) => {
        calls.push({ method: "runFailure", args });
        return { ...emptyResult(), additionalContexts: ["failure-ran"] };
      },
      runEvent: async (...args) => {
        calls.push({ method: "runEvent", args });
        return { ...emptyResult(), additionalContexts: ["event-ran"] };
      },
    });
    setHooksSink(sink);
    const services = getHostServices();

    const pre = await services.hooks.runPre("bash", { command: "ls" }, "session-1");
    expect(pre.additionalContexts).toEqual(["pre-ran"]);
    const post = await services.hooks.runPost("bash", { command: "ls" }, { ok: true }, "session-1");
    expect(post.additionalContexts).toEqual(["post-ran"]);
    const failure = await services.hooks.runFailure("bash", { command: "ls" }, "boom", "session-1");
    expect(failure.additionalContexts).toEqual(["failure-ran"]);
    const event = await services.hooks.runEvent({
      hook_event_name: "Notification",
      message: "hi",
      cwd: "/tmp",
    } as never);
    expect(event.additionalContexts).toEqual(["event-ran"]);

    expect(calls.map((c) => c.method)).toEqual(["runPre", "runPost", "runFailure", "runEvent"]);

    // runPre signature: (toolName, toolInput, sessionId?, abortSignal?)
    expect(calls[0]!.args[0]).toBe("bash");
    expect(calls[0]!.args[1]).toEqual({ command: "ls" });
    expect(calls[0]!.args[2]).toBe("session-1");

    // runPost signature: (toolName, toolInput, toolOutput, sessionId?, abortSignal?)
    expect(calls[1]!.args[0]).toBe("bash");
    expect(calls[1]!.args[1]).toEqual({ command: "ls" });
    expect(calls[1]!.args[2]).toEqual({ ok: true });
    expect(calls[1]!.args[3]).toBe("session-1");

    // runFailure signature: (toolName, toolInput, error, sessionId?, abortSignal?)
    expect(calls[2]!.args[0]).toBe("bash");
    expect(calls[2]!.args[1]).toEqual({ command: "ls" });
    expect(calls[2]!.args[2]).toBe("boom");
    expect(calls[2]!.args[3]).toBe("session-1");

    // runEvent signature: (input, abortSignal?)
    expect(calls[3]!.args[0]).toMatchObject({ hook_event_name: "Notification", message: "hi" });
  });

  it("replaces the sink when setHooksSink is called with a new one", async () => {
    setHooksSink(
      makeStubHooksSink({
        runPre: async () => ({ ...emptyResult(), additionalContexts: ["first"] }),
      }),
    );
    const services = getHostServices();
    let result = await services.hooks.runPre("bash", {});
    expect(result.additionalContexts).toEqual(["first"]);

    setHooksSink(
      makeStubHooksSink({
        runPre: async () => ({ ...emptyResult(), additionalContexts: ["second"] }),
      }),
    );
    result = await services.hooks.runPre("bash", {});
    expect(result.additionalContexts).toEqual(["second"]);
  });

  it("returns to the unbound no-op state when setHooksSink(null) clears the sink", async () => {
    setHooksSink(
      makeStubHooksSink({
        runPre: async () => ({ ...emptyResult(), additionalContexts: ["bound"] }),
      }),
    );
    const services = getHostServices();
    expect((await services.hooks.runPre("bash", {})).additionalContexts).toEqual(["bound"]);

    setHooksSink(null);
    const cleared = await services.hooks.runPre("bash", {});
    expect(cleared.blocked).toBe(false);
    expect(cleared.additionalContexts).toEqual([]);
  });

  it("swallows throws from a misbehaving sink and returns a no-op result", async () => {
    // The proxy in `loader.ts:608-643` wraps every call in try/catch — protects
    // the agent from a buggy sink (third-party or future). Defensive layer
    // covered here so a future cleanup PR can't silently strip it.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setHooksSink({
      runPre: async () => {
        throw new Error("runPre boom");
      },
      runPost: async () => {
        throw new Error("runPost boom");
      },
      runFailure: async () => {
        throw new Error("runFailure boom");
      },
      runEvent: async () => {
        throw new Error("runEvent boom");
      },
    });

    const services = getHostServices();
    const pre = await services.hooks.runPre("bash", {});
    const post = await services.hooks.runPost("bash", {}, {});
    const failure = await services.hooks.runFailure("bash", {}, "x");
    const event = await services.hooks.runEvent({ hook_event_name: "Notification", message: "x", cwd: "/" } as never);

    // All four resolve to a no-op AggregatedHookResult, not a rejection.
    for (const result of [pre, post, failure, event]) {
      expect(result.blocked).toBe(false);
      expect(result.blockingErrors).toEqual([]);
      expect(result.additionalContexts).toEqual([]);
    }

    // Each throw was logged.
    expect(consoleSpy).toHaveBeenCalledTimes(4);
    expect(consoleSpy.mock.calls.map((c) => c[0])).toEqual([
      "[extensions] hooks.runPre threw:",
      "[extensions] hooks.runPost threw:",
      "[extensions] hooks.runFailure threw:",
      "[extensions] hooks.runEvent threw:",
    ]);

    consoleSpy.mockRestore();
  });
});

describe("clearAllSinks", () => {
  // Single seam consolidating sink cleanup for shutdownPlugins +
  // __resetPluginsForTests. After the call, every host-service sink
  // accessor MUST behave as if no host had bound it (no-op for bridges that
  // swallow, throw for the bash bridge whose `requireBashSink()` semantics
  // remain unchanged).

  it("clears every sink in one call", async () => {
    const toastCalls: string[] = [];
    const chatCalls: string[] = [];
    const assistantCalls: string[] = [];
    const uiCalls: HostAction[] = [];

    // Bind a sampling of sinks across the surface.
    setAssistantSink((c) => assistantCalls.push(c));
    setChatSink((p) => void chatCalls.push(p));
    setUiActionSink((a) => uiCalls.push(a));
    setCwdProvider(() => "/from-provider");
    setBashSink({
      cwd: () => "/bash-bound",
      execute: async () => ({ success: true, output: "x" }),
      startBackground: async () => ({ success: true, output: "x" }),
      getProcessLogs: async () => ({ success: true, output: "x" }),
      stopProcess: async () => ({ success: true, output: "x" }),
      listProcesses: () => ({ success: true, output: "x" }),
      spawnChild: () => {
        throw new Error("not used");
      },
      cleanup: async () => {},
      getSandboxMode: () => "off",
      setSandboxMode: () => {},
      getSandboxSettings: () => ({}),
      setSandboxSettings: () => {},
    });
    setHooksSink({
      runPre: async () => ({
        blocked: true,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: ["bound"],
        results: [],
      }),
      runPost: async () => ({
        blocked: false,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: [],
        results: [],
      }),
      runFailure: async () => ({
        blocked: false,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: [],
        results: [],
      }),
      runEvent: async () => ({
        blocked: false,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: [],
        results: [],
      }),
    });

    const services = getHostServices();
    // Sanity: bound sinks are observable.
    services.toast.show({ title: "hi" });
    services.chat.dispatch("hello");
    services.chat.appendAssistant("appended");
    services.ui.action({ type: "clear" });
    expect(services.workspace.cwd()).toBe("/from-provider");
    expect(services.bash.cwd()).toBe("/bash-bound");
    expect((await services.hooks.runPre("bash", {})).blocked).toBe(true);

    clearAllSinks();

    // After clearing: the no-op bridges (toast, chat, assistant, ui, cwd
    // provider) silently drop calls. The bash bridge's accessors throw
    // because `requireBashSink()` enforces an active extension. The hooks
    // bridge falls back to the empty result.
    services.toast.show({ title: "post-clear" }); // no-op
    services.chat.dispatch("post-clear"); // no-op
    services.chat.appendAssistant("post-clear"); // no-op
    services.ui.action({ type: "quit" }); // no-op
    // No new entries should have been recorded after clearAllSinks.
    expect(toastCalls).toEqual([]);
    expect(chatCalls).toEqual(["hello"]);
    expect(assistantCalls).toEqual(["appended"]);
    expect(uiCalls).toEqual([{ type: "clear" }]);

    // cwdProvider unbound ⇒ falls back to process.cwd().
    expect(services.workspace.cwd()).toBe(process.cwd());
    // bashSink unbound ⇒ throws.
    expect(() => services.bash.cwd()).toThrowError(/Bash sink is not active/);
    // hooksSink unbound ⇒ no-op result.
    const cleared = await services.hooks.runPre("bash", {});
    expect(cleared.blocked).toBe(false);
    expect(cleared.additionalContexts).toEqual([]);
  });
});
