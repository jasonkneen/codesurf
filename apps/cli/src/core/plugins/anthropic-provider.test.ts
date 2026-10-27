import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadBuiltinPlugins } from "./builtin";
import { __resetPluginsForTests, bootstrapPlugins, enablePlugin, getHostServices, getRegistrySnapshot } from "./index";

// Redirect persistence to an isolated temp dir.
let tempDir: string;
let originalConfigDir: string | undefined;
let originalAnthropicKey: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-anthropic-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.CODESURF_CONFIG_DIR = tempDir;
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  if (originalAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  const credsFile = path.join(tempDir, "credentials.json");
  if (fs.existsSync(credsFile)) fs.unlinkSync(credsFile);
  delete process.env.ANTHROPIC_API_KEY;
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
});

describe("builtin.provider-anthropic", () => {
  it("is enabled by default", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const record = getRegistrySnapshot().extensions.find((e) => e.manifest.id === "builtin.provider-anthropic");
    expect(record).toBeDefined();
    expect(record?.enabled).toBe(true);
    expect(record?.active).toBe(true);
    // Models are registered once the extension activates on bootstrap.
    expect(
      getHostServices()
        .models.list()
        .find((m) => m.providerId === "anthropic"),
    ).toBeDefined();
  });

  it("registers its adapter and models when enabled", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");

    const providers = getHostServices().models.listProviders();
    const anthropic = providers.find((p) => p.id === "anthropic.api-key");
    expect(anthropic).toBeDefined();
    expect(anthropic?.providerId).toBe("anthropic");
    expect(anthropic?.auth.mode).toBe("api-key");
    expect(anthropic?.transport).toBe("sdk");

    const models = getHostServices()
      .models.list()
      .filter((m) => m.providerId === "anthropic");
    expect(models.length).toBeGreaterThanOrEqual(4);
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        "claude-fable-5",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-5-5",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-haiku-5-5",
        "claude-haiku-4-5",
      ]),
    );
  });

  it("registers every current Claude model with its real context window", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");
    const windowOf = (id: string) => getHostServices().models.get(id)?.contextWindow;
    expect(windowOf("claude-opus-5-5")).toBe(1_000_000);
    expect(windowOf("claude-sonnet-5-5")).toBe(1_000_000);
    expect(windowOf("claude-haiku-5-5")).toBe(1_000_000);
    expect(windowOf("claude-haiku-4-5")).toBe(200_000);
  });

  it("reports credentials missing when ANTHROPIC_API_KEY is unset", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");
    const anthropic = getHostServices()
      .models.listProviders()
      .find((p) => p.id === "anthropic.api-key");
    expect(anthropic).toBeDefined();
    const status = await anthropic!.auth.check({
      conversationId: "test",
      adapterId: "anthropic.api-key",
      providerId: "anthropic",
      settings: getHostServices().settings,
    });
    expect(status.ok).toBe(false);
    expect(status.needsUserAction).toBe("paste-api-key");
    expect(status.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("reports credentials ready when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");
    const anthropic = getHostServices()
      .models.listProviders()
      .find((p) => p.id === "anthropic.api-key");
    const status = await anthropic!.auth.check({
      conversationId: "test",
      adapterId: "anthropic.api-key",
      providerId: "anthropic",
      settings: getHostServices().settings,
    });
    expect(status.ok).toBe(true);
  });

  it("resolves aliases via getHostServices().models.get()", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    await enablePlugin("builtin.provider-anthropic");
    const sonnet = getHostServices().models.get("sonnet");
    expect(sonnet?.id).toBe("claude-sonnet-5-5");
    // Bare family aliases track the NEWEST release, so `opus` follows Opus 5.5.
    const opus = getHostServices().models.get("opus");
    expect(opus?.id).toBe("claude-opus-5-5");
    const haiku = getHostServices().models.get("haiku");
    expect(haiku?.id).toBe("claude-haiku-5-5");
    const fable = getHostServices().models.get("fable");
    expect(fable?.id).toBe("claude-fable-5-1");
  });
});
