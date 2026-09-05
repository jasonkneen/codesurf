import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ListTodo } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import { renderExtensionIcon } from './extensionIcons'
import { useTileTodos, type TileTodoItem } from '../state/tileTodosStore'
import {
  panelAtPoint,
  resolveTabDrop,
  zoneAtPoint,
} from '../lib/panelDock'
import {
  dockTileInTree,
  pinTabInLeaf,
  setActiveTab,
  type DockZone,
  type PanelLeaf,
  type PanelNode,
} from './panelLayoutTree'

const PANEL_SPLIT_GUTTER_PX = 6
const PANEL_SHELL_RADIUS_PX = 16
interface PanelCornerRadii {
  topLeft: number
  topRight: number
  bottomRight: number
  bottomLeft: number
}

const DEFAULT_PANEL_CORNER_RADII: PanelCornerRadii = {
  topLeft: PANEL_SHELL_RADIUS_PX,
  topRight: PANEL_SHELL_RADIUS_PX,
  bottomRight: PANEL_SHELL_RADIUS_PX,
  bottomLeft: PANEL_SHELL_RADIUS_PX,
}

interface PanelOuterEdges {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

function getLeafBorderRadius(edges: PanelOuterEdges, outerRadii: PanelCornerRadii): string {
  const topLeft = edges.top && edges.left ? outerRadii.topLeft : 0
  const topRight = edges.top && edges.right ? outerRadii.topRight : 0
  const bottomRight = edges.bottom && edges.right ? outerRadii.bottomRight : 0
  const bottomLeft = edges.bottom && edges.left ? outerRadii.bottomLeft : 0
  return `${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px`
}

function setWebviewsInteractionBlocked(blocked: boolean): void {
  if (typeof document === 'undefined') return
  // Block both webviews and iframes — both create independent pointer-event surfaces
  // that swallow mousemove/mouseup from the parent document during drags.
  document.querySelectorAll('webview, iframe').forEach(el => {
    ;(el as HTMLElement).style.pointerEvents = blocked ? 'none' : 'auto'
  })
}

function PanelTabIcon({ type, icon, size = 12 }: { type: string; icon?: string | null; size?: number }): JSX.Element {
  const stroke = 1.2

  if (type === 'terminal') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><path d="M2 3l4 4-4 4" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" /><path d="M7 11h5" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" /></svg>
  if (type === 'code') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><path d="M5 3 1 7l4 4M9 3l4 4-4 4" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" /></svg>
  if (type === 'note') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth={stroke} /><path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>
  if (type === 'browser') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth={stroke} /><path d="M1 5h12" stroke="currentColor" strokeWidth={stroke} /></svg>
  if (type === 'chat') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><path d="M2 2h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5l-3 2.5V10H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth={stroke} strokeLinejoin="round" /></svg>
  if (type === 'files') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><path d="M1 3C1 2.17 1.67 1.5 2.5 1.5H5L6.5 3H11.5C12.33 3 13 3.67 13 4.5V11C13 11.83 12.33 12.5 11.5 12.5H2.5C1.67 12.5 1 11.83 1 11V3Z" stroke="currentColor" strokeWidth={stroke} /></svg>
  if (type === 'kanban') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" /></svg>
  if (type === 'image') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth={stroke} /><circle cx="5" cy="5" r="1.2" stroke="currentColor" strokeWidth="1" /><path d="M1.5 10l3-3 2 2 2.5-3 3.5 4" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" /></svg>
  if (type === 'media') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth={stroke} /><path d="M5.5 4.75 9 7l-3.5 2.25V4.75Z" fill="currentColor" /></svg>
  if (type === 'customisation') return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><path d="M7 2.25 8 1l1.15.55.1 1.55a4.8 4.8 0 0 1 1.1.64l1.47-.52.68 1.06-.99 1.2c.09.27.15.55.18.84l1.4.7-.2 1.25-1.56.21a4.91 4.91 0 0 1-.58 1.05l.56 1.48-1.05.68-1.21-.98c-.26.1-.54.17-.82.21L8 13H6.75l-.23-1.55a4.72 4.72 0 0 1-.82-.21l-1.21.98-1.05-.68.56-1.48a4.91 4.91 0 0 1-.58-1.05l-1.56-.2-.2-1.26 1.4-.7c.03-.29.09-.57.18-.84l-.99-1.2.68-1.06 1.47.52c.34-.27.71-.49 1.1-.64L4.85 1.55 6 1l1 1.25Z" stroke="currentColor" strokeWidth="0.95" strokeLinejoin="round" /><circle cx="7" cy="7" r="1.7" stroke="currentColor" strokeWidth="0.95" /></svg>
  if (type.startsWith('ext:')) {
    return <>{renderExtensionIcon(icon, size)}</>
  }
  return <svg width={size} height={size} viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth={stroke} /></svg>
}

function getNodeMinWidth(node: PanelNode, getTileType: (tileId: string) => string): number {
  if (node.type === 'leaf') {
    return node.tabs.some(tileId => getTileType(tileId) === 'chat') ? 360 : 0
  }
  const childWidths = node.children.map(child => getNodeMinWidth(child, getTileType))
  return node.direction === 'horizontal'
    ? childWidths.reduce((sum, width) => sum + width, 0) + (Math.max(0, node.children.length - 1) * PANEL_SPLIT_GUTTER_PX)
    : Math.max(0, ...childWidths)
}

// ─── Dock Overlay ─────────────────────────────────────────────────────────────

function DockOverlay({ zone }: { zone: DockZone | null }): JSX.Element | null {
  const theme = useTheme()
  if (!zone) return null
  const styles: Record<DockZone, React.CSSProperties> = {
    left:   { position: 'absolute', left: 0, top: 0, width: '50%', height: '100%' },
    right:  { position: 'absolute', right: 0, top: 0, width: '50%', height: '100%' },
    top:    { position: 'absolute', left: 0, top: 0, width: '100%', height: '50%' },
    bottom: { position: 'absolute', left: 0, bottom: 0, width: '100%', height: '50%' },
    center: { position: 'absolute', inset: 0 },
  }
  return (
    <div
      data-codesurf-dock-overlay=""
      data-codesurf-dock-zone={zone}
      style={{
        ...styles[zone],
        background: theme.surface.accentSoft,
        border: `2px solid ${theme.border.accent}`,
        borderRadius: 4,
        pointerEvents: 'none',
        zIndex: 20,
      }}
    />
  )
}

// ─── Resize Handle ────────────────────────────────────────────────────────────

function ResizeHandle({ direction, onResize, onInteractionChange }: { direction: 'horizontal' | 'vertical'; onResize: (delta: number) => void; onInteractionChange?: (active: boolean) => void }): JSX.Element {
  const theme = useTheme()
  const dragging = useRef(false)
  const lastPos = useRef(0)
  const isHorizontal = direction === 'horizontal'
  const gutterBackground = theme.surface.panel
  // Ref so the mousemove closure always calls the latest onResize,
  // even after re-renders invalidate the original closure.
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    // Native Electron webviews can steal the drag stream as soon as the cursor
    // crosses into them, so block them synchronously before the first mousemove.
    setWebviewsInteractionBlocked(true)
    onInteractionChange?.(true)
    lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const pos = direction === 'horizontal' ? ev.clientX : ev.clientY
      onResizeRef.current(pos - lastPos.current)
      lastPos.current = pos
    }
    const onUp = () => {
      dragging.current = false
      setWebviewsInteractionBlocked(false)
      onInteractionChange?.(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction, onInteractionChange])

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        // Fixed gutter between split leaves — lets each leaf's borderRadius
        // show as rounded corners, matching the sidebar↔main-panel gap.
        [isHorizontal ? 'width' : 'height']: PANEL_SPLIT_GUTTER_PX,
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        background: gutterBackground,
        position: 'relative',
        zIndex: 5,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = gutterBackground)}
      onMouseLeave={e => { if (!dragging.current) e.currentTarget.style.background = gutterBackground }}
    />
  )
}

