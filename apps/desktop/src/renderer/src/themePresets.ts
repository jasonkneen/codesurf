/**
 * Built-in theme presets public surface.
 * Builders: themePresetsCore.ts
 * Catalogs: themePresetsDark.ts / themePresetsLight.ts
 */
import type { AppTheme } from './theme'
import { normalizePanelSurfaceTheme } from './themePresetsCore'
import { THEME_ENTRIES_DARK } from './themePresetsDark'
import { THEME_ENTRIES_LIGHT } from './themePresetsLight'

export {
  getEdgeShadow,
  stackEdgeShadow,
  type EdgeShadowTone,
  defineTheme,
  strengthenThemeBorders,
  normalizePanelSurfaceTheme,
} from './themePresetsCore'

const RAW_THEMES: Record<string, AppTheme> = {
  ...THEME_ENTRIES_DARK,
  ...THEME_ENTRIES_LIGHT,
}

export const THEMES: Record<string, AppTheme> = { ...RAW_THEMES }
for (const [themeId, theme] of Object.entries(THEMES)) {
  THEMES[themeId] = normalizePanelSurfaceTheme(theme)
}
