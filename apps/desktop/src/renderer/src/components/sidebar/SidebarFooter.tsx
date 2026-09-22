import React, { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import { renderExtensionIcon } from '../extensionIcons'
import { TILE_ICONS } from './utils'
import { buildFooterExtensions, type FooterExtensionEntrySummary, type FooterTileEntry } from './footerExtensions'

interface ExtTileEntry extends FooterTileEntry {}
interface ExtensionEntrySummary extends FooterExtensionEntrySummary {}

export interface SidebarFooterProps {
  onNewTerminal: () => void
  onNewKanban: () => void
  onNewBrowser: () => void
  onNewChat: () => void
  onNewFiles: () => void
  onOpenSettings: (tab: string) => void
  extensionTiles?: ExtTileEntry[]
  extensionEntries?: ExtensionEntrySummary[]
  onAddExtensionTile?: (type: string) => void
  collapsed?: boolean
  /** When true, replaces the legacy extension flyout with a prominent "Get Extensions" button. */
  galleryEnabled?: boolean
  onOpenGallery?: () => void
}

export function SidebarFooter({
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat: _onNewChat, onNewFiles,
  onOpenSettings,
  extensionTiles, extensionEntries, onAddExtensionTile,
  collapsed,
  galleryEnabled,
  onOpenGallery: _onOpenGallery,
}: SidebarFooterProps): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [showExtMenu, setShowExtMenu] = useState(false)
  const extMenuRef = useRef<HTMLDivElement>(null)
  const footerIconColor = theme.text.secondary
  const footerButtonBackground = 'transparent'
  const footerButtonHoverBackground = `color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
  const footerButtonEdge = 'none'

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      if (extMenuRef.current && !extMenuRef.current.contains(target)) setShowExtMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    setShowExtMenu(false)
  }, [extensionEntries, extensionTiles])

  const footerExtensions = buildFooterExtensions(extensionTiles ?? [], extensionEntries ?? [])

  return (
    <div style={{ padding: collapsed ? '14px 8px 2px' : '14px 8px 2px 13px', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 6, flexDirection: 'row', width: 'fit-content' }}>
      <button
        onClick={() => onOpenSettings('general')}
        title="Settings"
        aria-label="Settings"
        style={{
          height: 28,
          width: 28,
          padding: 0,
          borderRadius: 7,
          border: 'none',
          background: footerButtonBackground,
          boxShadow: footerButtonEdge,
          color: footerIconColor,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0,
          flexShrink: 0,
          fontFamily: fonts.primary,
          fontSize: fonts.size,
          fontWeight: fonts.weight,
          lineHeight: 1,
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = footerButtonHoverBackground; e.currentTarget.style.color = theme.text.primary }}
        onMouseLeave={e => { e.currentTarget.style.background = footerButtonBackground; e.currentTarget.style.color = footerIconColor }}
      >
        <Settings size={16.2} strokeWidth={2} />
      </button>
      <div style={{ display: 'flex', justifyContent: 'flex-start', gap: 2, flexShrink: 0, flexDirection: 'row' }}>
        {([
          { label: 'New Terminal', icon: TILE_ICONS.terminal, action: onNewTerminal },
          { label: 'Agent Board', icon: TILE_ICONS.kanban, action: onNewKanban, disabled: true },
          { label: 'Browser', icon: TILE_ICONS.browser, action: onNewBrowser },
          { label: 'Files', icon: (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 3C1 2.17 1.67 1.5 2.5 1.5H5L6.5 3H11.5C12.33 3 13 3.67 13 4.5V11C13 11.83 12.33 12.5 11.5 12.5H2.5C1.67 12.5 1 11.83 1 11V3Z" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          ), action: onNewFiles },
        ] as { label: string; icon: React.ReactNode; action: () => void; disabled?: boolean }[]).map(btn => (
          <button key={btn.label} title={btn.disabled ? `${btn.label} disabled` : btn.label} style={{
            width: 24, height: 24, borderRadius: 6, border: 'none', background: footerButtonBackground,
            boxShadow: footerButtonEdge, color: btn.disabled ? theme.text.disabled : footerIconColor, cursor: btn.disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: btn.disabled ? 0.45 : 1,
          }}
            onMouseEnter={e => { if (!btn.disabled) { e.currentTarget.style.background = footerButtonHoverBackground; e.currentTarget.style.color = theme.text.primary } }}
            onMouseLeave={e => { e.currentTarget.style.background = footerButtonBackground; e.currentTarget.style.color = btn.disabled ? theme.text.disabled : footerIconColor }}
            onClick={btn.disabled ? undefined : btn.action}
          >
            {btn.icon}
          </button>
        ))}

        {/* Installed extensions render inline in the toolbar (surface: toolbar.bottomLeft). */}
        {galleryEnabled && footerExtensions.length > 0 && footerExtensions.map(ext => {
          const disabled = ext.tileType === 'ext:artifact-builder'
          const action = () => {
            if (ext.tileType) {
              onAddExtensionTile?.(ext.tileType)
              return
            }
            onOpenSettings('extensions')
          }
          return (
            <button
              key={ext.id}
              title={disabled ? `${ext.label} disabled` : ext.tileType ? ext.label : `${ext.label} settings`}
              onClick={disabled ? undefined : action}
              style={{
                width: 24, height: 24, borderRadius: 6, border: 'none', background: footerButtonBackground,
                boxShadow: footerButtonEdge,
                color: disabled ? theme.text.disabled : footerIconColor,
                cursor: disabled ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: disabled ? 0.45 : 1,
                fontSize: 12, lineHeight: 1,
              }}
              onMouseEnter={e => { if (!disabled) { e.currentTarget.style.background = footerButtonHoverBackground; e.currentTarget.style.color = theme.text.primary } }}
              onMouseLeave={e => { e.currentTarget.style.background = footerButtonBackground; e.currentTarget.style.color = disabled ? theme.text.disabled : footerIconColor }}
            >
              {renderExtensionIcon(ext.icon, 12)}
            </button>
          )
        })}

        {!galleryEnabled && footerExtensions.length > 0 && (
          <div style={{ position: 'relative' }} ref={extMenuRef}>
            <button title="Plugins" style={{
              width: 28, height: 28, borderRadius: 6, border: 'none', background: footerButtonBackground,
              boxShadow: footerButtonEdge, color: showExtMenu ? theme.text.primary : footerIconColor, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = footerButtonHoverBackground; e.currentTarget.style.color = theme.text.primary }}
              onMouseLeave={e => { e.currentTarget.style.background = footerButtonBackground; if (!showExtMenu) e.currentTarget.style.color = footerIconColor }}
              onClick={() => setShowExtMenu(p => !p)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1v0a1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                <path d="M8 7.5h2a.5.5 0 01.5.5v1.5H10a1 1 0 00-1 1v0a1 1 0 001 1h.5V13a.5.5 0 01-.5.5H8V13a1 1 0 00-1-1v0a1 1 0 00-1 1v.5H4.5A.5.5 0 014 13v-1.5h.5a1 1 0 001-1v0a1 1 0 00-1-1H4V8a.5.5 0 01.5-.5H8z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity="0.5" />
              </svg>
            </button>
            {showExtMenu && (
              <div style={{
                position: 'absolute', bottom: 32, right: 0, minWidth: 160,
                background: theme.surface.panelElevated, border: `1px solid ${theme.border.default}`, borderRadius: 8,
                padding: 4, boxShadow: theme.shadow.panel, zIndex: 1000,
              }}>
                {footerExtensions.map(ext => {
                  const disabled = ext.tileType === 'ext:artifact-builder'
                  const action = () => {
                    if (ext.tileType) {
                      onAddExtensionTile?.(ext.tileType)
                      return
                    }
                    onOpenSettings('extensions')
                  }
                  return (
                    <button key={ext.id} onClick={disabled ? undefined : () => { action(); setShowExtMenu(false) }} style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', borderRadius: 6,
                      border: 'none', background: 'transparent', color: disabled ? theme.text.disabled : theme.text.secondary, fontSize: fonts.size, cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
                      opacity: disabled ? 0.45 : 1,
                    }}
                      onMouseEnter={e => {
                        if (disabled) return
                        e.currentTarget.style.background = theme.surface.panelMuted
                        e.currentTarget.style.color = theme.text.primary
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent'
                        e.currentTarget.style.color = disabled ? theme.text.disabled : theme.text.secondary
                      }}
                      title={disabled ? `${ext.label} disabled` : ext.tileType ? ext.label : `${ext.label} settings`}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, color: 'currentColor', flexShrink: 0 }}>
                        {renderExtensionIcon(ext.icon, 12)}
                      </span>
                      <span>{ext.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
