/**
 * Built-in theme preset definitions + their private builders.
 *
 * Extracted from theme.ts (A1) — this file is pure data: 29 hand-tuned theme
 * presets plus the `defineTheme` builder that expands a compact spec into a full
 * AppTheme. theme.ts owns the public type surface, the edge-shadow/contrast
 * helpers, and the theme registry (register/get/resolve). Keeping the ~2.7K
 * lines of preset data here lets both files stay navigable.
 *
 * The `THEMES` map is normalised once at module load (panel-surface pass) and
 * re-exported read-only; consumers should treat it as a frozen lookup table.
 */
import type { AppTheme, ThemeMode } from './theme'

export type EdgeShadowTone = 'subtle' | 'default' | 'strong' | 'accent'

export function getEdgeShadow(theme: Pick<AppTheme, 'mode' | 'accent'>, tone: EdgeShadowTone = 'default'): string {
  if (tone === 'accent') {
    return theme.mode === 'light'
      ? `inset 0 0 0 0.5px color-mix(in srgb, ${theme.accent.base} 38%, white 18%, transparent), 0 0 0 0.5px rgba(0, 0, 0, 0.04)`
      // Dark-mode accent: drop the `white 4%` admixture — at low ambient
      // brightness it shows up as a hard white halo on every accented panel.
      // Anchor the inset purely on the accent so the highlight reads as
      // "this is the active accent" not "this is a glowing outline".
      : `inset 0 0 0 0.5px color-mix(in srgb, ${theme.accent.base} 34%, transparent), 0 0 0 0.5px rgba(255, 255, 255, 0.12)`
  }

  // Light mode uses a restrained paper highlight plus a darker outer keyline
  // so panel and element borders remain visible on bright surfaces. Dark mode
  // keeps this to a single visible 0.5px light keyline — no doubled inset/outer
  // ring — so unfocused prompt cards and settings panels don't look chunky.
  if (theme.mode === 'dark') {
    const alpha = tone === 'strong' ? 0.20 : tone === 'subtle' ? 0.10 : 0.16
    return `0 0 0 0.5px rgba(255, 255, 255, ${alpha})`
  }

  const whiteAlpha = tone === 'strong' ? 0.74 : tone === 'subtle' ? 0.52 : 0.62
  const outerAlpha = tone === 'strong' ? 0.12 : tone === 'subtle' ? 0.08 : 0.10

  // 0.5px hairline reads cleaner on hidpi than a full pixel — at 1px the
  // inset highlight + outer line both grab a full device pixel and the
  // edge feels too declarative. 0.5px gives a sub-pixel rim that still
  // separates the panel from the canvas.
  return `inset 0 0 0 0.5px rgba(255, 255, 255, ${whiteAlpha}), 0 0 0 0.5px rgba(0, 0, 0, ${outerAlpha})`
}

export function stackEdgeShadow(theme: Pick<AppTheme, 'mode' | 'accent'>, shadow?: string, tone: EdgeShadowTone = 'default'): string {
  const edge = getEdgeShadow(theme, tone)
  if (!shadow || shadow === 'none') return edge
  if (shadow.includes('inset 0 0 0 1px rgba(255, 255, 255') || shadow.includes('color-mix(in srgb')) return shadow
  return `${edge}, ${shadow}`
}


/**
 * Default ANSI terminal palette for dark themes. Keeps cross-theme colour
 * recognition (red errors stay red, green diff-add stays green) while letting
 * the surrounding chrome shift per theme. Individual themes can override
 * any subset via `defineTheme({ terminal: {...} })`.
 */
const DEFAULT_DARK_ANSI: Pick<AppTheme['terminal'],
  'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' |
  'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' |
  'brightMagenta' | 'brightCyan' | 'brightWhite'
