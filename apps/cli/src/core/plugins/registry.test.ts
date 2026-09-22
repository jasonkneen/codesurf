// Registry bookkeeping: what a removal must release so the same id can be
// claimed again, and what a whole-extension sweep must clear.

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetRegistryForTests,
  getRegistrySnapshot,
  registerPluginPromptSection,
  registerPluginSetting,
  unregisterExtensionContributions,
  unregisterPluginSetting,
} from "./registry";

afterEach(() => {
  __resetRegistryForTests();
});

describe("registry", () => {
  it("releases a setting key's claim when the setting is unregistered", () => {
    registerPluginSetting({ pluginId: "a", key: "shared.key", title: "A", type: "boolean", default: true });
    unregisterPluginSetting("a", "shared.key");

    // Another plugin can now own the key; the stale claim used to make this throw.
    expect(() =>
      registerPluginSetting({ pluginId: "b", key: "shared.key", title: "B", type: "boolean", default: false }),
    ).not.toThrow();
    expect(getRegistrySnapshot().settings.map((s) => [s.pluginId, s.key])).toEqual([["b", "shared.key"]]);
  });

  it("sweeps an extension's prompt sections with the rest of its contributions", () => {
    registerPluginPromptSection({ pluginId: "a", id: "guide", title: "Guide", body: "Use the tool.", order: 500 });
    registerPluginPromptSection({ pluginId: "b", id: "other", title: "Other", body: "Keep me.", order: 500 });

    unregisterExtensionContributions("a");

    expect(getRegistrySnapshot().promptSections.map((s) => s.id)).toEqual(["other"]);
  });
});
