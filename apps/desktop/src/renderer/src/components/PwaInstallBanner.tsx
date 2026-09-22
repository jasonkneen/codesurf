/**
 * Lightweight install / update chrome for CodeSurf as a desktop PWA
 * (Chrome "Install app", Safari "Add to Dock").
 */
import React, { useEffect, useState } from 'react'
import { applyPwaUpdate, isPwaDisplayMode } from '../platform/pwa'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export function PwaInstallBanner(): React.JSX.Element | null {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [needRefresh, setNeedRefresh] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const standalone = isPwaDisplayMode()

  useEffect(() => {
    const onBip = (event: Event) => {
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBip)
    return () => window.removeEventListener('beforeinstallprompt', onBip)
  }, [])

  useEffect(() => {
    // Wired from AppBootstrap via custom event so registration stays one place
    const onNeed = () => setNeedRefresh(true)
    window.addEventListener('codesurf-pwa-need-refresh', onNeed)
    return () => window.removeEventListener('codesurf-pwa-need-refresh', onNeed)
  }, [])

  if (dismissed) return null
  if (!needRefresh && (standalone || !installEvent)) return null

  const barStyle: React.CSSProperties = {
    position: 'fixed',
    left: 16,
    right: 16,
    bottom: 16,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 14px',
    borderRadius: 12,
    background: '#161b22',
    border: '1px solid #30363d',
    color: '#e6edf3',
    boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
    fontSize: 13,
  }

  const btn: React.CSSProperties = {
    border: 'none',
    borderRadius: 8,
    padding: '8px 12px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 12,
  }

  if (needRefresh) {
    return (
      <div style={barStyle} role="status">
        <span>A new CodeSurf version is ready.</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={{ ...btn, background: 'transparent', color: '#8b949e' }}
            onClick={() => setDismissed(true)}
          >
            Later
          </button>
          <button
            type="button"
            style={{ ...btn, background: '#38bdf8', color: '#0c0c0c' }}
            onClick={() => { void applyPwaUpdate() }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={barStyle} role="dialog" aria-label="Install CodeSurf">
      <span>
        Install CodeSurf as a desktop app
        <span style={{ color: '#8b949e', marginLeft: 6 }}>(Chrome / Edge / Safari)</span>
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          style={{ ...btn, background: 'transparent', color: '#8b949e' }}
          onClick={() => setDismissed(true)}
        >
          Not now
        </button>
        <button
          type="button"
          style={{ ...btn, background: '#38bdf8', color: '#0c0c0c' }}
          onClick={async () => {
            if (!installEvent) return
            await installEvent.prompt()
            await installEvent.userChoice
            setInstallEvent(null)
            setDismissed(true)
          }}
        >
          Install
        </button>
      </div>
    </div>
  )
}
