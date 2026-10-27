// Kernel-aware model runtime resolver.
//
// Routes a requested modelId to the owning provider extension's adapter.
// For xAI models this falls back to the existing src/grok/client.ts path so
// behaviour (batch API, responses API, reasoning effort) stays bit-identical.
// For other providers we construct a minimal runtime: an ai-sdk
// LanguageModel + the canonical modelId. No modelInfo, no providerOptions —
// the Agent's xAI-specific code paths gracefully skip when those are absent.

import type { LanguageModel } from "ai";
import {
  type ResolvedModelRuntime,
  resolveModelRuntime as resolveXaiRuntime,
  type XaiProvider,
} from "../../grok/client";
import { currentWorkspaceScope } from "../../utils/workspace-scope";
import type {
  CredentialStatus,
  ProviderConnectionContext,
  ProviderSession,
  RegisteredModel,
  RegisteredModelProvider,
} from "./api";
import { getHostServices } from "./loader";
import { getModelProviderById, getRegistrySnapshot } from "./registry";

/**
 * Extended runtime shape. Most adapters (xAI, API-key providers) populate
 * `model` for the Agent's streamText path. Agent-SDK style adapters
 * instead populate `session` so the Agent can invoke `session.sendTurn`.
 */
export interface KernelModelRuntime extends ResolvedModelRuntime {
  /** Present when the adapter owns its own turn loop (Claude Agent SDK, Codex CLI). */
  session?: ProviderSession;
  /** Adapter id (for logging / usage attribution). */
  adapterId?: string;
  /** Logical provider id. */
  providerId?: string;
}

export interface KernelModelRuntimeOptions {
  /** Adapter selected by the user when the same model id exists in multiple adapters. */
  adapterId?: string;
}

// Cache provider sessions keyed by (adapterId, conversationId). For
// stateless adapters this avoids reconstructing the SDK client on every
// turn; for persistent adapters it's load-bearing (single connection per
// conversation). Every entry is tagged with the adapter generation that
// created it so a connect racing with disable → enable cannot revive a stale
// session after the old generation has been disposed.
interface CachedProviderSession {
  session: ProviderSession;
  generation: number;
}

const sessionCache = new Map<string, CachedProviderSession>();
const adapterGenerations = new Map<string, number>();

// In-flight connections keyed like the cache. Two concurrent lookups for the
// same (adapter, conversation) must share one `adapter.connect()` call: the
// cache is only populated after connect resolves, so without this both callers
// connected, the second overwrote the first in the cache, and the first
// session was stranded without a disconnect. Each entry remembers the adapter
// generation and conversation epoch it was started under so a caller that
// arrives after a disable/dispose never joins a connection that is about to
// be thrown away.
interface PendingProviderConnection {
  promise: Promise<ProviderSession>;
  generation: number;
  epoch: number;
}

const pendingConnections = new Map<string, PendingProviderConnection>();

// Conversation epochs. `disposeProviderSession(conversationId)` advances the
// epoch before touching anything else, so a connect that was already in
// flight for that conversation observes the mismatch when it resolves,
// disconnects its own result, and never repopulates the cache after the
// conversation was torn down or switched away from.
const conversationEpochs = new Map<string, number>();

function cacheKey(adapterId: string, conversationId: string): string {
  // A node session's folder is part of the key, so two folders that share a
  // conversation id (e.g. "ephemeral") never share a provider session. The
  // conversation id stays the suffix, so dispose-by-conversation still matches.
  const scope = currentWorkspaceScope();
  return scope ? `${adapterId}::${scope.root}::${conversationId}` : `${adapterId}::${conversationId}`;
}

function conversationSuffix(conversationId: string): string {
  return `::${conversationId}`;
}

function adapterGeneration(adapterId: string): number {
  const existing = adapterGenerations.get(adapterId);
  if (existing !== undefined) return existing;
  adapterGenerations.set(adapterId, 0);
  return 0;
}

function advanceAdapterGeneration(adapterId: string): number {
  const next = adapterGeneration(adapterId) + 1;
  adapterGenerations.set(adapterId, next);
  return next;
}

function conversationEpoch(conversationId: string): number {
  return conversationEpochs.get(conversationId) ?? 0;
}

