import type {
  ExtensionChatProviderConfig,
  ExtensionChatTransportConfig,
  ExtensionManifest,
  TileContextEntry,
} from '../../shared/types.ts'
import type { ExtensionRegistry } from '../extensions/registry.ts'
import { loadWorkspaceTileState } from '../storage/workspaceArtifacts.ts'
import type { PeerContext } from './types.ts'

export const BUILTIN_CHAT_PROVIDER_IDS = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'openclaw',
  'hermes',
  'omnigent',
  'csagent',
  'gateway',
] as const)

const BUILTIN_PROVIDER_SET = new Set<string>(BUILTIN_CHAT_PROVIDER_IDS)
const MAX_PROVIDER_ID_BYTES = 512
const MAX_MODEL_ID_BYTES = 512
const MAX_PROVIDER_CONFIGS = 64
const MAX_PROVIDER_MODELS = 128
const MAX_BASE_URL_BYTES = 2_048
const MAX_API_KEY_BYTES = 8_192

export interface HostResolvedChatTransport extends ExtensionChatTransportConfig {
  readonly hostAuthority: {
    readonly extensionId: string
    readonly tileId: string
    readonly trust: 'installed-loopback' | 'trusted-remote'
  }
}

export interface TrustedChatExecutionTarget {
  providerId: string
  modelIds: string[]
  transport: ExtensionChatTransportConfig
}

export interface HostChatProviderDependencies {
  scanInstalledExtensions: (workspaceDir: string) => Promise<ExtensionManifest[]>
  loadTileState: (workspaceId: string, tileId: string) => Promise<unknown>
  loadTrustedExecutionTarget?: (providerId: string) => Promise<TrustedChatExecutionTarget | null>
}

interface HostChatProviderSelection {
  workspaceId: string
  workspaceDir: string
  provider: string
  model: string
  peers: readonly Pick<PeerContext, 'peerId' | 'peerType'>[]
}

interface ProviderCandidate {
  extensionId: string
  tileId: string
  config: ExtensionChatProviderConfig
}

let extensionRegistryProvider: (() => ExtensionRegistry | null) | null = null
const issuedTransports = new WeakSet<object>()

export function setChatExtensionRegistryProvider(provider: () => ExtensionRegistry | null): void {
  extensionRegistryProvider = provider
}

export function isHostResolvedChatTransport(value: unknown): value is HostResolvedChatTransport {
  return Boolean(value && typeof value === 'object' && issuedTransports.has(value as object))
}

function boundedIdentifier(value: unknown, maxBytes: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return ''
  }
  return normalized
}

function manifestOwnsPeer(manifest: ExtensionManifest, peerType: string): boolean {
  if (manifest._enabled !== true) return false
  if (!manifest.contributes?.context?.produces?.includes('ctx:chat:providers')) return false
  return Boolean(manifest.contributes.tiles?.some(tile => (
    peerType === tile.type || peerType === `ext:${tile.type}`
  )))
}

function normalizedProviderConfig(value: unknown): ExtensionChatProviderConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const id = boundedIdentifier(candidate.id, MAX_PROVIDER_ID_BYTES)
  if (!id || BUILTIN_PROVIDER_SET.has(id)) return null
  if (!Array.isArray(candidate.models) || candidate.models.length === 0 || candidate.models.length > MAX_PROVIDER_MODELS) return null
  const models = candidate.models.map((value): ExtensionChatProviderConfig['models'][number] | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const model = value as Record<string, unknown>
    const modelId = boundedIdentifier(model.id, MAX_MODEL_ID_BYTES)
    if (!modelId) return null
    return {
      id: modelId,
      label: boundedIdentifier(model.label, MAX_MODEL_ID_BYTES) || modelId,
      ...(typeof model.description === 'string' ? { description: model.description.slice(0, 1_024) } : {}),
    }
  })
  if (models.some(model => model === null)) return null
  const transport = candidate.transport
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) return null
  const rawTransport = transport as Record<string, unknown>
  if (rawTransport.type !== 'local-proxy' || typeof rawTransport.baseUrl !== 'string') return null
  if (Buffer.byteLength(rawTransport.baseUrl, 'utf8') > MAX_BASE_URL_BYTES) return null
  const apiKey = typeof rawTransport.apiKey === 'string' ? rawTransport.apiKey : undefined
  if (apiKey && Buffer.byteLength(apiKey, 'utf8') > MAX_API_KEY_BYTES) return null
  return {
    id,
    label: boundedIdentifier(candidate.label, MAX_PROVIDER_ID_BYTES) || id,
    noun: candidate.noun === 'agent' ? 'agent' : 'model',
    models: models as ExtensionChatProviderConfig['models'],
    transport: {
      type: 'local-proxy',
      baseUrl: rawTransport.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      autoStart: rawTransport.autoStart !== false,
    },
  }
}

