import React, { useEffect, useState } from 'react'
import type { AppSettings } from '../../../../shared/types'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import { Button, Select, Toggle as UIToggle } from '../ui'
import { SectionLabel, SettingRow } from './controls'

interface ChromeProfile {
  name: string
  dir: string
  email?: string
}

export function ChromeSyncSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings
  onUpdate: (key: keyof AppSettings, value: any) => void
}): React.JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [profiles, setProfiles] = useState<ChromeProfile[]>([])
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    window.electron?.chromeSync?.listProfiles().then((p: ChromeProfile[]) => {
      setProfiles(p)
      if (p.length > 0 && !settings.chromeSyncProfileDir) {
        onUpdate('chromeSyncProfileDir', p[0].dir)
      }
    }).catch(() => {})
  }, [onUpdate, settings.chromeSyncProfileDir])

  const handleSync = async () => {
    if (!settings.chromeSyncProfileDir || syncing) return
    setSyncing(true)
    setSyncStatus('Syncing...')
    try {
      const result = await window.electron?.chromeSync?.syncCookies(
        settings.chromeSyncProfileDir,
        'persist:browser-tile-test',
      )
      if (result?.errors?.length > 0) {
        setSyncStatus(`Synced ${result.count} cookies (${result.errors.length} errors)`)
      } else {
        setSyncStatus(`Synced ${result?.count ?? 0} cookies`)
      }
    } catch (e) {
      setSyncStatus(`Error: ${e instanceof Error ? e.message : 'Failed'}`)
    } finally {
      setSyncing(false)
    }
  }

  const noChrome = profiles.length === 0

  return (
    <>
      <SectionLabel label="Chrome Data Sync" />
      <SettingRow label="Enable Chrome sync" description="Import cookies, bookmarks, and history from Chrome into browser blocks">
        <UIToggle value={settings.chromeSyncEnabled} onChange={value => onUpdate('chromeSyncEnabled', value)} />
      </SettingRow>

      {settings.chromeSyncEnabled && (
        <>
          <SettingRow label="Chrome profile" description={noChrome ? 'Chrome not detected on this machine' : 'Select which Chrome profile to sync from'}>
            {noChrome ? (
              <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>Not found</span>
            ) : (
              <Select
                value={settings.chromeSyncProfileDir ?? ''}
                onChange={e => onUpdate('chromeSyncProfileDir', e.target.value)}
                style={{ minWidth: 180 }}
              >
                {profiles.map(p => (
                  <option key={p.dir} value={p.dir}>
                    {p.name}{p.email ? ` (${p.email})` : ''}
                  </option>
                ))}
              </Select>
            )}
          </SettingRow>

          <SettingRow label="Sync now" description="Import Chrome cookies into all new browser blocks">
            <Button onClick={handleSync} disabled={syncing || noChrome} variant="primary" size="sm">
              {syncing ? 'Syncing...' : 'Sync'}
            </Button>
          </SettingRow>

          {syncStatus && (
            <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, padding: '4px 2px' }}>
              {syncStatus}
            </div>
          )}
        </>
      )}

      <SectionLabel label="What gets synced" />
      <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, lineHeight: 1.6, padding: '0 2px' }}>
        <strong style={{ color: theme.text.secondary }}>Cookies</strong> — Logged-in sessions from Chrome are injected into each new browser block so you are immediately authenticated.<br />
        <strong style={{ color: theme.text.secondary }}>Bookmarks</strong> — Available in the browser toolbar (coming soon).<br />
        <strong style={{ color: theme.text.secondary }}>History</strong> — Address bar autocomplete from Chrome history (coming soon).<br />
        <strong style={{ color: theme.text.secondary }}>Note:</strong> macOS will prompt you once for Keychain access to decrypt Chrome cookies.
      </div>
    </>
  )
}