// ─── Tab Bar ─────────────────────────────────────────────────────────────────

interface TabBarProps {
  tabs: { id: string; label: string }[]
  activeTab: string
  previewTabId?: string | null
  panelId: string
  onActivate: (tileId: string) => void
  onPinTab: (tileId: string) => void
  onClose: (tileId: string) => void
  onTabMouseDown: (tileId: string, panelId: string, label: string, e: React.MouseEvent) => void
  onExit?: () => void
  getTileType: (tileId: string) => string
  getTileIcon?: (tileId: string) => string | undefined
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
}

interface CtxMenu { tileId: string; tileType: string; x: number; y: number }

function TabBar({ tabs, activeTab, previewTabId = null, panelId, onActivate, onPinTab, onClose, onTabMouseDown, getTileType, getTileIcon, onSplitNew, onCloseOthers, onCloseToRight }: TabBarProps): JSX.Element {
  const theme = useTheme()
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Selected tab fill: in light mode it's a slightly tinted paper (anchor on
  // panelMuted to avoid pure white blowing out next to canvas); in dark mode
  // it's a low-alpha glass over the canvas. Both anchor on theme tokens so
  // they shift with contrast.
  const compactTabBackground = theme.mode === 'light'
    ? `color-mix(in srgb, ${theme.surface.panelMuted} 88%, transparent)`
    : `color-mix(in srgb, ${theme.text.primary} 13%, transparent)`
  const compactTabInactiveBackground = 'transparent'
  const compactTabHoverBackground = theme.mode === 'light'
    ? `color-mix(in srgb, ${theme.surface.app} 32%, transparent)`
    : `color-mix(in srgb, ${theme.text.primary} 5.5%, transparent)`
  const compactTabMaxWidth = 'min(180px, 18vw)'

  useEffect(() => {
    if (!ctxMenu) return
    const dismiss = () => setCtxMenu(null)
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [!!ctxMenu])

  // Scroll active tab into view when it changes (e.g. new tab added)
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const el = container.querySelector<HTMLElement>(`[data-tab-id="${activeTab}"]`)
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTab])

  const tabIdx = ctxMenu ? tabs.findIndex(t => t.id === ctxMenu.tileId) : -1
  const hasTabsToRight = tabIdx >= 0 && tabIdx < tabs.length - 1

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', height: 34,
      background: theme.surface.panel,
      overflow: 'hidden', flexShrink: 0, zIndex: 1,
      padding: '0 4px 0 2px',
    }}>
      {/* Scrollable tab strip */}
      <div ref={scrollRef} style={{
        display: 'flex', alignItems: 'center', gap: 2,
        flex: 1, overflowX: 'auto', overflowY: 'hidden',
        padding: '0 0 1px',
      }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTab
          const isPreview = tab.id === previewTabId
          const tileType = getTileType(tab.id)
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              title={isPreview ? `${tab.label} (Preview)` : tab.label}
              onMouseDown={e => {
                if (e.button !== 0) return
                e.preventDefault()
                e.stopPropagation()
                onTabMouseDown(tab.id, panelId, tab.label, e)
              }}
              onClick={() => {
                if (isPreview && isActive) {
                  onPinTab(tab.id)
                  return
                }
                onActivate(tab.id)
              }}
              onDoubleClick={e => {
                e.stopPropagation()
                onPinTab(tab.id)
              }}
              onContextMenu={e => {
                e.preventDefault()
                setCtxMenu({ tileId: tab.id, tileType: getTileType(tab.id), x: e.clientX, y: e.clientY })
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                height: 24,
                padding: '0 9px 0 10px', margin: isActive ? '0 2px 4px' : '0 2px', cursor: 'grab', userSelect: 'none',
                fontSize: 11, color: isActive ? theme.text.primary : theme.text.secondary,
                background: isActive ? compactTabBackground : compactTabInactiveBackground,
                marginBottom: isActive ? 4 : 3,
                borderRadius: 8,
                transition: 'color 0.15s, background 0.15s, border-color 0.15s',
                flexShrink: 0, maxWidth: compactTabMaxWidth,
                fontWeight: isActive ? 700 : 600,
                letterSpacing: 0.45,
                textTransform: 'uppercase',
                boxShadow: isActive ? 'var(--cs-edge-shadow-subtle)' : 'none',
                border: isPreview
                  ? `1px dashed ${isActive ? theme.border.accent : theme.border.subtle}`
                  : '1px solid transparent',
                fontStyle: isPreview ? 'italic' : 'normal',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  e.currentTarget.style.background = compactTabHoverBackground
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  e.currentTarget.style.background = compactTabInactiveBackground
                }
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', color: 'currentColor', flexShrink: 0 }}>
                <PanelTabIcon type={tileType} icon={getTileIcon?.(tab.id)} />
              </span>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {tab.label}
              </span>
              <span
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onClose(tab.id) }}
                style={{
                  width: 13, height: 13,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'currentColor',
                  flexShrink: 0, cursor: 'pointer', transition: 'color 0.15s',
                  marginLeft: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '0.72' }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
            </div>
          )
        })}
      </div>

      {/* Todo-list affordance: shown when the active tab is a chat tile that
          has published a TodoWrite list. Click to open a popover with the
          full list. Mirrors the tile/block todo icon pattern used elsewhere. */}
      <TabBarTodoButton
        activeTab={activeTab}
        isChat={getTileType(activeTab) === 'chat'}
      />

      {/* Context menu — position: fixed to escape overflow clipping */}
      {ctxMenu && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', left: ctxMenu.x, top: ctxMenu.y,
            background: theme.surface.panelElevated, border: `1px solid ${theme.border.default}`,
            borderRadius: 8, padding: 4, zIndex: 999999,
            minWidth: 190, boxShadow: theme.shadow.panel,
          }}
        >
          {([
            { label: 'Split Left',   zone: 'left'   },
            { label: 'Split Right',  zone: 'right'  },
            { label: 'Split Up',     zone: 'top'    },
            { label: 'Split Down',   zone: 'bottom' },
          ] as { label: string; zone: DockZone }[]).map(item => (
            <CtxItem key={item.zone} label={item.label} onClick={() => {
              onSplitNew(panelId, ctxMenu.tileType, item.zone)
              setCtxMenu(null)
            }} />
          ))}
          <CtxDivider />
          <CtxItem label="Close" onClick={() => { onClose(ctxMenu.tileId); setCtxMenu(null) }} />
          <CtxItem label="Close Others" onClick={() => { onCloseOthers(panelId, ctxMenu.tileId); setCtxMenu(null) }} disabled={tabs.length <= 1} />
          <CtxItem label="Close to Right" onClick={() => { onCloseToRight(panelId, ctxMenu.tileId); setCtxMenu(null) }} disabled={!hasTabsToRight} />
        </div>
      )}
    </div>
  )
}

