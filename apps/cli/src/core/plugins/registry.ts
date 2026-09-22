// Extension registry — module-level stores keyed by pluginId.
//
// Deliberately not using React context. Consumers subscribe via the
// explicit `subscribe()` API or the `useRegistrySnapshot()` hook. This
// mirrors codesurf's existing store patterns and avoids re-render cascades.

import { useSyncExternalStore } from "react";
import type {
  PluginLifecycleStatus,
  RegisteredCommand,
  RegisteredModel,
  RegisteredModelProvider,
  RegisteredScreen,
  RegisteredSetting,
  RegisteredStatusIndicator,
  RegisteredTool,
} from "./api";
import type { HostManifest } from "./manifest";

export interface RuntimePluginRecord {
  manifest: HostManifest;
  enabled: boolean;
  active: boolean;
  status: PluginLifecycleStatus;
  error?: string;
}

/**
 * A block of guidance a plugin contributes to the system prompt.
 *
 * Registering a tool tells the MODEL the tool exists; it does not tell it when
 * to prefer that tool, or that a plugin is installed at all. This is how a
 * plugin says so in its own words.
 */
export interface RegisteredPromptSection {
  pluginId: string;
  id: string;
  title: string;
  body: string;
  order: number;
}

export interface RegistrySnapshot {
  extensions: RuntimePluginRecord[];
  commands: RegisteredCommand[];
  tools: RegisteredTool[];
  settings: RegisteredSetting[];
  modelProviders: RegisteredModelProvider[];
  models: RegisteredModel[];
  screens: RegisteredScreen[];
  statusIndicators: RegisteredStatusIndicator[];
  promptSections: RegisteredPromptSection[];
}

const extensionRecords = new Map<string, RuntimePluginRecord>();
const commands = new Map<string, RegisteredCommand[]>();
const tools = new Map<string, RegisteredTool[]>();
const settings = new Map<string, RegisteredSetting[]>();
const modelProviders = new Map<string, RegisteredModelProvider[]>();
const models = new Map<string, RegisteredModel[]>();
const screens = new Map<string, RegisteredScreen[]>();
const promptSections = new Map<string, RegisteredPromptSection[]>();
const statusIndicators = new Map<string, RegisteredStatusIndicator[]>();
const subscribers = new Set<() => void>();

// Canonical contribution IDs that the host resolves without an extension
// namespace must be globally owned. Models intentionally do not appear here:
// the same model id may be offered by multiple provider adapters and is
// resolved with adapter identity at runtime.
type UniqueContributionKind = "command" | "tool" | "setting" | "model provider" | "screen";
const uniqueContributionOwners: Record<UniqueContributionKind, Map<string, string>> = {
  command: new Map(),
  tool: new Map(),
  setting: new Map(),
  "model provider": new Map(),
  screen: new Map(),
};

interface CommandIdentifierOwner {
  pluginId: string;
  commandName: string;
}

// Commands resolve both canonical names and aliases from a shared namespace.
// Track the owning canonical command so re-registering one command can safely
// replace its aliases without letting another command (even from the same
// extension) shadow them.
const commandIdentifierOwners = new Map<string, CommandIdentifierOwner>();

let snapshot: RegistrySnapshot = emptySnapshot();

function emptySnapshot(): RegistrySnapshot {
  return {
    extensions: [],
    commands: [],
    tools: [],
    settings: [],
    modelProviders: [],
    models: [],
    screens: [],
    promptSections: [],
    statusIndicators: [],
  };
}

function flatten<T>(source: Map<string, T[]>): T[] {
  return Array.from(source.values()).flat();
}

function upsertBy<T>(items: T[], nextItem: T, match: (item: T) => boolean): T[] {
  const index = items.findIndex(match);
  if (index === -1) return [...items, nextItem];
  return items.map((item, i) => (i === index ? nextItem : item));
}

