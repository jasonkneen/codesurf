import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Paperclip } from 'lucide-react'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import type { ModelOption } from '../../config/providers'
import { filterModels } from '../../config/providers'
import type { MCPServerEntry } from '../../hooks/useMCPServers'

const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}

export interface ChatSurfaceMenuEntry {
  extId: string
  surfaceId: string
  label: string
  description?: string
  icon?: string
  emits: 'image' | 'text'
  defaultHeight: number
  minHeight: number
}

function MCPIcon({ size = 14, color = 'currentColor' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <line x1="7.5" y1="8" x2="11" y2="16" />
      <line x1="16.5" y1="8" x2="13" y2="16" />
      <line x1="8.5" y1="6" x2="15.5" y2="6" />
    </svg>
  )
}

// Renders children in a portal at document.body so they escape tile overflow:hidden clipping.
// Positions above the anchor element, right-aligned so menus don't overflow off the right edge.
export function MenuPortal({ anchorRef, children }: { anchorRef: React.RefObject<HTMLElement | null>; children: React.ReactNode }): JSX.Element | null {
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null)

  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 4,
      right: window.innerWidth - rect.right,
    })
  }, [anchorRef])

  if (!pos) return null
  return createPortal(
    <div
      data-chat-menu-portal="true"
      style={{ position: 'fixed', bottom: pos.bottom, right: pos.right, zIndex: 99999 }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  )
}

export function Dropdown({ children }: { children: React.ReactNode }): JSX.Element {
  const theme = useTheme()
  const dropdownBackground = theme.chat.dropdownBackground
  const dropdownBorder = theme.chat.dropdownBorder
  return (
    <div style={{
      minWidth: 160,
      background: dropdownBackground, border: `1px solid ${dropdownBorder}`,
      borderRadius: 8, padding: 4,
      boxShadow: theme.shadow.panel,
      ...NON_SELECTABLE_UI_STYLE,
    }}>
      {children}
    </div>
  )
}

export function ComposerInsertMenu({
  onAttachFiles,
  mcpEnabled,
  onToggleMcpEnabled,
  mcpServers,
  disabledServers,
  setDisabledServers,
  peerToolNames,
  chatSurfaces,
  activeChatSurfaceId,
  onOpenChatSurface,
  renderChatSurfaceIcon,
}: {
  onAttachFiles: () => void
  mcpEnabled: boolean
  onToggleMcpEnabled: () => void
  mcpServers: MCPServerEntry[]
  disabledServers: Set<string>
  setDisabledServers: React.Dispatch<React.SetStateAction<Set<string>>>
  peerToolNames: string[]
  chatSurfaces: ChatSurfaceMenuEntry[]
  activeChatSurfaceId: string | null
  onOpenChatSurface: (entry: ChatSurfaceMenuEntry) => void
  renderChatSurfaceIcon: (icon: string | undefined, size?: number) => React.ReactNode
}): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [mcpSubmenuOpen, setMcpSubmenuOpen] = useState(false)

  const itemStyle = (active: boolean): React.CSSProperties => ({
    width: '100%',
    border: 'none',
    background: active ? theme.chat.dropdownHoverBackground : 'transparent',
    color: theme.chat.text,
    borderRadius: 8,
    padding: '9px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 0.12s ease',
    ...NON_SELECTABLE_UI_STYLE,
  })

  return (
    <div style={{ position: 'relative' }}>
      <Dropdown>
        <button
          type="button"
          onClick={onAttachFiles}
          style={itemStyle(false)}
          onMouseEnter={e => { e.currentTarget.style.background = theme.chat.dropdownHoverBackground }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <Paperclip size={14} color={theme.chat.muted} />
          <span style={{ fontSize: 12, fontFamily: fonts.primary }}>Add photos & files</span>
        </button>

        <div style={{ height: 1, background: theme.chat.dropdownBorder, margin: '4px 0' }} />

        <div
          style={{ position: 'relative' }}
          onMouseEnter={() => setMcpSubmenuOpen(true)}
          onMouseLeave={() => setMcpSubmenuOpen(false)}
        >
          <button
            type="button"
            onClick={() => setMcpSubmenuOpen(open => !open)}
            style={itemStyle(mcpSubmenuOpen)}
          >
            <MCPIcon size={14} color={mcpEnabled ? theme.chat.text : theme.chat.muted} />
            <span style={{ fontSize: 12, fontFamily: fonts.primary, flex: 1 }}>MCP Tools</span>
            <ChevronRight size={13} color={theme.chat.muted} />
          </button>

          {mcpSubmenuOpen && (
            <div style={{ position: 'absolute', top: 0, left: 'calc(100% + 8px)' }}>
              <Dropdown>
                <DropdownItem
                  icon={<MCPIcon size={11} />}
                  label="MCP Tools"
                  active={mcpEnabled}
                  onClick={onToggleMcpEnabled}
                />
                {mcpEnabled && mcpServers.length > 0 && (
                  <>
                    <div style={{ height: 1, background: theme.chat.dropdownBorder, margin: '4px 0' }} />
                    {mcpServers.map(server => {
                      const enabled = !disabledServers.has(server.name)
                      return (
                        <DropdownItem
                          key={server.name}
                          label={server.name}
                          sublabel={server.url ? 'http' : 'stdio'}
                          active={enabled}
                          onClick={() => setDisabledServers(prev => {
                            const next = new Set(prev)
                            if (enabled) next.add(server.name)
                            else next.delete(server.name)
                            return next
                          })}
                        />
                      )
                    })}
                  </>
                )}
                {mcpEnabled && mcpServers.length === 0 && (
                  <div style={{ padding: '6px 10px', fontSize: 11, color: theme.chat.muted, fontStyle: 'italic' }}>
                    No MCP servers configured
                  </div>
                )}
                {mcpEnabled && peerToolNames.length > 0 && (
                  <>
                    <div style={{ height: 1, background: theme.chat.dropdownBorder, margin: '4px 0' }} />
                    <div style={{ padding: '4px 10px 2px 10px', fontSize: 11, color: theme.chat.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      Connected peer tools
                    </div>
                    {peerToolNames.map(tool => (
                      <DropdownItem
                        key={`peer-tool-${tool}`}
                        label={tool}
                        sublabel="peer"
                        active={mcpEnabled}
                        onClick={() => { /* read-only affordance */ }}
                      />
                    ))}
                  </>
                )}
              </Dropdown>
            </div>
          )}
        </div>

        {chatSurfaces.length > 0 && (
          <>
            <div style={{ height: 1, background: theme.chat.dropdownBorder, margin: '4px 0' }} />
            {chatSurfaces.map(entry => {
              const id = `${entry.extId}:${entry.surfaceId}`
              const active = activeChatSurfaceId === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onOpenChatSurface(entry)}
                  style={itemStyle(active)}
                  onMouseEnter={e => { e.currentTarget.style.background = theme.chat.dropdownHoverBackground }}
                  onMouseLeave={e => { e.currentTarget.style.background = active ? theme.chat.dropdownHoverBackground : 'transparent' }}
                  title={entry.description ?? entry.label}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: theme.chat.muted }}>
                    {renderChatSurfaceIcon(entry.icon ?? entry.surfaceId, 14)}
                  </span>
                  <span style={{ fontSize: 12, fontFamily: fonts.primary }}>Add {entry.label}</span>
                </button>
              )
            })}
          </>
        )}
      </Dropdown>
    </div>
  )
}

