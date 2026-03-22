import React, { useEffect, useState, useCallback, useRef } from 'react'
import type { AppSettings, FontConfig, FontSettings } from '../../../shared/types'
import { DEFAULT_SETTINGS, DEFAULT_FONTS, withDefaultSettings } from '../../../shared/types'
import { Settings, Type, Monitor, Terminal, FolderOpen, Sliders, Network, Plus, Trash2, ChevronDown, ChevronRight, FileJson, AlertTriangle, Check, Copy, RotateCcw, FormInput, Code2 } from 'lucide-react'
import { useAppFonts } from '../FontContext'

interface Workspace {
  id: string
  name: string
  path: string
}

interface Props {
  onClose: () => void
  onSettingsChange: (s: AppSettings) => void
  workspaces?: Workspace[]
}

type Section = 'general' | 'canvas' | 'terminal' | 'sidebar' | 'behaviour' | 'mcp'

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; description: string }[] = [
  { id: 'general',   label: 'General',   icon: <Type size={15} />,      description: 'Display settings — fonts, weights, sizes, line heights, and raw JSON' },
  { id: 'canvas',    label: 'Canvas',    icon: <Monitor size={15} />,   description: 'Background, grid and snap settings' },
  { id: 'terminal',  label: 'Terminal',  icon: <Terminal size={15} />,  description: 'Font size and family for terminal tiles' },
  { id: 'sidebar',   label: 'Sidebar',   icon: <FolderOpen size={15} />,description: 'File tree sort and ignored folders' },
  { id: 'behaviour', label: 'Behaviour', icon: <Sliders size={15} />,   description: 'Auto-save interval and UI font size' },
  { id: 'mcp',       label: 'MCP',       icon: <Network size={15} />,   description: 'Model Context Protocol server connections' },
]

// ─── MCP types ────────────────────────────────────────────────────────────────
interface MCPServerEntry {
  type?: 'stdio' | 'sse' | 'http'
  url?: string
  cmd?: string
  args?: string[]
  command?: string
  description?: string
  enabled?: boolean
}

interface MCPConfig {
  port: number
  url: string
  mcpServers: Record<string, MCPServerEntry>
  endpoints: Record<string, string>
  updatedAt: string
}

// ─── Control components ────────────────────────────────────────────────────────
function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 44, height: 26, borderRadius: 13, cursor: 'pointer', flexShrink: 0,
        background: value ? '#666' : '#333',
        position: 'relative', transition: 'background 0.2s',
      }}
    >
      <div style={{
        position: 'absolute',
        top: 3, left: value ? 21 : 3,
        width: 20, height: 20, borderRadius: '50%',
        background: value ? '#fff' : '#888',
        transition: 'left 0.2s, background 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
      }} />
    </div>
  )
}

function NumInput({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <input
      type="number" value={value} min={min} max={max} step={step}
      onChange={e => onChange(Number(e.target.value))}
      style={{
        width: 72, padding: '5px 10px', fontSize: 13,
        background: '#222', color: '#ccc',
        border: '1px solid #333', borderRadius: 8, outline: 'none',
        textAlign: 'right'
      }}
    />
  )
}

function RangeInput({ value, min, max, step = 0.01, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }): JSX.Element {
  const clamped = Math.max(min, Math.min(max, value))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range"
        value={clamped}
        min={min}
        max={max}
        step={step}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: 160 }}
      />
      <div style={{
        minWidth: 44,
        padding: '5px 8px',
        fontSize: 12,
        textAlign: 'right',
        color: '#aaa',
        background: '#222',
        border: '1px solid #333',
        borderRadius: 8,
        fontVariantNumeric: 'tabular-nums'
      }}>
        {Math.round(clamped * 100)}%
      </div>
    </div>
  )
}

function TextInput({ value, onChange, width = 240 }: { value: string; onChange: (v: string) => void; width?: number }): JSX.Element {
  return (
    <input
      type="text" value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width, padding: '5px 10px', fontSize: 12,
        background: '#222', color: '#ccc',
        border: '1px solid #333', borderRadius: 8, outline: 'none'
      }}
    />
  )
}

function ColorSwatch({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  const fonts = useAppFonts()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <div
          style={{ width: 28, height: 28, borderRadius: 6, background: value, cursor: 'pointer', border: '1px solid #444' }}
          onClick={e => (e.currentTarget.nextSibling as HTMLInputElement)?.click()}
        />
        <input type="color" value={value} onChange={e => onChange(e.target.value)}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }} />
      </div>
      <span style={{ fontSize: 11, color: '#555', fontFamily: fonts.mono }}>{value}</span>
    </div>
  )
}

const SANS_FONTS = [
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
  '"SF Pro Display", "Segoe UI", "Helvetica Neue", sans-serif',
  '"Helvetica Neue", Helvetica, Arial, sans-serif',
  '"Inter", "Segoe UI", sans-serif',
  '"Geist", "SF Pro Text", sans-serif',
  '"Armata", sans-serif',
  '"Blinker", sans-serif',
  '"Datatype", sans-serif',
  '"Doto", sans-serif',
  '"Exo 2", sans-serif',
  '"Jockey One", sans-serif',
  '"Metrophobic", sans-serif',
  '"Orbitron", sans-serif',
  '"Oxanium", sans-serif',
  '"Quantico", sans-serif',
  '"Russo One", sans-serif',
  '"Saira", sans-serif',
  '"Saira Condensed", sans-serif',
  '"Tektur", sans-serif',
  '"Rajdhani", sans-serif',
  'system-ui, sans-serif',
]

const MONO_FONTS = [
  '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace',
  '"IBM Plex Mono", monospace',
  '"Fira Code", "JetBrains Mono", monospace',
  '"SF Mono", "Menlo", "Monaco", monospace',
  '"Cascadia Code", "Fira Code", monospace',
  '"Source Code Pro", "Menlo", monospace',
  '"Geist Mono", "SF Mono", monospace',
  'monospace',
]

function FontSelect({ value, onChange, fonts }: { value: string; onChange: (v: string) => void; fonts: string[] }): JSX.Element {
  const displayName = (stack: string) => {
    const first = stack.split(',')[0].trim().replace(/^"|"$/g, '')
    return first.startsWith('-apple-system') ? 'System Default' : first
  }
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width: 200, padding: '5px 10px', fontSize: 12,
        background: '#222', color: '#ccc',
        border: '1px solid #333', borderRadius: 8, outline: 'none',
        fontFamily: value
      }}
    >
      {fonts.map(f => (
        <option key={f} value={f} style={{ fontFamily: f }}>
          {displayName(f)}
        </option>
      ))}
      {!fonts.includes(value) && (
        <option value={value} style={{ fontFamily: value }}>
          {displayName(value)} (custom)
        </option>
      )}
    </select>
  )
}

