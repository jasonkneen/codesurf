/**
 * Multi-target host detection.
 *
 * - electron: preload installed `window.electron` (full IPC)
 * - native:   Vercel Native SDK WebView (`window.zero`)
 * - web:      plain browser
 */

export type CodesurfPlatform = 'electron' | 'native' | 'web'

export function detectPlatform(): CodesurfPlatform {
  if (typeof window === 'undefined') return 'web'
  const w = window as Window & { zero?: unknown; __CODESURF_PLATFORM__?: CodesurfPlatform }
  // installHostBridge marks a daemon-backed facade after detection. Respect
  // that explicit marker on later calls instead of mistaking the facade for an
  // Electron preload.
  if (w.__CODESURF_PLATFORM__ === 'electron' || w.__CODESURF_PLATFORM__ === 'native' || w.__CODESURF_PLATFORM__ === 'web') {
    return w.__CODESURF_PLATFORM__
  }
  // Electron preload wins whenever no explicit renderer marker is present.
  if (
    window.electron
    && (window.electron as typeof window.electron & { __codesurfHostKind?: string })
      .__codesurfHostKind !== 'electrobun'
  ) return 'electron'
  if (
    (window.electron as typeof window.electron & { __codesurfHostKind?: string } | undefined)
      ?.__codesurfHostKind === 'electrobun'
  ) return 'native'
  if (w.zero) return 'native'
  return 'web'
}

export function isElectronHost(): boolean {
  return detectPlatform() === 'electron'
}

export function isDaemonBackedHost(): boolean {
  const p = detectPlatform()
  return p === 'web' || p === 'native'
}
