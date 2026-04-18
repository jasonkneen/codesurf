import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'

interface MCPServer {
  name: string
  type?: 'stdio' | 'sse' | 'http'
  url?: string
  cmd?: string
  command?: string
  args?: string[]
  description?: string
  enabled: boolean
}

interface MCPTool {
  name: string
  description: string
  server: string
  enabled: boolean
}

interface MCPConfig {
  port: number
  url: string
  mcpServers: Record<string, Omit<MCPServer, 'name' | 'enabled'> & { enabled?: boolean }>
  tools?: MCPTool[]
  endpoints: { mcp: string; events: string; push: string; inject: string }
  updatedAt: string
}

const CONFIG_PATH = '~/.contex/mcp-server.json'

function serverCommandFromConfig(s: Partial<MCPServer>): string | undefined {
  if (typeof s.cmd === 'string' && s.cmd.trim()) return s.cmd.trim()
  const command = typeof s.command === 'string' ? s.command.trim() : ''
  if (!command) return undefined
  const args = Array.isArray(s.args) ? s.args.filter(a => typeof a === 'string' && a.trim()) : []
  return [command, ...args].join(' ')
}

function toServerRows(raw: MCPConfig['mcpServers']): MCPServer[] {
  return Object.entries(raw ?? {}).map(([name, s]: [string, any]) => ({
    name,
    type: s.type,
    url: s.url,
    cmd: serverCommandFromConfig(s),
    description: s.description,
    enabled: s.enabled !== false
  }))
}

// Well-known MCP servers — curated catalogue
const KNOWN_SERVERS: Array<Omit<MCPServer, 'enabled'> & { category: string; installCmd?: string }> = [
  // Filesystem & code
  { name: 'filesystem',     category: 'Files',      cmd: 'npx -y @modelcontextprotocol/server-filesystem ~/',         description: 'Read/write local files and directories' },
  { name: 'git',            category: 'Files',      cmd: 'npx -y @modelcontextprotocol/server-git',                   description: 'Git operations — log, diff, commit, branch' },
  { name: 'github',         category: 'Code',       cmd: 'npx -y @modelcontextprotocol/server-github',                description: 'GitHub repos, issues, PRs, actions' },
  { name: 'gitlab',         category: 'Code',       cmd: 'npx -y @modelcontextprotocol/server-gitlab',                description: 'GitLab repos, issues, MRs' },
  // Data
  { name: 'postgres',       category: 'Data',       cmd: 'npx -y @modelcontextprotocol/server-postgres',              description: 'Query and inspect Postgres databases' },
  { name: 'sqlite',         category: 'Data',       cmd: 'npx -y @modelcontextprotocol/server-sqlite',                description: 'SQLite database access' },
  { name: 'google-drive',   category: 'Data',       cmd: 'npx -y @modelcontextprotocol/server-gdrive',                description: 'Google Drive files and docs' },
  // Web & search
  { name: 'brave-search',   category: 'Web',        cmd: 'npx -y @modelcontextprotocol/server-brave-search',          description: 'Web search via Brave API' },
  { name: 'puppeteer',      category: 'Web',        cmd: 'npx -y @modelcontextprotocol/server-puppeteer',             description: 'Browser automation and web scraping' },
  { name: 'fetch',          category: 'Web',        cmd: 'npx -y @modelcontextprotocol/server-fetch',                 description: 'Fetch URLs and web content' },
  // Comms
  { name: 'slack',          category: 'Comms',      cmd: 'npx -y @modelcontextprotocol/server-slack',                 description: 'Read/send Slack messages and channels' },
  { name: 'gmail',          category: 'Comms',      url: 'http://localhost:3100',                                      description: 'Gmail read/send via local bridge' },
  // Dev tools
  { name: 'sequential-thinking', category: 'AI',   cmd: 'npx -y @modelcontextprotocol/server-sequential-thinking',   description: 'Break complex tasks into sequential steps' },
  { name: 'memory',         category: 'AI',         cmd: 'npx -y @modelcontextprotocol/server-memory',                description: 'Persistent memory store for agents' },
  { name: 'everything',     category: 'Dev',        cmd: 'npx -y @modelcontextprotocol/server-everything',            description: 'Test server — all MCP features' },
  // Cloud
  { name: 'aws-kb',         category: 'Cloud',      cmd: 'npx -y @modelcontextprotocol/server-aws-kb-retrieval',      description: 'AWS Knowledge Base retrieval' },
  { name: 'sentry',         category: 'Dev',        cmd: 'npx -y @modelcontextprotocol/server-sentry',                description: 'Sentry errors and issues' },
  // Local custom
  { name: 'custom',         category: 'Custom',     url: '', cmd: '',                                                  description: 'Custom MCP server' },
]