function advanceConversationEpoch(conversationId: string): number {
  const next = conversationEpoch(conversationId) + 1;
  conversationEpochs.set(conversationId, next);
  return next;
}

async function disconnectStaleSession(adapterId: string, session: ProviderSession): Promise<void> {
  try {
    await session.disconnect?.();
  } catch (err) {
    console.error(`[extensions] stale ${adapterId} session disconnect failed:`, err);
  }
}

/**
 * Inside a node session's scope, pin the provider's workspace to that session's
 * shell: an adapter may read `ctx.workspace.cwd()` from a callback that fires
 * outside the turn, where the ambient scope is gone.
 */
function scopedWorkspace(): ProviderConnectionContext["workspace"] | undefined {
  const scope = currentWorkspaceScope();
  if (!scope) return undefined;
  return { cwd: () => scope.bash.cwd() };
}

async function connectProviderSession(
  provider: RegisteredModelProvider,
  conversationId: string,
  modelId: string,
  key: string,
  generation: number,
  epoch: number,
): Promise<ProviderSession> {
  const ctx: ProviderConnectionContext = {
    conversationId,
    adapterId: provider.id,
    providerId: provider.providerId,
    modelId,
    settings: getHostServices().settings,
    services: getHostServices(),
    workspace: scopedWorkspace() ?? getHostServices().workspace,
  };
  const session = await provider.adapter.connect(ctx);
  if (adapterGeneration(provider.id) !== generation) {
    await disconnectStaleSession(provider.id, session);
    throw new Error(`Provider adapter "${provider.id}" was disabled or reconfigured while connecting.`);
  }
  if (conversationEpoch(conversationId) !== epoch) {
    await disconnectStaleSession(provider.id, session);
    throw new Error(`Conversation "${conversationId}" was disposed while "${provider.id}" was connecting.`);
  }
  sessionCache.set(key, { session, generation });
  return session;
}

async function getOrConnectSession(
  provider: RegisteredModelProvider,
  conversationId: string,
  modelId: string,
): Promise<ProviderSession> {
  const key = cacheKey(provider.id, conversationId);
  const generation = adapterGeneration(provider.id);
  const epoch = conversationEpoch(conversationId);
  const existing = sessionCache.get(key);
  if (existing?.generation === generation) return existing.session;
  if (existing) {
    sessionCache.delete(key);
    await disconnectStaleSession(provider.id, existing.session);
  }

  // Join a connection another caller already started under the same
  // ownership. Entries from an older generation/epoch are left to self-dispose
  // when they resolve (see connectProviderSession) and are replaced here.
  const pending = pendingConnections.get(key);
  if (pending && pending.generation === generation && pending.epoch === epoch) {
    return pending.promise;
  }

  const entry: PendingProviderConnection = {
    generation,
    epoch,
    promise: connectProviderSession(provider, conversationId, modelId, key, generation, epoch),
  };
  pendingConnections.set(key, entry);
  try {
    return await entry.promise;
  } finally {
    // Only clear our own entry. A dispose/disable that raced with this
    // connect may already have installed a newer in-flight entry under the
    // same key; deleting unconditionally would strand that caller's sharing.
    if (pendingConnections.get(key) === entry) pendingConnections.delete(key);
  }
}

function dropPendingConnections(predicate: (key: string) => boolean): void {
  for (const key of Array.from(pendingConnections.keys())) {
    if (predicate(key)) pendingConnections.delete(key);
  }
}

async function connectRuntime(
  registered: RegisteredModel,
  provider: RegisteredModelProvider,
  conversationId: string,
): Promise<KernelModelRuntime> {
  const session = await getOrConnectSession(provider, conversationId, registered.id);

  if (session.getModel) {
    const model: LanguageModel = session.getModel(registered.id);
    return {
      model,
      modelId: registered.id,
      modelInfo: undefined,
      providerOptions: undefined,
      session,
      adapterId: provider.id,
      providerId: provider.providerId,
    };
  }

  if (session.sendTurn) {
    // Agent-SDK / owning adapter. The Agent must detect this runtime and
    // take the sendTurn() branch in its turn loop instead of calling
    // streamText(model).
    return {
      // Placeholder; owning adapters use the sendTurn() branch and must not pass
      // this value to streamText(). Kept non-nullable for compatibility with
      // ResolvedModelRuntime's direct-provider shape.
      model: null as unknown as LanguageModel,
      modelId: registered.id,
      modelInfo: undefined,
      providerOptions: undefined,
      session,
      adapterId: provider.id,
      providerId: provider.providerId,
    };
  }

  throw new Error(`Adapter "${provider.id}" session exposes neither getModel() nor sendTurn().`);
}

