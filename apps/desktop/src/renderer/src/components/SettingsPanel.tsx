import React, { useEffect, useState, useCallback, useRef, lazy } from 'react'
import type { AppSettings, AutoDreamSettings, ExecutionHostRecord, GenerationProviderSettings, Workspace } from '../../../shared/types'
import { withDefaultSettings } from '../../../shared/types'
import { Settings, Type, Monitor, Puzzle, Star, Wrench, Users, FileText, Globe, Shield, KeyRound, Mic } from 'lucide-react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { DEFAULT_THEME_ID, getThemeCanvasDefaults, getThemeById, type AppearanceMode } from '../theme'
import { ChromeSyncSection } from './settings/ChromeSyncSection'
import { VoiceSettingsEditor } from './settings/VoiceSettingsEditor'
import { ColorSwatch, NumInput, RangeInput, SectionLabel, SettingRow, Toggle } from './settings/controls'
import { DaemonSection, type DaemonStatus, type ExecutionResolution } from './settings/DaemonSection'
import { ProvidersSection, type ProviderValidationResult } from './settings/ProvidersSection'
import { McpSection, type MCPConfig, type MCPServerEntry } from './settings/McpSection'
import { ExtensionsSection, type ExtensionListEntry } from './settings/ExtensionsSection'
import { PermissionsSection, type PermissionListResult } from './settings/PermissionsSection'
import { GeneralSection } from './settings/GeneralSection'


const LazyPromptsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.PromptsSection })))
const LazySkillsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.SkillsSection })))

const LazyAgentsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.AgentsSection })))

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

type BuiltinSection = 'general' | 'daemon' | 'canvas' | 'providers' | 'voice' | 'browser' | 'permissions' | 'mcp' | 'extensions' | 'prompts' | 'skills' | 'tools' | 'agents'
type Section = BuiltinSection | `ext:${string}`

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; description: string; group?: string }[] = [
  // App settings
  { id: 'general',    label: 'General',    icon: <Type size={15} />,       description: 'Display settings — fonts, weights, sizes, line heights, and raw JSON', group: 'app' },
  { id: 'daemon',     label: 'Daemon',     icon: <Settings size={15} />,   description: 'Daemon status, restart controls, execution routing, and remote hosts', group: 'app' },
  { id: 'canvas',     label: 'Canvas',     icon: <Monitor size={15} />,    description: 'Background, grid and snap settings', group: 'app' },
  { id: 'providers',  label: 'Providers',  icon: <KeyRound size={15} />,   description: 'Image and video generation providers, keys, and default models', group: 'app' },
  { id: 'voice',      label: 'Voice',      icon: <Mic size={15} />,        description: 'Speech-to-text, text-to-speech, auto-speak, and provider API keys', group: 'app' },


  { id: 'browser',    label: 'Browser',    icon: <Globe size={15} />,      description: 'Chrome data sync — cookies, bookmarks, history', group: 'app' },
  { id: 'permissions', label: 'Permissions', icon: <Shield size={15} />,   description: 'Tool approval memory, scoped grants, and reset controls', group: 'app' },
  // Customisation
  { id: 'prompts',    label: 'Prompts',    icon: <FileText size={15} />,   description: 'Prompt templates with variables and fields', group: 'customise' },
  { id: 'skills',     label: 'Skills',     icon: <Star size={15} />,       description: 'Custom skills and skill registry', group: 'customise' },
  { id: 'tools',      label: 'Tools',      icon: <Wrench size={15} />,     description: 'MCP servers, tools, integrations and registry', group: 'customise' },
  { id: 'agents',     label: 'Personas',   icon: <Users size={15} />,      description: 'Personas with system prompts and tool access', group: 'customise' },
  // System
  { id: 'extensions', label: 'Plugins', icon: <Puzzle size={15} />,     description: 'Installed plugins', group: 'system' },
]

// ─── MCP types ────────────────────────────────────────────────────────────────
// MCPServerEntry + MCPConfig now live in ./settings/McpSection (the extracted
// section owns them); re-imported above.

// PermissionListResult now lives in ./settings/PermissionsSection (re-imported above).

// ProviderModelOption + ProviderValidationResult now live in
// ./settings/ProvidersSection (the extracted section owns them).

// ExtensionListEntry now lives in ./settings/ExtensionsSection (re-imported above).

const EXTENSIONS_CHANGED_EVENT = 'codesurf:extensions-changed'

function notifyExtensionsChanged(): void {
  window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED_EVENT))
}

