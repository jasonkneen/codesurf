// Row-building + filtering for the multi-provider model picker.
//
// Source of truth is the kernel registry (`kernelGetHostServices().models.list()`).
// xAI models retain their full `ModelInfo` (reasoning effort, capabilities, pricing)
// so the existing xAI-specific UI affordances keep working.

import type { RegisteredModel } from "../core/plugins";
import { getModelInfo, getSupportedReasoningEfforts } from "../grok/models";
import type { ModelInfo, ReasoningEffort } from "../types/index";

export interface ModelPickerModelRow {
  kind: "model";
  /** Canonical model id (normalized — what gets passed to Agent.setModel). */
  id: string;
  /** Display name. */
  name: string;
  /** Short description shown under the name. */
  description?: string;
  /** Logical provider id — e.g. "xai", "anthropic". */
  providerId: string;
  /** Human-readable provider label (logical, not adapter-specific). */
  providerLabel: string;
  /** Adapter id that owns this model (e.g. "xai.default", "anthropic.api-key"). */
  adapterId?: string;
  /** Hierarchical group ids used by the picker UI. */
  providerGroupId: string;
  familyGroupId: string;
  familyLabel: string;
  depth: number;
  /** Human-readable adapter label — shown as a sub-tag on the row when
   *  the same model id is reachable via multiple adapters. */
  adapterLabel?: string;
  adapterTransport?: string;
  adapterConnectionMode?: string;
  adapterSessionStrategy?: string;
  authMode?: string;
  /** true ⇒ the adapter's auth.check() reported ok. */
  credentialsReady: boolean;
  /** xAI-specific metadata, present only for xAI models. */
  modelInfo?: ModelInfo;
  /** Context window (for display). */
  contextWindow?: number;
  capabilities?: RegisteredModel["capabilities"];
  /** Values shown/cycled by left/right in the model picker. */
  supportedReasoningEfforts: string[];
  /** Adapter setting to update for provider-owned effort controls. Undefined means use per-model user settings. */
  reasoningEffortSettingKey?: string;
  reasoningEffortValue?: string;
  reasoningEffortDefault?: string;
}

export interface ModelPickerGroupRow {
  kind: "group";
  groupType: "provider" | "family";
  groupId: string;
  providerId: string;
  adapterId?: string;
  parentGroupId?: string;
  label: string;
  count: number;
  depth: number;
  expanded: boolean;
}

export type ModelPickerRow = ModelPickerGroupRow | ModelPickerModelRow;

export interface FlatModelPickerHeaderRow {
  kind: "header";
  label: string;
  providerId: string;
}

export type FlatModelPickerRow = FlatModelPickerHeaderRow | ModelPickerModelRow;

export interface ModelPickerSelection {
  modelId: string;
  adapterId?: string | null;
}

export interface ProviderMeta {
  /** Logical providerId (e.g. "xai", "anthropic", "openai") — not the adapter id. */
  id: string;
  label: string;
}

export interface BuildModelPickerRowsInput {
  kernelModels: readonly RegisteredModel[];
  /** Logical provider metadata, one entry per providerId. */
  providers: readonly ProviderMeta[];
  /** Optional adapter-level metadata: map adapterId → human label. When
   *  provided, rows whose model id is reachable via multiple adapters show
   *  the adapter label as a sub-tag so users can pick which path to use. */
  adapters?: ReadonlyArray<{
    id: string;
    label: string;
    transport?: string;
    connectionMode?: string;
    sessionStrategy?: string;
    authMode?: string;
  }>;
  credentials: Record<string, boolean>;
  reasoningEffortControls?: ReadonlyArray<{
    adapterId: string;
    settingKey: string;
    values: readonly string[];
    currentValue?: string;
    defaultValue?: string;
  }>;
  query: string;
  expandedGroupIds?: ReadonlySet<string>;
  selection?: ModelPickerSelection;
}

function providerLabel(providerId: string, providers: readonly ProviderMeta[]): string {
  return providers.find((p) => p.id === providerId)?.label ?? titleCase(providerId);
}

function adapterLabelFor(adapterId: string | undefined, adapterLabels: Map<string, string>): string | undefined {
  if (!adapterId) return undefined;
  return adapterLabels.get(adapterId);
}

function providerGroupId(raw: RegisteredModel): string {
  return `provider:${raw.adapterId ?? raw.providerId}`;
}

