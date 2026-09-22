/**
 * Extensions settings section — extracted from SettingsPanel's `case 'extensions'`
 * render closure (god-object split). theme/fonts via context; extension list +
 * per-extension settings state and callbacks via props. Owns the
 * ExtensionListEntry type (re-imported by SettingsPanel).
 */
import React from 'react'
import { Eye, EyeOff, PanelRight, Pin, RefreshCw, Settings } from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { SectionLabel, Toggle } from './controls'
import { SettingsControl } from '../codesurf-ui'
import type { AppSettings, Workspace } from '../../../../shared/types'

export type ExtensionListEntry = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  tier: 'safe' | 'power'
  ui?: import('../../../../shared/types').ExtensionManifest['ui']
  enabled: boolean
  contributes?: import('../../../../shared/types').ExtensionManifest['contributes']
  dirPath?: string | null
}

export interface ExtensionsSectionProps {
  extensionsList: ExtensionListEntry[]
  extensionsLoading: boolean
  extensionsError: string | null
  expandedExtId: string | null
  setExpandedExtId: React.Dispatch<React.SetStateAction<string | null>>
  extSettingsMap: Record<string, Record<string, unknown>>
  setExtSettingsMap: React.Dispatch<React.SetStateAction<Record<string, Record<string, unknown>>>>
  toggleExtensionEnabled: (extId: string, nextEnabled: boolean) => void | Promise<void>
  refreshExtensions: () => void | Promise<void>
  settings: AppSettings
  updateSettingsPatch: (patch: Partial<AppSettings>) => void
  workspaces: Workspace[]
}

