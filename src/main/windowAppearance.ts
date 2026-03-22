import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

const TRANSPARENT_WINDOW_BACKGROUND = '#00000000'

/**
 * Transparency + vibrancy are always enabled at the Electron level.
 * The renderer controls perceived translucency via canvas background opacity
 * (slider at 1.0 = fully opaque, lower = more see-through).
 * No reboot needed to toggle — it's purely a CSS alpha change.
 */

export function getWindowAppearanceOptions(): Pick<BrowserWindowConstructorOptions, 'transparent' | 'backgroundColor' | 'vibrancy' | 'visualEffectState'> {
  const isMac = process.platform === 'darwin'
  return {
    transparent: true,
    backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
  }
}

export function applyWindowAppearance(win: BrowserWindow): void {
  win.setBackgroundColor(TRANSPARENT_WINDOW_BACKGROUND)
  if (process.platform === 'darwin') {
    win.setVibrancy('under-window')
  }
}
