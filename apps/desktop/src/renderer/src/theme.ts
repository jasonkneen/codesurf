import { shiftLAway } from './colorMath'
import { resolveThemeIdForAppearance } from './themeResolution'
import { THEMES, normalizePanelSurfaceTheme } from './themePresets'

// Edge-shadow helpers live in themePresets (next to the normaliser that uses
// them at load time) but are re-exported here so existing consumers keep
// importing from `./theme`.
export { getEdgeShadow, stackEdgeShadow, type EdgeShadowTone } from './themePresets'

export type ThemeMode = 'dark' | 'light'

export interface AppTheme {
  id: string
  label: string
  mode: ThemeMode
  description?: string
  canvas: {
    background: string
    backgroundEffect?: string
    gridSmall: string
    gridLarge: string
    gridGlowSmall: string
    gridGlowLarge: string
  }
  surface: {
    app: string
    sidebarOverlay: string
    sidebar: string
    panel: string
    panelMuted: string
    panelElevated: string
    titlebar: string
    input: string
    hover: string
    selection: string
    selectionBorder: string
    accentSoft: string
    /** Elevated overlay surface (alias of panelMuted). */
    overlay?: string
    /** Base panel surface (alias of panel). */
    base?: string
  }
  border: {
    subtle: string
    default: string
    strong: string
    accent: string
  }
  text: {
    primary: string
    secondary: string
    muted: string
    disabled: string
    inverse: string
  }
  accent: {
    base: string
    hover: string
    soft: string
  }
  status: {
    success: string
    warning: string
    danger: string
  }
  chat: {
    background: string
    placeholder: string
    input: string
    inputBorder: string
    text: string
    textSecondary: string
    muted: string
    subtle: string
    divider: string
    assistantBubble: string
    assistantBubbleBorder: string
    userBubble: string
    userBubbleBorder: string
    dropdownBackground: string
    dropdownBorder: string
    dropdownActiveBackground: string
    dropdownHoverBackground: string
  }
  terminal: {
    background: string
    foreground: string
    cursor: string
    cursorAccent: string
    selection: string
    black: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
    white: string
    brightBlack: string
    brightRed: string
    brightGreen: string
    brightYellow: string
    brightBlue: string
    brightMagenta: string
    brightCyan: string
    brightWhite: string
  }
  editor: {
    monacoBase: 'vs-dark' | 'vs'
    background: string
  }
  extension: {
    background: string
    panel: string
    border: string
    text: string
    muted: string
    accent: string
  }
  shadow: {
    panel: string
    modal: string
  }
}

/**
 * Apply a global contrast offset to a resolved theme. `factor` is in
 * `[-1, 1]`; positive values increase contrast (surfaces shift away from text,
 * text shifts away from surfaces), negative values compress everything toward
 * mid-grey.
 *
 * What we touch: surface/border/text/chat surface/extension/editor.background
 * lightness. Alpha overlays (e.g. the rgba surface.hover) keep their alpha
 * but shift their colour anchor in the same direction as the matching base
 * surface, so glass-style highlights remain visible at high-contrast
 * extremes.
 *
 * What we do *not* touch: accent.*, status.*, terminal ANSI palette,
 * editor.monacoBase (it's a mode hint, not a colour), shadow strings (they're
 * composed multi-value strings; their alpha-only black components don't
 * benefit from L shifts), shiki theme name. These are deliberately calibrated
 * and shifting them would break syntax-highlight semantics or accent
 * recognisability.
 */