// ─── Extension settings panel ─────────────────────────────────────────────────
function ExtSettingsPanel({ extId, tileType }: { extId: string; tileType: string }): React.JSX.Element {
  const theme = useTheme()
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

// ─── Chrome Sync section ──────────────────────────────────────────────────────



// DaemonStatus + ExecutionResolution now live in ./settings/DaemonSection
// (the extracted section owns them); re-imported above.

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
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null)
  const [daemonLoading, setDaemonLoading] = useState(false)
  const [daemonRestarting, setDaemonRestarting] = useState(false)
  const [daemonError, setDaemonError] = useState<string | null>(null)
  const [executionHosts, setExecutionHosts] = useState<ExecutionHostRecord[]>([])
  const [executionHostsLoading, setExecutionHostsLoading] = useState(false)
  const [executionHostsError, setExecutionHostsError] = useState<string | null>(null)
  const [executionResolution, setExecutionResolution] = useState<ExecutionResolution | null>(null)
  const [newHostLabel, setNewHostLabel] = useState('')
  const [newHostUrl, setNewHostUrl] = useState('')
  const [newHostToken, setNewHostToken] = useState('')
  const [permissionData, setPermissionData] = useState<PermissionListResult | null>(null)
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [permissionsError, setPermissionsError] = useState<string | null>(null)
  const [visibleProviderKeys, setVisibleProviderKeys] = useState<Record<string, boolean>>({})
  const [providerValidation, setProviderValidation] = useState<Record<string, ProviderValidationResult | { loading: true }>>({})

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

  const loadDaemonStatus = useCallback(async () => {
    setDaemonLoading(true)
    setDaemonError(null)
    try {
      const next = await window.electron?.system?.daemonStatus?.()
      setDaemonStatus(next ?? { running: false, info: null })
    } catch (e) {
      setDaemonError(e instanceof Error ? e.message : String(e))
      setDaemonStatus(null)
    } finally {
      setDaemonLoading(false)
    }
  }, [])

  const loadExecutionHosts = useCallback(async () => {
    setExecutionHostsLoading(true)
    setExecutionHostsError(null)
    try {
      const next = await window.electron.execution.listHosts()
      setExecutionHosts(next)
    } catch (e) {
      setExecutionHostsError(e instanceof Error ? e.message : String(e))
      setExecutionHosts([])
    } finally {
      setExecutionHostsLoading(false)
    }
  }, [])

  const resolveExecutionPreference = useCallback(async (nextSettings: AppSettings) => {
    try {
      const resolution = await window.electron.execution.resolveTarget(nextSettings.execution)
      setExecutionResolution(resolution)
    } catch {
      setExecutionResolution(null)
    }
  }, [])

  const loadPermissions = useCallback(async () => {
    setPermissionsLoading(true)
    setPermissionsError(null)
    try {
      const next = await window.electron.permissions.list()
      setPermissionData(next)
    } catch (e) {
      setPermissionsError(e instanceof Error ? e.message : String(e))
      setPermissionData(null)
    } finally {
      setPermissionsLoading(false)
    }
  }, [])

  const clearPermissionGrantById = useCallback(async (id: string) => {
    try {
      const next = await window.electron.permissions.clear(id)
      setPermissionData(next)
      setPermissionsError(null)
    } catch (e) {
      setPermissionsError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const clearAllPermissionGrants = useCallback(async () => {
    try {
      const next = await window.electron.permissions.clearAll()
      setPermissionData(next)
      setPermissionsError(null)
    } catch (e) {
      setPermissionsError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const handleRestartDaemon = useCallback(async () => {
    setDaemonRestarting(true)
    setDaemonError(null)
    try {
      const next = await window.electron?.system?.restartDaemon?.()
      setDaemonStatus(next ?? { running: false, info: null })
    } catch (e) {
      setDaemonError(e instanceof Error ? e.message : String(e))
    } finally {
      setDaemonRestarting(false)
    }
  }, [])

  useEffect(() => {
    if (section !== 'daemon') return
    let cancelled = false

    const refresh = async () => {
      try {
        const next = await window.electron?.system?.daemonStatus?.()
        if (!cancelled) {
          setDaemonStatus(next ?? { running: false, info: null })
          setDaemonError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setDaemonError(e instanceof Error ? e.message : String(e))
          setDaemonStatus(null)
        }
      } finally {
        if (!cancelled) setDaemonLoading(false)
      }
    }

    setDaemonLoading(true)
    void refresh()
    const interval = window.setInterval(() => {
      void refresh()
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [section])

  useEffect(() => {
    if (section !== 'permissions') return
    void loadPermissions()
  }, [section, loadPermissions])

  useEffect(() => {
    if (section !== 'daemon') return
    void loadExecutionHosts()
  }, [section, loadExecutionHosts])

  useEffect(() => {
    if (section !== 'daemon') return
    void resolveExecutionPreference(settings)
  }, [section, settings, resolveExecutionPreference])

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
    // Don't pass built-in codesurf MCP through saveServers — it's preserved server-side
    const { codesurf: _, contex: __, ...rest } = servers
    saveMcpServers(rest)
  }, [mcpConfig, saveMcpServers])

  const removeServer = useCallback((name: string) => {
    if (!mcpConfig) return
    const { codesurf: _cs, contex: _cx, [name]: __, ...rest } = mcpConfig.mcpServers
    saveMcpServers(rest)
  }, [mcpConfig, saveMcpServers])

  const addServer = useCallback(() => {
    if (!newServer.name.trim() || !mcpConfig) return
    const { codesurf: _cs, contex: _cx, ...rest } = mcpConfig.mcpServers
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

  const updateAutoDreamPatch = useCallback((patch: Partial<AutoDreamSettings>) => {
    updateSettingsPatch({
      autoDream: {
        ...settingsRef.current.autoDream,
        ...patch,
      },
    })
  }, [updateSettingsPatch])

  const updateGenerationProvider = useCallback((providerId: string, patch: Partial<GenerationProviderSettings>) => {
    const current = settingsRef.current.generationProviders?.[providerId]
    if (!current) return
    updateSettingsPatch({
      generationProviders: {
        ...settingsRef.current.generationProviders,
        [providerId]: {
          ...current,
          ...patch,
          id: providerId,
        },
      },
    })
  }, [updateSettingsPatch])

  const validateProvider = useCallback(async (provider: GenerationProviderSettings) => {
    setProviderValidation(prev => ({ ...prev, [provider.id]: { loading: true } }))
    try {
      const result = await window.electron.settings.validateGenerationProvider(provider.id, provider)
      setProviderValidation(prev => ({ ...prev, [provider.id]: result }))
    } catch (err) {
      setProviderValidation(prev => ({
        ...prev,
        [provider.id]: {
          ok: false,
          providerId: provider.id,
          message: err instanceof Error ? err.message : String(err),
          models: [],
          textModels: [],
          imageModels: [],
          videoModels: [],
        },
      }))
    }
  }, [])

  const saveExecutionHost = useCallback(async (host: ExecutionHostRecord) => {
    setExecutionHostsError(null)
    try {
      const next = await window.electron.execution.upsertHost(host)
      setExecutionHosts(next)
    } catch (e) {
      setExecutionHostsError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const removeExecutionHost = useCallback(async (hostId: string) => {
    setExecutionHostsError(null)
    try {
      const result = await window.electron.execution.deleteHost(hostId)
      setExecutionHosts(result.hosts)
      if (settings.execution.hostId === hostId) {
        updateSettingsPatch({ execution: { ...settings.execution, hostId: null, mode: 'auto' } })
      }
    } catch (e) {
      setExecutionHostsError(e instanceof Error ? e.message : String(e))
    }
  }, [settings.execution, updateSettingsPatch])

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
    const currentThemeId = settingsRef.current.themeId
    const currentTheme = getThemeById(currentThemeId)
    const shouldUseLightTheme = mode === 'light' || (mode === 'system' && !systemPrefersDark)
    const nextThemeId = shouldUseLightTheme
      ? (currentTheme.mode === 'light' ? currentThemeId : 'paper-light')
      : (currentTheme.mode === 'dark' ? currentThemeId : DEFAULT_THEME_ID)
    const canvas = getThemeCanvasDefaults(nextThemeId)
    updateSettingsPatch({
      appearance: mode,
      themeId: nextThemeId,
      canvasBackground: canvas.background,
      gridColorSmall: canvas.gridSmall,
      gridColorLarge: canvas.gridLarge,
    })
  }, [systemPrefersDark, updateSettingsPatch])

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
      case 'general':
        return (
          <GeneralSection
            settings={settings}
            updateSettingsPatch={updateSettingsPatch}
            applyAppearanceMode={applyAppearanceMode}
            applyThemePreset={applyThemePreset}
            systemPrefersDark={systemPrefersDark}
            updateState={updateState}
            checkForUpdates={checkForUpdates}
            downloadUpdate={downloadUpdate}
            onClose={onClose}
          />
        )
      case 'daemon':
        return (
          <DaemonSection
            settings={settings}
            daemonStatus={daemonStatus}
            daemonLoading={daemonLoading}
            daemonRestarting={daemonRestarting}
            daemonError={daemonError}
            loadDaemonStatus={loadDaemonStatus}
            handleRestartDaemon={handleRestartDaemon}
            updateAutoDreamPatch={updateAutoDreamPatch}
            updateSettingsPatch={updateSettingsPatch}
            executionHosts={executionHosts}
            executionHostsLoading={executionHostsLoading}
            executionHostsError={executionHostsError}
            executionResolution={executionResolution}
            saveExecutionHost={saveExecutionHost}
            removeExecutionHost={removeExecutionHost}
            newHostLabel={newHostLabel}
            newHostUrl={newHostUrl}
            newHostToken={newHostToken}
            setNewHostLabel={setNewHostLabel}
            setNewHostUrl={setNewHostUrl}
            setNewHostToken={setNewHostToken}
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

      case 'permissions':
        return (
          <PermissionsSection
            settings={settings}
            updateSettingsPatch={updateSettingsPatch}
            permissionData={permissionData}
            permissionsLoading={permissionsLoading}
            permissionsError={permissionsError}
            loadPermissions={loadPermissions}
            clearPermissionGrantById={clearPermissionGrantById}
            clearAllPermissionGrants={clearAllPermissionGrants}
          />
        )
      case 'providers':
        return (
          <ProvidersSection
            settings={settings}
            updateGenerationProvider={updateGenerationProvider}
            updateSettingsPatch={updateSettingsPatch}
            visibleProviderKeys={visibleProviderKeys}
            setVisibleProviderKeys={setVisibleProviderKeys}
            providerValidation={providerValidation}
            validateProvider={validateProvider}
          />
        )



      case 'voice':
        return (
          <>
            <SectionLabel label="Voice — STT, TTS, spokify, API keys" />
            <VoiceSettingsEditor
              settings={settings}
              onChange={(next) => updateSettingsPatch({ voice: next.voice })}
            />
          </>
        )

      case 'browser':
        return (
          <>
            <SectionLabel label="Links" />
            <SettingRow label="Open links in" description="Choose whether rendered links open in a browser block on the canvas or in your default external browser.">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {([
                  { id: 'browser-block', label: 'Browser block' },
                  { id: 'external-browser', label: 'External browser' },
                ] as const).map(option => {
                  const active = (settings.linkOpenMode ?? 'browser-block') === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => update('linkOpenMode', option.id)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 8,
                        fontSize: fonts.secondarySize,
                        fontWeight: 600,
                        border: `1px solid ${active ? theme.accent.base : theme.border.default}`,
                        background: active ? theme.accent.soft : theme.surface.input,
                        color: active ? theme.accent.hover : theme.text.secondary,
                        cursor: 'pointer',
                      }}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </SettingRow>
            <ChromeSyncSection settings={settings} onUpdate={update} />
          </>
        )

      case 'tools':
      case 'mcp':
        return (
          <McpSection
            mcpConfig={mcpConfig}
            mcpSaved={mcpSaved}
            addingServer={addingServer}
            setAddingServer={setAddingServer}
            newServer={newServer}
            setNewServer={setNewServer}
            expandedServer={expandedServer}
            setExpandedServer={setExpandedServer}
            workspaceServers={workspaceServers}
            activeWorkspaceId={activeWorkspaceId}
            setActiveWorkspaceId={setActiveWorkspaceId}
            updateServer={updateServer}
            removeServer={removeServer}
            addServer={addServer}
            saveWorkspaceServers={saveWorkspaceServers}
            updateWorkspaceServer={updateWorkspaceServer}
            removeWorkspaceServer={removeWorkspaceServer}
            workspaces={workspaces}
            isToolsView={section === 'tools'}
          />
        )

      case 'extensions':
        return (
          <ExtensionsSection
            extensionsList={extensionsList}
            extensionsLoading={extensionsLoading}
            extensionsError={extensionsError}
            expandedExtId={expandedExtId}
            setExpandedExtId={setExpandedExtId}
            extSettingsMap={extSettingsMap}
            setExtSettingsMap={setExtSettingsMap}
            toggleExtensionEnabled={toggleExtensionEnabled}
            refreshExtensions={refreshExtensions}
            settings={settings}
            updateSettingsPatch={updateSettingsPatch}
            workspaces={workspaces}
          />
        )

      case 'prompts':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazyPromptsSection workspacePath={workspacePath} hideHeaderText />
          </React.Suspense>
        ) : <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Open a workspace first</div>

      case 'skills':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazySkillsSection workspacePath={workspacePath} hideHeaderText />
          </React.Suspense>
        ) : <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Open a workspace first</div>

      case 'agents':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazyAgentsSection workspacePath={workspacePath} hideHeaderText />
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
          return <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Plugin has no block.</div>
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
        borderRadius: 14,
        border: '1px solid transparent',
        boxShadow: theme.shadow.modal,
        padding: 1,
        overflow: 'visible',
      }}>
        <div style={{
          width: '100%', height: '100%',
          background: theme.surface.panel, borderRadius: 13,
          display: 'flex', overflow: 'hidden',
          fontFamily: fonts.primary, fontSize: fonts.size,
        }}>

        {/* Left nav */}
        <div style={{
          width: 200, background: theme.surface.panelElevated,
          borderRight: '1px solid transparent',
          boxShadow: theme.mode === 'light'
            ? 'inset -1px 0 0 rgba(255,255,255,0.82)'
            : 'inset -1px 0 0 rgba(255,255,255,0.28)',
          display: 'flex', flexDirection: 'column',
          padding: '20px 0',
          flexShrink: 0
        }}>

          {/* Settings header */}
          <div style={{ padding: '8px 16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Settings size={18} color={theme.text.primary} />
            <span style={{ fontSize: 17, fontWeight: 700, color: theme.text.primary }}>Settings</span>
          </div>

          {/* Nav items — grouped */}
          <div className="cs-fade-scroll-y" style={{ flex: 1, overflowY: 'auto' }}>
            {(['app', 'customise', 'system'] as const).map(group => {
              const groupSections = SECTIONS
                .filter(s => s.group === group)
              const groupLabel = group === 'app' ? 'App' : group === 'customise' ? 'Customise' : 'System'
              return (
                <div key={group}>
                  <div style={{ padding: '14px 16px 4px', fontSize: 9, fontWeight: 700, color: theme.text.muted, letterSpacing: 1.2, textTransform: 'uppercase', userSelect: 'none' }}>{groupLabel}</div>
                  {groupSections.map(s => (
                    <div
                      key={s.id}
                      onClick={() => setSection(s.id as Section)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 16px', cursor: 'pointer',
                        color: section === s.id ? theme.text.primary : theme.text.secondary,
                        background: section === s.id ? theme.surface.selection : 'transparent',
                        fontSize: fonts.size, userSelect: 'none',
                        transition: 'color 0.1s'
                      }}
                      onMouseEnter={e => { if (section !== s.id) e.currentTarget.style.color = theme.text.primary }}
                      onMouseLeave={e => { if (section !== s.id) e.currentTarget.style.color = theme.text.secondary }}
                    >
                      <span style={{ opacity: section === s.id ? 1 : 0.8 }}>{s.icon}</span>
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
                  <div style={{ padding: '14px 16px 4px', fontSize: 9, fontWeight: 700, color: theme.text.muted, letterSpacing: 1.2, textTransform: 'uppercase', userSelect: 'none' }}>Plugins</div>
                  {panelExts.map(e => {
                    const sid = `ext:${e.id}` as Section
                    return (
                      <div
                        key={e.id}
                        onClick={() => setSection(sid)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 16px', cursor: 'pointer',
                          color: section === sid ? theme.text.primary : theme.text.secondary,
                          background: section === sid ? theme.surface.selection : 'transparent',
                          fontSize: fonts.size, userSelect: 'none', transition: 'color 0.1s',
                        }}
                        onMouseEnter={e2 => { if (section !== sid) e2.currentTarget.style.color = theme.text.primary }}
                        onMouseLeave={e2 => { if (section !== sid) e2.currentTarget.style.color = theme.text.secondary }}
                      >
                        <span style={{ opacity: 0.85 }}>
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
            <div style={{ fontSize: fonts.size, color: theme.text.muted }}>{active.description}</div>
          </div>

          {/* Content */}
          <div className="cs-fade-scroll-y cs-fade-scroll-y-lg" style={{ flex: 1, overflowY: 'auto', scrollbarGutter: 'stable', padding: '4px 28px 34px' }}>
            {renderContent()}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

export { FontTokenEditor } from './settings/FontTokenEditor'
