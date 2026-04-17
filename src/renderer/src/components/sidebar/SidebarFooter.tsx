import React, { useEffect, useRef, useState } from 'react'
import { Pin, Settings, Package, Puzzle } from 'lucide-react'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import { TILE_ICONS } from './utils'

interface ExtTileEntry { extId: string; type: string; label: string; icon?: string }

export interface SidebarFooterProps {
  onNewTerminal: () => void
  onNewKanban: () => void
  onNewBrowser: () => void
  onNewChat: () => void
  onNewFiles: () => void
  onOpenSettings: (tab: string) => void
  extensionTiles?: ExtTileEntry[]
  onAddExtensionTile?: (type: string) => void
  collapsed?: boolean
  /** When true, replaces the legacy extension flyout with a prominent "Get Extensions" button. */
  galleryEnabled?: boolean
  onOpenGallery?: () => void
}

export function SidebarFooter({
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onNewFiles,
  onOpenSettings,
  extensionTiles, onAddExtensionTile,
  collapsed,
  galleryEnabled,
  onOpenGallery,
}: SidebarFooterProps): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [showExtMenu, setShowExtMenu] = useState(false)
  const extMenuRef = useRef<HTMLDivElement>(null)
  const footerIconColor = theme.text.secondary

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
  }, [extensionTiles])

  return (
    <div style={{ padding: '14px 8px 2px', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: collapsed ? 6 : 10, flexDirection: 'row', width: 'fit-content' }}>
      {galleryEnabled && onOpenGallery && !collapsed && (
        <button
          onClick={onOpenGallery}
          title="Browse and install extensions"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 24,
            padding: '0 9px',
            borderRadius: 6,
            border: `1px solid ${theme.accent.base}`,
            background: theme.accent.base,
            color: theme.text.inverse,
            fontSize: Math.max(11, fonts.size - 1),
            fontWeight: 600,
            fontFamily: fonts.primary,
            lineHeight: 1,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.08)' }}
          onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
        >
          <Package size={12} />
          <span>Get Extensions</span>
        </button>
      )}
      {galleryEnabled && onOpenGallery && collapsed && (
        <button
          onClick={onOpenGallery}
          title="Get Extensions"
          style={{
            width: 24, height: 24, borderRadius: 6,
            border: `1px solid ${theme.accent.base}`,
            background: theme.accent.base,
            color: theme.text.inverse,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <Package size={12} />
        </button>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-start', gap: 2, flexShrink: 0, flexDirection: 'row' }}>
        {([
          { label: 'Settings', icon: <Settings size={12} />, action: () => onOpenSettings('general') },
          { label: 'New Terminal', icon: TILE_ICONS.terminal, action: onNewTerminal },
          { label: 'Agent Board', icon: TILE_ICONS.kanban, action: onNewKanban, disabled: true },
          { label: 'Browser', icon: TILE_ICONS.browser, action: onNewBrowser },
          { label: 'Chat', icon: TILE_ICONS.chat, action: onNewChat },
          { label: 'Files', icon: TILE_ICONS.files, action: onNewFiles },
        ] as { label: string; icon: React.ReactNode; action: () => void; disabled?: boolean }[]).map(btn => (
          <button key={btn.label} title={btn.disabled ? `${btn.label} disabled` : btn.label} style={{
            width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent',
            color: btn.disabled ? theme.text.disabled : footerIconColor, cursor: btn.disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: btn.disabled ? 0.45 : 1,
          }}
            onMouseEnter={e => { if (!btn.disabled) e.currentTarget.style.color = theme.text.primary }}
            onMouseLeave={e => { e.currentTarget.style.color = btn.disabled ? theme.text.disabled : footerIconColor }}
            onClick={btn.disabled ? undefined : btn.action}
          >
            {btn.icon}
          </button>
        ))}

        {/* Installed extensions render inline in the toolbar (surface: toolbar.bottomLeft). */}
        {galleryEnabled && extensionTiles && extensionTiles.length > 0 && extensionTiles.map(ext => {
          const disabled = ext.type === 'ext:artifact-builder'
          return (
            <button
              key={ext.type}
              title={disabled ? `${ext.label} disabled` : ext.label}
              onClick={disabled ? undefined : () => onAddExtensionTile?.(ext.type)}
              style={{
                width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent',
                color: disabled ? theme.text.disabled : footerIconColor,
                cursor: disabled ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: disabled ? 0.45 : 1,
                fontSize: 12, lineHeight: 1,
              }}
              onMouseEnter={e => { if (!disabled) e.currentTarget.style.color = theme.text.primary }}
              onMouseLeave={e => { e.currentTarget.style.color = disabled ? theme.text.disabled : footerIconColor }}
            >
              {ext.icon ? <span style={{ fontSize: 12, lineHeight: 1 }}>{ext.icon}</span> : <Puzzle size={12} />}
            </button>
          )
        })}

        {!galleryEnabled && extensionTiles && extensionTiles.length > 0 && (
          <div style={{ position: 'relative' }} ref={extMenuRef}>
            <button title="Extensions" style={{
              width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent',
              color: showExtMenu ? theme.text.primary : footerIconColor, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
              onMouseEnter={e => { e.currentTarget.style.color = theme.text.primary }}
              onMouseLeave={e => { if (!showExtMenu) e.currentTarget.style.color = footerIconColor }}
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
                {extensionTiles.map(ext => {
                  const disabled = ext.type === 'ext:artifact-builder'
                  return (
                    <button key={ext.type} onClick={disabled ? undefined : () => { onAddExtensionTile?.(ext.type); setShowExtMenu(false) }} style={{
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
                      title={disabled ? `${ext.label} disabled` : ext.label}
                    >
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
