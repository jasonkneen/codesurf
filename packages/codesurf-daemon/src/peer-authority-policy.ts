import {
  readDataProperty,
  singleLine,
  utf8Bytes,
  utf8Prefix,
} from './peer-context-serialization.js'
import { getAllNodeToolNames } from './node-tools.js'

const MAX_CANVAS_TILES = 2_048
const MAX_CANVAS_CONNECTIONS = 8_192
const MAX_ID_BYTES = 128
const MAX_TYPE_BYTES = 64
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export interface CanvasAuthoritativePeer {
  peerId: string
  peerType: string
  tools: string[]
}

function data(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== 'object') return undefined
  const property = readDataProperty(value, key)
  return property.ok ? property.value : undefined
}

function boundedId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = singleLine(value)
  if (!id || utf8Bytes(id) > MAX_ID_BYTES || !SAFE_ID.test(id)) return null
  if (id === '.' || id === '..' || id.includes('..') || id.endsWith('.')) return null
  return id
}

function boundedType(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const type = singleLine(value)
  return type ? utf8Prefix(type, MAX_TYPE_BYTES) : 'unknown'
}

/** Resolve host-validated functional topology; persisted canvas is not a model trust root. */
export function resolveAuthoritativeCanvasPeers(
  canvas: unknown,
  tileIdValue: unknown,
): CanvasAuthoritativePeer[] {
  const tileId = boundedId(tileIdValue)
  const rawTiles = data(canvas, 'tiles')
  const rawConnections = data(canvas, 'lockedConnections')
  if (!tileId || !Array.isArray(rawTiles) || !Array.isArray(rawConnections)) return []

  const tileTypes = new Map<string, string>()
  for (let index = 0; index < Math.min(rawTiles.length, MAX_CANVAS_TILES); index += 1) {
    const tile = data(rawTiles, String(index))
    const id = boundedId(data(tile, 'id'))
    if (!id || tileTypes.has(id)) continue
    tileTypes.set(id, boundedType(data(tile, 'type')))
  }
  if (!tileTypes.has(tileId)) return []

  const peerIds = new Set<string>()
  for (let index = 0; index < Math.min(rawConnections.length, MAX_CANVAS_CONNECTIONS); index += 1) {
    const connection = data(rawConnections, String(index))
    const source = boundedId(data(connection, 'sourceTileId'))
    const target = boundedId(data(connection, 'targetTileId'))
    if (!source || !target || source === target) continue
    const peerId = source === tileId ? target : target === tileId ? source : null
    if (peerId && tileTypes.has(peerId)) peerIds.add(peerId)
  }

  return [...peerIds]
    .sort()
    .map(peerId => {
      const peerType = tileTypes.get(peerId) ?? 'unknown'
      return {
        peerId,
        peerType,
        tools: getAllNodeToolNames(peerType),
      }
    })
}

export function getAuthoritativeNegotiatedPeerTools(
  peers: readonly CanvasAuthoritativePeer[],
  mcpEnabled: boolean | undefined,
): string[] | undefined {
  if (mcpEnabled === false) return undefined
  return [...new Set(peers.flatMap(peer => peer.tools))].sort()
}

/** Keep caller observations only for peer IDs already proven by the canvas. */
export function selectAuthorizedPeerObservations(
  value: unknown,
  authoritativePeers: readonly CanvasAuthoritativePeer[],
): unknown[] {
  if (!Array.isArray(value) || authoritativePeers.length === 0) return []
  const allowed = new Set(authoritativePeers.map(peer => peer.peerId))
  const selected: unknown[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length && selected.length < authoritativePeers.length; index += 1) {
    const candidate = data(value, String(index))
    const peerId = boundedId(data(candidate, 'peerId'))
    if (!peerId || !allowed.has(peerId) || seen.has(peerId)) continue
    seen.add(peerId)
    selected.push(candidate)
  }
  return selected
}