/**
 * Todo-list affordance for the tab bar. Subscribes to the `tileTodosStore`
 * for the active chat tile and, when a list is available, renders a small
 * icon button with a completion-count badge. Clicking it opens a floating
 * popover rendering the same ✓/▸/○ glyph pattern used inside the ChatTile's
 * inline TodoWrite rendering.
 *
 * Rendered outside the scrollable tab strip so it stays pinned to the
 * right edge even when many tabs are open.
 */
function TabBarTodoButton({ activeTab, isChat }: { activeTab: string; isChat: boolean }): JSX.Element | null {
  const theme = useTheme()
  const fonts = useAppFonts()
  const todos = useTileTodos(isChat ? activeTab : null)
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null)
  const [hover, setHover] = useState(false)

  // Close the popover when clicking outside.
  useEffect(() => {
    if (!open) return
    const dismiss = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (btnRef.current && target && btnRef.current.contains(target)) return
      const popover = document.getElementById('tabbar-todo-popover')
      if (popover && target && popover.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])

  // Recalculate popover position when opened or when the active tab changes.
  useEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setPopoverPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
  }, [open, activeTab])

  // Auto-close if the todo list goes away (e.g. tile closed or list cleared).
  useEffect(() => {
    if (!todos || todos.length === 0) setOpen(false)
  }, [todos])

  if (!isChat || !todos || todos.length === 0) return null

  const completed = todos.filter(t => t.status === 'completed').length
  const total = todos.length
  const inProgress = todos.some(t => t.status === 'in_progress')

  return (
    <>
      <button
        ref={btnRef}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={`Todo list (${completed}/${total})`}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          flexShrink: 0,
          height: 21,
          padding: '0 6px',
          marginLeft: 6, marginRight: 2, marginBottom: 3,
          background: open ? theme.surface.hover : (hover ? theme.surface.panelMuted : 'transparent'),
          border: '1px solid transparent',
          borderRadius: 4,
          cursor: 'pointer',
          color: inProgress ? theme.accent.base : theme.text.secondary,
          fontSize: 10,
          fontFamily: fonts.primary,
          fontWeight: 500,
          letterSpacing: 0.3,
          transition: 'color 0.15s, background 0.15s',
        }}
      >
        <ListTodo size={12} />
        <span style={{ opacity: 0.85 }}>{completed}/{total}</span>
      </button>
      {open && popoverPos && (
        <TabBarTodoPopover todos={todos} top={popoverPos.top} right={popoverPos.right} />
      )}
    </>
  )
}

