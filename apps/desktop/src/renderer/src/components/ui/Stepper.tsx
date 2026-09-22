import React, { useCallback, useEffect, useState } from 'react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'

export interface StepperProps {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  /** Formats the displayed value (e.g. for percentages or decimals). */
  format?: (value: number) => string
  /** Show a read-only display instead of an editable input. */
  readOnly?: boolean
  width?: number | string
}

export function Stepper({
  value,
  min = -Infinity,
  max = Infinity,
  step = 1,
  onChange,
  format,
  readOnly = false,
  width,
}: StepperProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()

  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max])
  const clamped = clamp(value)

  const [draft, setDraft] = useState<string>(() => format ? format(clamped) : String(clamped))

  useEffect(() => {
    setDraft(format ? format(clamped) : String(clamped))
  }, [clamped, format])

  const commit = useCallback((raw: string) => {
    const parsed = Number(raw)
    if (Number.isNaN(parsed)) {
      setDraft(format ? format(clamped) : String(clamped))
      return
    }
    const next = clamp(parsed)
    onChange(next)
    setDraft(format ? format(next) : String(next))
  }, [clamp, clamped, format, onChange])

  const nudge = useCallback((delta: number) => {
    const next = clamp(+(clamped + delta).toFixed(6))
    onChange(next)
    setDraft(format ? format(next) : String(next))
  }, [clamp, clamped, format, onChange])

  const buttonStyle: React.CSSProperties = {
    width: 24, height: 24, borderRadius: 6,
    border: `1px solid ${theme.border.default}`,
    background: theme.surface.panelElevated,
    color: theme.text.secondary,
    cursor: 'pointer', padding: 0, flexShrink: 0,
    fontFamily: fonts.secondary,
    fontSize: fonts.secondarySize, lineHeight: 1,
  }

  const display = format ? format(clamped) : String(clamped)

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `24px minmax(0, ${typeof width === 'number' ? width + 'px' : width ?? '1fr'}) 24px`,
      gap: 6,
      alignItems: 'center',
    }}>
      <button type="button" onClick={() => nudge(-step)} style={buttonStyle}>{'<'}</button>
      {readOnly ? (
        <div style={{
          height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 6, border: `1px solid ${theme.border.default}`,
          background: theme.surface.input, color: theme.text.primary,
          fontFamily: fonts.secondary,
          fontSize: fonts.secondarySize, fontVariantNumeric: 'tabular-nums',
        }}>
          {display}
        </div>
      ) : (
        <input
          type="number"
          value={draft}
          min={min === -Infinity ? undefined : min}
          max={max === Infinity ? undefined : max}
          step={step}
          onChange={e => setDraft(e.target.value)}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              commit((e.target as HTMLInputElement).value)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          style={{
            width: '100%', minWidth: 0, height: 24,
            padding: '0 8px', borderRadius: 6,
            border: `1px solid ${theme.border.default}`,
            background: theme.surface.input,
            color: theme.text.primary,
            outline: 'none',
            fontFamily: fonts.secondary,
            fontSize: fonts.secondarySize,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
          }}
        />
      )}
      <button type="button" onClick={() => nudge(step)} style={buttonStyle}>{'>'}</button>
    </div>
  )
}
