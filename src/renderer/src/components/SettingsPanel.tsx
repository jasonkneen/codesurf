import React, { useEffect, useState, useCallback, useRef, lazy } from 'react'
import type { AppSettings, FontSettings, FontToken } from '../../../shared/types'
import { DEFAULT_FONTS, withDefaultSettings } from '../../../shared/types'
import { Settings, Type, Monitor, FolderOpen, Plus, Trash2, ChevronDown, ChevronRight, FileJson, AlertTriangle, Check, Copy, RotateCcw, FormInput, Code2, Puzzle, RefreshCw, Star, Wrench, Users, FileText, Globe, Eye, EyeOff, PanelRight } from 'lucide-react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { THEME_OPTIONS, getThemeCanvasDefaults, resolveEffectiveThemeId, getThemeById, type AppearanceMode } from '../theme'

const LazyPromptsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.PromptsSection })))
const LazySkillsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.SkillsSection })))
const LazyToolsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.ToolsSection })))
const LazyAgentsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.AgentsSection })))

interface Workspace {
  id: string
  name: string
  path: string
}

interface Props {
  onClose: () => void
  settings: AppSettings
  onSettingsChange: (s: AppSettings) => void
  workspaces?: Workspace[]
  workspacePath?: string
  initialSection?: Section
  /** OS dark mode (for "system" appearance and preset list). */
  systemPrefersDark?: boolean
}

type BuiltinSection = 'general' | 'canvas' | 'sidebar' | 'browser' | 'mcp' | 'extensions' | 'prompts' | 'skills' | 'tools' | 'agents'
type Section = BuiltinSection | `ext:${string}`

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; description: string; group?: string }[] = [
  // App settings
  { id: 'general',    label: 'General',    icon: <Type size={15} />,       description: 'Display settings — fonts, weights, sizes, line heights, and raw JSON', group: 'app' },
  { id: 'canvas',     label: 'Canvas',     icon: <Monitor size={15} />,    description: 'Background, grid and snap settings', group: 'app' },

  { id: 'sidebar',    label: 'Sidebar',    icon: <FolderOpen size={15} />, description: 'File tree sort and ignored folders', group: 'app' },

  { id: 'browser',    label: 'Browser',    icon: <Globe size={15} />,      description: 'Chrome data sync — cookies, bookmarks, history', group: 'app' },
  // Customisation
  { id: 'prompts',    label: 'Prompts',    icon: <FileText size={15} />,   description: 'Prompt templates with variables and fields', group: 'customise' },
  { id: 'skills',     label: 'Skills',     icon: <Star size={15} />,       description: 'Custom skills and skill registry', group: 'customise' },
  { id: 'tools',      label: 'Tools',      icon: <Wrench size={15} />,     description: 'MCP servers, tools, integrations and registry', group: 'customise' },
  { id: 'agents',     label: 'Agents',     icon: <Users size={15} />,      description: 'Agent modes with system prompts and tool access', group: 'customise' },
  // System
  { id: 'extensions', label: 'Extensions', icon: <Puzzle size={15} />,     description: 'Installed extensions', group: 'system' },
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

type ExtensionListEntry = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  tier: 'safe' | 'power'
  ui?: import('../../../shared/types').ExtensionManifest['ui']
  enabled: boolean
  contributes?: import('../../../shared/types').ExtensionManifest['contributes']
  dirPath?: string | null
}

const EXTENSIONS_CHANGED_EVENT = 'codesurf:extensions-changed'

function notifyExtensionsChanged(): void {
  window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED_EVENT))
}

// ─── Extension settings panel ─────────────────────────────────────────────────
function ExtSettingsPanel({ extId, tileType }: { extId: string; tileType: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    window.electron.extensions?.tileEntry?.(extId, tileType)
      .then((url: string | null) => setSrc(url ?? null))
      .catch(() => setSrc(null))
  }, [extId, tileType])
  if (!src) return <div style={{ fontSize: 12, color: theme.text.muted }}>Loading…</div>
  return (
    <iframe
      key={src}
      src={src}
      style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8 }}
    />
  )
}

// ─── Control components ────────────────────────────────────────────────────────
function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  const theme = useTheme()
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 44, height: 26, borderRadius: 13, cursor: 'pointer', flexShrink: 0,
        background: value ? theme.accent.base : theme.surface.panelMuted,
        position: 'relative', transition: 'background 0.2s',
      }}
    >
      <div style={{
        position: 'absolute',
        top: 3, left: value ? 21 : 3,
        width: 20, height: 20, borderRadius: '50%',
        background: value ? theme.text.inverse : theme.text.muted,
        transition: 'left 0.2s, background 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
      }} />
    </div>
  )
}

function NumInput({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }): React.JSX.Element {
  const theme = useTheme()
  return (
    <input
      type="number" value={value} min={min} max={max} step={step}
      onChange={e => onChange(Number(e.target.value))}
      style={{
        width: 72, padding: '5px 10px', fontSize: 'inherit',
        background: theme.surface.input, color: theme.text.secondary,
        border: `1px solid ${theme.border.default}`, borderRadius: 8, outline: 'none',
        textAlign: 'right'
      }}
    />
  )
}

function RangeInput({ value, min, max, step = 0.01, onChange, formatValue }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; formatValue?: (v: number) => string }): React.JSX.Element {
  const theme = useTheme()
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
        fontSize: 'inherit',
        textAlign: 'right',
        color: theme.text.muted,
        background: theme.surface.input,
        border: `1px solid ${theme.border.default}`,
        borderRadius: 8,
        fontVariantNumeric: 'tabular-nums'
      }}>
        {formatValue ? formatValue(clamped) : `${Math.round(clamped * 100)}%`}
      </div>
    </div>
  )
}

function TextInput({ value, onChange, width = 240 }: { value: string; onChange: (v: string) => void; width?: number }): React.JSX.Element {
  const theme = useTheme()
  return (
    <input
      type="text" value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width, padding: '5px 10px', fontSize: 'inherit',
        background: theme.surface.input, color: theme.text.secondary,
        border: `1px solid ${theme.border.default}`, borderRadius: 8, outline: 'none'
      }}
    />
  )
}

function ColorSwatch({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const colorInputValue = (() => {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    }
    const match = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
    if (!match) return '#000000'
    const [r, g, b] = match.slice(1, 4).map((channel) => Math.max(0, Math.min(255, Number(channel))))
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  })()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <div
          style={{ width: 28, height: 28, borderRadius: 6, background: value, cursor: 'pointer', border: `1px solid ${theme.border.strong}` }}
          onClick={e => (e.currentTarget.nextSibling as HTMLInputElement)?.click()}
        />
        <input type="color" value={colorInputValue} onChange={e => onChange(e.target.value)}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }} />
      </div>
      <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, fontFamily: fonts.mono }}>{value}</span>
    </div>
  )
}

