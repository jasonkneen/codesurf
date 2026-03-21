import React, { useState, useRef, useCallback, useEffect, useMemo, Suspense } from 'react'
import { Ungroup, Grid2x2X, Scissors, ClipboardPaste } from 'lucide-react'
import type { TileState, GroupState, CanvasState, Workspace, AppSettings } from '../../shared/types'
import { withDefaultSettings, DEFAULT_SETTINGS } from '../../shared/types'
import type { MenuItem } from './components/ContextMenu'
import { FontProvider, FontTokenProvider, SANS_DEFAULT, MONO_DEFAULT } from './FontContext'
import type { PanelNode } from './components/PanelLayout'
import { createLeaf, removeTileFromTree, addTabToLeaf, getAllTileIds, splitLeaf, closeOthersInLeaf, closeToRightInLeaf, findLeafById } from './components/PanelLayout'
import { getDroppedPaths } from './utils/dnd'

const LazyPanelLayout = React.lazy(() => import('./components/PanelLayout').then(m => ({ default: m.PanelLayout })))

const textIconStyle = (size: number): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: size,
  height: size,
  fontSize: Math.max(10, size - 2),
  lineHeight: 1,
  userSelect: 'none'
})

const Icon = ({ glyph, size = 15 }: { glyph: string; size?: number }): JSX.Element => (
  <span style={textIconStyle(size)}>{glyph}</span>
)

const LazyTileChrome = React.lazy(() => import('./components/TileChrome').then(m => ({ default: m.TileChrome })))
const LazySidebar = React.lazy(() => import('./components/Sidebar').then(m => ({ default: m.Sidebar })))
const LazyContextMenu = React.lazy(() => import('./components/ContextMenu').then(m => ({ default: m.ContextMenu })))
const LazyImageTile = React.lazy(() => import('./components/ImageTile').then(m => ({ default: m.ImageTile })))
const LazyBrowserTile = React.lazy(() => import('./components/BrowserTile').then(m => ({ default: m.BrowserTile })))
const LazyKanbanTile = React.lazy(() => import('./components/KanbanTile').then(m => ({ default: m.KanbanTile })))
const LazyMCPPanel = React.lazy(() => import('./components/MCPPanel').then(m => ({ default: m.MCPPanel })))
const LazyArrangeToolbar = React.lazy(() => import('./components/ArrangeToolbar').then(m => ({ default: m.ArrangeToolbar })))
const LazyMinimap = React.lazy(() => import('./components/Minimap').then(m => ({ default: m.Minimap })))
const LazySettingsPanel = React.lazy(() => import('./components/SettingsPanel').then(m => ({ default: m.SettingsPanel })))
const LazyTerminalTile = React.lazy(() => import('./components/TerminalTile').then(m => ({ default: m.TerminalTile })))
const LazyCodeTile = React.lazy(() => import('./components/CodeTile').then(m => ({ default: m.CodeTile })))
const LazyNoteTile = React.lazy(() => import('./components/NoteTile').then(m => ({ default: m.NoteTile })))
const LazyChatTile = React.lazy(() => import('./components/ChatTile').then(m => ({ default: m.ChatTile })))
const LazyFileTile = React.lazy(() => import('./components/FileTile').then(m => ({ default: m.FileTile })))
const LazyClusoWidgetMount = React.lazy(() => import('./components/ClusoWidgetMount').then(m => ({ default: m.ClusoWidgetMount })))

