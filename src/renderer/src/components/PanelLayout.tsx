import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'

// ─── Panel tree types ────────────────────────────────────────────────────────

export interface PanelLeaf {
  type: 'leaf'
  id: string
  tabs: string[]
  activeTab: string
}

export interface PanelSplit {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: PanelNode[]
  sizes: number[]
}

export type PanelNode = PanelLeaf | PanelSplit

export type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

// ─── Panel element registry ───────────────────────────────────────────────────
// Mouse-event drag needs to know where each panel is on screen.
// Components register their DOM element here on mount.
const _panelElements = new Map<string, HTMLDivElement>()

function registerPanel(id: string, el: HTMLDivElement | null) {
  if (el) _panelElements.set(id, el)
  else _panelElements.delete(id)
}

function getLivePanelElement(panelId: string): HTMLDivElement | null {
  const el = _panelElements.get(panelId) ?? null
  if (!el) return null
  if (!el.isConnected) {
    _panelElements.delete(panelId)
    return null
  }
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return el
}

function getPanelAtPoint(x: number, y: number): string | null {
  let bestMatch: { id: string; area: number } | null = null
  for (const [id] of _panelElements) {
    const el = getLivePanelElement(id)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    const area = r.width * r.height
    if (!bestMatch || area < bestMatch.area) bestMatch = { id, area }
  }
  return bestMatch?.id ?? null
}

function getZone(x: number, y: number, panelId: string): DockZone {
  const el = getLivePanelElement(panelId)
  if (!el) return 'center'
  const r = el.getBoundingClientRect()
  const rx = (x - r.left) / r.width
  const ry = (y - r.top) / r.height
  const edge = 0.25
  if (rx < edge) return 'left'
  if (rx > 1 - edge) return 'right'
  if (ry < edge) return 'top'
  if (ry > 1 - edge) return 'bottom'
  return 'center'
}

