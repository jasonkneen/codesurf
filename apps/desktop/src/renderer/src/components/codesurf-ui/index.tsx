/**
 * @codesurf/ui — the default consistent control kit for plugin UIs.
 *
 * Plain React components styled on the host's --ct-* theme tokens (the same tokens
 * the iframe bridge injects), so every plugin's fields/buttons/switches look native
 * by default. Plugins opt into these for consistency (point 8) and override with
 * their own styles when they want something bespoke. Used directly by component-mode
 * plugin UIs and by the host when rendering declarative settings sections.
 *
 * Zero dependencies beyond React. Mirrors the structural styles baked into the iframe
 * bridge base stylesheet so component-mode and iframe-mode plugins match.
 */

import React from 'react'
import type { ExtensionSettingControl } from '../../../../shared/types'

const radius = 'var(--ct-radius, 6px)'
const border = '1px solid var(--ct-border, rgba(127,127,127,0.25))'
const text = 'var(--ct-text, inherit)'
const muted = 'var(--ct-text-muted, var(--ct-text, inherit))'
const panel = 'var(--ct-panel, rgba(127,127,127,0.06))'
const accent = 'var(--ct-accent, #4f46e5)'
const fontSans = 'var(--ct-font-primary, var(--ct-font-sans, inherit))'
const fontSecondary = 'var(--ct-font-secondary, var(--ct-font-subtle, var(--ct-font-primary, inherit)))'
const fontSize = 'var(--ct-font-primary-size, var(--ct-font-size, 13px))'
const fontSecondarySize = 'var(--ct-font-secondary-size, var(--ct-font-subtle-size, 12px))'

const controlBase: React.CSSProperties = {
  font: 'inherit',
  fontFamily: fontSans,
  fontSize,
  color: text,
  background: 'var(--ct-bg, transparent)',
  border,
  borderRadius: radius,
  padding: '6px 10px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

export function Button({
  variant = 'default',
  style,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' }) {
  const variants: Record<string, React.CSSProperties> = {
    default: { background: panel, color: text, border },
    primary: { background: accent, color: '#fff', border: '1px solid transparent' },
    ghost: { background: 'transparent', color: text, border: '1px solid transparent' },
  }
  return (
    <button
      {...props}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        cursor: 'pointer', borderRadius: radius, padding: '5px 12px',
        fontFamily: fontSecondary, fontSize: fontSecondarySize, lineHeight: 1.4,
        transition: 'background 0.15s, opacity 0.15s', outline: 'none',
        ...variants[variant], ...style,
      }}
    />
  )
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ style, ...props }, ref) {
    return <input ref={ref} {...props} style={{ ...controlBase, ...style }} />
  },
)

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ style, ...props }, ref) {
    return <textarea ref={ref} {...props} style={{ ...controlBase, resize: 'vertical', minHeight: 64, ...style }} />
  },
)

export function Select({ style, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ ...controlBase, cursor: 'pointer', ...style }}>{children}</select>
}

export function Switch({ checked, onChange, disabled, label }: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      <span
        onClick={() => !disabled && onChange(!checked)}
        style={{
          width: 32, height: 18, borderRadius: 999, padding: 2, boxSizing: 'border-box',
          background: checked ? accent : 'var(--ct-border, rgba(127,127,127,0.35))',
          transition: 'background 0.15s', flexShrink: 0, display: 'inline-block',
        }}
      >
        <span style={{
          display: 'block', width: 14, height: 14, borderRadius: 999, background: '#fff',
          transform: checked ? 'translateX(14px)' : 'translateX(0)', transition: 'transform 0.15s',
        }} />
      </span>
      {label != null && <span style={{ color: text, fontFamily: fontSans, fontSize }}>{label}</span>}
    </label>
  )
}

export function Field({ label, description, children }: {
  label?: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
      {label && <label style={{ color: text, fontFamily: fontSans, fontSize, fontWeight: 500 }}>{label}</label>}
      {children}
      {description && <span style={{ color: muted, opacity: 0.7, fontFamily: fontSans, fontSize: 11 }}>{description}</span>}
    </div>
  )
}

/**
 * Render a single declarative settings control (the ExtensionSettingControl union)
 * with consistent styling. The host uses this to paint plugin settings sections.
 */
export function SettingsControl({
  control,
  value,
  onChange,
  onCommand,
}: {
  control: ExtensionSettingControl
  value: unknown
  onChange: (value: unknown) => void
  onCommand?: (command: string) => void
}) {
  switch (control.kind) {
    case 'toggle':
      return (
        <Field description={control.description}>
          <Switch checked={Boolean(value ?? control.default)} onChange={onChange} label={control.label} />
        </Field>
      )
    case 'text':
      return (
        <Field label={control.label} description={control.description}>
          <Input
            value={String(value ?? control.default ?? '')}
            placeholder={control.placeholder}
            onChange={e => onChange(e.target.value)}
          />
        </Field>
      )
    case 'number':
      return (
        <Field label={control.label} description={control.description}>
          <Input
            type="number"
            value={String(value ?? control.default ?? '')}
            min={control.min}
            max={control.max}
            step={control.step}
            onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </Field>
      )
    case 'select':
      return (
        <Field label={control.label} description={control.description}>
          <Select value={String(value ?? control.default ?? '')} onChange={e => onChange(e.target.value)}>
            {control.options.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
        </Field>
      )
    case 'button':
      return (
        <Field description={control.description}>
          <Button onClick={() => onCommand?.(control.command)}>{control.label}</Button>
        </Field>
      )
    default:
      return null
  }
}