/** Extract display name from a font stack for sorting/display */
function fontDisplayName(stack: string): string {
  const first = stack.split(',')[0].trim().replace(/^"|"$/g, '')
  if (first.startsWith('-apple-system') || first === 'system-ui') return 'System Default'
  if (first === 'monospace') return 'System Monospace'
  return first
}

/** Sort font stacks alphabetically by display name, generic/system fonts last */
function sortFonts(fonts: string[]): string[] {
  return [...fonts].sort((a, b) => {
    const na = fontDisplayName(a)
    const nb = fontDisplayName(b)
    const aGeneric = na.startsWith('System')
    const bGeneric = nb.startsWith('System')
    if (aGeneric && !bGeneric) return 1
    if (bGeneric && !aGeneric) return -1
    return na.localeCompare(nb)
  })
}

const SANS_FONTS = sortFonts([
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
  // Paseo font stacks
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  '"SF Pro Rounded", "Hiragino Maru Gothic ProN", Meiryo, "MS PGothic", sans-serif',
  '"Roboto", "Segoe UI", sans-serif',
  'system-ui, sans-serif',
])

const MONO_FONTS = sortFonts([
  '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace',
  '"IBM Plex Mono", monospace',
  '"Fira Code", "JetBrains Mono", monospace',
  '"SF Mono", "Menlo", "Monaco", monospace',
  '"Cascadia Code", "Fira Code", monospace',
  '"Source Code Pro", "Menlo", monospace',
  '"Geist Mono", "SF Mono", monospace',
  // Paseo font stacks
  '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  '"JetBrains Mono", "JetBrainsMono Nerd Font", "JetBrainsMono NF", "MesloLGM Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "SF Mono", Menlo, Monaco, Consolas, monospace',
  '"MesloLGM Nerd Font", "MesloLGM NF", "JetBrains Mono", monospace',
  '"Hack Nerd Font", "Fira Code", monospace',
  '"FiraCode Nerd Font", "Fira Code", monospace',
  'monospace',
])

