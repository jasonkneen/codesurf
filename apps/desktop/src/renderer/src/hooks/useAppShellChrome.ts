/**
 * App shell chrome — theme resolution + shell layout metrics in one place
 * so App.tsx does not re-own that composition.
 */

import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, Workspace } from '../../../shared/types'
import type { PanelNode } from '../components/panelLayoutTree'
import {
  applyContrast,
  getThemeById,
  resolveEffectiveThemeId,
} from '../theme'
import { SANS_DEFAULT, MONO_DEFAULT } from '../FontContext'
import { useAppThemeCssVars, type AppFonts } from './useAppThemeCssVars'
import { useBrandWordmarkPrefs } from './useBrandWordmarkPrefs'
import {
  useShellLayoutMetrics,
  type ShellLayoutMetrics,
} from './useShellLayoutMetrics'

export type UseAppShellChromeParams = {
  settings: AppSettings
  sidebarCollapsed: boolean
  sidebarWidth: number
  panelLayout: PanelNode | null
  openWorkspaceIds: string[]
  workspaces: Workspace[]
  workspace: Workspace | null
  showWorkspacePickerTab: boolean
}

export type UseAppShellChromeResult = {
  appFonts: AppFonts
  fontTokens: AppSettings['fonts']
  effectiveThemeId: string
  theme: ReturnType<typeof applyContrast>
  systemPrefersDark: boolean
} & ShellLayoutMetrics

export function useAppShellChrome(params: UseAppShellChromeParams): UseAppShellChromeResult {
  const {
    settings,
    sidebarCollapsed,
    sidebarWidth,
    panelLayout,
    openWorkspaceIds,
    workspaces,
    workspace,
    showWorkspacePickerTab,
  } = params

  const [systemPrefersDark, setSystemPrefersDark] = useState(false)

  const appFonts = useMemo(() => {
    const p = settings.fonts?.primary ?? settings.primaryFont
    const s = settings.fonts?.secondary ?? settings.secondaryFont
    const m = settings.fonts?.mono ?? settings.monoFont
    return {
      primary: p?.family ?? SANS_DEFAULT,
      secondary: s?.family ?? SANS_DEFAULT,
      mono: m?.family ?? MONO_DEFAULT,
      size: p?.size ?? 13,
      lineHeight: p?.lineHeight ?? 1.5,
      weight: p?.weight ?? 400,
      secondarySize: s?.size ?? 11,
      secondaryLineHeight: s?.lineHeight ?? 1.4,
      secondaryWeight: s?.weight ?? 400,
      monoSize: m?.size ?? 13,
      monoLineHeight: m?.lineHeight ?? 1.5,
      monoWeight: m?.weight ?? 400,
    }
  }, [settings.fonts, settings.primaryFont, settings.secondaryFont, settings.monoFont])

  useEffect(() => {
    void window.electron?.window?.setSidebarCollapsed?.(sidebarCollapsed).catch(() => {})
  }, [sidebarCollapsed])

  const fontTokens = useMemo(() => settings.fonts, [settings.fonts])

  useEffect(() => {
    void window.electron?.appearance?.shouldUseDark?.().then(setSystemPrefersDark).catch(() => {})
    const unsub = window.electron?.appearance?.onUpdated?.(p => setSystemPrefersDark(p.shouldUseDark))
    return unsub
  }, [])

  useEffect(() => {
    const mode = settings.appearance ?? 'dark'
    void window.electron?.appearance?.setThemeSource?.(mode)
  }, [settings.appearance])

  const effectiveThemeId = useMemo(
    () => resolveEffectiveThemeId(settings.appearance, settings.themeId, systemPrefersDark),
    [settings.appearance, settings.themeId, systemPrefersDark],
  )
  const theme = useMemo(
    () => applyContrast(getThemeById(effectiveThemeId), settings.themeContrast ?? 0),
    [effectiveThemeId, settings.themeContrast],
  )

  useAppThemeCssVars(theme, appFonts)
  useBrandWordmarkPrefs(effectiveThemeId, theme.mode)

  const layout = useShellLayoutMetrics({
    settings,
    theme,
    sidebarCollapsed,
    sidebarWidth,
    panelLayout,
    openWorkspaceIds,
    workspaces,
    workspace,
    showWorkspacePickerTab,
    appFonts,
  })

  return {
    appFonts,
    fontTokens,
    effectiveThemeId,
    theme,
    systemPrefersDark,
    ...layout,
  }
}