function setWebviewsInteractionBlocked(blocked: boolean): void {
  if (typeof document === 'undefined') return
  // Block both webviews and iframes — both create independent pointer-event surfaces
  // that swallow mousemove/mouseup from the parent document during drags.
  document.querySelectorAll('webview, iframe').forEach(el => {
    ;(el as HTMLElement).style.pointerEvents = blocked ? 'none' : 'auto'
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let panelCounter = 0
export const newPanelId = (): string => `panel-${Date.now()}-${panelCounter++}`

export function createLeaf(tileIds: string[], activeTab?: string): PanelLeaf {
  return { type: 'leaf', id: newPanelId(), tabs: tileIds, activeTab: activeTab ?? tileIds[0] ?? '' }
}

export function findLeafByTileId(node: PanelNode, tileId: string): PanelLeaf | null {
  if (node.type === 'leaf') return node.tabs.includes(tileId) ? node : null
  for (const child of node.children) {
    const found = findLeafByTileId(child, tileId)
    if (found) return found
  }
  return null
}

export function findLeafById(node: PanelNode, panelId: string): PanelLeaf | null {
  if (node.type === 'leaf') return node.id === panelId ? node : null
  for (const child of node.children) {
    const found = findLeafById(child, panelId)
    if (found) return found
  }
  return null
}

export function getAllTileIds(node: PanelNode): string[] {
  if (node.type === 'leaf') return [...node.tabs]
  return node.children.flatMap(getAllTileIds)
}

function getNodeMinWidth(node: PanelNode, getTileType: (tileId: string) => string): number {
  if (node.type === 'leaf') {
    return node.tabs.some(tileId => getTileType(tileId) === 'chat') ? 360 : 0
  }
  const childWidths = node.children.map(child => getNodeMinWidth(child, getTileType))
  return node.direction === 'horizontal'
    ? childWidths.reduce((sum, width) => sum + width, 0)
    : Math.max(0, ...childWidths)
}

export function removeTileFromTree(node: PanelNode, tileId: string): PanelNode | null {
  if (node.type === 'leaf') {
    const newTabs = node.tabs.filter(id => id !== tileId)
    if (newTabs.length === 0) return null
    return { ...node, tabs: newTabs, activeTab: node.activeTab === tileId ? newTabs[0] : node.activeTab }
  }
  const newChildren: PanelNode[] = []
  const newSizes: number[] = []
  for (let i = 0; i < node.children.length; i++) {
    const result = removeTileFromTree(node.children[i], tileId)
    if (result) { newChildren.push(result); newSizes.push(node.sizes[i]) }
  }
  if (newChildren.length === 0) return null
  if (newChildren.length === 1) return newChildren[0]
  const total = newSizes.reduce((a, b) => a + b, 0)
  return { ...node, children: newChildren, sizes: newSizes.map(s => (s / total) * 100) }
}

export function addTabToLeaf(node: PanelNode, panelId: string, tileId: string): PanelNode {
  if (node.type === 'leaf') {
    if (node.id !== panelId) return node
    if (node.tabs.includes(tileId)) return { ...node, activeTab: tileId }
    return { ...node, tabs: [...node.tabs, tileId], activeTab: tileId }
  }
  return { ...node, children: node.children.map(c => addTabToLeaf(c, panelId, tileId)) }
}

export function setActiveTab(node: PanelNode, panelId: string, tileId: string): PanelNode {
  if (node.type === 'leaf') return node.id === panelId ? { ...node, activeTab: tileId } : node
  return { ...node, children: node.children.map(c => setActiveTab(c, panelId, tileId)) }
}

export function closeOthersInLeaf(root: PanelNode, panelId: string, keepId: string): PanelNode {
  const update = (n: PanelNode): PanelNode => {
    if (n.type === 'leaf') {
      if (n.id !== panelId) return n
      return { ...n, tabs: [keepId], activeTab: keepId }
    }
    return { ...n, children: n.children.map(update) }
  }
  return update(root)
}

export function closeToRightInLeaf(root: PanelNode, panelId: string, tileId: string): PanelNode {
  const update = (n: PanelNode): PanelNode => {
    if (n.type === 'leaf') {
      if (n.id !== panelId) return n
      const idx = n.tabs.indexOf(tileId)
      if (idx < 0) return n
      const newTabs = n.tabs.slice(0, idx + 1)
      return { ...n, tabs: newTabs, activeTab: newTabs.includes(n.activeTab) ? n.activeTab : tileId }
    }
    return { ...n, children: n.children.map(update) }
  }
  return update(root)
}

export function splitLeaf(node: PanelNode, targetPanelId: string, tileId: string, zone: DockZone): PanelNode {
  if (node.type === 'leaf') {
    if (node.id !== targetPanelId) return node
    if (zone === 'center') return addTabToLeaf(node, targetPanelId, tileId)
    const existingTabs = node.tabs.filter(id => id !== tileId)
    const existingLeaf: PanelLeaf = {
      ...node,
      tabs: existingTabs.length > 0 ? existingTabs : node.tabs,
      activeTab: existingTabs.length > 0 && node.activeTab === tileId ? existingTabs[0] : node.activeTab,
    }
    const newLeaf = createLeaf([tileId])
    const direction: 'horizontal' | 'vertical' = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
    const children: PanelNode[] = zone === 'left' || zone === 'top' ? [newLeaf, existingLeaf] : [existingLeaf, newLeaf]
    return { type: 'split', id: newPanelId(), direction, children, sizes: [50, 50] }
  }
  return { ...node, children: node.children.map(c => splitLeaf(c, targetPanelId, tileId, zone)) }
}

// ─── Dock Overlay ─────────────────────────────────────────────────────────────

function DockOverlay({ zone }: { zone: DockZone | null }): JSX.Element | null {
  const theme = useTheme()
  const fonts = useAppFonts()
  if (!zone) return null
  const styles: Record<DockZone, React.CSSProperties> = {
    left:   { position: 'absolute', left: 0, top: 0, width: '50%', height: '100%' },
    right:  { position: 'absolute', right: 0, top: 0, width: '50%', height: '100%' },
    top:    { position: 'absolute', left: 0, top: 0, width: '100%', height: '50%' },
    bottom: { position: 'absolute', left: 0, bottom: 0, width: '100%', height: '50%' },
    center: { position: 'absolute', inset: 0 },
  }
  return (
    <div style={{
      ...styles[zone],
      background: theme.surface.accentSoft,
      border: `2px solid ${theme.border.accent}`,
      borderRadius: 4,
      pointerEvents: 'none',
      zIndex: 10,
    }} />
  )
}

// ─── Resize Handle ────────────────────────────────────────────────────────────

function ResizeHandle({ direction, onResize, onInteractionChange }: { direction: 'horizontal' | 'vertical'; onResize: (delta: number) => void; onInteractionChange?: (active: boolean) => void }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const dragging = useRef(false)
  const lastPos = useRef(0)
  const isHorizontal = direction === 'horizontal'
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
        [isHorizontal ? 'width' : 'height']: 4,
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        background: 'transparent',
        position: 'relative',
        zIndex: 5,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = theme.surface.hover)}
      onMouseLeave={e => { if (!dragging.current) e.currentTarget.style.background = 'transparent' }}
    />
  )
}