function FontSelect({ value, onChange, fonts }: { value: string; onChange: (v: string) => void; fonts: string[] }): React.JSX.Element {
  const theme = useTheme()
  const displayName = fontDisplayName
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', maxWidth: 280, padding: '5px 10px', fontSize: 'inherit',
        background: theme.surface.input, color: theme.text.secondary,
        border: `1px solid ${theme.border.default}`, borderRadius: 8, outline: 'none',
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

/* FontGroup removed — token-based rows replaced it */

// ─── Setting row ──────────────────────────────────────────────────────────────
function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`, borderRadius: 10, padding: '14px 16px',
      marginBottom: 8, gap: 16
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500, marginBottom: description ? 3 : 0 }}>{label}</div>
        {description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

function SectionLabel({ label }: { label: string }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{
      fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.disabled,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      marginTop: 20, marginBottom: 8, paddingLeft: 2
    }}>
      {label}
    </div>
  )
}

// ─── Chrome Sync section ──────────────────────────────────────────────────────

interface ChromeProfile { name: string; dir: string; email?: string }

function ChromeSyncSection({ settings, onUpdate, theme }: {
  settings: AppSettings
  onUpdate: (key: keyof AppSettings, value: any) => void
  theme: ReturnType<typeof useTheme>
}): React.JSX.Element {
  const fonts = useAppFonts()
  const [profiles, setProfiles] = useState<ChromeProfile[]>([])
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    window.electron?.chromeSync?.listProfiles().then((p: ChromeProfile[]) => {
      setProfiles(p)
      // Auto-select first profile if none set
      if (p.length > 0 && !settings.chromeSyncProfileDir) {
        onUpdate('chromeSyncProfileDir', p[0].dir)
      }
    }).catch(() => {})
  }, [])

  const handleSync = async () => {
    if (!settings.chromeSyncProfileDir || syncing) return
    setSyncing(true)
    setSyncStatus('Syncing...')
    try {
      // Sync cookies into a test partition to verify it works
      const result = await window.electron?.chromeSync?.syncCookies(
        settings.chromeSyncProfileDir,
        'persist:browser-tile-test',
      )
      if (result?.errors?.length > 0) {
        setSyncStatus(`Synced ${result.count} cookies (${result.errors.length} errors)`)
      } else {
        setSyncStatus(`Synced ${result?.count ?? 0} cookies`)
      }
    } catch (e: any) {
      setSyncStatus(`Error: ${e.message || 'Failed'}`)
    } finally {
      setSyncing(false)
    }
  }

  const noChrome = profiles.length === 0

  return (
    <>
      <SectionLabel label="Chrome Data Sync" />
      <SettingRow label="Enable Chrome sync" description="Import cookies, bookmarks, and history from Chrome into browser blocks">
        <button
          onClick={() => onUpdate('chromeSyncEnabled', !settings.chromeSyncEnabled)}
          style={{
            width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
            background: settings.chromeSyncEnabled ? theme.accent.base : theme.surface.panelMuted,
            position: 'relative', transition: 'background 0.15s',
          }}
        >
          <div style={{
            width: 16, height: 16, borderRadius: 8, background: theme.text.primary,
            position: 'absolute', top: 2,
            left: settings.chromeSyncEnabled ? 18 : 2,
            transition: 'left 0.15s',
          }} />
        </button>
      </SettingRow>

      {settings.chromeSyncEnabled && (
        <>
          <SettingRow label="Chrome profile" description={noChrome ? 'Chrome not detected on this machine' : 'Select which Chrome profile to sync from'}>
            {noChrome ? (
              <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>Not found</span>
            ) : (
              <select
                value={settings.chromeSyncProfileDir ?? ''}
                onChange={e => onUpdate('chromeSyncProfileDir', e.target.value)}
                style={{
                  fontSize: fonts.secondarySize, padding: '4px 8px', borderRadius: 6,
                  background: theme.surface.panelMuted, color: theme.text.primary,
                  border: `1px solid ${theme.border.default}`, outline: 'none',
                  minWidth: 140,
                }}
              >
                {profiles.map(p => (
                  <option key={p.dir} value={p.dir}>
                    {p.name}{p.email ? ` (${p.email})` : ''}
                  </option>
                ))}
              </select>
            )}
          </SettingRow>

          <SettingRow label="Sync now" description="Import Chrome cookies into all new browser blocks">
            <button
              onClick={handleSync}
              disabled={syncing || noChrome}
              style={{
                fontSize: fonts.secondarySize, padding: '5px 12px', borderRadius: 6,
                background: theme.accent.base, color: '#fff', border: 'none',
                cursor: syncing || noChrome ? 'not-allowed' : 'pointer',
                opacity: syncing || noChrome ? 0.5 : 1,
              }}
            >
              {syncing ? 'Syncing...' : 'Sync'}
            </button>
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

// ─── Main panel ───────────────────────────────────────────────────────────────
export function SettingsPanel({ onClose, settings: initialSettings, onSettingsChange, workspaces = [], workspacePath, initialSection, systemPrefersDark = true }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  const [section, setSection] = useState<Section>(initialSection ?? 'general')
  const [mcpConfig, setMcpConfig] = useState<MCPConfig | null>(null)
  const fonts = useAppFonts()
  const theme = useTheme()
  const [mcpSaved, setMcpSaved] = useState(false)
  const [addingServer, setAddingServer] = useState(false)
  const [newServer, setNewServer] = useState({ name: '', url: '', cmd: '', description: '' })
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [workspaceServers, setWorkspaceServers] = useState<Record<string, Record<string, MCPServerEntry>>>({})
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<{ checking: boolean; downloading: boolean; result: null | { ok: boolean; currentVersion: string; status: string; updateAvailable: boolean; updateInfo?: { version?: string; releaseName?: string; releaseDate?: string } } }>({ checking: false, downloading: false, result: null })
  const [extensionsList, setExtensionsList] = useState<ExtensionListEntry[]>([])
  const [extensionsLoading, setExtensionsLoading] = useState(false)
  const [extensionsError, setExtensionsError] = useState<string | null>(null)
  const [expandedExtId, setExpandedExtId] = useState<string | null>(null)
  const [extSettingsMap, setExtSettingsMap] = useState<Record<string, Record<string, unknown>>>({})

  const latestSettingsSaveRef = useRef(0)
  const settingsRef = useRef<AppSettings>(withDefaultSettings(initialSettings))

  useEffect(() => {
    const normalized = withDefaultSettings(initialSettings)
    settingsRef.current = normalized
    setSettings(normalized)
  }, [initialSettings])

  useEffect(() => {
    window.electron.mcp?.getConfig?.().then((cfg: unknown) => {
      if (cfg) setMcpConfig(cfg as MCPConfig)
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

  const loadExtensions = useCallback(async () => {
    if (!window.electron?.extensions?.list) {
      setExtensionsError('Extensions API unavailable')
      return
    }
    setExtensionsLoading(true)
    setExtensionsError(null)
    try {
      const list = await window.electron.extensions.list()
      setExtensionsList(list as ExtensionListEntry[])
    } catch (e) {
      setExtensionsError(e instanceof Error ? e.message : String(e))
    } finally {
      setExtensionsLoading(false)
    }
  }, [])

  const refreshExtensions = useCallback(async () => {
    if (!window.electron?.extensions?.refresh) return loadExtensions()
    setExtensionsLoading(true)
    setExtensionsError(null)
    try {
      const wsPath = workspaces[0]?.path ?? null
      const list = await window.electron.extensions.refresh(wsPath)
      setExtensionsList(list as ExtensionListEntry[])
    } catch (e) {
      setExtensionsError(e instanceof Error ? e.message : String(e))
      await loadExtensions()
    } finally {
      setExtensionsLoading(false)
    }
  }, [workspaces, loadExtensions])

  const toggleExtensionEnabled = useCallback(async (extId: string, nextEnabled: boolean) => {
    if (!window.electron?.extensions) return
    try {
      if (nextEnabled) {
        await window.electron.extensions.enable(extId)
        await window.electron.extensions.refresh(workspaces[0]?.path ?? null)
      } else {
        await window.electron.extensions.disable(extId)
      }
      const list = await window.electron.extensions.list()
      setExtensionsList(list as ExtensionListEntry[])
      notifyExtensionsChanged()
    } catch (e) {
      setExtensionsError(e instanceof Error ? e.message : String(e))
    }
  }, [workspaces])

  useEffect(() => {
    if (section !== 'extensions') return
    void loadExtensions()
  }, [section, loadExtensions])

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

  const persistSettings = useCallback((next: AppSettings) => {
    const requestId = ++latestSettingsSaveRef.current
    const normalizedNext = withDefaultSettings(next)
    settingsRef.current = normalizedNext
    onSettingsChange(normalizedNext)
    void window.electron.settings?.set(normalizedNext).then((saved: AppSettings) => {
      if (!saved || requestId !== latestSettingsSaveRef.current) return
      const normalizedSaved = withDefaultSettings(saved)
      settingsRef.current = normalizedSaved
      setSettings(normalizedSaved)
      onSettingsChange(normalizedSaved)
    })
  }, [onSettingsChange])

  // Auto-save on every change
  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = withDefaultSettings({ ...settingsRef.current, [key]: value })
    settingsRef.current = next
    setSettings(next)
    persistSettings(next)
  }, [persistSettings])

  const updateSettingsPatch = useCallback((patch: Partial<AppSettings>) => {
    const themePatch = patch.themeId !== undefined && patch.canvasBackground === undefined && patch.gridColorSmall === undefined && patch.gridColorLarge === undefined
      ? (() => {
          const canvas = getThemeCanvasDefaults(patch.themeId)
          return {
            canvasBackground: canvas.background,
            gridColorSmall: canvas.gridSmall,
            gridColorLarge: canvas.gridLarge,
          }
        })()
      : {}
    const next = withDefaultSettings({ ...settingsRef.current, ...patch, ...themePatch })
    settingsRef.current = next
    setSettings(next)
    persistSettings(next)

    if (
      patch.extensionsDisabled !== undefined
      || patch.hiddenFromSidebarExtIds !== undefined
      || patch.settingsPanelExtIds !== undefined
      || patch.pinnedExtensionIds !== undefined
    ) {
      notifyExtensionsChanged()
    }
  }, [persistSettings])

  const applyThemePreset = useCallback((themeId: string) => {
    const canvas = getThemeCanvasDefaults(themeId)
    updateSettingsPatch({
      themeId,
      canvasBackground: canvas.background,
      gridColorSmall: canvas.gridSmall,
      gridColorLarge: canvas.gridLarge,
    })
  }, [updateSettingsPatch])

  const applyAppearanceMode = useCallback((mode: AppearanceMode) => {
    const currentThemeId = settings.themeId
    if (mode === 'light') {
      const canvas = getThemeCanvasDefaults('paper-light')
      updateSettingsPatch({
        appearance: mode,
        themeId: 'paper-light',
        canvasBackground: canvas.background,
        gridColorSmall: canvas.gridSmall,
        gridColorLarge: canvas.gridLarge,
      })
      return
    }
    let nextThemeId = currentThemeId
    if (currentThemeId === 'paper-light') {
      nextThemeId = 'default-dark'
    }
    const canvas = getThemeCanvasDefaults(nextThemeId)
    updateSettingsPatch({
      appearance: mode,
      themeId: nextThemeId,
      canvasBackground: canvas.background,
      gridColorSmall: canvas.gridSmall,
      gridColorLarge: canvas.gridLarge,
    })
  }, [settings.themeId, updateSettingsPatch])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const activeExt = section.startsWith('ext:') ? extensionsList.find(e => `ext:${e.id}` === section) : undefined
  const active = SECTIONS.find(s => s.id === section) ?? (activeExt ? { label: activeExt.name, description: activeExt.description ?? '' } : { label: '', description: '' })

  const renderContent = () => {
    switch (section) {
      case 'general': {
        const resolvedThemeId = resolveEffectiveThemeId(settings.appearance ?? 'dark', settings.themeId, systemPrefersDark)
        const resolvedUiMode = getThemeById(resolvedThemeId).mode
        const presetOptions = THEME_OPTIONS.filter(o => o.mode === resolvedUiMode)
        const appearanceMode = settings.appearance ?? 'dark'
        return (
          <>
            <SectionLabel label="Appearance" />
            <SettingRow label="Mode" description="Dark uses the palette below. Light uses the Paper Light theme. System follows your OS dark/light setting.">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(['dark', 'light', 'system'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => applyAppearanceMode(mode)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 8,
                      fontSize: fonts.secondarySize,
                      fontWeight: 600,
                      border: `1px solid ${appearanceMode === mode ? theme.accent.base : theme.border.default}`,
                      background: appearanceMode === mode ? theme.accent.soft : theme.surface.input,
                      color: appearanceMode === mode ? theme.accent.hover : theme.text.secondary,
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {mode === 'system' ? 'System' : mode}
                  </button>
                ))}
              </div>
            </SettingRow>
            <SectionLabel label="Theme" />
            <SettingRow label="Preset" description="Changes block chrome, terminal colours, shell surfaces, and resets the canvas palette to the preset defaults. Presets match the current light or dark mode.">
              <select
                value={resolvedThemeId}
                onChange={e => applyThemePreset(e.target.value)}
                style={{
                  minWidth: 220,
                  padding: '6px 10px',
                  fontSize: fonts.secondarySize,
                  background: theme.surface.input,
                  color: theme.text.secondary,
                  border: `1px solid ${theme.border.default}`,
                  borderRadius: 8,
                  outline: 'none',
                }}
              >
                {presetOptions.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {option.mode}
                  </option>
                ))}
              </select>
            </SettingRow>
            <DisplaySettingsEditor
              settings={settings}
              onApply={updateSettingsPatch}
              updateState={updateState}
              onCheckForUpdates={checkForUpdates}
              onDownloadUpdate={downloadUpdate}
            />
          </>
        )
      }
      case 'canvas':
        return (
          <>
            <SectionLabel label="Display" />
            <SettingRow label="Background colour" description="Canvas background color">
              <ColorSwatch value={settings.canvasBackground} onChange={v => update('canvasBackground', v)} />
            </SettingRow>
            <SettingRow label="Canvas translucency" description="Slide left for see-through vibrancy, all the way right for fully opaque">
              <RangeInput value={settings.translucentBackgroundOpacity} min={0.05} max={1} step={0.01} onChange={v => update('translucentBackgroundOpacity', Number(v.toFixed(2)))} formatValue={v => `${Math.round(v * 100)}%`} />
            </SettingRow>
            <SettingRow label="Cursor glow" description="Show or hide the cursor-proximity glow over the canvas grid. Radius is measured in screen pixels.">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Toggle value={settings.canvasGlowEnabled} onChange={v => update('canvasGlowEnabled', v)} />
                <div style={{ opacity: settings.canvasGlowEnabled ? 1 : 0.45, pointerEvents: settings.canvasGlowEnabled ? 'auto' : 'none' }}>
                  <RangeInput value={settings.canvasGlowRadius} min={50} max={200} step={5} onChange={v => update('canvasGlowRadius', v)} formatValue={v => `${Math.round(v)}px`} />
                </div>
              </div>
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
            <SettingRow label="Snap to grid" description="Snap blocks to the grid when dragging">
              <Toggle value={settings.snapToGrid} onChange={v => update('snapToGrid', v)} />
            </SettingRow>
          </>
        )

      case 'sidebar':
        return (
          <>
            <SectionLabel label="Sidebar" />
            <SettingRow label="Navigation" description="The sidebar shows workspaces and canvases. Use Files blocks on the canvas for file browsing.">
              <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted }}>Files block replaces sidebar file browser</span>
            </SettingRow>
          </>
        )



      case 'browser':
        return <ChromeSyncSection settings={settings} onUpdate={update} theme={theme} />

      case 'tools':
      case 'mcp': {
        const servers = mcpConfig?.mcpServers ?? {}
        const userServers = Object.entries(servers).filter(([k]) => k !== 'contex')
        return (
          <>
            {/* Tools & permissions — only when accessed via Tools tab */}
            {section === 'tools' && (
              <div style={{ marginBottom: 20 }}>
                <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
                  <LazyToolsSection />
                </React.Suspense>
              </div>
            )}

            {/* MCP Server Status */}
            <SectionLabel label="Server Status" />
            <div style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '12px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: mcpConfig ? theme.status.success : '#555', boxShadow: mcpConfig ? '0 0 6px #3fb950' : 'none', flexShrink: 0 }} />
                <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500 }}>contex</span>
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
                { label: 'Global config', path: '~/.contex/mcp-server.json' },
                { label: 'Workspace servers', path: '~/.contex/workspaces/<id>/mcp-servers.json' },
                { label: 'Merged config (point agents here)', path: '~/.contex/workspaces/<id>/.contex/mcp-merged.json', highlight: true },
              ].map(row => (
                <div key={row.label}>
                  <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{row.label}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ fontSize: fonts.secondarySize, color: row.highlight ? '#4a9eff' : '#555', fontFamily: fonts.mono, flex: 1 }}>{row.path}</code>
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

      case 'extensions':
        return (
          <>
            <SectionLabel label="Installed extensions" />
            {/* Master kill-switch */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', marginBottom: 12, borderRadius: 10,
              background: settings.extensionsDisabled ? 'rgba(244,71,71,0.08)' : theme.surface.panelMuted,
              border: `1px solid ${settings.extensionsDisabled ? 'rgba(244,71,71,0.25)' : theme.border.default}`,
              transition: 'background 0.15s, border-color 0.15s',
            }}>
              <div>
                <div style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>Disable all extensions</div>
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginTop: 2 }}>
                  {settings.extensionsDisabled ? 'Extensions are hidden from the sidebar and footer' : 'Hide all extensions from the sidebar and footer'}
                </div>
              </div>
              <Toggle value={settings.extensionsDisabled ?? false} onChange={v => updateSettingsPatch({ extensionsDisabled: v })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, lineHeight: 1.45, flex: 1, minWidth: 200 }}>
                Extensions load from <code style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>~/.contex/extensions</code>
                {workspaces.length > 0 && (
                  <> and the active workspace&apos;s <code style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>.contex/extensions</code></>
                )}
                . Disable a power extension to unload its main process code; use Refresh after adding folders.
              </div>
              <button
                type="button"
                onClick={() => { void refreshExtensions() }}
                disabled={extensionsLoading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 12px', borderRadius: 8, fontSize: fonts.secondarySize, fontWeight: 600,
                  cursor: extensionsLoading ? 'wait' : 'pointer',
                  background: theme.surface.input,
                  color: theme.text.secondary,
                  border: `1px solid ${theme.border.default}`,
                  flexShrink: 0,
                }}
              >
                <RefreshCw size={14} style={{ opacity: extensionsLoading ? 0.5 : 1 }} />
                Rescan
              </button>
            </div>

            {extensionsError && (
              <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(244,71,71,0.12)', border: '1px solid rgba(244,71,71,0.35)', fontSize: fonts.secondarySize, color: '#f48771' }}>
                {extensionsError}
              </div>
            )}

            {extensionsLoading && extensionsList.length === 0 ? (
              <div style={{ fontSize: fonts.size, color: theme.text.muted, padding: '12px 0' }}>Loading extensions…</div>
            ) : extensionsList.length === 0 ? (
              <div style={{ fontSize: fonts.size, color: theme.text.disabled, padding: '16px', background: theme.surface.panelMuted, borderRadius: 10, border: `1px dashed ${theme.border.default}` }}>
                No extensions found. Add a folder under <span style={{ fontFamily: fonts.mono, fontSize: fonts.secondarySize }}>~/.contex/extensions</span> with an <span style={{ fontFamily: fonts.mono, fontSize: fonts.secondarySize }}>extension.json</span> manifest.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {extensionsList.map(ext => {
                  const tiles = ext.contributes?.tiles?.length ?? 0
                  const menus = ext.contributes?.contextMenu?.length ?? 0
                  const extSettings = ext.contributes?.settings ?? []
                  const isHiddenFromSidebar = (settings.hiddenFromSidebarExtIds ?? []).includes(ext.id)
                  const isInSettingsPanel = (settings.settingsPanelExtIds ?? []).includes(ext.id)
                  const isExpanded = expandedExtId === ext.id
                  const savedExtSettings = extSettingsMap[ext.id] ?? {}
                  return (
                    <div
                      key={ext.id}
                      style={{
                        background: theme.surface.panelMuted,
                        borderRadius: 10,
                        border: `1px solid ${isExpanded ? theme.border.strong : theme.border.default}`,
                        overflow: 'hidden',
                        transition: 'border-color 0.15s',
                      }}
                    >
                      {/* Card header row */}
                      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                            <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>{ext.name}</span>
                            <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>v{ext.version}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
                              padding: '2px 6px', borderRadius: 4,
                              background: ext.tier === 'power' ? 'rgba(74,158,255,0.15)' : 'rgba(63,185,80,0.12)',
                              color: ext.tier === 'power' ? '#4a9eff' : theme.status.success,
                            }}>{ext.tier}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
                              padding: '2px 6px', borderRadius: 4,
                              background: ext.ui?.mode === 'custom' ? 'rgba(251,191,36,0.15)' : theme.surface.accentSoft,
                              color: ext.ui?.mode === 'custom' ? theme.status.warning : theme.accent.base,
                            }}>{ext.ui?.mode === 'custom' ? 'custom ui' : 'core ui'}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                              background: ext.enabled ? 'rgba(63,185,80,0.12)' : 'rgba(136,136,136,0.15)',
                              color: ext.enabled ? theme.status.success : theme.text.disabled,
                            }}>{ext.enabled ? 'enabled' : 'disabled'}</span>
                          </div>
                          <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono, marginBottom: 4 }}>{ext.id}</div>
                          {ext.description && (
                            <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, lineHeight: 1.4, marginBottom: 4 }}>{ext.description}</div>
                          )}
                          <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted }}>
                            {tiles > 0 && <span>{tiles} block{tiles === 1 ? '' : 's'}</span>}
                            {tiles > 0 && menus > 0 && ' · '}
                            {menus > 0 && <span>{menus} menu item{menus === 1 ? '' : 's'}</span>}
                            {(tiles > 0 || menus > 0) && ' · '}
                            <span>{ext.ui?.mode === 'custom' ? 'bespoke extension surface' : 'host-aligned extension surface'}</span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          {/* Show in sidebar toggle (ON by default) */}
                          <button
                            title={isHiddenFromSidebar ? 'Show in sidebar' : 'Hide from sidebar'}
                            onClick={() => {
                              const next = isHiddenFromSidebar
                                ? (settings.hiddenFromSidebarExtIds ?? []).filter(id => id !== ext.id)
                                : [...(settings.hiddenFromSidebarExtIds ?? []), ext.id]
                              updateSettingsPatch({ hiddenFromSidebarExtIds: next })
                            }}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                              color: isHiddenFromSidebar ? theme.text.disabled : theme.text.secondary,
                              display: 'flex', alignItems: 'center', transition: 'color 0.15s',
                            }}
                          >
                            {isHiddenFromSidebar ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          {/* Show as settings panel toggle */}
                          {ext.contributes?.tiles && ext.contributes.tiles.length > 0 && (
                            <button
                              title={isInSettingsPanel ? 'Remove from settings' : 'Show in settings panel'}
                              onClick={() => {
                                const next = isInSettingsPanel
                                  ? (settings.settingsPanelExtIds ?? []).filter(id => id !== ext.id)
                                  : [...(settings.settingsPanelExtIds ?? []), ext.id]
                                updateSettingsPatch({ settingsPanelExtIds: next })
                              }}
                              style={{
                                background: isInSettingsPanel ? theme.surface.accentSoft : 'none',
                                border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                                color: isInSettingsPanel ? theme.accent.base : theme.text.disabled,
                                display: 'flex', alignItems: 'center', transition: 'color 0.15s, background 0.15s',
                              }}
                            >
                              <PanelRight size={14} />
                            </button>
                          )}
                          {/* Settings cog — only show if extension declares settings */}
                          {extSettings.length > 0 && (
                            <button
                              title="Extension settings"
                              onClick={async () => {
                                if (isExpanded) { setExpandedExtId(null); return }
                                // Load current settings for this extension
                                const current = await window.electron.extensions?.getSettings?.(ext.id).catch(() => ({})) ?? {}
                                setExtSettingsMap(prev => ({ ...prev, [ext.id]: current }))
                                setExpandedExtId(ext.id)
                              }}
                              style={{
                                background: isExpanded ? theme.surface.accentSoft : 'none',
                                border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                                color: isExpanded ? theme.accent.base : theme.text.disabled,
                                display: 'flex', alignItems: 'center',
                                transition: 'color 0.15s, background 0.15s',
                              }}
                            >
                              <Settings size={14} />
                            </button>
                          )}
                          <Toggle value={ext.enabled} onChange={v => { void toggleExtensionEnabled(ext.id, v) }} />
                        </div>
                      </div>
                      {/* Inline settings panel */}
                      {isExpanded && extSettings.length > 0 && (
                        <div style={{
                          borderTop: `1px solid ${theme.border.default}`,
                          padding: '12px 14px',
                          background: theme.surface.panel,
                          display: 'flex', flexDirection: 'column', gap: 10,
                        }}>
                          <div style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Settings</div>
                          {extSettings.map((s) => (
                            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <label style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, flex: 1 }}>{s.label}</label>
                              {s.type === 'boolean' ? (
                                <Toggle
                                  value={savedExtSettings[s.key] !== undefined ? Boolean(savedExtSettings[s.key]) : Boolean(s.default)}
                                  onChange={async v => {
                                    const next = { ...savedExtSettings, [s.key]: v }
                                    setExtSettingsMap(prev => ({ ...prev, [ext.id]: next }))
                                    await window.electron.extensions?.setSettings?.(ext.id, next).catch(() => {})
                                  }}
                                />
                              ) : (
                                <input
                                  type={s.type === 'number' ? 'number' : 'text'}
                                  value={String(savedExtSettings[s.key] ?? s.default ?? '')}
                                  onChange={async e => {
                                    const val = s.type === 'number' ? Number(e.target.value) : e.target.value
                                    const next = { ...savedExtSettings, [s.key]: val }
                                    setExtSettingsMap(prev => ({ ...prev, [ext.id]: next }))
                                    await window.electron.extensions?.setSettings?.(ext.id, next).catch(() => {})
                                  }}
                                  style={{
                                    background: theme.surface.input, border: `1px solid ${theme.border.default}`,
                                    color: theme.text.primary, borderRadius: 6, padding: '4px 8px',
                                    fontSize: fonts.secondarySize, fontFamily: fonts.mono, width: 160,
                                  }}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )

      case 'prompts':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazyPromptsSection workspacePath={workspacePath} />
          </React.Suspense>
        ) : <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Open a workspace first</div>

      case 'skills':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazySkillsSection workspacePath={workspacePath} />
          </React.Suspense>
        ) : <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Open a workspace first</div>

      case 'agents':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazyAgentsSection workspacePath={workspacePath} />
          </React.Suspense>
        ) : <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Open a workspace first</div>

      default: {
        if (section.startsWith('ext:')) {
          const extId = section.slice(4)
          const ext = extensionsList.find(e => e.id === extId)
          const tile = ext?.contributes?.tiles?.[0]
          if (ext && tile) {
            return <ExtSettingsPanel extId={extId} tileType={tile.type} />
          }
          return <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Extension has no block.</div>
        }
        return null
      }
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: theme.mode === 'light' ? 'rgba(15,23,42,0.18)' : 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: '90vw', maxWidth: 1100, height: '85vh', maxHeight: 780,
        background: theme.surface.panel, borderRadius: 14,
        border: `1px solid ${theme.border.default}`,
        boxShadow: theme.shadow.modal,
        display: 'flex', overflow: 'hidden',
        fontFamily: fonts.primary, fontSize: fonts.size, lineHeight: fonts.lineHeight, fontWeight: fonts.weight,
      }}>

        {/* Left nav */}
        <div style={{
          width: 200, background: theme.surface.panelElevated,
          borderRight: `1px solid ${theme.border.default}`,
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
                cursor: 'pointer', color: theme.text.disabled,
              }}
              onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
              onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}
            >
              <div style={{
                width: 22, height: 22, borderRadius: '50%',
                border: '1.5px solid currentColor',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: fonts.secondarySize, lineHeight: 1
              }}>
                ×
              </div>
              <span style={{ fontSize: fonts.secondarySize }}>esc</span>
            </div>
          </div>

          {/* Settings header */}
          <div style={{ padding: '8px 16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Settings size={18} color={theme.text.primary} />
            <span style={{ fontSize: 17, fontWeight: 700, color: theme.text.primary }}>Settings</span>
          </div>

          {/* Nav items — grouped */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {(['app', 'customise', 'system'] as const).map(group => {
              const groupSections = SECTIONS.filter(s => s.group === group)
              const groupLabel = group === 'app' ? 'App' : group === 'customise' ? 'Customise' : 'System'
              return (
                <div key={group}>
                  <div style={{ padding: '14px 16px 4px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1.2, textTransform: 'uppercase', userSelect: 'none' }}>{groupLabel}</div>
                  {groupSections.map(s => (
                    <div
                      key={s.id}
                      onClick={() => setSection(s.id as Section)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 16px', cursor: 'pointer',
                        color: section === s.id ? theme.text.primary : theme.text.disabled,
                        background: section === s.id ? theme.surface.selection : 'transparent',
                        fontSize: fonts.size, userSelect: 'none',
                        transition: 'color 0.1s'
                      }}
                      onMouseEnter={e => { if (section !== s.id) e.currentTarget.style.color = theme.text.muted }}
                      onMouseLeave={e => { if (section !== s.id) e.currentTarget.style.color = theme.text.disabled }}
                    >
                      <span style={{ opacity: section === s.id ? 1 : 0.5 }}>{s.icon}</span>
                      {s.label}
                    </div>
                  ))}
                </div>
              )
            })}
            {/* Extension panels pinned to settings */}
            {(() => {
              const panelExts = extensionsList
                .filter(e => (settings.settingsPanelExtIds ?? []).includes(e.id))
                .sort((a, b) => a.name.localeCompare(b.name))
              if (panelExts.length === 0) return null
              return (
                <div>
                  <div style={{ padding: '14px 16px 4px', fontSize: 9, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1.2, textTransform: 'uppercase', userSelect: 'none' }}>Extensions</div>
                  {panelExts.map(e => {
                    const sid = `ext:${e.id}` as Section
                    return (
                      <div
                        key={e.id}
                        onClick={() => setSection(sid)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 16px', cursor: 'pointer',
                          color: section === sid ? theme.text.primary : theme.text.disabled,
                          background: section === sid ? theme.surface.selection : 'transparent',
                          fontSize: fonts.size, userSelect: 'none', transition: 'color 0.1s',
                        }}
                        onMouseEnter={e2 => { if (section !== sid) e2.currentTarget.style.color = theme.text.muted }}
                        onMouseLeave={e2 => { if (section !== sid) e2.currentTarget.style.color = theme.text.disabled }}
                      >
                        <span style={{ opacity: 0.6 }}>
                          <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1 1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1 1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1 1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>
                        </span>
                        {e.name}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>

          {/* Version */}
          <div style={{ padding: '0 16px', fontSize: fonts.secondarySize, color: theme.text.disabled }}>
            v{__VERSION__}
          </div>
        </div>

        {/* Right content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Section header */}
          <div style={{ padding: '28px 28px 0' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: theme.text.primary, marginBottom: 4 }}>{active.label}</div>
            <div style={{ fontSize: fonts.size, color: theme.text.disabled }}>{active.description}</div>
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

// Simplified: only 3 font tokens now

function buildDisplayJson(settings: AppSettings): string {
  return JSON.stringify({
    appearance: settings.appearance,
    themeId: settings.themeId,
    fonts: {
      primary: settings.fonts.primary,
      secondary: settings.fonts.secondary,
      mono: settings.fonts.mono,
    },
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

    const topLevel = new Set(['appearance', 'themeId', 'fonts'])
    const invalidTopLevel = Object.keys(parsed).filter(key => !topLevel.has(key))
    if (invalidTopLevel.length > 0) {
      return { ok: false, error: `Unknown key${invalidTopLevel.length > 1 ? 's' : ''}: ${invalidTopLevel.join(', ')}` }
    }

    const config = parsed as Record<string, unknown>
    if (config.appearance !== undefined) {
      if (config.appearance !== 'dark' && config.appearance !== 'light' && config.appearance !== 'system') {
        return { ok: false, error: 'appearance must be "dark", "light", or "system"' }
      }
    }
    if (config.themeId !== undefined && typeof config.themeId !== 'string') {
      return { ok: false, error: 'themeId must be a string' }
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
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', minWidth: 0 }}
      />
      <span style={{ width: 32, textAlign: 'right', fontSize: 10, color: theme.text.secondary, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
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
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(120px, 130px) 1fr',
      gap: 12,
      alignItems: 'start',
      padding: '10px 12px',
      background: theme.surface.panelMuted,
      border: `1px solid ${theme.border.subtle}`,
      borderRadius: 10,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{description}</div>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <FontSelect value={token.family} onChange={family => onChange({ ...token, family })} fonts={fontOptions} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          <SliderField value={token.size} min={8} max={32} step={1} onChange={size => onChange({ ...token, size })} format={value => `${value}px`} />
          <SliderField value={token.weight ?? 400} min={100} max={900} step={100} onChange={weight => onChange({ ...token, weight })} />
          <SliderField value={token.lineHeight} min={1} max={2.2} step={0.05} onChange={lineHeight => onChange({ ...token, lineHeight })} format={value => value.toFixed(2)} />
        </div>
      </div>
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
}): React.JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
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

  const updateFont = useCallback((key: 'primary' | 'secondary' | 'mono', next: FontToken) => {
    onApply({
      fonts: { ...settings.fonts, [key]: next },
    } as Partial<AppSettings>)
  }, [onApply, settings.fonts])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.border.default}`, paddingBottom: 8 }}>
        {[
          { id: 'display' as const, label: 'Display', icon: <FormInput size={14} /> },
          { id: 'json' as const, label: 'JSON', icon: <Code2 size={14} /> },
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
                border: `1px solid ${isActive ? theme.border.strong : 'transparent'}`,
                background: isActive ? theme.surface.panelElevated : 'transparent',
                color: isActive ? theme.accent.base : theme.text.muted,
                cursor: 'pointer',
                fontSize: fonts.secondarySize,
                fontWeight: isActive ? 700 : 500,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
                transition: 'color 0.15s, background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  e.currentTarget.style.background = theme.surface.hover
                  e.currentTarget.style.color = theme.text.secondary
                  e.currentTarget.style.borderColor = theme.border.default
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = theme.text.muted
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
          <SectionLabel label="Fonts" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CompactFontRow label="Primary" description="Main UI text, headings, chat messages" token={settings.fonts.primary} fontOptions={SANS_FONTS} onChange={next => updateFont('primary', next)} />
            <CompactFontRow label="Secondary" description="Metadata, subtitles, labels, smaller text" token={settings.fonts.secondary} fontOptions={SANS_FONTS} onChange={next => updateFont('secondary', next)} />
            <CompactFontRow label="Monospace" description="Terminal, code editor, data display" token={settings.fonts.mono} fontOptions={MONO_FONTS} onChange={next => updateFont('mono', next)} />
          </div>

          <SectionLabel label="Updates" />
          <SettingRow label="Current version" description="Installed desktop build version">
            <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>{updateState.result?.currentVersion ?? __VERSION__}</span>
          </SettingRow>
          <SettingRow label="Check for updates" description="Look for a newer GitHub release and show install actions here">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={onCheckForUpdates}
                disabled={updateState.checking}
                style={{
                  padding: '7px 12px',
                  fontSize: fonts.secondarySize,
                  background: updateState.checking ? theme.surface.panelMuted : theme.surface.panelElevated,
                  color: updateState.checking ? theme.text.disabled : theme.text.secondary,
                  border: `1px solid ${theme.border.default}`,
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
                    fontSize: fonts.secondarySize,
                    background: updateState.downloading ? theme.surface.panelMuted : theme.surface.panelElevated,
                    color: updateState.downloading ? theme.text.disabled : theme.status.warning,
                    border: `1px solid ${theme.border.default}`,
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
                    fontSize: fonts.secondarySize,
                    background: theme.surface.panelElevated,
                    color: theme.status.success,
                    border: `1px solid ${theme.border.default}`,
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
            <div style={{ marginBottom: 8, padding: '12px 16px', background: theme.surface.panel, borderRadius: 10, border: `1px solid ${theme.border.default}` }}>
              <div style={{ fontSize: fonts.secondarySize, color: updateState.result.ok ? '#777' : '#c77' }}>
                {updateState.result.updateAvailable
                  ? `Update available${updateState.result.updateInfo?.version ? `: ${updateState.result.updateInfo.version}` : ''}`
                  : updateState.result.status === 'up-to-date'
                    ? 'You are up to date.'
                    : updateState.result.status}
              </div>
              {updateState.result.updateInfo?.releaseDate && (
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, marginTop: 4 }}>
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
            <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono }}>{configPath || 'settings.json'}</span>
            <span style={{ fontSize: 9, color: '#388bfd', fontFamily: fonts.mono }}>settings.display</span>
            {jsonError && (
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: '#ff7b72', fontSize: fonts.secondarySize }}>
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
              background: theme.surface.panelMuted, color: jsonError ? '#ff9080' : '#c9d1d9',
              border: `1px solid ${jsonError ? '#ff7b7244' : theme.surface.panelMuted}`,
              outline: 'none', resize: 'vertical',
              fontFamily: fonts.mono, fontSize: fonts.secondarySize, lineHeight: 1.6,
              tabSize: 2, boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, lineHeight: 1.6 }}>
            Edit the display settings as JSON. Valid top-level keys: <span style={{ fontFamily: fonts.mono }}>appearance</span>, <span style={{ fontFamily: fonts.mono }}>themeId</span>, <span style={{ fontFamily: fonts.mono }}>fonts</span> (with <span style={{ fontFamily: fonts.mono }}>primary</span>, <span style={{ fontFamily: fonts.mono }}>secondary</span>, <span style={{ fontFamily: fonts.mono }}>mono</span>). The form and JSON stay in sync when the JSON is valid.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Font Token JSON Editor ─────────────────────────────────────────────────

