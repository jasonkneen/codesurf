import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { AppSettings } from '../../../shared/types'
import { basename, getDroppedPaths, isImagePath } from '../utils/dnd'
import {
  Paperclip, ShieldCheck, Mic, Activity, ChevronDown,
  Check, ArrowUp, Square, MessageSquare, Bot,
  Brain, ChevronRight, Clock, DollarSign,
  Trash2
} from 'lucide-react'
import { useMCPServers, type MCPServerEntry } from '../hooks/useMCPServers'

// --- Custom provider SVG icons (matching Paseo) ----------------------------------

function ClaudeIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} fillRule="evenodd">
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  )
}

function CodexIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} fillRule="evenodd">
      <path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z" />
    </svg>
  )
}

// --- MCP Logo (official connected-nodes mark) ------------------------------------
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

// --- Thinking strength icon (brain + signal bars) --------------------------------

const THINKING_LEVELS: Record<string, number> = { none: 0, low: 1, medium: 2, adaptive: 3, high: 4, max: 5 }

function ThinkingIcon({ level }: { level: string }): JSX.Element {
  const bars = THINKING_LEVELS[level] ?? 3
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Brain size={12} />
      <svg width="10" height="12" viewBox="0 0 10 12">
        {[0, 1, 2, 3, 4].map(i => (
          <rect
            key={i}
            x={i * 2}
            y={12 - (i + 1) * 2.2}
            width="1.4"
            height={(i + 1) * 2.2}
            rx="0.4"
            fill="currentColor"
            opacity={i < bars ? 1 : 0.2}
          />
        ))}
      </svg>
    </div>
  )
}

// --- Types -----------------------------------------------------------------------

interface ToolBlock {
  id: string
  name: string
  input: string
  summary?: string
  elapsed?: number
  status: 'running' | 'done' | 'error'
}

interface ThinkingBlock {
  content: string
  done: boolean
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  thinking?: ThinkingBlock
  toolBlocks?: ToolBlock[]
  cost?: number
  turns?: number
}

interface PendingAttachment {
  path: string
  kind: 'image' | 'file'
}

interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  settings?: AppSettings
}

// --- Font defaults (used when no settings are provided) --------------------------

const FONT_SANS = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const FONT_MONO = "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
const FONT_SIZE_DEFAULT = 13
const MONO_SIZE_DEFAULT = 13

// Font context so sub-components can read settings-derived fonts without prop drilling
const FontCtx = React.createContext({ sans: FONT_SANS, mono: FONT_MONO, size: FONT_SIZE_DEFAULT, monoSize: MONO_SIZE_DEFAULT })
function useFonts() { return React.useContext(FontCtx) }

// --- Provider / Model config -----------------------------------------------------

type Provider = 'claude' | 'codex' | 'opencode'

interface ModelOption {
  id: string
  label: string
}

