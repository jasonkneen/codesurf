import React, { useState, useRef, useEffect } from 'react'
import type { TileState } from '../../../shared/types'

interface Props {
  tile: TileState
  onClose: () => void
  onTitlebarMouseDown: (e: React.MouseEvent) => void
  onResizeMouseDown: (e: React.MouseEvent, dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw') => void
  onContextMenu?: (e: React.MouseEvent) => void
  onExpandChange?: (expanded: boolean) => void
  children: React.ReactNode
  isSelected?: boolean
  forceExpanded?: boolean // controlled from outside
  busChannel?: string           // channel this tile subscribes to (default: `tile:${tile.id}`)
  busUnreadCount?: number       // unread count passed from parent
  onBusPopupToggle?: () => void // callback when badge is clicked
  showBusPopup?: boolean        // controlled popup visibility
  busEvents?: Array<{           // recent events to show in popup
    id: string
    type: string
    timestamp: number
    source: string
    payload: Record<string, unknown>
  }>
}

const TYPE_LABELS: Record<string, string> = {
  terminal: 'Terminal', note: 'Note', code: 'Code', image: 'Image', kanban: 'Board', browser: 'Browser', chat: 'Chat'
}

export function fileLabel(tile: TileState): string {
  if (!tile.filePath) return TYPE_LABELS[tile.type] ?? tile.type
  return tile.filePath.replace(/\\/g, '/').split('/').pop() || tile.filePath
}

function ResizeHandle({ dir, onMouseDown }: {
  dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'
  onMouseDown: (e: React.MouseEvent) => void
}): JSX.Element {
  const S = 8
  const style: React.CSSProperties = { position: 'absolute', zIndex: 10 }
  if (dir === 'e')  Object.assign(style, { right: 0, top: S, bottom: S, width: S, cursor: 'col-resize' })
  if (dir === 'w')  Object.assign(style, { left: 0, top: S, bottom: S, width: S, cursor: 'col-resize' })
  if (dir === 's')  Object.assign(style, { bottom: 0, left: S, right: S, height: S, cursor: 'row-resize' })
  if (dir === 'n')  Object.assign(style, { top: 0, left: S, right: S, height: S, cursor: 'row-resize' })
  if (dir === 'se') Object.assign(style, { right: 0, bottom: 0, width: S, height: S, cursor: 'se-resize' })
  if (dir === 'sw') Object.assign(style, { left: 0, bottom: 0, width: S, height: S, cursor: 'sw-resize' })
  if (dir === 'ne') Object.assign(style, { right: 0, top: 0, width: S, height: S, cursor: 'ne-resize' })
  if (dir === 'nw') Object.assign(style, { left: 0, top: 0, width: S, height: S, cursor: 'nw-resize' })
  return <div style={style} onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onMouseDown(e) }} />
}

