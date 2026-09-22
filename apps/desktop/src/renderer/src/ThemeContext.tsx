import { createContext, useContext } from 'react'
import type { AppTheme } from './theme'
import { getThemeById } from './theme'

const ThemeContext = createContext<AppTheme>(getThemeById())

export const ThemeProvider = ThemeContext.Provider

export function useTheme(): AppTheme {
  return useContext(ThemeContext)
}
