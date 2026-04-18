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
  const isWin = process.platform === 'win32'
  return {
    // Transparent windows on Windows cause rendering issues (crash on focus change,
    // invisible window when packaged). Use opaque background on Windows instead.
    transparent: !isWin,
    backgroundColor: isWin ? '#1e1e1e' : TRANSPARENT_WINDOW_BACKGROUND,
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
  }
}

export function applyWindowAppearance(win: BrowserWindow): void {
  if (process.platform === 'win32') {
    win.setBackgroundColor('#1e1e1e')
  } else {
    win.setBackgroundColor(TRANSPARENT_WINDOW_BACKGROUND)
  }
  if (process.platform === 'darwin') {
    win.setVibrancy('under-window')
  }
}
