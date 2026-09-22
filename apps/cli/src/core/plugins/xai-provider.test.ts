import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MODELS } from "../../grok/models";
import { loadBuiltinPlugins } from "./builtin";
import { __resetPluginsForTests, bootstrapPlugins, disablePlugin, getHostServices, getRegistrySnapshot } from "./index";

// Redirect persistence so we don't touch ~/.grok/extensions.json.
let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-xai-provider-test-"));
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

beforeEach(() => {
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
});

describe("builtin.provider-xai", () => {
  it("registers the xAI adapter with the expected shape", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const providers = getHostServices().models.listProviders();
    const xai = providers.find((p) => p.id === "xai.default");
    expect(xai).toBeDefined();
    expect(xai?.providerId).toBe("xai");
    expect(xai?.shape).toBe("provider-family");
    expect(xai?.transport).toBe("sdk");
    expect(xai?.connectionMode).toBe("stateless");
    expect(xai?.capabilities.streaming).toBe(true);
  });

  it("mirrors every xAI model into the kernel registry", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const kernelModels = getHostServices().models.list();
    for (const expected of MODELS) {
      const registered = kernelModels.find((m) => m.id === expected.id);
      expect(registered, `model ${expected.id} should be registered`).toBeDefined();
      expect(registered?.providerId).toBe("xai");
      expect(registered?.adapterId).toBe("xai.default");
      expect(registered?.contextWindow).toBe(expected.contextWindow);
      expect(registered?.label).toBe(expected.name);
      if (expected.aliases) {
        expect(registered?.aliases).toEqual(expected.aliases);
      }
    }
  });

  it("resolves model aliases via getHostServices().models.get()", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    // grok-4-1-fast is a retired alias of the grok-4.3 flagship.
    const resolved = getHostServices().models.get("grok-4-1-fast");
    expect(resolved?.id).toBe("grok-4.6");
  });

  it("is protected and cannot be disabled", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const before = getHostServices().models.list().length;
    await disablePlugin("builtin.provider-xai");
    const extRecord = getRegistrySnapshot().extensions.find((e) => e.manifest.id === "builtin.provider-xai");
    expect(extRecord?.enabled).toBe(true);
    expect(getHostServices().models.list().length).toBe(before);
  });
});
