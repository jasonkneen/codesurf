import { useEffect } from 'react'
import { getEdgeShadow, type AppTheme } from '../theme'

export type AppFonts = {
  primary: string
  secondary: string
  mono: string
  size: number
  lineHeight: number
  weight: number
  secondarySize: number
  secondaryLineHeight: number
  secondaryWeight: number
  monoSize: number
  monoLineHeight: number
  monoWeight: number
}

/** Publish active theme + font tokens as CSS custom properties on `<html>`. */
export function useAppThemeCssVars(theme: AppTheme, appFonts: AppFonts) {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const isDark = theme.mode === 'dark'
    const setVar = (name: string, value: string) => root.style.setProperty(name, value)
    setVar('--cs-th-app', theme.surface.app)
    setVar('--cs-th-sidebar', theme.surface.sidebar)
    setVar('--cs-th-panel', theme.surface.panel)
    setVar('--cs-th-panel-muted', theme.surface.panelMuted)
    setVar('--cs-th-panel-elevated', theme.surface.panelElevated)
    setVar('--cs-th-input', theme.surface.input)
    setVar('--cs-th-text-primary', theme.text.primary)
    setVar('--cs-th-text-muted', theme.text.muted)
    setVar('--cs-th-text-inverse', theme.text.inverse)
    setVar('--cs-th-border-subtle', theme.border.subtle)
    setVar('--cs-th-border-default', theme.border.default)
    setVar('--cs-th-border-strong', theme.border.strong)
    setVar('--cs-th-accent-base', theme.accent.base)
    setVar('--cs-th-status-danger', theme.status.danger)
    setVar('--cs-th-status-success', theme.status.success)
    setVar('--cs-th-status-warning', theme.status.warning)
    // Edge shadow alpha channels — mirror the ladder in `getEdgeShadow()`
    // (theme.ts). Light mode uses a darker outer keyline; dark mode uses one
    // visible 0.5px light keyline so unfocused prompt/settings borders don't double up.
    setVar('--cs-th-edge-white-alpha', isDark ? '0' : '0.62')
    setVar('--cs-th-edge-white-alpha-subtle', isDark ? '0' : '0.52')
    setVar('--cs-th-edge-white-alpha-strong', isDark ? '0' : '0.74')
    setVar('--cs-th-edge-outer-rgb', isDark ? '255 255 255' : '0 0 0')
    setVar('--cs-th-edge-black-alpha', isDark ? '0.16' : '0.10')
    setVar('--cs-th-edge-black-alpha-subtle', isDark ? '0.10' : '0.08')
    setVar('--cs-th-edge-black-alpha-strong', isDark ? '0.20' : '0.12')
    // Scrollbar thumb — anchor on text colour with low alpha so it stays
    // visible against any surface and tracks contrast.
    setVar('--cs-th-scrollbar-thumb', isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.22)')
    setVar('--cs-th-scrollbar-thumb-hover', isDark ? 'rgba(255,255,255,0.26)' : 'rgba(15,23,42,0.34)')
  }, [theme])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.style.setProperty('--color-background', theme.chat.background)
    root.style.setProperty('--color-foreground', theme.text.primary)
    root.style.setProperty('--color-muted', theme.surface.panelMuted)
    root.style.setProperty('--color-muted-foreground', theme.text.muted)
    root.style.setProperty('--color-border', theme.border.default)
    root.style.setProperty('--color-input', theme.chat.inputBorder)
    root.style.setProperty('--color-ring', theme.accent.base)
    root.style.setProperty('--color-primary', theme.accent.base)
    root.style.setProperty('--color-primary-foreground', theme.text.inverse)
    root.style.setProperty('--color-secondary', theme.surface.panelElevated)
    root.style.setProperty('--color-secondary-foreground', theme.text.secondary)
    root.style.setProperty('--color-accent', theme.surface.hover)
    root.style.setProperty('--color-accent-foreground', theme.text.primary)
    root.style.setProperty('--color-destructive', theme.status.danger)
    root.style.setProperty('--color-destructive-foreground', theme.text.inverse)
    root.style.setProperty('--color-card', theme.surface.panel)
    root.style.setProperty('--color-card-foreground', theme.text.primary)
    root.style.setProperty('--color-popover', theme.surface.panel)
    root.style.setProperty('--color-popover-foreground', theme.text.primary)
    root.style.setProperty('--color-sidebar', theme.surface.panelMuted)
    // Tooltip theme variables — read by useTitleTooltips via getComputedStyle(:root)
    root.style.setProperty('--tooltip-bg', theme.surface.panelElevated)
    root.style.setProperty('--tooltip-fg', theme.text.secondary)
    root.style.setProperty('--tooltip-border', theme.border.default)
    root.style.setProperty('--tooltip-shadow', theme.mode === 'light'
      ? '0 4px 14px rgba(15,23,42,0.12)'
      : '0 2px 8px rgba(0,0,0,0.4)')
    root.style.setProperty('--cs-edge-shadow', getEdgeShadow(theme))
    root.style.setProperty('--cs-edge-shadow-subtle', getEdgeShadow(theme, 'subtle'))
    root.style.setProperty('--cs-edge-shadow-strong', getEdgeShadow(theme, 'strong'))
    root.style.setProperty('--cs-edge-shadow-accent', getEdgeShadow(theme, 'accent'))
    root.style.setProperty('--cs-font-primary', appFonts.primary)
    root.style.setProperty('--cs-font-secondary', appFonts.secondary)
    root.style.setProperty('--cs-font-mono', appFonts.mono)
    root.style.setProperty('--font-sans', appFonts.primary)
    root.style.setProperty('--font-mono', appFonts.mono)
    root.style.fontFamily = appFonts.primary
    if (document.body) document.body.style.fontFamily = appFonts.primary
    root.style.setProperty('--ct-font-primary', appFonts.primary)
    root.style.setProperty('--ct-font-primary-size', `${appFonts.size}px`)
    root.style.setProperty('--ct-font-primary-line', String(appFonts.lineHeight))
    root.style.setProperty('--ct-font-primary-weight', String(appFonts.weight))
    root.style.setProperty('--ct-font-secondary', appFonts.secondary)
    root.style.setProperty('--ct-font-secondary-size', `${appFonts.secondarySize}px`)
    root.style.setProperty('--ct-font-secondary-line', String(appFonts.secondaryLineHeight))
    root.style.setProperty('--ct-font-secondary-weight', String(appFonts.secondaryWeight))
    root.style.setProperty('--ct-font-mono', appFonts.mono)
    root.style.setProperty('--ct-font-mono-size', `${appFonts.monoSize}px`)
    root.style.setProperty('--ct-font-mono-line', String(appFonts.monoLineHeight))
    root.style.setProperty('--ct-font-mono-weight', String(appFonts.monoWeight))
    root.style.setProperty('--ct-font-sans', appFonts.primary)
    root.style.setProperty('--ct-font-size', `${appFonts.size}px`)
    root.style.setProperty('--ct-font-line', String(appFonts.lineHeight))
    root.style.setProperty('--ct-font-weight', String(appFonts.weight))
    root.style.setProperty('--ct-font-subtle', appFonts.secondary)
    root.style.setProperty('--ct-font-subtle-size', `${appFonts.secondarySize}px`)
    root.style.setProperty('--ct-font-subtle-line', String(appFonts.secondaryLineHeight))
    root.style.setProperty('--ct-font-subtle-weight', String(appFonts.secondaryWeight))
  }, [theme, appFonts])
}