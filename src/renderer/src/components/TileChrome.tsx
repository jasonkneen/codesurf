import React, { useState } from 'react'
import type { TileState } from '../../../shared/types'

interface Props {
  tile: TileState
  onClose: () => void
  onTitlebarMouseDown: (e: React.MouseEvent) => void
  onResizeMouseDown: (e: React.MouseEvent, dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw') => void
  onContextMenu?: (e: React.MouseEvent) => void
  children: React.ReactNode
  isSelected?: boolean
}

const TYPE_LABELS: Record<string, string> = {
  terminal: 'Terminal', note: 'Note', code: 'Code', image: 'Image', kanban: 'Board'
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
  tile, onClose, onTitlebarMouseDown, onResizeMouseDown, onContextMenu, children, isSelected
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const PAD = 24

  const containerStyle: React.CSSProperties = expanded
    ? {
        position: 'fixed',
        left: PAD, top: PAD,
        width: `calc(100vw - ${PAD * 2}px)`,
        height: `calc(100vh - ${PAD * 2}px)`,
        zIndex: 99990,
        borderRadius: 10, overflow: 'hidden',
        border: '1px solid #4a9eff',
        boxShadow: '0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(74,158,255,0.3)',
        background: '#1e1e1e',
        display: 'flex', flexDirection: 'column'
      }
    : {
        position: 'absolute',
        left: tile.x, top: tile.y,
        width: tile.width, height: tile.height,
        zIndex: tile.zIndex,
        borderRadius: 8, overflow: 'hidden',
        border: `1px solid ${isSelected ? '#4a9eff' : '#3a3a3a'}`,
        boxShadow: isSelected
          ? '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(74,158,255,0.3)'
          : '0 4px 20px rgba(0,0,0,0.4)',
        background: '#1e1e1e',
        display: 'flex', flexDirection: 'column'
      }

  return (
    <>
      {/* Backdrop when expanded */}
      {expanded && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 99989,
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(2px)'
          }}
          onClick={() => setExpanded(false)}
        />
      )}

      <div
        style={containerStyle}
        onDoubleClick={e => e.stopPropagation()}
      >
        {/* Titlebar */}
        <div
          style={{
            height: 32, background: '#252525', borderBottom: '1px solid #333',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 8px 0 0', userSelect: 'none', flexShrink: 0,
            cursor: expanded ? 'default' : 'move'
          }}
          onMouseDown={expanded ? undefined : onTitlebarMouseDown}
          onDoubleClick={e => { e.stopPropagation(); setExpanded(p => !p) }}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e) }}
        >
          {/* Drag handle — hidden when expanded */}
          {!expanded && (
            <div
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('application/tile-id', tile.id)
                e.dataTransfer.setData('application/tile-type', tile.type)
                e.dataTransfer.setData('application/tile-label', fileLabel(tile))
                e.dataTransfer.effectAllowed = 'link'
                e.stopPropagation()
              }}
              onMouseDown={e => e.stopPropagation()}
              style={{
                width: 28, height: '100%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'grab', flexShrink: 0, color: '#444', fontSize: 11
              }}
              title="Drag to board"
            >
              ::
            </div>
          )}
          {expanded && <div style={{ width: 12 }} />}

          {/* Label */}
          <span style={{
            flex: 1, fontSize: 12, fontWeight: 500, color: '#cccccc',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {fileLabel(tile)}
          </span>

          {/* Expand/collapse toggle */}
          <button
            style={{
              width: 20, height: 20, borderRadius: 4, background: 'transparent',
              border: 'none', cursor: 'pointer', flexShrink: 0,
              color: '#555', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
            onClick={e => { e.stopPropagation(); setExpanded(p => !p) }}
            onMouseDown={e => e.stopPropagation()}
            onMouseEnter={e => (e.currentTarget.style.color = '#aaa')}
            onMouseLeave={e => (e.currentTarget.style.color = '#555')}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '⊡' : '⊞'}
          </button>

          {/* Close */}
          <button
            style={{
              width: 14, height: 14, borderRadius: '50%', background: '#444',
              border: 'none', cursor: 'pointer', flexShrink: 0, transition: 'background 0.1s',
              marginLeft: 6
            }}
            onClick={e => { e.stopPropagation(); onClose() }}
            onMouseDown={e => e.stopPropagation()}
            onMouseEnter={e => (e.currentTarget.style.background = '#ff5f56')}
            onMouseLeave={e => (e.currentTarget.style.background = '#444')}
          />
        </div>

        {/* Content */}
        <div
          style={{ flex: 1, overflow: 'hidden', minHeight: 0, userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
          onDragOver={e => {
            if (tile.type === 'kanban') return
            e.stopPropagation()
          }}
          onDrop={e => {
            if (tile.type === 'kanban') return
            e.stopPropagation()
          }}
        >
          {children}
        </div>

        {/* Resize handles — only in normal mode */}
        {!expanded && (['n','s','e','w','ne','nw','se','sw'] as const).map(dir => (
          <ResizeHandle key={dir} dir={dir} onMouseDown={e => onResizeMouseDown(e, dir)} />
        ))}
      </div>
    </>
  )
}