> = {
  red: '#ff7b72',
  green: '#56c288',
  yellow: '#d8b66a',
  blue: '#7aa2ff',
  magenta: '#c792ea',
  cyan: '#64d2ff',
  white: '#d8dde6',
  brightBlack: '#6e7682',
  brightRed: '#ff9b95',
  brightGreen: '#79d8a0',
  brightYellow: '#e5c47f',
  brightBlue: '#9cbcff',
  brightMagenta: '#d8abff',
  brightCyan: '#8adfff',
  brightWhite: '#ffffff',
}

const DEFAULT_LIGHT_ANSI: Pick<AppTheme['terminal'],
  'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' |
  'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' |
  'brightMagenta' | 'brightCyan' | 'brightWhite'
> = {
  red: '#c5302a',
  green: '#247c3f',
  yellow: '#9a6b00',
  blue: '#1c5fcc',
  magenta: '#9d3ea6',
  cyan: '#0e7c7b',
  white: '#1d2330',
  brightBlack: '#586374',
  brightRed: '#d83a32',
  brightGreen: '#2e9450',
  brightYellow: '#b88200',
  brightBlue: '#316fda',
  brightMagenta: '#b34ec0',
  brightCyan: '#1a8e8c',
  brightWhite: '#0d1117',
}

interface ThemeSpec {
  id: string
  label: string
  mode: ThemeMode
  description?: string
  /** Canvas + grid palette. */
  canvas: {
    background: string
    gridSmall: string
    gridLarge: string
  }
  /** Surface tiers, ordered from outermost to innermost. */
  surface: {
    app: string
    sidebar: string
    panel: string
    panelMuted: string
    panelElevated: string
    titlebar: string
    input: string
  }
  /** Text tiers. `inverse` defaults to opposite-mode neutral. */
  text: {
    primary: string
    secondary: string
    muted: string
    disabled: string
    inverse?: string
  }
  /** Accent colour (e.g. `#7aa2ff`) plus its `r,g,b` triple as a string. */
  accent: { base: string; hover: string; rgb: string }
  /** Status colours. Defaults match `default-dark` / `paper-light`. */
  status?: { success: string; warning: string; danger: string }
  /** Chat surfaces. */
  chat: {
    background: string
    placeholder: string
    input: string
    inputBorder: string
    assistantBubble: string
    userBubble: string
    userBubbleBorder: string
    dropdownBackground: string
    dropdownBorder: string
    dropdownHover: string
  }
  /** Optional ANSI overrides; defaults to mode-appropriate ANSI palette. */
  terminalAnsi?: Partial<typeof DEFAULT_DARK_ANSI>
  /** Border alphas. Defaults provided. */
  border?: { subtle: string; default: string; strong: string }
  /** Drop-shadow rgba for panel + modal. */
  shadow?: { panel: string; modal: string }
}

/**
 * Synthesize a full `AppTheme` from a tighter spec. Reduces the per-theme
 * boilerplate from ~110 lines to ~30 while still letting each theme tune
 * any field that needs hand-attention.
 *
 * Conventions:
 *   - `surface.hover/selection/selectionBorder/accentSoft` derive from accent.
 *   - `border.accent` derives from accent.
 *   - `text.inverse` defaults to a near-pure-opposite neutral.
 *   - Terminal ANSI defaults to a generic mode-appropriate palette unless
 *     overridden via `terminalAnsi`.
 *   - Editor monaco base derives from mode.
 */