type DragState =
  | { type: null }
  | { type: 'pan'; startX: number; startY: number; initTx: number; initTy: number }
  | { type: 'tile'; tileId: string; startX: number; startY: number; initX: number; initY: number; groupSnapshots: { id: string; x: number; y: number }[] }
  | { type: 'resize'; tileId: string; dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'; startX: number; startY: number; initX: number; initY: number; initW: number; initH: number }
  | { type: 'select'; startWx: number; startWy: number; curWx: number; curWy: number }
  | { type: 'group'; groupId: string; startX: number; startY: number; snapshots: { id: string; x: number; y: number }[] }
  | { type: 'group-resize'; groupId: string; dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'; startX: number; startY: number; initBounds: { x: number; y: number; w: number; h: number }; snapshots: { id: string; x: number; y: number; width: number; height: number }[] }

const GRID = 20 // default, overridden by settings at runtime
const snap = (v: number, grid = GRID) => Math.round(v / grid) * grid

function extToType(filePath: string): TileState['type'] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'rs', 'go', 'cpp', 'c', 'java', 'css', 'html', 'sh', 'bash', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return 'code'
  if (['md', 'txt', 'markdown', 'mdx'].includes(ext)) return 'note'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image'
  // Files with no extension or unrecognized extensions default to code editor
  if (!filePath.includes('.')) return 'code'
  return 'terminal'
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
  if (type === 'file') return 200
  return 200
}

function getMinTileHeight(tileOrType: TileState | TileState['type']): number {
  const type = typeof tileOrType === 'string' ? tileOrType : tileOrType.type
  return type === 'file' ? 200 : 150
}

function App(): JSX.Element {
  const [tiles, setTiles] = useState<TileState[]>([])
  const [groups, setGroups] = useState<GroupState[]>([])
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
  const [showSettings, setShowSettings] = useState(false)
  const [showMinimap, setShowMinimap] = useState(false)
  const [expandedTileId, setExpandedTileId] = useState<string | null>(null)
  const [panelLayout, setPanelLayout] = useState<PanelNode | null>(null)
  const [activePanelId, setActivePanelId] = useState<string | null>(null)
  const savedLayoutRef = useRef<PanelNode | null>(null)
  const panelLayoutRef = useRef<PanelNode | null>(null)
  const activePanelIdRef = useRef<string | null>(null)
  const expandedTileIdRef = useRef<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [sidebarPillVisible, setSidebarPillVisible] = useState(true)
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null)
  const [canvasArrangeMode, setCanvasArrangeMode] = useState<'grid' | 'column' | 'row' | null>(null)
  const [guides, setGuides] = useState<{ x?: number; y?: number }[]>([])

  useEffect(() => { panelLayoutRef.current = panelLayout }, [panelLayout])
  useEffect(() => { activePanelIdRef.current = activePanelId }, [activePanelId])
  useEffect(() => { expandedTileIdRef.current = expandedTileId }, [expandedTileId])

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

  // Workspace pill tabs — open workspace ids within this window
  const [openWorkspaceIds, setOpenWorkspaceIds] = useState<string[]>([])
  useEffect(() => {
    if (workspace?.id) setOpenWorkspaceIds(prev => prev.includes(workspace.id) ? prev : [...prev, workspace.id])
  }, [workspace?.id])

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

  // Keep tilesRef / groupsRef in sync with state
  tilesRef.current = tiles
  groupsRef.current = groups

  // Context menus
  type CtxMenu = { x: number; y: number; items: MenuItem[] }
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const closeCtx = useCallback(() => setCtxMenu(null), [])

  const canvasRef = useRef<HTMLDivElement>(null)
  const dotGlowSmallRef = useRef<HTMLDivElement>(null)
  const dotGlowLargeRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spaceHeld = useRef(false)
  const skipHistory = useRef(false)

  // ─── Load workspace + canvas state on mount ───────────────────────────────
  useEffect(() => {
    async function init(): Promise<void> {
      if (!window.electron) {
        console.warn('window.electron not available — preload may not have loaded')
        return
      }
      const [wsList, active, savedSettings] = await Promise.all([
        window.electron.workspace.list(),
        window.electron.workspace.getActive(),
        window.electron.settings?.get()
      ])
      if (savedSettings) setSettings(withDefaultSettings(savedSettings))
      setWorkspaces(wsList)
      setWorkspace(active)
      if (active) {
        const saved: CanvasState | null = await window.electron.canvas.load(active.id)
        const savedTiles = saved?.tiles ?? []
        void window.electron.collab.pruneOrphanedTileDirs(active.path, savedTiles.map(tile => tile.id))
        if (saved) {
          setTiles(savedTiles)
          setGroups(saved.groups ?? [])
          setViewport(saved.viewport
            ? { tx: saved.viewport.tx, ty: saved.viewport.ty, zoom: saved.viewport.zoom }
            : { tx: 0, ty: 0, zoom: 1 })
          setNextZIndex(saved.nextZIndex ?? 1)
          savedLayoutRef.current = (saved.panelLayout as PanelNode | null) ?? null
          setPanelLayout(saved.tabViewActive ? (saved.panelLayout as PanelNode | null) ?? null : null)
          setActivePanelId(saved.activePanelId ?? null)
          setExpandedTileId(saved.expandedTileId ?? null)
        }
      }
    }
    init()
  }, [])

  // ─── Escape to collapse expanded tile ────────────────────────────────────
  const exitExpandedMode = useCallback(() => {
    // Save layout before clearing so re-entry can restore it
    setPanelLayout(prev => { savedLayoutRef.current = prev; return null })
    setExpandedTileId(null)
    setActivePanelId(null)
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
  }, [])

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
      historyBack.current.push({ tiles: tileList, groups: resolvedGroups })
      if (historyBack.current.length > 50) historyBack.current.shift()
      historyForward.current = []
    }

    persistCanvasState(tileList, vp, nz, resolvedGroups)
  }, [workspace, persistCanvasState])

  // ─── Coordinate helpers ───────────────────────────────────────────────────
  useEffect(() => {
    if (!workspace) return
    persistCanvasState(tiles, viewport, nextZIndex, groups)
  }, [workspace, panelLayout, activePanelId, expandedTileId, persistCanvasState])

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

  // ─── Tile creation ────────────────────────────────────────────────────────
  const addTile = useCallback((type: TileState['type'], filePath?: string, pos?: { x: number; y: number }) => {
    const center = pos ?? viewportCenter()
    const defaultSizes = settings.defaultTileSizes
    const { w, h } = defaultSizes[type]
    const minW = getMinTileWidth(type)
    const minH = getMinTileHeight(type)
    const width = Math.max(w, minW)
    const height = Math.max(h, minH)
    const newTile: TileState = {
      id: `tile-${Date.now()}`,
      type,
      x: snap(center.x - width / 2),
      y: snap(center.y - height / 2),
      width,
      height,
      zIndex: nextZIndex,
      filePath
    }
    const updated = [...tiles, newTile]
    const newNZ = nextZIndex + 1
    setTiles(updated)
    setNextZIndex(newNZ)
    setSelectedTileId(newTile.id)
    saveCanvas(updated, viewport, newNZ)

    // If in expanded/tabbed mode, add as a tab to the active panel
    if (panelLayout && activePanelId) {
      setPanelLayout(prev => prev ? addTabToLeaf(prev, activePanelId, newTile.id) : prev)
    }
  }, [tiles, nextZIndex, viewport, viewportCenter, saveCanvas, panelLayout, activePanelId, settings.defaultTileSizes])

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
        addTile(extToType(data.path), data.path)
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
    const tile = tiles.find(t => t.id === id)
    if (tile?.type === 'terminal') {
      window.electron.terminal.destroy(id)
    }
    if (workspace?.id) {
      void Promise.allSettled([
        window.electron.canvas.deleteTileArtifacts(workspace.id, id),
        window.electron.activity.clearTile(workspace.id, id),
        workspace.path ? window.electron.collab.removeTileDir(workspace.path, id) : Promise.resolve(true),
      ])
    }
    const updated = tiles.filter(t => t.id !== id)
    setTiles(updated)
    setPanelLayout(prev => {
      if (!prev) return prev
      const next = removeTileFromTree(prev, id)
      if (next) return next
      const emptyLeaf = createLeaf([])
      setActivePanelId(emptyLeaf.id)
      return emptyLeaf
    })
    if (selectedTileId === id) setSelectedTileId(null)
    saveCanvas(updated, viewport, nextZIndex)
  }, [tiles, workspace?.id, workspace?.path, selectedTileId, viewport, nextZIndex, saveCanvas])

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
    if (clipboard.current.length > 0) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: 'Paste', action: () => pasteTilesRef.current(world) })
      if (hitGroup) {
        items.push({ label: 'Paste into group', action: () => pasteTilesRef.current(world, hitGroup.id) })
      }
    }
    if (selectedTileIds.size >= 2) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: `Group ${selectedTileIds.size} tiles`, action: () => groupSelectedTilesRef.current() })
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [screenToWorld, addTile, selectedTileIds, groups, panelLayout])

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
    items.push({ label: 'Close', action: () => closeTile(tile.id), danger: true })
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [closeTile, groups, viewport, nextZIndex, saveCanvas])

  const handleTileMouseDown = useCallback((e: React.MouseEvent, tile: TileState) => {
    e.stopPropagation()
    bringToFront(tile.id)
    // Snapshot positions of all tiles in the same group for co-movement
    const groupSnapshots: { id: string; x: number; y: number }[] = []
    if (tile.groupId) {
      setTiles(prev => {
        prev.filter(t => t.groupId === tile.groupId && t.id !== tile.id)
          .forEach(t => groupSnapshots.push({ id: t.id, x: t.x, y: t.y }))
        return prev
      })
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
            x: snap(nx + relX * scaleX),
            y: snap(ny + relY * scaleY),
            width: Math.max(minW, snap(s.width * scaleX)),
            height: Math.max(minH, snap(s.height * scaleY)),
          }
        }))
      } else if (dragState.type === 'group') {
        const wdx = dx / viewport.zoom
        const wdy = dy / viewport.zoom
        setTiles(prev => prev.map(t => {
          const snap2 = dragState.snapshots.find(s => s.id === t.id)
          if (!snap2) return t
          return { ...t, x: snap(snap2.x + wdx), y: snap(snap2.y + wdy) }
        }))
      } else if (dragState.type === 'select') {
        const rect = canvasRef.current?.getBoundingClientRect()
        if (!rect) return
        const curWx = (e.clientX - rect.left - viewport.tx) / viewport.zoom
        const curWy = (e.clientY - rect.top - viewport.ty) / viewport.zoom
        setDragState(prev => prev.type === 'select' ? { ...prev, curWx, curWy } : prev)
      } else if (dragState.type === 'tile') {
        const wdx = dx / viewport.zoom
        const wdy = dy / viewport.zoom
        const newX = snap(dragState.initX + wdx)
        const newY = snap(dragState.initY + wdy)
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
            if (snap2) return { ...t, x: snap(snap2.x + ddx), y: snap(snap2.y + ddy) }
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
          if (dir.includes('e'))  w = Math.max(minW, snap(dragState.initW + wdx))
          if (dir.includes('s'))  h = Math.max(minH, snap(dragState.initH + wdy))
          if (dir.includes('w')) { w = Math.max(minW, snap(dragState.initW - wdx)); x = snap(dragState.initX + wdx) }
          if (dir.includes('n')) { h = Math.max(minH, snap(dragState.initH - wdy)); y = snap(dragState.initY + wdy) }
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
            return updated
          }
          saveCanvas(prev, viewport, nextZIndex)
          return prev
        })
      } else if (dragState.type === 'resize' || dragState.type === 'group' || dragState.type === 'group-resize') {
        setTiles(prev => { saveCanvas(prev, viewport, nextZIndex); return prev })
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
              prev.filter(t => t.x < maxX && t.x + t.width > minX && t.y < maxY && t.y + t.height > minY)
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
  }, [dragState, viewport, nextZIndex, saveCanvas])

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
    const ws = workspaces.find(w => w.id === id) ?? null
    setWorkspace(ws)
    if (ws) {
      const saved = await window.electron.canvas.load(id)
      const savedTiles = saved?.tiles ?? []
      void window.electron.collab.pruneOrphanedTileDirs(ws.path, savedTiles.map(tile => tile.id))
      if (saved) {
        setTiles(savedTiles)
        setGroups(saved.groups ?? [])
        setViewport(saved.viewport ? { tx: saved.viewport.tx, ty: saved.viewport.ty, zoom: saved.viewport.zoom } : { tx: 0, ty: 0, zoom: 1 })
        setNextZIndex(saved.nextZIndex ?? 1)
        savedLayoutRef.current = (saved.panelLayout as PanelNode | null) ?? null
        setPanelLayout(saved.tabViewActive ? (saved.panelLayout as PanelNode | null) ?? null : null)
        setActivePanelId(saved.activePanelId ?? null)
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

  const handleOpenFile = useCallback((filePath: string) => {
    setSidebarSelectedPath(filePath)
    addTile(extToType(filePath), filePath)
  }, [addTile])

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
        ? snap(center.x + (t.x - srcMinX) - (Math.max(...clipboard.current.map(t2 => t2.x + t2.width)) - srcMinX) / 2)
        : snap(t.x + OFFSET),
      y: pos
        ? snap(center.y + (t.y - srcMinY) - (Math.max(...clipboard.current.map(t2 => t2.y + t2.height)) - srcMinY) / 2)
        : snap(t.y + OFFSET),
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
  }, [viewport, nextZIndex, viewportCenter, saveCanvas, groups])

  const duplicateTiles = useCallback((ids?: string[]) => {
    const targets = ids
      ? tiles.filter(t => ids.includes(t.id))
      : getActiveTiles()
    if (targets.length === 0) return
    const newNZ = nextZIndex + targets.length
    const newTiles = targets.map((t, i) => ({
      ...t,
      id: `tile-${Date.now()}-${i}`,
      x: snap(t.x + 40),
      y: snap(t.y + 40),
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
  }, [tiles, getActiveTiles, viewport, nextZIndex, saveCanvas])

  // ─── Group frame bounds (recursive — includes child group tiles) ─────────
  const groupBounds = useCallback((groupId: string): { x: number; y: number; w: number; h: number } | null => {
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

  // Keep action refs in sync so early-defined callbacks can call them safely
  pasteTilesRef.current = pasteTiles
  duplicateTilesRef.current = duplicateTiles
  copyTilesRef.current = copyTiles
  groupSelectedTilesRef.current = groupSelectedTiles
  groupBoundsRef.current = groupBounds
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
            const state: CanvasState = { tiles: prev.tiles, groups: prev.groups, viewport: viewport, nextZIndex: nextZIndex }
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
            const state: CanvasState = { tiles: next.tiles, groups: next.groups, viewport: viewport, nextZIndex: nextZIndex }
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

    // Merge positions back — preserve zIndex / other fields from current state
    setTiles(prev => {
      const posIndex: Record<string, { x: number; y: number }> = {}
      for (const t of updated) posIndex[t.id] = { x: t.x, y: t.y }
      const merged = prev.map(t => {
        const pos = posIndex[t.id]
        return pos ? { ...t, ...pos } : t
      })
      saveCanvas(merged, viewport, nextZIndex)

      // Zoom to fit all arranged tiles with a 10% zoom-out from fit level
      const rect = canvasRef.current?.getBoundingClientRect()
      if (rect && merged.length > 0) {
        const minX = Math.min(...merged.map(t => t.x))
        const minY = Math.min(...merged.map(t => t.y))
        const maxX = Math.max(...merged.map(t => t.x + getArrangeWidth(t)))
        const maxY = Math.max(...merged.map(t => t.y + t.height))
        const PAD = 60
        const fitZoom = Math.min(
          rect.width  / (maxX - minX + PAD * 2),
          rect.height / (maxY - minY + PAD * 2),
          2
        )
        const newZoom = fitZoom * 0.9
        const tx = rect.width  / 2 - ((minX + maxX) / 2) * newZoom
        const ty = rect.height / 2 - ((minY + maxY) / 2) * newZoom
        setViewport({ tx, ty, zoom: newZoom })
      }

      return merged
    })
  }, [viewport, nextZIndex, saveCanvas])

  // ─── Render tile body ─────────────────────────────────────────────────────
  const renderTileBody = (tile: TileState): React.ReactNode => {
    switch (tile.type) {
      case 'terminal':
        return (
          <LazyTerminalTile
            tileId={tile.id}
            workspaceDir={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            fontSize={settings.terminalFontSize}
            fontFamily={settings.terminalFontFamily}
          />
        )
      case 'code':
        return <LazyCodeTile filePath={tile.filePath} />
      case 'note':
        return <LazyNoteTile filePath={tile.filePath} />
      case 'image':
        return tile.filePath ? <LazyImageTile filePath={tile.filePath} /> : null
      case 'browser':
        return (
          <LazyBrowserTile tileId={tile.id} workspaceId={workspace?.id ?? ''} initialUrl={tile.filePath ?? ''} width={tile.width} height={tile.height} zIndex={tile.zIndex} isInteracting={dragState.type !== null} />
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
      case 'chat':
        return (
          <LazyChatTile
            tileId={tile.id}
            workspaceId={workspace?.id ?? ''}
            workspaceDir={workspace?.path ?? ''}
            width={tile.width}
            height={tile.height}
            settings={settings}
          />
        )
      default:
        return null
    }
  }

  // Set of tile IDs currently in the panel tree — these should not render on canvas
  const panelTileIds = React.useMemo(() => {
    if (!panelLayout) return new Set<string>()
    return new Set(getAllTileIds(panelLayout))
  }, [panelLayout])

  const isDraggingCanvas = dragState.type === 'pan'

  const appFonts = React.useMemo(() => ({
    sans: settings.fonts?.sans?.family ?? settings.primaryFont?.family ?? SANS_DEFAULT,
    mono: settings.fonts?.mono?.family ?? settings.monoFont?.family ?? MONO_DEFAULT,
    size: settings.fonts?.sans?.size ?? settings.primaryFont?.size ?? 13,
    monoSize: settings.fonts?.mono?.size ?? settings.monoFont?.size ?? 13,
  }), [settings.fonts, settings.primaryFont, settings.monoFont])

  useEffect(() => {
    if (sidebarResizing) {
      setSidebarPillVisible(false)
      return
    }

    const timer = window.setTimeout(() => setSidebarPillVisible(true), 90)
    return () => window.clearTimeout(timer)
  }, [sidebarResizing])

  const fontTokens = React.useMemo(() => settings.fonts, [settings.fonts])
  const translucentBackground = settings.translucentBackground
  const shellBackground = 'transparent'
  const sidebarBackground = 'transparent'
  const pillBackground = '#252525'
  const toolbarBackground = 'transparent'
  const canvasBackground = translucentBackground ? withAlpha(settings.canvasBackground, 0.74) : settings.canvasBackground
  const openSidebarToolbarPadding = sidebarWidth + 16
  const openSidebarPillLeft = sidebarWidth + 18
  const expandedLayoutLeft = sidebarWidth + 8

  return (
    <FontTokenProvider value={fontTokens}>
    <FontProvider value={appFonts}>
    <div className="w-full h-full" style={{ position: 'relative', color: '#d4d4d4', fontFamily: appFonts.sans, fontSize: appFonts.size }}>
      {/* Sidebar inset panel — floats over the canvas */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        bottom: 0,
        padding: '8px 0 8px 8px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
        pointerEvents: 'none',
      }}>
        <div style={{
          height: '100%',
          background: 'rgba(30,30,30,0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRadius: 10,
          border: sidebarCollapsed ? 'none' : '1px solid rgba(255,255,255,0.12)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'auto',
        }}>
          {/* Traffic light drag zone — sits inside the sidebar panel */}
          <div
            style={{
              height: 52,
              flexShrink: 0,
              position: 'relative',
              // @ts-ignore
              WebkitAppRegion: 'drag',
            }}
          >
            {panelLayout && (
              <button
                onClick={() => setSidebarCollapsed(p => !p)}
                title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
                style={{
                  position: 'absolute', top: '50%', right: 8,
                  transform: 'translateY(-50%)',
                  width: 22, height: 22, borderRadius: 5,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#444',
                  // @ts-ignore
                  WebkitAppRegion: 'no-drag',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = '#aaa' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#444' }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  {sidebarCollapsed
                    ? <path d="M5 2H12V12H5M2 7H8M5 4L2 7L5 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    : <path d="M5 2H12V12H5M8 4L11 7L8 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  }
                </svg>
              </button>
            )}
          </div>
          {/* Sidebar content */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Suspense fallback={
              <div style={{
                flex: 1,
                color: '#666',
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
                onSwitchWorkspace={handleSwitchWorkspace}
                onNewWorkspace={handleNewWorkspace}
                onOpenFolder={handleOpenFolder}
                onOpenFile={handleOpenFile}
                selectedPath={sidebarSelectedPath}
                onSelectPath={setSidebarSelectedPath}
                onNewTerminal={() => addTile('terminal')}
                onNewKanban={() => addTile('kanban')}
                onNewBrowser={() => addTile('browser')}
                onNewChat={() => addTile('chat')}
                collapsed={sidebarCollapsed}
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                onResizeStateChange={setSidebarResizing}
                onToggleCollapse={() => setSidebarCollapsed(p => !p)}
              />
            </Suspense>
          </div>
        </div>
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
            paddingLeft: panelLayout
              ? (sidebarCollapsed ? 84 : openSidebarToolbarPadding)
              : (sidebarCollapsed ? 90 : openSidebarToolbarPadding),
            transition: 'padding-left 0.15s ease',
            position: 'relative',
            zIndex: 90,
            paddingTop: 8,
          }}
        >
          {/* Workspace pill tabs */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {openWorkspaceIds.map(id => {
              const ws = workspaces.find(w => w.id === id)
              if (!ws) return null
              const isActive = id === workspace?.id
              return (
                <button
                  key={id}
                  title={ws.name}
                  onClick={() => { if (!isActive) handleSwitchWorkspace(id) }}
                  style={{
                    height: 26, paddingLeft: 12, paddingRight: openWorkspaceIds.length > 1 ? 6 : 12,
                    borderRadius: 8,
                    background: 'transparent',
                    border: '1px solid transparent',
                    color: isActive ? '#e6e6e6' : '#666',
                    fontSize: 12, fontWeight: isActive ? 700 : 400,
                    cursor: isActive ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                    whiteSpace: 'nowrap', transition: 'color 0.1s',
                    boxShadow: 'none',
                  }}
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.color = '#8fbfff' }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.color = '#666' }}
                >
                  <span style={{ textTransform: 'uppercase', letterSpacing: 0.3 }}>{ws.name}</span>
                  {openWorkspaceIds.length > 1 && (
                    <span
                      onClick={e => {
                        e.stopPropagation()
                        setOpenWorkspaceIds(prev => {
                          const next = prev.filter(x => x !== id)
                          if (isActive && next.length > 0) handleSwitchWorkspace(next[next.length - 1])
                          return next
                        })
                      }}
                      style={{ fontSize: 14, lineHeight: 1, color: isActive ? '#777' : '#444', cursor: 'pointer', padding: '0 2px' }}
                      onMouseEnter={e => { e.currentTarget.style.color = '#8fbfff' }}
                      onMouseLeave={e => { e.currentTarget.style.color = isActive ? '#777' : '#444' }}
                    >×</span>
                  )}
                </button>
              )
            })}
            {/* Add workspace — picks the first unopened one */}
            {workspaces.some(w => !openWorkspaceIds.includes(w.id)) && (
              <button
                title="Open another workspace"
                onClick={() => {
                  const next = workspaces.find(w => !openWorkspaceIds.includes(w.id))
                  if (next) { setOpenWorkspaceIds(prev => [...prev, next.id]); handleSwitchWorkspace(next.id) }
                }}
                style={{
                  width: 26, height: 26, borderRadius: 8,
                  background: 'transparent', border: '1px solid transparent',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#555', transition: 'all 0.1s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#ccc' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#555' }}
              >
                <Icon glyph="+" size={18} />
              </button>
            )}
          </div>
        </div>

        {/* Sidebar collapse pill — floats over the canvas left edge; hidden in tab mode */}
        <div
          onClick={() => setSidebarCollapsed(p => !p)}
          style={{
            display: panelLayout || !sidebarPillVisible ? 'none' : 'flex',
            position: 'absolute',
            left: sidebarCollapsed ? 8 : openSidebarPillLeft,
            top: '50%',
            transform: 'translateY(-50%)',
            transition: 'opacity 0.12s ease',
            width: 8,
            height: 40,
            background: '#555',
            border: '1px solid #666',
            borderRadius: 9999,
            cursor: 'pointer',
            alignItems: 'center', justifyContent: 'center',
            color: '#555',
            fontSize: 9,
            userSelect: 'none',
            zIndex: 200,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#777' }}
          onMouseLeave={e => { e.currentTarget.style.background = '#555' }}
        >
          {''}
        </div>

        {/* Canvas — fills entire window, sits behind sidebar & toolbar */}
        <div
          ref={canvasRef}
          className="absolute inset-0 overflow-hidden"
          style={{
            background: canvasBackground,
            cursor: isDraggingCanvas ? 'grabbing' : (spaceHeld.current ? 'grab' : 'default'),
            userSelect: 'none',
            WebkitUserSelect: 'none',
            zIndex: 0,
          } as React.CSSProperties}
          onMouseDown={handleCanvasMouseDown}
          onDoubleClick={handleCanvasDoubleClick}
          onContextMenu={handleCanvasContextMenu}
          onWheel={handleWheel}
          onMouseMove={e => {
            const rect = canvasRef.current?.getBoundingClientRect()
            if (!rect) return
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            const mask = `radial-gradient(circle 120px at ${x}px ${y}px, rgba(0,0,0,1) 0%, rgba(0,0,0,0.6) 30%, rgba(0,0,0,0) 100%)`
            if (dotGlowSmallRef.current) {
              dotGlowSmallRef.current.style.maskImage = mask
              dotGlowSmallRef.current.style.webkitMaskImage = mask
              dotGlowSmallRef.current.style.opacity = '1'
            }
            if (dotGlowLargeRef.current) {
              dotGlowLargeRef.current.style.maskImage = mask
              dotGlowLargeRef.current.style.webkitMaskImage = mask
              dotGlowLargeRef.current.style.opacity = '1'
            }
          }}
          onMouseLeave={() => {
            if (dotGlowSmallRef.current) dotGlowSmallRef.current.style.opacity = '0'
            if (dotGlowLargeRef.current) dotGlowLargeRef.current.style.opacity = '0'
          }}
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

            // File from sidebar
            const filePath = e.dataTransfer.getData('text/plain')
            if (filePath) addTile(extToType(filePath), filePath, world)
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
          <div
            ref={dotGlowSmallRef}
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)`,
              backgroundSize: `${settings.gridSpacingSmall * viewport.zoom}px ${settings.gridSpacingSmall * viewport.zoom}px`,
              backgroundPosition: `${viewport.tx % (settings.gridSpacingSmall * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingSmall * viewport.zoom)}px`,
              opacity: 0,
              transition: 'opacity 0.3s ease-out',
            }}
          />
          {/* Dot grid glow - large (cursor proximity light) */}
          <div
            ref={dotGlowLargeRef}
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.8) 2px, transparent 2px)`,
              backgroundSize: `${settings.gridSpacingLarge * viewport.zoom}px ${settings.gridSpacingLarge * viewport.zoom}px`,
              backgroundPosition: `${viewport.tx % (settings.gridSpacingLarge * viewport.zoom)}px ${viewport.ty % (settings.gridSpacingLarge * viewport.zoom)}px`,
              opacity: 0,
              transition: 'opacity 0.3s ease-out',
            }}
          />

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
                        style={{ fontSize: 11, color: labelColor, fontWeight: 500, minWidth: 30, outline: 'none', cursor: 'text' }}>
                        {g.label ?? 'group'}
                      </span>

                      <span style={{ width: 1, height: 10, background: color, opacity: 0.3 }} />

                      {([
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
                  fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12, background: '#1e1e1e' }}>Loading tile frame…</div>}
                >
                  <LazyTileChrome
                    tile={activeTile}
                    workspaceId={workspace?.id}
                    workspaceDir={workspace?.path}
                    onClose={() => closeTile(tile.id)}
                    onTitlebarMouseDown={e => handleTileMouseDown(e, tile)}
                    onResizeMouseDown={(e, dir) => handleResizeMouseDown(e, tile, dir)}
                    onContextMenu={e => handleTileContextMenu(e, tile)}
                    isSelected={tile.id === selectedTileId || selectedTileIds.has(tile.id)}
                    forceExpanded={panelTileIds.has(tile.id)}
                    onExpandChange={expanded => expanded ? enterExpandedMode(tile.id) : exitExpandedMode()}
                  >
                    <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12, background: '#1a1a1a' }}>Loading tile…</div>}>
                      {renderTileBody(tile)}
                    </Suspense>
                  </LazyTileChrome>
                </Suspense>
              )
            })}
          </div>

          {/* Group button — appears when 2+ tiles are rubber-band selected */}
          {selectedTileIds.size >= 2 && (
            <div
              onMouseDown={e => e.stopPropagation()}
              style={{
              position: 'absolute', bottom: 62, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', gap: 8, alignItems: 'center',
              background: 'rgba(20,20,20,0.92)', border: '1px solid #2d2d2d',
              borderRadius: 8, padding: '5px 12px',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              zIndex: 1000
            }}>
              <span style={{ fontSize: 11, color: '#666' }}>{selectedTileIds.size} selected</span>
              <button
                onClick={groupSelectedTiles}
                style={{
                  fontSize: 11, color: '#4a9eff', background: 'rgba(74,158,255,0.1)',
                  border: '1px solid rgba(74,158,255,0.3)', borderRadius: 5,
                  padding: '3px 10px', cursor: 'pointer'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(74,158,255,0.2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(74,158,255,0.1)'}
              >
                Group
              </button>
              <button
                onClick={() => setSelectedTileIds(new Set())}
                style={{
                  fontSize: 11, color: '#555', background: 'transparent',
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
              top: 44,
              left: sidebarCollapsed ? 0 : expandedLayoutLeft,
              right: 0,
              bottom: 0,
              zIndex: 50,
              transition: 'left 0.15s ease',
            }}>
            <Suspense fallback={null}>
              <LazyPanelLayout
                root={panelLayout}
                getTileLabel={(tileId) => {
                  const t = tiles.find(ti => ti.id === tileId)
                  if (!t) return 'Unknown'
                  return t.filePath?.replace(/\\/g, '/').split('/').pop()
                    ?? t.type.charAt(0).toUpperCase() + t.type.slice(1)
                }}
                renderTile={(tileId) => {
                  const t = tiles.find(ti => ti.id === tileId)
                  if (!t) return null
                  return (
                    <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12, background: '#1a1a1a' }}>Loading tile…</div>}>
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
                  const { w, h } = settings.defaultTileSizes[tileType as TileState['type']]
                  const newTile: TileState = {
                    id: `tile-${Date.now()}`,
                    type: tileType as TileState['type'],
                    x: snap(center.x - w / 2), y: snap(center.y - h / 2),
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
            onOpenSettings={() => setShowSettings(true)}
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
          <LazySettingsPanel onClose={() => setShowSettings(false)} onSettingsChange={s => setSettings(s)} workspaces={workspaces} />
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
    </div>
    </FontProvider>
    </FontTokenProvider>
  )
}

export default App
