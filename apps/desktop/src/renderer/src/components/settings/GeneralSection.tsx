/**
 * General (appearance/theme) settings section — extracted from SettingsPanel's
 * `case 'general'` render closure. theme/fonts via context; settings + theme
 * callbacks via props.
 */
import React from 'react'
import type { AppSettings } from '../../../../shared/types'
import { THEME_OPTIONS, resolveEffectiveThemeId, getThemeById, type AppearanceMode } from '../../theme'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { SectionLabel, SettingRow } from './controls'
import { DisplaySettingsEditor } from './DisplaySettingsEditor'

export type UpdateState = {
  checking: boolean
  downloading: boolean
  result: null | { ok: boolean; currentVersion: string; status: string; updateAvailable: boolean; updateInfo?: { version?: string; releaseName?: string; releaseDate?: string } }
}

export interface GeneralSectionProps {
  settings: AppSettings
  updateSettingsPatch: (patch: Partial<AppSettings>) => void
  applyAppearanceMode: (mode: AppearanceMode) => void
  applyThemePreset: (themeId: string) => void
  systemPrefersDark: boolean
  updateState: UpdateState
  checkForUpdates: () => void | Promise<void>
  downloadUpdate: () => void | Promise<void>
  onClose: () => void
}

export function GeneralSection(props: GeneralSectionProps): React.JSX.Element {
  const {
    settings,
    updateSettingsPatch,
    applyAppearanceMode,
    applyThemePreset,
    systemPrefersDark,
    updateState,
    checkForUpdates,
    downloadUpdate,
    onClose,
  } = props
  const theme = useTheme()
  const fonts = useAppFonts()

        const resolvedThemeId = resolveEffectiveThemeId(settings.appearance ?? 'dark', settings.themeId, systemPrefersDark)
        const resolvedUiMode = getThemeById(resolvedThemeId).mode
        const presetOptions = THEME_OPTIONS.filter(o => o.mode === resolvedUiMode)
        const appearanceMode = settings.appearance ?? 'dark'
        return (
          <>
            <SectionLabel label="Theme" />
            <SettingRow label="Mode" description="Dark uses the palette below. Light uses the Paper Light theme. System follows your OS dark/light setting.">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(['dark', 'light', 'system'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => applyAppearanceMode(mode)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 8,
                      fontSize: fonts.secondarySize,
                      fontWeight: 600,
                      border: `1px solid ${appearanceMode === mode ? theme.accent.base : theme.border.default}`,
                      background: appearanceMode === mode ? theme.accent.soft : theme.surface.input,
                      color: appearanceMode === mode ? theme.accent.hover : theme.text.secondary,
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {mode === 'system' ? 'System' : mode}
                  </button>
                ))}
              </div>
            </SettingRow>
            <SettingRow label="Preset" description="Changes block chrome, terminal colours, shell surfaces, and resets the canvas palette to the preset defaults. Presets match the current light or dark mode.">
              <select
                value={resolvedThemeId}
                onChange={e => applyThemePreset(e.target.value)}
                style={{
                  minWidth: 220,
                  padding: '6px 10px',
                  fontSize: fonts.secondarySize,
                  background: theme.surface.input,
                  color: theme.text.secondary,
                  border: `1px solid ${theme.border.default}`,
                  borderRadius: 8,
                  outline: 'none',
                }}
              >
                {presetOptions.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {option.mode}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow
              label="Contrast"
              description="Push surfaces and text apart (positive) or compress them toward mid-grey (negative). 0 keeps the preset's natural contrast."
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 240 }}>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={settings.themeContrast ?? 0}
                  onChange={e => updateSettingsPatch({ themeContrast: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: theme.accent.base, cursor: 'pointer' }}
                  aria-label="Theme contrast"
                />
                <button
                  type="button"
                  onClick={() => updateSettingsPatch({ themeContrast: 0 })}
                  title="Reset contrast to preset default"
                  style={{
                    padding: '4px 10px',
                    fontSize: fonts.secondarySize,
                    background: theme.surface.input,
                    color: theme.text.secondary,
                    border: `1px solid ${theme.border.default}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                  }}
                >
                  Reset
                </button>
                <span
                  style={{
                    minWidth: 44,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: fonts.secondarySize,
                    color: theme.text.muted,
                  }}
                >
                  {((settings.themeContrast ?? 0) >= 0 ? '+' : '') + (settings.themeContrast ?? 0).toFixed(2)}
                </span>
              </div>
            </SettingRow>
            <DisplaySettingsEditor
              settings={settings}
              onApply={updateSettingsPatch}
              updateState={updateState}
              onCheckForUpdates={checkForUpdates}
              onDownloadUpdate={downloadUpdate}
            />
            <SettingRow
              label="Welcome screen"
              description="Replay the first-run welcome and feature tour."
            >
              <button
                onClick={() => { updateSettingsPatch({ onboardingComplete: false }); onClose() }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 8,
                  border: `1px solid ${theme.border.default}`,
                  background: theme.surface.panelMuted,
                  color: theme.text.primary, cursor: 'pointer',
                  fontSize: fonts.size, fontWeight: 600,
                }}
              >
                Show welcome
              </button>
            </SettingRow>
          </>
        )
}
