/**
 * MCP servers settings section — extracted from SettingsPanel's `case 'mcp'`
 * render closure (A1 god-object split). theme/fonts via context; MCP config +
 * server-edit state and callbacks via props. Owns MCPServerEntry/MCPConfig
 * types (re-imported by SettingsPanel).
 */
import React, { lazy } from 'react'
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import type { Workspace } from '../../../../shared/types'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { SectionLabel, Toggle } from './controls'

const LazyToolsSection = lazy(() => import('../CustomisationTile').then(m => ({ default: m.ToolsSection })))

export interface MCPServerEntry {
  type?: 'stdio' | 'sse' | 'http'
  url?: string
  cmd?: string
  args?: string[]
  command?: string
  description?: string
  enabled?: boolean
}

export interface MCPConfig {
  port: number
  url: string
  mcpServers: Record<string, MCPServerEntry>
  endpoints: Record<string, string>
  updatedAt: string
}

export interface McpSectionProps {
  mcpConfig: MCPConfig | null
  mcpSaved: boolean
  addingServer: boolean
  setAddingServer: React.Dispatch<React.SetStateAction<boolean>>
  newServer: { name: string; url: string; cmd: string; description: string }
  setNewServer: React.Dispatch<React.SetStateAction<{ name: string; url: string; cmd: string; description: string }>>
  expandedServer: string | null
  setExpandedServer: React.Dispatch<React.SetStateAction<string | null>>
  workspaceServers: Record<string, Record<string, MCPServerEntry>>
  activeWorkspaceId: string | null
  setActiveWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>
  updateServer: (name: string, patch: Partial<MCPServerEntry>) => void
  removeServer: (name: string) => void
  addServer: () => void
  saveWorkspaceServers: (wsId: string, servers: Record<string, MCPServerEntry>) => Promise<void> | void
  updateWorkspaceServer: (wsId: string, name: string, patch: Partial<MCPServerEntry>) => void
  removeWorkspaceServer: (wsId: string, name: string) => void
  workspaces: Workspace[]
  /** True when rendered via the Tools tab (shows the embedded tools/permissions block). */
  isToolsView: boolean
}

