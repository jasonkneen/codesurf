import { useEffect, useState } from 'react'
import { getBrandPalettes } from '../lib/brandPalettes'
import { BRAND_WORDMARKS } from '../lib/brandWordmarks'
import type { ThemeMode } from '../theme'

const BRAND_WORDMARK_CACHE_KEY = 'codesurf:brand-wordmark-index'
const BRAND_WORDMARK_PALETTE_CACHE_KEY = 'codesurf:brand-wordmark-palette-index'

/** Persist per-theme brand wordmark/palette indices and keep asset tables warm. */
export function useBrandWordmarkPrefs(effectiveThemeId: string, themeMode: ThemeMode): void {
  const [brandWordmarkIndex, setBrandWordmarkIndex] = useState(1)
  const [brandPaletteIndex, setBrandPaletteIndex] = useState(0)
  const [brandPrefsReadyTheme, setBrandPrefsReadyTheme] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    setBrandPrefsReadyTheme(null)
    try {
      const savedWordmark = window.localStorage.getItem(`${BRAND_WORDMARK_CACHE_KEY}:${effectiveThemeId}`)
      const savedPalette = window.localStorage.getItem(`${BRAND_WORDMARK_PALETTE_CACHE_KEY}:${effectiveThemeId}`)
      const nextWordmark = savedWordmark === null ? 1 : Number.parseInt(savedWordmark, 10)
      const nextPalette = savedPalette === null ? 0 : Number.parseInt(savedPalette, 10)
      setBrandWordmarkIndex(Number.isFinite(nextWordmark) && nextWordmark >= 0 ? nextWordmark : 1)
      setBrandPaletteIndex(Number.isFinite(nextPalette) && nextPalette >= 0 ? nextPalette : 0)
    } catch {
      setBrandWordmarkIndex(1)
      setBrandPaletteIndex(0)
    }
    setBrandPrefsReadyTheme(effectiveThemeId)
  }, [effectiveThemeId])

  useEffect(() => {
    if (typeof window === 'undefined' || brandPrefsReadyTheme !== effectiveThemeId) return
    try {
      window.localStorage.setItem(`${BRAND_WORDMARK_CACHE_KEY}:${effectiveThemeId}`, String(brandWordmarkIndex))
      window.localStorage.setItem(`${BRAND_WORDMARK_PALETTE_CACHE_KEY}:${effectiveThemeId}`, String(brandPaletteIndex))
    } catch {}
  }, [brandWordmarkIndex, brandPaletteIndex, brandPrefsReadyTheme, effectiveThemeId])

  const brandPalettes = getBrandPalettes(themeMode)
  const activeBrandWordmark = BRAND_WORDMARKS[brandWordmarkIndex % BRAND_WORDMARKS.length]
  void brandPalettes[brandPaletteIndex % brandPalettes.length]
  void (activeBrandWordmark[0]
    ? Math.min(1, (32 / activeBrandWordmark[0].length) * (
      brandWordmarkIndex === 0 ? 1 : brandWordmarkIndex === 1 ? 1.44 : 1.2
    )) * 0.62
    : 1)
}