const CATEGORIES = [...new Set(KNOWN_SERVERS.map(s => s.category))]

interface Props {
  onClose: () => void
}

export function MCPPanel({ onClose }: Props): JSX.Element {
  const [config, setConfig] = useState<MCPConfig | null>(null)
  const [servers, setServers] = useState<MCPServer[]>([])
  const [loading, setLoading] = useState(true)
  const [port, setPort] = useState<number | null>(null)
  const [newServer, setNewServer] = useState<Partial<MCPServer>>({ name: '', enabled: true })
  const [adding, setAdding] = useState(false)
  const [saved, setSaved] = useState(false)
  const fonts = useAppFonts()

  const applyConfig = useCallback((cfg: MCPConfig) => {
    setConfig(cfg)
    setServers(toServerRows(cfg.mcpServers))
    setLoading(false)
  }, [])

  // Load current config
  useEffect(() => {
    window.electron?.mcp?.getPort?.().then((p: number) => setPort(p))

    const load = async () => {
      try {
        const cfg = window.electron?.mcp?.getConfig ? await window.electron.mcp.getConfig() : null
        if (cfg) {
          applyConfig(cfg as MCPConfig)
          return
        }
      } catch { /**/ }

      const home = (window as any).__HOME__ ?? (window as any).process?.env?.HOME ?? (window as any).process?.env?.USERPROFILE ?? ''
      const path = `${home}/.contex/mcp-server.json`
      try {
        const raw = await window.electron.fs.readFile(path)
        applyConfig(JSON.parse(raw) as MCPConfig)
      } catch {
        setLoading(false)
      }
    }

    load()
  }, [applyConfig])

  const save = useCallback(async (updatedServers: MCPServer[]) => {
    const userServers: Record<string, Omit<MCPServer, 'name' | 'enabled'> > = {}
    for (const s of updatedServers) {
      if (s.name === 'contex') continue
      const entry: Omit<MCPServer, 'name' | 'enabled'> = {
        ...(s.type || s.url ? { type: s.type || (s.url ? 'http' : 'stdio') } : {}),
        ...(s.url ? { url: s.url } : {}),
        ...(s.cmd ? { cmd: s.cmd } : {}),
        ...(s.args?.length ? { args: s.args } : {}),
        ...(s.description ? { description: s.description } : {}),
        enabled: s.enabled
      }
      userServers[s.name] = entry
    }

    let updatedCfg: MCPConfig | null = null
    if (window.electron?.mcp?.saveServers) {
      updatedCfg = await window.electron.mcp.saveServers(userServers) as MCPConfig
    } else if (config) {
      // Fallback legacy path if IPC changed in future
      const mcpServers: MCPConfig['mcpServers'] = {}
      mcpServers['contex'] = config.mcpServers['contex'] ?? { type: 'http', url: `${config.url.replace(/\/$/, '')}/mcp` }
      for (const [name, entry] of Object.entries(userServers)) {
        mcpServers[name] = entry as MCPConfig['mcpServers'][string]
      }
      updatedCfg = { ...config, mcpServers, updatedAt: new Date().toISOString() }
      const home = (window as any).__HOME__ ?? (window as any).process?.env?.HOME ?? (window as any).process?.env?.USERPROFILE ?? ''
      await window.electron.fs.writeFile(`${home}/.contex/mcp-server.json`, JSON.stringify(updatedCfg, null, 2))
    }

    if (updatedCfg) {
      applyConfig(updatedCfg)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }, [config, applyConfig])

  const updateServer = (i: number, patch: Partial<MCPServer>) => {
    const updated = servers.map((s, j) => j === i ? { ...s, ...patch } : s)
    setServers(updated)
    save(updated)
  }

  const removeServer = (i: number) => {
    const updated = servers.filter((_, j) => j !== i)
    setServers(updated)
    save(updated)
  }

  const addServer = () => {
    if (!newServer.name?.trim()) return
    const s: MCPServer = {
      name: newServer.name.trim(),
      type: newServer.url ? 'http' : 'stdio',
      url: newServer.url,
      cmd: newServer.cmd,
      description: newServer.description,
      enabled: true
    }
    const updated = [...servers, s]
    setServers(updated)
    save(updated)
    setNewServer({ name: '', enabled: true })
    setAdding(false)
  }

  const theme = useTheme()

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: theme.mode === 'light' ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center'
    }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        width: 560, maxHeight: '80vh', background: theme.surface.panel,
        border: `1px solid ${theme.border.strong}`, borderRadius: 10,
        boxShadow: theme.shadow.modal,
        display: 'flex', flexDirection: 'column', overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${theme.border.default}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: fonts.size, fontWeight: 700, color: theme.text.primary }}>MCP Configuration</div>
            <div style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 2 }}>{CONFIG_PATH}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {port && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: theme.status.success, boxShadow: `0 0 5px ${theme.status.success}`, display: 'inline-block' }} />
                <span style={{ fontSize: 10, color: theme.status.success, fontFamily: fonts.mono }}>:{port}</span>
              </div>
            )}
            {saved && <span style={{ fontSize: 10, color: theme.status.success }}>saved</span>}
            <button onClick={onClose} style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.color = theme.text.primary)}
              onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>x</button>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

          {/* Built-in server */}
          <Section label="BUILT-IN">
            <ServerRow
              name="contex"
              description="Canvas, kanban, files, blocks — always running"
              url={config?.url}
              enabled={true}
              builtin
              tools={['card_complete', 'card_update', 'card_error', 'request_input', 'kanban_get_board', 'kanban_create_card', 'kanban_update_card', 'kanban_move_card', 'kanban_pause_card', 'kanban_delete_card', 'kanban_create_column', 'kanban_rename_column', 'kanban_delete_column', 'canvas_create_tile', 'canvas_open_file', 'canvas_pan_to', 'canvas_list_tiles']}
            />
          </Section>

          {/* External servers */}
          <Section label="MCP SERVERS">
            {loading ? (
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, padding: '8px 0' }}>Loading...</div>
            ) : (
              <>
                {servers.filter(s => s.name !== 'contex').map((s, i) => (
                  <EditableServerRow
                    key={s.name}
                    server={s}
                    onUpdate={patch => updateServer(i, patch)}
                    onRemove={() => removeServer(i)}
                  />
                ))}

                {adding ? (
                  <div style={{ background: theme.surface.panelMuted, border: `1px solid ${theme.border.default}`, borderRadius: 6, padding: 12, marginTop: 6 }}>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                      <input value={newServer.name ?? ''} onChange={e => setNewServer(p => ({ ...p, name: e.target.value }))}
                        placeholder="server name" autoFocus style={{ ...getInputStyle(theme), flex: '0 0 120px', background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}` }} />
                      <input value={newServer.url ?? ''} onChange={e => setNewServer(p => ({ ...p, url: e.target.value, cmd: undefined }))}
                        placeholder="http://..." style={{ ...getInputStyle(theme), flex: 1, fontFamily: fonts.mono, fontSize: 10, color: theme.status.success, background: theme.surface.input, border: `1px solid ${theme.border.default}` }} />
                    </div>
                    <input value={newServer.cmd ?? ''} onChange={e => setNewServer(p => ({ ...p, cmd: e.target.value, url: undefined }))}
                      placeholder="or stdio command: npx @modelcontextprotocol/server-name"
                      style={{ ...getInputStyle(theme), fontFamily: fonts.mono, fontSize: 10, marginBottom: 8, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}` }} />
                    <input value={newServer.description ?? ''} onChange={e => setNewServer(p => ({ ...p, description: e.target.value }))}
                      placeholder="Description (optional)" style={{ ...getInputStyle(theme), marginBottom: 8, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}` }} />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={addServer}
                        style={{ flex: 1, padding: '5px 0', borderRadius: 5, background: theme.accent.base, color: theme.text.inverse, border: 'none', fontSize: fonts.secondarySize, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Add Server
                      </button>
                      <button onClick={() => setAdding(false)}
                        style={{ padding: '5px 12px', borderRadius: 5, background: theme.surface.panelMuted, color: theme.text.muted, border: `1px solid ${theme.border.default}`, fontSize: fonts.secondarySize, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setAdding(true)}
                    style={{ width: '100%', padding: '7px 0', borderRadius: 6, background: 'none', border: `1px dashed ${theme.border.default}`, color: theme.text.muted, fontSize: fonts.secondarySize, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 }}
                    onMouseEnter={e => { e.currentTarget.style.color = theme.accent.base; e.currentTarget.style.borderColor = theme.accent.soft }}
                    onMouseLeave={e => { e.currentTarget.style.color = theme.text.muted; e.currentTarget.style.borderColor = theme.border.default }}>
                    + Add MCP Server
                  </button>
                )}
              </>
            )}
          </Section>

          {/* Catalogue */}
          <Section label="CATALOGUE — ADD SERVERS">
            <CatalogueView
              installed={servers.map(s => s.name)}
              onAdd={s => {
                if (servers.find(x => x.name === s.name)) return
                const type = s.url ? 'http' : 'stdio'
                const updated = [...servers, { ...s, type, enabled: true }]
                setServers(updated)
                save(updated)
              }}
            />
          </Section>

          {/* Endpoints reference */}
          {config && (
            <Section label="ENDPOINTS">
              {Object.entries(config.endpoints ?? {}).map(([key, url]) => (
                <div key={key} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '3px 0' }}>
                  <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, width: 60, flexShrink: 0 }}>{key}</span>
                  <span style={{ fontSize: 10, color: theme.status.success, fontFamily: fonts.mono, flex: 1 }}>{url}</span>
                  <button onClick={() => navigator.clipboard.writeText(url)}
                    style={{ fontSize: 9, color: theme.text.muted, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                    onMouseEnter={e => (e.currentTarget.style.color = theme.accent.base)}
                    onMouseLeave={e => (e.currentTarget.style.color = theme.text.muted)}>copy</button>
                </div>
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 9, color: theme.accent.base, fontFamily: 'inherit', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  )
}

function ServerRow({ name, description, url, cmd, enabled, builtin, tools }: {
  name: string; description?: string; url?: string; cmd?: string; enabled: boolean; builtin?: boolean; tools?: string[]
}): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  return (
    <div style={{ background: theme.surface.panelMuted, border: `1px solid ${theme.border.default}`, borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: description ? 4 : 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: enabled ? theme.status.success : theme.text.disabled, flexShrink: 0 }} />
        <span style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.primary }}>{name}</span>
        {builtin && <span style={{ fontSize: 9, color: theme.accent.base, background: theme.accent.soft, border: `1px solid ${theme.border.accent}`, borderRadius: 3, padding: '1px 6px', fontFamily: 'inherit' }}>built-in</span>}
        <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, marginLeft: 'auto' }}>{url ?? cmd}</span>
      </div>
      {description && <div style={{ fontSize: 10, color: theme.text.disabled, marginBottom: tools?.length ? 6 : 0 }}>{description}</div>}
      {tools && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {tools.map(t => (
            <span key={t} style={{ fontSize: 9, color: theme.text.muted, background: theme.surface.panel, border: `1px solid ${theme.border.default}`, borderRadius: 3, padding: '1px 6px', fontFamily: fonts.mono }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function EditableServerRow({ server, onUpdate, onRemove }: {
  server: MCPServer; onUpdate: (p: Partial<MCPServer>) => void; onRemove: () => void
}): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const iStyle = { ...getInputStyle(theme), background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}` }
  return (
    <div style={{ background: theme.surface.panelMuted, border: `1px solid ${theme.border.default}`, borderRadius: 6, marginBottom: 6, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={() => onUpdate({ enabled: !server.enabled })}
          style={{ width: 12, height: 12, borderRadius: '50%', background: server.enabled ? theme.status.success : theme.text.disabled, border: 'none', cursor: 'pointer', flexShrink: 0 }} />
        <span style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.primary, flex: 1 }}>{server.name}</span>
        <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
          {server.url ?? server.cmd}
        </span>
        <button onClick={() => setExpanded(p => !p)}
          style={{ fontSize: 9, color: theme.text.muted, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
          onMouseEnter={e => (e.currentTarget.style.color = theme.text.secondary)}
          onMouseLeave={e => (e.currentTarget.style.color = theme.text.muted)}>
          {expanded ? 'less' : 'edit'}
        </button>
        <button onClick={onRemove}
          style={{ fontSize: 10, color: theme.text.disabled, background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.color = theme.status.danger)}
          onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>x</button>
      </div>
      {expanded && (
        <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${theme.border.default}` }}>
          <div style={{ paddingTop: 8 }}>
            <label style={{ fontSize: 9, color: theme.text.muted, fontFamily: 'inherit', display: 'block', marginBottom: 3 }}>URL</label>
            <input value={server.url ?? ''} onChange={e => onUpdate({
                url: e.target.value || undefined,
                cmd: undefined,
                type: e.target.value ? 'http' : 'stdio'
              })}
              placeholder="http://localhost:3000" style={{ ...iStyle, fontFamily: fonts.mono, fontSize: 10, color: theme.status.success }} />
          </div>
          <div>
            <label style={{ fontSize: 9, color: theme.text.muted, fontFamily: 'inherit', display: 'block', marginBottom: 3 }}>STDIO COMMAND</label>
            <input value={server.cmd ?? ''} onChange={e => onUpdate({
                cmd: e.target.value || undefined,
                url: undefined,
                type: e.target.value ? 'stdio' : 'http'
              })}
              placeholder="npx @modelcontextprotocol/server-name" style={{ ...iStyle, fontFamily: fonts.mono, fontSize: 10 }} />
          </div>
          <div>
            <label style={{ fontSize: 9, color: theme.text.muted, fontFamily: 'inherit', display: 'block', marginBottom: 3 }}>DESCRIPTION</label>
            <input value={server.description ?? ''} onChange={e => onUpdate({ description: e.target.value })}
              placeholder="What does this server provide?" style={iStyle} />
          </div>
        </div>
      )}
    </div>
  )
}

function CatalogueView({ installed, onAdd }: {
  installed: string[]
  onAdd: (s: MCPServer) => void
}): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [filter, setFilter] = useState('')
  const [cat, setCat] = useState<string | null>(null)

  const filtered = KNOWN_SERVERS.filter(s => {
    if (s.name === 'custom') return false
    if (cat && s.category !== cat) return false
    if (filter && !s.name.includes(filter) && !s.description?.toLowerCase().includes(filter.toLowerCase())) return false
    return true
  })

  const iStyle = { ...getInputStyle(theme), background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}` }

  return (
    <div>
      {/* Category filter */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={() => setCat(null)}
          style={{ ...catBtnStyle, background: cat === null ? theme.accent.base : theme.surface.panelMuted, color: cat === null ? theme.text.inverse : theme.text.muted, border: `1px solid ${cat === null ? theme.accent.base : theme.border.default}` }}>
          All
        </button>
        {CATEGORIES.map(c => (
          <button key={c} onClick={() => setCat(cat === c ? null : c)}
            style={{ ...catBtnStyle, background: cat === c ? theme.accent.base : theme.surface.panelMuted, color: cat === c ? theme.text.inverse : theme.text.muted, border: `1px solid ${cat === c ? theme.accent.base : theme.border.default}` }}>
            {c}
          </button>
        ))}
      </div>

      {/* Search */}
      <input value={filter} onChange={e => setFilter(e.target.value)}
        placeholder="Search servers..."
        style={{ ...iStyle, marginBottom: 8 }} />

      {/* Server list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filtered.map(s => {
          const isInstalled = installed.includes(s.name)
          return (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: theme.surface.panelMuted, border: `1px solid ${theme.border.default}`, borderRadius: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: isInstalled ? theme.text.disabled : theme.text.primary }}>{s.name}</span>
                  <span style={{ fontSize: 9, color: theme.accent.base, background: theme.accent.soft, border: `1px solid ${theme.border.accent}`, borderRadius: 3, padding: '0 5px', fontFamily: 'inherit' }}>{s.category}</span>
                  {isInstalled && <span style={{ fontSize: 9, color: theme.status.success, fontFamily: 'inherit' }}>added</span>}
                </div>
                <div style={{ fontSize: 10, color: theme.text.disabled, marginTop: 1 }}>{s.description}</div>
                <div style={{ fontSize: 9, color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.cmd ?? s.url}
                </div>
              </div>
              <button
                onClick={() => !isInstalled && onAdd({ name: s.name, url: s.url, cmd: s.cmd, description: s.description, enabled: true })}
                disabled={isInstalled}
                style={{
                  padding: '4px 12px', borderRadius: 5, fontSize: 10, cursor: isInstalled ? 'default' : 'pointer',
                  background: isInstalled ? theme.surface.panelMuted : theme.surface.panelElevated, color: isInstalled ? theme.text.disabled : theme.text.muted,
                  border: `1px solid ${theme.border.default}`, fontFamily: 'inherit', flexShrink: 0
                }}
                onMouseEnter={e => { if (!isInstalled) { e.currentTarget.style.background = theme.accent.base; e.currentTarget.style.color = theme.text.inverse } }}
                onMouseLeave={e => { if (!isInstalled) { e.currentTarget.style.background = theme.surface.panelElevated; e.currentTarget.style.color = theme.text.muted } }}
              >
                {isInstalled ? 'added' : '+ add'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const catBtnStyle: React.CSSProperties = {
  padding: '2px 10px', borderRadius: 10, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit'
}

function getInputStyle(theme: ReturnType<typeof useTheme>): React.CSSProperties {
  return {
    width: '100%', fontSize: 'inherit', padding: '5px 8px', borderRadius: 5,
    background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`,
    outline: 'none', fontFamily: 'inherit'
  }
}
