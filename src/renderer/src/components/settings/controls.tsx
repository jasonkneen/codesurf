import React from 'react'
import type { FontToken } from '../../../../shared/types'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import { NumInput as UINumInput, Select as UISelect, Stepper as UIStepper, TextInput as UITextInput, Toggle as UIToggle } from '../ui'

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return <UIToggle value={value} onChange={onChange} />
}

export function NumInput({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }): React.JSX.Element {
  return (
    <UINumInput
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={e => onChange(Number(e.target.value))}
      style={{ width: 72 }}
    />
  )
}

export function RangeInput({ value, min, max, step = 0.01, onChange, formatValue }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; formatValue?: (v: number) => string }): React.JSX.Element {
  const clamped = Math.max(min, Math.min(max, value))
  const display = formatValue ? formatValue(clamped) : `${Math.round(clamped * 100)}%`
  return (
    <UIStepper
      value={clamped}
      min={min}
      max={max}
      step={step}
      onChange={onChange}
      format={() => display}
      readOnly
      width={80}
    />
  )
}

export function TextInput({ value, onChange, width = 240, placeholder }: { value: string; onChange: (v: string) => void; width?: number; placeholder?: string }): React.JSX.Element {
  return (
    <UITextInput
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={{ width }}
    />
  )
}

export function ColorSwatch({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const colorInputValue = (() => {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    }
    const match = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
    if (!match) return '#000000'
    const [r, g, b] = match.slice(1, 4).map(channel => Math.max(0, Math.min(255, Number(channel))))
    return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
  })()

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <div
          style={{ width: 28, height: 28, borderRadius: 6, background: value, cursor: 'pointer', border: `1px solid ${theme.border.strong}` }}
          onClick={e => (e.currentTarget.nextSibling as HTMLInputElement | null)?.click()}
        />
        <input
          type="color"
          value={colorInputValue}
          onChange={e => onChange(e.target.value)}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
        />
      </div>
      <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, fontFamily: fonts.mono }}>{value}</span>
    </div>
  )
}

export function fontDisplayName(stack: string): string {
  const first = stack.split(',')[0].trim().replace(/^"|"$/g, '')
  if (first.startsWith('-apple-system') || first === 'system-ui') return 'System Default'
  if (first === 'monospace') return 'System Monospace'
  return first
}

function sortFonts(fonts: string[]): string[] {
  return [...fonts].sort((a, b) => {
    const na = fontDisplayName(a)
    const nb = fontDisplayName(b)
    const aGeneric = na.startsWith('System')
    const bGeneric = nb.startsWith('System')
    if (aGeneric && !bGeneric) return 1
    if (bGeneric && !aGeneric) return -1
    return na.localeCompare(nb)
  })
}

export const SANS_FONTS = sortFonts([
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
  '"SF Pro Display", "Segoe UI", "Helvetica Neue", sans-serif',
  '"Helvetica Neue", Helvetica, Arial, sans-serif',
  '"Inter", "Segoe UI", sans-serif',
  '"Geist", "SF Pro Text", sans-serif',
  '"Armata", sans-serif',
  '"Blinker", sans-serif',
  '"Datatype", sans-serif',
  '"Doto", sans-serif',
  '"Exo 2", sans-serif',
  '"Jockey One", sans-serif',
  '"Metrophobic", sans-serif',
  '"Orbitron", sans-serif',
  '"Oxanium", sans-serif',
  '"Quantico", sans-serif',
  '"Russo One", sans-serif',
  '"Saira", sans-serif',
  '"Saira Condensed", sans-serif',
  '"Tektur", sans-serif',
  '"Rajdhani", sans-serif',
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  '"SF Pro Rounded", "Hiragino Maru Gothic ProN", Meiryo, "MS PGothic", sans-serif',
  '"Roboto", "Segoe UI", sans-serif',
  'system-ui, sans-serif',
])