export function McpSection(props: McpSectionProps): React.JSX.Element {
  const {
    mcpConfig,
    mcpSaved,
    addingServer,
    setAddingServer,
    newServer,
    setNewServer,
    expandedServer,
    setExpandedServer,
    workspaceServers,
    activeWorkspaceId,
    setActiveWorkspaceId,
    updateServer,
    removeServer,
    addServer,
    saveWorkspaceServers,
    updateWorkspaceServer,
    removeWorkspaceServer,
    workspaces,
    isToolsView,
  } = props
  const theme = useTheme()
  const fonts = useAppFonts()

        const servers = mcpConfig?.mcpServers ?? {}
        const userServers = Object.entries(servers).filter(([k]) => k !== 'codesurf' && k !== 'contex')
        return (
          <>
            {/* Tools & permissions — only when accessed via Tools tab */}
            {isToolsView && (
              <div style={{ marginBottom: 20 }}>
                <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
                  <LazyToolsSection hideHeaderText />
                </React.Suspense>
              </div>
            )}

            {/* MCP Server Status */}
            <SectionLabel label="Server Status" />
            <div style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '12px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: mcpConfig ? theme.status.success : '#555', boxShadow: mcpConfig ? '0 0 6px #3fb950' : 'none', flexShrink: 0 }} />
                <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500 }}>codesurf</span>
                <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: 'inherit', marginLeft: 'auto' }}>built-in</span>
              </div>
              {mcpConfig && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {Object.entries(mcpConfig.endpoints ?? {}).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: theme.text.muted, fontFamily: fonts.mono, width: 50, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontSize: 10, color: theme.status.success, fontFamily: fonts.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                      <button onClick={() => navigator.clipboard.writeText(v)}
                        style={{ fontSize: 9, color: theme.text.muted, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                        onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
                        onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
                        copy
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* User servers */}
            <SectionLabel label={`Connected Servers${mcpSaved ? ' — saved' : ''}`} />
            {userServers.map(([name, s]) => (
              <div key={name} style={{ background: theme.surface.panelMuted, borderRadius: 10, marginBottom: 6, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
                  <span
                    onClick={() => updateServer(name, { enabled: !(s.enabled !== false) })}
                    title="Toggle enabled"
                    style={{ width: 7, height: 7, borderRadius: '50%', background: s.enabled !== false ? theme.status.success : theme.border.default, flexShrink: 0, cursor: 'pointer' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500 }}>{name}</div>
                    {s.description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, marginTop: 1 }}>{s.description}</div>}
                    <div style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.url ?? s.cmd}
                    </div>
                  </div>
                  <button onClick={() => setExpandedServer(expandedServer === name ? null : name)}
                    style={{ background: 'none', border: 'none', color: theme.text.muted, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
                    onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
                    {expandedServer === name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button onClick={() => removeServer(name)}
                    style={{ background: 'none', border: 'none', color: theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = theme.status.danger)}
                    onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
                    <Trash2 size={13} />
                  </button>
                </div>
                {expandedServer === name && (
                  <div style={{ borderTop: '1px solid #1f1f1f', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>URL</div>
                      <input value={s.url ?? ''} onChange={e => {
                            const url = e.target.value || undefined
                            updateServer(name, { url, cmd: undefined, type: url ? 'http' : 'stdio' })
                          }}
                        placeholder="http://localhost:3000"
                        style={{ width: '100%', padding: '6px 10px', fontSize: fonts.secondarySize, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, borderRadius: 6, outline: 'none', fontFamily: fonts.mono, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Stdio Command</div>
                      <input value={s.cmd ?? ''} onChange={e => {
                            const cmd = e.target.value || undefined
                            updateServer(name, { cmd, url: undefined, type: cmd ? 'stdio' : 'http' })
                          }}
                        placeholder="npx @modelcontextprotocol/server-name"
                        style={{ width: '100%', padding: '6px 10px', fontSize: fonts.secondarySize, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, borderRadius: 6, outline: 'none', fontFamily: fonts.mono, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Description</div>
                      <input value={s.description ?? ''} onChange={e => updateServer(name, { description: e.target.value })}
                        placeholder="What does this server provide?"
                        style={{ width: '100%', padding: '6px 10px', fontSize: fonts.secondarySize, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, borderRadius: 6, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: fonts.secondarySize, color: theme.text.primary }}>Enabled</span>
                      <Toggle value={s.enabled !== false} onChange={v => updateServer(name, { enabled: v })} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Add server */}
            {addingServer ? (
              <div style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '14px 16px', marginTop: 4 }}>
                <SectionLabel label="New Server" />
                {[
                  { key: 'name', label: 'Name', placeholder: 'my-server', mono: false },
                  { key: 'url',  label: 'URL',  placeholder: 'http://localhost:3000', mono: true },
                  { key: 'cmd',  label: 'Stdio Command', placeholder: 'npx @modelcontextprotocol/server-name', mono: true },
                  { key: 'description', label: 'Description', placeholder: 'What does this server do?', mono: false },
                ].map(f => (
                  <div key={f.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{f.label}</div>
                    <input
                      value={(newServer as Record<string, string>)[f.key]}
                      onChange={e => setNewServer(p => ({ ...p, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      style={{ width: '100%', padding: '6px 10px', fontSize: fonts.secondarySize, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, borderRadius: 6, outline: 'none', fontFamily: f.mono ? 'monospace' : 'inherit', boxSizing: 'border-box' }}
                    />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={addServer}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 8, background: theme.accent.base, color: theme.text.inverse, border: 'none', fontSize: fonts.size, fontWeight: 600, cursor: 'pointer' }}>
                    Add Server
                  </button>
                  <button onClick={() => setAddingServer(false)}
                    style={{ padding: '7px 16px', borderRadius: 8, background: theme.surface.panelElevated, color: theme.text.muted, border: `1px solid ${theme.border.default}`, fontSize: fonts.size, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingServer(true)}
                style={{
                  width: '100%', marginTop: 4, padding: '10px 0', borderRadius: 10,
                  background: 'transparent', border: `1px dashed ${theme.border.default}`, color: theme.text.disabled,
                  fontSize: fonts.size, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = theme.accent.base; e.currentTarget.style.color = theme.accent.base }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border.default; e.currentTarget.style.color = theme.text.disabled }}>
                <Plus size={14} /> Add MCP Server
              </button>
            )}

            {/* Workspace servers */}
            {workspaces.length > 0 && (
              <>
                <SectionLabel label="Workspace Servers" />
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginBottom: 10 }}>
                  MCP servers scoped to a specific workspace — only active when that workspace is open.
                </div>

                {/* Workspace tabs */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
                  {workspaces.map(ws => (
                    <button
                      key={ws.id}
                      onClick={() => setActiveWorkspaceId(ws.id)}
                      style={{
                        padding: '4px 12px', borderRadius: 6, fontSize: fonts.secondarySize, cursor: 'pointer',
                        background: activeWorkspaceId === ws.id ? theme.accent.base : theme.surface.panelElevated,
                        color: activeWorkspaceId === ws.id ? theme.text.inverse : theme.text.muted,
                        border: `1px solid ${activeWorkspaceId === ws.id ? theme.accent.base : theme.border.default}`,
                        fontWeight: activeWorkspaceId === ws.id ? 600 : 400
                      }}>
                      {ws.name}
                      {Object.keys(workspaceServers[ws.id] ?? {}).length > 0 && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: activeWorkspaceId === ws.id ? theme.text.inverse : theme.text.disabled }}>
                          {Object.keys(workspaceServers[ws.id]).length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* Active workspace servers */}
                {activeWorkspaceId && (() => {
                  const wsServers = workspaceServers[activeWorkspaceId] ?? {}
                  const ws = workspaces.find(w => w.id === activeWorkspaceId)!
                  return (
                    <>
                      <div style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, marginBottom: 8 }}>{ws.path}</div>
                      {Object.entries(wsServers).map(([name, s]) => (
                        <div key={name} style={{ background: theme.surface.panelMuted, borderRadius: 10, marginBottom: 6, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            onClick={() => updateWorkspaceServer(activeWorkspaceId, name, { enabled: !(s.enabled !== false) })}
                            style={{ width: 7, height: 7, borderRadius: '50%', background: s.enabled !== false ? theme.status.success : theme.border.default, flexShrink: 0, cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500 }}>{name}</div>
                            {s.description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, marginTop: 1 }}>{s.description}</div>}
                            <div style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.url ?? s.cmd}
                            </div>
                          </div>
                          <button onClick={() => removeWorkspaceServer(activeWorkspaceId, name)}
                            style={{ background: 'none', border: 'none', color: theme.text.disabled, cursor: 'pointer' }}
                            onMouseEnter={e => (e.currentTarget.style.color = theme.status.danger)}
                            onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => {
                          const name = prompt('Server name:')
                          const cmd = prompt('Stdio command (or leave empty for URL):')
                          const url = cmd ? undefined : (prompt('URL:') ?? undefined)
                          const desc = prompt('Description (optional):') ?? ''
                          if (name) {
                            const type = cmd ? 'stdio' : 'http'
                            saveWorkspaceServers(activeWorkspaceId, { ...wsServers, [name]: { type, cmd: cmd || undefined, url, description: desc, enabled: true } })
                          }
                        }}
                        style={{
                          width: '100%', padding: '10px 0', borderRadius: 10,
                          background: 'transparent', border: `1px dashed ${theme.border.default}`, color: theme.text.disabled,
                          fontSize: fonts.size, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = theme.accent.base; e.currentTarget.style.color = theme.accent.base }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border.default; e.currentTarget.style.color = theme.text.disabled }}>
                        <Plus size={14} /> Add to {ws.name}
                      </button>
                    </>
                  )
                })()}
              </>
            )}

            {/* Config paths */}
            <div style={{ marginTop: 20, padding: '14px 16px', background: theme.surface.panel, borderRadius: 10, border: `1px solid ${theme.border.default}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: 'Global config', path: '~/.codesurf/mcp-server.json' },
                { label: 'Workspace servers', path: '~/.codesurf/workspaces/<id>/mcp-servers.json' },
                { label: 'Merged config (point agents here)', path: '~/.codesurf/workspaces/<id>/.codesurf/mcp-merged.json', highlight: true },
              ].map(row => (
                <div key={row.label}>
                  <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{row.label}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ fontSize: fonts.secondarySize, color: row.highlight ? theme.accent.base : theme.text.muted, fontFamily: fonts.mono, flex: 1 }}>{row.path}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(row.path)}
                      style={{ fontSize: 10, color: theme.text.disabled, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
                      onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
                      copy
                    </button>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 4, padding: '8px 10px', background: theme.surface.input, borderRadius: 6, border: `1px solid ${theme.border.subtle}` }}>
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>
                  The merged config combines global + workspace servers into one file. Point Claude Code, Cursor, or any MCP client at the merged path for the active workspace.
                </div>
              </div>
            </div>
          </>
        )
}
