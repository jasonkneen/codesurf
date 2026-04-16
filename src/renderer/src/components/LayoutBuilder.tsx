import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import { useLayoutTemplates } from '../hooks/useLayoutTemplates'
import type { LayoutTemplate, LayoutTemplateNode, LayoutTemplateSlot, TileType } from '../../../shared/types'


// ─── Tile definitions ────────────────────────────────────────────────────────

const TILE_DEFS: Array<{ type: string; label: string; icon: JSX.Element; disabled?: boolean }> = [
  { type: 'terminal', label: 'Terminal', icon: <svg width="22" height="22" viewBox="0 0 28 28" fill="none"><path d="M5 8l7 6-7 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M14 20h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg> },
  { type: 'code', label: 'Code', icon: <svg width="22" height="22" viewBox="0 0 28 28" fill="none"><path d="M10 8L4 14l6 6M18 8l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  { type: 'browser', label: 'Browser', icon: <svg width="22" height="22" viewBox="0 0 28 28" fill="none"><rect x="3" y="5" width="22" height="18" rx="2.5" stroke="currentColor" strokeWidth="2" /><path d="M3 10h22" stroke="currentColor" strokeWidth="2" /></svg> },
  { type: 'chat', label: 'Chat', icon: <svg width="22" height="22" viewBox="0 0 28 28" fill="none"><path d="M4 5h20a2 2 0 012 2v11a2 2 0 01-2 2H10l-5 4V20H4a2 2 0 01-2-2V7a2 2 0 012-2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg> },
  { type: 'files', label: 'Files', icon: <svg width="22" height="22" viewBox="0 0 28 28" fill="none"><path d="M3 6.5C3 5.12 4.12 4 5.5 4h5L13 6.5h9.5C23.88 6.5 25 7.62 25 9v13c0 1.38-1.12 2.5-2.5 2.5h-17C4.12 24.5 3 23.38 3 22V6.5z" stroke="currentColor" strokeWidth="2" /></svg> },
  { type: 'note', label: 'Note', icon: <svg width="22" height="22" viewBox="0 0 28 28" fill="none"><rect x="3" y="3" width="22" height="22" rx="2" stroke="currentColor" strokeWidth="2" /><path d="M8 10h12M8 14h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" /></svg> },
  { type: 'kanban', label: 'Board', disabled: true, icon: <svg width="22" height="22" viewBox="0 0 28 28" fill="none"><rect x="3" y="3" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" /><rect x="16" y="3" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" /><rect x="3" y="16" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" /><rect x="16" y="16" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" /></svg> },
  { type: 'ext:artifact-builder', label: 'Artifact', disabled: true, icon: <svg width="22" height="22" viewBox="0 0 28 28" fill="none"><path d="M6 4h16a2 2 0 012 2v16a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2z" stroke="currentColor" strokeWidth="2" /><path d="M8 12l4 4 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" /></svg> },
]

const TYPE_LABELS: Record<string, string> = {
  terminal: 'Terminal', code: 'Code', browser: 'Browser', chat: 'Chat',
  files: 'Files', note: 'Note', kanban: 'Board',
}

const TILE_COLORS: Record<string, string> = {
  terminal: '#56c288', code: '#3178c6', browser: '#e34c26',
  chat: '#7aa2ff', files: '#c09a5c', note: '#f7df1e', kanban: '#8f96a0',
}

// ─── Zone detection ──────────────────────────────────────────────────────────

type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

function getZone(rect: DOMRect, x: number, y: number): DockZone {
  const rx = (x - rect.left) / rect.width
  const ry = (y - rect.top) / rect.height
  if (rx < 0.25) return 'left'
  if (rx > 0.75) return 'right'
  if (ry < 0.25) return 'top'
  if (ry > 0.75) return 'bottom'
  return 'center'
}

// ─── Tree operations ─────────────────────────────────────────────────────────

function addToTree(tree: LayoutTemplateNode | null, tileType: string, zone: DockZone): LayoutTemplateNode {
  const newLeaf: LayoutTemplateNode = { type: 'leaf', slots: [{ tileType: tileType as TileType }] }
  if (!tree) return newLeaf
  if (zone === 'center') {
    if (tree.type === 'leaf') return { ...tree, slots: [...tree.slots, { tileType: tileType as TileType }] }
    const children = [...tree.children]
    children[0] = addToTree(children[0], tileType, 'center')
    return { ...tree, children }
  }
  const dir: 'horizontal' | 'vertical' = (zone === 'left' || zone === 'right') ? 'horizontal' : 'vertical'
  const first = (zone === 'left' || zone === 'top') ? newLeaf : tree
  const second = (zone === 'left' || zone === 'top') ? tree : newLeaf
  return { type: 'split', direction: dir, children: [first, second], sizes: [50, 50] }
}

// Remove a tile type from a tree, collapsing empty nodes
function removeFromTree(tree: LayoutTemplateNode, tileType: string): LayoutTemplateNode | null {
  if (tree.type === 'leaf') {
    const remaining = tree.slots.filter(s => s.tileType !== tileType)
    return remaining.length > 0 ? { ...tree, slots: remaining } : null
  }
  const children = tree.children.map(c => removeFromTree(c, tileType)).filter(Boolean) as LayoutTemplateNode[]
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...tree, children, sizes: children.map(() => Math.round(100 / children.length)) }
}

// Update sizes at a split node identified by path
function updateSizesAtPath(tree: LayoutTemplateNode, path: number[], sizes: number[]): LayoutTemplateNode {
  if (path.length === 0 && tree.type === 'split') {
    return { ...tree, sizes }
  }
  if (tree.type !== 'split') return tree
  const [idx, ...rest] = path
  const children = [...tree.children]
  children[idx] = updateSizesAtPath(children[idx], rest, sizes)
  return { ...tree, children }
}

// Add to a specific leaf in the tree (identified by path index)
function addToLeafAt(tree: LayoutTemplateNode, leafPath: number[], tileType: string, zone: DockZone): LayoutTemplateNode {
  if (leafPath.length === 0) return addToTree(tree, tileType, zone)
  if (tree.type === 'leaf') return addToTree(tree, tileType, zone)
  const [idx, ...rest] = leafPath
  const children = [...tree.children]
  if (rest.length === 0) {
    // Target this child
    const child = children[idx]
    if (zone === 'center' && child.type === 'leaf') {
      children[idx] = { ...child, slots: [...child.slots, { tileType: tileType as TileType }] }
    } else {
      children[idx] = addToTree(child, tileType, zone)
    }
  } else {
    children[idx] = addToLeafAt(children[idx], rest, tileType, zone)
  }
  return { ...tree, children }
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  onAddTile: (type: string) => void
  onLaunchTemplate?: (template: LayoutTemplate) => void
}

// ─── Interactive Tree Preview (drag source + drop target per leaf) ───────────

function InteractiveTree({ node, path, onDropOnLeaf, onDragLeaf, hoverPath, hoverZone, isEditing, onRemoveLeaf, onResizeSplit }: {
  node: LayoutTemplateNode
  path: number[]
  onDropOnLeaf: (path: number[], zone: DockZone) => void
  onDragLeaf: (tileType: string, fromPath: number[]) => void
  hoverPath: number[] | null
  hoverZone: DockZone | null
  isEditing?: boolean
  onRemoveLeaf?: (tileType: string) => void
  onResizeSplit?: (path: number[], sizes: number[]) => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const isHovered = hoverPath && hoverPath.length === path.length && hoverPath.every((v, i) => v === path[i])
  const containerRef = useRef<HTMLDivElement>(null)
  const isHoriz = node.type === 'split' ? node.direction === 'horizontal' : false

  const handleDividerDrag = useCallback((dividerIndex: number, e: React.MouseEvent) => {
    if (!isEditing || !onResizeSplit || !containerRef.current || node.type !== 'split') return
    e.preventDefault()
    e.stopPropagation()
    const container = containerRef.current
    const startPos = isHoriz ? e.clientX : e.clientY
    const rect = container.getBoundingClientRect()
    const totalSize = isHoriz ? rect.width : rect.height
    const startSizes = [...(node.sizes ?? node.children.map(() => Math.round(100 / node.children.length)))]

    const onMove = (ev: MouseEvent) => {
      const delta = ((isHoriz ? ev.clientX : ev.clientY) - startPos) / totalSize * 100
      const newSizes = [...startSizes]
      const minPct = 15
      newSizes[dividerIndex] = Math.max(minPct, startSizes[dividerIndex] + delta)
      newSizes[dividerIndex + 1] = Math.max(minPct, startSizes[dividerIndex + 1] - delta)
      const sum = newSizes.reduce((a, b) => a + b, 0)
      onResizeSplit!(path, newSizes.map(s => Math.round(s / sum * 100)))
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [isEditing, onResizeSplit, path, node, isHoriz])

  if (node.type === 'leaf') {
    const slot = node.slots[0]
    return (
      <div
        data-leaf-path={path.join(',')}
        style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 2,
          background: theme.surface.panelMuted,
          minHeight: 24, borderRadius: 0,
          padding: 4, position: 'relative',
          cursor: isEditing ? 'grab' : 'default',
        }}
        onMouseDown={e => {
          if (!isEditing) return
          e.stopPropagation()
          if (slot) onDragLeaf(slot.tileType, path)
        }}
      >
        <span style={{ fontSize: Math.max(10, fonts.size - 2), color: theme.text.secondary, fontWeight: 700 }}>{TYPE_LABELS[slot?.tileType] ?? '?'}</span>
        {node.slots.length > 1 && <span style={{ fontSize: Math.max(8, fonts.secondarySize - 2), color: theme.text.disabled, fontWeight: 600 }}>+{node.slots.length - 1}</span>}
        {/* Remove button */}
        {isEditing && onRemoveLeaf && slot && (
          <button
            onClick={e => { e.stopPropagation(); onRemoveLeaf(slot.tileType) }}
            onMouseDown={e => e.stopPropagation()}
            style={{
              position: 'absolute', top: 2, right: 2,
              width: 12, height: 12, borderRadius: 3, border: 'none',
              background: 'rgba(0,0,0,0.25)', color: '#fff',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: Math.max(8, fonts.secondarySize - 2), opacity: 0.6, zIndex: 2,
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = theme.status.danger }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.background = 'rgba(0,0,0,0.25)' }}
          >x</button>
        )}
        {/* Zone overlay */}
        {isHovered && hoverZone && (
          <div style={{
            position: 'absolute',
            ...(hoverZone === 'left' ? { left: 0, top: 0, bottom: 0, width: '30%' } :
               hoverZone === 'right' ? { right: 0, top: 0, bottom: 0, width: '30%' } :
               hoverZone === 'top' ? { left: 0, top: 0, right: 0, height: '30%' } :
               hoverZone === 'bottom' ? { left: 0, bottom: 0, right: 0, height: '30%' } :
               { inset: 0 }),
            background: `${theme.accent.base}30`,
            border: `1.5px solid ${theme.accent.base}`,
            borderRadius: 2, pointerEvents: 'none',
          }} />
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1, display: 'flex',
        flexDirection: isHoriz ? 'row' : 'column',
        minHeight: 24, height: '100%',
      }}
    >
      {node.children.map((child, i) => (
        <React.Fragment key={i}>
          {i > 0 && isEditing && (
            <div
              onMouseDown={e => handleDividerDrag(i - 1, e)}
              style={{
                flexShrink: 0,
                width: isHoriz ? 8 : '100%',
                height: isHoriz ? '100%' : 8,
                cursor: isHoriz ? 'col-resize' : 'row-resize',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 3,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = theme.accent.soft }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{
                width: isHoriz ? 3 : 16,
                height: isHoriz ? 16 : 3,
                borderRadius: 999,
                background: theme.text.disabled,
                opacity: 0.95,
              }} />
            </div>
          )}
          {!isEditing && i > 0 && <div style={{ flexShrink: 0, width: isHoriz ? 2 : '100%', height: isHoriz ? '100%' : 2, background: theme.text.disabled, opacity: 0.95 }} />}
          <div style={{ flex: node.sizes?.[i] ?? 1, display: 'flex', minWidth: 0, minHeight: 0 }}>
            <InteractiveTree
              node={child}
              path={[...path, i]}
              onDropOnLeaf={onDropOnLeaf}
              onDragLeaf={onDragLeaf}
              hoverPath={hoverPath}
              hoverZone={hoverZone}
              isEditing={isEditing}
              onRemoveLeaf={onRemoveLeaf}
              onResizeSplit={onResizeSplit}
            />
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

// ─── Mini preview for saved templates ────────────────────────────────────────

function MiniPreview({ node }: { node: LayoutTemplateNode }): JSX.Element {
  const theme = useTheme()
  const dividerColor = theme.border.strong
  if (node.type === 'leaf') {
    const tileColor = TILE_COLORS[node.slots[0]?.tileType] ?? theme.text.disabled
    return <div style={{ flex: 1, minHeight: 6, background: `${tileColor}20`, borderRadius: 1 }} />
  }
  const isHoriz = node.direction === 'horizontal'
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: isHoriz ? 'row' : 'column' }}>
      {node.children.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <div style={{
              flexShrink: 0,
              width: isHoriz ? 2 : '100%',
              height: isHoriz ? '100%' : 2,
              background: dividerColor,
              opacity: 0.95,
            }} />
          )}
          <MiniPreview node={c} />
        </React.Fragment>
      ))}
    </div>
  )
}

// ─── Main LayoutBuilder ─────────────────────────────────────────────────────


// ─── Main LayoutBuilder ─────────────────────────────────────────────────────

export function LayoutBuilder({ onAddTile, onLaunchTemplate }: Props): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const { templates, addTemplate, updateTemplate, deleteTemplate } = useLayoutTemplates()

  const [cards, setCards] = useState<Array<{ tree: LayoutTemplateNode | null; name: string }>>(
    Array.from({ length: 8 }, () => ({ tree: null, name: '' }))
  )

  // Drag state — either from picker or from within a card
  const [dragType, setDragType] = useState<string | null>(null)
  const [dragFrom, setDragFrom] = useState<{ cardIdx: number; path: number[] } | null>(null)
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  const [hoverCard, setHoverCard] = useState<number | null>(null)
  const [hoverLeafPath, setHoverLeafPath] = useState<number[] | null>(null)
  const [hoverZone, setHoverZone] = useState<DockZone | null>(null)
  const [hoveredLayoutCard, setHoveredLayoutCard] = useState<number | null>(null)

  // Load saved templates into cards on first load
  const loadedRef = useRef(false)
  if (!loadedRef.current && templates.length > 0) {
    loadedRef.current = true
    const padded = Math.max(8, Math.ceil(templates.length / 8) * 8)
    setTimeout(() => setCards(() => {
      const next = Array.from({ length: padded }, (_, i) => {
        const t = templates[i]
        return t ? { tree: t.tree, name: t.name } : { tree: null, name: '' }
      })
      return next
    }), 0)
  }

  // Auto-save cards to templates (debounced)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  useEffect(() => {
    if (!loadedRef.current) return
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(async () => {
      const currentCards = cardsRef.current
      const existingIds = templates.map(t => t.id)
      for (let i = 0; i < currentCards.length; i++) {
        const card = currentCards[i]
        const existingTemplate = templates[i]
        if (card.tree) {
          if (existingTemplate) {
            if (JSON.stringify(existingTemplate.tree) !== JSON.stringify(card.tree) || existingTemplate.name !== card.name) {
              await updateTemplate(existingTemplate.id, { tree: card.tree, name: card.name.trim() || `Layout ${i + 1}` })
            }
          } else {
            await addTemplate({ id: `layout-${Date.now()}-${i}`, name: card.name.trim() || `Layout ${i + 1}`, created_at: new Date().toISOString(), tree: card.tree })
          }
        } else if (existingTemplate) {
          await deleteTemplate(existingTemplate.id)
        }
      }
    }, 800)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
  }, [cards])

  // ── Global drag handlers ──

  const startDrag = useCallback((type: string, e: React.MouseEvent, fromCard?: number, fromPath?: number[]) => {
    e.preventDefault()
    e.stopPropagation()
    setDragType(type)
    setDragFrom(fromCard !== undefined && fromPath ? { cardIdx: fromCard, path: fromPath } : null)
    setDragPos({ x: e.clientX, y: e.clientY })

    const onMove = (ev: MouseEvent) => {
      setDragPos({ x: ev.clientX, y: ev.clientY })

      // Find card under cursor
      let foundCard: number | null = null
      let foundLeafPath: number[] | null = null
      let foundZone: DockZone = 'center'

      // Check leaf elements first (more specific)
      const leafEls = document.querySelectorAll<HTMLDivElement>('[data-leaf-path]')
      leafEls.forEach(el => {
        const rect = el.getBoundingClientRect()
        if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          // Find which card this leaf belongs to
          const cardEl = el.closest<HTMLDivElement>('[data-layout-card]')
          if (cardEl) {
            foundCard = parseInt(cardEl.dataset.layoutCard!, 10)
            foundLeafPath = el.dataset.leafPath!.split(',').map(Number)
            foundZone = getZone(rect, ev.clientX, ev.clientY)
          }
        }
      })

      // If not on a leaf, check card level
      if (foundCard === null) {
        const cardEls = document.querySelectorAll<HTMLDivElement>('[data-layout-card]')
        cardEls.forEach(el => {
          const rect = el.getBoundingClientRect()
          if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
            foundCard = parseInt(el.dataset.layoutCard!, 10)
            foundZone = getZone(rect, ev.clientX, ev.clientY)
          }
        })
      }

      setHoverCard(foundCard)
      setHoverLeafPath(foundLeafPath)
      setHoverZone(foundCard !== null ? foundZone : null)
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)

      // Find drop target
      let targetCard: number | null = null
      let targetLeafPath: number[] | null = null
      let targetZone: DockZone = 'center'

      const leafEls = document.querySelectorAll<HTMLDivElement>('[data-leaf-path]')
      leafEls.forEach(el => {
        const rect = el.getBoundingClientRect()
        if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          const cardEl = el.closest<HTMLDivElement>('[data-layout-card]')
          if (cardEl) {
            targetCard = parseInt(cardEl.dataset.layoutCard!, 10)
            targetLeafPath = el.dataset.leafPath!.split(',').map(Number)
            targetZone = getZone(rect, ev.clientX, ev.clientY)
          }
        }
      })

      if (targetCard === null) {
        const cardEls = document.querySelectorAll<HTMLDivElement>('[data-layout-card]')
        cardEls.forEach(el => {
          const rect = el.getBoundingClientRect()
          if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
            targetCard = parseInt(el.dataset.layoutCard!, 10)
            targetZone = getZone(rect, ev.clientX, ev.clientY)
          }
        })
      }

      if (targetCard !== null && type) {
        setCards(prev => {
          const next = [...prev]

          // If dragging from within a card, remove from source first
          if (fromCard !== undefined && fromPath) {
            const srcCard = next[fromCard]
            if (srcCard.tree) {
              const cleaned = removeFromTree(srcCard.tree, type)
              next[fromCard] = { ...srcCard, tree: cleaned }
            }
          }

          // Add to target
          const card = next[targetCard!]
          if (targetLeafPath && card.tree) {
            next[targetCard!] = { ...card, tree: addToLeafAt(card.tree, targetLeafPath, type, targetZone) }
          } else {
            next[targetCard!] = { ...card, tree: addToTree(card.tree, type, card.tree ? targetZone : 'center') }
          }
          return next
        })
      }

      setDragType(null)
      setDragFrom(null)
      setDragPos(null)
      setHoverCard(null)
      setHoverLeafPath(null)
      setHoverZone(null)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const CARDS_PER_PAGE = 8
  const totalPages = Math.max(1, Math.ceil(cards.length / CARDS_PER_PAGE))
  const [currentPage, setCurrentPage] = useState(0)
  const pageStart = currentPage * CARDS_PER_PAGE
  const pageCards = cards.slice(pageStart, pageStart + CARDS_PER_PAGE)

  // Add a new page if all cards on the last page have content
  const addPageIfNeeded = useCallback(() => {
    const lastPageStart = (totalPages - 1) * CARDS_PER_PAGE
    const lastPageCards = cards.slice(lastPageStart, lastPageStart + CARDS_PER_PAGE)
    if (lastPageCards.every(c => c.tree !== null)) {
      setCards(prev => [...prev, ...Array.from({ length: CARDS_PER_PAGE }, () => ({ tree: null, name: '' }))])
    }
  }, [cards, totalPages])

  const clearCard = useCallback((idx: number) => {
    setCards(prev => { const n = [...prev]; n[idx] = { tree: null, name: '' }; return n })
  }, [])

  const buildAndLaunch = useCallback((idx: number) => {
    const card = cards[idx]
    if (!card.tree || !onLaunchTemplate) return
    onLaunchTemplate({ id: `layout-${Date.now()}`, name: card.name.trim() || `Layout ${idx + 1}`, created_at: new Date().toISOString(), tree: card.tree })
  }, [cards, onLaunchTemplate])



  // Grid: 0-2 top, 3=left, CENTER, 4=right, 5-7 bottom (relative to page)
  const GRID_MAP = [0, 1, 2, 3, -1, 4, 5, 6, 7]

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: [
        `radial-gradient(circle at 50% 8%, ${theme.accent.base}40 0%, transparent 38%)`,
        `radial-gradient(circle at 14% 22%, ${theme.accent.base}24 0%, transparent 30%)`,
        `radial-gradient(circle at 86% 24%, ${theme.accent.base}20 0%, transparent 32%)`,
        `radial-gradient(circle at 24% 82%, ${theme.accent.soft}18 0%, transparent 28%)`,
        `radial-gradient(circle at 76% 80%, ${theme.accent.soft}1e 0%, transparent 30%)`,
        `radial-gradient(circle at 50% 76%, ${theme.accent.soft}2c 0%, transparent 44%)`,
        `linear-gradient(180deg, ${theme.accent.soft}24 0%, transparent 46%)`,
        theme.surface.panelMuted,
      ].join(', '),
      overflow: 'auto', padding: 20,
    }}>
      <div style={{ width: '100%', maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>


        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gridTemplateRows: 'repeat(3, auto)',
          gap: 10, width: '100%',
        }}>
          {GRID_MAP.map((relIdx, gridPos) => {
            if (relIdx === -1) {
              // Center: tile picker
              return (
                <div key="center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 8 }}>
                  <span style={{ fontSize: Math.max(11, fonts.secondarySize), fontWeight: 700, color: theme.text.secondary, letterSpacing: 1.2, textTransform: 'uppercase' }}>Blocks</span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 56px)', gap: 6, justifyContent: 'center', maxWidth: '100%' }}>
                    {TILE_DEFS.map(def => (
                      <div key={def.type} onMouseDown={def.disabled ? undefined : e => startDrag(def.type, e)} style={{
                        width: 56, height: 52, borderRadius: 10,
                        background: theme.surface.panelElevated, border: `1px solid ${theme.text.disabled}`,
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        gap: 2, cursor: def.disabled ? 'not-allowed' : 'grab', color: def.disabled ? theme.text.disabled : theme.text.muted, fontSize: Math.max(10, fonts.secondarySize - 1), fontWeight: 500,
                        userSelect: 'none', transition: 'all 0.12s ease', opacity: def.disabled ? 0.45 : 1,
                      }}
                        onMouseEnter={e => {
                          if (def.disabled) return
                          e.currentTarget.style.borderColor = theme.border.accent; e.currentTarget.style.color = theme.accent.base
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.borderColor = theme.text.disabled; e.currentTarget.style.color = def.disabled ? theme.text.disabled : theme.text.muted
                        }}
                        title={def.disabled ? `${def.label} disabled` : def.label}
                      >
                        {def.icon}{def.label}
                      </div>
                    ))}
                  </div>
                </div>
              )
            }

            const cardIdx = pageStart + relIdx
            const card = cards[cardIdx] ?? { tree: null, name: '' }
            const isEmpty = card.tree === null
            const isCardHovered = hoverCard === cardIdx && dragType !== null
            const isEditing = true

            return (
              <div
                key={cardIdx}
                onMouseEnter={() => setHoveredLayoutCard(cardIdx)}
                onMouseLeave={() => setHoveredLayoutCard(current => (current === cardIdx ? null : current))}
                style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                {/* Header: name + edit + delete */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 2px 2px' }}>
                  {isEmpty ? (
                    <span style={{ flex: 1, fontSize: Math.max(12, fonts.size - 1), fontWeight: 700, color: theme.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', visibility: 'hidden' }}>
                      Untitled
                    </span>
                  ) : (
                    <input value={card.name} onChange={e => setCards(prev => { const n = [...prev]; n[cardIdx] = { ...n[cardIdx], name: e.target.value }; return n })}
                      placeholder="Click to name..."
                      style={{ flex: 1, padding: '3px 7px', fontSize: Math.max(11, fonts.size - 1), borderRadius: 4, background: 'transparent', color: theme.text.primary, border: '1px solid transparent', outline: 'none', fontFamily: 'inherit', minWidth: 0, fontWeight: 700, cursor: 'text' }}
                      onFocus={e => { e.currentTarget.style.background = theme.surface.input; e.currentTarget.style.borderColor = theme.border.default }}
                      onBlur={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
                    />
                  )}
                  {!isEmpty && (
                    <>
                      <button onClick={() => { if (onLaunchTemplate) onLaunchTemplate({ id: `launch-${Date.now()}`, name: card.name.trim() || `Layout ${cardIdx + 1}`, created_at: new Date().toISOString(), tree: card.tree! }) }} title="Load" style={{
                        padding: '2px 8px', borderRadius: 4, border: `1px solid ${theme.border.default}`,
                        background: theme.surface.panelElevated, color: theme.text.secondary,
                        cursor: 'pointer', fontSize: Math.max(9, fonts.secondarySize - 2), fontWeight: 600,
                        opacity: hoveredLayoutCard === cardIdx ? 1 : 0,
                        pointerEvents: hoveredLayoutCard === cardIdx ? 'auto' : 'none',
                        transition: 'opacity 0.12s ease',
                        letterSpacing: 0.3, textTransform: 'uppercase',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.background = theme.accent.base; e.currentTarget.style.color = theme.text.inverse; e.currentTarget.style.borderColor = theme.accent.base }}
                        onMouseLeave={e => { e.currentTarget.style.background = theme.surface.panelElevated; e.currentTarget.style.color = theme.text.secondary; e.currentTarget.style.borderColor = theme.border.default }}
                      >
                        Load
                      </button>
                      <button onClick={() => clearCard(cardIdx)} title="Delete" style={{
                        width: 18, height: 18, borderRadius: 4, border: 'none', background: 'transparent',
                        color: theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        opacity: hoveredLayoutCard === cardIdx ? 1 : 0,
                        pointerEvents: hoveredLayoutCard === cardIdx ? 'auto' : 'none',
                        transition: 'opacity 0.12s ease',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.color = theme.status.danger }}
                        onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                      >
                        <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                      </button>
                    </>
                  )}
                </div>

                {/* Card — 16:9 ratio */}
                <div
                  data-layout-card={cardIdx}
                  onClick={() => { if (!isEmpty && !isEditing) buildAndLaunch(cardIdx) }}
                  style={{
                    borderRadius: 10, aspectRatio: '16 / 9',
                    border: `1.5px ${isEmpty ? 'dashed' : 'solid'} ${isCardHovered ? theme.accent.base : isEmpty ? `${theme.text.disabled}44` : theme.border.accent}`,
                    background: isEmpty ? `${theme.surface.panel}40` : theme.surface.panel,
                    backdropFilter: isEmpty ? 'blur(8px)' : 'none',
                    WebkitBackdropFilter: isEmpty ? 'blur(8px)' : 'none',
                    position: 'relative', overflow: 'hidden',
                    transition: 'border-color 0.12s ease',
                    display: 'flex',
                    cursor: !isEmpty && !isEditing ? 'pointer' : 'default',
                  }}
                >
                  {isEmpty ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: `${theme.text.disabled}66`, fontSize: Math.max(11, fonts.secondarySize), fontWeight: 500, userSelect: 'none', letterSpacing: 0.3 }}>
                      {isCardHovered ? <span style={{ color: theme.accent.base }}>Drop here</span> : 'Drag blocks here'}
                    </div>
                  ) : (
                    <div style={{ flex: 1, display: 'flex', padding: 3, position: 'relative' }}>
                      <InteractiveTree
                        node={card.tree}
                        path={[]}
                        onDropOnLeaf={() => {}}
                        onDragLeaf={isEditing ? (type, path) => startDrag(type, { preventDefault: () => {}, stopPropagation: () => {}, clientX: 0, clientY: 0 } as any, cardIdx, path) : () => {}}
                        hoverPath={hoverCard === cardIdx ? hoverLeafPath : null}
                        hoverZone={hoverCard === cardIdx ? hoverZone : null}
                        isEditing={isEditing}
                        onRemoveLeaf={isEditing ? (tileType) => {
                          setCards(prev => {
                            const n = [...prev]
                            const c = n[cardIdx]
                            if (c.tree) {
                              const cleaned = removeFromTree(c.tree, tileType)
                              n[cardIdx] = { ...c, tree: cleaned }
                            }
                            return n
                          })
                        } : undefined}
                        onResizeSplit={isEditing ? (splitPath, sizes) => {
                          setCards(prev => {
                            const n = [...prev]
                            const c = n[cardIdx]
                            if (c.tree) {
                              n[cardIdx] = { ...c, tree: updateSizesAtPath(c.tree, splitPath, sizes) }
                            }
                            return n
                          })
                        } : undefined}
                      />
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Pagination pips */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              style={{
                width: 24, height: 24, borderRadius: 6,
                border: `1px solid ${theme.border.default}`,
                background: theme.surface.panelElevated,
                color: currentPage === 0 ? theme.text.disabled : theme.text.secondary,
                cursor: currentPage === 0 ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: fonts.secondarySize,
              }}
            >{'<'}</button>
            {Array.from({ length: totalPages }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setCurrentPage(i)}
                style={{
                  width: 8, height: 8, borderRadius: 2, border: 'none', padding: 0,
                  background: i === currentPage ? theme.accent.base : `${theme.text.disabled}44`,
                  cursor: 'pointer', transition: 'background 0.12s ease',
                }}
              />
            ))}
            <button
              type="button"
              onClick={() => { addPageIfNeeded(); setCurrentPage(p => Math.min(totalPages, p + 1)) }}
              style={{
                width: 24, height: 24, borderRadius: 6,
                border: `1px solid ${theme.border.default}`,
                background: theme.surface.panelElevated,
                color: theme.text.secondary,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: fonts.secondarySize,
              }}
            >{'>'}</button>
          </div>
        )}
      </div>

      {/* Drag ghost */}
      {dragType && dragPos && dragPos.x > 0 && (
        <div style={{
          position: 'fixed', left: dragPos.x + 14, top: dragPos.y - 14,
          padding: '4px 10px', borderRadius: 6,
          background: theme.accent.base, color: theme.text.inverse,
          fontSize: fonts.secondarySize, fontWeight: 600, pointerEvents: 'none', zIndex: 999999,
          boxShadow: theme.shadow.panel,
        }}>
          {TYPE_LABELS[dragType] ?? dragType}
        </div>
      )}
    </div>
  )
}