function TabBarTodoPopover({ todos, top, right }: { todos: TileTodoItem[]; top: number; right: number }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div
      id="tabbar-todo-popover"
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: 'fixed', top, right,
        background: theme.surface.panelElevated,
        border: `1px solid ${theme.border.default}`,
        borderRadius: 8, padding: 10,
        minWidth: 280, maxWidth: 420,
        maxHeight: 480, overflowY: 'auto',
        zIndex: 999999,
        boxShadow: theme.shadow.panel,
        display: 'flex', flexDirection: 'column', gap: 4,
        fontFamily: fonts.primary,
      }}
    >
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
        color: theme.text.muted, marginBottom: 4,
      }}>
        Agent todos
      </div>
      {todos.map((todo, i) => {
        const status = todo.status
        const color = status === 'completed'
          ? theme.status.success
          : status === 'in_progress'
            ? theme.status.warning
            : theme.text.muted
        return (
          <div key={i} style={{
            display: 'flex', gap: 8, alignItems: 'flex-start',
            fontSize: 11, color: theme.text.primary,
            lineHeight: 1.35,
          }}>
            <span style={{ color, fontWeight: 700, flexShrink: 0, marginTop: 1, minWidth: 10 }}>
              {status === 'completed' ? '\u2713' : status === 'in_progress' ? '\u25B8' : '\u25CB'}
            </span>
            <span style={{
              textDecoration: status === 'completed' ? 'line-through' : undefined,
              opacity: status === 'completed' ? 0.65 : 1,
              wordBreak: 'break-word',
            }}>
              {status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function CtxItem({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        padding: '5px 10px', borderRadius: 5, cursor: disabled ? 'default' : 'pointer',
        fontSize: fonts.secondarySize, color: disabled ? theme.text.disabled : theme.text.primary, userSelect: 'none',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = theme.surface.hover }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </div>
  )
}

function CtxDivider(): JSX.Element {
  const theme = useTheme()
  return <div style={{ height: 1, background: theme.border.default, margin: '3px 0' }} />
}

// ─── Empty Panel ─────────────────────────────────────────────────────────────

const LazyLayoutBuilder = React.lazy(() => import('./LayoutBuilder').then(m => ({ default: m.LayoutBuilder })))

function EmptyPanel({ onAddTile, onLaunchTemplate }: { onAddTile: (type: string) => void; onLaunchTemplate?: (template: import('../../../shared/types').LayoutTemplate) => void }): JSX.Element {
  return (
    <React.Suspense fallback={<div style={{ position: 'absolute', inset: 0 }} />}>
      <LazyLayoutBuilder onAddTile={onAddTile} onLaunchTemplate={onLaunchTemplate} />
    </React.Suspense>
  )
}

// ─── Leaf Panel ───────────────────────────────────────────────────────────────

interface LeafPanelProps {
  leaf: PanelLeaf
  outerEdges: PanelOuterEdges
  getTileLabel: (tileId: string) => string
  renderTile: (tileId: string, options?: { isInteracting?: boolean; isActive?: boolean }) => React.ReactNode
  isInteracting: boolean
  onActivate: (panelId: string, tileId: string) => void
  onPinTab: (panelId: string, tileId: string) => void
  onCloseTab: (tileId: string) => void
  onTabMouseDown: (tileId: string, panelId: string, label: string, e: React.MouseEvent) => void
  onPanelFocus: (panelId: string) => void
  onAddTile: (type: string) => void
  dragTarget: { panelId: string; zone: DockZone } | null
  onExit: () => void
  getTileType: (tileId: string) => string
  getTileIcon?: (tileId: string) => string | undefined
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
  onLaunchTemplate?: (template: import('../../../shared/types').LayoutTemplate) => void
  outerRadii: PanelCornerRadii
  flushLeafChrome?: boolean
}

function LeafPanel({ leaf, outerEdges, getTileLabel, renderTile, isInteracting, onActivate, onPinTab, onCloseTab, onTabMouseDown, onPanelFocus, onAddTile, dragTarget, onExit, getTileType, getTileIcon, onSplitNew, onCloseOthers, onCloseToRight, onLaunchTemplate, outerRadii, flushLeafChrome }: LeafPanelProps): JSX.Element {
  const theme = useTheme()
  const keepMountedWhenInactive = useCallback((tileId: string) => {
    const type = getTileType(tileId)
    return type === 'terminal' || type === 'browser' || type === 'chat' || type.startsWith('ext:')
  }, [getTileType])
  const tabs = leaf.tabs.map(id => ({ id, label: getTileLabel(id) }))
  const isEmpty = tabs.length === 0
  const dockZone = dragTarget?.panelId === leaf.id ? dragTarget.zone : null
  const borderRadius = getLeafBorderRadius(outerEdges, outerRadii)

  return (
    <div
      data-codesurf-panel-id={leaf.id}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        borderRadius,
        overflow: 'hidden',
        background: theme.surface.panel,
        border: flushLeafChrome ? 'none' : '0.5px solid transparent',
        boxShadow: flushLeafChrome ? 'none' : 'var(--cs-edge-shadow-strong)',
        boxSizing: 'border-box',
      }}
      onClick={() => onPanelFocus(leaf.id)}
    >
      {!isEmpty && (
        <TabBar
          tabs={tabs}
          activeTab={leaf.activeTab}
          previewTabId={leaf.previewTabId ?? null}
          panelId={leaf.id}
          onActivate={tileId => onActivate(leaf.id, tileId)}
          onPinTab={tileId => onPinTab(leaf.id, tileId)}
          onClose={onCloseTab}
          onTabMouseDown={onTabMouseDown}
          onExit={onExit}
          getTileType={getTileType}
          getTileIcon={getTileIcon}
          onSplitNew={onSplitNew}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
        />
      )}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0, background: theme.surface.panel }}>
        {isEmpty ? (
          <EmptyPanel onAddTile={onAddTile} onLaunchTemplate={onLaunchTemplate} />
        ) : (
          leaf.tabs.map(tileId => {
            const isActive = tileId === leaf.activeTab
            if (!isActive && !keepMountedWhenInactive(tileId)) return null
            return (
              <div
                key={tileId}
                style={{
                  position: 'absolute',
                  inset: 0,
                  visibility: isActive ? 'visible' : 'hidden',
                  pointerEvents: isActive ? 'auto' : 'none',
                }}
              >
                {renderTile(tileId, { isInteracting, isActive })}
              </div>
            )
          })
        )}
      </div>
      <DockOverlay zone={dockZone} />
    </div>
  )
}