export function defineTheme(spec: ThemeSpec): AppTheme {
  const isDark = spec.mode === 'dark'
  const accentRgb = spec.accent.rgb
  const status = spec.status ?? (isDark
    ? { success: '#56c288', warning: '#ffbf5f', danger: '#ff7b72' }
    : { success: '#1f8f5f', warning: '#c07b12', danger: '#d14a4a' })
  const border = spec.border ?? (isDark
    ? { subtle: 'rgba(255,255,255,0.09)', default: 'rgba(255,255,255,0.20)', strong: 'rgba(255,255,255,0.30)' }
    : { subtle: 'rgba(15,23,42,0.06)', default: 'rgba(15,23,42,0.12)', strong: 'rgba(15,23,42,0.20)' })
  const shadow = spec.shadow ?? (isDark
    ? { panel: 'rgba(0,0,0,0.42)', modal: 'rgba(0,0,0,0.62)' }
    : { panel: 'rgba(20,30,50,0.10)', modal: 'rgba(20,30,50,0.16)' })
  const ansiBase = isDark ? DEFAULT_DARK_ANSI : DEFAULT_LIGHT_ANSI
  const ansi = { ...ansiBase, ...(spec.terminalAnsi ?? {}) }

  return {
    id: spec.id,
    label: spec.label,
    mode: spec.mode,
    description: spec.description,
    canvas: {
      background: spec.canvas.background,
      backgroundEffect: '',
      gridSmall: spec.canvas.gridSmall,
      gridLarge: spec.canvas.gridLarge,
      gridGlowSmall: isDark ? 'rgba(255,255,255,0.50)' : 'rgba(15,23,42,0.12)',
      gridGlowLarge: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(15,23,42,0.18)',
    },
    surface: {
      app: spec.surface.app,
      sidebarOverlay: isDark
        ? `rgba(${hexToRgb(spec.surface.sidebar)},0.88)`
        : `rgba(${hexToRgb(spec.surface.sidebar)},0.92)`,
      sidebar: spec.surface.sidebar,
      panel: spec.surface.panel,
      panelMuted: spec.surface.panelMuted,
      panelElevated: spec.surface.panelElevated,
      titlebar: spec.surface.titlebar,
      input: spec.surface.input,
      hover: isDark ? `rgba(${accentRgb},0.06)` : `rgba(${accentRgb},0.10)`,
      selection: `rgba(${accentRgb},${isDark ? 0.14 : 0.18})`,
      selectionBorder: `rgba(${accentRgb},${isDark ? 0.28 : 0.34})`,
      accentSoft: `rgba(${accentRgb},${isDark ? 0.16 : 0.20})`,
      overlay: spec.surface.panelMuted,
      base: spec.surface.panel,
    },
    border: {
      ...border,
      accent: `rgba(${accentRgb},0.5)`,
    },
    text: {
      primary: spec.text.primary,
      secondary: spec.text.secondary,
      muted: spec.text.muted,
      disabled: spec.text.disabled,
      inverse: spec.text.inverse ?? (isDark ? '#f5f7fa' : '#0f1116'),
    },
    accent: {
      base: spec.accent.base,
      hover: spec.accent.hover,
      soft: `rgba(${accentRgb},${isDark ? 0.16 : 0.20})`,
    },
    status,
    chat: {
      background: spec.chat.background,
      placeholder: spec.chat.placeholder,
      input: spec.chat.input,
      inputBorder: spec.chat.inputBorder,
      text: spec.text.primary,
      textSecondary: spec.text.secondary,
      muted: spec.text.muted,
      subtle: spec.text.disabled,
      divider: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)',
      assistantBubble: spec.chat.assistantBubble,
      assistantBubbleBorder: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.07)',
      userBubble: spec.chat.userBubble,
      userBubbleBorder: spec.chat.userBubbleBorder,
      dropdownBackground: spec.chat.dropdownBackground,
      dropdownBorder: spec.chat.dropdownBorder,
      dropdownActiveBackground: spec.chat.dropdownHover,
      dropdownHoverBackground: spec.chat.dropdownHover,
    },
    terminal: {
      background: spec.surface.panel,
      foreground: spec.text.primary,
      cursor: spec.text.secondary,
      cursorAccent: spec.surface.panel,
      selection: `rgba(${accentRgb},${isDark ? 0.25 : 0.22})`,
      black: isDark ? spec.canvas.background : spec.surface.app,
      ...ansi,
    },
    editor: {
      monacoBase: isDark ? 'vs-dark' : 'vs',
      background: spec.surface.panel,
    },
    extension: {
      background: spec.surface.panel,
      panel: spec.surface.panelElevated,
      border: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.14)',
      text: spec.text.primary,
      muted: spec.text.muted,
      accent: spec.accent.base,
    },
    shadow: {
      panel: `0 10px 36px ${shadow.panel}`,
      modal: `0 32px 80px ${shadow.modal}`,
    },
  }
}

