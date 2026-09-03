import React, { useState, useEffect, useRef, useCallback, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { Bot } from 'lucide-react'
import type { AppSettings, ExtensionChatTransportConfig } from '../../../shared/types'
import {
  type BuiltinProvider,
  type ModelOption,
  type ModeOption,
  type ThinkingOption,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_ID,
  PROVIDER_MODES,
  EXTENSION_PROVIDER_MODE,
  THINKING_OPTIONS,
  PROVIDER_LABELS,
  resolveProviderModeId,
} from '../config/providers'
import { ClaudeIcon, CodexIcon, HermesIcon, OpenClawIcon, PiIcon } from '../components/icons/providerIcons'
import { getExtensionProviderIcon } from '../components/chat/ChatTileViews'
import { normalizeExtensionProviders, type DiscoveryPeer } from '../components/chat/chatTileUtils'
import { TOOLBAR_PILL_ICON_SIZE } from '../components/chat/chatTileLayout'

export interface ProviderEntry {
  id: string
  label: string
  description?: string
  noun: 'model' | 'agent'
  icon: React.ReactNode
  models: ModelOption[]
  kind: 'builtin' | 'extension'
  transport?: ExtensionChatTransportConfig | null
}

const PROVIDER_ICON: Record<BuiltinProvider, React.ReactNode> = {
  claude: React.createElement(ClaudeIcon, { size: TOOLBAR_PILL_ICON_SIZE }),
  codex: React.createElement(CodexIcon, { size: TOOLBAR_PILL_ICON_SIZE }),
  opencode: React.createElement(Bot, { size: TOOLBAR_PILL_ICON_SIZE }),
  openclaw: React.createElement(OpenClawIcon, { size: TOOLBAR_PILL_ICON_SIZE }),
  hermes: React.createElement(HermesIcon, { size: TOOLBAR_PILL_ICON_SIZE }),
  omnigent: React.createElement(Bot, { size: TOOLBAR_PILL_ICON_SIZE }),
  csagent: React.createElement(PiIcon, { size: TOOLBAR_PILL_ICON_SIZE }),
  gateway: React.createElement(Bot, { size: TOOLBAR_PILL_ICON_SIZE }),
}

export interface UseChatTileProvidersOptions {
  provider: string
  setProvider: Dispatch<SetStateAction<string>>
  model: string
  setModel: Dispatch<SetStateAction<string>>
  mode: string
  setMode: Dispatch<SetStateAction<string>>
  thinking: string
  setThinking: Dispatch<SetStateAction<string>>
  settings?: AppSettings
  connectedPeers: DiscoveryPeer[]
  peerContextRef: MutableRefObject<Map<string, Record<string, unknown>>>
  peerContextVersion: number
  onProviderChanged?: () => void
  swapProviderSession?: (fromProvider: string, toProvider: string) => void
}

export interface UseChatTileProvidersResult {
  providerEntries: ProviderEntry[]
  providerEntryById: Map<string, ProviderEntry>
  currentProviderEntry: ProviderEntry | undefined
  modeOptions: ModeOption[]
  currentMode: ModeOption
  optionNoun: 'model' | 'agent'
  currentModel: ModelOption
  thinkingOptions: ThinkingOption[]
  handleProviderChange: (providerId: string) => void
}

export function useChatTileProviders({
  provider,
  setProvider,
  model,
  setModel,
  mode,
  setMode,
  settings,
  connectedPeers,
  peerContextRef,
  peerContextVersion,
  onProviderChanged,
  swapProviderSession,
}: UseChatTileProvidersOptions): UseChatTileProvidersResult {
  const [opencodeModels, setOpencodeModels] = useState<ModelOption[]>(DEFAULT_MODELS.opencode)
  const [openclawAgents, setOpenclawAgents] = useState<ModelOption[]>(DEFAULT_MODELS.openclaw)
  const [csagentModels, setCsagentModels] = useState<ModelOption[]>(DEFAULT_MODELS.csagent)
  const [gatewayModels, setGatewayModels] = useState<ModelOption[]>(DEFAULT_MODELS.gateway)
  const requestedProviderOptionsRef = useRef<{ opencode: boolean; openclaw: boolean; csagent: boolean; gateway: boolean }>({
    opencode: false,
    openclaw: false,
    csagent: false,
    gateway: false,
  })

  useEffect(() => {
    if (provider !== 'opencode') return

    const unsubscribeOpencode = window.electron?.chat?.onOpencodeModelsUpdated?.((payload: any) => {
      if (payload?.models?.length) setOpencodeModels(payload.models)
    })

    return () => { unsubscribeOpencode?.() }
  }, [provider])

  // The gateway catalog is fetched once per provider switch, so a key saved in
  // Settings AFTER this tile opened would otherwise never be reflected — the
  // picker would keep showing the hardcoded fallback list. Main re-fetches and
  // broadcasts on key change; clear the once-only guard so a later provider
  // switch can retry too.
  useEffect(() => {
    if (provider !== 'gateway') return

    const unsubscribeGateway = window.electron?.chat?.onGatewayModelsUpdated?.((payload: any) => {
      if (payload?.models?.length) {
        setGatewayModels(payload.models)
        requestedProviderOptionsRef.current.gateway = true
      } else {
        setGatewayModels(DEFAULT_MODELS.gateway)
        requestedProviderOptionsRef.current.gateway = false
      }
    })

    return () => { unsubscribeGateway?.() }
  }, [provider])

  useEffect(() => {
    if (provider === 'opencode' && !requestedProviderOptionsRef.current.opencode) {
      requestedProviderOptionsRef.current.opencode = true
      window.electron?.chat?.opencodeModels?.().then((result: any) => {
        if (result?.models?.length) setOpencodeModels(result.models)
      }).catch(() => {
        requestedProviderOptionsRef.current.opencode = false
      })
    }

    if (provider === 'openclaw' && !requestedProviderOptionsRef.current.openclaw) {
      requestedProviderOptionsRef.current.openclaw = true
      window.electron?.chat?.openclawAgents?.().then((result: any) => {
        if (result?.agents?.length) setOpenclawAgents(result.agents)
      }).catch(() => {
        requestedProviderOptionsRef.current.openclaw = false
      })
    }

    if (provider === 'gateway' && !requestedProviderOptionsRef.current.gateway) {
      requestedProviderOptionsRef.current.gateway = true
      window.electron?.chat?.gatewayModels?.().then((result: any) => {
        if (result?.models?.length) setGatewayModels(result.models)
        else requestedProviderOptionsRef.current.gateway = false
      }).catch(() => {
        requestedProviderOptionsRef.current.gateway = false
      })
    }

    if (provider === 'csagent' && !requestedProviderOptionsRef.current.csagent) {
      requestedProviderOptionsRef.current.csagent = true
      window.electron?.chat?.csagentModels?.().then((result: any) => {
        if (Array.isArray(result?.models)) setCsagentModels(result.models)
        else requestedProviderOptionsRef.current.csagent = false
      }).catch(() => {
        requestedProviderOptionsRef.current.csagent = false
      })
    }
  }, [provider])

  const builtinProviderEntries = useMemo<Record<BuiltinProvider, ProviderEntry>>(() => ({
    claude: {
      id: 'claude',
      label: PROVIDER_LABELS.claude,
      noun: 'model',
      icon: PROVIDER_ICON.claude,
      models: DEFAULT_MODELS.claude,
      kind: 'builtin',
    },
    codex: {
      id: 'codex',
      label: PROVIDER_LABELS.codex,
      noun: 'model',
      icon: PROVIDER_ICON.codex,
      models: DEFAULT_MODELS.codex,
      kind: 'builtin',
    },
    opencode: {
      id: 'opencode',
      label: PROVIDER_LABELS.opencode,
      noun: 'model',
      icon: PROVIDER_ICON.opencode,
      models: opencodeModels,
      kind: 'builtin',
    },
    openclaw: {
      id: 'openclaw',
      label: PROVIDER_LABELS.openclaw,
      noun: 'agent',
      icon: PROVIDER_ICON.openclaw,
      models: openclawAgents,
      kind: 'builtin',
    },
    hermes: {
      id: 'hermes',
      label: PROVIDER_LABELS.hermes,
      noun: 'model',
      icon: PROVIDER_ICON.hermes,
      models: DEFAULT_MODELS.hermes,
      kind: 'builtin',
    },
    omnigent: {
      id: 'omnigent',
      label: PROVIDER_LABELS.omnigent,
      noun: 'agent',
      icon: PROVIDER_ICON.omnigent,
      models: DEFAULT_MODELS.omnigent,
      kind: 'builtin',
    },
    csagent: {
      id: 'csagent',
      label: PROVIDER_LABELS.csagent,
      noun: 'model',
      icon: PROVIDER_ICON.csagent,
      models: csagentModels,
      kind: 'builtin',
    },
    gateway: {
      id: 'gateway',
      label: PROVIDER_LABELS.gateway,
      description: 'Vercel AI Gateway — every gateway model, streaming chat + canvas tools',
      noun: 'model',
      icon: PROVIDER_ICON.gateway,
      models: gatewayModels,
      kind: 'builtin',
    },
  }), [opencodeModels, openclawAgents, csagentModels, gatewayModels])

  const extensionProviderEntries = useMemo<ProviderEntry[]>(() => {
    void peerContextVersion
    const entries = new Map<string, ProviderEntry>()

    for (const peer of connectedPeers) {
      const peerContext = peerContextRef.current.get(peer.peerId) ?? {}
      const providers = normalizeExtensionProviders(peerContext['ctx:chat:providers'])
      for (const providerConfig of providers) {
        entries.set(providerConfig.id, {
          id: providerConfig.id,
          label: providerConfig.label,
          description: providerConfig.description,
          noun: providerConfig.noun ?? 'model',
          icon: getExtensionProviderIcon(providerConfig.icon),
          models: providerConfig.models.map(modelOption => ({
            id: modelOption.id,
            label: modelOption.label,
            description: modelOption.description,
          })),
          kind: 'extension',
          transport: providerConfig.transport,
        })
      }
    }

    return Array.from(entries.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [connectedPeers, peerContextRef, peerContextVersion])

  const providerEntries = useMemo<ProviderEntry[]>(() => [
    builtinProviderEntries.claude,
    builtinProviderEntries.codex,
    builtinProviderEntries.opencode,
    builtinProviderEntries.openclaw,
    builtinProviderEntries.hermes,
    builtinProviderEntries.omnigent,
    builtinProviderEntries.csagent,
    builtinProviderEntries.gateway,
    ...extensionProviderEntries,
  ], [builtinProviderEntries, extensionProviderEntries])

  const providerEntryById = useMemo(() => {
    const next = new Map<string, ProviderEntry>()
    for (const entry of providerEntries) next.set(entry.id, entry)
    return next
  }, [providerEntries])

  const currentProviderEntry = providerEntryById.get(provider)
    ?? providerEntryById.get(DEFAULT_PROVIDER_ID)
    ?? providerEntries[0]

  const modeOptions = useMemo<ModeOption[]>(() => {
    if (!currentProviderEntry) return [EXTENSION_PROVIDER_MODE]
    return currentProviderEntry.kind === 'builtin'
      ? PROVIDER_MODES[currentProviderEntry.id as BuiltinProvider]
      : [EXTENSION_PROVIDER_MODE]
  }, [currentProviderEntry])

  const optionNoun = currentProviderEntry?.noun ?? 'model'
  const currentModel = currentProviderEntry?.models.find(m => m.id === model)
    ?? currentProviderEntry?.models[0]
    ?? { id: '', label: optionNoun === 'agent' ? 'No agent' : 'No model' }
  const currentMode = modeOptions.find(item => item.id === mode) ?? modeOptions[0] ?? EXTENSION_PROVIDER_MODE
  const thinkingOptions = THINKING_OPTIONS

  useEffect(() => {
    if (!currentProviderEntry) return
    if (currentProviderEntry.id !== provider) {
      setProvider(currentProviderEntry.id)
      setModel(currentProviderEntry.models[0]?.id ?? '')
      setMode(resolveProviderModeId(currentProviderEntry.id, settings?.chatProviderModes?.[currentProviderEntry.id]))
      return
    }

    const options = currentProviderEntry.models
    if (options.length === 0) return
    if (!options.some(option => option.id === model)) {
      setModel(options[0].id)
    }
  }, [currentProviderEntry, provider, settings?.chatProviderModes, model, setProvider, setModel, setMode])

  useEffect(() => {
    if (!modeOptions.some(option => option.id === mode)) {
      setMode(resolveProviderModeId(provider, settings?.chatProviderModes?.[provider]))
    }
  }, [modeOptions, mode, provider, settings?.chatProviderModes, setMode])

  const handleProviderChange = useCallback((providerId: string) => {
    const nextProvider = providerEntryById.get(providerId)
    if (!nextProvider) return
    if (nextProvider.id !== provider) {
      swapProviderSession?.(provider, nextProvider.id)
    }
    setProvider(nextProvider.id)
    setModel(nextProvider.models[0]?.id ?? '')
    setMode(resolveProviderModeId(nextProvider.id, settings?.chatProviderModes?.[nextProvider.id]))
    onProviderChanged?.()
  }, [provider, providerEntryById, settings?.chatProviderModes, setProvider, setModel, setMode, onProviderChanged, swapProviderSession])

  return {
    providerEntries,
    providerEntryById,
    currentProviderEntry,
    modeOptions,
    currentMode,
    optionNoun,
    currentModel,
    thinkingOptions,
    handleProviderChange,
  }
}