function claimUniqueContribution(kind: UniqueContributionKind, id: string, pluginId: string): void {
  const owners = uniqueContributionOwners[kind];
  const existingOwner = owners.get(id);
  if (existingOwner && existingOwner !== pluginId) {
    throw new Error(
      `Extension ${pluginId} cannot register ${kind} "${id}": it is already registered by ${existingOwner}.`,
    );
  }
  owners.set(id, pluginId);
}

function releaseUniqueContributionClaims(pluginId: string): void {
  for (const owners of Object.values(uniqueContributionOwners)) {
    for (const [id, owner] of owners) {
      if (owner === pluginId) owners.delete(id);
    }
  }
  for (const [identifier, owner] of commandIdentifierOwners) {
    if (owner.pluginId === pluginId) commandIdentifierOwners.delete(identifier);
  }
}

/** Drop the name/alias claims held by one command of one extension. */
function releaseCommandIdentifiers(pluginId: string, commandName: string): void {
  for (const [identifier, owner] of commandIdentifierOwners) {
    if (owner.pluginId === pluginId && owner.commandName === commandName) {
      commandIdentifierOwners.delete(identifier);
    }
  }
}

function claimCommandIdentifiers(command: RegisteredCommand): void {
  const identifiers = new Set([command.name, ...(command.aliases ?? [])]);
  for (const identifier of identifiers) {
    const existing = commandIdentifierOwners.get(identifier);
    if (existing && (existing.pluginId !== command.pluginId || existing.commandName !== command.name)) {
      throw new Error(
        `Extension ${command.pluginId} cannot register command identifier "${identifier}": it is already registered by ${existing.pluginId}.`,
      );
    }
  }

  for (const [identifier, owner] of commandIdentifierOwners) {
    if (owner.pluginId === command.pluginId && owner.commandName === command.name) {
      commandIdentifierOwners.delete(identifier);
    }
  }
  for (const identifier of identifiers) {
    commandIdentifierOwners.set(identifier, { pluginId: command.pluginId, commandName: command.name });
  }
}

function rebuildSnapshot() {
  snapshot = {
    extensions: Array.from(extensionRecords.values()).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
    commands: flatten(commands).sort((a, b) => a.name.localeCompare(b.name)),
    tools: flatten(tools).sort((a, b) => a.name.localeCompare(b.name) || a.pluginId.localeCompare(b.pluginId)),
    settings: flatten(settings).sort((a, b) => a.key.localeCompare(b.key)),
    modelProviders: flatten(modelProviders).sort((a, b) => a.label.localeCompare(b.label)),
    models: flatten(models).sort((a, b) => a.label.localeCompare(b.label)),
    // Screens deliberately preserve registration order — overlays should mount
    // in the order extensions registered them.
    screens: flatten(screens),
    // Deterministic order so the prompt prefix is byte-stable across turns.
    promptSections: flatten(promptSections).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    // Status indicators preserve registration order — left-to-right footer layout.
    statusIndicators: flatten(statusIndicators),
  };
  for (const callback of subscribers) callback();
}

export function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function getRegistrySnapshot(): RegistrySnapshot {
  return snapshot;
}

// ── Extension records ─────────────────────────────────────────────────────────

export function registerPluginRecord(record: RuntimePluginRecord) {
  extensionRecords.set(record.manifest.id, record);
  rebuildSnapshot();
}

export function updatePluginRecord(id: string, patch: Partial<Omit<RuntimePluginRecord, "manifest">>) {
  const existing = extensionRecords.get(id);
  if (!existing) return;
  extensionRecords.set(id, { ...existing, ...patch });
  rebuildSnapshot();
}

export function getPluginRecord(id: string): RuntimePluginRecord | undefined {
  return extensionRecords.get(id);
}

// ── Contributions ─────────────────────────────────────────────────────────────

export function registerPluginCommand(command: RegisteredCommand) {
  claimCommandIdentifiers(command);
  claimUniqueContribution("command", command.name, command.pluginId);
  commands.set(
    command.pluginId,
    upsertBy(commands.get(command.pluginId) ?? [], command, (item) => item.name === command.name),
  );
  rebuildSnapshot();
}