export function ModelDropdown({ models, activeId, filter, onFilterChange, providerIcon, noun, onSelect }: {
  models: ModelOption[]; activeId: string; filter: string; onFilterChange: (v: string) => void
  providerIcon: React.ReactNode; noun: 'model' | 'agent'; onSelect: (id: string) => void
}): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const inputRef = useRef<HTMLInputElement>(null)
  const hasMany = models.length > 6

  useEffect(() => { if (hasMany) inputRef.current?.focus() }, [hasMany])

  const filtered = filterModels(models, filter)

  return (
    <div style={{
      minWidth: 200, maxWidth: 280,
      background: theme.chat.dropdownBackground, border: `1px solid ${theme.chat.dropdownBorder}`,
      borderRadius: 8, padding: 4,
      boxShadow: theme.shadow.panel,
      zIndex: 9999,
      display: 'flex', flexDirection: 'column',
    }}>
      {hasMany && (
        <div style={{ padding: '4px 4px 2px' }}>
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={e => onFilterChange(e.target.value)}
            placeholder={`Filter ${noun}s...`}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '5px 8px', fontSize: 11,
              background: (theme.chat as any).inputBackground ?? theme.chat.background,
              color: theme.chat.text, border: `1px solid ${theme.chat.dropdownBorder}`,
              borderRadius: 5, outline: 'none',
              fontFamily: fonts.mono,
            }}
            onKeyDown={e => e.stopPropagation()}
          />
        </div>
      )}
      <div style={{
        maxHeight: 240, overflowY: 'auto', overflowX: 'hidden',
      }}>
        {filtered.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 11, color: theme.chat.muted, fontFamily: fonts.primary }}>
            {`No matching ${noun}s`}
          </div>
        )}
        {filtered.map(m => (
          <DropdownItem
            key={m.id}
            icon={providerIcon}
            label={m.label}
            sublabel={m.description ?? (m.id.includes('/') ? m.id.split('/')[0] : undefined)}
            active={activeId === m.id}
            onClick={() => onSelect(m.id)}
          />
        ))}
      </div>
    </div>
  )
}

export function DropdownItem({ icon, label, sublabel, active, onClick }: {
  icon?: React.ReactNode; label: string; sublabel?: string; active: boolean; onClick: () => void
}): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [h, setH] = useState(false)
  const dropdownActiveBackground = theme.chat.dropdownActiveBackground
  const dropdownHoverBackground = theme.chat.dropdownHoverBackground
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 8,
        background: active ? dropdownActiveBackground : (h ? dropdownHoverBackground : 'transparent'),
        transition: 'background 0.1s',
        ...NON_SELECTABLE_UI_STYLE,
      }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {icon && <span style={{ display: 'flex', color: active ? theme.accent.base : theme.chat.muted }}>{icon}</span>}
      <span style={{
        fontSize: 12, color: active ? theme.accent.base : theme.chat.text,
        fontFamily: fonts.primary,
      }}>
        {label}
      </span>
      {active && <Check size={12} color={theme.accent.base} style={{ marginLeft: 'auto' }} />}
      {sublabel && !active && (
        <span style={{ fontSize: 9, color: theme.chat.subtle, fontFamily: fonts.mono }}>{sublabel}</span>
      )}
    </div>
  )
}