export function applyContrast(theme: AppTheme, factor: number): AppTheme {
  const f = Math.max(-1, Math.min(1, factor || 0))
  if (f === 0) return theme
  const isDark = theme.mode === 'dark'
  // Surfaces push toward 0 in dark mode, toward 1 in light mode.
  // Text pushes the opposite way.
  const surfaceMode: 'darker' | 'lighter' = isDark ? 'darker' : 'lighter'
  const textMode: 'darker' | 'lighter' = isDark ? 'lighter' : 'darker'

  const S = (v: string) => shiftLAway(v, f, surfaceMode)
  const T = (v: string) => shiftLAway(v, f, textMode)
  // Borders sit between surfaces and content; they should track the surface
  // direction but with a stronger pull so they remain visible against
  // higher-contrast surfaces.
  const B = (v: string) => shiftLAway(v, f, textMode)

  return {
    ...theme,
    canvas: {
      ...theme.canvas,
      background: S(theme.canvas.background),
      gridSmall: B(theme.canvas.gridSmall),
      gridLarge: B(theme.canvas.gridLarge),
      // gridGlow* are alpha overlays; leave alpha alone, shift anchor toward text
      gridGlowSmall: T(theme.canvas.gridGlowSmall),
      gridGlowLarge: T(theme.canvas.gridGlowLarge),
    },
    surface: {
      ...theme.surface,
      app: S(theme.surface.app),
      sidebarOverlay: S(theme.surface.sidebarOverlay),
      sidebar: S(theme.surface.sidebar),
      panel: S(theme.surface.panel),
      panelMuted: S(theme.surface.panelMuted),
      panelElevated: S(theme.surface.panelElevated),
      titlebar: S(theme.surface.titlebar),
      input: S(theme.surface.input),
      // hover/selection/accentSoft are alpha-tinted; nudge their anchor but
      // they preserve alpha so glass highlights remain visible at extremes.
      hover: T(theme.surface.hover),
      selection: theme.surface.selection,
      selectionBorder: theme.surface.selectionBorder,
      accentSoft: theme.surface.accentSoft,
      overlay: S(theme.surface.overlay ?? theme.surface.panelMuted),
      base: S(theme.surface.base ?? theme.surface.panel),
    },
    border: {
      ...theme.border,
      subtle: B(theme.border.subtle),
      default: B(theme.border.default),
      strong: B(theme.border.strong),
      // accent border stays anchored to accent.base — don't touch
      accent: theme.border.accent,
    },
    text: {
      ...theme.text,
      primary: T(theme.text.primary),
      secondary: T(theme.text.secondary),
      muted: T(theme.text.muted),
      disabled: T(theme.text.disabled),
      inverse: S(theme.text.inverse),
    },
    chat: {
      ...theme.chat,
      background: S(theme.chat.background),
      placeholder: T(theme.chat.placeholder),
      input: S(theme.chat.input),
      inputBorder: B(theme.chat.inputBorder),
      text: T(theme.chat.text),
      textSecondary: T(theme.chat.textSecondary),
      muted: T(theme.chat.muted),
      subtle: T(theme.chat.subtle),
      divider: B(theme.chat.divider),
      assistantBubble: S(theme.chat.assistantBubble),
      assistantBubbleBorder: B(theme.chat.assistantBubbleBorder),
      userBubble: S(theme.chat.userBubble),
      userBubbleBorder: B(theme.chat.userBubbleBorder),
      dropdownBackground: S(theme.chat.dropdownBackground),
      dropdownBorder: B(theme.chat.dropdownBorder),
      dropdownActiveBackground: S(theme.chat.dropdownActiveBackground),
      dropdownHoverBackground: S(theme.chat.dropdownHoverBackground),
    },
    terminal: {
      ...theme.terminal,
      // Only the surrounding chrome shifts; ANSI palette is sacrosanct.
      background: S(theme.terminal.background),
      foreground: T(theme.terminal.foreground),
      cursorAccent: S(theme.terminal.cursorAccent),
    },
    editor: {
      ...theme.editor,
      background: S(theme.editor.background),
    },
    extension: {
      ...theme.extension,
      background: S(theme.extension.background),
      panel: S(theme.extension.panel),
      border: B(theme.extension.border),
      text: T(theme.extension.text),
      muted: T(theme.extension.muted),
      // accent stays anchored
    },
    // shadows are mostly black with alpha — leave them; the L shift on
    // surfaces underneath them changes the perceived shadow weight naturally.
  }
}

export type AppearanceMode = 'dark' | 'light' | 'system'

/** Which theme id to apply given appearance mode, saved dark preset, and OS dark preference. */
export function resolveEffectiveThemeId(
  appearance: AppearanceMode | undefined,
  themeId: string,
  systemPrefersDark: boolean,
): string {
  const theme = THEMES[themeId]
  return resolveThemeIdForAppearance(appearance, themeId, theme?.mode, systemPrefersDark, DEFAULT_THEME_ID, 'paper-light')
}

export const DEFAULT_THEME_ID = 'default-dark'
const BUILTIN_THEME_IDS = new Set(Object.keys(THEMES))
export const THEME_PRESETS = Object.values(THEMES)
export const THEME_OPTIONS = THEME_PRESETS.map(({ id, label, mode, description }) => ({ id, label, mode, description }))

/** Register or update a custom (extension-provided) theme at runtime. Builtins are immutable. */
export function registerCustomTheme(theme: AppTheme): void {
  if (BUILTIN_THEME_IDS.has(theme.id)) return
  const normalizedTheme = normalizePanelSurfaceTheme(theme)
  THEMES[theme.id] = normalizedTheme
  const presetIndex = THEME_PRESETS.findIndex(t => t.id === theme.id)
  if (presetIndex >= 0) THEME_PRESETS[presetIndex] = normalizedTheme
  else THEME_PRESETS.push(normalizedTheme)

  const option = { id: normalizedTheme.id, label: normalizedTheme.label, mode: normalizedTheme.mode, description: normalizedTheme.description }
  const optionIndex = THEME_OPTIONS.findIndex(t => t.id === theme.id)
  if (optionIndex >= 0) THEME_OPTIONS[optionIndex] = option
  else THEME_OPTIONS.push(option)
}

/** Remove a custom theme registered at runtime. Builtins are immutable. */
export function unregisterCustomTheme(themeId: string): void {
  if (!themeId || BUILTIN_THEME_IDS.has(themeId)) return
  delete THEMES[themeId]
  const presetIndex = THEME_PRESETS.findIndex(t => t.id === themeId)
  if (presetIndex >= 0) THEME_PRESETS.splice(presetIndex, 1)
  const optionIndex = THEME_OPTIONS.findIndex(t => t.id === themeId)
  if (optionIndex >= 0) THEME_OPTIONS.splice(optionIndex, 1)
}

export function getThemeById(id?: string | null): AppTheme {
  if (!id) return THEMES[DEFAULT_THEME_ID]
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID]
}

export function getThemeCanvasDefaults(id?: string | null): Pick<AppTheme['canvas'], 'background' | 'gridSmall' | 'gridLarge'> {
  const theme = getThemeById(id)
  return {
    background: theme.canvas.background,
    gridSmall: theme.canvas.gridSmall,
    gridLarge: theme.canvas.gridLarge,
  }
}
