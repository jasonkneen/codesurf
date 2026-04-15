import React, { useState, useRef, useCallback, useEffect, useMemo, Suspense } from 'react'
import { Ungroup, Grid2x2X, Scissors, ClipboardPaste, Maximize2, LayoutGrid, Plus } from 'lucide-react'
import type { TileState, GroupState, CanvasState, Workspace, AppSettings, TileType, LockedConnection } from '../../shared/types'
import { TileColorProvider } from './TileColorContext'
import { withDefaultSettings, DEFAULT_SETTINGS } from '../../shared/types'
import type { MenuItem } from './components/ContextMenu'
import { useExtensions } from './hooks/useExtensions'
import { getTileNodeTools, withCapabilityPrefix, stripCapabilityPrefix, getAllNodeTools } from '../../shared/nodeTools'
import { FontProvider, FontTokenProvider, SANS_DEFAULT, MONO_DEFAULT } from './FontContext'
import { ThemeProvider } from './ThemeContext'
import { DEFAULT_THEME_ID, getThemeById, resolveEffectiveThemeId, registerCustomTheme, unregisterCustomTheme } from './theme'
import type { PanelNode } from './components/PanelLayout'
import { createLeaf, removeTileFromTree, addTabToLeaf, getAllTileIds, splitLeaf, closeOthersInLeaf, closeToRightInLeaf, findLeafById } from './components/PanelLayout'
import { basename, getDroppedPaths, toFileUrl, isMediaFile } from './utils/dnd'
import { disposeChatTileRuntimeState, setChatTileRuntimeState } from './components/chatTileRuntimeState'
import { disposeMediaTile } from './components/MediaTile'
import { MainStatusBar } from './components/MainStatusBar'

const LazyPanelLayout = React.lazy(() => import('./components/PanelLayout').then(m => ({ default: m.PanelLayout })))

type SidebarSessionEntry = {
  id: string
  source: 'codesurf' | 'claude' | 'codex' | 'cursor' | 'openclaw' | 'opencode'
  scope: 'workspace' | 'project' | 'user'
  tileId: string | null
  sessionId: string | null
  provider: string
  model: string
  messageCount: number
  lastMessage: string | null
  updatedAt: number
  filePath?: string
  title: string
  projectPath?: string | null
  sourceLabel: string
  sourceDetail?: string
  canOpenInChat?: boolean
  canOpenInApp?: boolean
  resumeBin?: string
  resumeArgs?: string[]
  relatedGroupId?: string | null
  nestingLevel?: number
}

type PendingSessionOpen =
  | { kind: 'chat'; session: SidebarSessionEntry; workspaceId: string }
  | { kind: 'app'; session: SidebarSessionEntry; workspaceId: string }

const LazyTileChrome = React.lazy(() => import('./components/TileChrome').then(m => ({ default: m.TileChrome })))
const LazySidebar = React.lazy(() => import('./components/Sidebar').then(m => ({ default: m.Sidebar })))
const LazySidebarFooter = React.lazy(() => import('./components/Sidebar').then(m => ({ default: m.SidebarFooter })))
const LazyContextMenu = React.lazy(() => import('./components/ContextMenu').then(m => ({ default: m.ContextMenu })))
const LazyImageTile = React.lazy(() => import('./components/ImageTile').then(m => ({ default: m.ImageTile })))
const LazyMediaTile = React.lazy(() => import('./components/MediaTile').then(m => ({ default: m.MediaTile })))
const LazyBrowserTile = React.lazy(() => import('./components/BrowserTile').then(m => ({ default: m.BrowserTile })))
const LazyKanbanTile = React.lazy(() => import('./components/KanbanTile').then(m => ({ default: m.KanbanTile })))
const LazyMCPPanel = React.lazy(() => import('./components/MCPPanel').then(m => ({ default: m.MCPPanel })))
const LazyArrangeToolbar = React.lazy(() => import('./components/ArrangeToolbar').then(m => ({ default: m.ArrangeToolbar })))
const LazyMinimap = React.lazy(() => import('./components/Minimap').then(m => ({ default: m.Minimap })))
const LazySettingsPanel = React.lazy(() => import('./components/SettingsPanel').then(m => ({ default: m.SettingsPanel })))
const LazyTerminalTile = React.lazy(() => import('./components/TerminalTile').then(m => ({ default: m.TerminalTile })))
const LazyCodeTile = React.lazy(() => import('./components/CodeTile').then(m => ({ default: m.CodeTile })))
const LazyNoteTile = React.lazy(() => import('./components/NoteTile').then(m => ({ default: m.NoteTile })))
const LazyStickyColorPicker = React.lazy(() => import('./components/NoteTile').then(m => ({ default: m.StickyColorPicker })))
const LazyChatTile = React.lazy(() => import('./components/ChatTile').then(m => ({ default: m.ChatTile })))
const LazyFileTile = React.lazy(() => import('./components/FileTile').then(m => ({ default: m.FileTile })))
const LazyFileExplorerTile = React.lazy(() => import('./components/FileExplorerTile'))
const LazyConnectionPill = React.lazy(() => import('./components/ConnectionPill').then(m => ({ default: m.ConnectionPill })))
const LazyExtensionTile = React.lazy(() => import('./components/ExtensionTile').then(m => ({ default: m.ExtensionTile })))
const LazyClusoWidgetMount = React.lazy(() => import('./components/ClusoWidgetMount').then(m => ({ default: m.ClusoWidgetMount })))
const LazyAgentSetup = React.lazy(() => import('./components/AgentSetup').then(m => ({ default: m.AgentSetup })))

type DragState =
  | { type: null }
  | { type: 'pan'; startX: number; startY: number; initTx: number; initTy: number }
  | { type: 'tile'; tileId: string; startX: number; startY: number; initX: number; initY: number; groupSnapshots: { id: string; x: number; y: number }[] }
  | { type: 'resize'; tileId: string; dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'; startX: number; startY: number; initX: number; initY: number; initW: number; initH: number }
  | { type: 'select'; startWx: number; startWy: number; curWx: number; curWy: number }
  | { type: 'group'; groupId: string; startX: number; startY: number; snapshots: { id: string; x: number; y: number }[]; initLayoutBounds?: { x: number; y: number; w: number; h: number } }
  | { type: 'group-resize'; groupId: string; dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'; startX: number; startY: number; initBounds: { x: number; y: number; w: number; h: number }; snapshots: { id: string; x: number; y: number; width: number; height: number }[] }

const GRID = 20 // default, overridden by settings at runtime
const snap = (v: number, grid = GRID) => Math.round(v / grid) * grid

function findFirstLeafId(node: PanelNode): string | null {
  if (node.type === 'leaf') return node.id
  for (const child of node.children) {
    const found = findFirstLeafId(child)
    if (found) return found
  }
  return null
}

function sanitizePanelLayout(root: PanelNode | null | undefined, tileIds: string[]): { layout: PanelNode | null; fallbackActivePanelId: string | null } {
  if (!root) return { layout: null, fallbackActivePanelId: null }

  const validTileIds = new Set(tileIds)
  let next: PanelNode | null = root

  for (const tileId of getAllTileIds(root)) {
    if (!validTileIds.has(tileId)) {
      next = next ? (removeTileFromTree(next, tileId) ?? createLeaf([])) : createLeaf([])
    }
  }

  return {
    layout: next,
    fallbackActivePanelId: next ? findFirstLeafId(next) : null,
  }
}

function normalizeWorkspacePath(path: string | null | undefined): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'rs', 'go', 'cpp', 'c', 'java', 'css', 'html', 'sh', 'bash', 'yaml', 'yml', 'toml', 'xml'])
const NOTE_EXTENSIONS = new Set(['md', 'txt', 'markdown', 'mdx'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'ogv', 'avi', 'mkv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'])
const BROWSER_DOCUMENT_EXTENSIONS = new Set(['pdf'])
const GENERIC_DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pages', 'numbers', 'key', 'rtf'])

function extToType(filePath: string): TileState['type'] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (NOTE_EXTENSIONS.has(ext)) return 'note'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) return 'media'
  if (BROWSER_DOCUMENT_EXTENSIONS.has(ext)) return 'browser'
  if (GENERIC_DOCUMENT_EXTENSIONS.has(ext)) return 'file'
  if (!filePath.includes('.')) return 'code'
  return 'file'
}

async function resolveFileTileType(filePath: string): Promise<TileState['type']> {
  const byExtension = extToType(filePath)
  if (byExtension !== 'file') return byExtension

  try {
    const isText = await window.electron.fs.isProbablyTextFile(filePath)
    return isText ? 'code' : 'file'
  } catch {
    return byExtension
  }
}

function toBrowserTileUrl(filePath: string): string {
  if (!filePath) return ''
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(filePath)) return filePath
  if (filePath === 'about:blank') return filePath
  if (filePath.startsWith('/')) return toFileUrl(filePath)
  return filePath
}

function withAlpha(color: string, alpha: number): string {
  const trimmed = color.trim()

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1)
    if (hex.length === 3) {
      const [r, g, b] = hex.split('').map(ch => parseInt(ch + ch, 16))
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }
  }

  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i)
  if (rgbMatch) {
    const [r = '0', g = '0', b = '0'] = rgbMatch[1].split(',').map(part => part.trim())
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  return color
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT'
    || tag === 'TEXTAREA'
    || el.isContentEditable
    || !!el.closest('.monaco-editor')
}

function getMinTileWidth(tileOrType: TileState | TileState['type']): number {
  const type = typeof tileOrType === 'string' ? tileOrType : tileOrType.type
  if (type === 'chat') return 450
  if (type === 'files') return 250
  if (type === 'file') return 200
  if (type.startsWith('ext:')) return 150
  return 200
}

function getMinTileHeight(tileOrType: TileState | TileState['type']): number {
  const type = typeof tileOrType === 'string' ? tileOrType : tileOrType.type
  if (type === 'files') return 300
  if (type === 'file') return 200
  if (type.startsWith('ext:')) return 100
  return 150
}

type AnchorSide = 'top' | 'right' | 'bottom' | 'left'

type TileCapabilitySet = {
  provides: string[]
  accepts: string[]
  tools?: string[]
}

type AnchorPoint = {
  side: AnchorSide
  x: number
  y: number
  gridX: number
  gridY: number
}

type TileSpatialReference = {
  tileId: string
  bounds: { left: number; top: number; right: number; bottom: number }
  gridBounds: { left: number; top: number; right: number; bottom: number }
  anchors: AnchorPoint[]
  capabilities: TileCapabilitySet
}

type DiscoveryMatch = {
  tile: TileState
  route: { x: number; y: number }[]
  distance: number
  matchLabels: string[]
  targetRef: TileSpatialReference
}

type DiscoveryPulse = {
  id: string
  sourceTileId: string
  targetTileId: string
  route: { x: number; y: number }[]
  startedAt: number
  durationMs: number
  matchLabels: string[]
  sourceGridLabel: string
  targetGridLabel: string
}

type DiscoveryCapabilityLink = {
  peerId: string
  peerType: TileType
  distance: number
  route: { x: number; y: number }[]
  capabilities: string[]
  lastSeen: number
}

type DiscoveryState = {
  connectedTileIds: Set<string>
  byTile: Map<string, DiscoveryCapabilityLink[]>
}

const DISCOVERY_PULSE_DURATION_MS = 1100
const SETTINGS_CACHE_KEY = 'contex:settings-cache'
const BRAND_WORDMARK_CACHE_KEY = 'contex:brand-wordmark-index'
const BRAND_WORDMARK_PALETTE_CACHE_KEY = 'contex:brand-wordmark-palette-index'

function readCachedSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(SETTINGS_CACHE_KEY)
    return raw ? withDefaultSettings(JSON.parse(raw)) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

function getDiscoveryMaxDistance(largeGridStep: number): number {
  return Math.max(largeGridStep * 3, largeGridStep)
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

// Extension action registry — extensions register actions at runtime; these become
// tool capabilities so connected peers (especially chat tiles) can discover them.
const extensionActionRegistry = new Map<string, Array<{ name: string; description: string }>>()

function getTileCapabilities(tile: TileState): TileCapabilitySet {
  const base: TileCapabilitySet = (() => {
    if (tile.type === 'terminal') return { provides: ['output', 'task', 'reference'], accepts: ['file', 'task', 'reference'] }
    if (tile.type === 'code' || tile.type === 'note' || tile.type === 'file') return { provides: ['file', 'text', 'reference'], accepts: ['task', 'output', 'reference'] }
    if (tile.type === 'browser') return { provides: ['url', 'web', 'reference'], accepts: ['text', 'task', 'reference'] }
    if (tile.type === 'chat') return { provides: ['task', 'text', 'reference'], accepts: ['file', 'output', 'reference'] }
    if (tile.type === 'files') return { provides: ['file', 'reference'], accepts: ['task', 'reference'] }

    if (tile.type === 'kanban') return { provides: ['task', 'reference'], accepts: ['task', 'text', 'reference'] }
    if (tile.type === 'image') return { provides: ['image', 'reference'], accepts: ['text', 'reference'] }
    if (tile.type.startsWith('ext:')) return { provides: ['task', 'reference'], accepts: ['task', 'text', 'reference'] }
    return { provides: ['reference'], accepts: ['reference'] }
  })()

  const toolNames = getTileNodeTools(tile.type).map(tool => tool.name)

  // Include dynamically registered extension actions as tool capabilities
  if (tile.type.startsWith('ext:')) {
    const extActions = extensionActionRegistry.get(tile.id)
    if (extActions) {
      for (const action of extActions) toolNames.push(action.name)
    }
  }

  return {
    ...base,
    tools: toolNames.map(withCapabilityPrefix),
  }
}

function getTileGridBounds(tile: TileState, grid: number): TileSpatialReference['gridBounds'] {
  return {
    left: Math.round(tile.x / grid),
    top: Math.round(tile.y / grid),
    right: Math.round((tile.x + tile.width) / grid),
    bottom: Math.round((tile.y + tile.height) / grid),
  }
}

function makeAnchor(side: AnchorSide, x: number, y: number, grid: number): AnchorPoint {
  const snappedX = snap(x, grid)
  const snappedY = snap(y, grid)
  return {
    side,
    x: snappedX,
    y: snappedY,
    gridX: Math.round(snappedX / grid),
    gridY: Math.round(snappedY / grid),
  }
}

function getTileSpatialReference(tile: TileState, grid: number): TileSpatialReference {
  return {
    tileId: tile.id,
    bounds: {
      left: tile.x,
      top: tile.y,
      right: tile.x + tile.width,
      bottom: tile.y + tile.height,
    },
    gridBounds: getTileGridBounds(tile, grid),
    anchors: [
      makeAnchor('top', tile.x + tile.width / 2, tile.y, grid),
      makeAnchor('right', tile.x + tile.width, tile.y + tile.height / 2, grid),
      makeAnchor('bottom', tile.x + tile.width / 2, tile.y + tile.height, grid),
      makeAnchor('left', tile.x, tile.y + tile.height / 2, grid),
    ],
    capabilities: getTileCapabilities(tile),
  }
}

function getCapabilityMatches(source: TileCapabilitySet, target: TileCapabilitySet): string[] {
  return uniq([
    ...source.provides.filter(value => target.accepts.includes(value)),
    ...target.provides.filter(value => source.accepts.includes(value)),
  ])
}

function findDiscoveryConnections(
  tileList: TileState[],
  hiddenTileIds: Set<string>,
  gridStep: number,
  maxDistance: number
): DiscoveryState {
  const connectedTileIds = new Set<string>()
  const byTile = new Map<string, DiscoveryCapabilityLink[]>()
  const refs = tileList
    .filter(tile => !hiddenTileIds.has(tile.id))
    .map(tile => ({ tile, ref: getTileSpatialReference(tile, gridStep) }))

  for (let i = 0; i < refs.length; i += 1) {
    const source = refs[i]
    for (let j = i + 1; j < refs.length; j += 1) {
      const target = refs[j]

      if (source.tile.id === target.tile.id) continue

      const sourceRect = { x: source.tile.x, y: source.tile.y, w: source.tile.width, h: source.tile.height }
      const targetRect = { x: target.tile.x, y: target.tile.y, w: target.tile.width, h: target.tile.height }
      if (rectsOverlap(sourceRect, targetRect)) continue

      const anchorPair = findBestAnchorPair(source.ref.anchors, target.ref.anchors)
      if (!anchorPair || anchorPair.distance > maxDistance) continue

      const sharedCaps = getCapabilityMatches(source.ref.capabilities, target.ref.capabilities)
      const route = getOrthogonalRoute(anchorPair.source, anchorPair.target, gridStep)
      const sourceTools = source.ref.capabilities.tools ?? []
      const targetTools = target.ref.capabilities.tools ?? []

      if (sharedCaps.length > 0) {
        const sourceLink: DiscoveryCapabilityLink = {
          peerId: target.tile.id,
          peerType: target.tile.type,
          distance: anchorPair.distance,
          route,
          capabilities: uniq([...targetTools, ...sharedCaps]),
          lastSeen: Date.now(),
        }
        const targetLink: DiscoveryCapabilityLink = {
          peerId: source.tile.id,
          peerType: source.tile.type,
          distance: anchorPair.distance,
          route: route.slice().reverse(),
          capabilities: uniq([...sourceTools, ...sharedCaps]),
          lastSeen: Date.now(),
        }

        const nextSource = byTile.get(source.tile.id) ?? []
        const nextTarget = byTile.get(target.tile.id) ?? []
        nextSource.push(sourceLink)
        nextTarget.push(targetLink)
        byTile.set(source.tile.id, nextSource)
        byTile.set(target.tile.id, nextTarget)
        connectedTileIds.add(source.tile.id)
        connectedTileIds.add(target.tile.id)
      }
    }
  }

  return { connectedTileIds, byTile }
}

function findBestAnchorPair(sourceAnchors: AnchorPoint[], targetAnchors: AnchorPoint[]): { source: AnchorPoint; target: AnchorPoint; distance: number } | null {
  let best: { source: AnchorPoint; target: AnchorPoint; distance: number } | null = null
  for (const source of sourceAnchors) {
    for (const target of targetAnchors) {
      const distance = Math.abs(source.x - target.x) + Math.abs(source.y - target.y)
      if (!best || distance < best.distance) best = { source, target, distance }
    }
  }
  return best
}

function stepOutFromAnchor(anchor: AnchorPoint, step: number): { x: number; y: number } {
  if (anchor.side === 'left') return { x: anchor.x - step, y: anchor.y }
  if (anchor.side === 'right') return { x: anchor.x + step, y: anchor.y }
  if (anchor.side === 'top') return { x: anchor.x, y: anchor.y - step }
  return { x: anchor.x, y: anchor.y + step }
}

function simplifyRoute(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const deduped = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
  if (deduped.length <= 2) return deduped

  const simplified = [deduped[0]]
  for (let i = 1; i < deduped.length - 1; i += 1) {
    const prev = simplified[simplified.length - 1]
    const current = deduped[i]
    const next = deduped[i + 1]
    const collinear = (prev.x === current.x && current.x === next.x) || (prev.y === current.y && current.y === next.y)
    if (!collinear) simplified.push(current)
  }
  simplified.push(deduped[deduped.length - 1])
  return simplified
}

function getOrthogonalRoute(source: AnchorPoint, target: AnchorPoint, step: number): { x: number; y: number }[] {
  const sourceLead = stepOutFromAnchor(source, step)
  const targetLead = stepOutFromAnchor(target, step)
  const points: { x: number; y: number }[] = [
    { x: source.x, y: source.y },
    sourceLead,
  ]

  if (sourceLead.x !== targetLead.x && sourceLead.y !== targetLead.y) {
    const horizontalFirst = source.side === 'left' || source.side === 'right'
    points.push(horizontalFirst
      ? { x: targetLead.x, y: sourceLead.y }
      : { x: sourceLead.x, y: targetLead.y })
  }

  points.push(targetLead, { x: target.x, y: target.y })
  return simplifyRoute(points)
}

function routeToSvgPath(points: { x: number; y: number }[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function findClearPosition(
  preferredX: number,
  preferredY: number,
  width: number,
  height: number,
  tiles: TileState[],
  blockedTileIds: Set<string>,
  step: number
): { x: number; y: number } {
  const overlapsExisting = (x: number, y: number) => {
    const candidate = { x, y, w: width, h: height }
    return tiles.some(tile => !blockedTileIds.has(tile.id) && rectsOverlap(candidate, { x: tile.x, y: tile.y, w: tile.width, h: tile.height }))
  }

  let x = preferredX
  let y = preferredY
  if (!overlapsExisting(x, y)) return { x, y }

  const maxRings = 120
  for (let ring = 1; ring <= maxRings; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      const dy = ring - Math.abs(dx)
      const candidates = dy === 0
        ? [{ dx: dx * step, dy: 0 }]
        : [{ dx: dx * step, dy: dy * step }, { dx: dx * step, dy: -dy * step }]

      for (const cand of candidates) {
        x = preferredX + cand.dx
        y = preferredY + cand.dy
        if (!overlapsExisting(x, y)) {
          return { x, y }
        }
      }
    }
  }

  return { x, y }
}

function getRouteSegments(points: { x: number; y: number }[], thickness = 3): Array<{ left: number; top: number; width: number; height: number; horizontal: boolean }> {
  const segments: Array<{ left: number; top: number; width: number; height: number; horizontal: boolean }> = []

  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1]
    const end = points[i]
    const horizontal = start.y === end.y
    if (horizontal) {
      segments.push({
        left: Math.min(start.x, end.x),
        top: start.y - thickness / 2,
        width: Math.max(Math.abs(end.x - start.x), thickness),
        height: thickness,
        horizontal: true,
      })
    } else {
      segments.push({
        left: start.x - thickness / 2,
        top: Math.min(start.y, end.y),
        width: thickness,
        height: Math.max(Math.abs(end.y - start.y), thickness),
        horizontal: false,
      })
    }
  }

  return segments
}

function getRouteMidpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length <= 1) return points[0] ?? { x: 0, y: 0 }

  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y)
  }

  let remaining = total / 2
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1]
    const end = points[i]
    const segment = Math.abs(end.x - start.x) + Math.abs(end.y - start.y)
    if (remaining <= segment) {
      if (start.x === end.x) {
        const direction = end.y >= start.y ? 1 : -1
        return { x: start.x, y: start.y + remaining * direction }
      }
      const direction = end.x >= start.x ? 1 : -1
      return { x: start.x + remaining * direction, y: start.y }
    }
    remaining -= segment
  }

  return points[points.length - 1]
}

function getRouteSignature(points: { x: number; y: number }[]): string {
  const forward = points.map(point => `${point.x},${point.y}`).join('|')
  const reverse = [...points].reverse().map(point => `${point.x},${point.y}`).join('|')
  return forward < reverse ? forward : reverse
}

function getLaneOffsets(count: number): number[] {
  if (count <= 1) return [0]
  const offsets: number[] = []
  if (count % 2 === 1) offsets.push(0)
  let step = count % 2 === 1 ? 1 : 0.5
  while (offsets.length < count) {
    offsets.push(-step, step)
    step += 1
  }
  return offsets.slice(0, count)
}

function offsetOrthogonalRoute(points: { x: number; y: number }[], offset: number): { x: number; y: number }[] {
  if (!offset || points.length <= 1) return points

  return points.map((point, index) => {
    const prev = index > 0 ? points[index - 1] : null
    const next = index < points.length - 1 ? points[index + 1] : null
    const touchesHorizontal = (prev ? prev.y === point.y : false) || (next ? next.y === point.y : false)
    const touchesVertical = (prev ? prev.x === point.x : false) || (next ? next.x === point.x : false)

    return {
      x: point.x + (touchesVertical ? offset : 0),
      y: point.y + (touchesHorizontal ? offset : 0),
    }
  })
}

function formatGridBounds(bounds: TileSpatialReference['gridBounds']): string {
  return `${bounds.left},${bounds.top} → ${bounds.right},${bounds.bottom}`
}

function findDiscoveryMatch(sourceTileId: string, tileList: TileState[], hiddenTileIds: Set<string>, gridStep: number, maxDistance: number): { sourceRef: TileSpatialReference; match: DiscoveryMatch | null } | null {
  const sourceTile = tileList.find(tile => tile.id === sourceTileId)
  if (!sourceTile || hiddenTileIds.has(sourceTile.id)) return null

  const sourceRef = getTileSpatialReference(sourceTile, gridStep)
  let bestCompatible: DiscoveryMatch | null = null
  let bestFallback: DiscoveryMatch | null = null

  for (const candidate of tileList) {
    if (candidate.id === sourceTileId || hiddenTileIds.has(candidate.id)) continue
    const sourceRect = { x: sourceTile.x, y: sourceTile.y, w: sourceTile.width, h: sourceTile.height }
    const targetRect = { x: candidate.x, y: candidate.y, w: candidate.width, h: candidate.height }
    if (rectsOverlap(sourceRect, targetRect)) continue

    const targetRef = getTileSpatialReference(candidate, gridStep)
    const anchorPair = findBestAnchorPair(sourceRef.anchors, targetRef.anchors)
    if (!anchorPair || anchorPair.distance > maxDistance) continue

    const candidateMatch: DiscoveryMatch = {
      tile: candidate,
      route: getOrthogonalRoute(anchorPair.source, anchorPair.target, gridStep),
      distance: anchorPair.distance,
      matchLabels: getCapabilityMatches(sourceRef.capabilities, targetRef.capabilities),
      targetRef,
    }

    if (!bestFallback || candidateMatch.distance < bestFallback.distance) {
      bestFallback = candidateMatch
    }

    if (candidateMatch.matchLabels.length && (!bestCompatible || candidateMatch.distance < bestCompatible.distance)) {
      bestCompatible = candidateMatch
    }
  }

  const match = bestCompatible ?? (bestFallback ? {
    ...bestFallback,
    matchLabels: bestFallback.matchLabels.length ? bestFallback.matchLabels : ['nearest'],
  } : null)

  return { sourceRef, match }
}

