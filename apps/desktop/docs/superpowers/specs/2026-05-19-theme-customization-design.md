# Theme Customization Design

**Date:** 2026-05-19
**Status:** Draft — awaiting user review
**Scope:** In-core theme customization knobs that layer on top of a selected preset

## Background

Today, Settings → Appearance offers three controls:

1. **Appearance mode** — light / dark / system
2. **Preset** — a hand-tuned `AppTheme` from `src/renderer/src/theme.ts`
3. **Contrast** — a global L-axis transform (`applyContrast` in `theme.ts`), backed by `settings.themeContrast`

The user can pick a preset, but cannot personalize it further without writing a custom theme via the (currently extension-based) Theme Builder. We want core, first-class knobs that modify the active preset's colours without discarding the preset's careful per-token tuning.

## Goals

- Let the user customize a preset along three additional axes — **saturation**, **warmth**, and **accent colour** — without leaving Settings.
- Apply customizations as **pure transforms layered on top of the resolved preset** (same pattern as `applyContrast`). Presets remain the source of truth and are not mutated.
- Restrict customizations to **main app chrome** only. Terminal ANSI palette and status colours stay untouched so that diff colours, error reds, and success greens remain recognizable across themes.
- Reset semantics are trivial — each knob has a single neutral value (0, or `null` for accent) that yields the unchanged preset.

## Non-Goals

- Per-token colour pickers, a full theme editor, or custom-preset save/export. Those belong in a dedicated Theme Builder extension if we ship one later.
- Customizing terminal ANSI colours, status colours (`success` / `warning` / `danger`), Monaco syntax themes, or shiki code-block themes.
- Migrating away from the existing `themeContrast` setting. The new knobs sit alongside it.

## Settings Schema

Three new flat fields on the existing settings object (same nesting level as `themeContrast`):

```ts
themeContrast?: number       // -1..1   existing
themeSaturation?: number     // -1..1   new — 0 = preset default
themeWarmth?: number         // -1..1   new — negative = cooler (blue), positive = warmer (orange)
themeAccent?: string | null  // hex     new — null = preset default
```

- All four fields are optional. Absent / `undefined` is treated as the neutral value.
- `themeAccent` accepts a 6-digit hex string (`#rrggbb`). Invalid strings fall back to neutral.
- Persisted as part of the existing settings JSON; no migration needed (additive only).

## Architecture

### New pure functions in `src/renderer/src/colorMath.ts`

Both functions follow the conventions of the existing `shiftLightness` / `shiftLAway`:

- Parse with the existing `parseColor` helper.
- Inputs we can't parse (named colours, `oklch()`, `color-mix()`) round-trip unchanged.
- Preserve alpha and output shape (`rgb`, `rgba`, `hsl`, `hex`).

```ts
/**
 * Scale HSL saturation by `factor` ∈ [-1, 1].
 *   factor > 0 → boost saturation toward fully saturated
 *   factor = 0 → unchanged
 *   factor < 0 → desaturate toward grey
 * Greys (S = 0) stay grey at any factor.
 */
export function shiftS(input: string, factor: number): string

/**
 * Pull HSL hue toward `targetHue` (in degrees, 0..360) by `amount` ∈ [0, 1].
 * Uses shortest-arc rotation. amount=0 leaves H unchanged; amount=1 snaps to target.
 * Greys (S = 0) round-trip unchanged.
 */
export function shiftHueToward(input: string, targetHue: number, amount: number): string
```

For the warmth slider:

- Positive warmth pulls toward `targetHue = 30°` (orange/amber).
- Negative warmth pulls toward `targetHue = 210°` (blue).
- `amount = Math.abs(warmth) * MAX_WARMTH_PULL` where `MAX_WARMTH_PULL = 0.20` (capped so warmth feels like a tint, not a hue replacement).

### New composition function in `src/renderer/src/theme.ts`

```ts
export interface ThemeCustomizations {
  contrast?: number
  saturation?: number
  warmth?: number
  accent?: string | null
}

export function applyCustomizations(theme: AppTheme, c: ThemeCustomizations): AppTheme
```