export function registerPluginTool(tool: RegisteredTool) {
  claimUniqueContribution("tool", tool.name, tool.pluginId);
  tools.set(
    tool.pluginId,
    upsertBy(tools.get(tool.pluginId) ?? [], tool, (item) => item.name === tool.name),
  );
  rebuildSnapshot();
}

export function registerPluginPromptSection(section: RegisteredPromptSection) {
  promptSections.set(
    section.pluginId,
    upsertBy(promptSections.get(section.pluginId) ?? [], section, (item) => item.id === section.id),
  );
  rebuildSnapshot();
}

export function unregisterPluginPromptSection(pluginId: string, id: string) {
  const list = promptSections.get(pluginId);
  if (!list) return;
  const next = list.filter((item) => item.id !== id);
  if (next.length === 0) promptSections.delete(pluginId);
  else promptSections.set(pluginId, next);
  rebuildSnapshot();
}

export function registerPluginSetting(setting: RegisteredSetting) {
  claimUniqueContribution("setting", setting.key, setting.pluginId);
  settings.set(
    setting.pluginId,
    upsertBy(settings.get(setting.pluginId) ?? [], setting, (item) => item.key === setting.key),
  );
  rebuildSnapshot();
}

export function registerPluginModelProvider(provider: RegisteredModelProvider) {
  claimUniqueContribution("model provider", provider.id, provider.pluginId);
  modelProviders.set(
    provider.pluginId,
    upsertBy(modelProviders.get(provider.pluginId) ?? [], provider, (item) => item.id === provider.id),
  );
  rebuildSnapshot();
}

export function registerPluginModel(model: RegisteredModel) {
  models.set(
    model.pluginId,
    upsertBy(models.get(model.pluginId) ?? [], model, (item) => item.id === model.id),
  );
  rebuildSnapshot();
}

export function registerPluginScreen(screen: RegisteredScreen) {
  claimUniqueContribution("screen", screen.id, screen.pluginId);
  screens.set(
    screen.pluginId,
    upsertBy(screens.get(screen.pluginId) ?? [], screen, (item) => item.id === screen.id),
  );
  rebuildSnapshot();
}

export function registerPluginStatusIndicator(indicator: RegisteredStatusIndicator) {
  statusIndicators.set(
    indicator.pluginId,
    upsertBy(statusIndicators.get(indicator.pluginId) ?? [], indicator, (item) => item.id === indicator.id),
  );
  rebuildSnapshot();
}

/**
 * Remove one command contributed by an extension.
 *
 * Native plugins own each registration through its own `ctx.effect` disposer,
 * so a plugin that contributes several commands must be able to drop exactly
 * one of them; `unregisterExtensionContributions` (which sweeps the whole
 * extension) is too blunt for that.
 */
export function unregisterPluginCommand(pluginId: string, name: string) {
  const list = commands.get(pluginId);
  if (!list) return;
  const next = list.filter((item) => item.name !== name);
  if (next.length === list.length) return;
  if (next.length === 0) commands.delete(pluginId);
  else commands.set(pluginId, next);
  releaseCommandIdentifiers(pluginId, name);
  uniqueContributionOwners.command.delete(name);
  rebuildSnapshot();
}

/** Remove one tool contributed by an extension. See `unregisterPluginCommand`. */
export function unregisterPluginTool(pluginId: string, name: string) {
  const list = tools.get(pluginId);
  if (!list) return;
  const next = list.filter((item) => item.name !== name);
  if (next.length === list.length) return;
  if (next.length === 0) tools.delete(pluginId);
  else tools.set(pluginId, next);
  uniqueContributionOwners.tool.delete(name);
  rebuildSnapshot();
}