// ─── Tab Bar ─────────────────────────────────────────────────────────────────

interface TabBarProps {
  tabs: { id: string; label: string }[]
  activeTab: string
  panelId: string
  onActivate: (tileId: string) => void
  onClose: (tileId: string) => void
  onTabMouseDown: (tileId: string, panelId: string, label: string, e: React.MouseEvent) => void
  onExit?: () => void
  getTileType: (tileId: string) => string
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
}

interface CtxMenu { tileId: string; tileType: string; x: number; y: number }

function TabBar({ tabs, activeTab, panelId, onActivate, onClose, onTabMouseDown, onExit, getTileType, onSplitNew, onCloseOthers, onCloseToRight }: TabBarProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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
      display: 'flex', alignItems: 'center', height: 34,
      background: theme.surface.panel, borderBottom: `1px solid ${theme.border.subtle}`,
      overflow: 'hidden', flexShrink: 0, zIndex: 1,
      padding: '0 8px',
    }}>
      {/* Scrollable tab strip */}
      <div ref={scrollRef} style={{
        display: 'flex', alignItems: 'center', gap: 4,
        flex: 1, overflowX: 'auto', overflowY: 'hidden',
        scrollbarWidth: 'none',
        padding: '0 0 1px',
      }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTab
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onMouseDown={e => {
                if (e.button !== 0) return
                e.preventDefault()
                e.stopPropagation()
                onTabMouseDown(tab.id, panelId, tab.label, e)
              }}
              onClick={() => onActivate(tab.id)}
              onContextMenu={e => {
                e.preventDefault()
                setCtxMenu({ tileId: tab.id, tileType: getTileType(tab.id), x: e.clientX, y: e.clientY })
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                height: 21,
                padding: '0 3px', margin: '0 5px', cursor: 'grab', userSelect: 'none',
                fontSize: 10, color: isActive ? theme.text.primary : theme.text.muted,
                background: 'transparent',
                border: '1px solid transparent',
                borderBottom: `1px solid ${isActive ? theme.accent.base : 'transparent'}`,
                marginBottom: 3,
                borderRadius: 0,
                transition: 'color 0.15s, border-color 0.15s',
                flexShrink: 0, maxWidth: 200,
                fontWeight: isActive ? 700 : 500,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  e.currentTarget.style.color = theme.text.secondary
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  e.currentTarget.style.color = theme.text.muted
                }
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {tab.label}
              </span>
              <span
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onClose(tab.id) }}
                style={{ width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, lineHeight: 1, color: isActive ? theme.text.secondary : theme.text.disabled, flexShrink: 0, cursor: 'pointer', transition: 'color 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                onMouseLeave={e => { e.currentTarget.style.color = isActive ? theme.text.secondary : theme.text.disabled }}
              >
                ×
              </span>
            </div>
          )
        })}
      </div>


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
  const fonts = useAppFonts()
  return <div style={{ height: 1, background: theme.border.default, margin: '3px 0' }} />
}