Internal pipeline order (each step returns a new `AppTheme`):

1. **`applyAccentOverride(theme, accent)`** — replaces the accent and its derived tokens. No-op when `accent` is null/empty/invalid.
2. **`applyWarmth(theme, warmth)`** — hue shift on chrome tokens.
3. **`applySaturation(theme, saturation)`** — S-axis transform on chrome tokens.
4. **`applyContrast(theme, contrast)`** — existing L-axis transform.

Order rationale: accent override goes first so the new accent's hue and saturation get transformed too. Hue shifts before saturation so the warmth pull operates on the preset's natural saturation. Contrast last because the L-axis pass already understands the preset's surface/text polarity.

### Chrome whitelist (applies to warmth + saturation)

These transforms walk only the following token paths. Anything not listed is passed through unchanged:

- `canvas.background`, `canvas.gridSmall`, `canvas.gridLarge`, `canvas.gridGlowSmall`, `canvas.gridGlowLarge`
- All of `surface.*`
- All of `border.*`
- All of `text.*`
- All of `accent.*`
- All of `chat.*`
- `editor.background`
- All of `extension.*`
- `shadow.panel`, `shadow.modal` (rgba composites — pass strings to the parser; unparseable parts round-trip unchanged)

Explicitly **excluded**:

- All of `terminal.*` (ANSI palette + chrome — kept stable so terminal output is predictable across customizations).
- All of `status.*` (success / warning / danger semantics).
- `editor.monacoBase` (mode hint, not a colour).
- shiki theme name in computed tokens.

### `applyAccentOverride` token rewrites

When the user picks a custom accent (e.g. `#ff6a3d`), this function rewrites a fixed list of accent-derived tokens. It is **not** a generic hue/sat transform — it specifically reproduces the recipes that presets use, so the output matches what the preset would have looked like with that accent baked in.

| Token | New value |
|---|---|
| `accent.base` | new accent |
| `accent.hover` | new accent lightened 8% (`shiftLightness(..., +0.08)`) |
| `accent.soft` | rgba(newAccent, 0.16) dark / 0.12 light |
| `border.accent` | rgba(newAccent, 0.30) |
| `surface.selection` | rgba(newAccent, dark 0.12 / light 0.10) |
| `surface.selectionBorder` | rgba(newAccent, dark 0.24 / light 0.22) |
| `surface.accentSoft` | rgba(newAccent, dark 0.16 / light 0.12) |
| `chat.userBubble` | rgba(newAccent, dark 0.15 / light 0.10) |
| `chat.userBubbleBorder` | rgba(newAccent, dark 0.28 / light 0.22) |
| `chat.dropdownActiveBackground` | rgba(newAccent, dark 0.16 / light 0.12) |
| `extension.accent` | new accent |

The `dark / light` choice keys off `theme.mode`. Terminal `blue` / `brightBlue` are intentionally **not** rewritten — they belong to the ANSI palette which we treat as out of scope.

### Wire-up site

In `App.tsx` (line ~4559), replace:

```ts
const theme = React.useMemo(
  () => applyContrast(getThemeById(effectiveThemeId), settings.themeContrast ?? 0),
  [effectiveThemeId, settings.themeContrast],
)
```

with:

```ts
const theme = React.useMemo(
  () => applyCustomizations(getThemeById(effectiveThemeId), {
    contrast: settings.themeContrast ?? 0,
    saturation: settings.themeSaturation ?? 0,
    warmth: settings.themeWarmth ?? 0,
    accent: settings.themeAccent ?? null,
  }),
  [
    effectiveThemeId,
    settings.themeContrast,
    settings.themeSaturation,
    settings.themeWarmth,
    settings.themeAccent,
  ],
)
```

`applyCustomizations` stays a no-op when all four knobs are neutral, so existing behaviour is preserved bit-for-bit for users who don't touch the new controls.

## UI

