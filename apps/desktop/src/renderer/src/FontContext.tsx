import React, { createContext, useContext } from 'react'
import type { FontSettings, FontToken } from '../../shared/types'
import { DEFAULT_FONTS } from '../../shared/types'

// ── Simple interface for components ─────────────────────────────────────────
export interface AppFonts {
  /** Primary sans font family string */
  primary: string
  /** Secondary sans font family string */
  secondary: string
  /** Monospace font family string */
  mono: string
  /** Primary font size */
  size: number
  /** Primary line height */
  lineHeight: number
  /** Primary font weight */
  weight: number
  /** Secondary font size */
  secondarySize: number
  /** Secondary line height */
  secondaryLineHeight: number
  /** Secondary font weight */
  secondaryWeight: number
  /** Mono font size */
  monoSize: number
  /** Mono line height */
  monoLineHeight: number
  /** Mono font weight */
  monoWeight: number
}

// ── Legacy compat exports ───────────────────────────────────────────────────
export const SANS_DEFAULT = DEFAULT_FONTS.primary.family
export const MONO_DEFAULT = DEFAULT_FONTS.mono.family

// ── Full token context ──────────────────────────────────────────────────────
const FontTokenContext = createContext<FontSettings>(DEFAULT_FONTS)
export const FontTokenProvider = FontTokenContext.Provider

/** Access the three font tokens: primary, secondary, mono */
export function useFontTokens(): FontSettings { return useContext(FontTokenContext) }

/** Convert a FontToken to a React.CSSProperties object */
export function tokenToStyle(token: FontToken): React.CSSProperties {
  return {
    fontFamily: token.family,
    fontSize: token.size,
    lineHeight: token.lineHeight,
    fontWeight: token.weight,
    letterSpacing: token.letterSpacing,
  }
}

// ── Simple context (most components use this) ───────────────────────────────
const FontContext = createContext<AppFonts>({
  primary: SANS_DEFAULT,
  secondary: SANS_DEFAULT,
  mono: MONO_DEFAULT,
  size: 13,
  lineHeight: 1.5,
  weight: 400,
  secondarySize: 11,
  secondaryLineHeight: 1.4,
  secondaryWeight: 400,
  monoSize: 13,
  monoLineHeight: 1.5,
  monoWeight: 400,
})

export const FontProvider = FontContext.Provider
export function useAppFonts(): AppFonts { return useContext(FontContext) }
