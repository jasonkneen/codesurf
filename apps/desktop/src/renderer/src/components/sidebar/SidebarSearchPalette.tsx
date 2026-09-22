/**
 * Sidebar fuzzy session-search palette — extracted verbatim from Sidebar.tsx.
 * Self-contained: props in, theme/fonts from context.
 */
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import type { SessionEntry } from './types'
import { formatSessionTitleForSidebar, getSessionAgentIcon } from './utils'

export function SidebarSearchPalette({
  query,
  sessions,
  onQueryChange,
  onOpenSession,
  onClose,
}: {
  query: string
  sessions: SessionEntry[]
  onQueryChange: (value: string) => void
  onOpenSession: (session: SessionEntry) => void
  onClose: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-label="Search chats"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(0, 0, 0, 0.28)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '7vh',
      }}
    >
      <div
        style={{
          width: 'min(680px, calc(100vw - 72px))',
          maxHeight: 'min(560px, calc(100vh - 96px))',
          borderRadius: 22,
          background: theme.surface.panelElevated,
          border: `1px solid ${theme.border.default}`,
          boxShadow: theme.shadow.panel,
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Search chats"
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: theme.text.primary,
            fontSize: Math.max(15, fonts.size + 2),
            fontFamily: fonts.primary,
            fontWeight: 600,
            padding: '12px 16px 10px',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ padding: '8px 14px 6px', color: theme.text.disabled, fontSize: Math.max(11, fonts.secondarySize), fontWeight: 700 }}>
          Recent chats
        </div>
        <div className="cs-fade-scroll-y cs-fade-scroll-y-sm" style={{ overflowY: 'auto', paddingBottom: 6 }}>
          {sessions.map((session, index) => (
            <button
              key={`${session.workspaceId}:${session.id}`}
              type="button"
              onClick={() => {
                onOpenSession(session)
                onClose()
              }}
              style={{
                width: '100%',
                border: 'none',
                borderRadius: 14,
                background: index === 0 ? theme.surface.hover : 'transparent',
                color: index === 0 ? theme.text.primary : theme.text.secondary,
                cursor: 'pointer',
                display: 'grid',
                gridTemplateColumns: '20px minmax(0, 1fr) auto auto',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                fontFamily: fonts.primary,
                textAlign: 'left',
              }}
              onMouseEnter={event => {
                event.currentTarget.style.background = theme.surface.hover
                event.currentTarget.style.color = theme.text.primary
              }}
              onMouseLeave={event => {
                event.currentTarget.style.background = index === 0 ? theme.surface.hover : 'transparent'
                event.currentTarget.style.color = index === 0 ? theme.text.primary : theme.text.secondary
              }}
            >
              <span style={{ display: 'flex', color: 'currentColor', opacity: 0.75 }}>{getSessionAgentIcon(session)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: Math.max(12, fonts.size), fontWeight: 400 }}>
                {formatSessionTitleForSidebar(session.title, 90)}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: theme.text.disabled, fontSize: Math.max(11, fonts.secondarySize), maxWidth: 150 }}>
                {session.workspaceName ?? session.sourceLabel}
              </span>
              <span style={{ borderRadius: 10, background: theme.surface.panelMuted, color: theme.text.secondary, padding: '1px 7px', fontSize: Math.max(11, fonts.secondarySize), lineHeight: 1.35 }}>
                {index < 9 ? `⌘${index + 1}` : ''}
              </span>
            </button>
          ))}
          {sessions.length === 0 && (
            <div style={{ padding: '16px 14px 22px', color: theme.text.disabled, fontSize: Math.max(12, fonts.size) }}>
              No matching chats
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