const DEFAULT_MODELS: Record<Provider, ModelOption[]> = {
  claude: [
    { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.1-codex-mini', label: 'Codex Mini' },
    { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'o3', label: 'o3' },
    { id: 'o3-mini', label: 'o3-mini' },
  ],
  opencode: [
    { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'deepseek/deepseek-coder', label: 'DeepSeek Coder' },
  ],
}

// --- Safety mode config (per-provider, matching Paseo) ---------------------------

interface ModeOption { id: string; label: string; description: string; color: string }

const PROVIDER_MODES: Record<Provider, ModeOption[]> = {
  claude: [
    { id: 'bypassPermissions', label: 'Bypass', description: 'Full auto, no approval', color: '#e54d2e' },
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Auto-approve file edits', color: '#ffb432' },
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
  ],
  codex: [
    { id: 'full-access', label: 'Full Access', description: 'Full auto, no approval', color: '#e54d2e' },
    { id: 'auto', label: 'Auto', description: 'Auto-approve safe actions', color: '#ffb432' },
    { id: 'read-only', label: 'Read Only', description: 'No file modifications', color: '#58a6ff' },
  ],
  opencode: [
    { id: 'build', label: 'Build', description: 'Execute and build code', color: '#ffb432' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
  ],
}

// --- Thinking budget config (Claude only) ----------------------------------------

interface ThinkingOption { id: string; label: string; description: string }

const THINKING_OPTIONS: ThinkingOption[] = [
  { id: 'adaptive', label: 'Adaptive', description: 'Model decides when to think' },
  { id: 'none', label: 'Off', description: 'No extended thinking' },
  { id: 'low', label: 'Low', description: '~2K tokens budget' },
  { id: 'medium', label: 'Medium', description: '~8K tokens budget' },
  { id: 'high', label: 'High', description: '~32K tokens budget' },
  { id: 'max', label: 'Max', description: '~128K tokens budget' },
]

const PROVIDER_ICON: Record<Provider, React.ReactNode> = {
  claude: <ClaudeIcon size={12} />,
  codex: <CodexIcon size={12} />,
  opencode: <Bot size={12} />,
}

const PROVIDER_LABELS: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
}

// --- Shimmer keyframes (injected once, lifted from Paseo) ------------------------

const SHIMMER_ID = 'chat-tile-shimmer'
function ensureShimmerStyle(): void {
  if (document.getElementById(SHIMMER_ID)) return
  const style = document.createElement('style')
  style.id = SHIMMER_ID
  style.textContent = `
    @keyframes chat-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes chat-shimmer-text {
      0% { background-position: var(--shimmer-start, -100px) 0; }
      100% { background-position: var(--shimmer-end, 200px) 0; }
    }
    @keyframes chat-dot-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-4px); }
    }
    @keyframes chat-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes chat-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
  `
  document.head.appendChild(style)
}

// --- Shimmer text helper (Paseo technique) ---------------------------------------
// Uses background-clip: text with a sweeping white gradient to create
// a shimmer effect on text labels while loading.

function ShimmerText({ children, style, baseColor = '#888' }: {
  children: React.ReactNode
  style?: React.CSSProperties
  baseColor?: string
}): JSX.Element {
  return (
    <span style={{
      color: 'transparent',
      backgroundImage: `linear-gradient(90deg, ${baseColor} 0%, ${baseColor} 35%, #fff 50%, ${baseColor} 65%, ${baseColor} 100%)`,
      backgroundSize: '200% 100%',
      backgroundClip: 'text',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      animation: 'chat-shimmer 1.8s linear infinite',
      ...style,
    }}>
      {children}
    </span>
  )
}

// --- Working dots ----------------------------------------------------------------

function WorkingDots({ color = '#58a6ff', size = 5 }: { color?: string; size?: number }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', gap: 3, padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: size, height: size, borderRadius: '50%', background: color,
          animation: `chat-dot-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
        }} />
      ))}
    </span>
  )
}

// --- Component -------------------------------------------------------------------

export function ChatTile({ tileId, workspaceId, workspaceDir: _workspaceDir, width: _width, height: _height, settings }: Props): JSX.Element {
  const fontSans = settings?.primaryFont?.family ?? FONT_SANS
  const fontMono = settings?.monoFont?.family ?? FONT_MONO
  const fontSize = settings?.primaryFont?.size ?? FONT_SIZE_DEFAULT
  const monoSize = settings?.monoFont?.size ?? MONO_SIZE_DEFAULT

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [provider, setProvider] = useState<Provider>('claude')
  const [model, setModel] = useState(DEFAULT_MODELS.claude[0].id)
  const [mcpEnabled, setMcpEnabled] = useState(true)
  const mcpServers = useMCPServers()
  const [disabledServers, setDisabledServers] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState(PROVIDER_MODES.claude[0].id)
  const [thinking, setThinking] = useState('adaptive')
  const [agentMode, setAgentMode] = useState(false)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const [showMcpMenu, setShowMcpMenu] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [showThinkingMenu, setShowThinkingMenu] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [opencodeModels, setOllamaModels] = useState<ModelOption[]>(DEFAULT_MODELS.opencode)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isDropTarget, setIsDropTarget] = useState(false)
  const stateLoadedRef = useRef(false)

  // Voice dictation state
  const [isDictating, setIsDictating] = useState(false)
  const [dictationText, setDictationText] = useState('')
  const recognitionRef = useRef<any>(null)

  // Autocomplete state
  const [acType, setAcType] = useState<'slash' | 'mention' | null>(null)
  const [acQuery, setAcQuery] = useState('')
  const [acIndex, setAcIndex] = useState(0)

  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const acRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const mcpMenuRef = useRef<HTMLDivElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const thinkingMenuRef = useRef<HTMLDivElement>(null)

  // Slash commands
  const SLASH_COMMANDS = [
    { value: '/compact', description: 'Compact conversation' },
    { value: '/clear', description: 'Clear conversation' },
    { value: '/model', description: 'Switch model' },
    { value: '/mode', description: 'Switch mode (plan, build, etc.)' },
    { value: '/help', description: 'Show help' },
    { value: '/init', description: 'Initialize workspace' },
  ]

  // File mention stubs
  const MENTION_STUBS = [
    { value: '@CLAUDE.md', description: 'Project instructions' },
    { value: '@package.json', description: 'Package manifest' },
    { value: '@src/', description: 'Source directory' },
  ]

  const acItems = acType === 'slash'
    ? SLASH_COMMANDS.filter(c => c.value.toLowerCase().startsWith('/' + acQuery.toLowerCase()))
    : acType === 'mention'
      ? (acQuery ? MENTION_STUBS.filter(c => c.value.toLowerCase().includes(acQuery.toLowerCase())) : MENTION_STUBS)
      : []

  // Clamp index when filtered items change
  useEffect(() => {
    setAcIndex(i => Math.min(i, Math.max(0, acItems.length - 1)))
  }, [acItems.length])

  useEffect(() => { ensureShimmerStyle() }, [])

  // Fetch available OpenCode models on mount
  useEffect(() => {
    window.electron?.chat?.opencodeModels?.().then((result: any) => {
      if (result?.models?.length) setOllamaModels(result.models)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    stateLoadedRef.current = false
    if (!workspaceId) return
    window.electron.canvas.loadTileState(workspaceId, tileId).then((saved: any) => {
      if (!saved) return
      if (Array.isArray(saved.messages)) setMessages(saved.messages)
      if (typeof saved.input === 'string') setInput(saved.input)
      if (Array.isArray(saved.attachments)) {
        setAttachments(saved.attachments.filter((item: any) => typeof item?.path === 'string').map((item: any) => ({
          path: item.path,
          kind: item.kind === 'image' || isImagePath(item.path) ? 'image' : 'file',
        })))
      }
      if (saved.provider) setProvider(saved.provider)
      if (typeof saved.model === 'string') setModel(saved.model)
      if (typeof saved.mcpEnabled === 'boolean') setMcpEnabled(saved.mcpEnabled)
      if (typeof saved.mode === 'string') setMode(saved.mode)
      if (typeof saved.thinking === 'string') setThinking(saved.thinking)
      if (typeof saved.agentMode === 'boolean') setAgentMode(saved.agentMode)
      if (typeof saved.sessionId === 'string' || saved.sessionId === null) setSessionId(saved.sessionId)
    }).catch(() => {}).finally(() => {
      stateLoadedRef.current = true
    })
  }, [workspaceId, tileId])

  useEffect(() => {
    if (!workspaceId || !stateLoadedRef.current || isStreaming) return
    window.electron.canvas.saveTileState(workspaceId, tileId, {
      messages,
      input,
      attachments,
      provider,
      model,
      mcpEnabled,
      mode,
      thinking,
      agentMode,
      sessionId,
    }).catch(() => {})
  }, [workspaceId, tileId, messages, input, attachments, provider, model, mcpEnabled, mode, thinking, agentMode, sessionId, isStreaming])

  const providerModels: Record<Provider, ModelOption[]> = {
    claude: DEFAULT_MODELS.claude,
    codex: DEFAULT_MODELS.codex,
    opencode: opencodeModels,
  }

  // Close dropdowns on outside click or Escape
  const anyMenuOpen = showModelMenu || showProviderMenu || showMcpMenu || showModeMenu || showThinkingMenu
  const menuRefs = [modelMenuRef, providerMenuRef, mcpMenuRef, modeMenuRef, thinkingMenuRef]

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      // If click is inside any menu button/dropdown, let toggleMenu handle it
      const insideAnyMenu = menuRefs.some(ref => ref.current?.contains(target))
      if (insideAnyMenu) return
      // Click is outside all menus — close everything
      setShowModelMenu(false)
      setShowProviderMenu(false)
      setShowMcpMenu(false)
      setShowModeMenu(false)
      setShowThinkingMenu(false)
      if (acRef.current && !acRef.current.contains(target) && target !== textareaRef.current) {
        setAcType(null)
        setAcQuery('')
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && anyMenuOpen) {
        e.stopPropagation()
        e.preventDefault()
        setShowModelMenu(false)
        setShowProviderMenu(false)
        setShowMcpMenu(false)
        setShowModeMenu(false)
        setShowThinkingMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [anyMenuOpen])

  const currentModel = providerModels[provider]?.find(m => m.id === model) ?? providerModels[provider]?.[0] ?? { id: '', label: 'No model' }

  const handleProviderChange = useCallback((p: Provider) => {
    setProvider(p)
    setModel(providerModels[p]?.[0]?.id ?? '')
    setMode(PROVIDER_MODES[p]?.[0]?.id ?? 'default')
    if (p !== 'claude') setThinking('adaptive') // reset thinking when leaving Claude
    setShowProviderMenu(false)
  }, [providerModels])

  const toggleMenu = useCallback((which: 'model' | 'provider' | 'mcp' | 'mode' | 'thinking') => {
    setShowModelMenu(prev => which === 'model' ? !prev : false)
    setShowProviderMenu(prev => which === 'provider' ? !prev : false)
    setShowMcpMenu(prev => which === 'mcp' ? !prev : false)
    setShowModeMenu(prev => which === 'mode' ? !prev : false)
    setShowThinkingMenu(prev => which === 'thinking' ? !prev : false)
  }, [])

  // Voice dictation via Web Speech API (Chromium in Electron)
  const toggleDictation = useCallback(() => {
    if (isDictating) {
      recognitionRef.current?.stop()
      setIsDictating(false)
      return
    }
    const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    if (!SpeechRecognition) return
    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onresult = (e: any) => {
      let final = '', interim = ''
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) final += r[0].transcript
        else interim += r[0].transcript
      }
      setDictationText(interim)
      if (final) {
        setInput(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + final)
        setDictationText('')
      }
    }
    recognition.onerror = () => { setIsDictating(false); setDictationText('') }
    recognition.onend = () => { setIsDictating(false); setDictationText('') }
    recognitionRef.current = recognition
    recognition.start()
    setIsDictating(true)
  }, [isDictating])

  // Auto-scroll (no scrollIntoView -- causes canvas shift)
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Stream listener -- handles all rich event types from Claude Agent SDK
  useEffect(() => {
    const cleanup = window.electron?.stream?.onChunk((event: any) => {
      if (event.cardId !== tileId) return

      const updateLast = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.isStreaming) return [...prev.slice(0, -1), fn(last)]
          return prev
        })

      switch (event.type) {
        case 'session':
          if (event.sessionId) setSessionId(event.sessionId)
          break

        case 'text':
          if (event.text) updateLast(m => ({ ...m, content: m.content + event.text }))
          break

        case 'thinking_start':
          updateLast(m => ({ ...m, thinking: { content: '', done: false } }))
          break

        case 'thinking':
          if (event.text) updateLast(m => ({
            ...m,
            thinking: { content: (m.thinking?.content ?? '') + event.text, done: false },
          }))
          break

        case 'tool_start':
          updateLast(m => ({
            ...m,
            toolBlocks: [...(m.toolBlocks ?? []), {
              id: event.toolId ?? `tool-${Date.now()}`,
              name: event.toolName ?? 'tool',
              input: '',
              status: 'running',
            }],
          }))
          break

        case 'tool_input':
          if (event.text) updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const last = blocks[blocks.length - 1]
            if (last) blocks[blocks.length - 1] = { ...last, input: last.input + event.text }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'tool_use':
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const idx = blocks.findIndex(b => b.name === event.toolName && b.status === 'running')
            if (idx >= 0) {
              blocks[idx] = { ...blocks[idx], input: event.toolInput ?? blocks[idx].input }
            }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'tool_summary':
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const last = blocks[blocks.length - 1]
            if (last) blocks[blocks.length - 1] = { ...last, summary: event.text, status: 'done' }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'tool_progress':
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const idx = blocks.findIndex(b => b.name === event.toolName && b.status === 'running')
            if (idx >= 0) blocks[idx] = { ...blocks[idx], elapsed: event.elapsed }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'block_stop':
          // Mark thinking as done when its block stops
          updateLast(m => ({
            ...m,
            thinking: m.thinking ? { ...m.thinking, done: true } : m.thinking,
          }))
          break

        case 'done':
          if (event.sessionId) setSessionId(event.sessionId)
          updateLast(m => ({
            ...m,
            isStreaming: false,
            cost: event.cost ?? m.cost,
            turns: event.turns ?? m.turns,
            toolBlocks: m.toolBlocks?.map(b => b.status === 'running' ? { ...b, status: 'done' as const } : b),
          }))
          setIsStreaming(false)
          window.electron?.bus?.publish(`tile:${tileId}`, 'activity', `chat:${tileId}`, {
            message: 'Assistant responded', role: 'assistant',
          })
          break

        case 'error':
          updateLast(m => ({
            ...m, content: m.content || `Error: ${event.error}`, isStreaming: false,
          }))
          setIsStreaming(false)
          break
      }
    })
    return cleanup
  }, [tileId])

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const pos = ta.value.length
      ta.setSelectionRange(pos, pos)
    })
  }, [])

  const syncComposerHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 134)}px`
  }, [])

  const addAttachments = useCallback((paths: string[]) => {
    if (paths.length === 0) return
    setAttachments(prev => {
      const seen = new Set(prev.map(item => item.path))
      const next = [...prev]
      for (const path of paths) {
        if (seen.has(path)) continue
        seen.add(path)
        next.push({ path, kind: isImagePath(path) ? 'image' : 'file' })
      }
      return next
    })
    setAcType(null)
    setAcQuery('')
    requestAnimationFrame(() => {
      syncComposerHeight()
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const pos = ta.value.length
      ta.setSelectionRange(pos, pos)
    })
  }, [syncComposerHeight])

  const removeAttachment = useCallback((path: string) => {
    setAttachments(prev => prev.filter(item => item.path !== path))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  const handleTileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (getDroppedPaths(e.dataTransfer).length === 0) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setIsDropTarget(true)
  }, [])

  const handleTileDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setIsDropTarget(false)
  }, [])

  const handleTileDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const droppedPaths = getDroppedPaths(e.dataTransfer)
    if (droppedPaths.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    setIsDropTarget(false)
    addAttachments(droppedPaths)
  }, [addAttachments])

  const sendMessage = useCallback(async () => {
    if (isStreaming) return

    const trimmedInput = input.trim()
    const attachmentBlock = attachments.length > 0
      ? `Attached file paths:\n${attachments.map(item => item.path).join('\n')}`
      : ''
    const messageContent = [trimmedInput, attachmentBlock].filter(Boolean).join('\n\n').trim()
    if (!messageContent) return

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: messageContent,
      timestamp: Date.now()
    }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setAcType(null)
    setAcQuery('')
    setAttachments([])
    setIsStreaming(true)

    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    focusComposer()

    window.electron?.bus?.publish(`tile:${tileId}`, 'activity', `chat:${tileId}`, {
      message: `User: ${userMsg.content.slice(0, 100)}`, role: 'user'
    })

    const assistantId = `msg-${Date.now() + 1}`
    setMessages(prev => [...prev, {
      id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true
    }])

    try {
      await window.electron?.chat?.send({
        cardId: tileId,
        provider,
        model,
        mode,
        thinking: provider === 'claude' ? thinking : undefined,
        messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
      })
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: `Error: ${err}`, isStreaming: false } : m
      ))
      setIsStreaming(false)
      focusComposer()
    }
  }, [input, attachments, isStreaming, messages, tileId, provider, model, mode, thinking, focusComposer])

  const stopStreaming = useCallback(() => {
    window.electron?.chat?.stop?.(tileId)
    setIsStreaming(false)
    setMessages(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m))
    focusComposer()
  }, [tileId, focusComposer])

  const clearConversation = useCallback(() => {
    if (isStreaming) return
    setMessages([])
    setAttachments([])
    setSessionId(null)
    window.electron?.chat?.clearSession?.(tileId)
  }, [isStreaming, tileId])

  const selectAcItem = useCallback((item: { value: string }) => {
    const ta = textareaRef.current
    if (!ta) return
    const pos = ta.selectionStart ?? input.length
    const textBefore = input.slice(0, pos)
    const textAfter = input.slice(pos)

    // Find the trigger start position
    let triggerStart = pos
    if (acType === 'slash') {
      const match = textBefore.match(/(^|\s)(\/\w*)$/)
      if (match) triggerStart = pos - match[2].length
    } else if (acType === 'mention') {
      const match = textBefore.match(/@[\w./]*$/)
      if (match) triggerStart = pos - match[0].length
    }

    const replacement = item.value + ' '
    const newVal = input.slice(0, triggerStart) + replacement + textAfter
    setInput(newVal)
    setAcType(null)
    setAcQuery('')

    // Restore focus and cursor position after React re-render
    requestAnimationFrame(() => {
      syncComposerHeight()
      if (ta) {
        ta.focus()
        const newPos = triggerStart + replacement.length
        ta.setSelectionRange(newPos, newPos)
      }
    })
  }, [input, acType, syncComposerHeight])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Autocomplete keyboard navigation
    if (acType && acItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcIndex(i => (i + 1) % acItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcIndex(i => (i - 1 + acItems.length) % acItems.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        selectAcItem(acItems[acIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAcType(null)
        setAcQuery('')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage, acType, acItems, acIndex, selectAcItem])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    syncComposerHeight()

    // Detect autocomplete triggers based on cursor position
    const pos = e.target.selectionStart ?? val.length
    const textBefore = val.slice(0, pos)

    // Slash command: `/` at start of input or after a space
    const slashMatch = textBefore.match(/(^|\s)\/(\w*)$/)
    if (slashMatch) {
      setAcType('slash')
      setAcQuery(slashMatch[2])
      setAcIndex(0)
      return
    }

    // @ mention: `@` anywhere
    const mentionMatch = textBefore.match(/@([\w./]*)$/)
    if (mentionMatch) {
      setAcType('mention')
      setAcQuery(mentionMatch[1])
      setAcIndex(0)
      return
    }

    // No trigger active
    setAcType(null)
    setAcQuery('')
  }, [syncComposerHeight])

  const fontCtxValue = React.useMemo(() => ({ sans: fontSans, mono: fontMono, size: fontSize, monoSize }), [fontSans, fontMono, fontSize, monoSize])

  return (
    <FontCtx.Provider value={fontCtxValue}>
    <div
      onDragOver={handleTileDragOver}
      onDragLeave={handleTileDragLeave}
      onDrop={handleTileDrop}
      style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        background: '#0d0d0d', color: '#d4d4d4',
        fontFamily: fontSans, fontSize,
        position: 'relative',
      }}
    >

      {/* Header bar with session indicator */}
      {sessionId && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center',
          padding: '4px 14px', gap: 6,
          borderBottom: '1px solid #1a1a1a', fontSize: monoSize - 3,
          color: '#555', fontFamily: fontMono,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: '#3fb950', flexShrink: 0,
          }} />
          <span>Session {sessionId.slice(0, 8)}</span>
          <span style={{ flex: 1 }} />
          <button
            onClick={clearConversation}
            disabled={isStreaming}
            style={{
              background: 'none', border: 'none', cursor: isStreaming ? 'default' : 'pointer',
              color: '#444', padding: 2, display: 'flex', alignItems: 'center',
              opacity: isStreaming ? 0.3 : 0.6,
            }}
            title="Clear conversation"
          >
            <Trash2 size={10} />
          </button>
        </div>
      )}

      {/* Messages */}
      <div
        ref={messagesRef}
        style={{
          flex: 1, overflowY: 'auto', padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0,
        }}
      >
        {messages.length === 0 && (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 8,
            color: '#444', fontSize: 12,
          }}>
            <MessageSquare size={24} color="#444" strokeWidth={1.5} style={{ opacity: 0.4 }} />
            <span>Start a conversation</span>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} style={{
            display: 'flex', flexDirection: 'column',
            alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '88%',
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            gap: 6,
          }}>
            {/* Thinking block — show immediately when streaming starts */}
            {(msg.thinking || (msg.isStreaming && !msg.content)) && (
              <ThinkingBlockView thinking={msg.thinking ?? { content: '', done: false }} />
            )}

            {/* Tool call blocks */}
            {msg.toolBlocks?.map(tb => (
              <ToolBlockView key={tb.id} block={tb} />
            ))}

            {/* Main text bubble — only show when we have content (Thinking block handles the empty streaming state) */}
            {msg.content && (
              <div style={{
                background: msg.role === 'user' ? '#1a3a5c' : '#1a1a1a',
                border: msg.role === 'user' ? '1px solid #244a6c' : '1px solid #252525',
                borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                padding: '8px 12px',
                fontSize, lineHeight: 1.55,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: '#d4d4d4', position: 'relative',
              }}>
                {msg.content}
                {msg.isStreaming && msg.content.length > 0 && (
                  <span style={{
                    display: 'inline-block', width: 6, height: 14,
                    marginLeft: 2, verticalAlign: 'text-bottom',
                    background: 'linear-gradient(90deg, #58a6ff 0%, #388bfd 50%, #58a6ff 100%)',
                    backgroundSize: '200% 100%',
                    animation: 'chat-shimmer 1.2s ease-in-out infinite',
                    borderRadius: 1,
                  }} />
                )}
                {msg.isStreaming && msg.content.length === 0 && !msg.toolBlocks?.length && (
                  <WorkingDots />
                )}
              </div>
            )}


            {/* Cost/turns footer */}
            {!msg.isStreaming && msg.cost != null && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: monoSize - 3, color: '#555', fontFamily: fontMono,
                padding: '0 4px',
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <DollarSign size={9} /> ${msg.cost.toFixed(4)}
                </span>
                {msg.turns != null && (
                  <span>{msg.turns} turn{msg.turns !== 1 ? 's' : ''}</span>
                )}
              </div>
            )}

            {/* Shimmer bar while streaming */}
            {msg.isStreaming && (
              <div style={{
                height: 2, marginTop: 1, width: '60%', borderRadius: 1,
                background: 'linear-gradient(90deg, transparent 0%, #58a6ff44 30%, #388bfd88 50%, #58a6ff44 70%, transparent 100%)',
                backgroundSize: '200% 100%',
                animation: 'chat-shimmer 1.5s ease-in-out infinite',
                alignSelf: 'flex-start',
              }} />
            )}
          </div>
        ))}
      </div>

      {/* Input bar */}
      <div style={{
        flexShrink: 0, margin: '0 10px 10px 10px',
        border: isDropTarget ? '1px solid rgba(88,166,255,0.85)' : '1px solid #333', borderRadius: 14,
        background: isDropTarget ? 'rgba(20, 34, 51, 0.92)' : '#161616',
        position: 'relative',
        boxShadow: isDropTarget ? '0 0 0 1px rgba(88,166,255,0.28), 0 0 22px rgba(56,139,253,0.12)' : 'none',
        transition: 'border-color 120ms ease, background 120ms ease, box-shadow 120ms ease',
      }}>
        {/* Autocomplete popup */}
        {acType && acItems.length > 0 && (
          <div
            ref={acRef}
            style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0,
              marginBottom: 4,
              background: '#1c1c1c', border: '1px solid #2a2a2a',
              borderRadius: 8, padding: 4,
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              zIndex: 9999,
              maxHeight: 6 * 36, overflowY: 'auto',
            }}
          >
            {acType === 'mention' && !acQuery && (
              <div style={{
                padding: '6px 10px', fontSize: 11, color: '#555',
                fontFamily: fontMono,
              }}>
                Type to search files...
              </div>
            )}
            {acItems.map((item, i) => (
              <div
                key={item.value}
                onMouseDown={(e) => { e.preventDefault(); selectAcItem(item) }}
                onMouseEnter={() => setAcIndex(i)}
                style={{
                  padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: i === acIndex ? '#252525' : 'transparent',
                  transition: 'background 0.1s',
                }}
              >
                <span style={{
                  fontSize: 12, color: i === acIndex ? '#58a6ff' : '#ccc',
                  fontFamily: fontMono, fontWeight: 500,
                }}>
                  {item.value}
                </span>
                <span style={{
                  fontSize: 11, color: '#555', fontFamily: fontSans,
                  marginLeft: 'auto',
                }}>
                  {item.description}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Dictation indicator */}
        {isDictating && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 14px 0 14px', fontSize: 11, color: '#e54d2e',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#e54d2e',
              animation: 'chat-pulse 1s ease-in-out infinite',
            }} />
            <span>Recording{dictationText ? ': ' : ''}</span>
            {dictationText && <span style={{ color: '#888', fontStyle: 'italic' }}>{dictationText}</span>}
          </div>
        )}

        {attachments.length > 0 && (
          <div style={{
            display: 'flex', gap: 8, padding: '8px 14px 4px 14px',
            overflowX: 'auto',
          }}>
            {attachments.map(item => (
              <div
                key={item.path}
                title={item.path}
                style={{
                  flexShrink: 0,
                  maxWidth: item.kind === 'image' ? 140 : 180,
                  height: 54,
                  borderRadius: 12,
                  border: '1px solid #2a2a2a',
                  background: '#121212',
                  overflow: 'hidden',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'stretch',
                }}
              >
                {item.kind === 'image' ? (
                  <img
                    src={item.path}
                    alt={basename(item.path)}
                    style={{ width: 54, height: 54, objectFit: 'cover', display: 'block', background: '#0d0d0d', flexShrink: 0 }}
                  />
                ) : (
                  <div style={{
                    width: 36, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#7f8ea3', borderRight: '1px solid #1f1f1f', fontSize: 15,
                  }}>
                    <Paperclip size={14} />
                  </div>
                )}
                <div style={{
                  minWidth: 0,
                  padding: '8px 26px 8px 10px',
                  display: 'flex', flexDirection: 'column', justifyContent: 'center',
                }}>
                  <div style={{ fontSize: 11, color: '#d4d4d4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{basename(item.path)}</div>
                  <div style={{ fontSize: 9, color: '#666', fontFamily: fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.kind === 'image' ? 'image' : 'file'}</div>
                </div>
                <button
                  onClick={() => removeAttachment(item.path)}
                  style={{
                    position: 'absolute', top: 6, right: 6,
                    width: 16, height: 16, borderRadius: 8,
                    border: '1px solid #2d2d2d', background: 'rgba(10,10,10,0.85)',
                    color: '#aaa', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 0,
                  }}
                  title="Remove attachment"
                >
                  <Trash2 size={9} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={isDictating ? 'Listening...' : 'Message the agent, or use /commands and /skills'}
          rows={1}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'transparent', color: '#d4d4d4',
            border: 'none', padding: '12px 14px 6px 14px',
            fontSize, fontFamily: fontSans, lineHeight: 1.5,
            resize: 'none', outline: 'none', overflow: 'hidden',
            minHeight: 32, opacity: 1,
          }}
        />

        {/* Toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '4px 8px 8px 8px', gap: 1,
        }}>
          {/* Attach */}
          <ToolbarBtn icon={<Paperclip size={14} />} tooltip="Attach files" onClick={() => {}} />

          {/* Safety / Mode — icon only, label in dropdown */}
          <div ref={modeMenuRef} style={{ position: 'relative' }}>
            {(() => {
              const currentMode = PROVIDER_MODES[provider].find(m => m.id === mode) ?? PROVIDER_MODES[provider][0]
              return (
                <>
                  <ToolbarBtn
                    icon={<ShieldCheck size={14} />}
                    tooltip={`Permissions: ${currentMode.label}`}
                    color={currentMode.color}
                    onClick={() => toggleMenu('mode')}
                  />
                  {showModeMenu && (
                    <Dropdown>
                      {PROVIDER_MODES[provider].map(m => (
                        <DropdownItem
                          key={m.id}
                          icon={<ShieldCheck size={11} />}
                          label={m.label}
                          sublabel={m.description}
                          active={mode === m.id}
                          onClick={() => { setMode(m.id); setShowModeMenu(false) }}
                        />
                      ))}
                    </Dropdown>
                  )}
                </>
              )
            })()}
          </div>

          {/* Thinking (Claude only) — brain + signal bars icon, label in dropdown */}
          {provider === 'claude' && (
            <div ref={thinkingMenuRef} style={{ position: 'relative' }}>
              <ToolbarBtn
                icon={<ThinkingIcon level={thinking} />}
                tooltip={`Thinking: ${THINKING_OPTIONS.find(t => t.id === thinking)?.label ?? 'Adaptive'}`}
                color={thinking === 'none' ? undefined : '#e0e0e0'}
                onClick={() => toggleMenu('thinking')}
              />
              {showThinkingMenu && (
                <Dropdown>
                  {THINKING_OPTIONS.map(t => (
                    <DropdownItem
                      key={t.id}
                      icon={<Brain size={11} />}
                      label={t.label}
                      sublabel={t.description}
                      active={thinking === t.id}
                      onClick={() => { setThinking(t.id); setShowThinkingMenu(false) }}
                    />
                  ))}
                </Dropdown>
              )}
            </div>
          )}

          {/* Provider */}
          <div ref={providerMenuRef} style={{ position: 'relative' }}>
            <ToolbarPill
              prefix={PROVIDER_ICON[provider]}
              label={PROVIDER_LABELS[provider]}
              active={showProviderMenu}
              onClick={() => toggleMenu('provider')}
            />
            {showProviderMenu && (
              <Dropdown>
                {(['claude', 'codex', 'opencode'] as Provider[]).map(p => (
                  <DropdownItem
                    key={p}
                    icon={PROVIDER_ICON[p]}
                    label={PROVIDER_LABELS[p]}
                    active={provider === p}
                    onClick={() => handleProviderChange(p)}
                  />
                ))}
              </Dropdown>
            )}
          </div>

          {/* Model */}
          <div ref={modelMenuRef} style={{ position: 'relative' }}>
            <ToolbarPill
              prefix={PROVIDER_ICON[provider]}
              label={currentModel.label}
              active={showModelMenu}
              onClick={() => toggleMenu('model')}
            />
            {showModelMenu && (
              <Dropdown>
                {providerModels[provider].map(m => (
                  <DropdownItem
                    key={m.id}
                    icon={PROVIDER_ICON[provider]}
                    label={m.label}
                    sublabel={m.id}
                    active={model === m.id}
                    onClick={() => { setModel(m.id); setShowModelMenu(false) }}
                  />
                ))}
              </Dropdown>
            )}
          </div>

          {/* Agent Mode */}
          <ToolbarBtn
            icon={<Bot size={14} />}
            tooltip={agentMode ? 'Agent mode (on)' : 'Agent mode (off)'}
            color={agentMode ? '#e0e0e0' : undefined}
            onClick={() => setAgentMode(p => !p)}
          />

          {/* MCP — server list with toggles */}
          <div ref={mcpMenuRef} style={{ position: 'relative' }}>
            <ToolbarBtn
              icon={<MCPIcon size={14} />}
              tooltip={`MCP Tools: ${mcpEnabled ? 'On' : 'Off'}`}
              color={mcpEnabled ? '#e0e0e0' : undefined}
              onClick={() => toggleMenu('mcp')}
            />
            {showMcpMenu && (
              <Dropdown>
                {/* Master toggle */}
                <DropdownItem
                  icon={<MCPIcon size={11} />}
                  label="MCP Tools"
                  active={mcpEnabled}
                  onClick={() => setMcpEnabled(v => !v)}
                />
                {mcpEnabled && mcpServers.length > 0 && (
                  <>
                    <div style={{ height: 1, background: '#2a2a2a', margin: '4px 0' }} />
                    {mcpServers.map(s => {
                      const enabled = !disabledServers.has(s.name)
                      return (
                        <DropdownItem
                          key={s.name}
                          label={s.name}
                          sublabel={s.url ? 'http' : 'stdio'}
                          active={enabled}
                          onClick={() => setDisabledServers(prev => {
                            const next = new Set(prev)
                            if (enabled) next.add(s.name)
                            else next.delete(s.name)
                            return next
                          })}
                        />
                      )
                    })}
                  </>
                )}
                {mcpEnabled && mcpServers.length === 0 && (
                  <div style={{ padding: '6px 10px', fontSize: 11, color: '#555', fontStyle: 'italic' }}>
                    No MCP servers configured
                  </div>
                )}
              </Dropdown>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* Voice */}
          <ToolbarBtn
            icon={<Mic size={14} />}
            tooltip={isDictating ? 'Stop dictation' : 'Voice input'}
            color={isDictating ? '#e54d2e' : undefined}
            onClick={toggleDictation}
          />

          {/* Activity */}
          <ToolbarBtn icon={<Activity size={14} />} tooltip="Activity" onClick={() => {}} />

          {/* Stop / Send */}
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: '#e54d2e', border: 'none',
                cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'background 0.15s', flexShrink: 0,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#ff6b4a')}
              onMouseLeave={e => (e.currentTarget.style.background = '#e54d2e')}
              title="Stop generation"
            >
              <Square size={10} fill="#fff" color="#fff" />
            </button>
          ) : (
            <button
              onClick={sendMessage}
              onMouseDown={e => e.preventDefault()}
              disabled={!input.trim() && attachments.length === 0}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: input.trim() || attachments.length > 0 ? '#4a9eff' : '#252525',
                border: 'none',
                cursor: input.trim() || attachments.length > 0 ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'background 0.15s', flexShrink: 0,
              }}
              onMouseEnter={e => { if (input.trim() || attachments.length > 0) e.currentTarget.style.background = '#58a6ff' }}
              onMouseLeave={e => { if (input.trim() || attachments.length > 0) e.currentTarget.style.background = '#4a9eff' }}
              title="Send message"
            >
              <ArrowUp size={16} color="#fff" strokeWidth={2.5} style={{ opacity: input.trim() || attachments.length > 0 ? 1 : 0.3 }} />
            </button>
          )}
        </div>
      </div>
    </div>
    </FontCtx.Provider>
  )
}

// --- Rich message sub-components -------------------------------------------------

function ThinkingBlockView({ thinking }: { thinking: ThinkingBlock }): JSX.Element {
  const fonts = useFonts()
  const [expanded, setExpanded] = useState(false)
  const isActive = !thinking.done
  const hasContent = thinking.content.length > 0

  // Auto-expand when content starts arriving, auto-collapse when done
  useEffect(() => {
    if (hasContent && isActive) setExpanded(true)
  }, [hasContent, isActive])

  useEffect(() => {
    if (thinking.done && expanded) {
      const t = setTimeout(() => setExpanded(false), 800)
      return () => clearTimeout(t)
    }
  }, [thinking.done])

  return (
    <div style={{ overflow: 'hidden', width: '100%' }}>
      {/* Compact inline badge */}
      <button
        onClick={() => hasContent && setExpanded(e => !e)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px 5px 8px',
          background: expanded ? 'rgba(74,158,255,0.08)' : 'transparent',
          border: expanded ? '1px solid rgba(74,158,255,0.15)' : '1px solid transparent',
          borderBottom: expanded ? '1px solid transparent' : '1px solid transparent',
          cursor: hasContent ? 'pointer' : 'default',
          color: isActive ? '#8ab4f8' : '#6a7a90',
          fontSize: 12, fontFamily: fonts.sans, fontWeight: 500,
          borderRadius: expanded ? '8px 8px 0 0' : 8,
          lineHeight: 1,
          backdropFilter: expanded ? 'blur(8px)' : 'none',
        }}
      >
        <Brain size={11} style={{ opacity: isActive ? 0.8 : 0.4, flexShrink: 0 }} />
        {isActive ? (
          <ShimmerText baseColor="#8ab4f8" style={{ fontSize: 12, fontWeight: 500 }}>
            Thinking
          </ShimmerText>
        ) : (
          <span style={{ opacity: 0.6, fontSize: 12, fontWeight: 500 }}>Thought</span>
        )}
        {isActive && !hasContent && (
          <WorkingDots color="#8ab4f8" size={3} />
        )}
        {hasContent && (
          <ChevronRight size={10} style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
            opacity: 0.4, flexShrink: 0,
          }} />
        )}
      </button>

      {/* Expanded thinking content */}
      {expanded && hasContent && (
        <div style={{
          padding: '8px 12px 10px 12px',
          fontSize: 12, lineHeight: 1.6, color: '#8ab4f8',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: fonts.sans, maxHeight: 200, overflowY: 'auto',
          background: 'rgba(74,158,255,0.06)',
          border: '1px solid rgba(74,158,255,0.15)',
          borderTop: 'none',
          borderRadius: '0 0 8px 8px',
          backdropFilter: 'blur(8px)',
          opacity: 0.85,
        }}>
          {thinking.content}
          {isActive && (
            <span style={{
              display: 'inline-block', width: 5, height: 12,
              marginLeft: 2, verticalAlign: 'text-bottom',
              background: '#8ab4f8', borderRadius: 1,
              animation: 'chat-pulse 1s ease-in-out infinite',
            }} />
          )}
        </div>
      )}
    </div>
  )
}

