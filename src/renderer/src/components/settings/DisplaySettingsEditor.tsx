import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Code2, FormInput } from 'lucide-react'
import type { AppSettings, FontToken } from '../../../../shared/types'
import { DEFAULT_FONTS, withDefaultSettings } from '../../../../shared/types'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import { CompactFontRow, MONO_FONTS, SANS_FONTS, SectionLabel, SettingRow } from './controls'

// The in-panel JSON editor is hidden: users can edit settings.json directly.
// Flip to `true` to restore the Display / JSON tab switcher + raw editor.
const SHOW_JSON_EDITOR = false

function buildDisplayJson(settings: AppSettings): string {
  return JSON.stringify({
    appearance: settings.appearance,
    themeId: settings.themeId,
    fonts: {
      primary: settings.fonts.primary,
      secondary: settings.fonts.secondary,
      mono: settings.fonts.mono,
    },
  }, null, 2)
}

function validateTokenLike(value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`
  const validProps = new Set(['family', 'size', 'lineHeight', 'weight', 'letterSpacing'])
  const invalidProps = Object.keys(value as object).filter(key => !validProps.has(key))
  if (invalidProps.length > 0) return `${path} has unknown propert${invalidProps.length > 1 ? 'ies' : 'y'}: ${invalidProps.join(', ')}`
  const token = value as Record<string, unknown>
  if (token.family !== undefined && typeof token.family !== 'string') return `${path}.family must be a string`
  if (token.size !== undefined && (typeof token.size !== 'number' || token.size < 1 || token.size > 72)) return `${path}.size must be 1-72`
  if (token.lineHeight !== undefined && (typeof token.lineHeight !== 'number' || token.lineHeight < 0.5 || token.lineHeight > 4)) return `${path}.lineHeight must be 0.5-4`
  if (token.weight !== undefined && (typeof token.weight !== 'number' || token.weight < 100 || token.weight > 900)) return `${path}.weight must be 100-900`
  if (token.letterSpacing !== undefined && typeof token.letterSpacing !== 'number') return `${path}.letterSpacing must be a number`
  return null
}

function validateDisplayJson(value: string): { ok: true; parsed: Partial<AppSettings> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'Must be a JSON object' }
    }

    const topLevel = new Set(['appearance', 'themeId', 'fonts'])
    const invalidTopLevel = Object.keys(parsed).filter(key => !topLevel.has(key))
    if (invalidTopLevel.length > 0) {
      return { ok: false, error: `Unknown key${invalidTopLevel.length > 1 ? 's' : ''}: ${invalidTopLevel.join(', ')}` }
    }

    const config = parsed as Record<string, unknown>
    if (config.appearance !== undefined) {
      if (config.appearance !== 'dark' && config.appearance !== 'light' && config.appearance !== 'system') {
        return { ok: false, error: 'appearance must be "dark", "light", or "system"' }
      }
    }
    if (config.themeId !== undefined && typeof config.themeId !== 'string') {
      return { ok: false, error: 'themeId must be a string' }
    }

    if (config.fonts !== undefined) {
      if (typeof config.fonts !== 'object' || config.fonts === null || Array.isArray(config.fonts)) {
        return { ok: false, error: 'fonts must be an object' }
      }
      const validTokenKeys = new Set(Object.keys(DEFAULT_FONTS))
      const invalidTokenKeys = Object.keys(config.fonts as object).filter(key => !validTokenKeys.has(key))
      if (invalidTokenKeys.length > 0) {
        return { ok: false, error: `Unknown font token${invalidTokenKeys.length > 1 ? 's' : ''}: ${invalidTokenKeys.join(', ')}` }
      }
      for (const [tokenKey, tokenVal] of Object.entries(config.fonts as Record<string, unknown>)) {
        const error = validateTokenLike(tokenVal, `fonts.${tokenKey}`)
        if (error) return { ok: false, error }
      }
    }

    return { ok: true, parsed: parsed as Partial<AppSettings> }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid JSON' }
  }
}

export function DisplaySettingsEditor({
  settings,
  onApply,
  updateState,
  onCheckForUpdates,
  onDownloadUpdate,
}: {
  settings: AppSettings
  onApply: (patch: Partial<AppSettings>) => void
  updateState: { checking: boolean; downloading: boolean; result: null | { ok: boolean; currentVersion: string; status: string; updateAvailable: boolean; updateInfo?: { version?: string; releaseName?: string; releaseDate?: string } } }
  onCheckForUpdates: () => void
  onDownloadUpdate: () => void
}): React.JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [view, setView] = useState<'display' | 'json'>('display')
  const [rawJson, setRawJson] = useState(() => buildDisplayJson(settings))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [configPath, setConfigPath] = useState('')
  const jsonSyncTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (typeof window.electron.settings.getRawJson !== 'function') return
    window.electron.settings.getRawJson().then(({ path }) => setConfigPath(path)).catch(() => {})
  }, [])

  useEffect(() => {
    const next = buildDisplayJson(settings)
    setRawJson(current => current === next ? current : next)
  }, [settings])

  useEffect(() => {
    if (jsonSyncTimeoutRef.current) window.clearTimeout(jsonSyncTimeoutRef.current)
    const validation = validateDisplayJson(rawJson)
    if (!validation.ok) {
      setJsonError(validation.error)
      return
    }
    setJsonError(null)
    jsonSyncTimeoutRef.current = window.setTimeout(() => {
      onApply(withDefaultSettings({ ...settings, ...validation.parsed }))
    }, 180)
    return () => {
      if (jsonSyncTimeoutRef.current) window.clearTimeout(jsonSyncTimeoutRef.current)
    }
  }, [onApply, rawJson, settings])

  const updateFont = useCallback((key: 'primary' | 'secondary' | 'mono', next: FontToken) => {
    onApply({ fonts: { ...settings.fonts, [key]: next } } as Partial<AppSettings>)
  }, [onApply, settings.fonts])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {SHOW_JSON_EDITOR && (
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.border.default}`, paddingBottom: 8 }}>
        {[
          { id: 'display' as const, label: 'Display', icon: <FormInput size={14} /> },
          { id: 'json' as const, label: 'JSON', icon: <Code2 size={14} /> },
        ].map(tab => {
          const isActive = view === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setView(tab.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                height: 28,
                padding: '0 11px',
                borderRadius: 7,
                border: `1px solid ${isActive ? theme.border.strong : 'transparent'}`,
                background: isActive ? theme.surface.panelElevated : 'transparent',
                color: isActive ? theme.accent.base : theme.text.muted,
                cursor: 'pointer',
                fontSize: fonts.secondarySize,
                fontWeight: isActive ? 700 : 500,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
                transition: 'color 0.15s, background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  e.currentTarget.style.background = theme.surface.hover
                  e.currentTarget.style.color = theme.text.secondary
                  e.currentTarget.style.borderColor = theme.border.default
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = theme.text.muted
                  e.currentTarget.style.borderColor = 'transparent'
                }
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          )
        })}
      </div>
      )}

      {(!SHOW_JSON_EDITOR || view === 'display') ? (
        <>
          <SectionLabel label="Fonts" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CompactFontRow label="Primary" description="Main UI text, headings, chat messages" token={settings.fonts.primary} fontOptions={SANS_FONTS} onChange={next => updateFont('primary', next)} />
            <CompactFontRow label="Secondary" description="Metadata, subtitles, labels, smaller text" token={settings.fonts.secondary} fontOptions={SANS_FONTS} onChange={next => updateFont('secondary', next)} />
            <CompactFontRow label="Monospace" description="Terminal, code editor, data display" token={settings.fonts.mono} fontOptions={MONO_FONTS} onChange={next => updateFont('mono', next)} />
          </div>

          <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            padding: '12px 14px',
            background: theme.surface.panelMuted,
            border: `1px solid ${theme.border.subtle}`,
            borderRadius: 10,
          }}>
            <div style={{ fontSize: fonts.secondarySize - 2, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1.2, textTransform: 'uppercase' }}>Preview</div>
            <div style={{
              fontFamily: settings.fonts.primary.family,
              fontSize: settings.fonts.primary.size,
              fontWeight: settings.fonts.primary.weight ?? 400,
              lineHeight: settings.fonts.primary.lineHeight,
              color: theme.text.primary,
            }}>
              Primary: The quick brown fox jumps over the lazy dog
            </div>
            <div style={{
              fontFamily: settings.fonts.secondary.family,
              fontSize: settings.fonts.secondary.size,
              fontWeight: settings.fonts.secondary.weight ?? 400,
              lineHeight: settings.fonts.secondary.lineHeight,
              color: theme.text.secondary,
            }}>
              Secondary: Metadata, labels, and smaller interface text
            </div>
            <div style={{
              fontFamily: settings.fonts.mono.family,
              fontSize: settings.fonts.mono.size,
              fontWeight: settings.fonts.mono.weight ?? 400,
              lineHeight: settings.fonts.mono.lineHeight,
              color: theme.text.muted,
            }}>
              Mono: const result = await fetch('/api/data')
            </div>
          </div>

          <SectionLabel label="Updates" />
          <SettingRow label="Current version" description="Installed desktop build version">
            <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>{updateState.result?.currentVersion ?? __VERSION__}</span>
          </SettingRow>
          <SettingRow label="Check for updates" description="Look for a newer GitHub release and show install actions here">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={onCheckForUpdates}
                disabled={updateState.checking}
                style={{
                  padding: '7px 12px',
                  fontSize: fonts.secondarySize,
                  background: updateState.checking ? theme.surface.panelMuted : theme.surface.panelElevated,
                  color: updateState.checking ? theme.text.disabled : theme.text.secondary,
                  border: `1px solid ${theme.border.default}`,
                  borderRadius: 8,
                  cursor: updateState.checking ? 'default' : 'pointer',
                }}
              >
                {updateState.checking ? 'Checking…' : 'Check now'}
              </button>
              {updateState.result?.updateAvailable && (
                <button
                  onClick={onDownloadUpdate}
                  disabled={updateState.downloading}
                  style={{
                    padding: '7px 12px',
                    fontSize: fonts.secondarySize,
                    background: updateState.downloading ? theme.surface.panelMuted : theme.surface.panelElevated,
                    color: updateState.downloading ? theme.text.disabled : theme.status.warning,
                    border: `1px solid ${theme.border.default}`,
                    borderRadius: 8,
                    cursor: updateState.downloading ? 'default' : 'pointer',
                  }}
                >
                  {updateState.downloading ? 'Downloading…' : 'Download'}
                </button>
              )}
              {updateState.result?.status === 'downloaded' && (
                <button
                  onClick={() => window.electron.updater.quitAndInstall()}
                  style={{
                    padding: '7px 12px',
                    fontSize: fonts.secondarySize,
                    background: theme.surface.panelElevated,
                    color: theme.status.success,
                    border: `1px solid ${theme.border.default}`,
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                >
                  Restart to install
                </button>
              )}
            </div>
          </SettingRow>
          {updateState.result && (
            <div style={{ marginBottom: 8, padding: '12px 16px', background: theme.surface.panel, borderRadius: 10, border: `1px solid ${theme.border.default}` }}>
              <div style={{ fontSize: fonts.secondarySize, color: updateState.result.ok ? theme.text.muted : theme.status.danger }}>
                {updateState.result.updateAvailable
                  ? `Update available${updateState.result.updateInfo?.version ? `: ${updateState.result.updateInfo.version}` : ''}`
                  : updateState.result.status === 'up-to-date'
                    ? 'You are up to date.'
                    : updateState.result.status}
              </div>
              {updateState.result.updateInfo?.releaseDate && (
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, marginTop: 4 }}>
                  Released {new Date(updateState.result.updateInfo.releaseDate).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Code2 size={14} color={theme.text.muted} />
            <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono }}>{configPath || 'settings.json'}</span>
            <span style={{ fontSize: 9, color: theme.accent.base, fontFamily: fonts.mono }}>settings.display</span>
            {jsonError && (
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: theme.status.danger, fontSize: fonts.secondarySize }}>
                <AlertTriangle size={12} />
                {jsonError}
              </span>
            )}
          </div>
          <textarea
            value={rawJson}
            onChange={e => setRawJson(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 520,
              padding: '12px 14px', borderRadius: 10,
              background: theme.surface.panelMuted, color: jsonError ? theme.status.danger : theme.text.primary,
              border: `1px solid ${jsonError ? `${theme.status.danger}44` : theme.surface.panelMuted}`,
              outline: 'none', resize: 'vertical',
              fontFamily: fonts.mono, fontSize: fonts.secondarySize, lineHeight: 1.6,
              tabSize: 2, boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, lineHeight: 1.6 }}>
            Edit the display settings as JSON. Valid top-level keys: <span style={{ fontFamily: fonts.mono }}>appearance</span>, <span style={{ fontFamily: fonts.mono }}>themeId</span>, <span style={{ fontFamily: fonts.mono }}>fonts</span> (with <span style={{ fontFamily: fonts.mono }}>primary</span>, <span style={{ fontFamily: fonts.mono }}>secondary</span>, <span style={{ fontFamily: fonts.mono }}>mono</span>). The form and JSON stay in sync when the JSON is valid.
          </div>
        </div>
      )}
    </div>
  )
}
