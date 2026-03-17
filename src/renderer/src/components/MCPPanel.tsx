import React, { useState, useEffect, useCallback } from 'react'
import { loadMCPServers } from '../hooks/useMCPServers'

interface MCPServer {
  name: string
  url?: string
  cmd?: string
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

const CONFIG_PATH = '~/.clawd-collab/mcp-server.json'

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

  // Load current config
  useEffect(() => {
    const home = (window as any).__dirname ?? ''
    window.electron?.mcp?.getPort?.().then((p: number) => setPort(p))

    // Read the config file
    const path = `${(window as any).process?.env?.HOME ?? '~'}/clawd-collab/mcp-server.json`
    window.electron.fs.readFile(path.replace('~', (window as any).__HOME__ ?? '/Users/' + ((window as any).process?.env?.USER ?? '')))
      .catch(() => null)
      .then((raw: string | null) => {
        if (raw) {
          try {
            const cfg: MCPConfig = JSON.parse(raw)
            setConfig(cfg)
            const list: MCPServer[] = Object.entries(cfg.mcpServers ?? {}).map(([name, s]) => ({
              name,
              url: s.url,
              cmd: s.cmd,
              args: s.args,
              description: s.description,
              enabled: s.enabled !== false
            }))
            setServers(list)
          } catch { /**/ }
        }
        setLoading(false)
      })
  }, [])

