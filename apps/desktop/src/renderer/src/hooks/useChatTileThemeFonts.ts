import { useMemo } from 'react'
import type { AppSettings } from '../../../shared/types'
import { useTheme } from '../ThemeContext'
import {
  FONT_SANS,
  FONT_MONO,
  FONT_SIZE_DEFAULT,
  MONO_SIZE_DEFAULT,
} from '../components/chat/chatTileLayout'

export function useChatTileThemeFonts(settings?: AppSettings) {
  const theme = useTheme()

  const fontSans = settings?.fonts?.primary?.family ?? settings?.primaryFont?.family ?? FONT_SANS
  const fontMono = settings?.fonts?.mono?.family ?? settings?.monoFont?.family ?? FONT_MONO
  const fontSize = settings?.fonts?.primary?.size ?? settings?.primaryFont?.size ?? FONT_SIZE_DEFAULT
  const fontLineHeight = settings?.fonts?.primary?.lineHeight ?? 1.5
  const fontWeight = settings?.fonts?.primary?.weight ?? 400
  const monoSize = settings?.fonts?.mono?.size ?? settings?.monoFont?.size ?? MONO_SIZE_DEFAULT
  const monoLineHeight = settings?.fonts?.mono?.lineHeight ?? 1.5
  const monoWeight = settings?.fonts?.mono?.weight ?? 400
  const fontSecondary = settings?.fonts?.secondary?.family ?? settings?.secondaryFont?.family ?? FONT_SANS
  const secondarySize = settings?.fonts?.secondary?.size ?? 11
  const secondaryLineHeight = settings?.fonts?.secondary?.lineHeight ?? 1.4
  const secondaryWeight = settings?.fonts?.secondary?.weight ?? 400

  const chatViewportBackground = theme.surface.panel
  const composerBackground = theme.mode === 'dark'
    ? theme.chat.input
    : `color-mix(in srgb, ${theme.surface.panelMuted} 82%, ${theme.chat.input})`
  const composerBorder = theme.chat.inputBorder

  const chatSurfaceThemeColors = useMemo(() => ({
    background: theme.surface.panelElevated,
    panel: theme.surface.panelElevated,
    border: theme.border.default,
    text: theme.chat.text,
    muted: theme.chat.muted,
    accent: theme.accent.base,
    mode: theme.mode,
    success: theme.status.success,
    warning: theme.status.warning,
    danger: theme.status.danger,
  }), [theme])

  const chatSurfaceThemeVars = useMemo(() => ({
    '--ct-mode': theme.mode,
    '--ct-bg': 'transparent',
    '--ct-panel': theme.surface.panelElevated,
    '--ct-panel-2': theme.surface.overlay ?? theme.surface.panelElevated,
    '--ct-border': theme.border.default,
    '--ct-border-2': theme.border.strong,
    '--ct-text': theme.chat.text,
    '--ct-muted': theme.chat.textSecondary,
    '--ct-dim': theme.chat.muted,
    '--ct-hover': theme.surface.hover,
    '--ct-accent': theme.accent.base,
    '--ct-accent-s': theme.accent.soft,
    '--ct-success': theme.status.success,
    '--ct-warning': theme.status.warning,
    '--ct-danger': theme.status.danger,
    '--ct-radius': '8px',
    '--ct-font-primary': fontSans,
    '--ct-font-primary-size': `${fontSize}px`,
    '--ct-font-primary-line': String(fontLineHeight),
    '--ct-font-primary-weight': String(fontWeight),
    '--ct-font-secondary': fontSecondary,
    '--ct-font-secondary-size': `${secondarySize}px`,
    '--ct-font-secondary-line': String(secondaryLineHeight),
    '--ct-font-secondary-weight': String(secondaryWeight),
    '--ct-font-sans': fontSans,
    '--ct-font-mono': fontMono,
    '--ct-font-size': `${fontSize}px`,
    '--ct-font-line': String(fontLineHeight),
    '--ct-font-weight': String(fontWeight),
    '--ct-font-subtle': fontSecondary,
    '--ct-font-subtle-size': `${secondarySize}px`,
    '--ct-font-subtle-line': String(secondaryLineHeight),
    '--ct-font-subtle-weight': String(secondaryWeight),
    '--ct-font-title': fontSans,
    '--ct-font-title-size': `${fontSize}px`,
    '--ct-font-title-weight': String(Math.max(fontWeight, 600)),
  }), [fontLineHeight, fontMono, fontSans, fontSecondary, fontSize, fontWeight, secondaryLineHeight, secondarySize, secondaryWeight, theme])

  const fontCtxValue = useMemo(() => ({
    sans: fontSans,
    secondary: fontSecondary,
    mono: fontMono,
    size: fontSize,
    monoSize,
    lineHeight: fontLineHeight,
    weight: fontWeight,
    monoLineHeight,
    monoWeight,
    secondarySize,
    secondaryLineHeight,
    secondaryWeight,
  }), [fontSans, fontSecondary, fontMono, fontSize, monoSize, fontLineHeight, fontWeight, monoLineHeight, monoWeight, secondarySize, secondaryLineHeight, secondaryWeight])

  return {
    theme,
    fontSans,
    fontMono,
    fontSize,
    fontLineHeight,
    fontWeight,
    monoSize,
    monoLineHeight,
    monoWeight,
    fontSecondary,
    secondarySize,
    secondaryLineHeight,
    secondaryWeight,
    chatViewportBackground,
    composerBackground,
    composerBorder,
    chatSurfaceThemeColors,
    chatSurfaceThemeVars,
    fontCtxValue,
  }
}