export function TileChrome({
  tile, onClose, onTitlebarMouseDown, onResizeMouseDown, onContextMenu,
  onExpandChange, children, isSelected, forceExpanded,
  busUnreadCount, onBusPopupToggle, showBusPopup, busEvents
}: Props): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = forceExpanded ?? localExpanded

  const toggle = () => {
    const next = !expanded
    setLocalExpanded(next)
    onExpandChange?.(next)
  }

  // ─── Native mousedown listener on the titlebar ───────────────────────────
  // WHY: React portal events (browser toolbar) bubble through React's component
  // tree — BrowserTile → App — never reaching TileChrome's titlebar. Every other
  // tile works because their title text is a direct React child of the titlebar.
  // A native DOM listener receives events via real DOM bubbling, which DOES
  // include portal content (it lives in the titlebar's DOM subtree).
  // Elements marked data-no-drag (expand/close) are excluded.
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

  return (
    <div
      data-tile-chrome="true"
      className="absolute flex flex-col"
      style={{
        left: tile.x, top: tile.y,
        width: tile.width, height: tile.height,
        zIndex: tile.zIndex,
        borderRadius: 8, overflow: 'hidden',
        border: isSelected ? '0.5px solid #4a9eff' : '1px solid #3a3a3a',
        boxShadow: isSelected
          ? '0 8px 32px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(74,158,255,0.3)'
          : '0 4px 20px rgba(0,0,0,0.4)',
        background: '#1e1e1e',
        visibility: forceExpanded ? 'hidden' : 'visible',
        pointerEvents: forceExpanded ? 'none' : 'all',
      }}
      onDoubleClick={e => e.stopPropagation()}
    >
      {/* Titlebar — ref + native listener instead of React onMouseDown so portal
          content (browser toolbar) can also initiate tile-move drag */}
      <div
        ref={titlebarRef}
        style={{
          height: 32, background: '#252525', borderBottom: '1px solid #333',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 8px 0 0', userSelect: 'none', flexShrink: 0, cursor: 'move'
        }}
        onDoubleClick={e => { e.stopPropagation(); toggle() }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e) }}
      >
        {/* Drag handle — mouseDown no longer blocked so the native listener above
            can start tile-move; onDragStart uses a transparent ghost so the OS
            drag image doesn't appear on top of the moving tile */}
        <div
          draggable
          onDragStart={e => {
            e.dataTransfer.setData('application/tile-id', tile.id)
            e.dataTransfer.setData('application/tile-type', tile.type)
            e.dataTransfer.setData('application/tile-label', fileLabel(tile))
            e.dataTransfer.effectAllowed = 'link'
            // Invisible drag ghost — tile-move handles the visual
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
            cursor: 'grab', flexShrink: 0, color: '#666', fontSize: 11
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
            flex: 1, fontSize: 12, fontWeight: 500, color: '#cccccc',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {fileLabel(tile)}
          </span>
        )}

        {/* data-no-drag excludes these from the native drag handler */}
        <button
          data-no-drag=""
          style={{
            width: 24, height: 24, borderRadius: 4, background: 'transparent',
            border: 'none', cursor: 'pointer', flexShrink: 0,
            color: '#666', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={e => { e.stopPropagation(); toggle() }}
          onMouseDown={e => e.stopPropagation()}
          onMouseEnter={e => (e.currentTarget.style.color = '#aaa')}
          onMouseLeave={e => (e.currentTarget.style.color = '#666')}
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
            data-no-drag=""
            onClick={e => { e.stopPropagation(); onBusPopupToggle?.() }}
            onMouseDown={e => e.stopPropagation()}
            style={{
              minWidth: 18, height: 18, borderRadius: 9,
              background: '#4a9eff',
              border: 'none', cursor: 'pointer',
              color: '#fff', fontSize: 10, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 5px',
              marginLeft: 4,
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#5ab0ff')}
            onMouseLeave={e => (e.currentTarget.style.background = '#4a9eff')}
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
            color: '#666', display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginLeft: 4
          }}
          onClick={e => { e.stopPropagation(); onClose() }}
          onMouseDown={e => e.stopPropagation()}
          onMouseEnter={e => (e.currentTarget.style.color = '#ff5f56')}
          onMouseLeave={e => (e.currentTarget.style.color = '#666')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Content — position:relative so BrowserTile's position:absolute inset:0
          is contained here, not the TileChrome outer div */}
      <div
        style={{ flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative', userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
        onDragOver={e => { if (tile.type !== 'kanban') e.stopPropagation() }}
        onDrop={e => { if (tile.type !== 'kanban') e.stopPropagation() }}
      >
        {forceExpanded ? null : children}
      </div>

      {(['n','s','e','w','ne','nw','se','sw'] as const).map(dir => (
        <ResizeHandle key={dir} dir={dir} onMouseDown={e => onResizeMouseDown(e, dir)} />
      ))}

      {/* Bus event popup */}
      {showBusPopup && busEvents && (
        <div
          data-no-drag=""
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 34, right: 4,
            width: 300, maxHeight: 280,
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            zIndex: 20,
            overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{
            padding: '6px 10px',
            borderBottom: '1px solid #2d2d2d',
            fontSize: 11, fontWeight: 600, color: '#888',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Events</span>
            <button
              onClick={e => { e.stopPropagation(); onBusPopupToggle?.() }}
              style={{
                background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
            {busEvents.length === 0 ? (
              <div style={{ padding: '12px', textAlign: 'center', color: '#555', fontSize: 11 }}>
                No events yet
              </div>
            ) : (
              busEvents.slice(-30).reverse().map(evt => (
                <div key={evt.id} style={{
                  padding: '4px 10px',
                  borderBottom: '1px solid #1f1f1f',
                  fontSize: 11,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{
                      color: evt.type === 'notification' ? '#ffb432' :
                             evt.type === 'progress' ? '#4a9eff' :
                             evt.type === 'task' ? '#66bb6a' :
                             '#888',
                      fontWeight: 500,
                    }}>
                      {evt.type}
                    </span>
                    <span style={{ color: '#555', fontSize: 10 }}>
                      {new Date(evt.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div style={{ color: '#aaa' }}>
                    {(evt.payload as any).message ?? (evt.payload as any).status ?? (evt.payload as any).title ?? JSON.stringify(evt.payload).slice(0, 80)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
