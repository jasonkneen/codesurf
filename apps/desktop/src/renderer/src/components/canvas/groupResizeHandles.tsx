import type { CSSProperties } from 'react'
import type { CanvasDragState } from '../../hooks/useCanvasEngine'

export const GROUP_RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
export type GroupResizeDir = typeof GROUP_RESIZE_DIRS[number]

type GroupResizeHandlesProps = {
  handleSize?: number
  onResizeStart: (dir: GroupResizeDir, event: React.MouseEvent<HTMLDivElement>) => void
}

export function GroupResizeHandles({ handleSize = 10, onResizeStart }: GroupResizeHandlesProps) {
  return (
    <>
      {GROUP_RESIZE_DIRS.map(dir => {
        const size = handleSize
        const hs: CSSProperties = { position: 'absolute', zIndex: 20 }
        if (dir === 'e') Object.assign(hs, { right: -size / 2, top: size, bottom: size, width: size, cursor: 'col-resize' })
        if (dir === 'w') Object.assign(hs, { left: -size / 2, top: size, bottom: size, width: size, cursor: 'col-resize' })
        if (dir === 's') Object.assign(hs, { bottom: -size / 2, left: size, right: size, height: size, cursor: 'row-resize' })
        if (dir === 'n') Object.assign(hs, { top: -size / 2, left: size, right: size, height: size, cursor: 'row-resize' })
        if (dir === 'se') Object.assign(hs, { right: -size / 2, bottom: -size / 2, width: size * 1.5, height: size * 1.5, cursor: 'se-resize' })
        if (dir === 'sw') Object.assign(hs, { left: -size / 2, bottom: -size / 2, width: size * 1.5, height: size * 1.5, cursor: 'sw-resize' })
        if (dir === 'ne') Object.assign(hs, { right: -size / 2, top: -size / 2, width: size * 1.5, height: size * 1.5, cursor: 'ne-resize' })
        if (dir === 'nw') Object.assign(hs, { left: -size / 2, top: -size / 2, width: size * 1.5, height: size * 1.5, cursor: 'nw-resize' })
        return (
          <div
            key={dir}
            style={hs}
            onMouseDown={event => {
              event.stopPropagation()
              event.preventDefault()
              onResizeStart(dir, event)
            }}
          />
        )
      })}
    </>
  )
}

export function isGroupDragActive(dragState: CanvasDragState, groupId: string): boolean {
  return (dragState.type === 'group' || dragState.type === 'group-resize') && dragState.groupId === groupId
}