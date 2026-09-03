/**
 * TileChrome — canvas tile shell (titlebar, resize, optional drawer).
 * Drawer panels / activity processing live in ./tile-chrome/.
 */
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { TileState, SkillConfig, ContextItem, ActivityStatus } from '../../../shared/types'
import { getCurvierBlockRadius } from '../../../shared/types'
import { buildObjective } from '../utils/objectiveBuilder'
import type { TaskItem, MessageItem } from './tile-chrome/types'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import { useTileColor } from '../TileColorContext'
import { getEdgeShadow } from '../theme'
import { tileFrameChrome } from '../lib/groupChrome.ts'
import { useTileTodos } from '../state/tileTodosStore'
import type { DrawerData, DrawerTab } from './tile-chrome/types'
import { DRAWER_WIDTH, DRAWER_TYPES, fileLabel, getTitlebarForeground } from './tile-chrome/labels'
import { ResizeHandle } from './tile-chrome/ResizeHandle'
import { DrawerPanel } from './tile-chrome/DrawerPanels'
import { persistToActivityStore, processEvent } from './tile-chrome/drawerActivity'

export { fileLabel } from './tile-chrome/labels'

// --- TileChrome props ---

interface Props {
  tile: TileState
  workspaceId?: string
  workspaceDir?: string
  onClose: () => void
  onActivate?: () => void
  onTitlebarMouseDown: (e: React.MouseEvent) => void
  onResizeMouseDown: (e: React.MouseEvent, dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw') => void
  onContextMenu?: (e: React.MouseEvent) => void
  onExpandChange?: (expanded: boolean) => void
  children: React.ReactNode
  isSelected?: boolean
  /** True while this tile is being actively dragged/resized. Switches positioning to a
   *  GPU-composited transform + will-change so movement skips layout. Kept off when idle
   *  so the tile root never becomes a containing block for fixed-position descendants. */
  isInteracting?: boolean
  forceExpanded?: boolean
  /** When true, the tile body can render content that extends OUTSIDE the
   *  block's rounded box (e.g. external controls flanking image tiles).
   *  Both the main panel and the content area drop their `overflow: hidden`. */
  allowOverflow?: boolean
  busChannel?: string
  busUnreadCount?: number
  onBusPopupToggle?: () => void
  showBusPopup?: boolean
  discoveryConnected?: boolean
  connectedPeers?: string[]
  titlebarColor?: string
  titlebarExtra?: React.ReactNode
  busEvents?: Array<{
    id: string
    type: string
    timestamp: number
    source: string
    payload: Record<string, unknown>
  }>
}

// ─── Main TileChrome ─────────────────────────────────────────────────────────

function areTileChromePropsEqual(prev: Props, next: Props): boolean {
  if (prev.isSelected !== next.isSelected) return false
  if (prev.isInteracting !== next.isInteracting) return false
  if (prev.discoveryConnected !== next.discoveryConnected) return false
  if (prev.busUnreadCount !== next.busUnreadCount) return false
  if (prev.forceExpanded !== next.forceExpanded) return false
  if (prev.allowOverflow !== next.allowOverflow) return false
  if (prev.children !== next.children) return false
  // connectedPeers: compare content (parent rebuilds the array each render)
  const pp = prev.connectedPeers ?? []
  const np = next.connectedPeers ?? []
  if (pp.length !== np.length || pp.some((p, i) => p !== np[i])) return false
  const prevTile = prev.tile
  const nextTile = next.tile
  return (
    prevTile.id === nextTile.id &&
    prevTile.x === nextTile.x &&
    prevTile.y === nextTile.y &&
    prevTile.width === nextTile.width &&
    prevTile.height === nextTile.height &&
    prevTile.zIndex === nextTile.zIndex &&
    prevTile.type === nextTile.type &&
    prevTile.label === nextTile.label &&
    prevTile.hideTitlebar === nextTile.hideTitlebar &&
    prevTile.borderRadius === nextTile.borderRadius
  )
}

function TileChromeComponent({
  tile, workspaceId, workspaceDir, onClose, onActivate, onTitlebarMouseDown, onResizeMouseDown, onContextMenu,
  onExpandChange, children, isSelected, isInteracting, forceExpanded, allowOverflow,
  busUnreadCount, onBusPopupToggle, showBusPopup, discoveryConnected, connectedPeers, titlebarColor: titlebarColorProp, titlebarExtra, busEvents
}: Props): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const { color: tileContextColor } = useTileColor()
  const titlebarColor = titlebarColorProp ?? tileContextColor
  const titlebarForeground = getTitlebarForeground(titlebarColor, theme.text.primary, '#3a2f00')
  const titlebarMuted = titlebarColor ? `${titlebarForeground}aa` : theme.text.disabled
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = forceExpanded ?? localExpanded
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<DrawerTab>('tasks')
  const [data, setData] = useState<DrawerData>({ tasks: [], tools: [], availableTools: [], skills: [], context: [], messages: [] })
  const hasDrawer = DRAWER_TYPES.has(tile.type)
  const agentTodos = useTileTodos(tile.type === 'chat' ? tile.id : null)
  const peerIds = React.useMemo(() => [...new Set((connectedPeers ?? []).filter(Boolean))], [connectedPeers])
  const busPopupButtonRef = useRef<HTMLButtonElement>(null)
  const busPopupRef = useRef<HTMLDivElement>(null)

