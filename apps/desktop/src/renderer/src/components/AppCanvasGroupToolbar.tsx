import type { AppFonts } from '../FontContext'
import type { AppTheme } from '../theme'

export type AppCanvasGroupToolbarProps = {
  selectedTileCount: number
  theme: AppTheme
  appFonts: AppFonts
  onGroupSelected: () => void
  onClearSelection: () => void
}

export function AppCanvasGroupToolbar(props: AppCanvasGroupToolbarProps): JSX.Element | null {
  const {
    selectedTileCount,
    theme,
    appFonts,
    onGroupSelected,
    onClearSelection,
  } = props

  if (selectedTileCount < 2) return null

  return (
    <div
      onMouseDown={event => event.stopPropagation()}
      style={{
        position: 'absolute',
        bottom: 62,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        background: theme.surface.overlay,
        border: `1px solid ${theme.border.default}`,
        borderRadius: 8,
        padding: '5px 12px',
        backdropFilter: 'blur(8px)',
        boxShadow: theme.shadow.panel,
        zIndex: 1000,
      }}
    >
      <span style={{ fontSize: appFonts.secondarySize, color: theme.text.muted }}>
        {selectedTileCount} block{selectedTileCount !== 1 ? 's' : ''} selected
      </span>
      <button
        onClick={onGroupSelected}
        style={{
          fontSize: appFonts.secondarySize,
          color: theme.accent.base,
          background: theme.accent.soft,
          border: `1px solid ${theme.border.accent}`,
          borderRadius: 5,
          padding: '3px 10px',
          cursor: 'pointer',
        }}
        onMouseEnter={event => { event.currentTarget.style.background = theme.surface.selection }}
        onMouseLeave={event => { event.currentTarget.style.background = theme.accent.soft }}
      >
        Group
      </button>
      <button
        onClick={onClearSelection}
        style={{
          fontSize: appFonts.secondarySize,
          color: theme.text.disabled,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '3px 6px',
        }}
      >
        Cancel
      </button>
    </div>
  )
}