function providerGroupLabel(
  raw: RegisteredModel,
  providers: readonly ProviderMeta[],
  adapterLabels: Map<string, string>,
): string {
  const adapterLabel = adapterLabelFor(raw.adapterId, adapterLabels);
  const label = adapterLabel ?? providerLabel(raw.providerId, providers);
  if (raw.providerId === "openai" && /\bcodex\b/i.test(label)) {
    const clean = label.replace(/\s*\(app-server\)\s*$/i, "").trim();
    return /^openai\b/i.test(clean) ? clean : `OpenAI ${clean}`;
  }
  return label;
}

function titleCase(text: string): string {
  return text
    .split(/[-_.]/)
    .map((part) => (part ? part[0]?.toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

function providerSortKey(providerId: string): [number, string] {
  // xAI first (grok is the default), then alphabetical.
  if (providerId === "xai") return [0, providerId];
  return [1, providerId];
}

function modelFamily(raw: Pick<RegisteredModel, "id" | "label">): { key: string; label: string } {
  const text = `${raw.label} ${raw.id}`.replace(/[_/-]+/g, " ");

  const gpt = text.match(/\bgpt\s*(\d+(?:\.\d+)?)(?:\s+(codex))?/i);
  if (gpt) {
    const label = `GPT ${gpt[1]}${gpt[2] ? " Codex" : ""}`;
    return { key: label.toLowerCase().replace(/\s+/g, "-"), label };
  }

  const claude = text.match(/\bclaude\s+(fable|opus|sonnet|haiku)\s+(\d+(?:\.\d+)?)/i);
  if (claude) {
    const tier = titleCase(claude[1] ?? "");
    const label = `Claude ${tier} ${claude[2]}`;
    return { key: label.toLowerCase().replace(/\s+/g, "-"), label };
  }

  const grok = text.match(/\bgrok\s+(\d+(?:\.\d+)?)/i);
  if (grok) {
    const label = `Grok ${grok[1]}`;
    return { key: label.toLowerCase().replace(/\s+/g, "-"), label };
  }

  const fallback = raw.label || raw.id;
  return {
    key: fallback
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    label: fallback,
  };
}

function rowMatches(row: ModelPickerModelRow, query: string): boolean {
  return (
    row.id.toLowerCase().includes(query) ||
    row.name.toLowerCase().includes(query) ||
    (row.description?.toLowerCase().includes(query) ?? false) ||
    row.providerId.toLowerCase().includes(query) ||
    row.providerLabel.toLowerCase().includes(query) ||
    row.familyLabel.toLowerCase().includes(query) ||
    (row.adapterId?.toLowerCase().includes(query) ?? false) ||
    (row.adapterLabel?.toLowerCase().includes(query) ?? false)
  );
}

interface BuildModelRowsInput {
  kernelModels: readonly RegisteredModel[];
  providers: readonly ProviderMeta[];
  adapters?: BuildModelPickerRowsInput["adapters"];
  credentials: Record<string, boolean>;
  reasoningEffortControls?: BuildModelPickerRowsInput["reasoningEffortControls"];
}

function buildModelRows(input: BuildModelRowsInput): ModelPickerModelRow[] {
  const { kernelModels, providers, adapters, credentials, reasoningEffortControls } = input;

  const adapterLabels = new Map<string, string>();
  const adapterMeta = new Map<string, NonNullable<BuildModelPickerRowsInput["adapters"]>[number]>();
  for (const entry of adapters ?? []) {
    adapterLabels.set(entry.id, entry.label);
    adapterMeta.set(entry.id, entry);
  }
  const effortControlByAdapter = new Map((reasoningEffortControls ?? []).map((entry) => [entry.adapterId, entry]));

  const adapterCountByModel = new Map<string, number>();
  for (const raw of kernelModels) {
    const key = `${raw.providerId}::${raw.id}`;
    adapterCountByModel.set(key, (adapterCountByModel.get(key) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const models: ModelPickerModelRow[] = [];
  for (const raw of kernelModels) {
    const dedupKey = `${raw.adapterId ?? ""}::${raw.id}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const xaiInfo = raw.providerId === "xai" ? getModelInfo(raw.id) : undefined;
    const ambiguous = (adapterCountByModel.get(`${raw.providerId}::${raw.id}`) ?? 0) > 1;
    const meta = raw.adapterId ? adapterMeta.get(raw.adapterId) : undefined;
    const providerGroup = providerGroupId(raw);
    const family = modelFamily(raw);
    const capabilities =
      raw.capabilities ??
      (xaiInfo
        ? {
            tools: true,
            images: true,
            reasoning: xaiInfo.reasoning,
          }
        : undefined);
    const xaiEfforts: ReasoningEffort[] = raw.providerId === "xai" ? getSupportedReasoningEfforts(raw.id) : [];
    const adapterEffortControl = raw.adapterId ? effortControlByAdapter.get(raw.adapterId) : undefined;
    const supportedReasoningEfforts =
      xaiEfforts.length > 0
        ? xaiEfforts
        : capabilities?.reasoning && adapterEffortControl
          ? [...adapterEffortControl.values]
          : [];
    models.push({
      kind: "model",
      id: raw.id,
      name: raw.label,
      description: raw.description,
      providerId: raw.providerId,
      providerLabel: providerGroupLabel(raw, providers, adapterLabels),
      adapterId: raw.adapterId,
      providerGroupId: providerGroup,
      familyGroupId: `${providerGroup}:family:${family.key}`,
      familyLabel: family.label,
      depth: 2,
      adapterLabel: ambiguous ? adapterLabelFor(raw.adapterId, adapterLabels) : undefined,
      adapterTransport: meta?.transport,
      adapterConnectionMode: meta?.connectionMode,
      adapterSessionStrategy: meta?.sessionStrategy,
      authMode: meta?.authMode,
      credentialsReady: credentials[raw.adapterId ?? ""] === true,
      modelInfo: xaiInfo,
      contextWindow: raw.contextWindow ?? xaiInfo?.contextWindow,
      capabilities,
      supportedReasoningEfforts,
      reasoningEffortSettingKey: xaiEfforts.length === 0 ? adapterEffortControl?.settingKey : undefined,
      reasoningEffortValue: xaiEfforts.length === 0 ? adapterEffortControl?.currentValue : undefined,
      reasoningEffortDefault: xaiEfforts.length === 0 ? adapterEffortControl?.defaultValue : undefined,
    });
  }

  models.sort((a, b) => {
    const [ap, an] = providerSortKey(a.providerId);
    const [bp, bn] = providerSortKey(b.providerId);
    if (ap !== bp) return ap - bp;
    if (an !== bn) return an.localeCompare(bn);
    if (a.providerLabel !== b.providerLabel) return a.providerLabel.localeCompare(b.providerLabel);
    if (a.familyLabel !== b.familyLabel) return a.familyLabel.localeCompare(b.familyLabel);
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    return (a.adapterLabel ?? "").localeCompare(b.adapterLabel ?? "");
  });

  return models;
}

export function buildModelPickerRows(input: BuildModelPickerRowsInput): ModelPickerRow[] {
  const { query, expandedGroupIds = new Set(), selection } = input;
  const q = query.trim().toLowerCase();

  const models = buildModelRows(input);

  const selected = selection
    ? models.find(
        (row) => row.id === selection.modelId && (selection.adapterId ? row.adapterId === selection.adapterId : true),
      )
    : undefined;

  // 3. Insert expandable provider and model-family groups.
  const rows: ModelPickerRow[] = [];
  const providerGroups = new Map<string, ModelPickerModelRow[]>();
  for (const row of models) {
    const list = providerGroups.get(row.providerGroupId) ?? [];
    list.push(row);
    providerGroups.set(row.providerGroupId, list);
  }

  for (const providerRows of providerGroups.values()) {
    const first = providerRows[0];
    if (!first) continue;
    const providerMatches = q
      ? first.providerLabel.toLowerCase().includes(q) ||
        first.providerId.toLowerCase().includes(q) ||
        (first.adapterId?.toLowerCase().includes(q) ?? false)
      : false;
    const providerFiltered = q && !providerMatches ? providerRows.filter((row) => rowMatches(row, q)) : providerRows;
    if (q && providerFiltered.length === 0) continue;

    const providerExpanded =
      q.length > 0 ||
      expandedGroupIds.has(first.providerGroupId) ||
      selected?.providerGroupId === first.providerGroupId;
    rows.push({
      kind: "group",
      groupType: "provider",
      groupId: first.providerGroupId,
      providerId: first.providerId,
      adapterId: first.adapterId,
      label: first.providerLabel,
      count: providerFiltered.length,
      depth: 0,
      expanded: providerExpanded,
    });
    if (!providerExpanded) continue;

    const familyGroups = new Map<string, ModelPickerModelRow[]>();
    for (const row of providerFiltered) {
      const list = familyGroups.get(row.familyGroupId) ?? [];
      list.push(row);
      familyGroups.set(row.familyGroupId, list);
    }

    for (const familyRowsAll of familyGroups.values()) {
      const familyFirst = familyRowsAll[0];
      if (!familyFirst) continue;
      const familyMatches = q ? familyFirst.familyLabel.toLowerCase().includes(q) : false;
      const familyRows =
        q && !providerMatches && !familyMatches ? familyRowsAll.filter((row) => rowMatches(row, q)) : familyRowsAll;
      if (q && familyRows.length === 0) continue;

      const familyExpanded =
        q.length > 0 ||
        expandedGroupIds.has(familyFirst.familyGroupId) ||
        selected?.familyGroupId === familyFirst.familyGroupId;
      rows.push({
        kind: "group",
        groupType: "family",
        groupId: familyFirst.familyGroupId,
        parentGroupId: familyFirst.providerGroupId,
        providerId: familyFirst.providerId,
        adapterId: familyFirst.adapterId,
        label: familyFirst.familyLabel,
        count: familyRows.length,
        depth: 1,
        expanded: familyExpanded,
      });
      if (familyExpanded) rows.push(...familyRows);
    }
  }

  return rows;
}

/** Extract only the selectable (model) rows — for navigation. */
export function selectableModelRows(rows: readonly ModelPickerRow[]): ModelPickerModelRow[] {
  return rows.filter((row): row is ModelPickerModelRow => row.kind === "model");
}

export function modelPickerRowKey(row: ModelPickerRow, idx = 0): string {
  return row.kind === "group" ? `${row.groupType}-${row.groupId}-${idx}` : `${row.adapterId ?? ""}-${row.id}`;
}

export function isCurrentModelPickerRow(row: ModelPickerRow, selection: ModelPickerSelection): boolean {
  if (row.kind !== "model") return false;
  if (row.id !== selection.modelId) return false;
  return selection.adapterId ? row.adapterId === selection.adapterId : true;
}

export function currentModelPickerIndex(rows: readonly ModelPickerRow[], selection: ModelPickerSelection): number {
  const exact = rows.findIndex((row) => isCurrentModelPickerRow(row, selection));
  if (exact >= 0) return exact;
  return firstSelectableIndex(rows);
}

/** Given a current index into the visible row list, advance by `delta`. */
export function advanceModelPickerIndex(rows: readonly ModelPickerRow[], currentIndex: number, delta: number): number {
  if (rows.length === 0) return 0;
  const step = delta > 0 ? 1 : -1;
  const steps = Math.abs(delta);
  let idx = currentIndex;
  for (let i = 0; i < steps; i++) {
    const next = idx + step;
    if (next < 0 || next >= rows.length) break;
    idx = next;
  }
  return idx;
}

/** Return the first visible row index, or 0. */
export function firstSelectableIndex(_rows: readonly ModelPickerRow[]): number {
  return 0;
}

// ── Flat row builder (no expand/collapse) ──────────────────────────────

export function buildFlatModelRows(input: BuildModelRowsInput & { query: string }): FlatModelPickerRow[] {
  const models = buildModelRows(input);
  const q = input.query.trim().toLowerCase();
  const filtered = q ? models.filter((row) => rowMatches(row, q)) : models;

  const rows: FlatModelPickerRow[] = [];
  let currentGroupId: string | null = null;
  for (const row of filtered) {
    if (row.providerGroupId !== currentGroupId) {
      currentGroupId = row.providerGroupId;
      rows.push({
        kind: "header",
        label: row.providerLabel.toUpperCase(),
        providerId: row.providerId,
      });
    }
    rows.push(row);
  }
  return rows;
}

export function flatModelPickerRowKey(row: FlatModelPickerRow, idx = 0): string {
  return row.kind === "header" ? `header-${row.label}-${idx}` : `${row.adapterId ?? ""}-${row.id}`;
}

export function isCurrentFlatModelRow(row: FlatModelPickerRow, selection: ModelPickerSelection): boolean {
  if (row.kind !== "model") return false;
  if (row.id !== selection.modelId) return false;
  return selection.adapterId ? row.adapterId === selection.adapterId : true;
}

export function currentFlatModelIndex(rows: readonly FlatModelPickerRow[], selection: ModelPickerSelection): number {
  const exact = rows.findIndex((row) => isCurrentFlatModelRow(row, selection));
  if (exact >= 0) return exact;
  const firstModel = rows.findIndex((row) => row.kind === "model");
  return firstModel >= 0 ? firstModel : 0;
}

/** Skip header rows when navigating. Returns the next model row index in the
 *  given direction, or the current index if there are no more model rows. */
export function nextFlatModelRowIndex(
  rows: readonly FlatModelPickerRow[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  let idx = currentIndex;
  while (true) {
    idx += direction;
    if (idx < 0 || idx >= rows.length) return currentIndex;
    if (rows[idx].kind === "model") return idx;
  }
}
