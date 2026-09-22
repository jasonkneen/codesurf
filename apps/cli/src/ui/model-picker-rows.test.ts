import { describe, expect, it } from "vitest";
import type { RegisteredModel } from "../core/plugins";
import {
  advanceModelPickerIndex,
  buildModelPickerRows,
  currentModelPickerIndex,
  firstSelectableIndex,
  isCurrentModelPickerRow,
  selectableModelRows,
} from "./model-picker-rows";

function xai(id: string, overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    pluginId: "builtin.provider-xai",
    id,
    label: id,
    providerId: "xai",
    adapterId: "xai.default",
    ...overrides,
  };
}

function anthropic(id: string, overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    pluginId: "builtin.provider-anthropic",
    id,
    label: id,
    providerId: "anthropic",
    adapterId: "anthropic.api-key",
    ...overrides,
  };
}

// Logical provider metadata (one entry per logical providerId, not adapter).
const PROVIDERS = [
  { id: "xai", label: "xAI (Grok)" },
  { id: "anthropic", label: "Anthropic (API key)" },
];

describe("buildModelPickerRows", () => {
  it("collapses models behind provider groups by default", () => {
    const rows = buildModelPickerRows({
      kernelModels: [xai("grok-1"), xai("grok-2"), anthropic("claude-1")],
      providers: PROVIDERS,
      credentials: { "xai.default": true, "anthropic.api-key": true },
      query: "",
    });

    expect(rows.map((r) => (r.kind === "group" ? `#${r.label}` : r.id))).toEqual([
      "#xAI (Grok)",
      "#Anthropic (API key)",
    ]);
  });

  it("expands provider groups into model-family groups and concrete models", () => {
    const rows = buildModelPickerRows({
      kernelModels: [xai("grok-1"), xai("grok-2"), anthropic("claude-1")],
      providers: PROVIDERS,
      credentials: { "xai.default": true, "anthropic.api-key": true },
      expandedGroupIds: new Set(["provider:xai.default", "provider:xai.default:family:grok-1"]),
      query: "",
    });

    expect(rows.map((r) => [r.kind, r.kind === "group" ? r.label : r.id, r.depth])).toEqual([
      ["group", "xAI (Grok)", 0],
      ["group", "Grok 1", 1],
      ["model", "grok-1", 2],
      ["group", "Grok 2", 1],
      ["group", "Anthropic (API key)", 0],
    ]);
  });

  it("puts xAI first regardless of alphabetic order", () => {
    const rows = buildModelPickerRows({
      kernelModels: [anthropic("claude-1"), xai("grok-1")],
      providers: PROVIDERS,
      credentials: {},
      query: "",
    });
    expect(rows[0]?.kind === "group" && rows[0].providerId).toBe("xai");
  });

  it("filters across id, label, description, and providerId", () => {
    const rows = buildModelPickerRows({
      kernelModels: [
        xai("grok-code-fast-1", { label: "Grok Code Fast 1" }),
        xai("grok-4-1-fast-reasoning", { label: "Grok 4.1 Fast Reasoning" }),
        anthropic("claude-sonnet-4-5", {
          label: "Claude Sonnet 4.5",
          description: "Balanced cost/performance",
        }),
      ],
      providers: PROVIDERS,
      credentials: {},
      query: "sonnet",
    });
    const ids = selectableModelRows(rows).map((r) => r.id);
    expect(ids).toEqual(["claude-sonnet-4-5"]);
  });

  it("reports credentialsReady based on the adapter credentials map", () => {
    const rows = buildModelPickerRows({
      kernelModels: [xai("grok-1"), anthropic("claude-1")],
      providers: PROVIDERS,
      credentials: { "xai.default": true, "anthropic.api-key": false },
      expandedGroupIds: new Set([
        "provider:xai.default",
        "provider:xai.default:family:grok-1",
        "provider:anthropic.api-key",
        "provider:anthropic.api-key:family:claude-1",
      ]),
      query: "",
    });
    const models = selectableModelRows(rows);
    expect(models.find((m) => m.id === "grok-1")?.credentialsReady).toBe(true);
    expect(models.find((m) => m.id === "claude-1")?.credentialsReady).toBe(false);
  });

  it("shows BOTH rows when the same model id is registered under different adapters", () => {
    const rows = buildModelPickerRows({
      kernelModels: [
        anthropic("claude-sonnet-4-5"),
        // An SDK adapter registering the same id.
        {
          pluginId: "builtin.provider-claude-agent",
          id: "claude-sonnet-4-5",
          label: "Claude Sonnet 4.5",
          providerId: "anthropic",
          adapterId: "anthropic.agent-sdk",
        },
      ],
      providers: PROVIDERS,
      adapters: [
        { id: "anthropic.api-key", label: "API key" },
        { id: "anthropic.agent-sdk", label: "Agent SDK" },
      ],
      credentials: { "anthropic.api-key": true, "anthropic.agent-sdk": true },
      query: "sonnet",
    });
    const models = selectableModelRows(rows);
    expect(models).toHaveLength(2);
    // Both rows carry an adapterLabel so the user can tell them apart.
    expect(new Set(models.map((m) => m.adapterLabel))).toEqual(new Set(["API key", "Agent SDK"]));
    // And both adapter ids are present.
    expect(new Set(models.map((m) => m.adapterId))).toEqual(new Set(["anthropic.api-key", "anthropic.agent-sdk"]));
  });

  it("marks only the selected adapter as current when duplicate model ids exist", () => {
    const rows = buildModelPickerRows({
      kernelModels: [
        anthropic("claude-haiku-4-5"),
        {
          pluginId: "builtin.provider-claude-agent",
          id: "claude-haiku-4-5",
          label: "Claude Haiku 4.5",
          providerId: "anthropic",
          adapterId: "anthropic.agent-sdk",
        },
      ],
      providers: PROVIDERS,
      adapters: [
        { id: "anthropic.api-key", label: "API key" },
        { id: "anthropic.agent-sdk", label: "Agent SDK" },
      ],
      credentials: { "anthropic.api-key": true, "anthropic.agent-sdk": true },
      selection: { modelId: "claude-haiku-4-5", adapterId: "anthropic.agent-sdk" },
      query: "",
    });
    const models = selectableModelRows(rows);
    const selection = { modelId: "claude-haiku-4-5", adapterId: "anthropic.agent-sdk" };

    expect(models.filter((row) => isCurrentModelPickerRow(row, selection)).map((row) => row.adapterId)).toEqual([
      "anthropic.agent-sdk",
    ]);
    expect(rows[currentModelPickerIndex(rows, selection)]).toMatchObject({
      kind: "model",
      id: "claude-haiku-4-5",
      adapterId: "anthropic.agent-sdk",
    });
  });

  it("omits adapterLabel when only one adapter exposes a given model id", () => {
    const rows = buildModelPickerRows({
      kernelModels: [anthropic("claude-haiku-4-5")],
      providers: PROVIDERS,
      adapters: [{ id: "anthropic.api-key", label: "API key" }],
      credentials: { "anthropic.api-key": true },
      query: "haiku",
    });
    const models = selectableModelRows(rows);
    expect(models).toHaveLength(1);
    expect(models[0]?.adapterLabel).toBeUndefined();
  });

  it("keeps Grok per-model reasoning effort support on xAI rows", () => {
    const rows = buildModelPickerRows({
      kernelModels: [xai("grok-3-mini", { label: "Grok 3 Mini" })],
      providers: PROVIDERS,
      credentials: { "xai.default": true },
      query: "mini",
    });
    const model = selectableModelRows(rows)[0];
    expect(model).toMatchObject({
      id: "grok-3-mini",
      supportedReasoningEfforts: ["low", "high"],
      reasoningEffortSettingKey: undefined,
    });
  });

  it("carries adapter-backed reasoning effort controls into provider model rows", () => {
    const rows = buildModelPickerRows({
      kernelModels: [
        anthropic("claude-sonnet-4-5", {
          pluginId: "builtin.provider-claude-agent",
          adapterId: "anthropic.agent-sdk",
          label: "Claude Sonnet 4.5",
          capabilities: { tools: true, images: true, reasoning: true },
        }),
      ],
      providers: PROVIDERS,
      adapters: [{ id: "anthropic.agent-sdk", label: "Agent SDK" }],
      credentials: { "anthropic.agent-sdk": true },
      reasoningEffortControls: [
        {
          adapterId: "anthropic.agent-sdk",
          settingKey: "anthropic.agent-sdk.effort",
          values: ["low", "medium", "high", "xhigh", "max"],
          currentValue: "medium",
          defaultValue: "high",
        },
      ],
      query: "sonnet",
    });
    const model = selectableModelRows(rows)[0];
    expect(model).toMatchObject({
      adapterId: "anthropic.agent-sdk",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      reasoningEffortSettingKey: "anthropic.agent-sdk.effort",
      reasoningEffortValue: "medium",
      reasoningEffortDefault: "high",
    });
  });

  it("attaches xAI ModelInfo to xAI rows only", () => {
    const rows = buildModelPickerRows({
      kernelModels: [xai("grok-code-fast-1"), anthropic("claude-sonnet-4-5")],
      providers: PROVIDERS,
      credentials: {},
      expandedGroupIds: new Set([
        "provider:xai.default",
        "provider:xai.default:family:grok-code-fast-1",
        "provider:anthropic.api-key",
        "provider:anthropic.api-key:family:claude-sonnet-4.5",
      ]),
      query: "",
    });
    const models = selectableModelRows(rows);
    const grok = models.find((m) => m.id === "grok-code-fast-1");
    const claude = models.find((m) => m.id === "claude-sonnet-4-5");
    // Unknown xAI alias returns undefined from getModelInfo, but real xAI ids do.
    expect(grok?.modelInfo).toBeDefined();
    expect(claude?.modelInfo).toBeUndefined();
  });

  it("carries adapter and capability metadata into model rows", () => {
    const rows = buildModelPickerRows({
      kernelModels: [
        anthropic("claude-sonnet-4-5", {
          label: "Claude Sonnet 4.5",
          capabilities: { tools: true, images: true, reasoning: true },
          contextWindow: 1_000_000,
        }),
      ],
      providers: PROVIDERS,
      adapters: [
        {
          id: "anthropic.api-key",
          label: "API key",
          transport: "sdk",
          connectionMode: "stateless",
          sessionStrategy: "per-turn",
          authMode: "api-key",
        },
      ],
      credentials: { "anthropic.api-key": true },
      expandedGroupIds: new Set(["provider:anthropic.api-key", "provider:anthropic.api-key:family:claude-sonnet-4.5"]),
      query: "",
    });
    const model = selectableModelRows(rows)[0];
    expect(model).toMatchObject({
      adapterTransport: "sdk",
      adapterConnectionMode: "stateless",
      adapterSessionStrategy: "per-turn",
      authMode: "api-key",
      contextWindow: 1_000_000,
      capabilities: { tools: true, images: true, reasoning: true },
    });
  });
});