  const derivedChatTasks = useMemo<TaskItem[]>(() => {
    if (tile.type !== 'chat' || !agentTodos || agentTodos.length === 0) return []
    return agentTodos.map((todo, index) => {
      let status: TaskItem['status'] = 'pending'
      if (todo.status === 'completed') status = 'done'
      else if (todo.status === 'in_progress') status = 'in-progress'
      else if (todo.status === 'error') status = 'error'
      else if (todo.status === 'paused') status = 'paused'
      return {
        id: `agent-todo-${tile.id}-${index}`,
        title: todo.content,
        status,
        detail: todo.activeForm,
        timestamp: index,
      }
    })
  }, [agentTodos, tile.id, tile.type])

  const drawerData = useMemo<DrawerData>(() => (
    tile.type === 'chat' && derivedChatTasks.length > 0
      ? { ...data, tasks: derivedChatTasks }
      : data
  ), [data, derivedChatTasks, tile.type])

  const toggle = () => {
    const next = !expanded
    setLocalExpanded(next)
    onExpandChange?.(next)
  }

  // ── Collab: auto-regenerate objective.md on drawer state change ────────
  const regenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const regenerateObjective = useCallback(() => {
    if (!workspaceDir) return
    if (regenTimer.current) clearTimeout(regenTimer.current)
    regenTimer.current = setTimeout(() => {
      const md = buildObjective({
        tileId: tile.id,
        tasks: data.tasks.map(t => ({
          id: t.id,
          title: t.title,
          status: (t.status === 'in-progress' ? 'running' : t.status) as ActivityStatus,
        })),
        skills: data.skills,
        context: data.context,
      })
      void window.electron?.collab?.writeObjective?.(workspaceDir, tile.id, md)

      // Also sync state.json
      void window.electron?.collab?.writeState?.(workspaceDir, tile.id, {
        tasks: data.tasks.map(t => ({
          id: t.id,
          title: t.title,
          status: (t.status === 'in-progress' ? 'running' : t.status) as ActivityStatus,
          createdAt: t.timestamp,
          updatedAt: Date.now(),
        })),
        paused: false,
      })

      // Sync skills.json
      void window.electron?.collab?.writeSkills?.(workspaceDir, tile.id, {
        enabled: data.skills.filter(s => s.enabled).map(s => s.id),
        disabled: data.skills.filter(s => !s.enabled).map(s => s.id),
      })
    }, 1000)
  }, [workspaceDir, tile.id, data.tasks, data.skills, data.context])

  useEffect(() => { regenerateObjective() }, [regenerateObjective])
  useEffect(() => () => { if (regenTimer.current) clearTimeout(regenTimer.current) }, [])

