/**
 * Computed theme tokens — derived from AppTheme, eliminating
 * `theme.mode === 'light' ? X : Y` ternaries scattered across components.
 *
 * Use via `useThemeTokens()`.
 */
import { useMemo } from 'react'
import type { AppTheme } from './theme'
import { useTheme } from './ThemeContext'

export interface CodeBlockTokens {
  shellBackground: string
  bodyBackground: string
  headerBackground: string
  headerColor: string
  borderColor: string
  inlineBackground: string
  inlineColor: string
  inlineBorderColor: string
}

export interface TableTokens {
  shellBackground: string
  innerBackground: string
  headerBackground: string
}

export interface ComputedTokens {
  code: CodeBlockTokens
  table: TableTokens
  /** github-dark / github-light shiki theme pair. */
  shikiTheme: ['github-light', 'github-light'] | ['github-dark', 'github-dark']
}

export function computeTokens(theme: AppTheme): ComputedTokens {
  // Code-block plates derive entirely from the resolved theme so the
  // contrast slider can shift them with the rest of the palette. Light and
  // dark modes pick different anchor surfaces so the slab still reads as a
  // distinct row regardless of how muddy a particular preset is.
  const isLight = theme.mode === 'light'
  return {
    code: {
      shellBackground: isLight ? theme.chat.background : theme.surface.panelMuted,
      bodyBackground: isLight ? theme.surface.panelMuted : theme.surface.app,
      headerBackground: isLight ? theme.surface.panelElevated : theme.surface.panel,
      headerColor: theme.text.muted,
      borderColor: isLight ? theme.border.subtle : 'transparent',
      inlineBackground: isLight ? theme.surface.panelElevated : theme.surface.panelMuted,
      inlineColor: theme.text.primary,
      inlineBorderColor: isLight ? theme.border.subtle : 'transparent',
    },
    table: {
      shellBackground: isLight ? theme.surface.panelMuted : theme.surface.panel,
      innerBackground: isLight ? theme.chat.background : theme.surface.app,
      headerBackground: theme.surface.panelElevated,
    },
    shikiTheme: isLight ? ['github-light', 'github-light'] : ['github-dark', 'github-dark'],
  }
}

export function useThemeTokens(): ComputedTokens {
  const theme = useTheme()
  return useMemo(() => computeTokens(theme), [theme])
}
