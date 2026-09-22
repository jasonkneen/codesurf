export type ThemeResolutionMode = 'dark' | 'light'
export type ThemeResolutionAppearanceMode = 'dark' | 'light' | 'system'

export function resolveThemeIdForAppearance(
  appearance: ThemeResolutionAppearanceMode | undefined,
  themeId: string,
  themeMode: ThemeResolutionMode | undefined,
  systemPrefersDark: boolean,
  defaultDarkThemeId: string,
  defaultLightThemeId: string,
): string {
  const a = appearance ?? 'dark'
  if (a === 'light') {
    return themeMode === 'light' ? themeId : defaultLightThemeId
  }
  if (a === 'system') {
    if (systemPrefersDark) {
      return themeMode === 'dark' ? themeId : defaultDarkThemeId
    }
    return themeMode === 'light' ? themeId : defaultLightThemeId
  }
  return themeMode === 'dark' ? themeId : defaultDarkThemeId
}