  useEffect(() => {
    if (!showBusPopup || !onBusPopupToggle) return

    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (busPopupRef.current?.contains(target)) return
      if (busPopupButtonRef.current?.contains(target)) return
      onBusPopupToggle()
    }

    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onBusPopupToggle()
    }

    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [showBusPopup, onBusPopupToggle])

  // ── Collab: ensure per-tile protocol dirs; state watcher only for drawer tiles ──
  useEffect(() => {
    if (!workspaceDir) return
    // Optional call: web/Native bridge may partially implement collab
    void window.electron?.collab?.ensureDir?.(workspaceDir, tile.id)
    if (!hasDrawer) return
    void window.electron?.collab?.watchState?.(workspaceDir, tile.id)
    return () => { void window.electron?.collab?.unwatchState?.(workspaceDir, tile.id) }
  }, [workspaceDir, tile.id, hasDrawer])

  // ── Collab: listen for external state.json changes ─────────────────────
  useEffect(() => {
    if (!hasDrawer) return
    // Collab state crosses IPC as `unknown`; the drawer reads a known-but-loose task shape.
    // (Directive removed: @typescript-eslint/no-explicit-any is not enabled.)
    const unsub = window.electron?.collab?.onStateChanged?.((change: any) => {
      if (change.tileId !== tile.id) return
      const state = change.state
      if (!state?.tasks) return
      setData(prev => {
        const merged = [...prev.tasks]
        for (const t of state.tasks) {
          const idx = merged.findIndex(m => m.id === t.id)
          const mapped = t.status === 'running' ? 'in-progress' : t.status
          if (idx >= 0) {
            merged[idx] = { ...merged[idx], status: mapped, title: t.title ?? merged[idx].title }
          } else {
            merged.push({ id: t.id, title: t.title, status: mapped, timestamp: t.createdAt ?? Date.now() })
          }
        }
        return { ...prev, tasks: merged }
      })
    })
    return () => { unsub?.() }
  }, [tile.id, hasDrawer])

  // ── Drawer action callbacks ────────────────────────────────────────────
  const handleAddTask = useCallback((title: string) => {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setData(prev => ({ ...prev, tasks: [...prev.tasks, { id, title, status: 'pending', timestamp: Date.now() }] }))
    // Also publish bus event so MCP/agents can see it
    window.electron?.bus?.publish(`tile:${tile.id}`, 'task', 'drawer', { action: 'create', task_id: id, title, status: 'pending' })
  }, [tile.id])

  const handleUpdateTask = useCallback((id: string, status: TaskItem['status']) => {
    setData(prev => ({ ...prev, tasks: prev.tasks.map(t => t.id === id ? { ...t, status } : t) }))
    window.electron?.bus?.publish(`tile:${tile.id}`, 'task', 'drawer', { action: 'update', task_id: id, status })
  }, [tile.id])

  const handleDeleteTask = useCallback((id: string) => {
    setData(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== id) }))
  }, [])

  const handleToggleSkill = useCallback((id: string) => {
    setData(prev => ({
      ...prev,
      skills: prev.skills.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s),
    }))
  }, [])

  const handleAddNote = useCallback((text: string) => {
    const id = `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const item: ContextItem = { id, name: text.slice(0, 40), type: 'note', content: text }
    setData(prev => ({ ...prev, context: [...prev.context, item] }))
    // Persist to .collab context folder
    if (workspaceDir) {
      void window.electron?.collab?.addContext?.(workspaceDir, tile.id, 'notes.md',
        [...data.context.filter(c => c.type === 'note').map(c => c.content), text].join('\n\n'))
    }
  }, [workspaceDir, tile.id, data.context])

  const handleRemoveContext = useCallback((id: string) => {
    const item = data.context.find(c => c.id === id)
    setData(prev => ({ ...prev, context: prev.context.filter(c => c.id !== id) }))
    if (item?.type === 'file' && item.name && workspaceDir) {
      void window.electron?.collab?.removeContext?.(workspaceDir, tile.id, item.name)
    }
  }, [workspaceDir, tile.id, data.context])

  const loadMessages = useCallback(async () => {
    if (!hasDrawer || !workspaceDir) return

    const peers = new Set(peerIds)
    const items: MessageItem[] = []
    const seen = new Set<string>()

    const pushMessage = (msg: MessageItem) => {
      if (seen.has(msg.id)) return
      seen.add(msg.id)
      items.push(msg)
    }

    const collabInboxes = await window.electron?.collab?.listMessages?.(workspaceDir, tile.id, 'inbox')
    const collabSent = await window.electron?.collab?.listMessages?.(workspaceDir, tile.id, 'sent')
    const collabMessages = [...(collabInboxes ?? []), ...(collabSent ?? [])]
    for (const msg of collabMessages) {
      const from = msg.meta.fromTileId
      const to = msg.meta.toTileId
      const peer = from === tile.id ? to : from
      if (!peers.has(peer) && peers.size > 0) continue
      const direction: MessageItem['direction'] = from === tile.id ? 'outbound' : 'inbound'
      pushMessage({
        id: msg.meta.id,
        source: 'direct',
        direction,
        fromTileId: from,
        toTileId: to,
        subject: msg.meta.subject || '(no subject)',
        type: msg.meta.type,
        kind: msg.meta.type,
        createdAt: msg.meta.createdTs,
        status: msg.meta.status,
        mailbox: msg.mailbox,
      })
    }

    items.sort((a, b) => b.createdAt - a.createdAt)
    setData(prev => ({ ...prev, messages: items }))
  }, [hasDrawer, workspaceDir, tile.id, peerIds.join(',')])

  useEffect(() => {
    if (!hasDrawer || !workspaceDir) return
    loadMessages()
    const interval = setInterval(() => { loadMessages() }, 15000)

    void window.electron?.collab?.watchMessages?.(workspaceDir, tile.id)
    const unsubscribeMessageChanges = window.electron?.collab?.onMessageChanged?.((change: { workspacePath: string; tileId: string; mailbox: string; filename: string; event: string; message?: unknown }) => {
      if (change?.workspacePath && change.workspacePath !== workspaceDir) return
      if (change.tileId !== tile.id) return
      if (change.mailbox === 'inbox' || change.mailbox === 'sent') {
        loadMessages()
      }
    })

    return () => {
      clearInterval(interval)
      void window.electron?.collab?.unwatchMessages?.(workspaceDir, tile.id)
      unsubscribeMessageChanges?.()
    }
  }, [hasDrawer, workspaceDir, tile.id, loadMessages, peerIds.join(',')])

  // ── Load skills from MCP config on mount ───────────────────────────────
  useEffect(() => {
    if (!hasDrawer || !workspaceId) return
    void window.electron?.mcp?.getMergedConfig?.(workspaceId).then((raw: unknown) => {
      const cfg = raw as { mcpServers?: Record<string, unknown> } | null
      if (!cfg?.mcpServers) return
      const skills: SkillConfig[] = []
      for (const [server, conf] of Object.entries(cfg.mcpServers)) {
        const c = (conf ?? {}) as { url?: string; command?: string }
        // Each MCP server is listed as a toggleable skill
        skills.push({
          id: `mcp:${server}`,
          name: server,
          enabled: true,
          source: 'mcp',
          server,
          description: c.url ?? c.command ?? 'MCP server',
        })
      }
      setData(prev => ({ ...prev, skills }))
    })
  }, [hasDrawer, workspaceId])

  // Listen for all event types on this tile's bus channel
  useEffect(() => {
    if (!hasDrawer) return
    const channel = `tile:${tile.id}`
    const unsub = window.electron?.bus?.subscribe(channel, `drawer:${tile.id}`, (event: { type?: string; payload?: Record<string, unknown>; id?: string; timestamp?: number }) => {
      if (!event?.type) return
      processEvent(event as { type: string; payload: Record<string, unknown>; id: string; timestamp: number }, setData)
      persistToActivityStore(workspaceId, tile.id, event as { type: string; payload: Record<string, unknown>; id: string })
    })
    return () => {
      if (typeof unsub === 'function') unsub()
      else if (unsub && typeof (unsub as Promise<() => void>).then === 'function') {
        void (unsub as Promise<() => void>).then((fn) => fn?.())
      }
    }
  }, [tile.id, hasDrawer, workspaceId])

  // Also extract from busEvents prop
  useEffect(() => {
    if (!busEvents || !hasDrawer) return
    for (const evt of busEvents) {
      processEvent(evt as any, setData)
    }
  }, [busEvents, hasDrawer])

  // Native mousedown listener on the titlebar
  const titlebarRef = useRef<HTMLDivElement>(null)
  const mouseDownRef = useRef(onTitlebarMouseDown)
  useEffect(() => { mouseDownRef.current = onTitlebarMouseDown })

  useEffect(() => {
    const el = titlebarRef.current
    if (!el) return
    const handler = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-no-drag]')) return
      mouseDownRef.current(e as unknown as React.MouseEvent)
    }
    el.addEventListener('mousedown', handler)
    return () => el.removeEventListener('mousedown', handler)
  }, [])

  const pendingTasks = drawerData.tasks.filter(t => t.status !== 'done').length
  const totalActivity = pendingTasks + drawerData.tools.filter(t => t.status === 'running').length
  const frame = tileFrameChrome(titlebarColor ?? theme.accent.base, Boolean(isSelected))
  const tilePanelShadow = theme.mode === 'light'
    ? isSelected
      ? `0 8px 18px color-mix(in srgb, ${theme.text.primary} 13%, transparent)`
      : `inset 0 0 0 0.5px color-mix(in srgb, ${theme.surface.app} 70%, transparent), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 20%, transparent), 0 7px 16px color-mix(in srgb, ${theme.text.primary} 11%, transparent)`
    : isSelected
      ? '0 8px 18px rgba(0, 0, 0, 0.28)'
      : getEdgeShadow(theme, 'strong')
  const drawerPanelShadow = theme.mode === 'light'
    ? `inset 0 0 0 0.5px color-mix(in srgb, ${theme.surface.app} 70%, transparent), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 18%, transparent), 0 7px 16px color-mix(in srgb, ${theme.text.primary} 10%, transparent)`
    : getEdgeShadow(theme, 'strong')

  return (
    <div
      data-tile-chrome="true"
      data-tile-id={tile.id}
      data-tile-type={tile.type}
      className="absolute"
      style={{
        // While dragging/resizing, position via a GPU-composited transform so movement
        // skips layout — heavy tile bodies (Monaco, terminals) don't relayout per frame.
        // When idle, fall back to left/top so the root is NOT a containing block; that
        // keeps inline `position: fixed` descendants (e.g. the customisation fullscreen
        // overlay) anchored to the viewport instead of the tile.
        ...(isInteracting
          ? { left: 0, top: 0, transform: `translate(${tile.x}px, ${tile.y}px)`, willChange: 'transform' }
          : { left: tile.x, top: tile.y }),
        width: tile.width, height: tile.height,
        zIndex: tile.zIndex,
        visibility: forceExpanded ? 'hidden' : 'visible',
        pointerEvents: forceExpanded ? 'none' : 'all',
      }}
      onDoubleClick={e => e.stopPropagation()}
      onMouseDownCapture={() => onActivate?.()}
    >
      {/* Drawer panel — sits behind the tile, slides right */}
      {hasDrawer && (
        <div style={{
          position: 'absolute',
          top: 5,
          bottom: 5,
          left: tile.width - 12,
          width: DRAWER_WIDTH + 12,
          background: theme.surface.panelMuted,
          borderRadius: 10,
          border: '1px solid transparent',
          boxShadow: drawerPanelShadow,
          zIndex: -1,
          transform: drawerOpen ? 'translateX(0)' : `translateX(-${DRAWER_WIDTH}px)`,
          transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          overflow: 'hidden',
          paddingLeft: 12,
        }}>
          <DrawerPanel
            data={drawerData}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onUpdateTask={handleUpdateTask}
            onDeleteTask={handleDeleteTask}
            onAddTask={handleAddTask}
            onToggleSkill={handleToggleSkill}
            onAddNote={handleAddNote}
            onRemoveContext={handleRemoveContext}
            tasksReadOnly={tile.type === 'chat' && derivedChatTasks.length > 0}
          />
        </div>
      )}

      {/* Main tile panel */}
      <div
        className="flex flex-col"
        style={{
          width: '100%', height: '100%',
          borderRadius: getCurvierBlockRadius(tile.borderRadius), overflow: allowOverflow ? 'visible' : 'hidden',
          border: `2px solid ${frame.border}`,
          boxShadow: tilePanelShadow,
          background: theme.surface.panel,
          position: 'relative',
          zIndex: 1,
          transition: 'border-color 160ms ease, box-shadow 160ms ease',
        }}
      >
        {/* Titlebar */}
        <div
          ref={titlebarRef}
          data-tile-titlebar="true"
          style={{
            height: tile.hideTitlebar ? 0 : 32,
            background: titlebarColor ?? frame.titlebarFill ?? theme.surface.titlebar,
            borderBottom: tile.hideTitlebar ? 'none' : titlebarColor ? 'none' : `1px solid ${frame.titlebarBorder ?? theme.border.default}`,
            transition: 'background-color 160ms ease, border-color 160ms ease, color 160ms ease',
            display: tile.hideTitlebar ? 'none' : 'flex',
            alignItems: 'center', justifyContent: 'space-between',
            padding: '0 8px 0 0', userSelect: 'none', flexShrink: 0, cursor: 'move',
            overflow: 'hidden',
          }}
          onDoubleClick={e => { e.stopPropagation(); toggle() }}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e) }}
        >
          {/* Drag handle */}
          <div
            draggable
            onDragStart={e => {
              e.dataTransfer.setData('application/tile-id', tile.id)
              e.dataTransfer.setData('application/tile-type', tile.type)
              e.dataTransfer.setData('application/tile-label', fileLabel(tile))
              e.dataTransfer.effectAllowed = 'link'
              const ghost = document.createElement('div')
              ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px'
              document.body.appendChild(ghost)
              e.dataTransfer.setDragImage(ghost, 0, 0)
              requestAnimationFrame(() => document.body.removeChild(ghost))
              e.stopPropagation()
            }}
            style={{
              width: 28, height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'grab', flexShrink: 0, color: frame.label ?? titlebarMuted, fontSize: fonts.secondarySize
            }}
          >
            ::
          </div>

          {tile.type === 'browser' ? (
            <div
              id={`tile-header-slot-${tile.id}`}
              style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'center' }}
            />
          ) : (
            <span style={{
              flex: 1, fontFamily: fonts.primary, fontSize: fonts.size, fontWeight: Math.min(900, fonts.weight + 100), color: frame.label ?? titlebarForeground,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>
              {fileLabel(tile)}
            </span>
          )}

          {titlebarExtra && (
            <div data-no-drag="" style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              {titlebarExtra}
            </div>
          )}

          {discoveryConnected && (
            <div
              title="Nearby connection negotiated"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                marginRight: 8,
                // Magnet/connection indicator dot — anchored on the theme's
                // accent so it shifts with palette and contrast.
                background: `color-mix(in srgb, ${theme.accent.base} 88%, transparent)`,
                boxShadow: `0 0 8px color-mix(in srgb, ${theme.accent.base} 34%, transparent), 0 0 0 0.5px color-mix(in srgb, ${theme.accent.base} 12%, transparent)`,
              }}
            />
          )}

          {/* Drawer toggle — only for terminal/chat */}
          {hasDrawer && (
            <button
              data-no-drag=""
              style={{
                width: 24, height: 24, borderRadius: 4, background: 'transparent',
                border: 'none', cursor: 'pointer', flexShrink: 0,
                color: drawerOpen ? theme.accent.base : theme.text.disabled,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                position: 'relative',
              }}
              onClick={e => { e.stopPropagation(); setDrawerOpen(p => !p) }}
              onMouseDown={e => e.stopPropagation()}
              onMouseEnter={e => { if (!drawerOpen) e.currentTarget.style.color = theme.text.muted }}
              onMouseLeave={e => { if (!drawerOpen) e.currentTarget.style.color = theme.text.disabled }}
              title={drawerOpen ? 'Hide panel' : 'Show panel'}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3.5h8M3 7h8M3 10.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              {totalActivity > 0 && !drawerOpen && (
                <span style={{
                  position: 'absolute', top: 1, right: 1,
                  minWidth: 12, height: 12, borderRadius: 6,
                  background: theme.accent.base, color: theme.text.inverse,
                  fontSize: 8, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 2px',
                }}>
                  {totalActivity > 9 ? '9+' : totalActivity}
                </span>
              )}
            </button>
          )}

          {/* Expand/collapse */}
          <button
            data-no-drag=""
            style={{
              width: 24, height: 24, borderRadius: 4, background: 'transparent',
              border: 'none', cursor: 'pointer', flexShrink: 0,
              color: theme.text.disabled, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
            onClick={e => { e.stopPropagation(); toggle() }}
            onMouseDown={e => e.stopPropagation()}
            onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
            onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              {expanded ? (
                <path d="M3 5.5h8M3 8.5h8M5.5 3v8M8.5 3v8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              ) : (
                <path d="M2 2h4v4H2zM8 2h4v4H8zM2 8h4v4H2zM8 8h4v4H8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              )}
            </svg>
          </button>

          {/* Bus event indicator */}
          {(busUnreadCount ?? 0) > 0 && (
            <button
              ref={busPopupButtonRef}
              data-no-drag=""
              onClick={e => { e.stopPropagation(); onBusPopupToggle?.() }}
              onMouseDown={e => e.stopPropagation()}
              style={{
                minWidth: 18, height: 18, borderRadius: 9,
                background: theme.accent.base,
                border: 'none', cursor: 'pointer',
                color: theme.text.inverse, fontSize: 10, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 5px',
                marginLeft: 4,
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = theme.accent.hover)}
              onMouseLeave={e => (e.currentTarget.style.background = theme.accent.base)}
              title={`${busUnreadCount} new event${busUnreadCount !== 1 ? 's' : ''}`}
            >
              {busUnreadCount! > 99 ? '99+' : busUnreadCount}
            </button>
          )}

          <button
            data-no-drag=""
            style={{
              width: 24, height: 24, borderRadius: 4, background: 'transparent',
              border: 'none', cursor: 'pointer', flexShrink: 0,
              color: theme.text.disabled, display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginLeft: 4
            }}
            onClick={e => { e.stopPropagation(); onClose() }}
            onMouseDown={e => e.stopPropagation()}
            onMouseEnter={e => (e.currentTarget.style.color = theme.status.danger)}
            onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div
          style={{ flex: 1, overflow: allowOverflow ? 'visible' : 'hidden', minHeight: 0, position: 'relative' } as React.CSSProperties}
          onDragOver={e => { if (tile.type !== 'kanban') e.stopPropagation() }}
          onDrop={e => { if (tile.type !== 'kanban') e.stopPropagation() }}
        >
          {forceExpanded ? null : children}

          {/* Chromeless drag strip — when titlebar is hidden, this thin overlay
              at the top provides a reliable drag + right-click target so the
              tile is still movable and the context menu remains reachable. */}
          {tile.hideTitlebar && (
            <div
              data-chromeless-drag=""
              onMouseDown={e => { e.stopPropagation(); onTitlebarMouseDown(e) }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e) }}
              onDoubleClick={e => { e.stopPropagation(); toggle() }}
              style={{
                position: 'absolute',
                top: 0, left: 0, right: 0,
                height: 24,
                cursor: 'grab',
                zIndex: 5,
                // Drag-handle gradient overlay — pure black/white alpha is
                // appropriate here because this overlay sits on top of
                // arbitrary tile content (image, video, code) and needs to
                // dim/contrast against any backdrop.
                background: `linear-gradient(to bottom, color-mix(in srgb, #000 35%, transparent), transparent)`,
                opacity: 0,
                transition: 'opacity 120ms ease',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: `color-mix(in srgb, #fff 70%, transparent)`,
                fontSize: 11,
                letterSpacing: 1,
                userSelect: 'none',
                pointerEvents: 'auto',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0')}
            >
              ::::
            </div>
          )}
        </div>

        {(['n','s','e','w','ne','nw','se','sw'] as const).map(dir => (
          <ResizeHandle key={dir} dir={dir} onMouseDown={e => onResizeMouseDown(e, dir)} />
        ))}

        {/* Bus event popup */}
        {showBusPopup && busEvents && (
          <div
            ref={busPopupRef}
            data-no-drag=""
            onMouseDown={e => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: 34, right: 4,
              width: 300, maxHeight: 280,
              background: theme.surface.panelElevated,
              border: `1px solid ${theme.border.default}`,
              borderRadius: 8,
              boxShadow: theme.shadow.panel,
              zIndex: 20,
              overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{
              padding: '6px 10px',
              borderBottom: `1px solid ${theme.border.default}`,
              fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.muted,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Events</span>
              <button
                onClick={e => { e.stopPropagation(); onBusPopupToggle?.() }}
                style={{
                  background: 'none', border: 'none', color: theme.text.disabled, cursor: 'pointer', fontSize: fonts.secondarySize
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
              {busEvents.length === 0 ? (
                <div style={{ padding: '12px', textAlign: 'center', color: theme.text.disabled, fontSize: fonts.secondarySize }}>
                  No events yet
                </div>
              ) : (
                busEvents.slice(-30).reverse().map(evt => (
                  <div key={evt.id} style={{
                    padding: '4px 10px',
                    borderBottom: `1px solid ${theme.border.subtle}`,
                    fontSize: fonts.secondarySize,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{
                        color: evt.type === 'notification' ? theme.status.warning :
                               evt.type === 'progress' ? theme.accent.base :
                               evt.type === 'task' ? theme.status.success :
                               theme.text.muted,
                        fontWeight: 500,
                      }}>
                        {evt.type}
                      </span>
                      <span style={{ color: theme.text.disabled, fontSize: 10 }}>
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ color: theme.text.secondary }}>
                      {(evt.payload as any).message ?? (evt.payload as any).status ?? (evt.payload as any).title ?? JSON.stringify(evt.payload).slice(0, 80)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const TileChrome = React.memo(TileChromeComponent, areTileChromePropsEqual)