export function FontTokenEditor({ settings, onSettingsChange }: {
  settings: AppSettings
  onSettingsChange: (s: AppSettings) => void
}): React.JSX.Element {
  const [rawJson, setRawJson] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const fonts = useAppFonts()
  const theme = useTheme()
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

  const insertToken = useCallback((key: 'primary' | 'secondary' | 'mono') => {
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
    return <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, padding: 20 }}>Loading config...</div>
  }

  const monoFont = fonts.mono

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Config file path */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileJson size={13} color="#555" />
        <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: monoFont }}>{configPath}</span>
        <span style={{ fontSize: 9, color: '#388bfd', fontFamily: monoFont }}>settings.fonts</span>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #1a1a1a' }}>
        {(['editor', 'reference'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '6px 14px', fontSize: fonts.secondarySize, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: view === v ? theme.surface.panelMuted : 'transparent',
            color: view === v ? theme.text.primary : '#555',
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
                background: error ? theme.surface.panelMuted : saved ? theme.surface.panelElevated : theme.accent.base,
                color: error ? '#444' : saved ? theme.status.success : '#fff',
                border: 'none', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4,
              }}>
              {saved ? <><Check size={10} /> Saved</> : 'Save'}
            </button>
            <button onClick={handleReset}
              style={{ padding: '4px 10px', borderRadius: 5, fontSize: 10, cursor: 'pointer', background: theme.surface.panelMuted, color: theme.text.secondary, border: 'none', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
              title="Reset to defaults (remove all overrides)">
              <RotateCcw size={9} /> Reset
            </button>
            <button onClick={handleCopyDefaults}
              style={{ padding: '4px 10px', borderRadius: 5, fontSize: 10, cursor: 'pointer', background: theme.surface.panelMuted, color: theme.text.secondary, border: 'none', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
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
              background: theme.surface.panelMuted, color: error ? '#ff9080' : '#c9d1d9',
              border: `1px solid ${error ? '#ff7b7244' : theme.surface.panelMuted}`,
              outline: 'none', resize: 'vertical',
              fontFamily: monoFont, fontSize: fonts.secondarySize, lineHeight: 1.6,
              tabSize: 2, boxSizing: 'border-box',
            }}
          />

          {/* Hint */}
          <div style={{ fontSize: 10, color: theme.text.disabled, lineHeight: 1.6 }}>
            Override only the tokens you want. Properties: <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>family</span>, <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>size</span>, <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>lineHeight</span>, <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>weight</span>, <span style={{ color: theme.text.disabled, fontFamily: monoFont }}>letterSpacing</span>.
            Unset tokens inherit from General. <span style={{ color: theme.text.disabled }}>Cmd+S</span> to save.
          </div>
        </>
      ) : (
        /* Token reference */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 360, overflowY: 'auto' }}>
          {(['primary', 'secondary', 'mono'] as const).map(key => {
            const token = settings.fonts?.[key] ?? DEFAULT_FONTS[key]
            const desc = key === 'primary' ? 'Main UI text' : key === 'secondary' ? 'Metadata & labels' : 'Terminal & code'
            return (
              <div key={key}
                onClick={() => insertToken(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                  background: theme.surface.panelMuted,
                  border: '1px solid #151515',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = theme.surface.hover}
                onMouseLeave={e => e.currentTarget.style.background = theme.surface.panelMuted}
                title={`Click to add "${key}" to editor`}
              >
                <span style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, fontFamily: monoFont, width: 100, flexShrink: 0 }}>{key}</span>
                <span style={{ fontSize: 10, color: theme.text.disabled, flex: 1 }}>{desc}</span>
                <span style={{ fontSize: 9, color: theme.text.muted, fontFamily: monoFont, flexShrink: 0 }}>{token.size}px</span>
                <span style={{ fontSize: Math.min(token.size, 14), color: theme.text.secondary, fontFamily: token.family, fontWeight: token.weight, flexShrink: 0 }} title={token.family}>Abc</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
