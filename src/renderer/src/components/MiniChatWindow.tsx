import React, { Suspense, useEffect } from 'react'
import { X } from 'lucide-react'
import type { AppSettings, TileState, Workspace } from '../../../shared/types'
import { FontProvider, FontTokenProvider } from '../FontContext'
import { ThemeProvider } from '../ThemeContext'
import type { AppFonts } from '../hooks/useAppThemeCssVars'
import type { MiniChatOptions } from '../lib/miniChatWindow'
import type { AppTheme } from '../theme'
import type { DiscoveryPeer } from './chat/chatTileUtils'

const LazyChatTile = React.lazy(() => import('./ChatTile').then(m => ({ default: m.ChatTile })))

export type MiniChatWindowProps = {
  miniChatOptions: MiniChatOptions
  theme: AppTheme
  appFonts: AppFonts
  fontTokens: AppSettings['fonts']
  workspace: Workspace | null
  miniChatTile: TileState | null | undefined
  miniChatPeers: DiscoveryPeer[]
  settings: AppSettings
  chatReloadToken: number
  isConnected: boolean
  isAutoConnected: boolean
  onChatModePreferenceChange?: (providerId: string, modeId: string) => void
}

export function MiniChatWindow({
  miniChatOptions,
  theme,
  appFonts,
  fontTokens,
  workspace,
  miniChatTile,
  miniChatPeers,
  settings,
  chatReloadToken,
  isConnected,
  isAutoConnected,
  onChatModePreferenceChange,
}: MiniChatWindowProps): JSX.Element {
  useEffect(() => {
    void window.electron?.window?.setTitle?.(miniChatOptions.title)
  }, [miniChatOptions.title])

  return (
    <ThemeProvider value={theme}>
      <FontTokenProvider value={fontTokens}>
        <FontProvider value={appFonts}>
          <div
            className="cs-mini-chat-window"
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              color: theme.text.primary,
              fontFamily: appFonts.primary,
              fontSize: appFonts.size,
              background: theme.surface.app,
            }}
          >
            <div
              className="cs-mini-window-titlebar"
              style={{
                height: 38,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: window.electron?.platform === 'darwin'
                  ? '0 10px 0 80px'
                  : '0 10px 0 14px',
                borderBottom: `1px solid ${theme.border.subtle}`,
                background: theme.surface.titlebar,
                backdropFilter: 'blur(18px)',
                WebkitBackdropFilter: 'blur(18px)',
                WebkitAppRegion: 'drag',
                userSelect: 'none',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: theme.accent.base,
                  boxShadow: `0 0 14px ${theme.accent.base}`,
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {miniChatOptions.title}
                </div>
                <div style={{ fontSize: 10, color: theme.text.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Floating CodeSurf chat · {workspace?.name ?? 'loading workspace'}
                </div>
              </div>
              <button
                type="button"
                title="Close mini chat"
                onClick={async () => {
                  try {
                    const id = await window.electron?.window?.getCurrentId?.()
                    if (id !== undefined) await window.electron?.window?.closeById?.(id)
                    else window.close()
                  } catch {
                    window.close()
                  }
                }}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 999,
                  border: `1px solid ${theme.border.subtle}`,
                  background: theme.surface.panelMuted,
                  color: theme.text.secondary,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  WebkitAppRegion: 'no-drag',
                }}
              >
                <X size={13} />
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, background: theme.chat.background }}>
              <Suspense fallback={<div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 12 }}>Loading chat…</div>}>
                {miniChatTile ? (
                  <LazyChatTile
                    tileId={miniChatTile.id}
                    workspaceId={workspace?.id ?? miniChatOptions.workspaceId}
                    workspaceDir={workspace?.path ?? ''}
                    width={Math.max(360, window.innerWidth)}
                    height={Math.max(360, window.innerHeight - 38)}
                    reloadToken={chatReloadToken}
                    settings={settings}
                    onChatModePreferenceChange={onChatModePreferenceChange}
                    isConnected={isConnected}
                    isAutoConnected={isAutoConnected}
                    connectedPeers={miniChatPeers}
                  />
                ) : (
                  <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center', color: theme.text.secondary }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 650, color: theme.text.primary, marginBottom: 6 }}>Chat unavailable</div>
                      <div style={{ fontSize: 12, lineHeight: 1.5 }}>The source chat tile could not be found in this workspace.</div>
                    </div>
                  </div>
                )}
              </Suspense>
            </div>
          </div>
        </FontProvider>
      </FontTokenProvider>
    </ThemeProvider>
  )
}