// ─── Empty Panel ─────────────────────────────────────────────────────────────

type QuickAction = { type: string; label: string; icon: JSX.Element }

const CORE_ACTIONS: QuickAction[] = [
  { type: 'terminal', label: 'Terminal', icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M5 8l7 6-7 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M14 20h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg> },
  { type: 'code',     label: 'Code',     icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M10 8L4 14l6 6M18 8l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  { type: 'browser',  label: 'Browser',  icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="3" y="5" width="22" height="18" rx="2.5" stroke="currentColor" strokeWidth="2" /><path d="M3 10h22" stroke="currentColor" strokeWidth="2" /><circle cx="6.5" cy="7.5" r="1" fill="currentColor" /><circle cx="9.5" cy="7.5" r="1" fill="currentColor" /></svg> },
  { type: 'chat',     label: 'Chat',     icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M4 5h20a2 2 0 012 2v11a2 2 0 01-2 2H10l-5 4V20H4a2 2 0 01-2-2V7a2 2 0 012-2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg> },
  { type: 'files',    label: 'Files',    icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M3 6.5C3 5.12 4.12 4 5.5 4h5L13 6.5h9.5C23.88 6.5 25 7.62 25 9v13c0 1.38-1.12 2.5-2.5 2.5h-17C4.12 24.5 3 23.38 3 22V6.5z" stroke="currentColor" strokeWidth="2" fill="none" /><path d="M9 13h10M9 17h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" /></svg> },
]

const EXTENSION_ACTIONS: QuickAction[] = [
  { type: 'note',     label: 'Sticky Note', icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="3" y="3" width="22" height="22" rx="2" stroke="currentColor" strokeWidth="2" /><path d="M18 25V20a2 2 0 012-2h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M8 10h12M8 14h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" /></svg> },
  { type: 'kanban',   label: 'Board',      icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="3" y="3" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" /><rect x="16" y="3" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" /><rect x="3" y="16" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" /><rect x="16" y="16" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" /></svg> },
  { type: 'note',     label: 'Markdown',   icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="2" y="6" width="24" height="16" rx="2" stroke="currentColor" strokeWidth="2" /><path d="M6 18V10l4 5 4-5v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M20 14l3 3m0 0l-3-3m3 3v-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  { type: 'ext:pomodoro', label: 'Pomodoro', icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="15" r="10" stroke="currentColor" strokeWidth="2" /><path d="M14 9v6l4 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M11 5h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg> },
  { type: 'ext:system-monitor', label: 'System', icon: <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="3" y="5" width="22" height="16" rx="2" stroke="currentColor" strokeWidth="2" /><path d="M10 24h8M14 21v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M7 15l3-4 3 2 4-5 4 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg> },
]

function TileButton({ action, theme, onAddTile }: { action: QuickAction; theme: ReturnType<typeof useTheme>; onAddTile: (type: string) => void }): JSX.Element {
  return (
    <button
      onClick={() => onAddTile(action.type)}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 8, width: 80, height: 80,
        background: theme.surface.panelElevated, border: `1px solid ${theme.border.default}`,
        borderRadius: 14, color: theme.text.muted, fontSize: 'inherit', fontWeight: 500,
        cursor: 'pointer', transition: 'all 0.15s ease',
        letterSpacing: 0.3,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = theme.surface.hover
        e.currentTarget.style.borderColor = theme.border.accent
        e.currentTarget.style.color = theme.accent.base
        e.currentTarget.style.transform = 'translateY(-2px)'
        e.currentTarget.style.boxShadow = `0 4px 12px ${theme.mode === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.3)'}`
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = theme.surface.panelElevated
        e.currentTarget.style.borderColor = theme.border.default
        e.currentTarget.style.color = theme.text.muted
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {action.icon}
      {action.label}
    </button>
  )
}

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
  getTileLabel: (tileId: string) => string
  renderTile: (tileId: string, options?: { isInteracting?: boolean }) => React.ReactNode
  isInteracting: boolean
  onActivate: (panelId: string, tileId: string) => void
  onCloseTab: (tileId: string) => void
  onTabMouseDown: (tileId: string, panelId: string, label: string, e: React.MouseEvent) => void
  onPanelFocus: (panelId: string) => void
  onAddTile: (type: string) => void
  dragTarget: { panelId: string; zone: DockZone } | null
  onExit: () => void
  getTileType: (tileId: string) => string
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
  onLaunchTemplate?: (template: import('../../../shared/types').LayoutTemplate) => void
}

function LeafPanel({ leaf, getTileLabel, renderTile, isInteracting, onActivate, onCloseTab, onTabMouseDown, onPanelFocus, onAddTile, dragTarget, onExit, getTileType, onSplitNew, onCloseOthers, onCloseToRight, onLaunchTemplate }: LeafPanelProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const keepMountedWhenInactive = useCallback((tileId: string) => {
    const type = getTileType(tileId)
    return type === 'terminal' || type === 'browser' || type === 'chat' || type.startsWith('ext:')
  }, [getTileType])
  const panelRef = useRef<HTMLDivElement>(null)
  const tabs = leaf.tabs.map(id => ({ id, label: getTileLabel(id) }))
  const isEmpty = tabs.length === 0
  const dockZone = dragTarget?.panelId === leaf.id ? dragTarget.zone : null

  useEffect(() => {
    const el = panelRef.current
    registerPanel(leaf.id, el)
    return () => { registerPanel(leaf.id, null) }
  }, [leaf.id])

  return (
    <div
      ref={panelRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        borderRadius: 12,
        overflow: 'hidden',
        background: theme.surface.panel,
        border: `1px solid ${theme.border.default}`,
      }}
      onClick={() => onPanelFocus(leaf.id)}
    >
      {!isEmpty && (
        <TabBar
          tabs={tabs}
          activeTab={leaf.activeTab}
          panelId={leaf.id}
          onActivate={tileId => onActivate(leaf.id, tileId)}
          onClose={onCloseTab}
          onTabMouseDown={onTabMouseDown}
          onExit={onExit}
          getTileType={getTileType}
          onSplitNew={onSplitNew}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
        />
      )}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
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
                {renderTile(tileId, { isInteracting })}
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
  renderTile: (tileId: string, options?: { isInteracting?: boolean }) => React.ReactNode
  onLayoutChange: (newRoot: PanelNode) => void
  onCloseTab: (tileId: string) => void
  onAddTile: (type: string) => void
  onExit: () => void
  activePanelId: string | null
  onActivePanelChange: (panelId: string) => void
  getTileType: (tileId: string) => string
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
  insetBottom?: number
  onLaunchTemplate?: (template: import('../../../shared/types').LayoutTemplate) => void
}

export function PanelLayout({ root, getTileLabel, renderTile, onLayoutChange, onCloseTab, onAddTile, onExit, activePanelId: _activePanelId, onActivePanelChange, getTileType, onSplitNew, onCloseOthers, onCloseToRight, insetBottom = 4, onLaunchTemplate }: PanelLayoutProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [dragTarget, setDragTarget] = useState<{ panelId: string; zone: DockZone } | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [panelInteractionActive, setPanelInteractionActive] = useState(false)
  const handleDockRef = useRef<(tileId: string, fromPanelId: string, targetPanelId: string, zone: DockZone) => void>(() => {})

  useEffect(() => {
    return () => setWebviewsInteractionBlocked(false)
  }, [])

  const handleActivate = useCallback((panelId: string, tileId: string) => {
    onActivePanelChange(panelId)
    onLayoutChange(setActiveTab(root, panelId, tileId))
  }, [root, onLayoutChange, onActivePanelChange])

  const handleDock = useCallback((tileId: string, fromPanelId: string, targetPanelId: string, zone: DockZone) => {
    if (fromPanelId === targetPanelId && zone === 'center') return

    if (fromPanelId === targetPanelId) {
      onLayoutChange(splitLeaf(root, targetPanelId, tileId, zone))
      return
    }

    let updated = removeTileFromTree(root, tileId) ?? createLeaf([tileId])
    updated = splitLeaf(updated, targetPanelId, tileId, zone)
    onLayoutChange(updated)
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

      const panelId = getPanelAtPoint(ev.clientX, ev.clientY)
      if (panelId) {
        setDragTarget({ panelId, zone: getZone(ev.clientX, ev.clientY, panelId) })
      } else {
        setDragTarget(null)
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

      const targetPanelId = getPanelAtPoint(ev.clientX, ev.clientY)
      if (!targetPanelId) return
      const zone = getZone(ev.clientX, ev.clientY, targetPanelId)
      handleDockRef.current(tileId, fromPanelId, targetPanelId, zone)
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

  const renderNode = (node: PanelNode): React.ReactNode => {
    if (node.type === 'leaf') {
      return (
        <LeafPanel
          key={node.id}
          leaf={node}
          getTileLabel={getTileLabel}
          renderTile={renderTile}
          isInteracting={panelInteractionActive}
          onActivate={handleActivate}
          onCloseTab={onCloseTab}
          onTabMouseDown={handleTabMouseDown}
          onPanelFocus={onActivePanelChange}
          onAddTile={onAddTile}
          dragTarget={dragTarget}
          onExit={onExit}
          getTileType={getTileType}
          onSplitNew={onSplitNew}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
          onLaunchTemplate={onLaunchTemplate}
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
              flex: `0 0 ${node.sizes[i]}%`,
              width: node.direction === 'horizontal' ? `${node.sizes[i]}%` : undefined,
              height: node.direction === 'vertical' ? `${node.sizes[i]}%` : undefined,
              minWidth: node.direction === 'horizontal' ? getNodeMinWidth(child, getTileType) : 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}>
              {renderNode(child)}
            </div>
            {i < node.children.length - 1 && (
              <ResizeHandle
                direction={node.direction}
                onInteractionChange={setPanelInteractionActive}
                onResize={delta => {
                  const el = document.querySelector(`[data-split-id="${node.id}"]`) as HTMLElement
                  const totalPx = el ? (node.direction === 'horizontal' ? el.clientWidth : el.clientHeight) : 800
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
      style={{ position: 'absolute', top: 0, right: 6, bottom: insetBottom, left: 4, zIndex: 99990, background: 'transparent', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: 'none' }}
      onMouseDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
    >
      {/* Panel tree */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {renderNode(root)}
      </div>

      {panelInteractionActive && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'transparent',
            pointerEvents: 'auto',
            userSelect: 'none',
            zIndex: 99995,
          }}
        />
      )}

      {/* Drag ghost — follows cursor */}
      {ghost && (
        <div style={{
          position: 'fixed', left: ghost.x + 12, top: ghost.y - 10,
          background: theme.surface.panelElevated, border: `1px solid ${theme.border.accent}`,
          borderRadius: 4, padding: '2px 10px', fontSize: fonts.secondarySize, color: theme.text.primary,
          pointerEvents: 'none', zIndex: 100000, userSelect: 'none',
        }}>
          {ghost.label}
        </div>
      )}
    </div>
  )
}