function providerConfigsFromTileState(state: unknown, tileId: string): ExtensionChatProviderConfig[] {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return []
  const context = (state as { _context?: unknown })._context
  if (!context || typeof context !== 'object' || Array.isArray(context)) return []
  const entry = (context as Record<string, unknown>)['ctx:chat:providers'] as TileContextEntry | undefined
  if (!entry || entry.key !== 'ctx:chat:providers' || entry.source !== tileId || !Array.isArray(entry.value)) return []
  if (entry.value.length > MAX_PROVIDER_CONFIGS) return []
  return entry.value
    .map(normalizedProviderConfig)
    .filter((config): config is ExtensionChatProviderConfig => config !== null)
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
}

function normalizedLoopbackBaseUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) return null
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost') {
    url.hostname = '127.0.0.1'
  } else if (!isIpv4Loopback(hostname) && hostname !== '[::1]' && hostname !== '::1') {
    return null
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function issueTransport(
  transport: ExtensionChatTransportConfig,
  authority: HostResolvedChatTransport['hostAuthority'],
): HostResolvedChatTransport {
  const issued = Object.freeze({
    ...transport,
    hostAuthority: Object.freeze(authority),
  })
  issuedTransports.add(issued)
  return issued
}

async function defaultDependencies(): Promise<HostChatProviderDependencies> {
  const registry = extensionRegistryProvider?.()
  if (!registry) throw new Error('Extension provider registry is unavailable')
  return {
    scanInstalledExtensions: workspaceDir => registry.scanLightweight(workspaceDir),
    loadTileState: (workspaceId, tileId) => loadWorkspaceTileState(workspaceId, tileId, {}),
  }
}

/** Resolve extension execution authority from installed host state, never caller transport fields. */
export async function resolveHostChatProvider(
  selection: HostChatProviderSelection,
  dependencies?: HostChatProviderDependencies,
): Promise<HostResolvedChatTransport | undefined> {
  const providerId = boundedIdentifier(selection.provider, MAX_PROVIDER_ID_BYTES)
  const modelId = boundedIdentifier(selection.model, MAX_MODEL_ID_BYTES)
  if (!providerId || !modelId) throw new Error('Provider and model identifiers are required')
  if (BUILTIN_PROVIDER_SET.has(providerId)) return undefined

  const deps = dependencies ?? await defaultDependencies()
  const manifests = await deps.scanInstalledExtensions(selection.workspaceDir)
  const candidates: ProviderCandidate[] = []
  for (const peer of selection.peers) {
    const extension = manifests.find(manifest => manifestOwnsPeer(manifest, peer.peerType))
    if (!extension) continue
    const configs = providerConfigsFromTileState(
      await deps.loadTileState(selection.workspaceId, peer.peerId),
      peer.peerId,
    )
    for (const config of configs) {
      if (config.id === providerId) {
        candidates.push({ extensionId: extension.id, tileId: peer.peerId, config })
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Extension provider is not registered by an installed enabled peer: ${providerId}`)
  }
  if (candidates.length > 1) {
    throw new Error(`Extension provider id is ambiguous across installed peers: ${providerId}`)
  }
  const candidate = candidates[0]
  if (!candidate.config.models.some(model => model.id === modelId)) {
    throw new Error(`Selected model is not registered for extension provider ${providerId}`)
  }

  const loopbackBaseUrl = normalizedLoopbackBaseUrl(candidate.config.transport.baseUrl)
  if (loopbackBaseUrl) {
    // The tile-state contribution is renderer writable. It may advertise a
    // provider/model, but it must never choose the socket or credentials that
    // receive host-composed context. The provider runtime replaces this
    // sentinel with CodeSurf's live in-process proxy port and token.
    return issueTransport({
      type: 'local-proxy',
      baseUrl: 'http://127.0.0.1/v1',
      autoStart: candidate.config.transport.autoStart !== false,
    }, {
      extensionId: candidate.extensionId,
      tileId: candidate.tileId,
      trust: 'installed-loopback',
    })
  }

  const trusted = await deps.loadTrustedExecutionTarget?.(providerId)
  if (!trusted || trusted.providerId !== providerId || !trusted.modelIds.includes(modelId)) {
    throw new Error(`Remote extension provider ${providerId} requires an explicitly trusted execution target`)
  }
  return issueTransport(trusted.transport, {
    extensionId: candidate.extensionId,
    tileId: candidate.tileId,
    trust: 'trusted-remote',
  })
}
