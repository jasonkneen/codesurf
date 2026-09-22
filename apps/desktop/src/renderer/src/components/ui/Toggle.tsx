import { useTheme } from '../../ThemeContext'

export interface ToggleProps {
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}

/** Compact toggle switch. */
export function Toggle({ value, onChange, disabled }: ToggleProps): JSX.Element {
  const theme = useTheme()
  return (
    <div
      onClick={() => { if (!disabled) onChange(!value) }}
      style={{
        width: 32, height: 18, borderRadius: 7,
        cursor: disabled ? 'not-allowed' : 'pointer',
        flexShrink: 0,
        background: value ? theme.accent.base : theme.surface.panelMuted,
        border: `1px solid ${value ? theme.accent.base : theme.border.default}`,
        position: 'relative',
        transition: 'background 0.15s, border-color 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{
        position: 'absolute',
        top: 2, left: value ? 16 : 2,
        width: 12, height: 12, borderRadius: 4,
        background: value ? theme.text.inverse : theme.text.muted,
        transition: 'left 0.15s, background 0.15s',
      }} />
    </div>
  )
}