/** Remove one setting contributed by an extension. See `unregisterPluginCommand`. */
export function unregisterPluginSetting(pluginId: string, key: string) {
  const list = settings.get(pluginId);
  if (!list) return;
  const next = list.filter((item) => item.key !== key);
  if (next.length === list.length) return;
  if (next.length === 0) settings.delete(pluginId);
  else settings.set(pluginId, next);
  uniqueContributionOwners.setting.delete(key);
  rebuildSnapshot();
}

/** Remove one screen contributed by an extension. */
export function unregisterPluginScreen(pluginId: string, id: string) {
  const list = screens.get(pluginId);
  if (!list) return;
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) return;
  if (next.length === 0) screens.delete(pluginId);
  else screens.set(pluginId, next);
  uniqueContributionOwners.screen.delete(id);
  rebuildSnapshot();
}

/** Remove one model provider contributed by an extension. */
export function unregisterPluginModelProvider(pluginId: string, id: string) {
  const list = modelProviders.get(pluginId);
  if (!list) return;
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) return;
  if (next.length === 0) modelProviders.delete(pluginId);
  else modelProviders.set(pluginId, next);
  uniqueContributionOwners["model provider"].delete(id);
  rebuildSnapshot();
}

/** Remove one model contributed by an extension. */
export function unregisterPluginModel(pluginId: string, id: string) {
  const list = models.get(pluginId);
  if (!list) return;
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) return;
  if (next.length === 0) models.delete(pluginId);
  else models.set(pluginId, next);
  rebuildSnapshot();
}

export function unregisterExtensionStatusIndicator(pluginId: string, indicatorId: string) {
  const list = statusIndicators.get(pluginId);
  if (!list) return;
  const next = list.filter((item) => item.id !== indicatorId);
  if (next.length === 0) statusIndicators.delete(pluginId);
  else statusIndicators.set(pluginId, next);
  rebuildSnapshot();
}

export function __resetRegistryForTests() {
  extensionRecords.clear();
  commands.clear();
  tools.clear();
  settings.clear();
  modelProviders.clear();
  models.clear();
  screens.clear();
  promptSections.clear();
  statusIndicators.clear();
  for (const owners of Object.values(uniqueContributionOwners)) owners.clear();
  commandIdentifierOwners.clear();
  subscribers.clear();
  snapshot = emptySnapshot();
}

export function unregisterExtensionContributions(pluginId: string) {
  commands.delete(pluginId);
  tools.delete(pluginId);
  settings.delete(pluginId);
  modelProviders.delete(pluginId);
  models.delete(pluginId);
  screens.delete(pluginId);
  statusIndicators.delete(pluginId);
  promptSections.delete(pluginId);
  releaseUniqueContributionClaims(pluginId);
  rebuildSnapshot();
}

// ── Convenience lookups ───────────────────────────────────────────────────────

export function getModelById(id: string): RegisteredModel | undefined {
  return snapshot.models.find((model) => model.id === id || model.aliases?.includes(id));
}

export function getModelProviderById(id: string): RegisteredModelProvider | undefined {
  return snapshot.modelProviders.find((provider) => provider.id === id);
}

// ── React hooks (only used by new modals) ─────────────────────────────────────

export function useRegistrySnapshot(): RegistrySnapshot {
  return useSyncExternalStore(subscribe, getRegistrySnapshot, getRegistrySnapshot);
}

export function usePlugins(): RuntimePluginRecord[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.extensions,
    () => snapshot.extensions,
  );
}

export function useCommands(): RegisteredCommand[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.commands,
    () => snapshot.commands,
  );
}

export function useTools(): RegisteredTool[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.tools,
    () => snapshot.tools,
  );
}

export function useModels(): RegisteredModel[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.models,
    () => snapshot.models,
  );
}

export function useScreens(): RegisteredScreen[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.screens,
    () => snapshot.screens,
  );
}

export function useStatusIndicators(): RegisteredStatusIndicator[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.statusIndicators,
    () => snapshot.statusIndicators,
  );
}