// ─── Main PanelLayout ─────────────────────────────────────────────────────────

export interface PanelLayoutProps {
  root: PanelNode
  getTileLabel: (tileId: string) => string
  renderTile: (tileId: string, options?: { isInteracting?: boolean; isActive?: boolean }) => React.ReactNode
  onLayoutChange: (newRoot: PanelNode) => void
  onCloseTab: (tileId: string) => void
  onAddTile: (type: string) => void
  onExit: () => void
  activePanelId: string | null
  onActivePanelChange: (panelId: string) => void
  getTileType: (tileId: string) => string
  getTileIcon?: (tileId: string) => string | undefined
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
  insetBottom?: number
  onLaunchTemplate?: (template: import('../../../shared/types').LayoutTemplate) => void
  outerRadii?: PanelCornerRadii
  /** Minimum edge thickness in viewport px so canvas-zoom still has L/R/T/B snap. */
  dockMinEdgePx?: number
  /** Dropped a tab on the free canvas — leave this layout. */
  onTabDropOutside?: (tileId: string, clientX: number, clientY: number) => void
  /** Skip the leaf hairline when a parent frame already paints the border. */
  flushLeafChrome?: boolean
}

export function PanelLayout({ root, getTileLabel, renderTile, onLayoutChange, onCloseTab, onAddTile, onExit, activePanelId: _activePanelId, onActivePanelChange, getTileType, getTileIcon, onSplitNew, onCloseOthers, onCloseToRight, insetBottom = 0, onLaunchTemplate, outerRadii = DEFAULT_PANEL_CORNER_RADII, dockMinEdgePx, onTabDropOutside, flushLeafChrome = false }: PanelLayoutProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const layoutRootRef = useRef<HTMLDivElement>(null)
  const dockMinEdgePxRef = useRef(dockMinEdgePx)
  dockMinEdgePxRef.current = dockMinEdgePx
  const [dragTarget, setDragTarget] = useState<{ panelId: string; zone: DockZone } | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [panelInteractionActive, setPanelInteractionActive] = useState(false)
  const handleDockRef = useRef<(tileId: string, fromPanelId: string, targetPanelId: string, zone: DockZone) => void>(() => {})
  const onTabDropOutsideRef = useRef(onTabDropOutside)
  onTabDropOutsideRef.current = onTabDropOutside

  useEffect(() => {
    return () => setWebviewsInteractionBlocked(false)
  }, [])

  const handleActivate = useCallback((panelId: string, tileId: string) => {
    onActivePanelChange(panelId)
    onLayoutChange(setActiveTab(root, panelId, tileId))
  }, [root, onLayoutChange, onActivePanelChange])

  const handlePinTab = useCallback((panelId: string, tileId: string) => {
    onActivePanelChange(panelId)
    onLayoutChange(pinTabInLeaf(root, panelId, tileId))
  }, [root, onLayoutChange, onActivePanelChange])

  const handleDock = useCallback((tileId: string, fromPanelId: string, targetPanelId: string, zone: DockZone) => {
    const next = dockTileInTree(root, tileId, fromPanelId, targetPanelId, zone)
    if (next !== root) onLayoutChange(next)
  }, [root, onLayoutChange])
  handleDockRef.current = handleDock

  const handleTabMouseDown = useCallback((tileId: string, fromPanelId: string, label: string, e: React.MouseEvent) => {
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false

    // Block iframes/webviews immediately — before the cursor can move over them.
    // If we wait for the 5px threshold, Chromium may already have captured the
    // pointer stream into the iframe surface and our document-level mouseup never fires.
    setWebviewsInteractionBlocked(true)

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!dragging && Math.sqrt(dx * dx + dy * dy) > 5) {
        dragging = true
        setPanelInteractionActive(true)
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
      }
      if (!dragging) return

      setGhost({ x: ev.clientX, y: ev.clientY, label })

      const rootEl = layoutRootRef.current
      const panelId = panelAtPoint(rootEl, ev.clientX, ev.clientY)
      // Commit dragTarget only when the resolved panel/zone actually changes.
      // Setting a fresh object on every mousemove re-rendered PanelLayout at
      // pointer rate, which re-invoked the unmemoized LeafPanel and through it
      // renderTile for every kept-mounted tab (Monaco, xterm, chat, browser) —
      // dirtying layout that the next event then read back via
      // panelAtPoint/zoneAtPoint. Most moves resolve to the same target, so this
      // removes the great majority of those commits.
      if (!panelId) {
        setDragTarget(prev => (prev === null ? prev : null))
      } else {
        const nextZone = zoneAtPoint(rootEl, ev.clientX, ev.clientY, panelId, { minEdgePx: dockMinEdgePxRef.current })
        setDragTarget(prev => (
          prev && prev.panelId === panelId && prev.zone === nextZone
            ? prev
            : { panelId, zone: nextZone }
        ))
      }
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setGhost(null)
      setDragTarget(null)
      setWebviewsInteractionBlocked(false)
      setPanelInteractionActive(false)

      if (!dragging) return

      const rootEl = layoutRootRef.current
      const targetPanelId = panelAtPoint(rootEl, ev.clientX, ev.clientY)
      const drop = resolveTabDrop(targetPanelId, Boolean(onTabDropOutsideRef.current))
      if (drop === 'dock' && targetPanelId) {
        const zone = zoneAtPoint(rootEl, ev.clientX, ev.clientY, targetPanelId, { minEdgePx: dockMinEdgePxRef.current })
        handleDockRef.current(tileId, fromPanelId, targetPanelId, zone)
        return
      }
      if (drop === 'eject') {
        onTabDropOutsideRef.current?.(tileId, ev.clientX, ev.clientY)
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const handleResize = useCallback((splitId: string, index: number, delta: number, totalPx: number) => {
    const update = (node: PanelNode): PanelNode => {
      if (node.type === 'leaf') return node
      if (node.id === splitId) {
        const sizes = [...node.sizes]
        if (node.direction === 'horizontal') {
          const currentPxA = totalPx * (sizes[index] / 100)
          const currentPxB = totalPx * (sizes[index + 1] / 100)
          const pairTotalPx = currentPxA + currentPxB
          const minPxA = getNodeMinWidth(node.children[index], getTileType)
          const minPxB = getNodeMinWidth(node.children[index + 1], getTileType)
          const nextPxA = Math.min(Math.max(currentPxA + delta, minPxA), pairTotalPx - minPxB)
          const nextPxB = pairTotalPx - nextPxA
          sizes[index] = (nextPxA / totalPx) * 100
          sizes[index + 1] = (nextPxB / totalPx) * 100
        } else {
          const pct = (delta / totalPx) * 100
          sizes[index] = Math.max(10, sizes[index] + pct)
          sizes[index + 1] = Math.max(10, sizes[index + 1] - pct)
        }
        return { ...node, sizes }
      }
      return { ...node, children: node.children.map(update) }
    }
    onLayoutChange(update(root))
  }, [root, onLayoutChange, getTileType])

  const renderNode = (node: PanelNode, outerEdges: PanelOuterEdges): React.ReactNode => {
    if (node.type === 'leaf') {
      return (
        <LeafPanel
          key={node.id}
          leaf={node}
          outerEdges={outerEdges}
          getTileLabel={getTileLabel}
          renderTile={renderTile}
          isInteracting={panelInteractionActive}
          onActivate={handleActivate}
          onPinTab={handlePinTab}
          onCloseTab={onCloseTab}
          onTabMouseDown={handleTabMouseDown}
          onPanelFocus={onActivePanelChange}
          onAddTile={onAddTile}
          dragTarget={dragTarget}
          onExit={onExit}
          getTileType={getTileType}
          getTileIcon={getTileIcon}
          onSplitNew={onSplitNew}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
          onLaunchTemplate={onLaunchTemplate}
          outerRadii={outerRadii}
          flushLeafChrome={flushLeafChrome}
        />
      )
    }

    return (
      <div
        key={node.id}
        data-split-id={node.id}
        style={{ display: 'flex', flexDirection: node.direction === 'horizontal' ? 'row' : 'column', flex: 1, minWidth: 0, minHeight: 0 }}
      >
        {node.children.map((child, i) => (
          <React.Fragment key={child.id}>
            <div style={{
              flexGrow: node.sizes[i],
              flexShrink: 1,
              flexBasis: 0,
              minWidth: node.direction === 'horizontal' ? getNodeMinWidth(child, getTileType) : 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              // No overflow:hidden here — the inner LeafPanel already clips its
              // own content, and hiding overflow on this flex-item wrapper was
              // dropping the LeafPanel's 1px bottom border on Chromium.
            }}>
              {renderNode(
                child,
                node.direction === 'horizontal'
                  ? {
                    top: outerEdges.top,
                    right: outerEdges.right && i === node.children.length - 1,
                    bottom: outerEdges.bottom,
                    left: outerEdges.left && i === 0,
                  }
                  : {
                    top: outerEdges.top && i === 0,
                    right: outerEdges.right,
                    bottom: outerEdges.bottom && i === node.children.length - 1,
                    left: outerEdges.left,
                  },
              )}
            </div>
            {i < node.children.length - 1 && (
              <ResizeHandle
                direction={node.direction}
                onInteractionChange={setPanelInteractionActive}
                onResize={delta => {
                  const el = document.querySelector(`[data-split-id="${node.id}"]`) as HTMLElement
                  const containerPx = el ? (node.direction === 'horizontal' ? el.clientWidth : el.clientHeight) : 800
                  const totalPx = Math.max(1, containerPx - (Math.max(0, node.children.length - 1) * PANEL_SPLIT_GUTTER_PX))
                  handleResize(node.id, i, delta, totalPx)
                }}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={layoutRootRef}
      data-codesurf-panel-layout=""
      style={{ position: 'absolute', top: 0, right: 0, bottom: insetBottom, left: 0, zIndex: 99990, background: 'transparent', display: 'flex', flexDirection: 'column', border: 'none' }}
      onMouseDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
    >
      {/* Panel tree */}
      <div style={{ flex: 1, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {renderNode(root, { top: true, right: true, bottom: true, left: true })}
      </div>

      {typeof document !== 'undefined' && createPortal(
        <>
          {panelInteractionActive && (
            <div
              data-codesurf-dock-shield=""
              style={{
                position: 'fixed',
                inset: 0,
                background: 'transparent',
                pointerEvents: 'auto',
                userSelect: 'none',
                cursor: 'grabbing',
                zIndex: 99995,
              }}
            />
          )}
          {ghost && (
            <div
              data-codesurf-dock-ghost=""
              style={{
                position: 'fixed', left: ghost.x + 12, top: ghost.y - 10,
                background: theme.surface.panelElevated, border: `1px solid ${theme.border.accent}`,
                borderRadius: 4, padding: '2px 10px', fontSize: fonts.secondarySize, color: theme.text.primary,
                pointerEvents: 'none', zIndex: 100000, userSelect: 'none',
              }}
            >
              {ghost.label}
            </div>
          )}
        </>,
        document.body,
      )}
    </div>
  )
}
