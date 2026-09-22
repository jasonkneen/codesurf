/**
 * Sidebar text-input dialog (rename/new-value prompts) — extracted verbatim
 * from Sidebar.tsx. Self-contained: portal-rendered, owns its input state,
 * theme/fonts from context. Owns the SidebarTextDialogState type (re-imported
 * by Sidebar).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'

export interface SidebarTextDialogState {
  title: string
  description?: string
  confirmLabel: string
  initialValue: string
  placeholder?: string
  submit: (value: string) => Promise<void> | void
}

export function SidebarTextDialog({
  state,
  onClose,
}: {
  state: SidebarTextDialogState
  onClose: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(state.initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setValue(state.initialValue)
    setBusy(false)
    setError(null)
  }, [state])

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [state])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose])

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await state.submit(value)
      onClose()
    } catch (submitError) {
      setBusy(false)
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    }
  }, [busy, onClose, state, value])

  return createPortal(
    <div
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(0, 0, 0, 0.48)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: 420,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: 18,
          borderRadius: 12,
          border: `1px solid ${theme.border.default}`,
          background: theme.surface.panelElevated,
          boxShadow: theme.shadow.panel,
          color: theme.text.primary,
          fontFamily: fonts.primary,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: fonts.size + 2, fontWeight: Math.min(900, fonts.weight + 100), color: theme.text.primary }}>
            {state.title}
          </div>
          {state.description && (
            <div style={{ fontSize: fonts.secondarySize, lineHeight: 1.45, color: theme.text.muted }}>
              {state.description}
            </div>
          )}
        </div>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder={state.placeholder}
          spellCheck={false}
          disabled={busy}
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${error ? theme.status.danger : theme.border.default}`,
            background: theme.surface.hover,
            color: theme.text.primary,
            outline: 'none',
            fontFamily: fonts.primary,
            fontSize: fonts.size,
            boxSizing: 'border-box',
          }}
        />

        {error && (
          <div style={{ fontSize: fonts.secondarySize, color: theme.status.danger }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${theme.border.default}`,
              background: 'transparent',
              color: theme.text.secondary,
              cursor: busy ? 'default' : 'pointer',
              fontFamily: fonts.primary,
              fontSize: fonts.size,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: 'none',
              background: theme.accent.base,
              color: theme.text.inverse,
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.7 : 1,
              fontFamily: fonts.primary,
              fontSize: fonts.size,
              fontWeight: Math.min(900, fonts.weight + 100),
            }}
          >
            {busy ? 'Working…' : state.confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
