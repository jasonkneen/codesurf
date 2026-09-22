import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, FileJson, RotateCcw } from 'lucide-react'
import type { AppSettings } from '../../../../shared/types'
import { DEFAULT_FONTS } from '../../../../shared/types'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import { Button } from '../ui'

export function FontTokenEditor({ settings, onSettingsChange }: {
  settings: AppSettings
  onSettingsChange: (s: AppSettings) => void
}): React.JSX.Element {
  const [rawJson, setRawJson] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const fonts = useAppFonts()
  const theme = useTheme()
  const [view, setView] = useState<'editor' | 'reference'>('editor')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (typeof window.electron.settings.getRawJson !== 'function') {
      setRawJson(JSON.stringify(settings.fonts ?? {}, null, 2))
      setConfigPath('~/.codesurf/config.json')
      setLoading(false)
      return
    }
    window.electron.settings.getRawJson().then(({ path, content }) => {
      setConfigPath(path)
      try {
        const parsed = JSON.parse(content)
        const fontOverrides = parsed.settings?.fonts ?? {}
        setRawJson(JSON.stringify(fontOverrides, null, 2))
      } catch {
        setRawJson('{}')
      }
      setLoading(false)
    })
  }, [settings.fonts])

  const handleChange = useCallback((value: string) => {
    setRawJson(value)
    setSaved(false)
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('Must be a JSON object')
        return
      }
      const validKeys = new Set(Object.keys(DEFAULT_FONTS))
      const invalidKeys = Object.keys(parsed).filter(k => !validKeys.has(k))
      if (invalidKeys.length > 0) {
        setError(`Unknown token${invalidKeys.length > 1 ? 's' : ''}: ${invalidKeys.join(', ')}`)
        return
      }
      const validProps = new Set(['family', 'size', 'lineHeight', 'weight', 'letterSpacing'])
      for (const [tokenKey, tokenVal] of Object.entries(parsed)) {
        if (typeof tokenVal !== 'object' || tokenVal === null) {
          setError(`"${tokenKey}" must be an object`)
          return
        }
        const invalidProps = Object.keys(tokenVal as object).filter(p => !validProps.has(p))
        if (invalidProps.length > 0) {
          setError(`"${tokenKey}" has unknown propert${invalidProps.length > 1 ? 'ies' : 'y'}: ${invalidProps.join(', ')}`)
          return
        }
        const tv = tokenVal as Record<string, unknown>
        if (tv.family !== undefined && typeof tv.family !== 'string') { setError(`"${tokenKey}.family" must be a string`); return }
        if (tv.size !== undefined && (typeof tv.size !== 'number' || tv.size < 1 || tv.size > 72)) { setError(`"${tokenKey}.size" must be 1-72`); return }
        if (tv.lineHeight !== undefined && (typeof tv.lineHeight !== 'number' || tv.lineHeight < 0.5 || tv.lineHeight > 4)) { setError(`"${tokenKey}.lineHeight" must be 0.5-4`); return }
        if (tv.weight !== undefined && (typeof tv.weight !== 'number' || tv.weight < 100 || tv.weight > 900)) { setError(`"${tokenKey}.weight" must be 100-900`); return }
        if (tv.letterSpacing !== undefined && typeof tv.letterSpacing !== 'number') { setError(`"${tokenKey}.letterSpacing" must be a number`); return }
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON')
    }
  }, [])

  const hasBridge = typeof window.electron.settings.getRawJson === 'function'

  const handleSave = useCallback(async () => {
    if (error) return
    try {
      const fontsOverride = JSON.parse(rawJson)
      if (!hasBridge) {
        const updated = await window.electron.settings.set({ ...settings, fonts: Object.keys(fontsOverride).length > 0 ? fontsOverride : undefined })
        onSettingsChange(updated)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        return
      }
      const { content } = await window.electron.settings.getRawJson()
      const config = JSON.parse(content || '{}')
      if (!config.settings) config.settings = {}
      if (Object.keys(fontsOverride).length === 0) delete config.settings.fonts
      else config.settings.fonts = fontsOverride
      const result = await window.electron.settings.setRawJson(JSON.stringify(config, null, 2))
      if (result.ok && result.settings) {
        onSettingsChange(result.settings)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setError(result.error ?? 'Save failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }, [rawJson, error, onSettingsChange, settings, hasBridge])

  const handleReset = useCallback(async () => {
    setRawJson('{}')
    setError(null)
    if (!hasBridge) {
      const updated = await window.electron.settings.set({ ...settings, fonts: undefined as any })
      onSettingsChange(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      return
    }
    const { content } = await window.electron.settings.getRawJson()
    const config = JSON.parse(content || '{}')
    if (config.settings) delete config.settings.fonts
    const result = await window.electron.settings.setRawJson(JSON.stringify(config, null, 2))
    if (result.ok && result.settings) {
      onSettingsChange(result.settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }, [onSettingsChange, settings, hasBridge])

  const handleCopyDefaults = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(DEFAULT_FONTS, null, 2))
  }, [])

  const insertToken = useCallback((key: 'primary' | 'secondary' | 'mono') => {
    try {
      const current = JSON.parse(rawJson || '{}')
      if (!current[key]) {
        const def = DEFAULT_FONTS[key]
        current[key] = { family: def.family, size: def.size }
      }
      const newJson = JSON.stringify(current, null, 2)
      setRawJson(newJson)
      handleChange(newJson)
      setView('editor')
    } catch {}
  }, [rawJson, handleChange])

  if (loading) {
    return <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, padding: 20 }}>Loading config...</div>
  }

  const monoFont = fonts.mono

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileJson size={13} color={theme.text.disabled} />
        <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: monoFont }}>{configPath}</span>
        <span style={{ fontSize: 9, color: theme.accent.base, fontFamily: monoFont }}>settings.fonts</span>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${theme.border.default}` }}>
        {(['editor', 'reference'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '6px 14px', fontSize: fonts.secondarySize, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: view === v ? theme.surface.panelMuted : 'transparent',
            color: view === v ? theme.text.primary : theme.text.muted,
            borderBottom: view === v ? `2px solid ${theme.accent.base}` : '2px solid transparent',
          }}>
            {v === 'editor' ? 'JSON Editor' : 'Token Reference'}
          </button>
        ))}
      </div>

      {view === 'editor' ? (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Button onClick={handleSave} disabled={!!error} variant={saved ? 'secondary' : 'primary'} size="xs" icon={saved ? <Check size={10} /> : undefined}>
              {saved ? 'Saved' : 'Save'}
            </Button>
            <Button onClick={handleReset} variant="secondary" size="xs" icon={<RotateCcw size={9} />} title="Reset to defaults (remove all overrides)">
              Reset
            </Button>
            <Button onClick={handleCopyDefaults} variant="secondary" size="xs" icon={<Copy size={9} />} title="Copy all default tokens to clipboard">
              Copy Defaults
            </Button>
            <div style={{ flex: 1 }} />
            {error && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: theme.status.danger }}>
                <AlertTriangle size={10} />
                <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</span>
              </div>
            )}
          </div>

          <textarea
            ref={textareaRef}
            value={rawJson}
            onChange={e => handleChange(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                handleSave()
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                const ta = e.currentTarget
                const start = ta.selectionStart
                const end = ta.selectionEnd
                const newVal = ta.value.substring(0, start) + '  ' + ta.value.substring(end)
                handleChange(newVal)
                requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2 })
              }
            }}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 260, maxHeight: 380,
              padding: '12px 14px', borderRadius: 8,
              background: theme.surface.panelMuted, color: error ? theme.status.danger : theme.text.primary,
              border: `1px solid ${error ? `${theme.status.danger}44` : theme.surface.panelMuted}`,
              outline: 'none', resize: 'vertical',
              fontFamily: monoFont, fontSize: fonts.secondarySize, lineHeight: 1.6,
              tabSize: 2, boxSizing: 'border-box',
            }}
          />

          <div style={{ fontSize: 10, color: theme.text.disabled, lineHeight: 1.6 }}>
            Override only the tokens you want. Properties: <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>family</span>, <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>size</span>, <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>lineHeight</span>, <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>weight</span>, <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>letterSpacing</span>. Unset tokens inherit from General. <span style={{ color: theme.text.disabled }}>Cmd+S</span> to save.
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 360, overflowY: 'auto' }}>
          {(['primary', 'secondary', 'mono'] as const).map(key => {
            const token = settings.fonts?.[key] ?? DEFAULT_FONTS[key]
            const desc = key === 'primary' ? 'Main UI text' : key === 'secondary' ? 'Metadata & labels' : 'Terminal & code'
            return (
              <div
                key={key}
                onClick={() => insertToken(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                  background: theme.surface.panelMuted,
                  border: `1px solid ${theme.border.subtle}`,
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = theme.surface.hover }}
                onMouseLeave={e => { e.currentTarget.style.background = theme.surface.panelMuted }}
                title={`Click to add "${key}" to editor`}
              >
                <span style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, fontFamily: monoFont, width: 100, flexShrink: 0 }}>{key}</span>
                <span style={{ fontSize: 10, color: theme.text.disabled, flex: 1 }}>{desc}</span>
                <span style={{ fontSize: 9, color: theme.text.muted, fontFamily: monoFont, flexShrink: 0 }}>{token.size}px</span>
                <span style={{ fontSize: Math.min(token.size, 14), color: theme.text.secondary, fontFamily: token.family, fontWeight: token.weight, flexShrink: 0 }} title={token.family}>Abc</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