describe("advanceModelPickerIndex", () => {
  const rows = buildModelPickerRows({
    kernelModels: [xai("grok-1"), xai("grok-2"), anthropic("claude-1"), anthropic("claude-2")],
    providers: PROVIDERS,
    credentials: {},
    expandedGroupIds: new Set(["provider:xai.default", "provider:xai.default:family:grok-1"]),
    query: "",
  });

  it("walks visible group and model rows when advancing down", () => {
    const first = firstSelectableIndex(rows);
    const next = advanceModelPickerIndex(rows, first, 1);
    expect(rows[first]).toMatchObject({ kind: "group", label: "xAI (Grok)" });
    expect(rows[next]).toMatchObject({ kind: "group", label: "Grok 1" });
  });

  it("walks visible group and model rows when advancing up", () => {
    const modelIndex = rows.findIndex((r) => r.kind === "model" && r.id === "grok-1");
    expect(modelIndex).toBeGreaterThan(0);
    const prev = advanceModelPickerIndex(rows, modelIndex, -1);
    expect(rows[prev]).toMatchObject({ kind: "group", label: "Grok 1" });
  });

  it("is a no-op when already at the end / beginning", () => {
    const first = firstSelectableIndex(rows);
    expect(advanceModelPickerIndex(rows, first, -5)).toBe(first);
    const last = rows.length - 1;
    expect(advanceModelPickerIndex(rows, last, 5)).toBe(last);
  });
});