All new controls live in `SettingsPanel.tsx`, Appearance section, immediately below the existing Contrast row. Each row uses the same `SettingRow` component with consistent slider + reset + readout structure.

### Saturation row

- Label: `Saturation`
- Description: `Boost or mute the preset's colours. 0 keeps the preset's natural saturation.`
- Control: range slider `min=-1 max=1 step=0.05`, bound to `settings.themeSaturation`.
- Reset button: sets `themeSaturation: 0`.
- Readout: `+0.50` style, tabular-nums, signed.

### Warmth row

- Label: `Warmth`
- Description: `Tint the palette warmer (orange) or cooler (blue). 0 keeps the preset's natural hue.`
- Control: range slider `min=-1 max=1 step=0.05`, bound to `settings.themeWarmth`.
- Reset button: sets `themeWarmth: 0`.
- Readout: same as Saturation.

### Accent row

- Label: `Accent`
- Description: `Replace the preset's accent colour. Other tokens (selection, dropdown highlights, etc.) follow automatically.`
- Control: HTML `<input type="color">` + a hex text input (6-digit hex, validated like the Theme Builder's hex inputs).
- Reset button: `Match preset` — sets `themeAccent: null`.
- When `themeAccent` is `null`, the colour input shows the resolved preset's accent as a "ghost" value, the hex input is empty with a placeholder.

### "Reset all customisations" link

- Single text button at the bottom of the Appearance section.
- Resets `themeContrast`, `themeSaturation`, `themeWarmth` to `0` and `themeAccent` to `null` in a single `updateSettingsPatch` call.
- Does **not** change the preset or appearance mode.

## Component boundaries

- `colorMath.ts` (pure) — adds `shiftS` and `shiftHueToward`. No theme knowledge.
- `theme.ts` — adds `applyAccentOverride`, `applyWarmth`, `applySaturation`, `applyCustomizations`. Imports `shiftS`, `shiftHueToward`, `shiftLightness`. No React.
- `App.tsx` — single-line change at the existing `applyContrast` call site. No new state.
- `SettingsPanel.tsx` — three new `SettingRow`s + one reset link. No new context, no new hooks.

Total surface area: 2 files extended, 2 files touched at one call site each. App.tsx change is < 10 lines.

## Testing

- **Unit tests for `colorMath.ts`** — round-trip behaviour for parseable / unparseable inputs, alpha preservation, edge cases (greys, saturated primaries, hue wrap at 360°).
- **Unit tests for `applyCustomizations`** — all-neutral input returns the input unchanged (referential or structural equality is fine); accent override does not mutate non-accent tokens; warmth/saturation skip terminal and status; pipeline composes in the documented order.
- **Manual verification** — pick each built-in preset, sweep each slider through its range, confirm:
  - No NaN / invalid colour strings reach the DOM (inspect `<html>` CSS custom properties).
  - Terminal output still reads as expected (red errors, green diffs).
  - Status pills (success / warning / danger) are unchanged.
  - Reset returns the theme to byte-identical preset values.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Combined extremes (e.g. saturation=-1 + contrast=-1) muddy the UI into illegible greys | Sliders are bipolar around 0 with the same `0.5` damping factor used by `shiftLAway`. Documented in field descriptions. |
| Custom accent collides with status colours (e.g. user picks red, danger pill blends in) | Acceptable trade-off; status colours are out of scope. We could warn at extreme overlaps later if real users hit it. |
| `parseColor` failing on a token leaves a mixed-style theme | Existing behaviour for `applyContrast`. Unparseable strings round-trip; mitigated by `theme.ts` using hex / rgba throughout. |
| Settings JSON grows | Three additional optional fields. Negligible. |

## Out of Scope (future work)

- Saving customizations as a named "Custom from <preset>" theme that shows up in the preset dropdown.
- Per-token colour pickers for users who want fine-grained control.
- Sync of customizations across workspaces (currently lives in workspace settings; cross-workspace propagation can come later).
- Surfacing customizations to extensions via the `window.contex.theme` bridge — extensions already get the resolved theme, so they pick this up for free.