function FontGroup({ label, font, onChange, fonts }: {
  label: string
  font: FontConfig
  onChange: (f: FontConfig) => void
  fonts: string[]
}): JSX.Element {
  return (
    <>
      <SectionLabel label={label} />
      <SettingRow label="Font family" description="Select from common font stacks">
        <FontSelect value={font.family} onChange={v => onChange({ ...font, family: v })} fonts={fonts} />
      </SettingRow>
      <SettingRow label="Font size" description="Size in pixels">
        <NumInput value={font.size} min={8} max={32} onChange={v => onChange({ ...font, size: v })} />
      </SettingRow>
      <SettingRow label="Line height" description="Line height multiplier">
        <NumInput value={font.lineHeight} min={1} max={3} step={0.1} onChange={v => onChange({ ...font, lineHeight: v })} />
      </SettingRow>
    </>
  )
}

// ─── Setting row ──────────────────────────────────────────────────────────────
function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: '#161616', borderRadius: 10, padding: '14px 16px',
      marginBottom: 8, gap: 16
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, color: '#e0e0e0', fontWeight: 500, marginBottom: description ? 3 : 0 }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: '#555' }}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

function SectionLabel({ label }: { label: string }): JSX.Element {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: '#555',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      marginTop: 20, marginBottom: 8, paddingLeft: 2
    }}>
      {label}
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export function SettingsPanel({ onClose, onSettingsChange, workspaces = [] }: Props): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [section, setSection] = useState<Section>('general')
  const [mcpConfig, setMcpConfig] = useState<MCPConfig | null>(null)
  const fonts = useAppFonts()
  const [mcpSaved, setMcpSaved] = useState(false)
  const [addingServer, setAddingServer] = useState(false)
  const [newServer, setNewServer] = useState({ name: '', url: '', cmd: '', description: '' })
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [workspaceServers, setWorkspaceServers] = useState<Record<string, Record<string, MCPServerEntry>>>({})
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<{ checking: boolean; downloading: boolean; result: null | { ok: boolean; currentVersion: string; status: string; updateAvailable: boolean; updateInfo?: { version?: string; releaseName?: string; releaseDate?: string } } }>({ checking: false, downloading: false, result: null })

  useEffect(() => {
    window.electron.settings?.get().then((s: AppSettings) => {
      if (s) setSettings(withDefaultSettings(s))
    })
    window.electron.mcp?.getConfig?.().then((cfg: MCPConfig) => {
      if (cfg) setMcpConfig(cfg)
    })
  }, [])

  // Load workspace MCP servers when MCP section is opened
  useEffect(() => {
    if (section !== 'mcp') return
    Promise.all(
      workspaces.map(async ws => {
        const servers = await window.electron.mcp?.getWorkspaceServers?.(ws.id) ?? {}
        return [ws.id, servers] as [string, Record<string, MCPServerEntry>]
      })
    ).then(entries => {
      setWorkspaceServers(Object.fromEntries(entries))
      if (!activeWorkspaceId && workspaces.length > 0) {
        setActiveWorkspaceId(workspaces[0].id)
      }
    })
  }, [section, workspaces])

  const checkForUpdates = useCallback(async () => {
    setUpdateState(prev => ({ ...prev, checking: true }))
    const result = await window.electron.updater.check()
    setUpdateState(prev => ({ ...prev, checking: false, result }))
  }, [])

  const downloadUpdate = useCallback(async () => {
    setUpdateState(prev => ({ ...prev, downloading: true }))
    const result = await window.electron.updater.download()
    setUpdateState(prev => ({
      ...prev,
      downloading: false,
      result: prev.result ? { ...prev.result, status: result.status } : prev.result,
    }))
  }, [])

  // ─── MCP helpers ────────────────────────────────────────────────────────
  const saveMcpServers = useCallback(async (servers: Record<string, MCPServerEntry>) => {
    const cfg = await window.electron.mcp?.saveServers?.(servers)
    if (cfg) {
      setMcpConfig(cfg)
      setMcpSaved(true)
      setTimeout(() => setMcpSaved(false), 2000)
    }
  }, [])

  const updateServer = useCallback((name: string, patch: Partial<MCPServerEntry>) => {
    if (!mcpConfig) return
    const servers = { ...mcpConfig.mcpServers }
    servers[name] = { ...servers[name], ...patch }
    // Don't pass contex through saveServers — it's preserved server-side
    const { contex: _, ...rest } = servers
    saveMcpServers(rest)
  }, [mcpConfig, saveMcpServers])

  const removeServer = useCallback((name: string) => {
    if (!mcpConfig) return
    const { contex: _, [name]: __, ...rest } = mcpConfig.mcpServers
    saveMcpServers(rest)
  }, [mcpConfig, saveMcpServers])

  const addServer = useCallback(() => {
    if (!newServer.name.trim() || !mcpConfig) return
    const { contex: _, ...rest } = mcpConfig.mcpServers
    const entry: MCPServerEntry = {
      type: newServer.url ? 'http' : 'stdio',
      ...(newServer.url ? { url: newServer.url } : {}),
      ...(newServer.cmd ? { cmd: newServer.cmd } : {}),
      ...(newServer.description ? { description: newServer.description } : {}),
      enabled: true
    }
    saveMcpServers({ ...rest, [newServer.name.trim()]: entry })
    setNewServer({ name: '', url: '', cmd: '', description: '' })
    setAddingServer(false)
  }, [newServer, mcpConfig, saveMcpServers])

  const saveWorkspaceServers = useCallback(async (wsId: string, servers: Record<string, MCPServerEntry>) => {
    const saved = await window.electron.mcp?.saveWorkspaceServers?.(wsId, servers)
    if (saved) setWorkspaceServers(prev => ({ ...prev, [wsId]: saved }))
  }, [])

  const updateWorkspaceServer = useCallback((wsId: string, name: string, patch: Partial<MCPServerEntry>) => {
    const current = workspaceServers[wsId] ?? {}
    saveWorkspaceServers(wsId, { ...current, [name]: { ...current[name], ...patch } })
  }, [workspaceServers, saveWorkspaceServers])

  const removeWorkspaceServer = useCallback((wsId: string, name: string) => {
    const { [name]: _, ...rest } = workspaceServers[wsId] ?? {}
    saveWorkspaceServers(wsId, rest)
  }, [workspaceServers, saveWorkspaceServers])

  // Auto-save on every change
  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      window.electron.settings?.set(next).then((saved: AppSettings) => {
        if (saved) onSettingsChange(saved)

      })
      return next
    })
  }, [onSettingsChange])

  const updateSettingsPatch = useCallback((patch: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = withDefaultSettings({ ...prev, ...patch })
      window.electron.settings?.set(next).then((saved: AppSettings) => {
        if (saved) onSettingsChange(saved)

      })
      return next
    })
  }, [onSettingsChange])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const active = SECTIONS.find(s => s.id === section)!

  const renderContent = () => {
    switch (section) {
      case 'general':
        return (
          <DisplaySettingsEditor
            settings={settings}
            onApply={updateSettingsPatch}
            updateState={updateState}
            onCheckForUpdates={checkForUpdates}
            onDownloadUpdate={downloadUpdate}
          />
        )
      case 'canvas':
        return (
          <>
            <SectionLabel label="Display" />
            <SettingRow label="Background colour" description="Canvas background color">
              <ColorSwatch value={settings.canvasBackground} onChange={v => update('canvasBackground', v)} />
            </SettingRow>
            <SettingRow label="Canvas translucency" description="Slide left for see-through vibrancy, all the way right for fully opaque">
              <RangeInput value={settings.translucentBackgroundOpacity} min={0.05} max={1} step={0.01} onChange={v => update('translucentBackgroundOpacity', Number(v.toFixed(2)))} />
            </SettingRow>
            <SectionLabel label="Grid" />
            <SettingRow label="Small dot colour" description="Color of the small grid dots">
              <ColorSwatch value={settings.gridColorSmall} onChange={v => update('gridColorSmall', v)} />
            </SettingRow>
            <SettingRow label="Large dot colour" description="Color of the large grid dots">
              <ColorSwatch value={settings.gridColorLarge} onChange={v => update('gridColorLarge', v)} />
            </SettingRow>
            <SettingRow label="Small dot spacing" description="Distance between small dots in pixels">
              <NumInput value={settings.gridSpacingSmall} min={4} max={200} onChange={v => update('gridSpacingSmall', v)} />
            </SettingRow>
            <SettingRow label="Large dot spacing" description="Distance between large dots in pixels">
              <NumInput value={settings.gridSpacingLarge} min={20} max={500} onChange={v => update('gridSpacingLarge', v)} />
            </SettingRow>
            <SectionLabel label="Snap" />
            <SettingRow label="Snap grid size" description="Snap grid size in pixels">
              <NumInput value={settings.gridSize} min={4} max={80} onChange={v => update('gridSize', v)} />
            </SettingRow>
            <SettingRow label="Snap to grid" description="Snap tiles to the grid when dragging">
              <Toggle value={settings.snapToGrid} onChange={v => update('snapToGrid', v)} />
            </SettingRow>
          </>
        )
      case 'terminal':
        return (
          <>
            <SectionLabel label="Font" />
            <SettingRow label="Font size" description="Terminal font size in points">
              <NumInput value={settings.terminalFontSize} min={8} max={24} onChange={v => update('terminalFontSize', v)} />
            </SettingRow>
            <SettingRow label="Font family" description="Font stack for terminals">
              <TextInput value={settings.terminalFontFamily} onChange={v => update('terminalFontFamily', v)} />
            </SettingRow>
          </>
        )
      case 'sidebar':
        return (
          <>
            <SectionLabel label="Files" />
            <SettingRow label="Default sort" description="Initial sort order for the file tree">
              <select value={settings.sidebarDefaultSort}
                onChange={e => update('sidebarDefaultSort', e.target.value as AppSettings['sidebarDefaultSort'])}
                style={{ padding: '5px 10px', fontSize: 13, background: '#222', color: '#ccc', border: '1px solid #333', borderRadius: 8, outline: 'none' }}>
                <option value="name">Name</option>
                <option value="type">Type</option>
                <option value="ext">Ext</option>
              </select>
            </SettingRow>
            <SettingRow label="Ignored folders" description="Comma-separated list of folders to hide">
              <TextInput value={settings.sidebarIgnored.join(', ')}
                onChange={v => update('sidebarIgnored', v.split(',').map(s => s.trim()).filter(Boolean))}
                width={280} />
            </SettingRow>
          </>
        )

      case 'behaviour':
        return (
          <>
            <SectionLabel label="Saving" />
            <SettingRow label="Auto-save interval" description="How often canvas state is written to disk (ms)">
              <NumInput value={settings.autoSaveIntervalMs} min={100} max={10000} step={100} onChange={v => update('autoSaveIntervalMs', v)} />
            </SettingRow>
            <SectionLabel label="Interface" />
            <SettingRow label="UI font size" description="Base font size for the interface">
              <NumInput value={settings.uiFontSize} min={10} max={18} onChange={v => update('uiFontSize', v)} />
            </SettingRow>
          </>
        )

      case 'mcp': {
        const servers = mcpConfig?.mcpServers ?? {}
        const userServers = Object.entries(servers).filter(([k]) => k !== 'contex')
        return (
          <>
            {/* Status */}
            <SectionLabel label="Server Status" />
            <div style={{ background: '#161616', borderRadius: 10, padding: '12px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: mcpConfig ? '#3fb950' : '#555', boxShadow: mcpConfig ? '0 0 6px #3fb950' : 'none', flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: '#e0e0e0', fontWeight: 500 }}>contex</span>
                <span style={{ fontSize: 11, color: '#444', fontFamily: 'inherit', marginLeft: 'auto' }}>built-in</span>
              </div>
              {mcpConfig && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {Object.entries(mcpConfig.endpoints ?? {}).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: '#444', fontFamily: fonts.mono, width: 50, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontSize: 10, color: '#3fb950', fontFamily: fonts.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                      <button onClick={() => navigator.clipboard.writeText(v)}
                        style={{ fontSize: 9, color: '#444', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#888')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#444')}>
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
              <div key={name} style={{ background: '#161616', borderRadius: 10, marginBottom: 6, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
                  <span
                    onClick={() => updateServer(name, { enabled: !(s.enabled !== false) })}
                    title="Toggle enabled"
                    style={{ width: 7, height: 7, borderRadius: '50%', background: s.enabled !== false ? '#3fb950' : '#333', flexShrink: 0, cursor: 'pointer' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: '#e0e0e0', fontWeight: 500 }}>{name}</div>
                    {s.description && <div style={{ fontSize: 11, color: '#555', marginTop: 1 }}>{s.description}</div>}
                    <div style={{ fontSize: 10, color: '#333', fontFamily: fonts.mono, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.url ?? s.cmd}
                    </div>
                  </div>
                  <button onClick={() => setExpandedServer(expandedServer === name ? null : name)}
                    style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#888')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#444')}>
                    {expandedServer === name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button onClick={() => removeServer(name)}
                    style={{ background: 'none', border: 'none', color: '#333', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#f44747')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#333')}>
                    <Trash2 size={13} />
                  </button>
                </div>
                {expandedServer === name && (
                  <div style={{ borderTop: '1px solid #1f1f1f', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#444', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>URL</div>
                      <input value={s.url ?? ''} onChange={e => {
                            const url = e.target.value || undefined
                            updateServer(name, { url, cmd: undefined, type: url ? 'http' : 'stdio' })
                          }}
                        placeholder="http://localhost:3000"
                        style={{ width: '100%', padding: '6px 10px', fontSize: 12, background: '#111', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 6, outline: 'none', fontFamily: fonts.mono, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#444', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Stdio Command</div>
                      <input value={s.cmd ?? ''} onChange={e => {
                            const cmd = e.target.value || undefined
                            updateServer(name, { cmd, url: undefined, type: cmd ? 'stdio' : 'http' })
                          }}
                        placeholder="npx @modelcontextprotocol/server-name"
                        style={{ width: '100%', padding: '6px 10px', fontSize: 12, background: '#111', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 6, outline: 'none', fontFamily: fonts.mono, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#444', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Description</div>
                      <input value={s.description ?? ''} onChange={e => updateServer(name, { description: e.target.value })}
                        placeholder="What does this server provide?"
                        style={{ width: '100%', padding: '6px 10px', fontSize: 12, background: '#111', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 6, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: '#e0e0e0' }}>Enabled</span>
                      <Toggle value={s.enabled !== false} onChange={v => updateServer(name, { enabled: v })} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Add server */}
            {addingServer ? (
              <div style={{ background: '#161616', borderRadius: 10, padding: '14px 16px', marginTop: 4 }}>
                <SectionLabel label="New Server" />
                {[
                  { key: 'name', label: 'Name', placeholder: 'my-server', mono: false },
                  { key: 'url',  label: 'URL',  placeholder: 'http://localhost:3000', mono: true },
                  { key: 'cmd',  label: 'Stdio Command', placeholder: 'npx @modelcontextprotocol/server-name', mono: true },
                  { key: 'description', label: 'Description', placeholder: 'What does this server do?', mono: false },
                ].map(f => (
                  <div key={f.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#444', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{f.label}</div>
                    <input
                      value={(newServer as Record<string, string>)[f.key]}
                      onChange={e => setNewServer(p => ({ ...p, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, background: '#111', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 6, outline: 'none', fontFamily: f.mono ? 'monospace' : 'inherit', boxSizing: 'border-box' }}
                    />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={addServer}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 8, background: '#fff', color: '#000', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    Add Server
                  </button>
                  <button onClick={() => setAddingServer(false)}
                    style={{ padding: '7px 16px', borderRadius: 8, background: '#222', color: '#666', border: '1px solid #333', fontSize: 13, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingServer(true)}
                style={{
                  width: '100%', marginTop: 4, padding: '10px 0', borderRadius: 10,
                  background: 'transparent', border: '1px dashed #2a2a2a', color: '#555',
                  fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#4a9eff44'; e.currentTarget.style.color = '#4a9eff' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#2a2a2a'; e.currentTarget.style.color = '#555' }}>
                <Plus size={14} /> Add MCP Server
              </button>
            )}

            {/* Workspace servers */}
            {workspaces.length > 0 && (
              <>
                <SectionLabel label="Workspace Servers" />
                <div style={{ fontSize: 12, color: '#444', marginBottom: 10 }}>
                  MCP servers scoped to a specific workspace — only active when that workspace is open.
                </div>

                {/* Workspace tabs */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
                  {workspaces.map(ws => (
                    <button
                      key={ws.id}
                      onClick={() => setActiveWorkspaceId(ws.id)}
                      style={{
                        padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                        background: activeWorkspaceId === ws.id ? '#fff' : '#161616',
                        color: activeWorkspaceId === ws.id ? '#000' : '#666',
                        border: `1px solid ${activeWorkspaceId === ws.id ? '#fff' : '#2a2a2a'}`,
                        fontWeight: activeWorkspaceId === ws.id ? 600 : 400
                      }}>
                      {ws.name}
                      {Object.keys(workspaceServers[ws.id] ?? {}).length > 0 && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: activeWorkspaceId === ws.id ? '#555' : '#444' }}>
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
                      <div style={{ fontSize: 10, color: '#333', fontFamily: fonts.mono, marginBottom: 8 }}>{ws.path}</div>
                      {Object.entries(wsServers).map(([name, s]) => (
                        <div key={name} style={{ background: '#161616', borderRadius: 10, marginBottom: 6, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            onClick={() => updateWorkspaceServer(activeWorkspaceId, name, { enabled: !(s.enabled !== false) })}
                            style={{ width: 7, height: 7, borderRadius: '50%', background: s.enabled !== false ? '#3fb950' : '#333', flexShrink: 0, cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, color: '#e0e0e0', fontWeight: 500 }}>{name}</div>
                            {s.description && <div style={{ fontSize: 11, color: '#555', marginTop: 1 }}>{s.description}</div>}
                            <div style={{ fontSize: 10, color: '#333', fontFamily: fonts.mono, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.url ?? s.cmd}
                            </div>
                          </div>
                          <button onClick={() => removeWorkspaceServer(activeWorkspaceId, name)}
                            style={{ background: 'none', border: 'none', color: '#333', cursor: 'pointer' }}
                            onMouseEnter={e => (e.currentTarget.style.color = '#f44747')}
                            onMouseLeave={e => (e.currentTarget.style.color = '#333')}>
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
                          background: 'transparent', border: '1px dashed #2a2a2a', color: '#555',
                          fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = '#4a9eff44'; e.currentTarget.style.color = '#4a9eff' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = '#2a2a2a'; e.currentTarget.style.color = '#555' }}>
                        <Plus size={14} /> Add to {ws.name}
                      </button>
                    </>
                  )
                })()}
              </>
            )}

            {/* Config paths */}
            <div style={{ marginTop: 20, padding: '14px 16px', background: '#0d0d0d', borderRadius: 10, border: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: 'Global config', path: '~/.contex/mcp-server.json' },
                { label: 'Workspace servers', path: '~/.contex/workspaces/<id>/mcp-servers.json' },
                { label: 'Merged config (point agents here)', path: '~/.contex/workspaces/<id>/mcp-merged.json', highlight: true },
              ].map(row => (
                <div key={row.label}>
                  <div style={{ fontSize: 10, color: '#444', marginBottom: 3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{row.label}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ fontSize: 11, color: row.highlight ? '#4a9eff' : '#555', fontFamily: fonts.mono, flex: 1 }}>{row.path}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(row.path)}
                      style={{ fontSize: 10, color: '#333', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#888')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#333')}>
                      copy
                    </button>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 4, padding: '8px 10px', background: '#111', borderRadius: 6, border: '1px solid #1f1f1f' }}>
                <div style={{ fontSize: 11, color: '#555' }}>
                  The merged config combines global + workspace servers into one file. Point Claude Code, Cursor, or any MCP client at the merged path for the active workspace.
                </div>
              </div>
            </div>
          </>
        )
      }
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 720, height: 580,
        background: '#111', borderRadius: 14,
        border: '1px solid #222',
        boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
        display: 'flex', overflow: 'hidden'
      }}>

        {/* Left nav */}
        <div style={{
          width: 200, background: '#0d0d0d',
          borderRight: '1px solid #1a1a1a',
          display: 'flex', flexDirection: 'column',
          padding: '20px 0',
          flexShrink: 0
        }}>
          {/* Close */}
          <div style={{ padding: '0 16px 16px' }}>
            <div
              onClick={onClose}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                cursor: 'pointer', color: '#444',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = '#888')}
              onMouseLeave={e => (e.currentTarget.style.color = '#444')}
            >
              <div style={{
                width: 22, height: 22, borderRadius: '50%',
                border: '1.5px solid currentColor',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, lineHeight: 1
              }}>
                ×
              </div>
              <span style={{ fontSize: 11 }}>esc</span>
            </div>
          </div>

          {/* Settings header */}
          <div style={{ padding: '8px 16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Settings size={18} color="#fff" />
            <span style={{ fontSize: 17, fontWeight: 700, color: '#fff' }}>Settings</span>
          </div>

          {/* Nav items */}
          <div style={{ flex: 1 }}>
            {SECTIONS.map(s => (
              <div
                key={s.id}
                onClick={() => setSection(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 16px', cursor: 'pointer',
                  color: section === s.id ? '#fff' : '#555',
                  background: section === s.id ? 'rgba(255,255,255,0.06)' : 'transparent',
                  fontSize: 14, userSelect: 'none',
                  transition: 'color 0.1s'
                }}
                onMouseEnter={e => { if (section !== s.id) e.currentTarget.style.color = '#888' }}
                onMouseLeave={e => { if (section !== s.id) e.currentTarget.style.color = '#555' }}
              >
                <span style={{ opacity: section === s.id ? 1 : 0.5 }}>{s.icon}</span>
                {s.label}
              </div>
            ))}
          </div>

          {/* Version */}
          <div style={{ padding: '0 16px', fontSize: 11, color: '#333' }}>
            v{__VERSION__}
          </div>
        </div>

        {/* Right content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Section header */}
          <div style={{ padding: '28px 28px 0' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{active.label}</div>
            <div style={{ fontSize: 14, color: '#555' }}>{active.description}</div>
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 28px 28px' }}>
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Font token categories for the reference table ──────────────────────────

const FONT_TOKEN_GROUPS: { label: string; tokens: { key: keyof FontSettings; description: string }[] }[] = [
  { label: 'Base', tokens: [
    { key: 'sans', description: 'Default sans-serif for all UI' },
    { key: 'mono', description: 'Default monospace for code/data' },
  ]},
  { label: 'Headings', tokens: [
    { key: 'title', description: 'Tile title bars, panel headers' },
    { key: 'sectionLabel', description: 'Section labels (ACTIVITY, BUILT-IN, etc.)' },
    { key: 'subtitle', description: 'Descriptions, hints, secondary text' },
  ]},
  { label: 'Sidebar', tokens: [
    { key: 'sidebarFileList', description: 'File/folder names in sidebar' },
    { key: 'sidebarHeader', description: 'Sidebar section headers' },
    { key: 'sidebarPath', description: 'Path breadcrumbs, workspace path' },
  ]},
  { label: 'Terminal & Code', tokens: [
    { key: 'terminal', description: 'Terminal emulator (xterm)' },
    { key: 'codeEditor', description: 'Code editor (Monaco)' },
    { key: 'inlineCode', description: 'Inline code, <code> tags' },
    { key: 'commandPreview', description: 'CLI command previews' },
  ]},
  { label: 'Chat', tokens: [
    { key: 'chatMessage', description: 'Chat message body' },
    { key: 'chatInput', description: 'Chat input textarea' },
    { key: 'chatToolbar', description: 'Model/provider dropdown labels' },
    { key: 'chatMeta', description: 'Model IDs, cost, session info' },
    { key: 'chatThinking', description: 'Thinking block content' },
  ]},
  { label: 'Kanban', tokens: [
    { key: 'kanbanCardTitle', description: 'Kanban card titles' },
    { key: 'kanbanBadge', description: 'Agent pills, status badges' },
    { key: 'kanbanTab', description: 'Tab labels' },
  ]},
  { label: 'Data Display', tokens: [
    { key: 'dataUrl', description: 'URLs, endpoints' },
    { key: 'dataPath', description: 'File/directory paths' },
    { key: 'dataKeyValue', description: 'Key-value pairs, env vars' },
    { key: 'dataTimestamp', description: 'Timestamps, dates' },
    { key: 'dataNumeric', description: 'Costs, counts, numbers' },
    { key: 'dataBadge', description: 'Tags, chips, tool names' },
  ]},
  { label: 'Controls', tokens: [
    { key: 'button', description: 'Buttons, clickable text' },
    { key: 'formLabel', description: 'Form labels (URL, DESCRIPTION)' },
    { key: 'formInput', description: 'Text inputs, selects' },
  ]},
  { label: 'Settings', tokens: [
    { key: 'settingsHeader', description: 'Settings section headers' },
    { key: 'settingsLabel', description: 'Settings field labels' },
  ]},
]

const SANS_TOKEN_KEYS = new Set<keyof FontSettings>([
  'sans', 'title', 'sectionLabel', 'subtitle',
  'sidebarFileList', 'sidebarHeader',
  'chatMessage', 'chatInput', 'chatToolbar',
  'kanbanCardTitle', 'kanbanBadge', 'kanbanTab',
  'dataBadge', 'button', 'formLabel', 'formInput',
  'settingsHeader', 'settingsLabel',
])

const MONO_TOKEN_KEYS = new Set<keyof FontSettings>([
  'mono', 'sidebarPath', 'terminal', 'codeEditor', 'inlineCode', 'commandPreview',
  'chatMeta', 'chatThinking',
  'dataUrl', 'dataPath', 'dataKeyValue', 'dataTimestamp', 'dataNumeric',
])

function buildDisplayJson(settings: AppSettings): string {
  return JSON.stringify({
    primaryFont: settings.primaryFont,
    secondaryFont: settings.secondaryFont,
    monoFont: settings.monoFont,
    fonts: settings.fonts,
  }, null, 2)
}

function validateTokenLike(value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`
  const validProps = new Set(['family', 'size', 'lineHeight', 'weight', 'letterSpacing'])
  const invalidProps = Object.keys(value as object).filter(key => !validProps.has(key))
  if (invalidProps.length > 0) return `${path} has unknown propert${invalidProps.length > 1 ? 'ies' : 'y'}: ${invalidProps.join(', ')}`
  const token = value as Record<string, unknown>
  if (token.family !== undefined && typeof token.family !== 'string') return `${path}.family must be a string`
  if (token.size !== undefined && (typeof token.size !== 'number' || token.size < 1 || token.size > 72)) return `${path}.size must be 1-72`
  if (token.lineHeight !== undefined && (typeof token.lineHeight !== 'number' || token.lineHeight < 0.5 || token.lineHeight > 4)) return `${path}.lineHeight must be 0.5-4`
  if (token.weight !== undefined && (typeof token.weight !== 'number' || token.weight < 100 || token.weight > 900)) return `${path}.weight must be 100-900`
  if (token.letterSpacing !== undefined && typeof token.letterSpacing !== 'number') return `${path}.letterSpacing must be a number`
  return null
}

function validateDisplayJson(value: string): { ok: true; parsed: Partial<AppSettings> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'Must be a JSON object' }
    }

    const topLevel = new Set(['primaryFont', 'secondaryFont', 'monoFont', 'fonts'])
    const invalidTopLevel = Object.keys(parsed).filter(key => !topLevel.has(key))
    if (invalidTopLevel.length > 0) {
      return { ok: false, error: `Unknown key${invalidTopLevel.length > 1 ? 's' : ''}: ${invalidTopLevel.join(', ')}` }
    }

    const config = parsed as Record<string, unknown>
    for (const key of ['primaryFont', 'secondaryFont', 'monoFont'] as const) {
      if (config[key] !== undefined) {
        const error = validateTokenLike(config[key], key)
        if (error) return { ok: false, error }
      }
    }

    if (config.fonts !== undefined) {
      if (typeof config.fonts !== 'object' || config.fonts === null || Array.isArray(config.fonts)) {
        return { ok: false, error: 'fonts must be an object' }
      }
      const validTokenKeys = new Set(Object.keys(DEFAULT_FONTS))
      const invalidTokenKeys = Object.keys(config.fonts as object).filter(key => !validTokenKeys.has(key))
      if (invalidTokenKeys.length > 0) {
        return { ok: false, error: `Unknown font token${invalidTokenKeys.length > 1 ? 's' : ''}: ${invalidTokenKeys.join(', ')}` }
      }
      for (const [tokenKey, tokenVal] of Object.entries(config.fonts as Record<string, unknown>)) {
        const error = validateTokenLike(tokenVal, `fonts.${tokenKey}`)
        if (error) return { ok: false, error }
      }
    }

    return { ok: true, parsed: parsed as Partial<AppSettings> }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid JSON' }
  }
}

function SliderField({ value, min, max, step, onChange, format }: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: 92 }}
      />
      <span style={{ width: 38, textAlign: 'right', fontSize: 11, color: '#888', fontVariantNumeric: 'tabular-nums' }}>
        {format ? format(value) : value}
      </span>
    </div>
  )
}

function CompactFontRow({ label, description, token, fontOptions, onChange }: {
  label: string
  description: string
  token: FontToken
  fontOptions: string[]
  onChange: (next: FontToken) => void
}): JSX.Element {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(150px, 180px) minmax(210px, 1fr) 140px 140px 140px',
      gap: 12,
      alignItems: 'center',
      padding: '10px 12px',
      background: '#141414',
      border: '1px solid #1f1f1f',
      borderRadius: 10,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#e6e6e6', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{description}</div>
      </div>
      <FontSelect value={token.family} onChange={family => onChange({ ...token, family })} fonts={fontOptions} />
      <SliderField value={token.size} min={8} max={32} step={1} onChange={size => onChange({ ...token, size })} format={value => `${value}px`} />
      <SliderField value={token.weight ?? 400} min={100} max={900} step={100} onChange={weight => onChange({ ...token, weight })} />
      <SliderField value={token.lineHeight} min={1} max={2.2} step={0.05} onChange={lineHeight => onChange({ ...token, lineHeight })} format={value => value.toFixed(2)} />
    </div>
  )
}

function DisplaySettingsEditor({
  settings,
  onApply,
  updateState,
  onCheckForUpdates,
  onDownloadUpdate,
}: {
  settings: AppSettings
  onApply: (patch: Partial<AppSettings>) => void
  updateState: { checking: boolean; downloading: boolean; result: null | { ok: boolean; currentVersion: string; status: string; updateAvailable: boolean; updateInfo?: { version?: string; releaseName?: string; releaseDate?: string } } }
  onCheckForUpdates: () => void
  onDownloadUpdate: () => void
}): JSX.Element {
  const fonts = useAppFonts()
  const [view, setView] = useState<'display' | 'json'>('display')
  const [rawJson, setRawJson] = useState(() => buildDisplayJson(settings))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [configPath, setConfigPath] = useState('')
  const jsonSyncTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (typeof window.electron.settings.getRawJson !== 'function') return
    window.electron.settings.getRawJson().then(({ path }) => setConfigPath(path)).catch(() => {})
  }, [])

  useEffect(() => {
    const next = buildDisplayJson(settings)
    setRawJson(current => current === next ? current : next)
  }, [settings])

  useEffect(() => {
    if (jsonSyncTimeoutRef.current) window.clearTimeout(jsonSyncTimeoutRef.current)
    const validation = validateDisplayJson(rawJson)
    if (!validation.ok) {
      setJsonError(validation.error)
      return
    }
    setJsonError(null)
    jsonSyncTimeoutRef.current = window.setTimeout(() => {
      onApply(withDefaultSettings({ ...settings, ...validation.parsed }))
    }, 180)
    return () => {
      if (jsonSyncTimeoutRef.current) window.clearTimeout(jsonSyncTimeoutRef.current)
    }
  }, [rawJson])

  const updateBaseFont = useCallback((key: 'primaryFont' | 'secondaryFont' | 'monoFont', tokenKey: keyof FontSettings, next: FontToken) => {
    onApply({
      [key]: next,
      fonts: { ...settings.fonts, [tokenKey]: next },
    } as Partial<AppSettings>)
  }, [onApply, settings.fonts])

  const updateToken = useCallback((key: keyof FontSettings, next: FontToken) => {
    const patch: Partial<AppSettings> = {
      fonts: { ...settings.fonts, [key]: next },
    }
    if (key === 'sans') patch.primaryFont = next
    if (key === 'subtitle') patch.secondaryFont = next
    if (key === 'mono') patch.monoFont = next
    onApply(patch)
  }, [onApply, settings.fonts])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #1a1a1a', paddingBottom: 8 }}>
        {[
          { id: 'display' as const, label: 'Display', icon: <FormInput size={14} /> },
          { id: 'json' as const, label: '<>', icon: <Code2 size={14} /> },
        ].map(tab => {
          const isActive = view === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setView(tab.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                height: 28,
                padding: '0 11px',
                borderRadius: 7,
                border: `1px solid ${isActive ? '#30363d' : 'transparent'}`,
                background: isActive ? '#21262d' : 'transparent',
                color: isActive ? '#58a6ff' : '#6f7782',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: isActive ? 700 : 500,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
                transition: 'color 0.15s, background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                  e.currentTarget.style.color = '#aeb8c4'
                  e.currentTarget.style.borderColor = '#2a2f38'
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = '#6f7782'
                  e.currentTarget.style.borderColor = 'transparent'
                }
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          )
        })}
      </div>

      {view === 'display' ? (
        <>
          <SectionLabel label="Base Styles" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CompactFontRow label="Primary" description="Main UI font" token={settings.primaryFont} fontOptions={SANS_FONTS} onChange={next => updateBaseFont('primaryFont', 'sans', next)} />
            <CompactFontRow label="Secondary" description="Secondary / metadata font" token={settings.secondaryFont} fontOptions={SANS_FONTS} onChange={next => updateBaseFont('secondaryFont', 'subtitle', next)} />
            <CompactFontRow label="Monospace" description="Code and data font" token={settings.monoFont} fontOptions={MONO_FONTS} onChange={next => updateBaseFont('monoFont', 'mono', next)} />
          </div>

          {FONT_TOKEN_GROUPS.map(group => (
            <div key={group.label}>
              <SectionLabel label={group.label} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {group.tokens.map(({ key, description }) => (
                  <CompactFontRow
                    key={key}
                    label={key}
                    description={description}
                    token={settings.fonts[key]}
                    fontOptions={MONO_TOKEN_KEYS.has(key) ? MONO_FONTS : SANS_TOKEN_KEYS.has(key) ? SANS_FONTS : [...SANS_FONTS, ...MONO_FONTS]}
                    onChange={next => updateToken(key, next)}
                  />
                ))}
              </div>
            </div>
          ))}

          <SectionLabel label="Updates" />
          <SettingRow label="Current version" description="Installed desktop build version">
            <span style={{ fontSize: 12, color: '#aaa', fontFamily: fonts.mono }}>{updateState.result?.currentVersion ?? __VERSION__}</span>
          </SettingRow>
          <SettingRow label="Check for updates" description="Look for a newer GitHub release and show install actions here">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={onCheckForUpdates}
                disabled={updateState.checking}
                style={{
                  padding: '7px 12px',
                  fontSize: 12,
                  background: updateState.checking ? '#1a1a1a' : '#222',
                  color: updateState.checking ? '#666' : '#ddd',
                  border: '1px solid #333',
                  borderRadius: 8,
                  cursor: updateState.checking ? 'default' : 'pointer'
                }}
              >
                {updateState.checking ? 'Checking…' : 'Check now'}
              </button>
              {updateState.result?.updateAvailable && (
                <button
                  onClick={onDownloadUpdate}
                  disabled={updateState.downloading}
                  style={{
                    padding: '7px 12px',
                    fontSize: 12,
                    background: updateState.downloading ? '#1a1a1a' : '#2a2416',
                    color: updateState.downloading ? '#666' : '#f0d28a',
                    border: '1px solid #4a3a16',
                    borderRadius: 8,
                    cursor: updateState.downloading ? 'default' : 'pointer'
                  }}
                >
                  {updateState.downloading ? 'Downloading…' : 'Download'}
                </button>
              )}
              {updateState.result?.status === 'downloaded' && (
                <button
                  onClick={() => window.electron.updater.quitAndInstall()}
                  style={{
                    padding: '7px 12px',
                    fontSize: 12,
                    background: '#16261a',
                    color: '#8fdb9a',
                    border: '1px solid #23482a',
                    borderRadius: 8,
                    cursor: 'pointer'
                  }}
                >
                  Restart to install
                </button>
              )}
            </div>
          </SettingRow>
          {updateState.result && (
            <div style={{ marginBottom: 8, padding: '12px 16px', background: '#0d0d0d', borderRadius: 10, border: '1px solid #1a1a1a' }}>
              <div style={{ fontSize: 12, color: updateState.result.ok ? '#777' : '#c77' }}>
                {updateState.result.updateAvailable
                  ? `Update available${updateState.result.updateInfo?.version ? `: ${updateState.result.updateInfo.version}` : ''}`
                  : updateState.result.status === 'up-to-date'
                    ? 'You are up to date.'
                    : updateState.result.status}
              </div>
              {updateState.result.updateInfo?.releaseDate && (
                <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>
                  Released {new Date(updateState.result.updateInfo.releaseDate).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Code2 size={14} color="#555" />
            <span style={{ fontSize: 10, color: '#555', fontFamily: fonts.mono }}>{configPath || 'settings.json'}</span>
            <span style={{ fontSize: 9, color: '#388bfd', fontFamily: fonts.mono }}>settings.display</span>
            {jsonError && (
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: '#ff7b72', fontSize: 11 }}>
                <AlertTriangle size={12} />
                {jsonError}
              </span>
            )}
          </div>
          <textarea
            value={rawJson}
            onChange={e => setRawJson(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 520,
              padding: '12px 14px', borderRadius: 10,
              background: '#0a0a0a', color: jsonError ? '#ff9080' : '#c9d1d9',
              border: `1px solid ${jsonError ? '#ff7b7244' : '#1a1a1a'}`,
              outline: 'none', resize: 'vertical',
              fontFamily: fonts.mono, fontSize: 12, lineHeight: 1.6,
              tabSize: 2, boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: 11, color: '#555', lineHeight: 1.6 }}>
            Edit the display settings as JSON. Valid top-level keys: <span style={{ fontFamily: fonts.mono }}>primaryFont</span>, <span style={{ fontFamily: fonts.mono }}>secondaryFont</span>, <span style={{ fontFamily: fonts.mono }}>monoFont</span>, <span style={{ fontFamily: fonts.mono }}>fonts</span>. The form and JSON stay in sync when the JSON is valid.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Font Token JSON Editor ─────────────────────────────────────────────────

function FontTokenEditor({ settings, onSettingsChange }: {
  settings: AppSettings
  onSettingsChange: (s: AppSettings) => void
}): JSX.Element {
  const [rawJson, setRawJson] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const fonts = useAppFonts()
  const [view, setView] = useState<'editor' | 'reference'>('editor')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Load raw config on mount
  useEffect(() => {
    if (typeof window.electron.settings.getRawJson !== 'function') {
      // Bridge not available — app needs restart to pick up preload changes
      setRawJson(JSON.stringify(settings.fonts ?? {}, null, 2))
      setConfigPath('~/..contex/config.json')
      setLoading(false)
      return
    }
    window.electron.settings.getRawJson().then(({ path, content }) => {
      setConfigPath(path)
      try {
        const parsed = JSON.parse(content)
        const fonts = parsed.settings?.fonts ?? {}
        setRawJson(JSON.stringify(fonts, null, 2))
      } catch {
        setRawJson('{}')
      }
      setLoading(false)
    })
  }, [])

  // Validate on change
  const handleChange = useCallback((value: string) => {
    setRawJson(value)
    setSaved(false)
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('Must be a JSON object')
        return
      }
      const validKeys = new Set(Object.keys(DEFAULT_FONTS))
      const invalidKeys = Object.keys(parsed).filter(k => !validKeys.has(k))
      if (invalidKeys.length > 0) {
        setError(`Unknown token${invalidKeys.length > 1 ? 's' : ''}: ${invalidKeys.join(', ')}`)
        return
      }
      const validProps = new Set(['family', 'size', 'lineHeight', 'weight', 'letterSpacing'])
      for (const [tokenKey, tokenVal] of Object.entries(parsed)) {
        if (typeof tokenVal !== 'object' || tokenVal === null) {
          setError(`"${tokenKey}" must be an object`)
          return
        }
        const invalidProps = Object.keys(tokenVal as object).filter(p => !validProps.has(p))
        if (invalidProps.length > 0) {
          setError(`"${tokenKey}" has unknown propert${invalidProps.length > 1 ? 'ies' : 'y'}: ${invalidProps.join(', ')}`)
          return
        }
        const tv = tokenVal as Record<string, unknown>
        if (tv.family !== undefined && typeof tv.family !== 'string') {
          setError(`"${tokenKey}.family" must be a string`); return
        }
        if (tv.size !== undefined && (typeof tv.size !== 'number' || tv.size < 1 || tv.size > 72)) {
          setError(`"${tokenKey}.size" must be 1-72`); return
        }
        if (tv.lineHeight !== undefined && (typeof tv.lineHeight !== 'number' || tv.lineHeight < 0.5 || tv.lineHeight > 4)) {
          setError(`"${tokenKey}.lineHeight" must be 0.5-4`); return
        }
        if (tv.weight !== undefined && (typeof tv.weight !== 'number' || tv.weight < 100 || tv.weight > 900)) {
          setError(`"${tokenKey}.weight" must be 100-900`); return
        }
        if (tv.letterSpacing !== undefined && typeof tv.letterSpacing !== 'number') {
          setError(`"${tokenKey}.letterSpacing" must be a number`); return
        }
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON')
    }
  }, [])

  const hasBridge = typeof window.electron.settings.getRawJson === 'function'

  const handleSave = useCallback(async () => {
    if (error) return
    try {
      const fontsOverride = JSON.parse(rawJson)
      if (!hasBridge) {
        // Fallback: save via regular settings API
        const updated = await window.electron.settings.set({ ...settings, fonts: Object.keys(fontsOverride).length > 0 ? fontsOverride : undefined })
        onSettingsChange(updated)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        return
      }
      const { content } = await window.electron.settings.getRawJson()
      const config = JSON.parse(content || '{}')
      if (!config.settings) config.settings = {}
      // If empty object, remove fonts key entirely
      if (Object.keys(fontsOverride).length === 0) {
        delete config.settings.fonts
      } else {
        config.settings.fonts = fontsOverride
      }
      const result = await window.electron.settings.setRawJson(JSON.stringify(config, null, 2))
      if (result.ok && result.settings) {
        onSettingsChange(result.settings)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setError(result.error ?? 'Save failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }, [rawJson, error, onSettingsChange, settings, hasBridge])

  const handleReset = useCallback(async () => {
    setRawJson('{}')
    setError(null)
    if (!hasBridge) {
      const updated = await window.electron.settings.set({ ...settings, fonts: undefined as any })
      onSettingsChange(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      return
    }
    const { content } = await window.electron.settings.getRawJson()
    const config = JSON.parse(content || '{}')
    if (config.settings) delete config.settings.fonts
    const result = await window.electron.settings.setRawJson(JSON.stringify(config, null, 2))
    if (result.ok && result.settings) {
      onSettingsChange(result.settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }, [onSettingsChange, settings, hasBridge])

  const handleCopyDefaults = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(DEFAULT_FONTS, null, 2))
  }, [])

  const insertToken = useCallback((key: keyof FontSettings) => {
    try {
      const current = JSON.parse(rawJson || '{}')
      if (!current[key]) {
        const def = DEFAULT_FONTS[key]
        current[key] = { family: def.family, size: def.size }
      }
      const newJson = JSON.stringify(current, null, 2)
      setRawJson(newJson)
      handleChange(newJson)
      setView('editor')
    } catch { /* ignore */ }
  }, [rawJson, handleChange])

  if (loading) {
    return <div style={{ fontSize: 12, color: '#555', padding: 20 }}>Loading config...</div>
  }

  const monoFont = fonts.mono

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Config file path */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileJson size={13} color="#555" />
        <span style={{ fontSize: 10, color: '#555', fontFamily: monoFont }}>{configPath}</span>
        <span style={{ fontSize: 9, color: '#388bfd', fontFamily: monoFont }}>settings.fonts</span>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #1a1a1a' }}>
        {(['editor', 'reference'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '6px 14px', fontSize: 11, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: view === v ? '#1a1a1a' : 'transparent',
            color: view === v ? '#e6edf3' : '#555',
            borderBottom: view === v ? '2px solid #388bfd' : '2px solid transparent',
          }}>
            {v === 'editor' ? 'JSON Editor' : 'Token Reference'}
          </button>
        ))}
      </div>

      {view === 'editor' ? (
        <>
          {/* Toolbar */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button onClick={handleSave} disabled={!!error}
              style={{
                padding: '4px 12px', borderRadius: 5, fontSize: 10, cursor: error ? 'not-allowed' : 'pointer',
                background: error ? '#1a1a1a' : saved ? '#0d2a1a' : '#1f6feb',
                color: error ? '#444' : saved ? '#3fb950' : '#fff',
                border: 'none', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4,
              }}>
              {saved ? <><Check size={10} /> Saved</> : 'Save'}
            </button>
            <button onClick={handleReset}
              style={{ padding: '4px 10px', borderRadius: 5, fontSize: 10, cursor: 'pointer', background: '#1a1a1a', color: '#888', border: 'none', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
              title="Reset to defaults (remove all overrides)">
              <RotateCcw size={9} /> Reset
            </button>
            <button onClick={handleCopyDefaults}
              style={{ padding: '4px 10px', borderRadius: 5, fontSize: 10, cursor: 'pointer', background: '#1a1a1a', color: '#888', border: 'none', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
              title="Copy all default tokens to clipboard">
              <Copy size={9} /> Copy Defaults
            </button>
            <div style={{ flex: 1 }} />
            {error && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#ff7b72' }}>
                <AlertTriangle size={10} />
                <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</span>
              </div>
            )}
          </div>

          {/* JSON textarea */}
          <textarea
            ref={textareaRef}
            value={rawJson}
            onChange={e => handleChange(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                handleSave()
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                const ta = e.currentTarget
                const start = ta.selectionStart
                const end = ta.selectionEnd
                const newVal = ta.value.substring(0, start) + '  ' + ta.value.substring(end)
                handleChange(newVal)
                requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2 })
              }
            }}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 260, maxHeight: 380,
              padding: '12px 14px', borderRadius: 8,
              background: '#0a0a0a', color: error ? '#ff9080' : '#c9d1d9',
              border: `1px solid ${error ? '#ff7b7244' : '#1a1a1a'}`,
              outline: 'none', resize: 'vertical',
              fontFamily: monoFont, fontSize: 12, lineHeight: 1.6,
              tabSize: 2, boxSizing: 'border-box',
            }}
          />

          {/* Hint */}
          <div style={{ fontSize: 10, color: '#333', lineHeight: 1.6 }}>
            Override only the tokens you want. Properties: <span style={{ color: '#555', fontFamily: monoFont }}>family</span>, <span style={{ color: '#555', fontFamily: monoFont }}>size</span>, <span style={{ color: '#555', fontFamily: monoFont }}>lineHeight</span>, <span style={{ color: '#555', fontFamily: monoFont }}>weight</span>, <span style={{ color: '#555', fontFamily: monoFont }}>letterSpacing</span>.
            Unset tokens inherit from General. <span style={{ color: '#555' }}>Cmd+S</span> to save.
          </div>
        </>
      ) : (
        /* Token reference */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 360, overflowY: 'auto' }}>
          {FONT_TOKEN_GROUPS.map(group => (
            <div key={group.label}>
              <div style={{ fontSize: 9, color: '#388bfd', fontFamily: 'inherit', letterSpacing: 1, fontWeight: 700, marginBottom: 6, textTransform: 'uppercase' }}>
                {group.label}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {group.tokens.map(({ key, description }) => {
                  const token = settings.fonts?.[key] ?? DEFAULT_FONTS[key]
                  let isOverridden = false
                  try { isOverridden = !!(rawJson && rawJson !== '{}' && JSON.parse(rawJson)[key]) } catch { /* ignore */ }
                  return (
                    <div key={key}
                      onClick={() => insertToken(key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                        background: isOverridden ? '#0d2137' : '#0d0d0d',
                        border: `1px solid ${isOverridden ? '#1f3a5f' : '#151515'}`,
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { if (!isOverridden) e.currentTarget.style.background = '#111' }}
                      onMouseLeave={e => { if (!isOverridden) e.currentTarget.style.background = '#0d0d0d' }}
                      title={`Click to add "${key}" to editor`}
                    >
                      <span style={{ fontSize: 11, color: isOverridden ? '#58a6ff' : '#c9d1d9', fontFamily: monoFont, width: 140, flexShrink: 0 }}>
                        {key}
                      </span>
                      <span style={{ fontSize: 10, color: '#555', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {description}
                      </span>
                      <span style={{ fontSize: 9, color: '#444', fontFamily: monoFont, flexShrink: 0 }}>
                        {token.size}px
                      </span>
                      <span
                        style={{
                          fontSize: token.size > 14 ? 14 : token.size,
                          color: '#888', fontFamily: token.family,
                          fontWeight: token.weight, maxWidth: 60, flexShrink: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                        title={token.family}
                      >
                        Abc
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