/** Helper: convert `#rrggbb` → `r,g,b` triple string for `rgba()` composition.
 *  Falls back gracefully for shorthand or invalid input. */
function hexToRgb(hex: string): string {
  const m6 = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (m6) return `${parseInt(m6[1], 16)},${parseInt(m6[2], 16)},${parseInt(m6[3], 16)}`
  const m3 = hex.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (m3) return `${parseInt(m3[1] + m3[1], 16)},${parseInt(m3[2] + m3[2], 16)},${parseInt(m3[3] + m3[3], 16)}`
  return '0,0,0'
}

function strengthenRgbaAlpha(value: string, minAlpha: number): string {
  const match = value.match(/^rgba\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/i)
  if (!match) return value
  const alpha = Math.max(Number.parseFloat(match[4]), minAlpha)
  return `rgba(${match[1]},${match[2]},${match[3]},${Number(alpha.toFixed(3))})`
}

export function strengthenThemeBorders(theme: AppTheme): AppTheme {
  const light = theme.mode === 'light'
  const subtle = strengthenRgbaAlpha(theme.border.subtle, light ? 0.10 : 0.14)
  const defaultBorder = strengthenRgbaAlpha(theme.border.default, light ? 0.18 : 0.24)
  const strong = strengthenRgbaAlpha(theme.border.strong, light ? 0.28 : 0.36)
  const chatDefault = strengthenRgbaAlpha(theme.chat.inputBorder, light ? 0.18 : 0.22)
  const chatDivider = strengthenRgbaAlpha(theme.chat.divider, light ? 0.12 : 0.14)
  const chatBubble = strengthenRgbaAlpha(theme.chat.assistantBubbleBorder, light ? 0.11 : 0.12)
  return {
    ...theme,
    border: {
      ...theme.border,
      subtle,
      default: defaultBorder,
      strong,
    },
    chat: {
      ...theme.chat,
      inputBorder: chatDefault,
      divider: chatDivider,
      assistantBubbleBorder: chatBubble,
      userBubbleBorder: strengthenRgbaAlpha(theme.chat.userBubbleBorder, light ? 0.11 : 0.12),
      dropdownBorder: strengthenRgbaAlpha(theme.chat.dropdownBorder, light ? 0.18 : 0.22),
    },
    extension: {
      ...theme.extension,
      border: strengthenRgbaAlpha(theme.extension.border, light ? 0.18 : 0.24),
    },
  }
}

export function normalizePanelSurfaceTheme(theme: AppTheme): AppTheme {
  const strengthenedTheme = strengthenThemeBorders(theme)
  const panelBackground = strengthenedTheme.surface.panel
  const overlay = strengthenedTheme.surface.overlay ?? strengthenedTheme.surface.panelMuted
  const base = strengthenedTheme.surface.base ?? strengthenedTheme.surface.panel
  return {
    ...strengthenedTheme,
    surface: {
      ...strengthenedTheme.surface,
      overlay,
      base,
    },
    terminal: {
      ...strengthenedTheme.terminal,
      background: panelBackground,
      cursorAccent: panelBackground,
    },
    editor: {
      ...strengthenedTheme.editor,
      background: panelBackground,
    },
    extension: {
      ...strengthenedTheme.extension,
      background: panelBackground,
    },
    chat: {
      ...strengthenedTheme.chat,
      userBubble: strengthenedTheme.chat.assistantBubble,
      userBubbleBorder: strengthenedTheme.chat.assistantBubbleBorder,
    },
    shadow: {
      ...strengthenedTheme.shadow,
      panel: stackEdgeShadow(strengthenedTheme, strengthenedTheme.shadow.panel),
      modal: stackEdgeShadow(strengthenedTheme, strengthenedTheme.shadow.modal, 'strong'),
    },
  }
}

