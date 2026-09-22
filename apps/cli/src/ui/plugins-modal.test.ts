import { describe, expect, it } from "vitest";
import type { PluginListEntry } from "../core/plugins";
import { buildExtensionsRows } from "./plugins-modal";

function fake(id: string, overrides: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    id,
    title: id,
    description: `${id} description`,
    source: "builtin",
    enabled: true,
    active: true,
    protected: false,
    hidden: false,
    commands: 0,
    tools: 0,
    models: 0,
    ...overrides,
  };
}

describe("buildExtensionsRows", () => {
  it("returns every visible extension when the query is empty", () => {
    const rows = buildExtensionsRows([fake("a"), fake("b"), fake("c")], "");
    expect(rows.map((row) => row.extension.id)).toEqual(["a", "b", "c"]);
  });

  it("omits hidden extensions regardless of query", () => {
    const rows = buildExtensionsRows([fake("a"), fake("b", { hidden: true }), fake("c")], "");
    expect(rows.map((row) => row.extension.id)).toEqual(["a", "c"]);
  });

  it("filters by id, title, and description (case-insensitive)", () => {
    const list = [
      fake("builtin.tools.bash", { title: "Bash & Processes" }),
      fake("builtin.tools.computer", { title: "Computer Use" }),
      fake("builtin.tools.media", {
        title: "Media Generation",
        description: "Generate images and videos",
      }),
    ];
    expect(buildExtensionsRows(list, "bash").map((r) => r.extension.id)).toEqual([
      "codesurf.tools",
      "builtin.tools.bash",
    ]);
    expect(buildExtensionsRows(list, "COMPUTER").map((r) => r.extension.id)).toEqual([
      "codesurf.tools",
      "builtin.tools.computer",
    ]);
    expect(buildExtensionsRows(list, "videos").map((r) => r.extension.id)).toEqual([
      "codesurf.tools",
      "builtin.tools.media",
    ]);
  });

  it("trims whitespace from the query", () => {
    const rows = buildExtensionsRows([fake("a"), fake("b")], "   a   ");
    expect(rows.map((row) => row.extension.id)).toEqual(["a"]);
  });

  it("orders protected extensions first, then enabled, then disabled (stable within groups)", () => {
    const list = [
      fake("disabled-a", { enabled: false }),
      fake("enabled-a", { enabled: true }),
      fake("protected-a", { enabled: true, protected: true }),
      fake("disabled-b", { enabled: false }),
      fake("enabled-b", { enabled: true }),
      fake("protected-b", { enabled: true, protected: true }),
    ];
    const rows = buildExtensionsRows(list, "");
    expect(rows.map((row) => row.extension.id)).toEqual([
      "protected-a",
      "protected-b",
      "enabled-a",
      "enabled-b",
      "disabled-a",
      "disabled-b",
    ]);
  });

  it("treats protected extensions as first regardless of enabled state", () => {
    const list = [fake("enabled", { enabled: true }), fake("protected-disabled", { enabled: false, protected: true })];
    const rows = buildExtensionsRows(list, "");
    expect(rows.map((row) => row.extension.id)).toEqual(["protected-disabled", "enabled"]);
  });

  it("applies sort after the search filter", () => {
    const list = [
      fake("alpha-disabled", { title: "alpha", enabled: false }),
      fake("alpha-enabled", { title: "alpha", enabled: true }),
      fake("beta", { title: "beta", enabled: true }),
    ];
    const rows = buildExtensionsRows(list, "alpha");
    expect(rows.map((row) => row.extension.id)).toEqual(["alpha-enabled", "alpha-disabled"]);
  });

  it("collapses grouped extensions behind a synthetic group row", () => {
    const group = { id: "codesurf.providers", name: "CodeSurf Providers", description: "Model providers." };
    const rows = buildExtensionsRows(
      [
        fake("builtin.provider-xai", { title: "xAI", group }),
        fake("builtin.provider-anthropic", { title: "Anthropic", group, enabled: false }),
        fake("test.tools.bash", { title: "Bash", source: "user" }),
      ],
      "",
    );

    expect(rows.map((row) => [row.kind, row.extension.id])).toEqual([
      ["extension", "test.tools.bash"],
      ["group", "codesurf.providers"],
    ]);
    const providerGroup = rows.find((row) => row.kind === "group");
    expect(providerGroup?.members?.map((ext) => ext.id)).toEqual([
      "builtin.provider-xai",
      "builtin.provider-anthropic",
    ]);
    expect(providerGroup?.extension.enabled).toBe(false);
  });

  it("expands grouped extensions when the group id is expanded", () => {
    const group = { id: "codesurf.providers", name: "CodeSurf Providers" };
    const rows = buildExtensionsRows(
      [
        fake("builtin.provider-xai", { title: "xAI", group }),
        fake("builtin.provider-anthropic", { title: "Anthropic", group }),
      ],
      "",
      new Set(["codesurf.providers"]),
    );

    expect(rows.map((row) => [row.kind, row.extension.id, row.depth])).toEqual([
      ["group", "codesurf.providers", 0],
      ["extension", "builtin.provider-xai", 1],
      ["extension", "builtin.provider-anthropic", 1],
    ]);
  });

  it("auto-expands matching grouped children during search", () => {
    const group = { id: "codesurf.providers", name: "CodeSurf Providers" };
    const rows = buildExtensionsRows(
      [
        fake("builtin.provider-xai", { title: "xAI", group }),
        fake("builtin.provider-anthropic", { title: "Anthropic", group }),
      ],
      "anthropic",
    );

    expect(rows.map((row) => [row.kind, row.extension.id])).toEqual([
      ["group", "codesurf.providers"],
      ["extension", "builtin.provider-anthropic"],
    ]);
  });

  it("infers logical groups for built-in extensions without manifest groups", () => {
    const rows = buildExtensionsRows(
      [
        fake("builtin.tools.bash", { title: "Bash", tools: 4 }),
        fake("builtin.tools.computer", { title: "Computer Use", tools: 2 }),
        fake("custom.extension", { title: "Custom extension", source: "user" }),
      ],
      "",
    );

    expect(rows.map((row) => [row.kind, row.extension.id, row.depth])).toEqual([
      ["extension", "custom.extension", 0],
      ["group", "codesurf.tools", 0],
    ]);
    expect(rows.find((row) => row.kind === "group")?.members?.map((ext) => ext.id)).toEqual([
      "builtin.tools.bash",
      "builtin.tools.computer",
    ]);
  });
});