async function checkProviderAuth(
  registered: RegisteredModel,
  provider: RegisteredModelProvider,
  conversationId: string,
): Promise<CredentialStatus> {
  return await Promise.resolve(
    provider.auth.check({
      conversationId,
      adapterId: provider.id,
      providerId: provider.providerId,
      modelId: registered.id,
      settings: getHostServices().settings,
    }),
  );
}

/**
 * Dispose a cached provider session for a given conversation. Called on
 * Agent cleanup and on session switching.
 */
export async function disposeProviderSession(conversationId: string): Promise<void> {
  // Ownership first, I/O second. Advancing the epoch invalidates every
  // connect still in flight for this conversation, and removing the cache
  // entries before awaiting disconnect means no lookup can observe (and
  // reuse) a session that is in the middle of disconnecting.
  advanceConversationEpoch(conversationId);
  const suffix = conversationSuffix(conversationId);
  dropPendingConnections((key) => key.endsWith(suffix));
  const toDispose: Array<{ adapterId: string; session: ProviderSession }> = [];
  for (const [key, cached] of sessionCache) {
    if (!key.endsWith(suffix)) continue;
    sessionCache.delete(key);
    toDispose.push({ adapterId: key.slice(0, key.length - suffix.length), session: cached.session });
  }
  await Promise.allSettled(
    toDispose.map(async ({ adapterId, session }) => {
      try {
        await session.disconnect?.();
      } catch (err) {
        console.error(`[extensions] ${adapterId} session disconnect failed:`, err);
      }
    }),
  );
}

/**
 * Dispose every cached session. Called from Agent.cleanup() at shutdown.
 */
export async function disposeAllProviderSessions(): Promise<void> {
  const entries = Array.from(sessionCache.values(), (cached) => cached.session);
  sessionCache.clear();
  for (const adapterId of adapterGenerations.keys()) advanceAdapterGeneration(adapterId);
  for (const conversationId of conversationEpochs.keys()) advanceConversationEpoch(conversationId);
  pendingConnections.clear();
  await Promise.allSettled(entries.map((s) => s.disconnect?.()));
}

/**
 * Dispose cached sessions belonging to a given provider adapter id. Called
 * when a provider extension is disabled (see loader.ts clearExtensionRuntimeState)
 * so disabling the extension tears down its live sessions instead of leaving
 * stale entries in the cache that would be reused on re-enable.
 *
 * Cache keys are shaped `${adapterId}::${conversationId}`.
 */
export async function disposeProviderSessionsByAdapter(adapterId: string): Promise<void> {
  // Invalidate pending connections before awaiting disconnect. A connection
  // that started under the old generation will observe the mismatch in
  // getOrConnectSession(), disconnect itself, and never repopulate the cache.
  advanceAdapterGeneration(adapterId);
  const prefix = `${adapterId}::`;
  dropPendingConnections((key) => key.startsWith(prefix));
  const toDispose: ProviderSession[] = [];
  for (const [key, cached] of sessionCache) {
    if (key.startsWith(prefix)) {
      toDispose.push(cached.session);
      sessionCache.delete(key);
    }
  }
  await Promise.allSettled(toDispose.map((s) => s.disconnect?.()));
}

/**
 * Pre-establish the provider session for a model the user just selected.
 *
 * Owning adapters defer their subprocess boot to the first `sendTurn` (see
 * `ProviderSession.warm`), so without this the user pays 1.8–3.0s of process
 * startup inside their first message. Calling this at model-select time moves
 * that cost into the window where they are still typing.
 *
 * Entirely best-effort and non-blocking by contract: a provider that cannot
 * warm (missing CLI, logged out, extension disabled) must fail on the next real
 * turn, where there is a stream controller to render the error — never here,
 * where a throw would surface as an unhandled rejection during model selection.
 */