function App(): JSX.Element {
  const [tiles, setTiles] = useState<TileState[]>([])
  const [groups, setGroups] = useState<GroupState[]>([])
  const [lockedConnections, setLockedConnections] = useState<Array<{ sourceTileId: string; targetTileId: string }>>([])
  const [viewport, setViewport] = useState({ tx: 0, ty: 0, zoom: 1 })
  const prevZoomRef = React.useRef(1)
  const panVelocityRef = useRef({ vx: 0, vy: 0 })
  const panLastPos = useRef({ x: 0, y: 0, t: 0 })
  const panInertiaRaf = useRef<number>(0)
  const [nextZIndex, setNextZIndex] = useState(1)
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null)
  const [selectedTileIds, setSelectedTileIds] = useState<Set<string>>(new Set())
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [dragState, setDragState] = useState<DragState>({ type: null })
  const [showMCP, setShowMCP] = useState(false)
  const [showSettings, setShowSettings] = useState<string | false>(false)
  const [showMinimap, setShowMinimap] = useState(false)
  const [expandedTileId, setExpandedTileId] = useState<string | null>(null)
  const [panelLayout, setPanelLayout] = useState<PanelNode | null>(null)
  const [chatReloadTokens, setChatReloadTokens] = useState<Record<string, number>>({})
  const [extActionsVersion, setExtActionsVersion] = useState(0)
  const [activePanelId, setActivePanelId] = useState<string | null>(null)
  const [expandLayoutGroupId, setExpandLayoutGroupId] = useState<string | null>(null)
  const expandLayoutGroupIdRef = useRef<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const persistCanvasStateRef = useRef<((...args: any[]) => void) | null>(null)
  const savedLayoutRef = useRef<PanelNode | null>(null)
  const panelLayoutRef = useRef<PanelNode | null>(null)
  const activePanelIdRef = useRef<string | null>(null)
  const expandedTileIdRef = useRef<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(() => readCachedSettings())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [sidebarPillVisible, setSidebarPillVisible] = useState(true)
  const [sidebarScrollMetrics, setSidebarScrollMetrics] = useState({ hasOverflow: false, topRatio: 0, thumbRatio: 1 })
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null)
  const [canvasArrangeMode, setCanvasArrangeMode] = useState<'grid' | 'column' | 'row' | null>(null)
  const [guides, setGuides] = useState<{ x?: number; y?: number }[]>([])
  const [discoveryPulses, setDiscoveryPulses] = useState<DiscoveryPulse[]>([])
  const [showAgentSetup, setShowAgentSetup] = useState(false)
  const { extensionTiles, extensionEntries } = useExtensions(
    workspace?.path ?? null,
    !settings.extensionsDisabled,
  )
  const extensionNameById = useMemo(
    () => new Map((extensionEntries ?? []).map(entry => [entry.id, entry.name] as const)),
    [extensionEntries],
  )
  const [systemPrefersDark, setSystemPrefersDark] = useState(true)
  const [brandWordmarkIndex, setBrandWordmarkIndex] = useState(1)
  const [brandPaletteIndex, setBrandPaletteIndex] = useState(0)
  const [brandPrefsReadyTheme, setBrandPrefsReadyTheme] = useState<string | null>(null)
  const [pendingSessionOpen, setPendingSessionOpen] = useState<PendingSessionOpen | null>(null)
  const [showWorkspacePickerTab, setShowWorkspacePickerTab] = useState(false)
  const [workspacePickerReturnWorkspaceId, setWorkspacePickerReturnWorkspaceId] = useState<string | null>(null)
  const latestSettingsSaveRef = useRef(0)

  useEffect(() => { panelLayoutRef.current = panelLayout }, [panelLayout])
  useEffect(() => { activePanelIdRef.current = activePanelId }, [activePanelId])
  useEffect(() => { expandedTileIdRef.current = expandedTileId }, [expandedTileId])
  const currentWorkspaceIdRef = useRef<string | null>(workspace?.id ?? null)
  useEffect(() => { currentWorkspaceIdRef.current = workspace?.id ?? null }, [workspace?.id])

  const selectedWorkspaceFilePath = useMemo(() => {
    if (!workspace?.path) return null

    const tileById = new Map(tiles.map(tile => [tile.id, tile]))
    const toWorkspaceFilePath = (tileId: string | null | undefined): string | null => {
      if (!tileId) return null
      const filePath = tileById.get(tileId)?.filePath
      return filePath && filePath.startsWith(workspace.path) ? filePath : null
    }

    if (panelLayout && activePanelId) {
      const leaf = findLeafById(panelLayout, activePanelId)
      const panelPath = toWorkspaceFilePath(leaf?.activeTab)
      if (panelPath) return panelPath
    }

    const expandedPath = toWorkspaceFilePath(expandedTileId)
    if (expandedPath) return expandedPath

    const selectedPath = toWorkspaceFilePath(selectedTileId)
    if (selectedPath) return selectedPath

    for (const tileId of selectedTileIds) {
      const multiSelectedPath = toWorkspaceFilePath(tileId)
      if (multiSelectedPath) return multiSelectedPath
    }

    return null
  }, [workspace?.path, tiles, panelLayout, activePanelId, expandedTileId, selectedTileId, selectedTileIds])

  useEffect(() => {
    setSidebarSelectedPath(null)
  }, [workspace?.id])

  useEffect(() => {
    if (selectedWorkspaceFilePath) setSidebarSelectedPath(selectedWorkspaceFilePath)
  }, [selectedWorkspaceFilePath])

  const getPanelTileLabel = useCallback((tileId: string): string => {
    const tile = tiles.find(ti => ti.id === tileId)
    if (!tile) return 'Unknown'
    if (tile.label?.trim()) return tile.label.trim()
    if (tile.filePath) return tile.filePath.replace(/\\/g, '/').split('/').pop() ?? tile.filePath
    if (tile.type.startsWith('ext:')) {
      const friendlyName = extensionNameById.get(tile.type.slice(4))
      if (friendlyName?.trim()) return friendlyName.trim()
    }
    return tile.type.charAt(0).toUpperCase() + tile.type.slice(1)
  }, [extensionNameById, tiles])

  // Workspace pill tabs — open workspace ids within this window
  const [openWorkspaceIds, setOpenWorkspaceIds] = useState<string[]>([])
  useEffect(() => {
    if (workspace?.id) setOpenWorkspaceIds(prev => prev.includes(workspace.id) ? prev : [...prev, workspace.id])
  }, [workspace?.id])

  // ─── Auto Agent Mode Effect ───────────────────────────────────────────────
  // Automatically enables agentMode on chat tiles when they get close to compatible tiles
  useEffect(() => {
    if (!workspace?.id) return
    // Skip during drag operations to avoid lag
    if (dragState.type !== null) return

    const gridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
    const maxDistance = getDiscoveryMaxDistance(settings.gridSpacingLarge || DEFAULT_SETTINGS.gridSpacingLarge)
    const enableThreshold = maxDistance * PROXIMITY_ENABLE_DISTANCE
    const disableThreshold = maxDistance * PROXIMITY_DISABLE_DISTANCE

    // Find all chat tiles and their proximity status
    const chatTileProximities = new Map<string, { hasMatch: boolean; distance: number }>()
    
    for (const tile of tiles) {
      if (tile.type !== 'chat') continue
      
      const discovery = findDiscoveryMatch(tile.id, tiles, panelTileIdsRef.current, gridStep, maxDistance)
      const hasCompatibleMatch = Boolean(
        discovery?.match && discovery.match.matchLabels.length > 0
          && !(discovery.match.matchLabels.length === 1 && discovery.match.matchLabels[0] === 'nearest')
      )
      if (!hasCompatibleMatch) {
        chatTileProximities.set(tile.id, { hasMatch: false, distance: Infinity })
      } else {
        chatTileProximities.set(tile.id, { hasMatch: true, distance: discovery.match.distance })
      }
    }

    // Clear existing debounce timer
    if (proximityDebounceTimerRef.current) {
      window.clearTimeout(proximityDebounceTimerRef.current)
    }

    // Debounce the state changes
    proximityDebounceTimerRef.current = window.setTimeout(() => {
      const autoEnabled = autoAgentModeTilesRef.current
      const timers = autoAgentModeTimersRef.current
      const now = Date.now()
      let hasChanges = false
      const newAutoEnabled = new Set(autoEnabled)

      for (const [tileId, proximity] of chatTileProximities) {
        const isAutoEnabled = autoEnabled.has(tileId)
        const lastChange = timers.get(tileId) || 0
        const timeSinceChange = now - lastChange

        // Minimum time between toggles to prevent thrashing (1 second)
        if (timeSinceChange < 1000) continue

        if (!isAutoEnabled && proximity.hasMatch && proximity.distance <= enableThreshold) {
          // Auto-enable agentMode
          newAutoEnabled.add(tileId)
          timers.set(tileId, now)
          hasChanges = true
          
          // Update tile state
          setTiles(prev => prev.map(t => {
            if (t.id !== tileId) return t
            return { ...t, autoAgentMode: true }
          }))
          
          // Save tile state
          void window.electron.canvas.saveTileState(workspace.id, tileId, {
            agentMode: true,
            autoAgentMode: true,
          })
          
          console.log(`[AutoAgent] Enabled agentMode for ${tileId} (distance: ${Math.round(proximity.distance)}px)`)
        } else if (isAutoEnabled && (!proximity.hasMatch || proximity.distance > disableThreshold)) {
          // Auto-disable agentMode
          newAutoEnabled.delete(tileId)
          timers.set(tileId, now)
          hasChanges = true
          
          // Update tile state
          setTiles(prev => prev.map(t => {
            if (t.id !== tileId) return t
            return { ...t, autoAgentMode: false }
          }))
          
          // Save tile state
          void window.electron.canvas.saveTileState(workspace.id, tileId, {
            agentMode: false,
            autoAgentMode: false,
          })
          
          console.log(`[AutoAgent] Disabled agentMode for ${tileId}`)
        }
      }

      if (hasChanges) {
        autoAgentModeTilesRef.current = newAutoEnabled
      }
    }, PROXIMITY_DEBOUNCE_MS)

    return () => {
      if (proximityDebounceTimerRef.current) {
        window.clearTimeout(proximityDebounceTimerRef.current)
      }
    }
  }, [tiles, dragState.type, settings.gridSize, settings.gridSpacingSmall, settings.gridSpacingLarge, workspace?.id])

  // Internal clipboard — stores tile snapshots (not OS clipboard)
  const clipboard = useRef<TileState[]>([])
  const isCut = useRef(false)
  const pasteOffset = useRef(0)
  const pasteTargetGroupId = useRef<string | undefined>(undefined)
  const pasteTilesRef = useRef<(pos?: { x: number; y: number }, intoGroupId?: string) => void>(() => {})
  const duplicateTilesRef = useRef<(ids?: string[]) => void>(() => {})
  const copyTilesRef = useRef<(cut?: boolean) => void>(() => {})
  const groupSelectedTilesRef = useRef<() => void>(() => {})
  const groupBoundsRef = useRef<(id: string) => { x: number; y: number; w: number; h: number } | null>(() => null)
  const ungroupTilesRef = useRef<(groupId: string) => void>(() => {})
  const ungroupAllRef = useRef<(groupId: string) => void>(() => {})

  // Undo/redo history stacks — each entry is a full canvas snapshot
  type HistoryEntry = { tiles: TileState[]; groups: GroupState[] }
  const historyBack = useRef<HistoryEntry[]>([])
  const historyForward = useRef<HistoryEntry[]>([])
  // Refs that always reflect the latest tiles/groups state (for use in keyboard handlers)
  const tilesRef = useRef<TileState[]>(tiles)
  const groupsRef = useRef<GroupState[]>(groups)
  const lockedConnectionsRef = useRef(lockedConnections)
  useEffect(() => { lockedConnectionsRef.current = lockedConnections }, [lockedConnections])
  const [suppressedConnections, setSuppressedConnections] = useState<Set<string>>(new Set())
  const suppressedConnectionsRef = useRef(suppressedConnections)
  useEffect(() => { suppressedConnectionsRef.current = suppressedConnections }, [suppressedConnections])

  const viewportRef = useRef(viewport)
  const nextZIndexRef = useRef(nextZIndex)

  // Keep tilesRef / groupsRef / viewportRef / nextZIndexRef in sync with state
  tilesRef.current = tiles
  groupsRef.current = groups
  viewportRef.current = viewport
  nextZIndexRef.current = nextZIndex

  // Context menus
  type CtxMenu = { x: number; y: number; items: MenuItem[] }
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const closeCtx = useCallback(() => setCtxMenu(null), [])

  const canvasRef = useRef<HTMLDivElement>(null)
  const dotGlowSmallRef = useRef<HTMLDivElement>(null)
  const dotGlowLargeRef = useRef<HTMLDivElement>(null)
  const discoveryGlowRef = useRef<HTMLDivElement>(null)
  const discoveryTimeoutsRef = useRef<number[]>([])

  // ─── Auto Agent Mode (proximity-based tile discovery) ─────────────────────
  // Tracks which chat tiles have auto-enabled agentMode due to proximity
  const autoAgentModeTilesRef = useRef<Set<string>>(new Set())
  // Tracks timestamps for hysteresis (prevent rapid toggle at boundary)
  const autoAgentModeTimersRef = useRef<Map<string, number>>(new Map())
  // Debounce timer for batching proximity changes
  const proximityDebounceTimerRef = useRef<number | null>(null)
  // HYSTERESIS_GAP: disable threshold is larger than enable threshold to prevent thrashing
  const PROXIMITY_ENABLE_DISTANCE = 0.8 // 80% of max distance
  const PROXIMITY_DISABLE_DISTANCE = 1.0 // 100% of max distance
  const PROXIMITY_DEBOUNCE_MS = 300
  const panelTileIdsRef = useRef<Set<string>>(new Set())
  const canvasGlowRafRef = useRef<number | null>(null)
  const canvasGlowPointRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spaceHeld = useRef(false)
  const skipHistory = useRef(false)
  const canvasGlowEnabled = settings.canvasGlowEnabled
  const canvasGlowRadius = Math.max(50, Math.min(200, settings.canvasGlowRadius ?? 120))
  const cursorGlowBrightnessScale = 1 + ((viewport.zoom - 1) / 0.2) * 0.1
  const cursorGlowOpacity = Math.max(0, Math.min(1, cursorGlowBrightnessScale))
  const cursorGlowFilterBrightness = Math.max(1, cursorGlowBrightnessScale)
  const snapValue = React.useCallback((value: number) => (
    settings.snapToGrid ? snap(value, settings.gridSize) : value
  ), [settings.snapToGrid, settings.gridSize])

  const hideCanvasGlow = React.useCallback(() => {
    if (canvasGlowRafRef.current !== null) {
      cancelAnimationFrame(canvasGlowRafRef.current)
      canvasGlowRafRef.current = null
    }
    canvasGlowPointRef.current = null
    if (dotGlowSmallRef.current) {
      dotGlowSmallRef.current.style.opacity = '0'
      dotGlowSmallRef.current.style.filter = 'brightness(1)'
    }
    if (dotGlowLargeRef.current) {
      dotGlowLargeRef.current.style.opacity = '0'
      dotGlowLargeRef.current.style.filter = 'brightness(1)'
    }
    if (discoveryGlowRef.current) discoveryGlowRef.current.style.opacity = '0'
  }, [])

  const updateCanvasGlow = React.useCallback((clientX: number, clientY: number) => {
    if (!canvasGlowEnabled) return
    canvasGlowPointRef.current = { clientX, clientY }
    if (canvasGlowRafRef.current !== null) return
    canvasGlowRafRef.current = requestAnimationFrame(() => {
      canvasGlowRafRef.current = null
      const rect = canvasRef.current?.getBoundingClientRect()
      const point = canvasGlowPointRef.current
      if (!rect || !point || !dotGlowSmallRef.current || !dotGlowLargeRef.current) return
      const x = point.clientX - rect.left
      const y = point.clientY - rect.top
      const visible = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
      if (!visible) {
        hideCanvasGlow()
        return
      }
      const innerGlowRadius = Math.round(canvasGlowRadius * 0.5)
      const mask = `radial-gradient(circle at ${x}px ${y}px, rgba(0,0,0,1) 0px, rgba(0,0,0,1) ${innerGlowRadius}px, rgba(0,0,0,0) ${canvasGlowRadius}px)`
      dotGlowSmallRef.current.style.opacity = String(cursorGlowOpacity)
      dotGlowLargeRef.current.style.opacity = String(cursorGlowOpacity)
      dotGlowSmallRef.current.style.filter = `brightness(${cursorGlowFilterBrightness})`
      dotGlowLargeRef.current.style.filter = `brightness(${cursorGlowFilterBrightness})`
      dotGlowSmallRef.current.style.maskImage = mask
      dotGlowSmallRef.current.style.webkitMaskImage = mask
      dotGlowLargeRef.current.style.maskImage = mask
      dotGlowLargeRef.current.style.webkitMaskImage = mask
      if (discoveryGlowRef.current) {
        discoveryGlowRef.current.style.opacity = '1'
        discoveryGlowRef.current.style.maskImage = mask
        discoveryGlowRef.current.style.webkitMaskImage = mask
      }
    })
  }, [canvasGlowEnabled, canvasGlowRadius, cursorGlowFilterBrightness, cursorGlowOpacity, hideCanvasGlow])

  const showEmptyLayoutPage = useCallback((options?: { preserveOpenTabs?: boolean }) => {
    const preserveOpenTabs = options?.preserveOpenTabs ?? false
    const emptyPanel = createLeaf([])
    setShowWorkspacePickerTab(true)
    setWorkspacePickerReturnWorkspaceId(preserveOpenTabs ? currentWorkspaceIdRef.current : null)
    setWorkspace(null)
    if (!preserveOpenTabs) setOpenWorkspaceIds([])
    setTiles([])
    setGroups([])
    setLockedConnections([])
    setViewport({ tx: 0, ty: 0, zoom: 1 })
    setNextZIndex(1)
    savedLayoutRef.current = emptyPanel
    setPanelLayout(emptyPanel)
    setActivePanelId(emptyPanel.id)
    setExpandedTileId(null)
  }, [])

  // ─── Load workspace + canvas state on mount ───────────────────────────────
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings))
    } catch {}
  }, [settings])

  const updateAppSettings = useCallback((patch: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>)) => {
    setSettings(current => {
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch
      const next = withDefaultSettings({ ...current, ...resolvedPatch })
      const requestId = ++latestSettingsSaveRef.current
      void window.electron.settings?.set(next).then(saved => {
        if (!saved || requestId !== latestSettingsSaveRef.current) return
        setSettings(withDefaultSettings(saved))
      }).catch(err => {
        console.warn('[settings] Failed to persist app settings patch:', err)
      })
      return next
    })
  }, [])

  useEffect(() => {
    async function init(): Promise<void> {
      if (!window.electron) {
        console.warn('window.electron not available — preload may not have loaded')
        return
      }
      const isFresh = await window.electron.window.isFresh()
      const [wsList, active, savedSettings] = await Promise.all([
        window.electron.workspace.list(),
        isFresh ? Promise.resolve(null) : window.electron.workspace.getActive(),
        window.electron.settings?.get()
      ])
      if (savedSettings) setSettings(withDefaultSettings(savedSettings))
      setWorkspaces(wsList)
      setWorkspace(active)
      if (!active) {
        showEmptyLayoutPage()
        return
      }
      if (active) {
        const saved: CanvasState | null = await window.electron.canvas.load(active.id)
        const savedTiles = saved?.tiles ?? []
        void window.electron.collab.pruneOrphanedTileDirs(active.path, savedTiles.map(tile => tile.id))
        if (saved) {
          const sanitizedPanel = sanitizePanelLayout((saved.panelLayout as PanelNode | null) ?? null, savedTiles.map(tile => tile.id))
          const nextActivePanelId = saved.activePanelId && sanitizedPanel.layout && findLeafById(sanitizedPanel.layout, saved.activePanelId)
            ? saved.activePanelId
            : sanitizedPanel.fallbackActivePanelId
          setTiles(savedTiles)
          setGroups(saved.groups ?? [])
          setLockedConnections(saved.lockedConnections ?? [])
          setViewport(saved.viewport
            ? { tx: saved.viewport.tx, ty: saved.viewport.ty, zoom: saved.viewport.zoom }
            : { tx: 0, ty: 0, zoom: 1 })
          setNextZIndex(saved.nextZIndex ?? 1)
          savedLayoutRef.current = sanitizedPanel.layout
          setPanelLayout(saved.tabViewActive ? (sanitizedPanel.layout ?? createLeaf([])) : null)
          setActivePanelId(saved.tabViewActive ? nextActivePanelId : null)
          setExpandedTileId(saved.expandedTileId ?? null)
        }
      }
    }
    init()

    // Check if agent setup is needed (first run or paths not confirmed)
    // Force with: CONTEX_SHOW_SETUP=1 npm run dev
    const forceSetup = import.meta.env.VITE_SHOW_SETUP === '1'
    if (forceSetup) {
      setShowAgentSetup(true)
    } else {
      window.electron?.agentPaths?.needsSetup?.().then((needs: boolean) => {
        if (needs) setShowAgentSetup(true)
      }).catch(() => {})
    }
  }, [showEmptyLayoutPage])

  // ─── Subscribe to custom theme registrations from extensions ─────────────
  useEffect(() => {
    const subscriberId = 'app:theme-bus'
    window.electron.bus?.subscribe('themes', subscriberId, () => {})
    const unsubEvent = window.electron.bus?.onEvent((event: { channel: string; payload: unknown }) => {
      if (event?.channel !== 'themes') return
      const data = event.payload as { action?: string; theme?: unknown; themeId?: string } | null
      if (!data) return
      if (data.action === 'register' && data.theme) {
        try { registerCustomTheme(data.theme as Parameters<typeof registerCustomTheme>[0]) } catch { /* skip invalid */ }
      }
      if (data.action === 'apply' && data.theme) {
        try {
          registerCustomTheme(data.theme as Parameters<typeof registerCustomTheme>[0])
          if (data.themeId) setSettings(s => ({ ...s, themeId: data.themeId as string }))
        } catch { /* skip invalid */ }
      }
      if (data.action === 'delete') {
        const deletedThemeId = typeof (data as { id?: unknown }).id === 'string' ? (data as { id: string }).id : ''
        if (!deletedThemeId) return
        unregisterCustomTheme(deletedThemeId)
        setSettings(s => s.themeId === deletedThemeId ? { ...s, themeId: DEFAULT_THEME_ID } : s)
      }
    })
    return () => {
      window.electron.bus?.unsubscribeAll(subscriberId)
      unsubEvent?.()
    }
  }, [])

  // ─── Escape to collapse expanded tile ────────────────────────────────────
  const exitExpandedMode = useCallback(() => {
    const expandingGroup = expandLayoutGroupIdRef.current
    setPanelLayout(prev => {
      if (expandingGroup && prev) {
        // Save layout back to the group instead of the global savedLayoutRef
        setGroups(grps => {
          const updated = grps.map(g => g.id === expandingGroup ? { ...g, layout: prev } : g)
          setTimeout(() => persistCanvasStateRef.current?.(tilesRef.current, viewportRef.current, nextZIndexRef.current, updated), 0)
          return updated
        })
      } else if (!expandingGroup) {
        savedLayoutRef.current = prev
      }
      return null
    })
    setExpandedTileId(null)
    setActivePanelId(null)
    setExpandLayoutGroupId(null)
    expandLayoutGroupIdRef.current = null
  }, [])

  const enterExpandedMode = useCallback((tileId: string) => {
    // All open tiles become tabs, with the expanded tile as the active one
    const allIds = tilesRef.current.map(t => t.id)
    const leaf = createLeaf(allIds, tileId)
    setExpandedTileId(tileId)
    setPanelLayout(leaf)
    setActivePanelId(leaf.id)
  }, [])

  const enterTabbedView = useCallback(() => {
    const currentIds = tilesRef.current.map(t => t.id)
    const currentIdSet = new Set(currentIds)

    if (savedLayoutRef.current) {
      // Restore saved layout — prune removed tiles, append any new ones
      let restored: PanelNode = savedLayoutRef.current

      // Remove tiles that no longer exist on canvas
      const savedIds = getAllTileIds(savedLayoutRef.current)
      for (const id of savedIds) {
        if (!currentIdSet.has(id)) {
          restored = removeTileFromTree(restored, id) ?? restored
        }
      }

      // Append new tiles (not in saved layout) to the first leaf
      const restoredIds = new Set(getAllTileIds(restored))
      const newIds = currentIds.filter(id => !restoredIds.has(id))
      // Find active panel id from restored tree
      const firstLeaf = (function find(n: PanelNode): string | null {
        if (n.type === 'leaf') return n.id
        return find(n.children[0])
      })(restored)

      for (const id of newIds) {
        if (firstLeaf) restored = addTabToLeaf(restored, firstLeaf, id)
      }

      setPanelLayout(restored)
      setActivePanelId(firstLeaf)
      setExpandedTileId(null)
    } else {
      // No saved layout — fresh leaf with all tiles
      const leaf = createLeaf(currentIds, currentIds[0])
      setPanelLayout(leaf)
      setActivePanelId(leaf.id)
      setExpandedTileId(null)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitExpandedMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exitExpandedMode])

  // ─── Space key for pan mode ───────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        spaceHeld.current = true
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // ─── Cmd+0 reset zoom ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        setViewport(prev => ({ ...prev, zoom: 1 }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ─── Auto-save canvas state ───────────────────────────────────────────────
  const persistCanvasState = useCallback((tileList: TileState[], vp: { tx: number; ty: number; zoom: number }, nz: number, grps?: GroupState[]) => {
    if (!workspace) return
    const resolvedGroups = grps ?? groupsRef.current

    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const state: CanvasState = {
        tiles: tileList,
        groups: resolvedGroups,
        viewport: vp,
        nextZIndex: nz,
        panelLayout: panelLayoutRef.current ?? savedLayoutRef.current,
        activePanelId: activePanelIdRef.current,
        tabViewActive: Boolean(panelLayoutRef.current),
        expandedTileId: expandedTileIdRef.current,
        lockedConnections: lockedConnectionsRef.current.length > 0 ? lockedConnectionsRef.current : undefined,
      }
      window.electron.canvas.save(workspace.id, state)
    }, 500)
  }, [workspace])

  const saveCanvas = useCallback((tileList: TileState[], vp: { tx: number; ty: number; zoom: number }, nz: number, grps?: GroupState[]) => {
    if (!workspace) return
    // Use explicitly passed groups, or fall back to current groups state
    const resolvedGroups = grps ?? groupsRef.current

    // Push to undo history unless this save was triggered by undo/redo itself
    if (!skipHistory.current) {
      historyBack.current.push({ tiles: tilesRef.current, groups: groupsRef.current })
      if (historyBack.current.length > 50) historyBack.current.shift()
      historyForward.current = []
    }

    persistCanvasState(tileList, vp, nz, resolvedGroups)
  }, [workspace, persistCanvasState])

  // ─── Coordinate helpers ───────────────────────────────────────────────────
  useEffect(() => {
    if (!workspace) return
    persistCanvasState(tiles, viewport, nextZIndex, groups)
  }, [workspace, panelLayout, activePanelId, expandedTileId, persistCanvasState, tiles, viewport, nextZIndex, groups])

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (sx - rect.left - viewport.tx) / viewport.zoom,
      y: (sy - rect.top - viewport.ty) / viewport.zoom
    }
  }, [viewport])

  const viewportCenter = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 200, y: 100 }
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [screenToWorld])

  const worldToScreenPoint = useCallback((point: { x: number; y: number }) => ({
    x: point.x * viewport.zoom + viewport.tx,
    y: point.y * viewport.zoom + viewport.ty,
  }), [viewport])

  const worldToScreenRect = useCallback((tile: TileState) => ({
    left: tile.x * viewport.zoom + viewport.tx,
    top: tile.y * viewport.zoom + viewport.ty,
    width: tile.width * viewport.zoom,
    height: tile.height * viewport.zoom,
  }), [viewport])

  const triggerDiscoveryPulse = useCallback((tileId: string, tileList: TileState[]) => {
    const gridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
    const maxDistance = getDiscoveryMaxDistance(settings.gridSpacingLarge || DEFAULT_SETTINGS.gridSpacingLarge)
    const discovery = findDiscoveryMatch(tileId, tileList, panelTileIdsRef.current, gridStep, maxDistance)
    if (!discovery?.match) return

    const sourceTile = tileList.find(tile => tile.id === tileId)
    if (!sourceTile) return

    const pulse: DiscoveryPulse = {
      id: `pulse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceTileId: sourceTile.id,
      targetTileId: discovery.match.tile.id,
      route: discovery.match.route,
      startedAt: Date.now(),
      durationMs: DISCOVERY_PULSE_DURATION_MS,
      matchLabels: discovery.match.matchLabels,
      sourceGridLabel: formatGridBounds(discovery.sourceRef.gridBounds),
      targetGridLabel: formatGridBounds(discovery.match.targetRef.gridBounds),
    }

    setDiscoveryPulses(prev => {
      const next = prev.filter(existing => !(existing.sourceTileId === pulse.sourceTileId && existing.targetTileId === pulse.targetTileId))
      return [...next, pulse]
    })

    const timeout = window.setTimeout(() => {
      setDiscoveryPulses(prev => prev.filter(existing => existing.id !== pulse.id))
    }, pulse.durationMs + 180)
    discoveryTimeoutsRef.current.push(timeout)
  }, [settings.gridSize, settings.gridSpacingSmall, settings.gridSpacingLarge])

  const getInitialTileSize = useCallback((type: TileState['type']) => {
    const configured = settings.defaultTileSizes[type]
    if (configured) return configured
    if (type.startsWith('ext:')) {
      const extDefault = extensionTiles.find(ext => ext.type === type)?.defaultSize
      if (extDefault) return extDefault
      return { w: 360, h: 280 }
    }
    return { w: 600, h: 400 }
  }, [settings.defaultTileSizes, extensionTiles])

  const pinnedCanvasExtensionTiles = useMemo(() => {
    if (settings.extensionsDisabled) return []
    const pinned = new Set(settings.pinnedExtensionIds ?? [])
    if (pinned.size === 0) return []
    return extensionTiles.filter(ext => pinned.has(ext.extId) || pinned.has(ext.type))
  }, [settings.extensionsDisabled, settings.pinnedExtensionIds, extensionTiles])

  // ─── Tile creation ────────────────────────────────────────────────────────
  const addTile = useCallback((type: TileState['type'], filePath?: string, pos?: { x: number; y: number }, initialOptions?: { hideTitlebar?: boolean; hideNavbar?: boolean; launchBin?: string; launchArgs?: string[] }) => {
    const center = pos ?? viewportCenter()
    const { w, h } = getInitialTileSize(type)
    const minW = getMinTileWidth(type)
    const minH = getMinTileHeight(type)
    const width = Math.max(w, minW)
    const height = Math.max(h, minH)
    const placementStep = Math.max(16, settings.gridSize || settings.gridSpacingSmall || GRID)
    const preferred = {
      x: snapValue(center.x - width / 2),
      y: snapValue(center.y - height / 2),
    }
    const position = findClearPosition(preferred.x, preferred.y, width, height, tilesRef.current, panelTileIdsRef.current, placementStep)

    // Media files (image/video/audio/PDF) open chromeless by default — hides
    // both the tile titlebar and the browser navbar so the content fills the
    // block. User can right-click to restore controls. Caller can override.
    const isMedia = !!filePath && isMediaFile(filePath)
    const defaultHideTitlebar = isMedia ? true : undefined
    const defaultHideNavbar = isMedia ? true : undefined

    const newTile: TileState = {
      id: `tile-${Date.now()}`,
      type,
      x: position.x,
      y: position.y,
      width,
      height,
      zIndex: nextZIndex,
      filePath,
      hideTitlebar: initialOptions?.hideTitlebar ?? defaultHideTitlebar,
      hideNavbar: initialOptions?.hideNavbar ?? defaultHideNavbar,
      launchBin: initialOptions?.launchBin,
      launchArgs: initialOptions?.launchArgs,
    }
    const newNZ = nextZIndex + 1
    setTiles(prev => {
      const updated = [...prev, newTile]
      saveCanvas(updated, viewport, newNZ)
      return updated
    })
    setNextZIndex(newNZ)
    setSelectedTileId(newTile.id)
    window.setTimeout(() => triggerDiscoveryPulse(newTile.id, [...tilesRef.current, newTile]), 40)

    // If in expanded/tabbed mode, add as a tab to the active panel
    if (panelLayout && activePanelId) {
      setPanelLayout(prev => prev ? addTabToLeaf(prev, activePanelId, newTile.id) : prev)
    }

    return newTile.id
  }, [nextZIndex, viewport, viewportCenter, saveCanvas, panelLayout, activePanelId, getInitialTileSize, snapValue, triggerDiscoveryPulse, settings.gridSize, settings.gridSpacingSmall])

  useEffect(() => {
    if (!tiles.some(tile => tile.width < getMinTileWidth(tile) || tile.height < getMinTileHeight(tile))) return
    setTiles(prev => {
      let changed = false
      const updated = prev.map(tile => {
        const minW = getMinTileWidth(tile)
        const minH = getMinTileHeight(tile)
        if (tile.width >= minW && tile.height >= minH) return tile
        changed = true
        return {
          ...tile,
          width: Math.max(tile.width, minW),
          height: Math.max(tile.height, minH),
        }
      })
      if (!changed) return prev
      saveCanvas(updated, viewport, nextZIndex)
      return updated
    })
  }, [tiles, viewport, nextZIndex, saveCanvas])

  // ─── MCP canvas tool handlers (must be after addTile) ────────────────────
  useEffect(() => {
    const el = (window as any).electron?.mcp
    if (!el?.onKanban) return
    const cleanup = el.onKanban((event: string, data: any) => {
      if (event === 'canvas_create_tile') {
        addTile((data.type ?? 'note') as TileState['type'], data.filePath, data.x !== undefined ? { x: data.x, y: data.y } : undefined)
      }
      if (event === 'canvas_open_file') {
        void resolveFileTileType(data.path).then(type => addTile(type, data.path))
      }
      if (event === 'canvas_pan_to') {
        setViewport(prev => ({ ...prev, tx: data.x, ty: data.y }))
      }
      if (event === 'canvas_list_tiles') {
        const tileList = tiles.map(t => ({ id: t.id, type: t.type, filePath: t.filePath, x: t.x, y: t.y }))
        ;(window as any).electron?.mcp?.getPort?.().then((port: number | null) => {
          if (!port) return
          fetch(`http://127.0.0.1:${port}/push`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card_id: 'global', event: 'canvas_tiles_response', data: { tiles: tileList } })
          }).catch(() => {})
        })
      }
    })
    return cleanup
  }, [tiles, addTile])

  const closeTile = useCallback((id: string) => {
    const tile = tilesRef.current.find(t => t.id === id)
    if (tile?.type === 'terminal') {
      window.electron.terminal.destroy(id)
    }
    if (tile?.type === 'chat') {
      disposeChatTileRuntimeState(id)
    }
    if (tile?.type === 'media') {
      // Pause, clear src, detach the persistent <video>/<audio> node so
      // codecs are released and playback stops immediately.
      disposeMediaTile(id)
    }
    // System-level cleanup for every tile type: drops bus history pinned to
    // tile:${id}*, clears peer state, and schedules a debounced GC on main
    // and all renderers (requires --expose-gc, see package.json dev script).
    void window.electron.system.cleanupTile(id)
    if (workspace?.id) {
      void Promise.allSettled([
        window.electron.canvas.deleteTileArtifacts(workspace.id, id),
        window.electron.activity.clearTile(workspace.id, id),
        workspace.path ? window.electron.collab.removeTileDir(workspace.path, id) : Promise.resolve(true),
      ])
    }
    setTiles(prev => {
      const updated = prev.filter(t => t.id !== id)
      saveCanvas(updated, viewport, nextZIndex)
      return updated
    })
    setPanelLayout(prev => {
      if (!prev) return prev
      const next = removeTileFromTree(prev, id)
      if (next) return next
      const emptyLeaf = createLeaf([])
      setActivePanelId(emptyLeaf.id)
      return emptyLeaf
    })
    if (selectedTileId === id) setSelectedTileId(null)
  }, [workspace?.id, workspace?.path, selectedTileId, viewport, nextZIndex, saveCanvas])

  const bringToFront = useCallback((id: string) => {
    const nz = nextZIndex
    setTiles(prev => {
      const tile = prev.find(t => t.id === id)
      pasteTargetGroupId.current = tile?.groupId
      return prev.map(t => t.id === id ? { ...t, zIndex: nz } : t)
    })
    setNextZIndex(n => n + 1)
    setSelectedTileId(id)
  }, [nextZIndex])

  // ─── Canvas mouse handlers ────────────────────────────────────────────────
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    // Block if click originated from a tile or UI element (they stopPropagation — so anything
    // that reaches here is either the canvas bg, world container, or group frames)
    const t = e.target as HTMLElement
    // If the target has a tile chrome ancestor, ignore (tiles call stopPropagation on titlebar)
    if (t.closest('[data-tile-chrome]')) return
    e.preventDefault()
    const isPan = e.button === 1 || (e.button === 0 && (e.metaKey || spaceHeld.current))
    if (isPan) {
      cancelAnimationFrame(panInertiaRaf.current)
      panVelocityRef.current = { vx: 0, vy: 0 }
      panLastPos.current = { x: e.clientX, y: e.clientY, t: performance.now() }
      setDragState({ type: 'pan', startX: e.clientX, startY: e.clientY, initTx: viewport.tx, initTy: viewport.ty })
      setSelectedTileId(null)
      return
    }
    if (e.button === 0) {
      // Start rubber-band select on empty canvas
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const wx = (e.clientX - rect.left - viewport.tx) / viewport.zoom
      const wy = (e.clientY - rect.top - viewport.ty) / viewport.zoom
      setDragState({ type: 'select', startWx: wx, startWy: wy, curWx: wx, curWy: wy })
      setSelectedTileIds(new Set())
      setSelectedTileId(null)
    }
  }, [viewport])

  // Double-click on blank canvas creates a terminal (not in tab view, not over a tile)
  const handleCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    if (panelLayout) return
    if (e.target !== e.currentTarget) return
    const world = screenToWorld(e.clientX, e.clientY)
    addTile('terminal', undefined, world)
  }, [screenToWorld, addTile, panelLayout])

  // Right-click on empty canvas
  const handleCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (panelLayout) return
    const world = screenToWorld(e.clientX, e.clientY)
    const hitGroup = groups.find(g => {
      const b = groupBoundsRef.current(g.id)
      return b && world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h
    })
    const items: MenuItem[] = [
      { label: 'New Terminal', action: () => addTile('terminal', undefined, world) },
      { label: 'New Note',     action: () => addTile('note',     undefined, world) },
      { label: 'New Browser',  action: () => addTile('browser',  undefined, world) },
      { label: 'New Board',    action: () => addTile('kanban',   undefined, world) },
    ]
    // Extension tile types
    if (pinnedCanvasExtensionTiles.length > 0) {
      items.push({ label: '', action: () => {}, divider: true })
      for (const ext of pinnedCanvasExtensionTiles) {
        items.push({
          label: ext.label,
          action: () => addTile(ext.type as TileType, undefined, world),
        })
      }
    }
    if (clipboard.current.length > 0) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: 'Paste', action: () => pasteTilesRef.current(world) })
      if (hitGroup) {
        items.push({ label: 'Paste into group', action: () => pasteTilesRef.current(world, hitGroup.id) })
      }
    }
    if (selectedTileIds.size >= 2) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: `Group ${selectedTileIds.size} blocks`, action: () => groupSelectedTilesRef.current() })
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [screenToWorld, addTile, selectedTileIds, groups, panelLayout, pinnedCanvasExtensionTiles])

  // Right-click on a tile titlebar
  const handleTileContextMenu = useCallback((e: React.MouseEvent, tile: TileState) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = [
      { label: 'Duplicate', action: () => duplicateTilesRef.current([tile.id]) },
      { label: 'Copy',      action: () => { setSelectedTileId(tile.id); setSelectedTileIds(new Set()); copyTilesRef.current(false) } },
      { label: 'Cut',       action: () => { setSelectedTileId(tile.id); setSelectedTileIds(new Set()); copyTilesRef.current(true) } },
    ]
    // Paste options
    if (clipboard.current.length > 0) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: 'Paste', action: () => pasteTilesRef.current() })
      if (tile.groupId) {
        items.push({ label: 'Paste into this group', action: () => pasteTilesRef.current(undefined, tile.groupId) })
      }
    }
    items.push({ label: '', action: () => {}, divider: true })
    // Group membership
    if (tile.groupId) {
      items.push({ label: 'Remove from group', action: () => {
        setTiles(prev => {
          const updated = prev.map(t => t.id === tile.id ? { ...t, groupId: undefined } : t)
          saveCanvas(updated, viewport, nextZIndex)
          return updated
        })
      }})
      items.push({ label: 'Ungroup',     action: () => ungroupTilesRef.current(tile.groupId!) })
      items.push({ label: 'Ungroup All', action: () => ungroupAllRef.current(tile.groupId!) })
      items.push({ label: '', action: () => {}, divider: true })
    }
    // Add to group options — show available groups this tile isn't already in
    const availableGroups = groups.filter(g => g.id !== tile.groupId)
    if (availableGroups.length > 0) {
      availableGroups.forEach(g => {
        items.push({
          label: `Add to ${g.label ?? g.id.slice(-6)}`,
          action: () => {
            setTiles(prev => {
              const updated = prev.map(t => t.id === tile.id ? { ...t, groupId: g.id } : t)
              saveCanvas(updated, viewport, nextZIndex)
              return updated
            })
          }
        })
      })
      items.push({ label: '', action: () => {}, divider: true })
    }
    if (tile.type === 'file' && tile.filePath && workspace?.path && !tile.filePath.startsWith(workspace.path)) {
      items.push({
        label: 'Add to workspace',
        action: () => { void importFileToWorkspace(tile.filePath!, tile.id) }
      })
      items.push({ label: '', action: () => {}, divider: true })
    }
    // Chrome toggle — media files open chromeless; this restores titlebar +
    // browser navbar (for browser tiles). Toggling them together keeps the
    // two states coherent.
    const currentlyChromeless = !!tile.hideTitlebar || !!tile.hideNavbar
    items.push({
      label: currentlyChromeless ? 'Show Controls' : 'Hide Controls',
      action: () => {
        setTiles(prev => {
          const updated = prev.map(t => t.id === tile.id
            ? { ...t, hideTitlebar: !currentlyChromeless, hideNavbar: !currentlyChromeless }
            : t)
          saveCanvas(updated, viewport, nextZIndex)
          return updated
        })
      }
    })
    items.push({ label: '', action: () => {}, divider: true })
    items.push({ label: 'Close', action: () => closeTile(tile.id), danger: true })
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [closeTile, groups, viewport, nextZIndex, saveCanvas])

  const handleTileMouseDown = useCallback((e: React.MouseEvent, tile: TileState) => {
    e.stopPropagation()
    bringToFront(tile.id)
    // Snapshot positions of all tiles in the same group for co-movement
    const groupSnapshots: { id: string; x: number; y: number }[] = []
    if (tile.groupId) {
      tilesRef.current
        .filter(t => t.groupId === tile.groupId && t.id !== tile.id)
        .forEach(t => groupSnapshots.push({ id: t.id, x: t.x, y: t.y }))
    }
    setDragState({
      type: 'tile',
      tileId: tile.id,
      startX: e.clientX,
      startY: e.clientY,
      initX: tile.x,
      initY: tile.y,
      groupSnapshots
    })
  }, [bringToFront])

  const handleResizeMouseDown = useCallback((e: React.MouseEvent, tile: TileState, dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw') => {
    e.stopPropagation()
    e.preventDefault()
    setDragState({
      type: 'resize', tileId: tile.id, dir,
      startX: e.clientX, startY: e.clientY,
      initX: tile.x, initY: tile.y,
      initW: tile.width, initH: tile.height
    })
  }, [])

  // ─── Global mouse move/up ─────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragState.type === null) return
      const dx = e.clientX - dragState.startX
      const dy = e.clientY - dragState.startY

      if (dragState.type === 'pan') {
        const now = performance.now()
        const dt = now - panLastPos.current.t
        if (dt > 0) {
          const decay = 0.4
          panVelocityRef.current = {
            vx: decay * panVelocityRef.current.vx + (1 - decay) * (e.clientX - panLastPos.current.x) / dt * 16,
            vy: decay * panVelocityRef.current.vy + (1 - decay) * (e.clientY - panLastPos.current.y) / dt * 16,
          }
        }
        panLastPos.current = { x: e.clientX, y: e.clientY, t: now }
        setViewport(prev => ({ ...prev, tx: dragState.initTx + dx, ty: dragState.initTy + dy }))
      } else if (dragState.type === 'group-resize') {
        const wdx = dx / viewport.zoom
        const wdy = dy / viewport.zoom
        const { dir, initBounds: ib, snapshots: snaps } = dragState

        // Compute new bounds
        let nx = ib.x, ny = ib.y, nw = ib.w, nh = ib.h
        if (dir.includes('e'))  nw = Math.max(100, ib.w + wdx)
        if (dir.includes('s'))  nh = Math.max(100, ib.h + wdy)
        if (dir.includes('w')) { nw = Math.max(100, ib.w - wdx); nx = ib.x + ib.w - nw }
        if (dir.includes('n')) { nh = Math.max(100, ib.h - wdy); ny = ib.y + ib.h - nh }

        // For layout groups, just update layoutBounds directly — no tile scaling
        const resizingGroup = groupsRef.current.find(g => g.id === dragState.groupId)
        if (resizingGroup?.layoutMode) {
          setGroups(prev => prev.map(g => g.id === dragState.groupId
            ? { ...g, layoutBounds: { x: snapValue(nx), y: snapValue(ny), w: snapValue(nw), h: snapValue(nh) } }
            : g))
        } else {
          const scaleX = nw / ib.w
          const scaleY = nh / ib.h
          setTiles(prev => prev.map(t => {
            const s = snaps.find(s2 => s2.id === t.id)
            if (!s) return t
            const minW = getMinTileWidth(t)
            const minH = getMinTileHeight(t)
            // Scale position relative to group origin
            const relX = s.x - ib.x
            const relY = s.y - ib.y
            return {
              ...t,
              x: snapValue(nx + relX * scaleX),
              y: snapValue(ny + relY * scaleY),
              width: Math.max(minW, snapValue(s.width * scaleX)),
              height: Math.max(minH, snapValue(s.height * scaleY)),
            }
          }))
        }
      } else if (dragState.type === 'group') {
        const wdx = dx / viewport.zoom
        const wdy = dy / viewport.zoom
        if (dragState.initLayoutBounds) {
          // Layout group — move the stored bounds, not individual tiles
          const lb = dragState.initLayoutBounds
          setGroups(prev => prev.map(g => g.id === dragState.groupId ? {
            ...g,
            layoutBounds: { ...lb, x: snapValue(lb.x + wdx), y: snapValue(lb.y + wdy) }
          } : g))
        } else {
          setTiles(prev => prev.map(t => {
            const snap2 = dragState.snapshots.find(s => s.id === t.id)
            if (!snap2) return t
            return { ...t, x: snapValue(snap2.x + wdx), y: snapValue(snap2.y + wdy) }
          }))
        }
      } else if (dragState.type === 'select') {
        const rect = canvasRef.current?.getBoundingClientRect()
        if (!rect) return
        const curWx = (e.clientX - rect.left - viewport.tx) / viewport.zoom
        const curWy = (e.clientY - rect.top - viewport.ty) / viewport.zoom
        setDragState(prev => prev.type === 'select' ? { ...prev, curWx, curWy } : prev)
      } else if (dragState.type === 'tile') {
        const wdx = dx / viewport.zoom
        const wdy = dy / viewport.zoom
        const newX = snapValue(dragState.initX + wdx)
        const newY = snapValue(dragState.initY + wdy)
        const ddx = newX - dragState.initX
        const ddy = newY - dragState.initY
        setTiles(prev => {
          const dragging = prev.find(t => t.id === dragState.tileId)
          if (!dragging) return prev
          const others = prev.filter(t => t.id !== dragState.tileId && !dragState.groupSnapshots.find(g => g.id === t.id))
          const w = dragging.width
          const h = dragging.height
          const THRESH = 6
          const newGuides: { x?: number; y?: number }[] = []
          for (const o of others) {
            const dx_checks: [number, number][] = [
              [newX, o.x], [newX, o.x + o.width / 2 - w / 2], [newX, o.x + o.width - w],
              [newX + w / 2, o.x + o.width / 2], [newX + w, o.x], [newX + w, o.x + o.width],
            ]
            for (const [a, b] of dx_checks) {
              if (Math.abs(a - b) < THRESH) newGuides.push({ x: b })
            }
            const dy_checks: [number, number][] = [
              [newY, o.y], [newY, o.y + o.height / 2 - h / 2], [newY, o.y + o.height - h],
              [newY + h / 2, o.y + o.height / 2], [newY + h, o.y], [newY + h, o.y + o.height],
            ]
            for (const [a, b] of dy_checks) {
              if (Math.abs(a - b) < THRESH) newGuides.push({ y: b })
            }
          }
          const seen = new Set<string>()
          const dedupedGuides = newGuides.filter(g => {
            const k = g.x !== undefined ? `x:${g.x}` : `y:${g.y}`
            if (seen.has(k)) return false
            seen.add(k); return true
          })
          setGuides(dedupedGuides)
          return prev.map(t => {
            if (t.id === dragState.tileId) return { ...t, x: newX, y: newY }
            const snap2 = dragState.groupSnapshots.find(g => g.id === t.id)
            if (snap2) return { ...t, x: snapValue(snap2.x + ddx), y: snapValue(snap2.y + ddy) }
            return t
          })
        })
      } else if (dragState.type === 'resize') {
        const wdx = dx / viewport.zoom
        const wdy = dy / viewport.zoom
        const dir = dragState.dir
        setTiles(prev => prev.map(t => {
          if (t.id !== dragState.tileId) return t
          const minW = getMinTileWidth(t)
          const minH = getMinTileHeight(t)
          let { x, y, width: w, height: h } = t
          if (dir.includes('e'))  w = Math.max(minW, snapValue(dragState.initW + wdx))
          if (dir.includes('s'))  h = Math.max(minH, snapValue(dragState.initH + wdy))
          if (dir.includes('w')) { w = Math.max(minW, snapValue(dragState.initW - wdx)); x = snapValue(dragState.initX + wdx) }
          if (dir.includes('n')) { h = Math.max(minH, snapValue(dragState.initH - wdy)); y = snapValue(dragState.initY + wdy) }
          return { ...t, x, y, width: w, height: h }
        }))
      }
    }

    const onUp = () => {
      if (dragState.type === 'tile') {
        setTiles(prev => {
          const tile = prev.find(t => t.id === dragState.tileId)
          if (!tile) { saveCanvas(prev, viewport, nextZIndex); return prev }

          // If tile didn't actually move, don't touch group membership
          const didMove = tile.x !== dragState.initX || tile.y !== dragState.initY
          // Clear suppressed connections for this tile when it moves
          if (didMove && suppressedConnectionsRef.current.size > 0) {
            setSuppressedConnections(prev => {
              const next = new Set(prev)
              for (const key of prev) {
                if (key.includes(tile.id)) next.delete(key)
              }
              return next.size === prev.size ? prev : next
            })
          }
          if (!didMove) { saveCanvas(prev, viewport, nextZIndex); return prev }

          const tileCx = tile.x + tile.width / 2
          const tileCy = tile.y + tile.height / 2

          // Check if dropped inside a different group's bounds
          let newGroupId: string | undefined = tile.groupId
          for (const g of groups) {
            if (g.id === tile.groupId) continue // already in this group
            const b = groupBoundsRef.current(g.id)
            if (b && tileCx >= b.x && tileCx <= b.x + b.w && tileCy >= b.y && tileCy <= b.y + b.h) {
              newGroupId = g.id
              break
            }
          }

          // Check if dragged outside its current group
          if (tile.groupId && newGroupId === tile.groupId) {
            const members = prev.filter(t => t.groupId === tile.groupId && t.id !== tile.id)
            if (members.length > 0) {
              const PAD = 20
              const minX = Math.min(...members.map(t => t.x)) - PAD
              const minY = Math.min(...members.map(t => t.y)) - PAD
              const maxX = Math.max(...members.map(t => t.x + t.width)) + PAD
              const maxY = Math.max(...members.map(t => t.y + t.height)) + PAD
              const outside = tile.x + tile.width < minX || tile.x > maxX ||
                              tile.y + tile.height < minY || tile.y > maxY
              if (outside) newGroupId = undefined
            }
          }

          if (newGroupId !== tile.groupId) {
            const updated = prev.map(t => t.id === tile.id ? { ...t, groupId: newGroupId } : t)
            saveCanvas(updated, viewport, nextZIndex)
            window.setTimeout(() => triggerDiscoveryPulse(tile.id, updated), 40)
            return updated
          }
          saveCanvas(prev, viewport, nextZIndex)
          window.setTimeout(() => triggerDiscoveryPulse(tile.id, prev), 40)
          return prev
        })
      } else if (dragState.type === 'resize' || dragState.type === 'group' || dragState.type === 'group-resize') {
        setTiles(prev => { saveCanvas(prev, viewport, nextZIndex, groupsRef.current); return prev })
      }
      if (dragState.type === 'select') {
        const minX = Math.min(dragState.startWx, dragState.curWx)
        const maxX = Math.max(dragState.startWx, dragState.curWx)
        const minY = Math.min(dragState.startWy, dragState.curWy)
        const maxY = Math.max(dragState.startWy, dragState.curWy)
        const size = Math.max(maxX - minX, maxY - minY)
        if (size > 10) {
          setTiles(prev => {
            const hit = new Set(
              prev
                .filter(t => !panelTileIdsRef.current.has(t.id))  // exclude layout-group / panel tiles
                .filter(t => t.x < maxX && t.x + t.width > minX && t.y < maxY && t.y + t.height > minY)
                .map(t => t.id)
            )
            setSelectedTileIds(hit)
            return prev
          })
        }
      }
      // Kick off inertia when releasing a pan
      if (dragState.type === 'pan') {
        const { vx, vy } = panVelocityRef.current
        if (Math.abs(vx) > 0.5 || Math.abs(vy) > 0.5) {
          const friction = 0.92
          const animate = () => {
            const v = panVelocityRef.current
            if (Math.abs(v.vx) < 0.5 && Math.abs(v.vy) < 0.5) return
            setViewport(prev => ({ ...prev, tx: prev.tx + v.vx, ty: prev.ty + v.vy }))
            panVelocityRef.current = { vx: v.vx * friction, vy: v.vy * friction }
            panInertiaRaf.current = requestAnimationFrame(animate)
          }
          panInertiaRaf.current = requestAnimationFrame(animate)
        }
      }
      setGuides([])
      setDragState({ type: null })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragState, groups, nextZIndex, saveCanvas, triggerDiscoveryPulse, viewport])

  // ─── Zoom — native listener needed for { passive: false } ────────────────
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.08 : 0.92
      const newZoom = Math.max(0.25, Math.min(2, viewport.zoom * factor))
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const wx = (mx - viewport.tx) / viewport.zoom
      const wy = (my - viewport.ty) / viewport.zoom
      setViewport({ tx: mx - wx * newZoom, ty: my - wy * newZoom, zoom: newZoom })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewport])

  // Keep as no-op for JSX prop (wheel handled natively above)
  const handleWheel = useCallback((_e: React.WheelEvent) => {}, [])

  // ─── Workspace switching ──────────────────────────────────────────────────
  const handleSwitchWorkspace = useCallback(async (id: string) => {
    await window.electron.workspace.setActive(id)
    let ws = workspaces.find(w => w.id === id) ?? null
    if (!ws) {
      const refreshed = await window.electron.workspace.list().catch(() => [])
      if (refreshed.length > 0) {
        setWorkspaces(refreshed)
        ws = refreshed.find(w => w.id === id) ?? null
      }
    }
    setWorkspace(ws)
    setShowWorkspacePickerTab(false)
    setWorkspacePickerReturnWorkspaceId(null)
    if (ws) {
      const saved = await window.electron.canvas.load(id)
      const savedTiles = saved?.tiles ?? []
      void window.electron.collab.pruneOrphanedTileDirs(ws.path, savedTiles.map(tile => tile.id))
      if (saved) {
        const sanitizedPanel = sanitizePanelLayout((saved.panelLayout as PanelNode | null) ?? null, savedTiles.map(tile => tile.id))
        const nextActivePanelId = saved.activePanelId && sanitizedPanel.layout && findLeafById(sanitizedPanel.layout, saved.activePanelId)
          ? saved.activePanelId
          : sanitizedPanel.fallbackActivePanelId
        setTiles(savedTiles)
        setGroups(saved.groups ?? [])
        setViewport(saved.viewport ? { tx: saved.viewport.tx, ty: saved.viewport.ty, zoom: saved.viewport.zoom } : { tx: 0, ty: 0, zoom: 1 })
        setNextZIndex(saved.nextZIndex ?? 1)
        savedLayoutRef.current = sanitizedPanel.layout
        setPanelLayout(saved.tabViewActive ? (sanitizedPanel.layout ?? createLeaf([])) : null)
        setActivePanelId(saved.tabViewActive ? nextActivePanelId : null)
        setExpandedTileId(saved.expandedTileId ?? null)
      } else {
        setTiles([])
        setGroups([])
        setViewport({ tx: 0, ty: 0, zoom: 1 })
        setNextZIndex(1)
        savedLayoutRef.current = null
        setPanelLayout(null)
        setActivePanelId(null)
        setExpandedTileId(null)
      }
    }
  }, [workspaces])

  const handleDeleteWorkspace = useCallback(async (id: string) => {
    const wasActive = workspace?.id === id
    const nextOpenIds = openWorkspaceIds.filter(wsId => wsId !== id)

    await window.electron.workspace.delete(id)
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    setOpenWorkspaceIds(nextOpenIds)

    if (!wasActive) return

    const nextId = nextOpenIds.find(wsId => updated.some(ws => ws.id === wsId)) ?? updated[0]?.id ?? null
    if (nextId) {
      await handleSwitchWorkspace(nextId)
      return
    }

    showEmptyLayoutPage()
  }, [workspace?.id, openWorkspaceIds, handleSwitchWorkspace, showEmptyLayoutPage])

  const handleCloseWorkspaceTab = useCallback(async (id: string) => {
    const tabIndex = openWorkspaceIds.indexOf(id)
    if (tabIndex === -1) return

    const nextOpenIds = openWorkspaceIds.filter(wsId => wsId !== id)
    setOpenWorkspaceIds(nextOpenIds)

    if (workspace?.id !== id) return

    const nextId = nextOpenIds[tabIndex] ?? nextOpenIds[tabIndex - 1] ?? null
    if (nextId) {
      await handleSwitchWorkspace(nextId)
      return
    }

    showEmptyLayoutPage()
  }, [openWorkspaceIds, workspace?.id, handleSwitchWorkspace, showEmptyLayoutPage])

  const handleNewWorkspace = useCallback(async (name: string) => {
    if (!name.trim()) return
    const ws = await window.electron.workspace.create(name.trim())
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    await handleSwitchWorkspace(ws.id)
  }, [handleSwitchWorkspace])

  const handleOpenFolder = useCallback(async () => {
    const folderPath = await window.electron.workspace.openFolder()
    if (!folderPath) return
    const ws = await window.electron.workspace.createFromFolder(folderPath)
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    await handleSwitchWorkspace(ws.id)
  }, [handleSwitchWorkspace])

  // Cmd+T → open next available workspace as a pill tab
  useEffect(() => {
    return window.electron?.window?.onNewTab?.(() => {
      const next = workspaces.find(w => !openWorkspaceIds.includes(w.id))
      if (next) {
        setOpenWorkspaceIds(prev => [...prev, next.id])
        handleSwitchWorkspace(next.id)
      }
    })
  }, [workspaces, openWorkspaceIds, handleSwitchWorkspace])

  // Launch a layout template as a new view within the current project
  const handleLaunchTemplate = useCallback(async (template: import('../../shared/types').LayoutTemplate) => {
    // Inherit the current workspace's project path so the new view stays in the same project.
    // Name it "ProjectBase:LayoutName" so the tab bar makes the relationship clear.
    const currentPath = workspace?.path ?? ''
    const projectBase = currentPath ? currentPath.split('/').filter(Boolean).pop() ?? '' : ''
    const viewName = projectBase ? `${projectBase}:${template.name}` : template.name
    const ws = await window.electron.workspace.createWithPath(viewName, currentPath)
    const updatedList = await window.electron.workspace.list()
    setWorkspaces(updatedList)

    // Generate tiles from template tree
    const generatedTiles: TileState[] = []
    let zIdx = 1
    const VW = 1600, VH = 900
    let counter = 0

    const generateTiles = (node: import('../../shared/types').LayoutTemplateNode, x: number, y: number, w: number, h: number) => {
      if (node.type === 'leaf') {
        for (const slot of node.slots) {
          generatedTiles.push({
            id: `tile-${Date.now()}-${counter++}`,
            type: slot.tileType,
            x: Math.round(x), y: Math.round(y),
            width: Math.round(w), height: Math.round(h),
            zIndex: zIdx++,
            label: slot.label,
          })
        }
        return
      }
      const { direction, children, sizes } = node
      let offset = 0
      children.forEach((child, i) => {
        const pct = (sizes[i] ?? 50) / 100
        if (direction === 'horizontal') {
          generateTiles(child, x + offset, y, w * pct, h)
          offset += w * pct
        } else {
          generateTiles(child, x, y + offset, w, h * pct)
          offset += h * pct
        }
      })
    }

    generateTiles(template.tree, 0, 0, VW, VH)

    // Generate PanelNode tree from template
    const generatePanel = (node: import('../../shared/types').LayoutTemplateNode, tileIdx: { v: number }): PanelNode => {
      if (node.type === 'leaf') {
        const tabs = node.slots.map(() => generatedTiles[tileIdx.v++]?.id).filter(Boolean)
        return { type: 'leaf', id: `panel-${Date.now()}-${tileIdx.v}`, tabs, activeTab: tabs[0] ?? '' }
      }
      return {
        type: 'split',
        id: `split-${Date.now()}-${tileIdx.v}`,
        direction: node.direction,
        children: node.children.map(c => generatePanel(c, tileIdx)),
        sizes: node.sizes,
      }
    }

    const panelTree = generatePanel(template.tree, { v: 0 })

    // Generate locked connections for adjacent tiles
    const connections: Array<{ sourceTileId: string; targetTileId: string }> = []
    for (let i = 0; i < generatedTiles.length; i++) {
      for (let j = i + 1; j < generatedTiles.length; j++) {
        const a = generatedTiles[i], b = generatedTiles[j]
        const touchH = (Math.round(a.x + a.width) === b.x || Math.round(b.x + b.width) === a.x) && !(a.y + a.height <= b.y || b.y + b.height <= a.y)
        const touchV = (Math.round(a.y + a.height) === b.y || Math.round(b.y + b.height) === a.y) && !(a.x + a.width <= b.x || b.x + b.width <= a.x)
        if (touchH || touchV) {
          connections.push({ sourceTileId: a.id, targetTileId: b.id })
        }
      }
    }

    // Save canvas state
    const firstLeafId = panelTree.type === 'leaf' ? panelTree.id
      : (function findFirst(n: PanelNode): string { return n.type === 'leaf' ? n.id : findFirst(n.children[0]) })(panelTree)

    const state: CanvasState = {
      tiles: generatedTiles,
      groups: [],
      viewport: { tx: 0, ty: 0, zoom: 1 },
      nextZIndex: zIdx,
      panelLayout: panelTree,
      activePanelId: firstLeafId,
      tabViewActive: true,
      lockedConnections: connections.length > 0 ? connections : undefined,
    }
    await window.electron.canvas.save(ws.id, state)

    // Switch to new workspace — set state directly since the ws is new and not in the old closure
    await window.electron.workspace.setActive(ws.id)
    setWorkspace(ws)
    setTiles(generatedTiles)
    setGroups([])
    setLockedConnections(connections)
    setViewport({ tx: 0, ty: 0, zoom: 1 })
    setNextZIndex(zIdx)
    savedLayoutRef.current = panelTree
    setPanelLayout(panelTree)
    setActivePanelId(firstLeafId)
    setExpandedTileId(null)
    setOpenWorkspaceIds(prev => prev.includes(ws.id) ? prev : [...prev, ws.id])
  }, [workspace])

  const handleOpenFile = useCallback((filePath: string) => {
    setSidebarSelectedPath(filePath)

    // If this file is already open in a tile, focus it instead of creating a duplicate
    const existing = tilesRef.current.find(t => t.filePath === filePath)
    if (existing) {
      bringToFront(existing.id)
      // In panel mode, switch to the tab containing this tile
      if (panelLayout && activePanelId) {
        // Find which leaf contains this tile and activate it
        const allIds = getAllTileIds(panelLayout)
        if (allIds.includes(existing.id)) {
          // Find the leaf containing this tile and set it as active tab
          const findLeafContaining = (node: PanelNode, tileId: string): string | null => {
            if ('tabs' in node) return node.tabs.includes(tileId) ? node.id : null
            for (const child of node.children) {
              const found = findLeafContaining(child, tileId)
              if (found) return found
            }
            return null
          }
          const leafId = findLeafContaining(panelLayout, existing.id)
          if (leafId) {
            setActivePanelId(leafId)
            setPanelLayout(prev => {
              if (!prev) return prev
              const setActiveTab = (node: PanelNode): PanelNode => {
                if ('tabs' in node) {
                  return node.id === leafId ? { ...node, activeTab: existing.id } : node
                }
                return { ...node, children: node.children.map(setActiveTab) }
              }
              return setActiveTab(prev)
            })
          }
        }
      }
      return
    }

    void resolveFileTileType(filePath).then(type => addTile(type, filePath))
  }, [addTile, bringToFront, panelLayout, activePanelId])

  const resolveWorkspaceForProjectPath = useCallback(async (projectPath: string | null | undefined): Promise<Workspace | null> => {
    const normalizedProjectPath = normalizeWorkspacePath(projectPath)
    if (!normalizedProjectPath) return workspace ?? null

    const currentWorkspacePath = normalizeWorkspacePath(workspace?.path)
    const currentWorkspaceProjects = new Set((workspace?.projectPaths ?? []).map(normalizeWorkspacePath))
    if (workspace && (currentWorkspacePath === normalizedProjectPath || currentWorkspaceProjects.has(normalizedProjectPath))) return workspace

    const existingWorkspace = workspaces.find(candidate => {
      if (normalizeWorkspacePath(candidate.path) === normalizedProjectPath) return true
      return (candidate.projectPaths ?? []).some(path => normalizeWorkspacePath(path) === normalizedProjectPath)
    }) ?? null
    if (existingWorkspace) return existingWorkspace

    const workspaceName = basename(normalizedProjectPath) || 'Project'
    const created = await window.electron.workspace.createWithPath(workspaceName, normalizedProjectPath)
    const updated = await window.electron.workspace.list().catch(() => null)
    if (updated && updated.length > 0) setWorkspaces(updated)
    return created
  }, [workspace, workspaces])

  const resolveWorkspaceForSession = useCallback(async (session: SidebarSessionEntry): Promise<Workspace | null> => {
    return resolveWorkspaceForProjectPath(session.projectPath)
  }, [resolveWorkspaceForProjectPath])

  const openSessionInChatCurrentWorkspace = useCallback(async (session: SidebarSessionEntry, workspaceId: string) => {
    const state = await window.electron.canvas.getSessionState(workspaceId, session.id).catch(() => null)
    if (!state) {
      if (session.filePath) handleOpenFile(session.filePath)
      return
    }

    const provider = typeof state.provider === 'string' ? state.provider : (session.provider || 'claude')
    const defaultModeByProvider: Record<string, string> = {
      claude: 'default',
      codex: 'full-auto',
      opencode: 'build',
      openclaw: 'default',
      hermes: 'full',
    }

    const nextChatState = {
      messages: Array.isArray(state.messages) ? state.messages : [],
      input: '',
      attachments: [],
      provider,
      model: typeof state.model === 'string' ? state.model : (session.model || ''),
      mcpEnabled: false,
      mode: defaultModeByProvider[provider] ?? 'default',
      thinking: 'adaptive',
      agentMode: false,
      autoAgentMode: false,
      sessionId: typeof state.sessionId === 'string' || state.sessionId === null ? state.sessionId : session.sessionId,
      isStreaming: false,
    }

    const activeFullscreenChatTileId = (() => {
      const currentLayout = panelLayoutRef.current
      const currentPanelId = activePanelIdRef.current
      if (!currentLayout || !currentPanelId) return null
      const activeLeaf = findLeafById(currentLayout, currentPanelId)
      const activeTileId = activeLeaf?.activeTab ?? expandedTileIdRef.current
      if (!activeTileId) return null
      const activeTile = tilesRef.current.find(tile => tile.id === activeTileId)
      return activeTile?.type === 'chat' ? activeTile.id : null
    })()

    if (activeFullscreenChatTileId) {
      setChatTileRuntimeState(activeFullscreenChatTileId, nextChatState)
      await window.electron.canvas.saveTileState(workspaceId, activeFullscreenChatTileId, nextChatState).catch(() => {})
      setChatReloadTokens(prev => ({ ...prev, [activeFullscreenChatTileId]: (prev[activeFullscreenChatTileId] ?? 0) + 1 }))
      bringToFront(activeFullscreenChatTileId)
      return
    }

    const chatTileId = addTile('chat')
    await window.electron.canvas.saveTileState(workspaceId, chatTileId, {
      ...nextChatState,
    }).catch(() => {})
    bringToFront(chatTileId)
  }, [addTile, bringToFront, handleOpenFile])

  const openSessionInChat = useCallback(async (session: SidebarSessionEntry) => {
    const targetWorkspace = await resolveWorkspaceForSession(session)
    if (!targetWorkspace?.id) return

    if (targetWorkspace.id !== workspace?.id) {
      setPendingSessionOpen({ kind: 'chat', session, workspaceId: targetWorkspace.id })
      await handleSwitchWorkspace(targetWorkspace.id)
      return
    }

    await openSessionInChatCurrentWorkspace(session, targetWorkspace.id)
  }, [resolveWorkspaceForSession, workspace?.id, handleSwitchWorkspace, openSessionInChatCurrentWorkspace])

  const openSessionInAppCurrentWorkspace = useCallback((session: SidebarSessionEntry) => {
    if (!session.resumeBin) return
    const tileId = addTile('terminal', undefined, undefined, {
      launchBin: session.resumeBin,
      launchArgs: session.resumeArgs ?? [],
    })
    bringToFront(tileId)
  }, [addTile, bringToFront])

  const openSessionInApp = useCallback(async (session: SidebarSessionEntry) => {
    const targetWorkspace = await resolveWorkspaceForSession(session)
    if (!targetWorkspace?.id) return

    if (targetWorkspace.id !== workspace?.id) {
      setPendingSessionOpen({ kind: 'app', session, workspaceId: targetWorkspace.id })
      await handleSwitchWorkspace(targetWorkspace.id)
      return
    }

    openSessionInAppCurrentWorkspace(session)
  }, [resolveWorkspaceForSession, workspace?.id, handleSwitchWorkspace, openSessionInAppCurrentWorkspace])

  useEffect(() => {
    if (!pendingSessionOpen || !workspace?.id) return
    if (pendingSessionOpen.workspaceId !== workspace.id) return

    const nextPending = pendingSessionOpen
    setPendingSessionOpen(null)

    if (nextPending.kind === 'chat') {
      void openSessionInChatCurrentWorkspace(nextPending.session, workspace.id)
      return
    }

    openSessionInAppCurrentWorkspace(nextPending.session)
  }, [pendingSessionOpen, workspace?.id, openSessionInAppCurrentWorkspace, openSessionInChatCurrentWorkspace])

  const importFileToWorkspace = useCallback(async (sourcePath: string, tileId?: string) => {
    if (!workspace?.path) return null
    const { path: importedPath } = await window.electron.fs.copyIntoDir(sourcePath, workspace.path)

    if (tileId) {
      setTiles(prev => {
        const updated = prev.map(tile => tile.id === tileId ? { ...tile, filePath: importedPath } : tile)
        saveCanvas(updated, viewport, nextZIndex)
        return updated
      })
    }

    setSidebarSelectedPath(importedPath)
    return importedPath
  }, [workspace?.path, viewport, nextZIndex, saveCanvas])

  // Rebuild merged MCP config whenever workspace changes
  useEffect(() => {
    if (workspace) {
      window.electron.mcp?.getMergedConfig?.(workspace.id)
    }
  }, [workspace?.id])

  // ─── Group selected tiles (supports nesting — wraps existing groups too) ──
  const groupSelectedTiles = useCallback(() => {
    if (selectedTileIds.size < 2) return
    const groupId = `group-${Date.now()}`

    setGroups(prevGroups => {
      // Find any existing groups whose member tiles are all selected — those groups become children
      const childGroupIds = new Set(
        prevGroups
          .filter(g => {
            const members = tiles.filter(t => t.groupId === g.id)
            return members.length > 0 && members.every(t => selectedTileIds.has(t.id))
          })
          .map(g => g.id)
      )

      // Reparent child groups into the new group
      const updatedGroups = prevGroups.map(g =>
        childGroupIds.has(g.id) ? { ...g, parentGroupId: groupId } : g
      )
      const newGroup: GroupState = { id: groupId }
      const finalGroups = [...updatedGroups, newGroup]

      setTiles(tPrev => {
        // Assign groupId to selected tiles that aren't already in a child group
        const updated = tPrev.map(t =>
          selectedTileIds.has(t.id) && !childGroupIds.has(t.groupId ?? '')
            ? { ...t, groupId }
            : t
        )
        saveCanvas(updated, viewport, nextZIndex, finalGroups)
        return updated
      })
      return finalGroups
    })
    setSelectedTileIds(new Set())
  }, [selectedTileIds, tiles, viewport, nextZIndex, saveCanvas])

  // ─── Cmd+G to group ───────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'g') {
        e.preventDefault()
        if (selectedTileIds.size >= 2) groupSelectedTiles()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedTileIds, groupSelectedTiles])

  // Ungroup one level — tiles revert to parentGroupId if present
  const ungroupTiles = useCallback((groupId: string) => {
    setGroups(prevGroups => {
      const group = prevGroups.find(g => g.id === groupId)
      const parentId = group?.parentGroupId

      // Child groups that had this as parent get reparented up
      const updatedGroups = prevGroups
        .filter(g => g.id !== groupId)
        .map(g => g.parentGroupId === groupId
          ? { ...g, parentGroupId: parentId }
          : g
        )

      setTiles(prev => {
        const updated = prev.map(t =>
          t.groupId === groupId ? { ...t, groupId: parentId } : t
        )
        saveCanvas(updated, viewport, nextZIndex, updatedGroups)
        return updated
      })
      return updatedGroups
    })
  }, [viewport, nextZIndex, saveCanvas])

  // Ungroup all — recursively strip every groupId from tiles in this group tree
  const ungroupAll = useCallback((groupId: string) => {
    setGroups(prevGroups => {
      // Collect all group ids in this subtree
      const toRemove = new Set<string>()
      const collect = (id: string) => {
        toRemove.add(id)
        prevGroups.filter(g => g.parentGroupId === id).forEach(g => collect(g.id))
      }
      collect(groupId)

      const updatedGroups = prevGroups.filter(g => !toRemove.has(g.id))

      setTiles(prev => {
        const updated = prev.map(t =>
          toRemove.has(t.groupId ?? '') ? { ...t, groupId: undefined } : t
        )
        saveCanvas(updated, viewport, nextZIndex, updatedGroups)
        return updated
      })
      return updatedGroups
    })
  }, [viewport, nextZIndex, saveCanvas])

  // ─── Clipboard ───────────────────────────────────────────────────────────
  const getActiveTiles = useCallback((): TileState[] => {
    // Multi-select takes priority, then single selected, then nothing
    return tiles.filter(t =>
      selectedTileIds.size > 0 ? selectedTileIds.has(t.id) : t.id === selectedTileId
    )
  }, [tiles, selectedTileIds, selectedTileId])

  const copyTiles = useCallback((cut = false) => {
    const active = getActiveTiles()
    if (active.length === 0) return
    clipboard.current = active
    isCut.current = cut
    pasteOffset.current = 0
    // For cut: remember source group so Cmd+V pastes back in by default
    // For copy: clear target so Cmd+V pastes freely (use "paste in" label to target a group)
    pasteTargetGroupId.current = cut ? active[0]?.groupId : undefined
    if (cut) {
      const ids = new Set(active.map(t => t.id))
      setTiles(prev => {
        const updated = prev.filter(t => !ids.has(t.id))
        saveCanvas(updated, viewport, nextZIndex)
        return updated
      })
      setSelectedTileId(null)
      setSelectedTileIds(new Set())
    }
  }, [getActiveTiles, viewport, nextZIndex, saveCanvas])

  const pasteTiles = useCallback((pos?: { x: number; y: number }, intoGroupId?: string) => {
    if (clipboard.current.length === 0) return
    if (pasteOffset.current > 10) pasteOffset.current = 0
    pasteOffset.current += 1
    const OFFSET = pasteOffset.current * 30
    const srcMinX = Math.min(...clipboard.current.map(t => t.x))
    const srcMinY = Math.min(...clipboard.current.map(t => t.y))
    const center = pos ?? viewportCenter()
    const newNZ = nextZIndex + clipboard.current.length
    // Resolve target group: explicit > position-based > ref > none
    let targetGroup = intoGroupId ?? pasteTargetGroupId.current
    if (!targetGroup && pos) {
      // Check if paste position is inside a group frame
      for (const g of groups) {
        const b = groupBoundsRef.current(g.id)
        if (b && pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h) {
          targetGroup = g.id
          break
        }
      }
    }
    const newTiles = clipboard.current.map((t, i) => ({
      ...t,
      id: `tile-${Date.now()}-${i}`,
      x: pos
        ? snapValue(center.x + (t.x - srcMinX) - (Math.max(...clipboard.current.map(t2 => t2.x + t2.width)) - srcMinX) / 2)
        : snapValue(t.x + OFFSET),
      y: pos
        ? snapValue(center.y + (t.y - srcMinY) - (Math.max(...clipboard.current.map(t2 => t2.y + t2.height)) - srcMinY) / 2)
        : snapValue(t.y + OFFSET),
      zIndex: nextZIndex + i,
      groupId: targetGroup
    }))
    setTiles(prev => {
      const updated = [...prev, ...newTiles]
      saveCanvas(updated, viewport, newNZ)
      return updated
    })
    setNextZIndex(newNZ)
    setSelectedTileIds(new Set(newTiles.map(t => t.id)))
    setSelectedTileId(null)
  }, [viewport, nextZIndex, viewportCenter, saveCanvas, groups, snapValue])

  const duplicateTiles = useCallback((ids?: string[]) => {
    const targets = ids
      ? tiles.filter(t => ids.includes(t.id))
      : getActiveTiles()
    if (targets.length === 0) return
    const newNZ = nextZIndex + targets.length
    const newTiles = targets.map((t, i) => ({
      ...t,
      id: `tile-${Date.now()}-${i}`,
      x: snapValue(t.x + 40),
      y: snapValue(t.y + 40),
      zIndex: nextZIndex + i,
      groupId: undefined
    }))
    setTiles(prev => {
      const updated = [...prev, ...newTiles]
      saveCanvas(updated, viewport, newNZ)
      return updated
    })
    setNextZIndex(newNZ)
    setSelectedTileIds(new Set(newTiles.map(t => t.id)))
    setSelectedTileId(null)
  }, [tiles, getActiveTiles, viewport, nextZIndex, saveCanvas, snapValue])

  // ─── Group frame bounds (recursive — includes child group tiles) ─────────
  const groupBounds = useCallback((groupId: string): { x: number; y: number; w: number; h: number } | null => {
    const group = groups.find(g => g.id === groupId)
    // Layout-mode groups use stored fixed bounds
    if (group?.layoutMode && group.layoutBounds) {
      return group.layoutBounds as { x: number; y: number; w: number; h: number }
    }
    const collectTileIds = (gid: string): string[] => {
      const direct = tiles.filter(t => t.groupId === gid).map(t => t.id)
      const childGroups = groups.filter(g => g.parentGroupId === gid)
      return [...direct, ...childGroups.flatMap(g => collectTileIds(g.id))]
    }
    const ids = new Set(collectTileIds(groupId))
    const members = tiles.filter(t => ids.has(t.id))
    if (members.length === 0) return null
    const PAD = 20
    const minX = Math.min(...members.map(t => t.x)) - PAD
    const minY = Math.min(...members.map(t => t.y)) - PAD
    const maxX = Math.max(...members.map(t => t.x + t.width)) + PAD
    const maxY = Math.max(...members.map(t => t.y + t.height)) + PAD
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }, [tiles, groups])

  // Collect all tile ids in a group tree (for drag)
  const collectGroupTileIds = useCallback((groupId: string): string[] => {
    const direct = tiles.filter(t => t.groupId === groupId).map(t => t.id)
    const childGroups = groups.filter(g => g.parentGroupId === groupId)
    return [...direct, ...childGroups.flatMap(g => collectGroupTileIds(g.id))]
  }, [tiles, groups])

  const convertGroupToLayout = useCallback((groupId: string) => {
    const memberTileIds = tiles.filter(t => t.groupId === groupId).map(t => t.id)
    if (memberTileIds.length === 0) return
    const bounds = groupBounds(groupId)
    if (!bounds) return
    const leaf = createLeaf(memberTileIds, memberTileIds[0])
    setGroups(prev => {
      const updated = prev.map(g => g.id === groupId ? {
        ...g,
        layoutMode: true,
        layout: leaf,
        layoutBounds: bounds,
      } : g)
      setTiles(t => { saveCanvas(t, viewport, nextZIndex, updated); return t })
      return updated
    })
  }, [tiles, groupBounds, viewport, nextZIndex, saveCanvas])

  const revertLayoutGroup = useCallback((groupId: string) => {
    setGroups(prev => {
      const updated = prev.map(g => g.id === groupId ? {
        ...g,
        layoutMode: false,
        layout: undefined,
        layoutBounds: undefined,
      } : g)
      setTiles(t => { saveCanvas(t, viewport, nextZIndex, updated); return t })
      return updated
    })
  }, [viewport, nextZIndex, saveCanvas])

  const expandLayoutGroup = useCallback((groupId: string) => {
    const g = groupsRef.current.find(gr => gr.id === groupId)
    if (!g?.layout) return
    const layout = g.layout as PanelNode
    setExpandLayoutGroupId(groupId)
    expandLayoutGroupIdRef.current = groupId
    setPanelLayout(layout)
    const firstLeafId = findFirstLeafId(layout)
    setActivePanelId(firstLeafId)
    setExpandedTileId(null)
  }, [])

  // Keep action refs in sync so early-defined callbacks can call them safely
  pasteTilesRef.current = pasteTiles
  duplicateTilesRef.current = duplicateTiles
  copyTilesRef.current = copyTiles
  groupSelectedTilesRef.current = groupSelectedTiles
  groupBoundsRef.current = groupBounds
  persistCanvasStateRef.current = persistCanvasState
  ungroupTilesRef.current = ungroupTiles
  ungroupAllRef.current = ungroupAll

  // ─── Copy / Cut / Paste / Duplicate / Delete shortcuts ───────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'c') { e.preventDefault(); copyTiles(false) }
      if (mod && e.key === 'x') { e.preventDefault(); copyTiles(true) }
      if (mod && e.key === 'v') { e.preventDefault(); pasteTiles() }
      if (mod && e.key === 'd') { e.preventDefault(); duplicateTiles() }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !mod) {
        const active = selectedTileIds.size > 0
          ? [...selectedTileIds]
          : selectedTileId ? [selectedTileId] : []
        if (active.length > 0) {
          const ids = new Set(active)
          setTiles(prev => {
            const updated = prev.filter(t => !ids.has(t.id))
            saveCanvas(updated, viewport, nextZIndex)
            return updated
          })
          setSelectedTileId(null)
          setSelectedTileIds(new Set())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copyTiles, pasteTiles, duplicateTiles, selectedTileId, selectedTileIds, viewport, nextZIndex, saveCanvas])

  // ─── Undo / redo ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      const isUndo = e.key === 'z' && !e.shiftKey
      const isRedo = (e.key === 'z' && e.shiftKey) || e.key === 'y'
      if (!isUndo && !isRedo) return
      e.preventDefault()

      if (isUndo && historyBack.current.length > 0) {
        const prev = historyBack.current.pop()!
        historyForward.current.push({ tiles: tilesRef.current, groups: groupsRef.current })
        skipHistory.current = true
        setTiles(prev.tiles)
        setGroups(prev.groups)
        // Persist the restored state without adding another history entry
        if (workspace) {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => {
            const state: CanvasState = { tiles: prev.tiles, groups: prev.groups, viewport: viewportRef.current, nextZIndex: nextZIndexRef.current }
            window.electron.canvas.save(workspace.id, state)
            skipHistory.current = false
          }, 500)
        } else {
          skipHistory.current = false
        }
      }

      if (isRedo && historyForward.current.length > 0) {
        const next = historyForward.current.pop()!
        historyBack.current.push({ tiles: tilesRef.current, groups: groupsRef.current })
        if (historyBack.current.length > 50) historyBack.current.shift()
        skipHistory.current = true
        setTiles(next.tiles)
        setGroups(next.groups)
        if (workspace) {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => {
            const state: CanvasState = { tiles: next.tiles, groups: next.groups, viewport: viewportRef.current, nextZIndex: nextZIndexRef.current }
            window.electron.canvas.save(workspace.id, state)
            skipHistory.current = false
          }, 500)
        } else {
          skipHistory.current = false
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspace, viewport, nextZIndex])

  // ─── Arrange handler ──────────────────────────────────────────────────────
  const handleArrange = useCallback((updated: TileState[]) => {
    const getArrangeWidth = (tile: TileState) => tile.width + ((tile.type === 'terminal' || tile.type === 'chat') ? 272 : 0)

    // Merge positions + sizes back — preserve zIndex / other fields from current state
    setTiles(prev => {
      const updateIndex: Record<string, { x: number; y: number; width?: number; height?: number }> = {}
      for (const t of updated) updateIndex[t.id] = { x: t.x, y: t.y, width: t.width, height: t.height }
      const merged = prev.map(t => {
        const upd = updateIndex[t.id]
        if (!upd) return t
        return {
          ...t,
          x: upd.x,
          y: upd.y,
          ...(upd.width != null ? { width: upd.width } : {}),
          ...(upd.height != null ? { height: upd.height } : {}),
        }
      })
      saveCanvas(merged, viewport, nextZIndex)

      // Zoom to fit — compensate for sidebar width if open
      const rect = canvasRef.current?.getBoundingClientRect()
      if (rect && merged.length > 0) {
        const sidebarOffset = sidebarCollapsed ? 0 : sidebarWidth + 8
        const availableWidth = rect.width - sidebarOffset
        const minX = Math.min(...merged.map(t => t.x))
        const minY = Math.min(...merged.map(t => t.y))
        const maxX = Math.max(...merged.map(t => t.x + getArrangeWidth(t)))
        const maxY = Math.max(...merged.map(t => t.y + t.height))
        const PAD = 60
        const fitZoom = Math.min(
          availableWidth / (maxX - minX + PAD * 2),
          rect.height   / (maxY - minY + PAD * 2),
          2
        )
        const newZoom = fitZoom * 0.9
        // Center within the available area (shifted right by sidebar)
        const centerX = sidebarOffset + availableWidth / 2
        const tx = centerX - ((minX + maxX) / 2) * newZoom
        const ty = rect.height / 2 - ((minY + maxY) / 2) * newZoom
        setViewport({ tx, ty, zoom: newZoom })
      }

      return merged
    })
  }, [viewport, nextZIndex, saveCanvas, sidebarCollapsed, sidebarWidth])

  // ─── Render tile body ─────────────────────────────────────────────────────
  const renderTileBody = (tile: TileState, options?: { isInteracting?: boolean }): React.ReactNode => {
    const isTileInteracting = dragState.type !== null || Boolean(options?.isInteracting)
    switch (tile.type) {
      case 'terminal':
        return (
          <LazyTerminalTile
            tileId={tile.id}
            workspaceDir={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            fontSize={settings.terminalFontSize || appFonts.monoSize}
            fontFamily={settings.terminalFontFamily || appFonts.mono}
            launchBin={tile.launchBin}
            launchArgs={tile.launchArgs}
          />
        )
      case 'code':
        return <LazyCodeTile filePath={tile.filePath} />
      case 'note':
        return <LazyNoteTile tileId={tile.id} filePath={tile.filePath} workspacePath={workspace?.path} />
      case 'image':
        return tile.filePath ? <LazyImageTile filePath={tile.filePath} /> : null
      case 'media':
        return tile.filePath ? <LazyMediaTile tileId={tile.id} filePath={tile.filePath} /> : null
      case 'file':
        return tile.filePath ? (
          <LazyFileTile
            tileId={tile.id}
            filePath={tile.filePath}
            workspacePath={workspace?.path}
            secondaryFont={settings.fonts.secondary}
          />
        ) : null
      case 'browser':
        return (
          <LazyBrowserTile
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            initialUrl={toBrowserTileUrl(tile.filePath ?? '')}
            width={tile.width}
            height={tile.height}
            zIndex={tile.zIndex}
            isInteracting={isTileInteracting}
            connectedPeers={negotiatedDiscoveryState.byTileConnections.get(tile.id)?.map(link => link.peerId) ?? []}
            hideNavbar={tile.hideNavbar}
          />
        )
      case 'kanban':
        return (
          <LazyKanbanTile
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            workspaceDir={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            onFocusTile={(linkedId) => {
              const target = tiles.find(t => t.id === linkedId)
              if (!target) return
              // Bring to front
              bringToFront(linkedId)
              // Pan canvas to center the tile
              const rect = canvasRef.current?.getBoundingClientRect()
              if (!rect) return
              const newTx = rect.width / 2 - (target.x + target.width / 2) * viewport.zoom
              const newTy = rect.height / 2 - (target.y + target.height / 2) * viewport.zoom
              setViewport(prev => ({ ...prev, tx: newTx, ty: newTy }))
            }}
          />
        )
      case 'chat': {
        const chatPeers = (negotiatedDiscoveryState.byTileConnections.get(tile.id) ?? []).map(peer => {
          const extActions = extensionActionRegistry.get(peer.peerId)
          const peerTile = tileByIdMap.get(peer.peerId)
          return {
            ...peer,
            actions: extActions,
            filePath: peerTile?.filePath,
            label: peerTile?.label,
          }
        })
        return (
          <LazyChatTile
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            workspaceDir={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            reloadToken={chatReloadTokens[tile.id] ?? 0}
            settings={settings}
            isConnected={negotiatedDiscoveryState.connectedTileIds.has(tile.id)}
            isAutoConnected={tile.autoAgentMode && negotiatedDiscoveryState.connectedTileIds.has(tile.id)}
            connectedPeers={chatPeers}
          />
        )
      }
      case 'files': {
        const fileLinks = negotiatedDiscoveryState.byTileConnections.get(tile.id) ?? []
        const terminalPeerIds = fileLinks.filter(l => l.peerType === 'terminal').map(l => l.peerId)
        return (
          <LazyFileExplorerTile
            tileId={tile.id}
            workspacePath={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            onOpenFile={handleOpenFile}
            onOpenWorkspace={() => { void handleOpenFolder() }}
            selectedFilePath={sidebarSelectedPath}
            connectedTerminalIds={terminalPeerIds}
          />
        )
      }
      default:
        if (tile.type.startsWith('ext:')) {
          return (
            <LazyExtensionTile
              tileId={tile.id}
              extType={tile.type}
              width={tile.width}
              height={tile.height}
              workspaceId={workspace?.id ?? ''}
              workspacePath={workspace?.path ?? ''}
              isInteracting={isTileInteracting}
              connectedPeers={negotiatedDiscoveryState.byTileConnections.get(tile.id)?.map(link => link.peerId) ?? []}
              onCreateTile={(type, opts) => addTile(
                type as TileType,
                opts?.filePath,
                opts?.x !== undefined && opts?.y !== undefined ? { x: opts.x, y: opts.y } : undefined,
                { hideTitlebar: opts?.hideTitlebar, hideNavbar: opts?.hideNavbar },
              )}
              onActionsChanged={(tId, actions) => { console.log('[App] Extension actions registered:', tId, actions.map(a => a.name)); extensionActionRegistry.set(tId, actions); setExtActionsVersion(v => v + 1) }}
            />
          )
        }
        return null
    }
  }

  // Set of tile IDs that should not render on canvas (in fullscreen panel OR in a layout group)
  const panelTileIds = React.useMemo(() => {
    const ids = new Set<string>()
    if (panelLayout) getAllTileIds(panelLayout).forEach(id => ids.add(id))
    for (const g of groups) {
      if (g.layoutMode) {
        tiles.filter(t => t.groupId === g.id).forEach(t => ids.add(t.id))
      }
    }
    return ids
  }, [panelLayout, groups, tiles])

  useEffect(() => {
    panelTileIdsRef.current = panelTileIds
  }, [panelTileIds])

  const tileByIdMap = React.useMemo(() => new Map(tiles.map(tile => [tile.id, tile])), [tiles])

  const discoveryFocusTileId = React.useMemo(() => {
    if (dragState.type === 'tile' || dragState.type === 'resize') return dragState.tileId
    return selectedTileId
  }, [dragState, selectedTileId])

  const discoveryPreview = React.useMemo(() => {
    if (!discoveryFocusTileId) return null
    const gridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
    const maxDistance = getDiscoveryMaxDistance(settings.gridSpacingLarge || DEFAULT_SETTINGS.gridSpacingLarge)
    return findDiscoveryMatch(discoveryFocusTileId, tiles, panelTileIds, gridStep, maxDistance)
  }, [discoveryFocusTileId, panelTileIds, settings.gridSize, settings.gridSpacingSmall, settings.gridSpacingLarge, tiles])

  const negotiatedDiscoveryState = React.useMemo(() => {
    const gridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
    const maxDistance = getDiscoveryMaxDistance(settings.gridSpacingLarge || DEFAULT_SETTINGS.gridSpacingLarge)
    const routes = new Map<string, { key: string; route: { x: number; y: number }[]; distance: number; locked: boolean }>()

    // Pass empty set — panel/layout tiles must stay in the graph so peers keep their tools/connections.
    // Visual hiding is handled at ambientDiscoveryRoutes level only.
    const connectionGraph = findDiscoveryConnections(tiles, new Set(), gridStep, maxDistance)

    // Remove suppressed connections (deleted by user, cleared when tiles move)
    for (const key of suppressedConnections) {
      const [a, b] = key.split('::')
      const aLinks = connectionGraph.byTile.get(a)
      if (aLinks) connectionGraph.byTile.set(a, aLinks.filter(l => l.peerId !== b))
      const bLinks = connectionGraph.byTile.get(b)
      if (bLinks) connectionGraph.byTile.set(b, bLinks.filter(l => l.peerId !== a))
      // Remove route
      routes.delete(key)
    }

    // Inject locked connections — these persist even when tiles move apart
    const tileMap = new Map(tiles.map(t => [t.id, t]))
    if (lockedConnections.length > 0) console.log('[Discovery] Injecting locked connections:', lockedConnections.length)
    for (const lc of lockedConnections) {
      const src = tileMap.get(lc.sourceTileId)
      const tgt = tileMap.get(lc.targetTileId)
      if (!src || !tgt) continue
      const existingLinks = connectionGraph.byTile.get(src.id)
      const alreadyLinkedByProximity = existingLinks?.some(l => l.peerId === tgt.id) ?? false
      const srcCaps = getTileCapabilities(src)
      const tgtCaps = getTileCapabilities(tgt)
      const srcRef = getTileSpatialReference(src, gridStep)
      const tgtRef = getTileSpatialReference(tgt, gridStep)
      const pair = findBestAnchorPair(srcRef.anchors, tgtRef.anchors)
      if (!pair) continue
      const route = getOrthogonalRoute(pair.source, pair.target, gridStep)
      const dist = pair.distance

      if (!alreadyLinkedByProximity) {
        const srcLink: DiscoveryCapabilityLink = { peerId: tgt.id, peerType: tgt.type, distance: dist, route, capabilities: [...tgtCaps.provides.map(c => `cap:${c}`), ...srcCaps.accepts.map(c => `accept:${c}`)], lastSeen: Date.now() }
        const tgtLink: DiscoveryCapabilityLink = { peerId: src.id, peerType: src.type, distance: dist, route: [...route].reverse(), capabilities: [...srcCaps.provides.map(c => `cap:${c}`), ...tgtCaps.accepts.map(c => `accept:${c}`)], lastSeen: Date.now() }
        connectionGraph.connectedTileIds.add(src.id)
        connectionGraph.connectedTileIds.add(tgt.id)
        const srcLinks = connectionGraph.byTile.get(src.id) ?? []
        srcLinks.push(srcLink)
        connectionGraph.byTile.set(src.id, srcLinks)
        const tgtLinks = connectionGraph.byTile.get(tgt.id) ?? []
        tgtLinks.push(tgtLink)
        connectionGraph.byTile.set(tgt.id, tgtLinks)
      }

      const key = [src.id, tgt.id].sort().join('::')
      routes.set(key, { key, route, distance: dist, locked: true })
    }

    for (const tile of tiles) {
      const discovery = findDiscoveryMatch(tile.id, tiles, new Set(), gridStep, maxDistance)
      if (!discovery?.match) continue

      const key = [tile.id, discovery.match.tile.id].sort().join('::')
      const existing = routes.get(key)
      if (existing?.locked) continue
      if (!existing || discovery.match.distance < existing.distance) {
        routes.set(key, {
          key,
          route: discovery.match.route,
          distance: discovery.match.distance,
          locked: false,
        })
      }
    }

    return {
      connectedTileIds: connectionGraph.connectedTileIds,
      byTileConnections: connectionGraph.byTile,
      ambientRoutes: Array.from(routes.values()).map(({ key, route, locked }) => ({ key, route, locked })),
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelTileIds, settings.gridSize, settings.gridSpacingSmall, settings.gridSpacingLarge, tiles, lockedConnections, suppressedConnections, extActionsVersion])

  // Push peer updates to terminal tiles when discovery state changes
  const prevTerminalPeersRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    if (!workspace?.path) return
    const validTools = new Set(getAllNodeTools().map(t => t.name))
    const newMap = new Map<string, string>()

    for (const tile of tiles) {
      if (tile.type !== 'terminal') continue
      const links = negotiatedDiscoveryState.byTileConnections.get(tile.id)
      const peers = (links ?? []).map(link => {
        const tools: string[] = []
        for (const cap of link.capabilities) {
          if (!cap.startsWith('tool:')) continue
          const name = stripCapabilityPrefix(cap)
          if (name && validTools.has(name)) tools.push(name)
        }
        return { peerId: link.peerId, peerType: link.peerType, tools }
      })
      // Serialize to detect changes without deep-compare
      const key = JSON.stringify(peers)
      newMap.set(tile.id, key)

      if (prevTerminalPeersRef.current.get(tile.id) !== key) {
        window.electron.terminal.updatePeers(tile.id, workspace.path, peers)
      }
    }

    // Clean up peers.md for terminals that lost all peers
    for (const [tileId, _prev] of prevTerminalPeersRef.current) {
      if (!newMap.has(tileId)) {
        window.electron.terminal.updatePeers(tileId, workspace!.path, [])
      }
    }

    prevTerminalPeersRef.current = newMap
  }, [negotiatedDiscoveryState.byTileConnections, tiles, workspace?.path])

  // ─── Locked connection helpers ──────────────────────────────────────────────
  const isConnectionLocked = useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    return lockedConnections.some(lc => {
      const [la, lb] = [lc.sourceTileId, lc.targetTileId].sort()
      return la === a && lb === b
    })
  }, [lockedConnections])

  const toggleConnectionLock = useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    setLockedConnections(prev => {
      const idx = prev.findIndex(lc => {
        const [la, lb] = [lc.sourceTileId, lc.targetTileId].sort()
        return la === a && lb === b
      })
      const next = idx >= 0
        ? prev.filter((_, i) => i !== idx)
        : [...prev, { sourceTileId: a, targetTileId: b }]
      lockedConnectionsRef.current = next
      console.log('[Lock]', idx >= 0 ? 'Unlocked' : 'Locked', a, b, 'total:', next.length)
      setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, groupsRef.current), 0)
      return next
    })
  }, [persistCanvasState])

  const deleteConnection = useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    const key = `${a}::${b}`
    // Remove from locked connections
    setLockedConnections(prev => {
      const next = prev.filter(lc => {
        const [la, lb] = [lc.sourceTileId, lc.targetTileId].sort()
        return !(la === a && lb === b)
      })
      lockedConnectionsRef.current = next
      setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, groupsRef.current), 0)
      return next
    })
    // Suppress proximity auto-reconnect until tiles move
    setSuppressedConnections(prev => new Set(prev).add(key))
  }, [persistCanvasState])

  const lockedConnectionKeys = React.useMemo(() => {
    return new Set(lockedConnections.map(lc => [lc.sourceTileId, lc.targetTileId].sort().join('::')))
  }, [lockedConnections])

  const ambientDiscoveryRoutes = React.useMemo(() => {
    // Never show routes where either endpoint is hidden (inside a layout or fullview panel)
    const visibleRoutes = negotiatedDiscoveryState.ambientRoutes.filter(r => {
      const [a, b] = r.key.split('::')
      return !panelTileIds.has(a) && !panelTileIds.has(b)
    })
    if (discoveryFocusTileId) {
      return visibleRoutes.filter(r => lockedConnectionKeys.has(r.key))
    }
    return visibleRoutes.filter(route => !lockedConnectionKeys.has(route.key) || route.locked)
  }, [discoveryFocusTileId, negotiatedDiscoveryState, lockedConnectionKeys, panelTileIds])

  const ambientDiscoveryRenderRoutes = React.useMemo(() => {
    if (ambientDiscoveryRoutes.length === 0) return []

    const worldLaneSpacing = 12 / Math.max(0.25, viewport.zoom)
    const grouped = new Map<string, Array<typeof ambientDiscoveryRoutes[number]>>()

    for (const route of ambientDiscoveryRoutes) {
      const signature = getRouteSignature(route.route)
      const group = grouped.get(signature) ?? []
      group.push(route)
      grouped.set(signature, group)
    }

    const offsets = new Map<string, number>()
    for (const routes of grouped.values()) {
      const laneOffsets = getLaneOffsets(routes.length).map(offset => offset * worldLaneSpacing)
      const orderedRoutes = [...routes].sort((a, b) => {
        if (a.locked !== b.locked) return a.locked ? -1 : 1
        return a.key.localeCompare(b.key)
      })
      orderedRoutes.forEach((route, index) => {
        offsets.set(route.key, laneOffsets[index] ?? 0)
      })
    }

    return ambientDiscoveryRoutes.map(route => ({
      ...route,
      baseRoute: route.route,
      displayRoute: offsetOrthogonalRoute(route.route, offsets.get(route.key) ?? 0),
    }))
  }, [ambientDiscoveryRoutes, viewport.zoom])

  const isDraggingCanvas = dragState.type === 'pan'

  const appFonts = React.useMemo(() => {
    const p = settings.fonts?.primary ?? settings.primaryFont
    const s = settings.fonts?.secondary ?? settings.secondaryFont
    const m = settings.fonts?.mono ?? settings.monoFont
    return {
      primary: p?.family ?? SANS_DEFAULT,
      secondary: s?.family ?? SANS_DEFAULT,
      mono: m?.family ?? MONO_DEFAULT,
      size: p?.size ?? 13,
      lineHeight: p?.lineHeight ?? 1.5,
      weight: p?.weight ?? 400,
      secondarySize: s?.size ?? 11,
      secondaryLineHeight: s?.lineHeight ?? 1.4,
      secondaryWeight: s?.weight ?? 400,
      monoSize: m?.size ?? 13,
      monoLineHeight: m?.lineHeight ?? 1.5,
      monoWeight: m?.weight ?? 400,
    }
  }, [settings.fonts, settings.primaryFont, settings.secondaryFont, settings.monoFont])

  useEffect(() => {
    if (sidebarResizing) {
      setSidebarPillVisible(false)
      return
    }

    const timer = window.setTimeout(() => setSidebarPillVisible(true), 90)
    return () => window.clearTimeout(timer)
  }, [sidebarResizing])

  useEffect(() => {
    void window.electron?.window?.setSidebarCollapsed?.(sidebarCollapsed).catch(() => {})
  }, [sidebarCollapsed])

  const fontTokens = React.useMemo(() => settings.fonts, [settings.fonts])

  useEffect(() => {
    void window.electron?.appearance?.shouldUseDark?.().then(setSystemPrefersDark).catch(() => {})
    const unsub = window.electron?.appearance?.onUpdated?.(p => setSystemPrefersDark(p.shouldUseDark))
    return unsub
  }, [])

  useEffect(() => {
    const mode = settings.appearance ?? 'dark'
    void window.electron?.appearance?.setThemeSource?.(mode)
  }, [settings.appearance])

  const effectiveThemeId = React.useMemo(
    () => resolveEffectiveThemeId(settings.appearance, settings.themeId, systemPrefersDark),
    [settings.appearance, settings.themeId, systemPrefersDark],
  )
  const theme = React.useMemo(() => getThemeById(effectiveThemeId), [effectiveThemeId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    setBrandPrefsReadyTheme(null)
    try {
      const savedWordmark = window.localStorage.getItem(`${BRAND_WORDMARK_CACHE_KEY}:${effectiveThemeId}`)
      const savedPalette = window.localStorage.getItem(`${BRAND_WORDMARK_PALETTE_CACHE_KEY}:${effectiveThemeId}`)
      const nextWordmark = savedWordmark === null ? 1 : Number.parseInt(savedWordmark, 10)
      const nextPalette = savedPalette === null ? 0 : Number.parseInt(savedPalette, 10)
      setBrandWordmarkIndex(Number.isFinite(nextWordmark) && nextWordmark >= 0 ? nextWordmark : 1)
      setBrandPaletteIndex(Number.isFinite(nextPalette) && nextPalette >= 0 ? nextPalette : 0)
    } catch {
      setBrandWordmarkIndex(1)
      setBrandPaletteIndex(0)
    }
    setBrandPrefsReadyTheme(effectiveThemeId)
  }, [effectiveThemeId])

  useEffect(() => {
    if (typeof window === 'undefined' || brandPrefsReadyTheme !== effectiveThemeId) return
    try {
      window.localStorage.setItem(`${BRAND_WORDMARK_CACHE_KEY}:${effectiveThemeId}`, String(brandWordmarkIndex))
      window.localStorage.setItem(`${BRAND_WORDMARK_PALETTE_CACHE_KEY}:${effectiveThemeId}`, String(brandPaletteIndex))
    } catch {}
  }, [brandWordmarkIndex, brandPaletteIndex, brandPrefsReadyTheme, effectiveThemeId])
  const brandWordmarks = React.useMemo(() => [
    [
      '░█▀▀░█▀█░█▀▄░█▀▀░█▀▀░█░█░█▀▄░█▀▀',
      '░█░░░█░█░█░█░█▀▀░▀▀█░█░█░█▀▄░█▀▀',
      '░▀▀▀░▀▀▀░▀▀░░▀▀▀░▀▀▀░▀▀▀░▀░▀░▀░░',
    ],
    [
      ' ██████╗ ██████╗ ██████╗ ███████╗███████╗██╗   ██╗██████╗ ███████╗',
      '██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██║   ██║██╔══██╗██╔════╝',
      '██║     ██║   ██║██║  ██║█████╗  ███████╗██║   ██║██████╔╝█████╗  ',
      '██║     ██║   ██║██║  ██║██╔══╝  ╚════██║██║   ██║██╔══██╗██╔══╝  ',
      '╚██████╗╚██████╔╝██████╔╝███████╗███████║╚██████╔╝██║  ██║██║     ',
      ' ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝     ',
    ],
    [
      ' ██████  ██████  ██████  ███████ ███████ ██    ██ ██████  ███████ ',
      '██      ██    ██ ██   ██ ██      ██      ██    ██ ██   ██ ██      ',
      '██      ██    ██ ██   ██ █████   ███████ ██    ██ ██████  █████   ',
      '██      ██    ██ ██   ██ ██           ██ ██    ██ ██   ██ ██      ',
      ' ██████  ██████  ██████  ███████ ███████  ██████  ██   ██ ██      ',
    ],
    [
      '        CCCCCCCCCCCCC     OOOOOOOOO     DDDDDDDDDDDDD      EEEEEEEEEEEEEEEEEEEEEE   SSSSSSSSSSSSSSS UUUUUUUU     UUUUUUUURRRRRRRRRRRRRRRRR   FFFFFFFFFFFFFFFFFFFFFF',
      '     CCC::::::::::::C   OO:::::::::OO   D::::::::::::DDD   E::::::::::::::::::::E SS:::::::::::::::SU::::::U     U::::::UR::::::::::::::::R  F::::::::::::::::::::F',
      '   CC:::::::::::::::C OO:::::::::::::OO D:::::::::::::::DD E::::::::::::::::::::ES:::::SSSSSS::::::SU::::::U     U::::::UR::::::RRRRRR:::::R F::::::::::::::::::::F',
      '  C:::::CCCCCCCC::::CO:::::::OOO:::::::ODDD:::::DDDDD:::::DEE::::::EEEEEEEEE::::ES:::::S     SSSSSSSUU:::::U     U:::::UURR:::::R     R:::::RFF::::::FFFFFFFFF::::F',
      ' C:::::C       CCCCCCO::::::O   O::::::O  D:::::D    D:::::D E:::::E       EEEEEES:::::S             U:::::U     U:::::U   R::::R     R:::::R  F:::::F       FFFFFF',
      'C:::::C              O:::::O     O:::::O  D:::::D     D:::::DE:::::E             S:::::S             U:::::D     D:::::U   R::::R     R:::::R  F:::::F             ',
      'C:::::C              O:::::O     O:::::O  D:::::D     D:::::DE::::::EEEEEEEEEE    S::::SSSS          U:::::D     D:::::U   R::::RRRRRR:::::R   F::::::FFFFFFFFFF   ',
      'C:::::C              O:::::O     O:::::O  D:::::D     D:::::DE:::::::::::::::E     SS::::::SSSSS     U:::::D     D:::::U   R:::::::::::::RR    F:::::::::::::::F   ',
      'C:::::C              O:::::O     O:::::O  D:::::D     D:::::DE:::::::::::::::E       SSS::::::::SS   U:::::D     D:::::U   R::::RRRRRR:::::R   F:::::::::::::::F   ',
      'C:::::C              O:::::O     O:::::O  D:::::D     D:::::DE::::::EEEEEEEEEE          SSSSSS::::S  U:::::D     D:::::U   R::::R     R:::::R  F::::::FFFFFFFFFF   ',
      'C:::::C              O:::::O     O:::::O  D:::::D     D:::::DE:::::E                         S:::::S U:::::D     D:::::U   R::::R     R:::::R  F:::::F             ',
      ' C:::::C       CCCCCCO::::::O   O::::::O  D:::::D    D:::::D E:::::E       EEEEEE            S:::::S U::::::U   U::::::U   R::::R     R:::::R  F:::::F             ',
      '  C:::::CCCCCCCC::::CO:::::::OOO:::::::ODDD:::::DDDDD:::::DEE::::::EEEEEEEE:::::ESSSSSSS     S:::::S U:::::::UUU:::::::U RR:::::R     R:::::RFF:::::::FF           ',
      '   CC:::::::::::::::C OO:::::::::::::OO D:::::::::::::::DD E::::::::::::::::::::ES::::::SSSSSS:::::S  UU:::::::::::::UU  R::::::R     R:::::RF::::::::FF           ',
      '     CCC::::::::::::C   OO:::::::::OO   D::::::::::::DDD   E::::::::::::::::::::ES:::::::::::::::SS     UU:::::::::UU    R::::::R     R:::::RF::::::::FF           ',
      '        CCCCCCCCCCCCC     OOOOOOOOO     DDDDDDDDDDDDD      EEEEEEEEEEEEEEEEEEEEEE SSSSSSSSSSSSSSS         UUUUUUUUU      RRRRRRRR     RRRRRRRFFFFFFFFFFF           ',
    ],
    [
      '__________  ____  ___________ __  ______  ______',
      '  / ____/ __ \/ __ \/ ____/ ___// / / / __ \/ ____/',
      ' / /   / / / / / / / __/  \\__ \/ / / / /_/ / /_    ',
      '/ /___/ /_/ / /_/ / /___ ___/ / /_/ / _, _/ __/    ',
      '\\____/\\____/_____/_____//____/\\____/_/ |_/_/     ',
    ],
    [
      ' _________  ___  __________  _____  ____',
      ' / ___/ __ \/ _ \/ __/ __/ / / / _ \/ __/',
      '/ /__/ /_/ / // / _/_\\ \/ /_/ / , _/ _/  ',
      '\\___/\\____/____/___/___/\\____/_/|_/_/   ',
    ],
    [
      '░██████    ░██████   ░███████   ░██████████   ░██████   ░██     ░██ ░█████████  ░██████████',
      ' ░██   ░██  ░██   ░██  ░██   ░██  ░██          ░██   ░██  ░██     ░██ ░██     ░██ ░██        ',
      '░██        ░██     ░██ ░██    ░██ ░██         ░██         ░██     ░██ ░██     ░██ ░██        ',
      '░██        ░██     ░██ ░██    ░██ ░█████████   ░████████  ░██     ░██ ░█████████  ░█████████ ',
      '░██        ░██     ░██ ░██    ░██ ░██                 ░██ ░██     ░██ ░██   ░██   ░██        ',
      ' ░██   ░██  ░██   ░██  ░██   ░██  ░██          ░██   ░██   ░██   ░██  ░██    ░██  ░██        ',
      '  ░██████    ░██████   ░███████   ░██████████   ░██████     ░██████   ░██     ░██ ░██        ',
    ],
    [
      '_____  ____   _____   ______   _____  _    _  _____   ______ ',
      '  / ____|/ __ \\ |  __ \\ |  ____| / ____|| |  | ||  __ \\ |  ____|',
      ' | |    | |  | || |  | || |__   | (___  | |  | || |__) || |__   ',
      ' | |    | |  | || |  | ||  __|   \\___ \\ | |  | ||  _  / |  __|  ',
      ' | |____| |__| || |__| || |____  ____) || |__| || | \\ \\ | |     ',
      '  \\_____|\\____/ |_____/ |______||_____/  \\____/ |_|  \\_\\|_|     ',
    ],
    [
      '▄█████ ▄████▄ ████▄  ██████ ▄█████ ██  ██ █████▄  ██████ ',
      '██     ██  ██ ██  ██ ██▄▄   ▀▀▀▄▄▄ ██  ██ ██▄▄██▄ ██▄▄   ',
      '▀█████ ▀████▀ ████▀  ██▄▄▄▄ █████▀ ▀████▀ ██   ██ ██     ',
    ],
    [
      '▄▄▄▄▄▄▄   ▄▄▄▄▄   ▄▄▄▄▄▄    ▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄ ▄▄▄  ▄▄▄ ▄▄▄▄▄▄▄    ▄▄▄▄▄▄▄ ',
      '███▀▀▀▀▀ ▄███████▄ ███▀▀██▄ ███▀▀▀▀▀ █████▀▀▀ ███  ███ ███▀▀███▄ ███▀▀▀▀▀ ',
      '███      ███   ███ ███  ███ ███▄▄     ▀████▄  ███  ███ ███▄▄███▀ ███▄▄    ',
      '███      ███▄▄▄███ ███  ███ ███         ▀████ ███▄▄███ ███▀▀██▄  ███▀▀    ',
      '▀███████  ▀█████▀  ██████▀  ▀███████ ███████▀ ▀██████▀ ███  ▀███ ███      ',
    ],
    [
      '▄████████  ▄██████▄  ████████▄     ▄████████    ▄████████ ███    █▄     ▄████████    ▄████████ ',
      '███    ███ ███    ███ ███   ▀███   ███    ███   ███    ███ ███    ███   ███    ███   ███    ███ ',
      '███    █▀  ███    ███ ███    ███   ███    █▀    ███    █▀  ███    ███   ███    ███   ███    █▀  ',
      '███        ███    ███ ███    ███  ▄███▄▄▄       ███        ███    ███  ▄███▄▄▄▄██▀  ▄███▄▄▄     ',
      '███        ███    ███ ███    ███ ▀▀███▀▀▀     ▀███████████ ███    ███ ▀▀███▀▀▀▀▀   ▀▀███▀▀▀     ',
      '███    █▄  ███    ███ ███    ███   ███    █▄           ███ ███    ███ ▀███████████   ███        ',
      '███    ███ ███    ███ ███   ▄███   ███    ███    ▄█    ███ ███    ███   ███    ███   ███        ',
      '████████▀   ▀██████▀  ████████▀    ██████████  ▄████████▀  ████████▀    ███    ███   ███        ',
      '                                                                        ███    ███              ',
    ],
    [
      '▄▄▄▄     ▄▄▄▄    ▄▄▄▄▄     ▄▄▄▄▄▄▄▄    ▄▄▄▄    ▄▄    ▄▄  ▄▄▄▄▄▄    ▄▄▄▄▄▄▄▄ ',
      '  ██▀▀▀▀█   ██▀▀██   ██▀▀▀██   ██▀▀▀▀▀▀  ▄█▀▀▀▀█   ██    ██  ██▀▀▀▀██  ██▀▀▀▀▀▀ ',
      ' ██▀       ██    ██  ██    ██  ██        ██▄       ██    ██  ██    ██  ██       ',
      ' ██        ██    ██  ██    ██  ███████    ▀████▄   ██    ██  ███████   ███████  ',
      ' ██▄       ██    ██  ██    ██  ██             ▀██  ██    ██  ██  ▀██▄  ██       ',
      '  ██▄▄▄▄█   ██▄▄██   ██▄▄▄██   ██▄▄▄▄▄▄  █▄▄▄▄▄█▀  ▀██▄▄██▀  ██    ██  ██       ',
      '    ▀▀▀▀     ▀▀▀▀    ▀▀▀▀▀     ▀▀▀▀▀▀▀▀   ▀▀▀▀▀      ▀▀▀▀    ▀▀    ▀▀▀ ▀▀       ',
    ],
    [
      '▄▄▄   ▄▄▄▄  ▄▄▄▄   ▄▄▄▄▄▄  ▄▄▄▄  ▄    ▄ ▄▄▄▄▄  ▄▄▄▄▄▄',
      ' ▄▀   ▀ ▄▀  ▀▄ █   ▀▄ █      █▀   ▀ █    █ █   ▀█ █     ',
      ' █      █    █ █    █ █▄▄▄▄▄ ▀█▄▄▄  █    █ █▄▄▄▄▀ █▄▄▄▄▄',
      ' █      █    █ █    █ █          ▀█ █    █ █   ▀▄ █     ',
      '  ▀▄▄▄▀  █▄▄█  █▄▄▄▀  █▄▄▄▄▄ ▀▄▄▄█▀ ▀▄▄▄▄▀ █    ▀ █     ',
    ],
    [
      '.o88b.  .d88b.  d8888b. d88888b .d8888. db    db d8888b. d88888b ',
      'd8P  Y8 .8P  Y8. 88  `8D 88\'     88\'  YP 88    88 88  `8D 88\'     ',
      '8P      88    88 88   88 88ooooo `8bo.   88    88 88oobY\' 88ooo   ',
      '8b      88    88 88   88 88~~~~~   `Y8b. 88    88 88`8b   88~~~   ',
      'Y8b  d8 `8b  d8\' 88  .8D 88.     db   8D 88b  d88 88 `88. 88      ',
      ' `Y88P\'  `Y88P\'  Y8888D\' Y88888P `8888Y\' ~Y8888P\' 88   YD YP      ',
    ],
    [
      '.d8888b.   .d88888b.  8888888b.  8888888888 .d8888b.  888     888 8888888b.  8888888888 ',
      'd88P  Y88b d88P" "Y88b 888  "Y88b 888       d88P  Y88b 888     888 888   Y88b 888        ',
      '888    888 888     888 888    888 888       Y88b.      888     888 888    888 888        ',
      '888        888     888 888    888 8888888    "Y888b.   888     888 888   d88P 8888888    ',
      '888        888     888 888    888 888           "Y88b. 888     888 8888888P"  888        ',
      '888    888 888     888 888    888 888             "888 888     888 888 T88b   888        ',
      'Y88b  d88P Y88b. .d88P 888  .d88P 888       Y88b  d88P Y88b. .d88P 888  T88b  888        ',
      ' "Y8888P"   "Y88888P"  8888888P"  8888888888 "Y8888P"   "Y88888P"  888   T88b 888        ',
    ],
    [
      '_______ _______ ______   _______ _______ ___ ___ _______ _______ ',
      ' |   _   |   _   |   _  \\ |   _   |   _   |   Y   |   _   |   _   |',
      ' |.  1___|.  |   |.  |   \\|.  1___|   1___|.  |   |.  l   |.  1___|',
      ' |.  |___|.  |   |.  |    |.  __)_|____   |.  |   |.  _   |.  __)  ',
      ' |:  1   |:  1   |:  1    |:  1   |:  1   |:  1   |:  |   |:  |    ',
      ' |::.. . |::.. . |::.. . /|::.. . |::.. . |::.. . |::.|:. |::.|    ',
      ' `-------`-------`------\' `-------`-------`-------`--- ---`---\'    ',
    ],
    [
      '█████████     ███████    ██████████   ██████████  █████████  █████  █████ ███████████   ███████████',
      '  ███░░░░░███  ███░░░░░███ ░░███░░░░███ ░░███░░░░░█ ███░░░░░███░░███  ░░███ ░░███░░░░░███ ░░███░░░░░░█',
      ' ███     ░░░  ███     ░░███ ░███   ░░███ ░███  █ ░ ░███    ░░░  ░███   ░███  ░███    ░███  ░███   █ ░ ',
      '░███         ░███      ░███ ░███    ░███ ░██████   ░░█████████  ░███   ░███  ░██████████   ░███████   ',
      '░███         ░███      ░███ ░███    ░███ ░███░░█    ░░░░░░░░███ ░███   ░███  ░███░░░░░███  ░███░░░█   ',
      '░░███     ███░░███     ███  ░███    ███  ░███ ░   █ ███    ░███ ░███   ░███  ░███    ░███  ░███  ░    ',
      ' ░░█████████  ░░░███████░   ██████████   ██████████░░█████████  ░░████████   █████   █████ █████      ',
      '  ░░░░░░░░░     ░░░░░░░    ░░░░░░░░░░   ░░░░░░░░░░  ░░░░░░░░░    ░░░░░░░░   ░░░░░   ░░░░░ ░░░░░      ',
    ],
    [
      'MM\'""""\'YMM MMP"""""YMM M""""""\'YMM MM""""""""`M MP""""""`MM M""MMMMM""M MM"""""""`MM MM""""""""`M ',
      'M\' .mmm. `M M\' .mmm. `M M  mmmm. `M MM  mmmmmmmM M  mmmmm..M M  MMMMM  M MM  mmmm,  M MM  mmmmmmmM ',
      'M  MMMMMooM M  MMMMM  M M  MMMMM  M M`      MMMM M.      `YM M  MMMMM  M M\'        .M M\'      MMMM ',
      'M  MMMMMMMM M  MMMMM  M M  MMMMM  M MM  MMMMMMMM MMMMMMM.  M M  MMMMM  M MM  MMMb. "M MM  MMMMMMMM ',
      'M. `MMM\' .M M. `MMM\' .M M  MMMM\' .M MM  MMMMMMMM M. .MMM\'  M M  `MMM\'  M MM  MMMMM  M MM  MMMMMMMM ',
      'MM.     .dM MMb     dMM M       .MM MM        .M Mb.     .dM Mb       dM MM  MMMMM  M MM  MMMMMMMM ',
      'MMMMMMMMMMM MMMMMMMMMMM MMMMMMMMMMM MMMMMMMMMMMM MMMMMMMMMMM MMMMMMMMMMM MMMMMMMMMMMM MMMMMMMMMMMM ',
    ],
    [
      '.aMMMb  .aMMMb  dMMMMb  dMMMMMP .dMMMb  dMP dMP dMMMMb  dMMMMMP ',
      '  dMP"VMP dMP"dMP dMP VMP dMP     dMP" VP dMP dMP dMP.dMP dMP      ',
      ' dMP     dMP dMP dMP dMP dMMMP    VMMMb  dMP dMP dMMMMK" dMMMP     ',
      'dMP.aMP dMP.aMP dMP.aMP dMP     dP .dMP dMP.aMP dMP"AMF dMP        ',
      'VMMMP"  VMMMP" dMMMMP" dMMMMMP  VMMMP"  VMMMP" dMP dMP dMP        ',
    ],
  ], [])
  const brandPalettes = React.useMemo(() => theme.mode === 'dark'
    ? [
        ['#8bd5ff', '#6db8ff', '#7ee7c8', '#6db8ff', '#8bd5ff', '#7ee7c8'],
        ['#ffd166', '#ff9f1c', '#ff6b6b', '#c77dff', '#7bdff2', '#72efdd'],
        ['#f8fafc', '#cbd5e1', '#94a3b8', '#38bdf8', '#22c55e', '#f59e0b'],
        ['#ffadad', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#bdb2ff'],
        ['#e879f9', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#fb7185'],
        ['#f5f5f5', '#e5e5e5', '#d4d4d4', '#fafafa', '#e5e7eb', '#ffffff'],
        ['#9ca3af', '#6b7280', '#4b5563', '#d1d5db', '#9ca3af', '#6b7280'],
        ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
        ['#000000', '#000000', '#000000', '#000000', '#000000', '#000000'],
      ]
    : [
        ['#67b8ff', '#4aa3ff', '#8bd5ff', '#4aa3ff', '#67b8ff', '#8bd5ff'],
        ['#8a2b06', '#c2410c', '#b91c1c', '#7c3aed', '#0369a1', '#0f766e'],
        ['#111827', '#374151', '#6b7280', '#2563eb', '#059669', '#d97706'],
        ['#9f1239', '#c2410c', '#ca8a04', '#15803d', '#0f766e', '#4338ca'],
        ['#be185d', '#9333ea', '#2563eb', '#0891b2', '#16a34a', '#ea580c'],
        ['#404040', '#525252', '#737373', '#a3a3a3', '#d4d4d4', '#171717'],
        ['#111111', '#000000', '#1f2937', '#374151', '#4b5563', '#6b7280'],
        ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
        ['#000000', '#000000', '#000000', '#000000', '#000000', '#000000'],
      ], [theme.mode])
  const activeBrandWordmark = brandWordmarks[brandWordmarkIndex % brandWordmarks.length]
  const activeBrandPalette = brandPalettes[brandPaletteIndex % brandPalettes.length]
  const activeBrandWordmarkScale = activeBrandWordmark[0]
    ? Math.min(1, (32 / activeBrandWordmark[0].length) * (
      brandWordmarkIndex === 0 ? 1 : brandWordmarkIndex === 1 ? 1.44 : 1.2
    )) * 0.62
    : 1
  const translucentBackgroundOpacity = Math.max(0.05, Math.min(1, settings.translucentBackgroundOpacity ?? 1))
  const canvasBackground = withAlpha(settings.canvasBackground, translucentBackgroundOpacity)
  const canvasLayerBackground = theme.canvas.backgroundEffect
    ? `${theme.canvas.backgroundEffect}, ${canvasBackground}`
    : canvasBackground
  const sidebarPanelTop = 0
  const sidebarFooterBottom = 0
  const sidebarFooterLeft = 0
  const sidebarFooterHeight = 42
  const sidebarToFooterGap = 8
  const sidebarPanelBottomOffset = sidebarFooterBottom + sidebarFooterHeight - 12
  const mainPanelBottomInset = sidebarPanelBottomOffset
  const mainStatusBarLeft = sidebarCollapsed ? 0 : sidebarWidth
  const openSidebarToolbarPadding = sidebarWidth + 16
  const openSidebarPillLeft = sidebarWidth - 4
  const sidebarScrollTrackTop = 48
  const sidebarScrollTrackBottom = sidebarFooterHeight + 10
  const collapsedSidebarPillHeight = 32
  const sidebarScrollIndicatorMinRatio = 0.045
  const sidebarScrollIndicatorMaxRatio = 0.11
  const sidebarScrollIndicatorRatio = sidebarScrollMetrics.hasOverflow
    ? Math.max(
        sidebarScrollIndicatorMinRatio,
        Math.min(sidebarScrollIndicatorMaxRatio, sidebarScrollMetrics.thumbRatio * 0.42),
      )
    : 0
  const sidebarScrollIndicatorTop = sidebarScrollMetrics.hasOverflow
    ? `${sidebarScrollMetrics.topRatio * (1 - sidebarScrollIndicatorRatio) * 100}%`
    : `calc(50% - ${collapsedSidebarPillHeight / 2}px)`
  const expandedLayoutLeft = sidebarWidth + 2
  const discoveryHighlightZIndex = 0
  const discoveryGlowZIndex = 0
  const discoveryPillZIndex = 99997
  const openWorkspaceTabs = openWorkspaceIds
    .map(id => workspaces.find(ws => ws.id === id) ?? null)
    .filter((ws): ws is Workspace => Boolean(ws))
  const hasWorkspaceTabs = openWorkspaceTabs.length > 0
  const workspaceTitleFallback = workspace?.name?.trim() || 'WORKSPACES'
  const showTopWorkspacePickerTab = showWorkspacePickerTab || (!workspace && openWorkspaceTabs.length === 0)
  // Discovery connection colors — adapt to theme mode
  const dsc = theme.mode === 'light'
    ? { line: '53, 104, 255', dot: '53, 104, 255', bg: '255, 255, 255', text: theme.accent.base }
    : { line: '123, 241, 255', dot: '123, 241, 255', bg: '5, 13, 19', text: 'rgba(215, 247, 255, 0.97)' }

  useEffect(() => {
    if (!canvasGlowEnabled) hideCanvasGlow()
    return () => hideCanvasGlow()
  }, [canvasGlowEnabled, hideCanvasGlow])

  useEffect(() => () => {
    discoveryTimeoutsRef.current.forEach(timeout => window.clearTimeout(timeout))
    discoveryTimeoutsRef.current = []
  }, [])

  return (
    <ThemeProvider value={theme}>
    <FontTokenProvider value={fontTokens}>
    <FontProvider value={appFonts}>
    <div className="w-full h-full" style={{ position: 'relative', color: theme.text.primary, fontFamily: appFonts.primary, fontSize: appFonts.size, background: theme.surface.app }}>
      {/* Sidebar inset panel — floats over the canvas */}
      <div style={{
        position: 'absolute',
        top: sidebarPanelTop,
        left: 0,
        bottom: 0,
        padding: '0px',
        width: sidebarCollapsed ? 0 : sidebarWidth,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minWidth: sidebarCollapsed ? 0 : 270,
        zIndex: 10,
        pointerEvents: 'none',
        transition: 'width 0.15s ease',
      }}>
        <div style={{
          width: '100%',
          height: '100%',
          background: theme.surface.sidebarOverlay,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderRadius: 0,
          border: 'none',
          paddingTop: (window as any).electron?.platform === 'darwin' ? 40 : 6,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'auto',
          position: 'relative',
        }}>
          {/* Sidebar content */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', paddingBottom: sidebarFooterHeight, position: 'relative', zIndex: 2 }}>
            <Suspense fallback={
              <div style={{
                flex: 1,
                color: theme.text.disabled,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11
              }}>
                Loading sidebar…
              </div>
            }>
              <LazySidebar
                workspace={workspace}
                workspaces={workspaces}
                tiles={tiles}
                onSwitchWorkspace={handleSwitchWorkspace}
                onDeleteWorkspace={handleDeleteWorkspace}
                onNewWorkspace={handleNewWorkspace}
                onOpenFolder={handleOpenFolder}
                onOpenFile={handleOpenFile}
                onFocusTile={bringToFront}
                onUpdateTile={(tileId, patch) => {
                  setTiles(prev => {
                    const updated = prev.map(t => t.id === tileId ? { ...t, ...patch } : t)
                    saveCanvas(updated, viewport, nextZIndex)
                    return updated
                  })
                }}
                onCloseTile={closeTile}
                onNewTerminal={() => addTile('terminal')}
                onNewKanban={() => addTile('kanban')}
                onNewBrowser={() => addTile('browser')}
                onNewChat={() => addTile('chat')}
                onNewFiles={() => addTile('files')}
                onOpenSettings={(tab) => setShowSettings(tab)}
                onOpenSessionInChat={openSessionInChat}
                onOpenSessionInApp={openSessionInApp}
                extensionTiles={settings.extensionsDisabled ? [] : extensionTiles.filter(e => e.type !== 'ext:md-preview' && !(settings.hiddenFromSidebarExtIds ?? []).includes(e.extId))}
                extensionEntries={settings.extensionsDisabled ? [] : extensionEntries}
                onAddExtensionTile={(type) => addTile(type as TileType)}
                pinnedExtensionIds={settings.extensionsDisabled ? [] : (settings.pinnedExtensionIds ?? [])}
                onTogglePinnedExtension={(key) => {
                  updateAppSettings(current => {
                    const pinned = current.pinnedExtensionIds ?? []
                    return {
                      pinnedExtensionIds: pinned.includes(key)
                        ? pinned.filter(id => id !== key)
                        : [...pinned, key],
                    }
                  })
                }}
                collapsed={sidebarCollapsed}
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                onResizeStateChange={setSidebarResizing}
                onToggleCollapse={() => setSidebarCollapsed(p => !p)}
                onScrollMetricsChange={setSidebarScrollMetrics}
                showFooter={false}
              />
            </Suspense>
          </div>
        </div>
      </div>

      {!sidebarCollapsed && (
        <div
          style={{
            position: 'absolute',
            left: sidebarFooterLeft,
            bottom: sidebarFooterBottom,
            width: sidebarWidth,
            height: sidebarFooterHeight,
            zIndex: 110,
            pointerEvents: 'auto',
            transition: 'width 0.15s ease',
          }}
        >
          <Suspense fallback={null}>
            <LazySidebarFooter
              onNewTerminal={() => addTile('terminal')}
              onNewKanban={() => addTile('kanban')}
              onNewBrowser={() => addTile('browser')}
              onNewChat={() => addTile('chat')}
              onNewFiles={() => addTile('files')}
              onOpenSettings={(tab) => setShowSettings(tab)}
              extensionTiles={settings.extensionsDisabled ? [] : extensionTiles.filter(e => e.type !== 'ext:md-preview' && !(settings.hiddenFromSidebarExtIds ?? []).includes(e.extId))}
              onAddExtensionTile={(type) => addTile(type as TileType)}
            />
          </Suspense>
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          left: mainStatusBarLeft,
          right: 0,
          bottom: 0,
          height: sidebarFooterHeight,
          zIndex: 95,
          pointerEvents: 'none',
          transform: 'translateY(5px)',
          transition: 'left 0.15s ease',
        }}
      >
        <MainStatusBar />
      </div>

      {/* Main area — toolbar overlays top, canvas fills entire window */}
      <div className="absolute inset-0 flex flex-col" style={{ position: 'absolute' }}>
        {/* Toolbar row — floats over canvas */}
        <div
          className="flex items-center flex-shrink-0"
          style={{
            height: 38,
            // @ts-ignore
            WebkitAppRegion: 'drag',
            paddingLeft: sidebarCollapsed ? 78 : sidebarWidth + 4,
            transition: 'padding-left 0.15s ease',
            position: 'relative',
            zIndex: 90,
            paddingTop: 2,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 8,
              minWidth: 0,
              height: '100%',
              paddingLeft: 6,
              // @ts-ignore
              WebkitAppRegion: 'no-drag',
            }}
          >
            {hasWorkspaceTabs ? openWorkspaceTabs.map(ws => {
              const isActive = ws.id === workspace?.id
              return (
                <div
                  key={ws.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    maxWidth: 280,
                    minWidth: 0,
                    height: '100%',
                    padding: '0 2px 0 0',
                    gap: 2,
                    borderBottom: isActive ? `3px solid ${theme.accent.base}` : '3px solid transparent',
                    color: isActive ? theme.text.primary : theme.text.muted,
                    transition: 'color 0.12s ease, border-color 0.12s ease',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!isActive) void handleSwitchWorkspace(ws.id)
                    }}
                    title={ws.name}
                    aria-current={isActive ? 'page' : undefined}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      minWidth: 0,
                      maxWidth: 246,
                      height: '100%',
                      padding: '0 2px',
                      border: 'none',
                      background: 'transparent',
                      color: 'inherit',
                      fontSize: appFonts.size,
                      fontWeight: 600,
                      letterSpacing: 0,
                      cursor: isActive ? 'default' : 'pointer',
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {ws.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      void handleCloseWorkspaceTab(ws.id)
                    }}
                    aria-label={`Close ${ws.name}`}
                    title={`Close ${ws.name}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 18,
                      height: 18,
                      marginBottom: 1,
                      border: 'none',
                      borderRadius: 4,
                      background: 'transparent',
                      color: theme.text.disabled,
                      cursor: 'pointer',
                      flexShrink: 0,
                      padding: 0,
                      transition: 'background 0.12s ease, color 0.12s ease',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = theme.surface.hover
                      e.currentTarget.style.color = theme.text.secondary
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.color = theme.text.disabled
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )
            }) : !showTopWorkspacePickerTab ? (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  maxWidth: 280,
                  minWidth: 0,
                  height: '100%',
                  padding: '0 2px',
                  borderBottom: `3px solid ${theme.accent.base}`,
                  color: theme.text.primary,
                  fontSize: appFonts.size,
                  fontWeight: 600,
                  letterSpacing: 0,
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {workspaceTitleFallback}
                </span>
              </div>
            ) : null}

            {showTopWorkspacePickerTab && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  maxWidth: 280,
                  minWidth: 0,
                  height: '100%',
                  padding: '0 2px 0 0',
                  gap: 2,
                  borderBottom: `3px solid ${theme.accent.base}`,
                  color: theme.text.primary,
                }}
              >
                <button
                  type="button"
                  onClick={() => showEmptyLayoutPage({ preserveOpenTabs: openWorkspaceTabs.length > 0 })}
                  aria-current="page"
                  title="New workspace"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    minWidth: 0,
                    maxWidth: 246,
                    height: '100%',
                    padding: '0 2px',
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    fontSize: appFonts.size,
                    fontWeight: 600,
                    letterSpacing: 0,
                    cursor: 'default',
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    NEW WORKSPACE
                  </span>
                </button>
                {openWorkspaceTabs.length > 0 && (
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      setShowWorkspacePickerTab(false)
                      const fallbackWorkspaceId = workspacePickerReturnWorkspaceId
                        ?? workspace?.id
                        ?? openWorkspaceTabs[openWorkspaceTabs.length - 1]?.id
                        ?? null
                      if (fallbackWorkspaceId) void handleSwitchWorkspace(fallbackWorkspaceId)
                    }}
                    aria-label="Close new workspace tab"
                    title="Close new workspace tab"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 18,
                      height: 18,
                      marginBottom: 1,
                      border: 'none',
                      borderRadius: 4,
                      background: 'transparent',
                      color: theme.text.disabled,
                      cursor: 'pointer',
                      flexShrink: 0,
                      padding: 0,
                      transition: 'background 0.12s ease, color 0.12s ease',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = theme.surface.hover
                      e.currentTarget.style.color = theme.text.secondary
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.color = theme.text.disabled
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => showEmptyLayoutPage({ preserveOpenTabs: true })}
              aria-label="New workspace"
              title="New workspace"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: '100%',
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: theme.text.muted,
                cursor: 'pointer',
                transition: 'color 0.12s ease',
              }}
            >
              <Plus size={18} strokeWidth={2.1} />
            </button>
          </div>
        </div>

        {/* Sidebar collapse pill / scroll indicator */}
        {sidebarCollapsed ? (
          <div
            onClick={() => setSidebarCollapsed(p => !p)}
            style={{
              display: !sidebarPillVisible ? 'none' : 'flex',
              position: 'absolute',
              left: 4,
              top: '50%',
              transform: 'translateY(-50%)',
              transition: 'opacity 0.12s ease',
              width: 8,
              height: collapsedSidebarPillHeight,
              background: theme.surface.panelElevated,
              border: `1px solid ${theme.border.strong}`,
              borderRadius: 9999,
              cursor: 'pointer',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.text.disabled,
              fontSize: 9,
              userSelect: 'none',
              zIndex: 200,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = theme.surface.panelMuted }}
            onMouseLeave={e => { e.currentTarget.style.background = theme.surface.panelElevated }}
          >
            <span style={{
              width: 2,
              height: 14,
              borderRadius: 999,
              background: theme.text.disabled,
              opacity: 0.9,
              transition: 'opacity 0.12s ease',
            }} />
          </div>
        ) : (
          <div
            style={{
              display: !sidebarPillVisible ? 'none' : 'block',
              position: 'absolute',
              left: openSidebarPillLeft,
              top: sidebarScrollTrackTop,
              bottom: sidebarScrollTrackBottom,
              width: 8,
              zIndex: 200,
              pointerEvents: 'none',
              transition: 'left 0.15s ease, opacity 0.12s ease',
            }}
          >
            <div
              onClick={() => setSidebarCollapsed(p => !p)}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: sidebarScrollIndicatorTop,
                height: sidebarScrollMetrics.hasOverflow
                  ? `${sidebarScrollIndicatorRatio * 100}%`
                  : collapsedSidebarPillHeight,
                minHeight: sidebarScrollMetrics.hasOverflow ? 24 : collapsedSidebarPillHeight,
                background: theme.surface.panelElevated,
                border: `1px solid ${theme.border.strong}`,
                borderRadius: 9999,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: theme.text.disabled,
                userSelect: 'none',
                pointerEvents: 'auto',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = theme.surface.panelMuted }}
              onMouseLeave={e => { e.currentTarget.style.background = theme.surface.panelElevated }}
            >
              <span style={{
                width: 2,
                height: sidebarScrollMetrics.hasOverflow ? 12 : 14,
                borderRadius: 999,
                background: theme.text.disabled,
                opacity: 0.9,
                transition: 'opacity 0.12s ease',
              }} />
            </div>
          </div>
        )}

        {/* Canvas — fills entire window, sits behind sidebar & toolbar */}
        <div
          ref={canvasRef}
          className="absolute inset-0 overflow-hidden"
          style={{
            background: canvasLayerBackground,
            cursor: isDraggingCanvas ? 'grabbing' : (spaceHeld.current ? 'grab' : 'default'),
            userSelect: 'none',
            WebkitUserSelect: 'none',
            zIndex: 0,
          } as React.CSSProperties}
          onMouseDown={handleCanvasMouseDown}
          onDoubleClick={handleCanvasDoubleClick}
          onContextMenu={handleCanvasContextMenu}
          onWheel={handleWheel}
          onMouseMove={e => updateCanvasGlow(e.clientX, e.clientY)}
          onMouseLeave={hideCanvasGlow}
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
          onDrop={e => {
            e.preventDefault()
            const world = screenToWorld(e.clientX, e.clientY)

            // Tile already on canvas — just pan to it (dragged from kanban card ↗)
            const linkedTileId = e.dataTransfer.getData('application/tile-id')
            if (linkedTileId) {
              bringToFront(linkedTileId)
              const target = tiles.find(t => t.id === linkedTileId)
              if (target) {
                const rect = canvasRef.current?.getBoundingClientRect()
                if (rect) {
                  setViewport(prev => ({
                    ...prev,
                    tx: rect.width / 2 - (target.x + target.width / 2) * prev.zoom,
                    ty: rect.height / 2 - (target.y + target.height / 2) * prev.zoom
                  }))
                }
              }
              return
            }

            // Kanban card dragged onto canvas — create new tile
            const cardTitle = e.dataTransfer.getData('application/card-title')
            const cardType = e.dataTransfer.getData('application/card-type') as TileState['type'] | ''
            const cardFile = e.dataTransfer.getData('application/card-file')
            if (cardTitle) {
              addTile(cardType || 'note', cardFile || undefined, world)
              return
            }

            // Files dropped from OS or sidebar
            const droppedPaths = getDroppedPaths(e.dataTransfer)
            if (droppedPaths.length > 0) {
              // Check for .vsix first
              const vsixPath = droppedPaths.find(p => p.endsWith('.vsix'))
              if (vsixPath) {
                window.api.extensions.installVsix(vsixPath).then((result: any) => {
                  if (result?.ok) {
                    console.log('[vsix] Installed:', result.name)
                    if (result.tiles && result.tiles.length > 0) {
                      addTile('extension', undefined, world)
                    }
                  } else {
                    console.error('[vsix] Install failed:', result?.error)
                  }
                })
                return
              }
              // Create a file tile for each dropped path
              for (const p of droppedPaths) {
                void resolveFileTileType(p).then(type => addTile(type, p, world))
              }
              return
            }

            // File from sidebar (text/plain fallback)
            const filePath = e.dataTransfer.getData('text/plain')
            if (filePath) {
              void resolveFileTileType(filePath).then(type => addTile(type, filePath, world))
            }
          }}
        >
          {/* Canvas content wrapper — fades out when in expanded/tabbed mode */}
          <div style={{
            position: 'absolute', inset: 0,
            opacity: panelLayout ? 0 : 1,
            transition: 'opacity 0.3s ease',
            pointerEvents: panelLayout ? 'none' : 'auto',
          }}>
          {/* Dot grid - small */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `radial-gradient(circle, ${settings.gridColorSmall} 1px, transparent 1px)`,
              backgroundSize: `${settings.gridSpacingSmall * viewport.zoom}px ${settings.gridSpacingSmall * viewport.zoom}px`,
              backgroundPosition: `${viewport.tx % (settings.gridSpacingSmall * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingSmall * viewport.zoom)}px`
            }}
          />
          {/* Dot grid - large */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `radial-gradient(circle, ${settings.gridColorLarge} 2px, transparent 2px)`,
              backgroundSize: `${settings.gridSpacingLarge * viewport.zoom}px ${settings.gridSpacingLarge * viewport.zoom}px`,
              backgroundPosition: `${viewport.tx % (settings.gridSpacingLarge * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingLarge * viewport.zoom)}px`
            }}
          />

          {/* Dot grid glow - small (cursor proximity light) */}
          {canvasGlowEnabled && (
            <div
              ref={dotGlowSmallRef}
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `radial-gradient(circle, ${theme.canvas.gridGlowSmall} 1px, transparent 1px)`,
                backgroundSize: `${settings.gridSpacingSmall * viewport.zoom}px ${settings.gridSpacingSmall * viewport.zoom}px`,
                backgroundPosition: `${viewport.tx % (settings.gridSpacingSmall * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingSmall * viewport.zoom)}px`,
                opacity: 0,
                transition: 'opacity 0.3s ease-out',
              }}
            />
          )}
          {/* Dot grid glow - large (cursor proximity light) */}
          {canvasGlowEnabled && (
            <div
              ref={dotGlowLargeRef}
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `radial-gradient(circle, ${theme.canvas.gridGlowLarge} 2px, transparent 2px)`,
                backgroundSize: `${settings.gridSpacingLarge * viewport.zoom}px ${settings.gridSpacingLarge * viewport.zoom}px`,
                backgroundPosition: `${viewport.tx % (settings.gridSpacingLarge * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingLarge * viewport.zoom)}px`,
                opacity: 0,
                transition: 'opacity 0.3s ease-out',
              }}
            />
          )}

          {/* World container */}
          <div
            className="absolute"
            style={{
              transform: `translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.zoom})`,
              transformOrigin: '0 0'
            }}
          >
            {/* Group frames — sorted so parents render behind children */}
            {[...groups]
              .sort((a, b) => (a.parentGroupId ? 1 : 0) - (b.parentGroupId ? 1 : 0))
              .map(g => {
                const b = groupBounds(g.id)
                if (!b) return null

                // ── Layout-mode group: embedded PanelLayout ──────────────────
                if (g.layoutMode && g.layout) {
                  const lb = b
                  const layout = g.layout as PanelNode
                  const color = g.color ?? '#4a9eff'
                  const borderColor = color + 'bb'
                  const labelColor = color + 'ee'
                  const isDraggingThis = dragState.type === 'group' && dragState.groupId === g.id
                  const HEADER_H = 32  // world px — scales with canvas zoom like tile chrome

                  return (
                    <div
                      key={g.id}
                      style={{
                        position: 'absolute',
                        left: lb.x, top: lb.y, width: lb.w, height: lb.h,
                        border: `2px solid ${borderColor}`,
                        borderRadius: 12,
                        background: theme.surface.panel,  // opaque — prevents grid bleed-through
                        zIndex: isDraggingThis ? 99989 : 8,
                        boxSizing: 'border-box',
                        overflow: 'hidden',
                        cursor: 'default',
                      }}
                      onMouseDown={e => e.stopPropagation()}
                    >
                      {/* Header — fixed world-px height, scales naturally with canvas zoom */}
                      <div
                        style={{
                          position: 'absolute',
                          top: 0, left: 0, right: 0,
                          height: HEADER_H,
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '0 10px',
                          background: color + '22',
                          borderBottom: `1px solid ${borderColor}`,
                          cursor: isDraggingThis ? 'grabbing' : 'grab',
                          userSelect: 'none',
                          boxSizing: 'border-box',
                        }}
                        onMouseDown={e => {
                          e.stopPropagation()
                          setDragState({
                            type: 'group',
                            groupId: g.id,
                            startX: e.clientX, startY: e.clientY,
                            snapshots: [],
                            initLayoutBounds: lb,
                          })
                        }}
                        onDoubleClick={e => { e.stopPropagation(); expandLayoutGroup(g.id) }}
                      >
                        <LayoutGrid size={12} style={{ color: labelColor, flexShrink: 0, opacity: 0.7 }} />
                        <span style={{ fontSize: appFonts.secondarySize, color: labelColor, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {g.label ?? 'layout'}
                        </span>
                        <div
                          title="Expand fullscreen"
                          onClick={e => { e.stopPropagation(); expandLayoutGroup(g.id) }}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, cursor: 'pointer', color: labelColor, opacity: 0.6 }}
                          onMouseEnter={e => { e.currentTarget.style.opacity = '1' }}
                          onMouseLeave={e => { e.currentTarget.style.opacity = '0.6' }}
                        >
                          <Maximize2 size={11} />
                        </div>
                        <div
                          title="Back to blocks"
                          onClick={e => { e.stopPropagation(); revertLayoutGroup(g.id) }}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, cursor: 'pointer', color: labelColor, opacity: 0.6 }}
                          onMouseEnter={e => { e.currentTarget.style.opacity = '1' }}
                          onMouseLeave={e => { e.currentTarget.style.opacity = '0.6' }}
                        >
                          <Ungroup size={11} />
                        </div>
                      </div>

                      {/* Resize handles */}
                      {([ 'n','s','e','w','ne','nw','se','sw' ] as const).map(dir => {
                        const S = 10 / viewport.zoom
                        const hs: React.CSSProperties = { position: 'absolute', zIndex: 20 }
                        if (dir === 'e')  Object.assign(hs, { right: -S/2,  top: S,      bottom: S,      width: S,  cursor: 'col-resize' })
                        if (dir === 'w')  Object.assign(hs, { left: -S/2,   top: S,      bottom: S,      width: S,  cursor: 'col-resize' })
                        if (dir === 's')  Object.assign(hs, { bottom: -S/2, left: S,     right: S,       height: S, cursor: 'row-resize' })
                        if (dir === 'n')  Object.assign(hs, { top: -S/2,    left: S,     right: S,       height: S, cursor: 'row-resize' })
                        if (dir === 'se') Object.assign(hs, { right: -S/2,  bottom: -S/2, width: S*1.5, height: S*1.5, cursor: 'se-resize' })
                        if (dir === 'sw') Object.assign(hs, { left: -S/2,   bottom: -S/2, width: S*1.5, height: S*1.5, cursor: 'sw-resize' })
                        if (dir === 'ne') Object.assign(hs, { right: -S/2,  top: -S/2,    width: S*1.5, height: S*1.5, cursor: 'ne-resize' })
                        if (dir === 'nw') Object.assign(hs, { left: -S/2,   top: -S/2,    width: S*1.5, height: S*1.5, cursor: 'nw-resize' })
                        return (
                          <div
                            key={dir}
                            style={hs}
                            onMouseDown={e => {
                              e.stopPropagation()
                              e.preventDefault()
                              setDragState({
                                type: 'group-resize',
                                groupId: g.id, dir,
                                startX: e.clientX, startY: e.clientY,
                                initBounds: { x: lb.x, y: lb.y, w: lb.w, h: lb.h },
                                snapshots: [],
                              })
                            }}
                          />
                        )
                      })}

                      {/* Embedded PanelLayout */}
                      <div
                        style={{
                          position: 'absolute',
                          top: HEADER_H, left: 0, right: 0, bottom: 0,
                          overflow: 'hidden',
                        }}
                      >
                        <Suspense fallback={null}>
                          <LazyPanelLayout
                            root={layout}
                            getTileLabel={getPanelTileLabel}
                            renderTile={(tileId) => {
                              const t = tiles.find(ti => ti.id === tileId)
                              if (!t) return null
                              return (
                                <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12 }}>Loading…</div>}>
                                  {renderTileBody(t)}
                                </Suspense>
                              )
                            }}
                            onLayoutChange={(newLayout) => {
                              setGroups(prev => {
                                const updated = prev.map(gr => gr.id === g.id ? { ...gr, layout: newLayout } : gr)
                                setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, updated), 0)
                                return updated
                              })
                            }}
                            onCloseTab={(tileId) => {
                              setGroups(prev => {
                                const updated = prev.map(gr => {
                                  if (gr.id !== g.id || !gr.layout) return gr
                                  const newLayout = removeTileFromTree(gr.layout as PanelNode, tileId)
                                  return { ...gr, layout: newLayout ?? undefined }
                                })
                                return updated
                              })
                            }}
                            onAddTile={() => { /* handled externally */ }}
                            onExit={() => revertLayoutGroup(g.id)}
                            activePanelId={null}
                            onActivePanelChange={() => { /* no-op for embedded */ }}
                            getTileType={(tileId) => tiles.find(t => t.id === tileId)?.type ?? 'note'}
                            onSplitNew={(panelId, tileType, zone) => {
                              const { w, h } = getInitialTileSize(tileType as TileState['type'])
                              const newTile: TileState = {
                                id: `tile-${Date.now()}`,
                                type: tileType as TileState['type'],
                                x: 0, y: 0,
                                width: w, height: h, zIndex: nextZIndex,
                                groupId: g.id,
                              }
                              setTiles(prev => [...prev, newTile])
                              setNextZIndex(prev => prev + 1)
                              setGroups(prev => {
                                const updated = prev.map(gr => gr.id === g.id && gr.layout
                                  ? { ...gr, layout: splitLeaf(gr.layout as PanelNode, panelId, newTile.id, zone) }
                                  : gr)
                                return updated
                              })
                            }}
                            onCloseOthers={(panelId, tileId) => {
                              setGroups(prev => prev.map(gr => gr.id === g.id && gr.layout
                                ? { ...gr, layout: closeOthersInLeaf(gr.layout as PanelNode, panelId, tileId) }
                                : gr))
                            }}
                            onCloseToRight={(panelId, tileId) => {
                              setGroups(prev => prev.map(gr => gr.id === g.id && gr.layout
                                ? { ...gr, layout: closeToRightInLeaf(gr.layout as PanelNode, panelId, tileId) }
                                : gr))
                            }}
                            onLaunchTemplate={() => { /* no-op in embedded mode */ }}
                          />
                        </Suspense>
                      </div>
                    </div>
                  )
                }

                const isNested = !!g.parentGroupId
                const defaultColor = isNested ? '#ffb432' : '#4a9eff'
                const color = g.color ?? defaultColor
                const borderColor = color + 'cc'
                const bgColor = color + '14'
                const labelColor = color + 'ee'
                const isDraggingThis = (dragState.type === 'group' || dragState.type === 'group-resize') && dragState.groupId === g.id
                return (
                  <div
                    key={g.id}
                    style={{
                      position: 'absolute',
                      left: b.x, top: b.y, width: b.w, height: b.h,
                      border: `2px dashed ${borderColor}`,
                      borderRadius: 12,
                      background: bgColor,
                      zIndex: isDraggingThis ? 99989 : isNested ? 1 : 0,
                      boxSizing: 'border-box',
                      cursor: isDraggingThis ? 'grabbing' : 'grab',
                    }}
                    onMouseDown={e => {
                      if ((e.target as HTMLElement) !== e.currentTarget) return
                      e.stopPropagation()
                      const ids = collectGroupTileIds(g.id)
                      const snapshots = tiles
                        .filter(t => ids.includes(t.id))
                        .map(t => ({ id: t.id, x: t.x, y: t.y }))
                      setDragState({ type: 'group', groupId: g.id, startX: e.clientX, startY: e.clientY, snapshots })
                    }}
                  >
                    {/* Label bar */}
                    <div
                      draggable
                      onMouseDown={e => e.stopPropagation()}
                      onDragStart={e => {
                        e.stopPropagation()
                        const memberTiles = tiles.filter(t => t.groupId === g.id)
                        e.dataTransfer.setData('application/group-id', g.id)
                        e.dataTransfer.setData('application/group-label', g.label ?? 'group')
                        e.dataTransfer.setData('application/group-tile-ids', JSON.stringify(memberTiles.map(t => t.id)))
                        e.dataTransfer.setData('application/group-tile-types', JSON.stringify(memberTiles.map(t => t.type)))
                        e.dataTransfer.effectAllowed = 'link'
                        const ghost = document.createElement('div')
                        ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px'
                        document.body.appendChild(ghost)
                        e.dataTransfer.setDragImage(ghost, 0, 0)
                        setTimeout(() => ghost.remove(), 0)
                      }}
                      style={{
                        position: 'absolute', top: -24 / viewport.zoom, left: 0,
                        display: 'flex', gap: 6, alignItems: 'center',
                        userSelect: 'none', pointerEvents: 'all',
                        background: 'none',
                        border: 'none',
                        padding: '3px 0',
                        cursor: 'grab',
                        transform: `scale(${1 / viewport.zoom})`,
                        transformOrigin: 'left top',
                      }}>
                      {/* Color swatch / picker */}
                      <div style={{ position: 'relative' }}>
                        <div
                          style={{
                            width: 10, height: 10, borderRadius: '50%',
                            background: color, cursor: 'pointer', flexShrink: 0,
                            border: '1px solid rgba(255,255,255,0.2)'
                          }}
                          onClick={e => {
                            e.stopPropagation()
                            const input = e.currentTarget.nextSibling as HTMLInputElement
                            input?.click()
                          }}
                        />
                        <input
                          type="color"
                          value={color}
                          onChange={e => {
                            const newColor = e.target.value
                            setGroups(prev => {
                              const updated = prev.map(gr => gr.id === g.id ? { ...gr, color: newColor } : gr)
                              setTiles(t => { saveCanvas(t, viewport, nextZIndex, updated); return t })
                              return updated
                            })
                          }}
                          style={{
                            position: 'absolute', opacity: 0, width: 0, height: 0,
                            top: 0, left: 0, pointerEvents: 'none'
                          }}
                        />
                      </div>

                      {/* Editable label */}
                      <span
                        contentEditable
                        suppressContentEditableWarning
                        onBlur={e => {
                          const newLabel = e.currentTarget.textContent?.trim() || 'group'
                          setGroups(prev => {
                            const updated = prev.map(gr => gr.id === g.id ? { ...gr, label: newLabel } : gr)
                            setTiles(t => { saveCanvas(t, viewport, nextZIndex, updated); return t })
                            return updated
                          })
                        }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur() } e.stopPropagation() }}
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize: appFonts.secondarySize, color: labelColor, fontWeight: 500, minWidth: 30, outline: 'none', cursor: 'text' }}>
                        {g.label ?? 'group'}
                      </span>

                      <span style={{ width: 1, height: 10, background: color, opacity: 0.3 }} />

                      {([
                        { icon: <LayoutGrid size={12} />, label: 'Make layout', action: () => convertGroupToLayout(g.id) },
                        { icon: <Ungroup size={12} />, label: 'Ungroup', action: () => ungroupTilesRef.current(g.id) },
                        { icon: <Grid2x2X size={12} />, label: 'Ungroup all', action: () => ungroupAllRef.current(g.id) },
                        { icon: <Scissors size={12} />, label: 'Cut', action: () => {
                          const ids = collectGroupTileIds(g.id)
                          setSelectedTileIds(new Set(ids))
                          setSelectedTileId(null)
                          setTimeout(() => copyTilesRef.current(true), 0)
                        }},
                        ...(clipboard.current.length > 0 ? [{ icon: <ClipboardPaste size={12} />, label: 'Paste in', action: () => pasteTilesRef.current(undefined, g.id) }] : [])
                      ] as { icon: React.ReactNode; label: string; action: () => void }[]).map(btn => (
                        <div
                          key={btn.label}
                          title={btn.label}
                          onClick={e => { e.stopPropagation(); btn.action() }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 20, height: 20, borderRadius: 4, cursor: 'pointer',
                            color: labelColor, opacity: 0.6,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.opacity = '1' }}
                          onMouseLeave={e => { e.currentTarget.style.opacity = '0.6' }}
                        >
                          {btn.icon}
                        </div>
                      ))}
                    </div>

                    {/* Resize handles */}
                    {([ 'n','s','e','w','ne','nw','se','sw' ] as const).map(dir => {
                      const S = 10
                      const hs: React.CSSProperties = { position: 'absolute', zIndex: 20 }
                      if (dir === 'e')  Object.assign(hs, { right: -S/2,  top: S,      bottom: S,      width: S,  cursor: 'col-resize' })
                      if (dir === 'w')  Object.assign(hs, { left: -S/2,   top: S,      bottom: S,      width: S,  cursor: 'col-resize' })
                      if (dir === 's')  Object.assign(hs, { bottom: -S/2, left: S,     right: S,       height: S, cursor: 'row-resize' })
                      if (dir === 'n')  Object.assign(hs, { top: -S/2,    left: S,     right: S,       height: S, cursor: 'row-resize' })
                      if (dir === 'se') Object.assign(hs, { right: -S/2,  bottom: -S/2, width: S*1.5, height: S*1.5, cursor: 'se-resize' })
                      if (dir === 'sw') Object.assign(hs, { left: -S/2,   bottom: -S/2, width: S*1.5, height: S*1.5, cursor: 'sw-resize' })
                      if (dir === 'ne') Object.assign(hs, { right: -S/2,  top: -S/2,    width: S*1.5, height: S*1.5, cursor: 'ne-resize' })
                      if (dir === 'nw') Object.assign(hs, { left: -S/2,   top: -S/2,    width: S*1.5, height: S*1.5, cursor: 'nw-resize' })
                      return (
                        <div
                          key={dir}
                          style={hs}
                          onMouseDown={e => {
                            e.stopPropagation()
                            e.preventDefault()
                            const ids = collectGroupTileIds(g.id)
                            const snapshots = tiles
                              .filter(t => ids.includes(t.id))
                              .map(t => ({ id: t.id, x: t.x, y: t.y, width: t.width, height: t.height }))
                            setDragState({
                              type: 'group-resize',
                              groupId: g.id, dir,
                              startX: e.clientX, startY: e.clientY,
                              initBounds: { x: b.x + 20, y: b.y + 20, w: b.w - 40, h: b.h - 40 }, // strip PAD
                              snapshots
                            })
                          }}
                        />
                      )
                    })}
                  </div>
                )
              })
            }

            {/* Rubber-band selection rect */}
            {dragState.type === 'select' && (() => {
              const x = Math.min(dragState.startWx, dragState.curWx)
              const y = Math.min(dragState.startWy, dragState.curWy)
              const w = Math.abs(dragState.curWx - dragState.startWx)
              const h = Math.abs(dragState.curWy - dragState.startWy)
              return (
                <div style={{
                  position: 'absolute', left: x, top: y, width: w, height: h,
                  border: '1px solid rgba(74,158,255,0.6)',
                  background: 'rgba(74,158,255,0.06)',
                  borderRadius: 3,
                  pointerEvents: 'none',
                  zIndex: 99998,
                  boxSizing: 'border-box'
                }} />
              )
            })()}

            {/* Alignment guides */}
            {guides.map((g, i) =>
              g.x !== undefined ? (
                <div key={`gx-${i}`} style={{
                  position: 'absolute',
                  left: g.x,
                  top: -9999,
                  width: 1,
                  height: 99999,
                  background: 'rgba(74,158,255,0.7)',
                  pointerEvents: 'none',
                  zIndex: 99999
                }} />
              ) : (
                <div key={`gy-${i}`} style={{
                  position: 'absolute',
                  top: g.y,
                  left: -9999,
                  height: 1,
                  width: 99999,
                  background: 'rgba(74,158,255,0.7)',
                  pointerEvents: 'none',
                  zIndex: 99999
                }} />
              )
            )}

            {/* Connection pills — rendered in screen-space under tiles, like edges */}
            {!panelLayout && (ambientDiscoveryRenderRoutes.length > 0 || discoveryPreview?.match) && (
              <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: discoveryPillZIndex }}>
                {/* Ambient route pills */}
                {ambientDiscoveryRenderRoutes.map(connection => {
                  const mid = getRouteMidpoint(connection.displayRoute)
                  const [tileIdA, tileIdB] = connection.key.split('::')
                  return (
                    <Suspense key={`pill-${connection.key}`} fallback={null}>
                      <LazyConnectionPill
                        x={mid.x}
                        y={mid.y}
                        zoom={viewport.zoom}
                        isLocked={isConnectionLocked(tileIdA, tileIdB)}
                        onToggleLock={() => toggleConnectionLock(tileIdA, tileIdB)}
                        onDelete={() => deleteConnection(tileIdA, tileIdB)}
                        dscLine={dsc.line}
                      />
                    </Suspense>
                  )
                })}
                {/* Preview pill — only if this pair doesn't already have a locked pill showing */}
                {discoveryPreview?.match && discoveryFocusTileId && (() => {
                  const previewKey = [discoveryFocusTileId, discoveryPreview.match.tile.id].sort().join('::')
                  // Skip if already rendered as a locked ambient pill
                  if (lockedConnectionKeys.has(previewKey)) return null
                  const mid = getRouteMidpoint(discoveryPreview.match.route)
                  return (
                    <Suspense fallback={null}>
                      <LazyConnectionPill
                        x={mid.x}
                        y={mid.y}
                        zoom={viewport.zoom}
                        isLocked={false}
                        onToggleLock={() => toggleConnectionLock(discoveryFocusTileId!, discoveryPreview!.match!.tile.id)}
                        onDelete={() => deleteConnection(discoveryFocusTileId!, discoveryPreview!.match!.tile.id)}
                        dscLine={dsc.line}
                      />
                    </Suspense>
                  )
                })()}
              </div>
            )}

            {tiles.filter(tile => !panelTileIds.has(tile.id)).map(tile => {
              // Tile being dragged (or part of a group being dragged) gets max z-index
              const isActiveDrag =
                (dragState.type === 'tile' && (dragState.tileId === tile.id || dragState.groupSnapshots.some(s => s.id === tile.id))) ||
                (dragState.type === 'resize' && dragState.tileId === tile.id) ||
                ((dragState.type === 'group' || dragState.type === 'group-resize') && tile.groupId === dragState.groupId)
              const activeTile = isActiveDrag ? { ...tile, zIndex: 99990 } : tile
              return (
                <Suspense
                  key={tile.id}
                  fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12, background: theme.surface.panel }}>Loading block…</div>}
                >
                  <TileColorProvider>
                  <LazyTileChrome
                    tile={activeTile}
                    workspaceId={workspace?.id}
                    workspaceDir={workspace?.path}
                    onClose={() => closeTile(tile.id)}
                    onActivate={() => bringToFront(tile.id)}
                    onTitlebarMouseDown={e => handleTileMouseDown(e, tile)}
                    onResizeMouseDown={(e, dir) => handleResizeMouseDown(e, tile, dir)}
                    onContextMenu={e => handleTileContextMenu(e, tile)}
                    isSelected={tile.id === selectedTileId || selectedTileIds.has(tile.id)}
                    forceExpanded={panelTileIds.has(tile.id)}
                    onExpandChange={expanded => expanded ? enterExpandedMode(tile.id) : exitExpandedMode()}
                    discoveryConnected={negotiatedDiscoveryState.connectedTileIds.has(tile.id)}
                    connectedPeers={negotiatedDiscoveryState.byTileConnections.get(tile.id)?.map(link => link.peerId) ?? []}
                    titlebarExtra={tile.type === 'note' && !tile.filePath ? <Suspense fallback={null}><LazyStickyColorPicker /></Suspense> : undefined}
                  >
                    <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12, background: theme.surface.panelMuted }}>Loading block…</div>}>
                      {renderTileBody(tile)}
                    </Suspense>
                  </LazyTileChrome>
                  </TileColorProvider>
                </Suspense>
              )
            })}

            {!panelLayout && (ambientDiscoveryRenderRoutes.length > 0 || discoveryPreview?.match || discoveryPulses.length > 0) && (
              <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: discoveryHighlightZIndex }}>
                {(() => {
                  const previewPairKey = discoveryPreview?.match && discoveryFocusTileId
                    ? [discoveryFocusTileId, discoveryPreview.match.tile.id].sort().join('::')
                    : null
                  return (
                    <>
                {ambientDiscoveryRenderRoutes.map(connection => (
                  <React.Fragment key={connection.key}>
                    {getRouteSegments(connection.displayRoute, 2).map((segment, index) => (
                      <div
                        key={`${connection.key}-segment-${index}`}
                        style={{
                          position: 'absolute',
                          left: segment.left,
                          top: segment.top,
                          width: segment.width,
                          height: segment.height,
                          borderRadius: 999,
                          backgroundImage: segment.horizontal
                            ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.28) 0 10px, transparent 10px 22px)`
                            : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.28) 0 10px, transparent 10px 22px)`,
                          opacity: 0.92,
                          filter: `drop-shadow(0 0 4px rgba(${dsc.line}, 0.18))`,
                        }}
                      />
                    ))}
                  </React.Fragment>
                ))}
                {discoveryPreview?.match && discoveryFocusTileId && (() => {
                  const previewKey = [discoveryFocusTileId, discoveryPreview.match.tile.id].sort().join('::')
                  if (lockedConnectionKeys.has(previewKey)) return null
                  const sourceTile = tileByIdMap.get(discoveryFocusTileId)
                  const targetTile = tileByIdMap.get(discoveryPreview.match.tile.id)
                  if (!sourceTile || !targetTile) return null
                  const previewRoute = discoveryPreview.match.route
                  const sourceRect = { left: sourceTile.x, top: sourceTile.y, width: sourceTile.width, height: sourceTile.height }
                  const targetRect = { left: targetTile.x, top: targetTile.y, width: targetTile.width, height: targetTile.height }
                  const labelPoint = getRouteMidpoint(discoveryPreview.match.route)

                  return (
                    <>
                      {getRouteSegments(previewRoute).map((segment, index) => (
                        <div
                          key={`preview-segment-${index}`}
                          style={{
                            position: 'absolute',
                            left: segment.left,
                            top: segment.top,
                            width: segment.width,
                            height: segment.height,
                            borderRadius: 999,
                            backgroundImage: segment.horizontal
                              ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.64) 0 12px, transparent 12px 20px)`
                              : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.64) 0 12px, transparent 12px 20px)`,
                            filter: `drop-shadow(0 0 6px rgba(${dsc.line}, 0.22))`,
                          }}
                        />
                      ))}

                      {previewRoute.map((point, index) => (
                        <div
                          key={`preview-${index}`}
                          style={{
                            position: 'absolute',
                            left: point.x,
                            top: point.y,
                            width: index === 0 || index === previewRoute.length - 1 ? 9 : 6,
                            height: index === 0 || index === previewRoute.length - 1 ? 9 : 6,
                            borderRadius: '50%',
                            transform: 'translate(-50%, -50%)',
                            background: index === 0 || index === previewRoute.length - 1 ? `rgba(${dsc.line}, 0.72)` : `rgba(${dsc.line}, 0.36)`,
                            boxShadow: `0 0 8px rgba(${dsc.line}, 0.24)`,
                          }}
                        />
                      ))}

                      {/* Pill rendered in screen-space overlay below */}
                    </>
                  )
                })()}

                <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
                  {discoveryPulses.map(pulse => {
                    const sourceTile = tileByIdMap.get(pulse.sourceTileId)
                    const targetTile = tileByIdMap.get(pulse.targetTileId)
                    if (!sourceTile || !targetTile) return null
                    const route = pulse.route
                    const d = routeToSvgPath(route)
                    return (
                      <g key={`route-${pulse.id}`}>
                        <path
                          d={d}
                          fill="none"
                          stroke={`rgba(${dsc.line}, 0.18)`}
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d={d}
                          fill="none"
                          pathLength={100}
                          stroke={`rgba(${dsc.line}, 0.72)`}
                          strokeWidth={3}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{
                            strokeDasharray: '16 84',
                            strokeDashoffset: 100,
                            filter: `drop-shadow(0 0 8px rgba(${dsc.line}, 0.24))`,
                            animation: `discovery-route-travel ${pulse.durationMs}ms linear forwards`
                          }}
                        />
                        {route.map((point, index) => (
                          <circle
                            key={`${pulse.id}-pt-${index}`}
                            cx={point.x}
                            cy={point.y}
                            r={index === 0 || index === route.length - 1 ? 4.5 : 3}
                            fill={index === 0 || index === route.length - 1 ? `rgba(${dsc.line}, 0.72)` : `rgba(${dsc.line}, 0.36)`}
                          />
                        ))}
                      </g>
                    )
                  })}
                </svg>

                {discoveryPulses.map(pulse => {
                  const sourceTile = tileByIdMap.get(pulse.sourceTileId)
                  const targetTile = tileByIdMap.get(pulse.targetTileId)
                  if (!sourceTile || !targetTile) return null

                  const pairKey = [pulse.sourceTileId, pulse.targetTileId].sort().join('::')
                  const _hidePulsePills = previewPairKey === pairKey
                  const sourceRect = { left: sourceTile.x, top: sourceTile.y, width: sourceTile.width, height: sourceTile.height }
                  const targetRect = { left: targetTile.x, top: targetTile.y, width: targetTile.width, height: targetTile.height }
                  const labelPoint = getRouteMidpoint(pulse.route)

                  return (
                    <React.Fragment key={pulse.id}>

                      {/* Pill rendered in screen-space overlay below */}
                    </React.Fragment>
                  )
                })}
                    </>
                  )
                })()}
              </div>
            )}
          </div>

          {canvasGlowEnabled && !panelLayout && (ambientDiscoveryRenderRoutes.length > 0 || discoveryPreview?.match || discoveryPulses.length > 0) && (
            <div
              ref={discoveryGlowRef}
              className="absolute inset-0 pointer-events-none"
              style={{
                opacity: 0,
                transition: 'opacity 0.18s ease-out',
                zIndex: discoveryGlowZIndex,
              }}
            >
              {ambientDiscoveryRenderRoutes.map(connection => {
                const screenRoute = connection.displayRoute.map(worldToScreenPoint)
                return getRouteSegments(screenRoute, 2.5).map((segment, index) => (
                  <div
                    key={`${connection.key}-glow-${index}`}
                    style={{
                      position: 'absolute',
                      left: segment.left,
                      top: segment.top,
                      width: segment.width,
                      height: segment.height,
                      borderRadius: 999,
                      backgroundImage: segment.horizontal
                        ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.72) 0 10px, transparent 10px 22px)`
                        : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.72) 0 10px, transparent 10px 22px)`,
                      filter: `drop-shadow(0 0 6px rgba(${dsc.line}, 0.26))`,
                    }}
                  />
                ))
              })}

              {discoveryPreview?.match && discoveryFocusTileId && (() => {
                const previewKey = [discoveryFocusTileId, discoveryPreview.match.tile.id].sort().join('::')
                if (lockedConnectionKeys.has(previewKey)) return null
                const screenRoute = discoveryPreview.match.route.map(worldToScreenPoint)
                return (
                  <>
                    {getRouteSegments(screenRoute, 3.2).map((segment, index) => (
                      <div
                        key={`preview-glow-${index}`}
                        style={{
                          position: 'absolute',
                          left: segment.left,
                          top: segment.top,
                          width: segment.width,
                          height: segment.height,
                          borderRadius: 999,
                          backgroundImage: segment.horizontal
                            ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.82) 0 12px, transparent 12px 20px)`
                            : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.82) 0 12px, transparent 12px 20px)`,
                          filter: `drop-shadow(0 0 8px rgba(${dsc.line}, 0.30))`,
                        }}
                      />
                    ))}
                    {screenRoute.map((point, index) => (
                      <div
                        key={`preview-glow-dot-${index}`}
                        style={{
                          position: 'absolute',
                          left: point.x,
                          top: point.y,
                          width: index === 0 || index === screenRoute.length - 1 ? 10 : 6,
                          height: index === 0 || index === screenRoute.length - 1 ? 10 : 6,
                          borderRadius: '50%',
                          transform: 'translate(-50%, -50%)',
                          background: index === 0 || index === screenRoute.length - 1 ? `rgba(${dsc.line}, 0.82)` : `rgba(${dsc.line}, 0.46)`,
                          boxShadow: `0 0 9px rgba(${dsc.line}, 0.28)`,
                        }}
                      />
                    ))}
                  </>
                )
              })()}

              {discoveryPulses.map(pulse => {
                const screenRoute = pulse.route.map(worldToScreenPoint)
                return getRouteSegments(screenRoute, 3.2).map((segment, index) => (
                  <div
                    key={`${pulse.id}-glow-${index}`}
                    style={{
                      position: 'absolute',
                      left: segment.left,
                      top: segment.top,
                      width: segment.width,
                      height: segment.height,
                      borderRadius: 999,
                      backgroundImage: segment.horizontal
                        ? `repeating-linear-gradient(90deg, rgba(${dsc.line}, 0.76) 0 12px, transparent 12px 20px)`
                        : `repeating-linear-gradient(180deg, rgba(${dsc.line}, 0.76) 0 12px, transparent 12px 20px)`,
                      filter: `drop-shadow(0 0 8px rgba(${dsc.line}, 0.28))`,
                    }}
                  />
                ))
              })}
            </div>
          )}

          {/* Group button — appears when 2+ tiles are rubber-band selected */}
          {selectedTileIds.size >= 2 && (
            <div
              onMouseDown={e => e.stopPropagation()}
              style={{
              position: 'absolute', bottom: 62, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', gap: 8, alignItems: 'center',
              background: theme.surface.overlay, border: `1px solid ${theme.border.default}`,
              borderRadius: 8, padding: '5px 12px',
              backdropFilter: 'blur(8px)',
              boxShadow: theme.shadow.panel,
              zIndex: 1000
            }}>
              <span style={{ fontSize: appFonts.secondarySize, color: theme.text.muted }}>{selectedTileIds.size} block{selectedTileIds.size !== 1 ? 's' : ''} selected</span>
              <button
                onClick={groupSelectedTiles}
                style={{
                  fontSize: appFonts.secondarySize, color: theme.accent.base, background: theme.accent.soft,
                  border: `1px solid ${theme.border.accent}`, borderRadius: 5,
                  padding: '3px 10px', cursor: 'pointer'
                }}
                onMouseEnter={e => e.currentTarget.style.background = theme.surface.selection}
                onMouseLeave={e => e.currentTarget.style.background = theme.accent.soft}
              >
                Group
              </button>
              <button
                onClick={() => setSelectedTileIds(new Set())}
                style={{
                  fontSize: appFonts.secondarySize, color: theme.text.disabled, background: 'transparent',
                  border: 'none', cursor: 'pointer', padding: '3px 6px'
                }}
              >
                Cancel
              </button>
            </div>
          )}

          </div>{/* end canvas content wrapper */}

          {/* Expanded panel layout — VS Code-style tabs + splits, inset to avoid sidebar + toolbar */}
          {panelLayout && (
            <div style={{
              position: 'absolute',
              top: 39,
              left: sidebarCollapsed ? 2 : expandedLayoutLeft,
              right: 0,
              bottom: 0,
              zIndex: 50,
              transition: 'left 0.15s ease',
            }}>
            <Suspense fallback={null}>
              <LazyPanelLayout
                root={panelLayout}
                insetBottom={mainPanelBottomInset}
                getTileLabel={getPanelTileLabel}
                renderTile={(tileId) => {
                  const t = tiles.find(ti => ti.id === tileId)
                  if (!t) return null
                  return (
                    <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12, background: theme.surface.panelMuted }}>Loading block…</div>}>
                      {renderTileBody(t)}
                    </Suspense>
                  )
                }}
                onLayoutChange={setPanelLayout}
                onCloseTab={closeTile}
                onAddTile={(type) => addTile(type as TileState['type'])}
                onExit={exitExpandedMode}
                activePanelId={activePanelId}
                onActivePanelChange={setActivePanelId}
                getTileType={(tileId) => tiles.find(t => t.id === tileId)?.type ?? 'note'}
                onSplitNew={(panelId, tileType, zone) => {
                  const center = viewportCenter()
                  const { w, h } = getInitialTileSize(tileType as TileState['type'])
                  const newTile: TileState = {
                    id: `tile-${Date.now()}`,
                    type: tileType as TileState['type'],
                    x: snapValue(center.x - w / 2), y: snapValue(center.y - h / 2),
                    width: w, height: h, zIndex: nextZIndex,
                  }
                  setTiles(prev => [...prev, newTile])
                  setNextZIndex(prev => prev + 1)
                  setPanelLayout(prev => prev ? splitLeaf(prev, panelId, newTile.id, zone) : prev)
                }}
                onCloseOthers={(panelId, tileId) => {
                  setPanelLayout(prev => prev ? closeOthersInLeaf(prev, panelId, tileId) : prev)
                }}
                onCloseToRight={(panelId, tileId) => {
                  setPanelLayout(prev => prev ? closeToRightInLeaf(prev, panelId, tileId) : prev)
                }}
                onLaunchTemplate={handleLaunchTemplate}
              />
            </Suspense>
            </div>
          )}

          {/* Minimap */}
          {showMinimap && (
            <Suspense fallback={null}>
              <LazyMinimap
                tiles={tiles}
                viewport={viewport}
                canvasSize={{
                  w: canvasRef.current?.clientWidth ?? 1200,
                  h: canvasRef.current?.clientHeight ?? 800
                }}
                onPan={(tx, ty) => setViewport(prev => ({ ...prev, tx, ty }))}
              />
            </Suspense>
          )}

        </div>

        {/* Arrange toolbar — render above the titlebar drag layer */}
        <Suspense fallback={null}>
          <LazyArrangeToolbar
            tiles={tiles}
            groups={groups}
            onArrange={(updated, mode) => {
              if (panelLayout) exitExpandedMode()
              setCanvasArrangeMode(mode)
              handleArrange(updated)
            }}
            zoom={viewport.zoom}
            isTabbedView={!!panelLayout}
            activeCanvasMode={canvasArrangeMode}
            onToggleTabs={() => {
              if (panelLayout) exitExpandedMode()
              else enterTabbedView()
            }}
            onZoomToggle={() => {
              setViewport(prev => {
                if (prev.zoom === 1) {
                  return { ...prev, zoom: prevZoomRef.current !== 1 ? prevZoomRef.current : 1 }
                }
                prevZoomRef.current = prev.zoom
                return { ...prev, zoom: 1 }
              })
            }}
          />
        </Suspense>
      </div>
      {showMCP && (
        <Suspense fallback={null}>
          <LazyMCPPanel onClose={() => setShowMCP(false)} />
        </Suspense>
      )}
      {showSettings && (
        <Suspense fallback={null}>
          <LazySettingsPanel settings={settings} onClose={() => setShowSettings(false)} onSettingsChange={s => setSettings(withDefaultSettings(s))} workspaces={workspaces} workspacePath={workspace?.path} initialSection={typeof showSettings === 'string' ? showSettings as any : undefined} systemPrefersDark={systemPrefersDark} />
        </Suspense>
      )}
      {ctxMenu && (
        <Suspense fallback={null}>
          <LazyContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={closeCtx} />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <LazyClusoWidgetMount />
      </Suspense>
      {showAgentSetup && (
        <Suspense fallback={null}>
          <LazyAgentSetup onComplete={() => setShowAgentSetup(false)} />
        </Suspense>
      )}
    </div>
    </FontProvider>
    </FontTokenProvider>
    </ThemeProvider>
  )
}

export default App