export const MONO_FONTS = sortFonts([
  '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace',
  '"IBM Plex Mono", monospace',
  '"Fira Code", "JetBrains Mono", monospace',
  '"SF Mono", "Menlo", "Monaco", monospace',
  '"Cascadia Code", "Fira Code", monospace',
  '"Source Code Pro", "Menlo", monospace',
  '"Geist Mono", "SF Mono", monospace',
  '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  '"JetBrains Mono", "JetBrainsMono Nerd Font", "JetBrainsMono NF", "MesloLGM Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "SF Mono", Menlo, Monaco, Consolas, monospace',
  '"MesloLGM Nerd Font", "MesloLGM NF", "JetBrains Mono", monospace',
  '"Hack Nerd Font", "Fira Code", monospace',
  '"FiraCode Nerd Font", "Fira Code", monospace',
  'monospace',
])

export function FontSelect({ value, onChange, fonts }: { value: string; onChange: (v: string) => void; fonts: string[] }): React.JSX.Element {
  const displayName = fontDisplayName
  return (
    <UISelect
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{ width: '100%', maxWidth: 280, fontFamily: value }}
    >
      {fonts.map(f => (
        <option key={f} value={f} style={{ fontFamily: f }}>
          {displayName(f)}
        </option>
      ))}
      {!fonts.includes(value) && (
        <option value={value} style={{ fontFamily: value }}>
          {displayName(value)} (custom)
        </option>
      )}
    </UISelect>
  )
}

export function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`, borderRadius: 10, padding: '14px 16px',
      marginBottom: 8, gap: 16,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500, marginBottom: description ? 3 : 0 }}>{label}</div>
        {description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

export function SectionLabel({ label }: { label: string }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{
      fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.disabled,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      marginTop: 20, marginBottom: 8, paddingLeft: 2,
    }}>
      {label}
    </div>
  )
}

export function StepperNumberField({ value, min, max, step, onChange, format }: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
}): React.JSX.Element {
  return (
    <UIStepper
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={onChange}
      format={format}
    />
  )
}

export function CompactFontRow({ label, description, token, fontOptions, onChange }: {
  label: string
  description: string
  token: FontToken
  fontOptions: string[]
  onChange: (next: FontToken) => void
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

  const microFieldStyle: React.CSSProperties = {
    width: 56, height: 28,
    padding: '0 6px', borderRadius: 6,
    border: `1px solid ${theme.border.default}`,
    background: theme.surface.input,
    color: theme.text.primary,
    outline: 'none',
    fontSize: fonts.secondarySize,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    MozAppearance: 'textfield',
  }
  const microLabelStyle: React.CSSProperties = {
    fontSize: Math.max(9, fonts.secondarySize - 2),
    color: theme.text.disabled,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 2,
    textAlign: 'center',
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(120px, 130px) 1fr',
      gap: 12,
      alignItems: 'center',
      padding: '10px 12px',
      background: theme.surface.panelMuted,
      border: `1px solid ${theme.border.subtle}`,
      borderRadius: 10,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{description}</div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={microLabelStyle}>Family</div>
          <FontSelect value={token.family} onChange={family => onChange({ ...token, family })} fonts={fontOptions} />
        </div>
        <div>
          <div style={microLabelStyle}>Size</div>
          <input
            type="number"
            min={8}
            max={32}
            step={1}
            value={token.size}
            onChange={e => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange({ ...token, size: clamp(n, 8, 32) })
            }}
            style={microFieldStyle}
          />
        </div>
        <div>
          <div style={microLabelStyle}>Weight</div>
          <input
            type="number"
            min={100}
            max={900}
            step={100}
            value={token.weight ?? 400}
            onChange={e => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange({ ...token, weight: clamp(Math.round(n / 100) * 100, 100, 900) })
            }}
            style={microFieldStyle}
          />
        </div>
        <div>
          <div style={microLabelStyle}>Line</div>
          <input
            type="number"
            min={0.7}
            max={2.2}
            step={0.05}
            value={Number(token.lineHeight.toFixed(2))}
            onChange={e => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange({ ...token, lineHeight: clamp(n, 0.7, 2.2) })
            }}
            style={microFieldStyle}
          />
        </div>
      </div>
    </div>
  )
}