export async function warmProviderSession(
  conversationId: string,
  modelId: string,
  adapterId?: string,
): Promise<boolean> {
  try {
    const registry = getRegistrySnapshot();
    const registered = registry.models.find(
      (m) => (m.id === modelId || m.aliases?.includes(modelId)) && (!adapterId || m.adapterId === adapterId),
    );
    const providerId = adapterId ?? registered?.adapterId;
    if (!providerId) return false;
    const provider = getModelProviderById(providerId);
    // Only adapters that own a turn loop have anything to warm. Direct-API
    // adapters (xAI, Anthropic API-key) construct a client in microseconds.
    if (!provider || provider.connectionMode !== "persistent") return false;

    const session = await getOrConnectSession(provider, conversationId, registered?.id ?? modelId);
    if (!session.warm) return false;
    await session.warm();
    return true;
  } catch (err) {
    console.error("[extensions] provider warm failed (non-fatal):", err);
    return false;
  }
}

async function getXaiSessionAndProvider(
  conversationId: string,
  modelId: string,
): Promise<{ session: ProviderSession; provider: XaiProvider; adapterId: string; providerId: string }> {
  const adapter = getModelProviderById("xai.default");
  if (!adapter) {
    throw new Error("xAI provider extension is not loaded. Cannot construct an xAI runtime.");
  }
  const session = await getOrConnectSession(adapter, conversationId, modelId);
  const raw = session.getRawProvider?.();
  if (!raw) {
    throw new Error(
      "xAI session did not expose getRawProvider() — version mismatch with builtin xai-provider extension.",
    );
  }
  return {
    session,
    provider: raw as XaiProvider,
    adapterId: adapter.id,
    providerId: adapter.providerId,
  };
}

/**
 * Resolve a model runtime via the kernel. Falls back to the direct xAI path
 * when the kernel has no registration for `modelId` or the owning provider
 * is xAI (which still uses the specialized xAI client).
 *
 * Return shape depends on the owning adapter:
 *   - xAI ↔ full xAI runtime (modelInfo, providerOptions populated).
 *   - Other `getModel` adapter (Anthropic API key, OpenAI API key) ↔ runtime
 *     with a LanguageModel ready for streamText().
 *   - `sendTurn` adapter (Claude Agent SDK) ↔ runtime with `session` populated
 *     and `model` set to a placeholder the Agent must NOT pass to streamText.
 */