function ToolBlockView({ block }: { block: ToolBlock }): JSX.Element {
  const fonts = useFonts()
  const [expanded, setExpanded] = useState(false)
  const isRunning = block.status === 'running'

  return (
    <div style={{
      background: '#111418', border: '1px solid #252a30',
      borderRadius: 10, overflow: 'hidden', width: '100%',
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', background: 'none', border: 'none',
          cursor: 'pointer', color: isRunning ? '#8b949e' : '#7c8a98',
          fontSize: 12, fontFamily: fonts.sans, lineHeight: 1,
        }}
      >
        <Wrench size={11} style={{ opacity: isRunning ? 0.7 : 0.5, flexShrink: 0 }} />

        {/* Tool name + secondary label with shimmer when running */}
        {isRunning ? (
          <>
            <ShimmerText baseColor="#7c8a98" style={{ fontSize: 13, fontFamily: fonts.sans, fontWeight: 500 }}>
              {block.name}
            </ShimmerText>
            {block.summary && (
              <ShimmerText baseColor="#556" style={{
                fontSize: 13, fontFamily: fonts.sans, fontWeight: 400,
                marginLeft: 4, flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {block.summary}
              </ShimmerText>
            )}
          </>
        ) : (
          <>
            <span style={{ fontWeight: 500, fontSize: 13 }}>{block.name}</span>
            {block.summary && (
              <span style={{
                fontSize: 13, color: '#555', fontWeight: 400,
                marginLeft: 4, flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {block.summary}
              </span>
            )}
          </>
        )}

        <span style={{ flex: isRunning || block.summary ? undefined : 1 }} />

        {block.elapsed != null && (
          <span style={{
            fontSize: 10, color: '#555', display: 'flex', alignItems: 'center', gap: 3,
            fontFamily: fonts.mono, flexShrink: 0,
          }}>
            <Clock size={9} /> {block.elapsed.toFixed(1)}s
          </span>
        )}
        {!isRunning && !block.elapsed && (
          <Check size={11} color="#3fb950" style={{ flexShrink: 0 }} />
        )}
        <ChevronRight size={12} style={{
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
          opacity: 0.4, flexShrink: 0,
        }} />
      </button>

      {/* Expanded: show JSON input */}
      {expanded && block.input && (
        <div style={{
          padding: '4px 10px 8px 10px',
          borderTop: '1px solid #252a30',
        }}>
          <pre style={{
            margin: 0, padding: 8, borderRadius: 6,
            background: '#0a0c10', color: '#8b949e',
            fontSize: 10, lineHeight: 1.4, fontFamily: fonts.mono,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 200, overflowY: 'auto',
          }}>
            {formatToolInput(block.input)}
          </pre>
          {block.summary && (
            <div style={{
              marginTop: 6, padding: '4px 0',
              fontSize: 11, color: '#7c8a98', fontFamily: fonts.mono,
            }}>
              {block.summary}
            </div>
          )}
        </div>
      )}

      {/* Running shimmer bar */}
      {isRunning && (
        <div style={{
          height: 2, width: '100%',
          background: 'linear-gradient(90deg, transparent 0%, #58a6ff44 30%, #388bfd88 50%, #58a6ff44 70%, transparent 100%)',
          backgroundSize: '200% 100%',
          animation: 'chat-shimmer 1.5s ease-in-out infinite',
        }} />
      )}
    </div>
  )
}

function formatToolInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

// --- Toolbar sub-components ------------------------------------------------------

function ToolbarBtn({ icon, tooltip, color, onClick }: {
  icon: React.ReactNode; tooltip: string; color?: string; onClick: () => void
}): JSX.Element {
  const [h, setH] = useState(false)
  return (
    <button
      onClick={onClick}
      title={tooltip}
      style={{
        background: h ? '#1e1e1e' : 'none',
        border: 'none', cursor: 'pointer',
        padding: '4px 6px', borderRadius: 6,
        color: color ?? (h ? '#ddd' : '#999'),
        transition: 'color 0.1s, background 0.1s',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {icon}
    </button>
  )
}

function ToolbarPill({ prefix, label, color, active, onClick }: {
  prefix?: React.ReactNode; label: string; color?: string; active: boolean; onClick: () => void
}): JSX.Element {
  const fonts = useFonts()
  const [h, setH] = useState(false)
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        background: active ? '#1e1e1e' : (h ? '#1a1a1a' : 'transparent'),
        border: 'none',
        borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
        fontSize: 11, fontFamily: fonts.sans,
        color: color ?? (h ? '#eee' : '#ccc'),
        transition: 'color 0.1s, background 0.1s',
        whiteSpace: 'nowrap',
        maxWidth: 180,
        overflow: 'hidden',
      }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {prefix && <span style={{ display: 'flex', opacity: 0.8 }}>{prefix}</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <ChevronDown size={10} style={{ marginLeft: 1, opacity: 0.4, flexShrink: 0 }} />
    </button>
  )
}

function Dropdown({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{
      position: 'absolute', bottom: '100%', left: 0,
      marginBottom: 4, minWidth: 160,
      background: '#1c1c1c', border: '1px solid #2a2a2a',
      borderRadius: 8, padding: 4,
      boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      zIndex: 9999,
    }}>
      {children}
    </div>
  )
}

function DropdownItem({ icon, label, sublabel, active, onClick }: {
  icon?: React.ReactNode; label: string; sublabel?: string; active: boolean; onClick: () => void
}): JSX.Element {
  const fonts = useFonts()
  const [h, setH] = useState(false)
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 8,
        background: active ? '#252525' : (h ? '#1e1e1e' : 'transparent'),
        transition: 'background 0.1s',
      }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {icon && <span style={{ display: 'flex', color: active ? '#58a6ff' : '#888' }}>{icon}</span>}
      <span style={{
        fontSize: 12, color: active ? '#58a6ff' : '#ccc',
        fontFamily: fonts.sans,
      }}>
        {label}
      </span>
      {active && <Check size={12} color="#58a6ff" style={{ marginLeft: 'auto' }} />}
      {sublabel && !active && (
        <span style={{ fontSize: 9, color: '#444', fontFamily: fonts.mono }}>{sublabel}</span>
      )}
    </div>
  )
}