  const save = useCallback(async (updatedServers: MCPServer[]) => {
    if (!config) return
    const mcpServers: MCPConfig['mcpServers'] = {}
    // Always keep the collaborator built-in
    mcpServers['collaborator'] = config.mcpServers['collaborator'] ?? { url: config.url }
    for (const s of updatedServers) {
      if (s.name === 'collaborator') continue
      mcpServers[s.name] = {
        ...(s.url ? { url: s.url } : {}),
        ...(s.cmd ? { cmd: s.cmd } : {}),
        ...(s.args?.length ? { args: s.args } : {}),
        ...(s.description ? { description: s.description } : {}),
        enabled: s.enabled
      }
    }
    const updated = { ...config, mcpServers, updatedAt: new Date().toISOString() }
    const home = (window as any).process?.env?.HOME ?? ''
    const filePath = `${home}/clawd-collab/mcp-server.json`
    await window.electron.fs.writeFile(filePath, JSON.stringify(updated, null, 2))
    await loadMCPServers() // refresh global cache
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [config])

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

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center'
    }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        width: 560, maxHeight: '80vh', background: '#0d1117',
        border: '1px solid #30363d', borderRadius: 10,
        boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #21262d', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>MCP Configuration</div>
            <div style={{ fontSize: 10, color: '#555', fontFamily: 'monospace', marginTop: 2 }}>{CONFIG_PATH}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {port && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fb950', boxShadow: '0 0 5px #3fb950', display: 'inline-block' }} />
                <span style={{ fontSize: 10, color: '#3fb950', fontFamily: 'monospace' }}>:{port}</span>
              </div>
            )}
            {saved && <span style={{ fontSize: 10, color: '#3fb950' }}>saved</span>}
            <button onClick={onClose} style={{ fontSize: 12, color: '#555', background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
              onMouseLeave={e => (e.currentTarget.style.color = '#555')}>x</button>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

          {/* Built-in server */}
          <Section label="BUILT-IN">
            <ServerRow
              name="collaborator"
              description="Canvas, kanban, files, tiles — always running"
              url={config?.url}
              enabled={true}
              builtin
              tools={['card_complete', 'card_update', 'card_error', 'request_input', 'canvas_create_tile', 'canvas_open_file', 'canvas_pan_to', 'canvas_list_tiles']}
            />
          </Section>

          {/* External servers */}
          <Section label="MCP SERVERS">
            {loading ? (
              <div style={{ fontSize: 11, color: '#444', padding: '8px 0' }}>Loading…</div>
            ) : (
              <>
                {servers.filter(s => s.name !== 'collaborator').map((s, i) => (
                  <EditableServerRow
                    key={s.name}
                    server={s}
                    onUpdate={patch => updateServer(i, patch)}
                    onRemove={() => removeServer(i)}
                  />
                ))}

                {adding ? (
                  <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 6, padding: 12, marginTop: 6 }}>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                      <input value={newServer.name ?? ''} onChange={e => setNewServer(p => ({ ...p, name: e.target.value }))}
                        placeholder="server name" autoFocus style={{ ...inputStyle, flex: '0 0 120px' }} />
                      <input value={newServer.url ?? ''} onChange={e => setNewServer(p => ({ ...p, url: e.target.value, cmd: undefined }))}
                        placeholder="http://..." style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 10, color: '#3fb950' }} />
                    </div>
                    <input value={newServer.cmd ?? ''} onChange={e => setNewServer(p => ({ ...p, cmd: e.target.value, url: undefined }))}
                      placeholder="or stdio command: npx @modelcontextprotocol/server-name"
                      style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10, marginBottom: 8 }} />
                    <input value={newServer.description ?? ''} onChange={e => setNewServer(p => ({ ...p, description: e.target.value }))}
                      placeholder="Description (optional)" style={{ ...inputStyle, marginBottom: 8 }} />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={addServer}
                        style={{ flex: 1, padding: '5px 0', borderRadius: 5, background: '#1f6feb', color: '#fff', border: 'none', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Add Server
                      </button>
                      <button onClick={() => setAdding(false)}
                        style={{ padding: '5px 12px', borderRadius: 5, background: '#21262d', color: '#8b949e', border: '1px solid #30363d', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setAdding(true)}
                    style={{ width: '100%', padding: '7px 0', borderRadius: 6, background: 'none', border: '1px dashed #21262d', color: '#444', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#58a6ff'; e.currentTarget.style.borderColor = '#388bfd44' }}
                    onMouseLeave={e => { e.currentTarget.style.color = '#444'; e.currentTarget.style.borderColor = '#21262d' }}>
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
                const updated = [...servers, { ...s, enabled: true }]
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
                  <span style={{ fontSize: 10, color: '#555', fontFamily: 'monospace', width: 60, flexShrink: 0 }}>{key}</span>
                  <span style={{ fontSize: 10, color: '#3fb950', fontFamily: 'monospace', flex: 1 }}>{url}</span>
                  <button onClick={() => navigator.clipboard.writeText(url)}
                    style={{ fontSize: 9, color: '#444', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'monospace' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#58a6ff')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#444')}>copy</button>
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
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 9, color: '#388bfd', fontFamily: 'monospace', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  )
}

function ServerRow({ name, description, url, cmd, enabled, builtin, tools }: {
  name: string; description?: string; url?: string; cmd?: string; enabled: boolean; builtin?: boolean; tools?: string[]
}): JSX.Element {
  return (
    <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: description ? 4 : 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: enabled ? '#3fb950' : '#333', flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>{name}</span>
        {builtin && <span style={{ fontSize: 9, color: '#388bfd', background: '#0d2137', border: '1px solid #1f3a5f', borderRadius: 3, padding: '1px 6px', fontFamily: 'monospace' }}>built-in</span>}
        <span style={{ fontSize: 10, color: '#555', fontFamily: 'monospace', marginLeft: 'auto' }}>{url ?? cmd}</span>
      </div>
      {description && <div style={{ fontSize: 10, color: '#555', marginBottom: tools?.length ? 6 : 0 }}>{description}</div>}
      {tools && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {tools.map(t => (
            <span key={t} style={{ fontSize: 9, color: '#444', background: '#0d1117', border: '1px solid #21262d', borderRadius: 3, padding: '1px 6px', fontFamily: 'monospace' }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function EditableServerRow({ server, onUpdate, onRemove }: {
  server: MCPServer; onUpdate: (p: Partial<MCPServer>) => void; onRemove: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 6, marginBottom: 6, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={() => onUpdate({ enabled: !server.enabled })}
          style={{ width: 12, height: 12, borderRadius: '50%', background: server.enabled ? '#3fb950' : '#333', border: 'none', cursor: 'pointer', flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', flex: 1 }}>{server.name}</span>
        <span style={{ fontSize: 10, color: '#555', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
          {server.url ?? server.cmd}
        </span>
        <button onClick={() => setExpanded(p => !p)}
          style={{ fontSize: 9, color: '#444', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'monospace' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#888')}
          onMouseLeave={e => (e.currentTarget.style.color = '#444')}>
          {expanded ? 'less' : 'edit'}
        </button>
        <button onClick={onRemove}
          style={{ fontSize: 10, color: '#333', background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#ff7b72')}
          onMouseLeave={e => (e.currentTarget.style.color = '#333')}>x</button>
      </div>
      {expanded && (
        <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid #21262d' }}>
          <div style={{ paddingTop: 8 }}>
            <label style={{ fontSize: 9, color: '#444', fontFamily: 'monospace', display: 'block', marginBottom: 3 }}>URL</label>
            <input value={server.url ?? ''} onChange={e => onUpdate({ url: e.target.value || undefined, cmd: undefined })}
              placeholder="http://localhost:3000" style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10, color: '#3fb950' }} />
          </div>
          <div>
            <label style={{ fontSize: 9, color: '#444', fontFamily: 'monospace', display: 'block', marginBottom: 3 }}>STDIO COMMAND</label>
            <input value={server.cmd ?? ''} onChange={e => onUpdate({ cmd: e.target.value || undefined, url: undefined })}
              placeholder="npx @modelcontextprotocol/server-name" style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10 }} />
          </div>
          <div>
            <label style={{ fontSize: 9, color: '#444', fontFamily: 'monospace', display: 'block', marginBottom: 3 }}>DESCRIPTION</label>
            <input value={server.description ?? ''} onChange={e => onUpdate({ description: e.target.value })}
              placeholder="What does this server provide?" style={inputStyle} />
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
  const [filter, setFilter] = useState('')
  const [cat, setCat] = useState<string | null>(null)

  const filtered = KNOWN_SERVERS.filter(s => {
    if (s.name === 'custom') return false
    if (cat && s.category !== cat) return false
    if (filter && !s.name.includes(filter) && !s.description?.toLowerCase().includes(filter.toLowerCase())) return false
    return true
  })

  return (
    <div>
      {/* Category filter */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={() => setCat(null)}
          style={{ ...catBtnStyle, background: cat === null ? '#1f6feb' : '#161b22', color: cat === null ? '#fff' : '#555', border: `1px solid ${cat === null ? '#388bfd' : '#21262d'}` }}>
          All
        </button>
        {CATEGORIES.map(c => (
          <button key={c} onClick={() => setCat(cat === c ? null : c)}
            style={{ ...catBtnStyle, background: cat === c ? '#1f6feb' : '#161b22', color: cat === c ? '#fff' : '#555', border: `1px solid ${cat === c ? '#388bfd' : '#21262d'}` }}>
            {c}
          </button>
        ))}
      </div>

      {/* Search */}
      <input value={filter} onChange={e => setFilter(e.target.value)}
        placeholder="Search servers…"
        style={{ ...inputStyle, marginBottom: 8 }} />

      {/* Server list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filtered.map(s => {
          const isInstalled = installed.includes(s.name)
          return (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#161b22', border: '1px solid #21262d', borderRadius: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: isInstalled ? '#555' : '#c9d1d9' }}>{s.name}</span>
                  <span style={{ fontSize: 9, color: '#388bfd', background: '#0d2137', border: '1px solid #1f3a5f', borderRadius: 3, padding: '0 5px', fontFamily: 'monospace' }}>{s.category}</span>
                  {isInstalled && <span style={{ fontSize: 9, color: '#3fb950', fontFamily: 'monospace' }}>added</span>}
                </div>
                <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>{s.description}</div>
                <div style={{ fontSize: 9, color: '#2d3a2d', fontFamily: 'monospace', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.cmd ?? s.url}
                </div>
              </div>
              <button
                onClick={() => !isInstalled && onAdd({ name: s.name, url: s.url, cmd: s.cmd, description: s.description, enabled: true })}
                disabled={isInstalled}
                style={{
                  padding: '4px 12px', borderRadius: 5, fontSize: 10, cursor: isInstalled ? 'default' : 'pointer',
                  background: isInstalled ? '#161b22' : '#21262d', color: isInstalled ? '#333' : '#8b949e',
                  border: `1px solid ${isInstalled ? '#21262d' : '#30363d'}`, fontFamily: 'inherit', flexShrink: 0
                }}
                onMouseEnter={e => { if (!isInstalled) { e.currentTarget.style.background = '#1f6feb'; e.currentTarget.style.color = '#fff' } }}
                onMouseLeave={e => { if (!isInstalled) { e.currentTarget.style.background = '#21262d'; e.currentTarget.style.color = '#8b949e' } }}
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

const inputStyle: React.CSSProperties = {
  width: '100%', fontSize: 11, padding: '5px 8px', borderRadius: 5,
  background: '#0d1117', color: '#c9d1d9', border: '1px solid #21262d',
  outline: 'none', fontFamily: 'inherit'
}