export function ExtensionsSection(props: ExtensionsSectionProps): React.JSX.Element {
  const {
    extensionsList,
    extensionsLoading,
    extensionsError,
    expandedExtId,
    setExpandedExtId,
    extSettingsMap,
    setExtSettingsMap,
    toggleExtensionEnabled,
    refreshExtensions,
    settings,
    updateSettingsPatch,
    workspaces,
  } = props
  const theme = useTheme()
  const fonts = useAppFonts()

        return (
          <>
            <SectionLabel label="Installed extensions" />
            {/* Master kill-switch */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', marginBottom: 12, borderRadius: 10,
              background: settings.extensionsDisabled ? 'rgba(244,71,71,0.08)' : theme.surface.panelMuted,
              border: `1px solid ${settings.extensionsDisabled ? 'rgba(244,71,71,0.25)' : theme.border.default}`,
              transition: 'background 0.15s, border-color 0.15s',
            }}>
              <div>
                <div style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>Disable all plugins</div>
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginTop: 2 }}>
                  {settings.extensionsDisabled ? 'Plugins are hidden from the sidebar and footer' : 'Hide all plugins from the sidebar and footer'}
                </div>
              </div>
              <Toggle value={settings.extensionsDisabled ?? false} onChange={v => updateSettingsPatch({ extensionsDisabled: v })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, lineHeight: 1.45, flex: 1, minWidth: 200 }}>
                Plugins load from <code style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>~/.codesurf/extensions</code>
                {workspaces.length > 0 && (
                  <> and the active workspace&apos;s <code style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>.codesurf/extensions</code></>
                )}
                . Disable a power plugin to unload its main process code; use Refresh after adding folders.
              </div>
              <button
                type="button"
                onClick={() => { void refreshExtensions() }}
                disabled={extensionsLoading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 12px', borderRadius: 8, fontSize: fonts.secondarySize, fontWeight: 600,
                  cursor: extensionsLoading ? 'wait' : 'pointer',
                  background: theme.surface.input,
                  color: theme.text.secondary,
                  border: `1px solid ${theme.border.default}`,
                  flexShrink: 0,
                }}
              >
                <RefreshCw size={14} style={{ opacity: extensionsLoading ? 0.5 : 1 }} />
                Rescan
              </button>
            </div>

            {extensionsError && (
              <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(244,71,71,0.12)', border: '1px solid rgba(244,71,71,0.35)', fontSize: fonts.secondarySize, color: '#f48771' }}>
                {extensionsError}
              </div>
            )}

            {extensionsLoading && extensionsList.length === 0 ? (
              <div style={{ fontSize: fonts.size, color: theme.text.muted, padding: '12px 0' }}>Loading extensions…</div>
            ) : extensionsList.length === 0 ? (
              <div style={{ fontSize: fonts.size, color: theme.text.disabled, padding: '16px', background: theme.surface.panelMuted, borderRadius: 10, border: `1px dashed ${theme.border.default}` }}>
                No extensions found. Add a folder under <span style={{ fontFamily: fonts.mono, fontSize: fonts.secondarySize }}>~/.codesurf/extensions</span> with an <span style={{ fontFamily: fonts.mono, fontSize: fonts.secondarySize }}>extension.json</span> manifest.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {extensionsList.map(ext => {
                  const tiles = ext.contributes?.tiles?.length ?? 0
                  const menus = ext.contributes?.contextMenu?.length ?? 0
                  const extSettings = ext.contributes?.settings ?? []
                  const extSettingsSections = ext.contributes?.settingsSections ?? []
                  const hasAnySettings = extSettings.length > 0 || extSettingsSections.length > 0
                  const isHiddenFromSidebar = (settings.hiddenFromSidebarExtIds ?? []).includes(ext.id)
                  const isInSettingsPanel = (settings.settingsPanelExtIds ?? []).includes(ext.id)
                  const isPinned = (settings.pinnedExtensionIds ?? []).includes(ext.id)
                  const isExpanded = expandedExtId === ext.id
                  const savedExtSettings = extSettingsMap[ext.id] ?? {}
                  return (
                    <div
                      key={ext.id}
                      style={{
                        background: theme.surface.panelMuted,
                        borderRadius: 10,
                        border: `1px solid ${isExpanded ? theme.border.strong : theme.border.default}`,
                        overflow: 'hidden',
                        transition: 'border-color 0.15s',
                      }}
                    >
                      {/* Card header row */}
                      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                            <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>{ext.name}</span>
                            <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>v{ext.version}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
                              padding: '2px 6px', borderRadius: 4,
                              background: ext.tier === 'power' ? 'rgba(74,158,255,0.15)' : 'rgba(63,185,80,0.12)',
                              color: ext.tier === 'power' ? '#4a9eff' : theme.status.success,
                            }}>{ext.tier}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
                              padding: '2px 6px', borderRadius: 4,
                              background: ext.ui?.mode === 'custom' ? 'rgba(251,191,36,0.15)' : theme.surface.accentSoft,
                              color: ext.ui?.mode === 'custom' ? theme.status.warning : theme.accent.base,
                            }}>{ext.ui?.mode === 'custom' ? 'custom ui' : 'core ui'}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                              background: ext.enabled ? 'rgba(63,185,80,0.12)' : 'rgba(136,136,136,0.15)',
                              color: ext.enabled ? theme.status.success : theme.text.disabled,
                            }}>{ext.enabled ? 'enabled' : 'disabled'}</span>
                          </div>
                          <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono, marginBottom: 4 }}>{ext.id}</div>
                          {ext.description && (
                            <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, lineHeight: 1.4, marginBottom: 4 }}>{ext.description}</div>
                          )}
                          <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted }}>
                            {tiles > 0 && <span>{tiles} block{tiles === 1 ? '' : 's'}</span>}
                            {tiles > 0 && menus > 0 && ' · '}
                            {menus > 0 && <span>{menus} menu item{menus === 1 ? '' : 's'}</span>}
                            {(tiles > 0 || menus > 0) && ' · '}
                            <span>{ext.ui?.mode === 'custom' ? 'bespoke extension surface' : 'host-aligned extension surface'}</span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <button
                            title={isPinned ? 'Unpin from canvas menu' : 'Pin to canvas menu'}
                            onClick={() => {
                              const next = isPinned
                                ? (settings.pinnedExtensionIds ?? []).filter(id => id !== ext.id)
                                : [...(settings.pinnedExtensionIds ?? []), ext.id]
                              updateSettingsPatch({ pinnedExtensionIds: next })
                            }}
                            style={{
                              background: isPinned ? theme.surface.accentSoft : 'none',
                              border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                              color: isPinned ? theme.accent.base : theme.text.disabled,
                              display: 'flex', alignItems: 'center', transition: 'color 0.15s, background 0.15s',
                            }}
                          >
                            <Pin size={14} />
                          </button>
                          {/* Show in sidebar toggle (ON by default) */}
                          <button
                            title={isHiddenFromSidebar ? 'Show in sidebar and footer' : 'Hide from sidebar and footer'}
                            onClick={() => {
                              const next = isHiddenFromSidebar
                                ? (settings.hiddenFromSidebarExtIds ?? []).filter(id => id !== ext.id)
                                : [...(settings.hiddenFromSidebarExtIds ?? []), ext.id]
                              updateSettingsPatch({ hiddenFromSidebarExtIds: next })
                            }}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                              color: isHiddenFromSidebar ? theme.text.disabled : theme.text.secondary,
                              display: 'flex', alignItems: 'center', transition: 'color 0.15s',
                            }}
                          >
                            {isHiddenFromSidebar ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          {/* Show as settings panel toggle */}
                          {ext.contributes?.tiles && ext.contributes.tiles.length > 0 && (
                            <button
                              title={isInSettingsPanel ? 'Remove from settings' : 'Show in settings panel'}
                              onClick={() => {
                                const next = isInSettingsPanel
                                  ? (settings.settingsPanelExtIds ?? []).filter(id => id !== ext.id)
                                  : [...(settings.settingsPanelExtIds ?? []), ext.id]
                                updateSettingsPatch({ settingsPanelExtIds: next })
                              }}
                              style={{
                                background: isInSettingsPanel ? theme.surface.accentSoft : 'none',
                                border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                                color: isInSettingsPanel ? theme.accent.base : theme.text.disabled,
                                display: 'flex', alignItems: 'center', transition: 'color 0.15s, background 0.15s',
                              }}
                            >
                              <PanelRight size={14} />
                            </button>
                          )}
                          {/* Settings cog — only show if extension declares settings */}
                          {hasAnySettings && (
                            <button
                              title="Plugin settings"
                              onClick={async () => {
                                if (isExpanded) { setExpandedExtId(null); return }
                                // Load current settings for this extension
                                const current = await window.electron.extensions?.getSettings?.(ext.id).catch(() => ({})) ?? {}
                                setExtSettingsMap(prev => ({ ...prev, [ext.id]: current }))
                                setExpandedExtId(ext.id)
                              }}
                              style={{
                                background: isExpanded ? theme.surface.accentSoft : 'none',
                                border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                                color: isExpanded ? theme.accent.base : theme.text.disabled,
                                display: 'flex', alignItems: 'center',
                                transition: 'color 0.15s, background 0.15s',
                              }}
                            >
                              <Settings size={14} />
                            </button>
                          )}
                          <Toggle value={ext.enabled} onChange={v => { void toggleExtensionEnabled(ext.id, v) }} />
                        </div>
                      </div>
                      {/* Inline settings panel */}
                      {isExpanded && hasAnySettings && (
                        <div style={{
                          borderTop: `1px solid ${theme.border.default}`,
                          padding: '12px 14px',
                          background: theme.surface.panel,
                          display: 'flex', flexDirection: 'column', gap: 10,
                        }}>
                          {extSettings.length > 0 && (
                            <div style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Settings</div>
                          )}
                          {extSettings.map((s) => (
                            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <label style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, flex: 1 }}>{s.label}</label>
                              {s.type === 'boolean' ? (
                                <Toggle
                                  value={savedExtSettings[s.key] !== undefined ? Boolean(savedExtSettings[s.key]) : Boolean(s.default)}
                                  onChange={async v => {
                                    const next = { ...savedExtSettings, [s.key]: v }
                                    setExtSettingsMap(prev => ({ ...prev, [ext.id]: next }))
                                    await window.electron.extensions?.setSettings?.(ext.id, next).catch(() => {})
                                  }}
                                />
                              ) : (
                                <input
                                  type={s.type === 'number' ? 'number' : 'text'}
                                  value={String(savedExtSettings[s.key] ?? s.default ?? '')}
                                  onChange={async e => {
                                    const val = s.type === 'number' ? Number(e.target.value) : e.target.value
                                    const next = { ...savedExtSettings, [s.key]: val }
                                    setExtSettingsMap(prev => ({ ...prev, [ext.id]: next }))
                                    await window.electron.extensions?.setSettings?.(ext.id, next).catch(() => {})
                                  }}
                                  style={{
                                    background: theme.surface.input, border: `1px solid ${theme.border.default}`,
                                    color: theme.text.primary, borderRadius: 6, padding: '4px 8px',
                                    fontSize: fonts.secondarySize, fontFamily: fonts.mono, width: 160,
                                  }}
                                />
                              )}
                            </div>
                          ))}
                          {/* v2 settings sections — declarative control union rendered with @codesurf/ui */}
                          {extSettingsSections.map((sec) => (
                            <div key={sec.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: extSettings.length > 0 ? 8 : 0 }}>
                              {sec.title && (
                                <div style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{sec.title}</div>
                              )}
                              {sec.items.map((control, i) => (
                                <SettingsControl
                                  key={('key' in control ? control.key : control.label) + ':' + i}
                                  control={control}
                                  value={'key' in control ? (savedExtSettings[control.key] ?? control.default) : undefined}
                                  onChange={async (val) => {
                                    if (!('key' in control)) return
                                    const next = { ...savedExtSettings, [control.key]: val }
                                    setExtSettingsMap(prev => ({ ...prev, [ext.id]: next }))
                                    await window.electron.extensions?.setSettings?.(ext.id, next).catch(() => {})
                                  }}
                                  onCommand={(command) => { window.dispatchEvent(new CustomEvent('codesurf:command', { detail: { extId: ext.id, id: command } })) }}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )
}