export async function resolveModelRuntimeViaKernel(
  modelId: string,
  conversationId: string,
  options: KernelModelRuntimeOptions = {},
): Promise<KernelModelRuntime> {
  // Collect every registered model entry matching this id (or aliases) — the
  // same id can be exposed by multiple adapters (e.g. anthropic.api-key AND
  // anthropic.agent-sdk). We must pick the right one based on which adapter
  // is actually usable.
  const snapshot = getRegistrySnapshot();
  const matches = snapshot.models.filter((m) => m.id === modelId || m.aliases?.includes(modelId));

  if (matches.length === 0) {
    const codesurf = syntheticCodesurfModel(modelId);
    if (codesurf?.adapterId) {
      const provider = getModelProviderById(codesurf.adapterId);
      if (!provider) {
        throw new Error(
          `Codesurf daemon provider is not loaded, so "${modelId}" cannot run. Enable it in /extensions.`,
        );
      }
      const status = await checkProviderAuth(codesurf, provider, conversationId);
      if (!status.ok) {
        throw new Error(status.reason ?? `Codesurf daemon is not available for "${modelId}".`);
      }
      return connectRuntime(codesurf, provider, conversationId);
    }

    // Unknown to kernel — route through the xAI session anyway. The Agent's
    // pre-3b behavior was to treat any unknown id as xAI-by-default; preserve
    // that for now (alias support in /models add will land in 3c).
    const xai = await getXaiSessionAndProvider(conversationId, modelId);
    return {
      ...resolveXaiRuntime(xai.provider, modelId),
      session: xai.session,
      adapterId: xai.adapterId,
      providerId: xai.providerId,
    };
  }

  const selectedAdapterId = options.adapterId?.trim();
  if (selectedAdapterId) {
    const selected = matches.find((m) => m.adapterId === selectedAdapterId);
    if (selected) {
      if (selected.providerId === "xai") {
        const xai = await getXaiSessionAndProvider(conversationId, selected.id);
        return {
          ...resolveXaiRuntime(xai.provider, selected.id),
          session: xai.session,
          adapterId: xai.adapterId,
          providerId: xai.providerId,
        };
      }

      const provider = getModelProviderById(selectedAdapterId);
      if (!provider) {
        throw new Error(`Adapter "${selectedAdapterId}" for "${modelId}" is not registered.`);
      }
      const status = await checkProviderAuth(selected, provider, conversationId);
      if (!status.ok) {
        throw new Error(
          status.reason ?? `Adapter "${selectedAdapterId}" for "${modelId}" is not configured. Open /models.`,
        );
      }
      return connectRuntime(selected, provider, conversationId);
    }
  }

  const xaiMatch = matches.find((m) => m.providerId === "xai");
  if (xaiMatch) {
    const xai = await getXaiSessionAndProvider(conversationId, xaiMatch.id);
    return {
      ...resolveXaiRuntime(xai.provider, xaiMatch.id),
      session: xai.session,
      adapterId: xai.adapterId,
      providerId: xai.providerId,
    };
  }

  // Collect every adapter whose credential check passes, then prefer the
  // one with a persistent connection mode. Previously this loop returned on
  // the FIRST ok adapter — which meant adding ANTHROPIC_API_KEY silently
  // took routing away from the Agent SDK adapter (its check always reports
  // ok because auth is delegated to the claude CLI). A bad or expired API
  // key then surfaced as "invalid key" even though the user had explicitly
  // enabled the persistent Agent SDK extension. Preferring persistent
  // adapters honors that explicit opt-in.
  const okCandidates: Array<{
    model: RegisteredModel;
    provider: RegisteredModelProvider;
  }> = [];
  let lastStatus: CredentialStatus | undefined;

  for (const candidate of matches) {
    const candidateProvider = getModelProviderById(candidate.adapterId ?? "");
    if (!candidateProvider) continue;
    const status = await checkProviderAuth(candidate, candidateProvider, conversationId);
    lastStatus = status;
    if (status.ok) {
      okCandidates.push({ model: candidate, provider: candidateProvider });
    }
  }

  if (okCandidates.length === 0) {
    // No adapter with working credentials. Surface the last seen reason.
    throw new Error(
      lastStatus?.reason ??
        `No adapter for "${modelId}" is configured. Open /models or /extensions to set credentials.`,
    );
  }

  // Stable sort: persistent adapters (Agent SDK, Codex CLI) win over
  // stateless ones (API-key, SDK clients). Within the same mode the
  // original registration order is preserved.
  okCandidates.sort((a, b) => {
    const scoreA = a.provider.connectionMode === "persistent" ? 0 : 1;
    const scoreB = b.provider.connectionMode === "persistent" ? 0 : 1;
    return scoreA - scoreB;
  });

  const { model: registered, provider } = okCandidates[0];
  return connectRuntime(registered, provider, conversationId);
}

const CODESURF_DOWNSTREAMS = new Set(["claude", "codex", "opencode", "hermes"]);

/**
 * A `codesurf:<downstream>/<model>` id the registry does not know yet.
 * Null for anything that is not that shape, so bare unknown ids still take
 * the legacy xAI fallback.
 */
function syntheticCodesurfModel(modelId: string): RegisteredModel | null {
  if (!modelId.startsWith("codesurf:")) return null;
  const rest = modelId.slice("codesurf:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const downstream = rest.slice(0, slash);
  if (!CODESURF_DOWNSTREAMS.has(downstream)) return null;
  return {
    pluginId: "builtin.provider-codesurf-desktop",
    id: modelId,
    providerId: "codesurf",
    adapterId: "codesurf.daemon",
    label: rest.slice(slash + 1),
  };
}

/** Convenience: does this runtime require the owning-adapter sendTurn path? */
export function runtimeUsesSendTurn(runtime: KernelModelRuntime): boolean {
  return !!runtime.session?.sendTurn && !runtime.session?.getModel;
}
