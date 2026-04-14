import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import 'streamdown/styles.css'
import type {
  AppSettings,
  ExtensionChatModel,
  ExtensionChatProviderConfig,
  ExtensionChatTransportConfig,
} from '../../../shared/types'
import { basename, getDroppedPaths, isImagePath } from '../utils/dnd'
import {
  ShieldCheck, ChevronDown,
  Check, ArrowUp, ArrowDown, Square, MessageSquare, Bot,
  Brain, ChevronRight, Clock, DollarSign,
  FileText, Paperclip, Plus, Trash2, Wrench
} from 'lucide-react'
import { useMCPServers, type MCPServerEntry } from '../hooks/useMCPServers'
import { useTheme } from '../ThemeContext'
import { stripCapabilityPrefix, getAllNodeTools } from '../../../shared/nodeTools'
import { getChatTileRuntimeState, setChatTileRuntimeState, reviveChatTileRuntimeState, isChatTileRuntimeStateDisposed } from './chatTileRuntimeState'

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

function HermesIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L9 7h6l-3-5z" />
      <path d="M4 10c0-1 .5-2 2-2h12c1.5 0 2 1 2 2v2c0 1-.5 2-2 2H6c-1.5 0-2-1-2-2v-2z" />
      <path d="M8 14v5M16 14v5" />
      <path d="M6 19h4M14 19h4" />
      <circle cx="12" cy="11" r="1" fill={color} />
    </svg>
  )
}

function OpenClawIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8c0-2 1.5-4 3-4s2 1 3 1 1.5-1 3-1 3 2 3 4" />
      <path d="M5 12c-1 0-2 .5-2 2s1.5 3 3 3h12c1.5 0 3-1 3-3s-1-2-2-2" />
      <path d="M8 17v2M16 17v2M12 17v2" />
      <circle cx="9" cy="11" r="1" fill={color} />
      <circle cx="15" cy="11" r="1" fill={color} />
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
      <Brain size={14} />
      <svg width="12" height="14" viewBox="0 0 10 12">
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

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolId: string }

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  thinking?: ThinkingBlock
  toolBlocks?: ToolBlock[]
  contentBlocks?: ContentBlock[]
  cost?: number
  turns?: number
}

interface PendingAttachment {
  path: string
  kind: 'image' | 'file'
}

interface ChatTilePersistedState {
  messages: ChatMessage[]
  input: string
  attachments: PendingAttachment[]
  provider: string
  model: string
  mcpEnabled: boolean
  mode: string
  thinking: string
  agentMode: boolean
  autoAgentMode: boolean
  sessionId: string | null
  isStreaming: boolean
}

interface DiscoveryPeer {
  peerId: string
  peerType: string
  capabilities: string[]
  distance: number
  lastSeen: number
  actions?: Array<{ name: string; description: string }>
  filePath?: string
  label?: string
}

interface AutocompleteItem {
  key: string
  value: string
  description: string
  attachPath?: string
  priority?: number
}

interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  settings?: AppSettings
  isConnected?: boolean
  isAutoConnected?: boolean
  connectedPeers?: DiscoveryPeer[]
}

// --- Font defaults (used when no settings are provided) --------------------------

// Use the canonical font stacks from shared/types.ts DEFAULT_FONTS
const FONT_SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const FONT_MONO = '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace'
const FONT_SIZE_DEFAULT = 13
const MONO_SIZE_DEFAULT = 13
const CHAT_MESSAGE_MAX_WIDTH = 800
const CHAT_RENDER_WINDOW = 80
const CHAT_MEMORY_MESSAGE_LIMIT = 120
const CHAT_MEMORY_CHAR_LIMIT = 180_000
const CHAT_MEMORY_SINGLE_MESSAGE_LIMIT = 80_000
const CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT = 12
const CHAT_MEMORY_TOOL_INPUT_LIMIT = 2_000
const CHAT_MEMORY_TOOL_INPUT_LIMIT_AGGRESSIVE = 500
const CHAT_MEMORY_TOOL_SUMMARY_LIMIT = 2_000
const CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE = 600
const CHAT_MEMORY_THINKING_LIMIT = 8_000
const CHAT_MEMORY_THINKING_LIMIT_AGGRESSIVE = 1_200
const CHAT_MEMORY_CONTENT_BLOCK_LIMIT = 8_000
const CHAT_MEMORY_CONTENT_BLOCK_LIMIT_AGGRESSIVE = 1_500
const CHAT_TRIM_NOTICE_PREFIX = '[CodeSurf memory guard]'
const CHAT_COMPOSER_MAX_WIDTH = 640
const CHAT_COMPOSER_MIN_WIDTH = 400
const CHAT_COMPOSER_MIN_HEIGHT = 105
const CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT = 56
const CHAT_AUTO_SCROLL_THRESHOLD = 48
const TOOLBAR_ICON_SIZE = 16
const TOOLBAR_PILL_ICON_SIZE = 14
const TOOLBAR_TEXT_SIZE = 13
const TOOLBAR_CHEVRON_SIZE = 12
const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}

// Font context so sub-components can read settings-derived fonts without prop drilling
const FontCtx = React.createContext({ sans: FONT_SANS, secondary: FONT_SANS, mono: FONT_MONO, size: FONT_SIZE_DEFAULT, monoSize: MONO_SIZE_DEFAULT })
function useFonts() { return React.useContext(FontCtx) }

function truncateTextForMemory(text: string | undefined, limit: number, label: string): string {
  if (!text) return ''
  if (text.length <= limit) return text
  const keptTail = text.slice(-limit)
  return `${CHAT_TRIM_NOTICE_PREFIX} Older ${label} was truncated to keep the renderer alive.\n\n${keptTail}`
}

function trimToolBlockForMemory(block: ToolBlock, aggressive: boolean): ToolBlock {
  const input = truncateTextForMemory(
    block.input,
    aggressive ? CHAT_MEMORY_TOOL_INPUT_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_INPUT_LIMIT,
    `tool input for ${block.name}`,
  )
  const summary = block.summary
    ? truncateTextForMemory(
      block.summary,
      aggressive ? CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_SUMMARY_LIMIT,
      `tool summary for ${block.name}`,
    )
    : block.summary

  if (input === block.input && summary === block.summary) return block
  return { ...block, input, summary }
}

function compactMessageForMemory(message: ChatMessage, options: { aggressive: boolean; preserveRichLayout: boolean }): ChatMessage {
  const aggressive = options.aggressive && !message.isStreaming
  const content = truncateTextForMemory(message.content, CHAT_MEMORY_SINGLE_MESSAGE_LIMIT, 'message content')
  let next: ChatMessage = content === message.content ? message : { ...message, content }

  if (message.thinking?.content) {
    const thinkingContent = truncateTextForMemory(
      message.thinking.content,
      aggressive ? CHAT_MEMORY_THINKING_LIMIT_AGGRESSIVE : CHAT_MEMORY_THINKING_LIMIT,
      'thinking text',
    )
    if (thinkingContent !== message.thinking.content) {
      next = next === message ? { ...message } : next
      next.thinking = { ...message.thinking, content: thinkingContent }
    }
  }

  if (message.toolBlocks?.length) {
    const sourceBlocks = aggressive && message.toolBlocks.length > 3
      ? message.toolBlocks.slice(-3)
      : message.toolBlocks
    const trimmedBlocks = sourceBlocks.map(block => trimToolBlockForMemory(block, aggressive))
    const blocksChanged = sourceBlocks.length !== message.toolBlocks.length
      || trimmedBlocks.some((block, index) => block !== sourceBlocks[index])
    if (blocksChanged) {
      next = next === message ? { ...message } : next
      next.toolBlocks = trimmedBlocks.length > 0 ? trimmedBlocks : undefined
    }
  }

  if (message.contentBlocks?.length) {
    if (message.isStreaming || options.preserveRichLayout) {
      const nextContentBlocks = message.contentBlocks.map(block => {
        if (block.type !== 'text') return block
        const text = truncateTextForMemory(
          block.text,
          aggressive ? CHAT_MEMORY_CONTENT_BLOCK_LIMIT_AGGRESSIVE : CHAT_MEMORY_CONTENT_BLOCK_LIMIT,
          'interleaved message content',
        )
        if (text === block.text) return block
        return {
          ...block,
          text,
        }
      })
      if (nextContentBlocks.some((block, index) => block !== message.contentBlocks?.[index])) {
        next = next === message ? { ...message } : next
        next.contentBlocks = nextContentBlocks
      }
    } else {
      next = next === message ? { ...message } : next
      next.contentBlocks = undefined
    }
  }

  return next
}

function estimateMessageChars(message: ChatMessage): number {
  const toolChars = (message.toolBlocks ?? []).reduce((sum, block) => {
    return sum + (block.name?.length ?? 0) + (block.input?.length ?? 0) + (block.summary?.length ?? 0)
  }, 0)
  const contentBlockChars = (message.contentBlocks ?? []).reduce((sum, block) => {
    return sum + (block.type === 'text' ? (block.text?.length ?? 0) : 24)
  }, 0)
  return (message.content?.length ?? 0) + (message.thinking?.content?.length ?? 0) + toolChars + contentBlockChars
}

function normalizeMessagesForMemory(messages: ChatMessage[]): ChatMessage[] {
  const withoutNotice = messages.filter(message => !(message.role === 'system' && message.content.startsWith(CHAT_TRIM_NOTICE_PREFIX)))
  const sourceMessages = withoutNotice.length === messages.length ? messages : withoutNotice
  const normalized = sourceMessages.map((message, index, arr) => compactMessageForMemory(message, {
    aggressive: index < arr.length - CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT,
    preserveRichLayout: index >= arr.length - CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT,
  }))

  let start = 0
  let totalChars = normalized.reduce((sum, message) => sum + estimateMessageChars(message), 0)
  while (normalized.length - start > CHAT_MEMORY_MESSAGE_LIMIT || totalChars > CHAT_MEMORY_CHAR_LIMIT) {
    totalChars -= estimateMessageChars(normalized[start])
    start += 1
  }

  if (start === 0) {
    if (sourceMessages.length === messages.length && normalized.every((message, index) => message === messages[index])) {
      return messages
    }
    return normalized
  }

  const notice: ChatMessage = {
    id: `msg-memory-guard-${normalized[start]?.timestamp ?? Date.now()}`,
    role: 'system',
    content: `${CHAT_TRIM_NOTICE_PREFIX} Dropped ${start} older message${start === 1 ? '' : 's'} from live renderer state to avoid an out-of-memory crash. Remaining history may also be compacted.`,
    timestamp: normalized[start]?.timestamp ?? Date.now(),
  }
  return [notice, ...normalized.slice(start)]
}

function getRelativeMentionPath(filePath: string, workspaceDir: string): string {
  const normalizedFilePath = filePath.replace(/\\/g, '/')
  const normalizedWorkspaceDir = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedWorkspaceDir) return basename(normalizedFilePath)
  if (normalizedFilePath === normalizedWorkspaceDir) return basename(normalizedFilePath)
  if (normalizedFilePath.startsWith(`${normalizedWorkspaceDir}/`)) {
    return normalizedFilePath.slice(normalizedWorkspaceDir.length + 1)
  }
  return basename(normalizedFilePath)
}

// --- Markdown renderer for chat bubbles (Streamdown) ------------------------------

// Post-render patch: fix Streamdown's code block layout via direct DOM style overrides
function usePatchCodeBlocks(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const blocks = el.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')
    blocks.forEach(block => {
      // Container: kill padding, gap, margin
      block.style.cssText = 'padding:0!important;gap:0!important;margin:6px 0!important;border-radius:6px!important;overflow:hidden!important;border:1px solid rgba(128,128,128,0.2)!important;max-width:100%!important'
      // Header: compact
      const header = block.querySelector<HTMLElement>('[data-streamdown="code-block-header"]')
      if (header) header.style.cssText = 'height:22px!important;font-size:10px!important;padding:0 8px!important'
      // Actions wrapper (parent of code-block-actions): same line as header
      const actionsWrapper = block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')?.parentElement
      if (actionsWrapper) actionsWrapper.style.cssText = 'margin-top:-22px!important;height:22px!important;pointer-events:none;position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:flex-end'
      // Actions buttons
      const actions = block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')
      if (actions) {
        actions.style.cssText = 'padding:1px 4px!important;pointer-events:auto'
        actions.querySelectorAll<HTMLElement>('button').forEach(btn => {
          btn.style.cssText = 'width:18px!important;height:18px!important;padding:1px!important'
        })
        actions.querySelectorAll<SVGElement>('svg').forEach(svg => {
          svg.setAttribute('width', '11')
          svg.setAttribute('height', '11')
        })
      }
      // Code body: compact
      const body = block.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')
      if (body) body.style.cssText = 'padding:8px 10px!important;font-size:11px!important;border:none!important;border-radius:0!important'
      // Pre: small font, preserve whitespace
      block.querySelectorAll<HTMLElement>('pre').forEach(pre => {
        pre.style.cssText += ';font-size:11px!important;line-height:1.4!important;margin:0!important;border-radius:0!important;white-space:pre!important'
      })
      block.querySelectorAll<HTMLElement>('pre > code').forEach(code => {
        code.style.cssText += ';font-size:11px!important;line-height:1.4!important'
        // Each direct child span is a line — must be display:block
        code.querySelectorAll<HTMLElement>(':scope > span').forEach(line => {
          line.style.display = 'block'
        })
      })
    })
  })
}

const ChatMarkdown = React.memo(({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}) => {
  const ref = useRef<HTMLDivElement>(null)
  usePatchCodeBlocks(ref)
  return (
    <div ref={ref}>
      <Streamdown
        className={`chat-md ${className ?? ''}`}
        plugins={streamdownPlugins}
        mode={isStreaming ? 'streaming' : 'static'}
        shikiTheme={['github-light', 'github-dark']}
        controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
        lineNumbers={false}
      >
        {text}
      </Streamdown>
    </div>
  )
})

// --- Provider / Model config -----------------------------------------------------

type BuiltinProvider = 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes'

interface ModelOption {
  id: string
  label: string
  description?: string
}

interface ProviderEntry {
  id: string
  label: string
  description?: string
  noun: 'model' | 'agent'
  icon: React.ReactNode
  models: ModelOption[]
  kind: 'builtin' | 'extension'
  transport?: ExtensionChatTransportConfig | null
}

const DEFAULT_MODELS: Record<BuiltinProvider, ModelOption[]> = {
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
    { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  openclaw: [
    { id: 'main', label: 'Main (default)', description: 'Configured default OpenClaw agent' },
  ],
  hermes: [
    { id: 'anthropic/claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
}

const DEFAULT_PROVIDER_ID: BuiltinProvider = 'claude'

// --- Safety mode config (per-provider, matching Paseo) ---------------------------

interface ModeOption { id: string; label: string; description: string; color: string }

const PROVIDER_MODES: Record<BuiltinProvider, ModeOption[]> = {
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
  openclaw: [
    { id: 'full-auto', label: 'Full Auto', description: 'Full auto, no approval', color: '#e54d2e' },
    { id: 'auto', label: 'Auto', description: 'Auto-approve safe actions', color: '#ffb432' },
    { id: 'default', label: 'Default', description: 'Ask before risky actions', color: '#3fb950' },
    { id: 'plan', label: 'Plan', description: 'Plan only, no execution', color: '#58a6ff' },
  ],
  hermes: [
    { id: 'full', label: 'Full', description: 'All toolsets enabled', color: '#e54d2e' },
    { id: 'terminal', label: 'Terminal', description: 'Terminal + file tools', color: '#ffb432' },
    { id: 'web', label: 'Web', description: 'Web + browser tools', color: '#3fb950' },
    { id: 'query', label: 'Query', description: 'No tools, query only', color: '#58a6ff' },
  ],
}

const EXTENSION_PROVIDER_MODE: ModeOption = {
  id: 'proxy',
  label: 'Proxy',
  description: 'Connected extension transport',
  color: '#58a6ff',
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

const PROVIDER_ICON: Record<BuiltinProvider, React.ReactNode> = {
  claude: <ClaudeIcon size={TOOLBAR_PILL_ICON_SIZE} />,
  codex: <CodexIcon size={TOOLBAR_PILL_ICON_SIZE} />,
  opencode: <Bot size={TOOLBAR_PILL_ICON_SIZE} />,
  openclaw: <OpenClawIcon size={TOOLBAR_PILL_ICON_SIZE} />,
  hermes: <HermesIcon size={TOOLBAR_PILL_ICON_SIZE} />,
}

const PROVIDER_LABELS: Record<BuiltinProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
}

function isBuiltinProvider(providerId: string): providerId is BuiltinProvider {
  return providerId === 'claude'
    || providerId === 'codex'
    || providerId === 'opencode'
    || providerId === 'openclaw'
    || providerId === 'hermes'
}

function getExtensionProviderIcon(icon: ExtensionChatProviderConfig['icon'] | undefined): React.ReactNode {
  switch (icon) {
    case 'server':
      return <ShieldCheck size={TOOLBAR_PILL_ICON_SIZE} />
    case 'plug':
      return <Wrench size={TOOLBAR_PILL_ICON_SIZE} />
    case 'bot':
    default:
      return <Bot size={TOOLBAR_PILL_ICON_SIZE} />
  }
}

function normalizeExtensionModels(value: unknown): ExtensionChatModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ExtensionChatModel[] => {
    if (!item || typeof item !== 'object') return []
    const model = item as Record<string, unknown>
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    const label = typeof model.label === 'string' ? model.label.trim() : id
    if (!id || !label) return []
    return [{
      id,
      label,
      description: typeof model.description === 'string' ? model.description : undefined,
    }]
  })
}

function normalizeExtensionProviders(value: unknown): ExtensionChatProviderConfig[] {
  const rawProviders = Array.isArray(value) ? value : [value]
  return rawProviders.flatMap((item): ExtensionChatProviderConfig[] => {
    if (!item || typeof item !== 'object') return []
    const provider = item as Record<string, unknown>
    const id = typeof provider.id === 'string' ? provider.id.trim() : ''
    const label = typeof provider.label === 'string' ? provider.label.trim() : ''
    const transport = provider.transport
    if (!id || !label || !transport || typeof transport !== 'object') return []

    const transportConfig = transport as Record<string, unknown>
    if (transportConfig.type !== 'local-proxy') return []
    const baseUrl = typeof transportConfig.baseUrl === 'string' ? transportConfig.baseUrl.trim() : ''
    if (!baseUrl) return []

    const models = normalizeExtensionModels(provider.models)
    if (models.length === 0) return []

    return [{
      id,
      label,
      description: typeof provider.description === 'string' ? provider.description : undefined,
      noun: provider.noun === 'agent' ? 'agent' : 'model',
      icon: provider.icon === 'server' || provider.icon === 'plug' || provider.icon === 'bot'
        ? provider.icon
        : undefined,
      models,
      transport: {
        type: 'local-proxy',
        baseUrl,
        apiKey: typeof transportConfig.apiKey === 'string' ? transportConfig.apiKey : undefined,
        autoStart: transportConfig.autoStart === false ? false : true,
      },
    }]
  })
}

// --- Shimmer keyframes (injected once, lifted from Paseo) ------------------------

const SHIMMER_ID = 'chat-tile-shimmer'
function relativeTime(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

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

    /* Chat markdown styles (Streamdown overrides for dark theme) */
    .chat-md { line-height: 1.55; color: inherit; max-width: 100%; overflow: hidden; }
    .chat-md > *:first-child { margin-top: 0 !important; }
    .chat-md > *:last-child { margin-bottom: 0 !important; }
    .chat-md pre { max-width: 100%; overflow-x: auto; }
    .chat-md p { margin: 0 0 8px; }
    .chat-md p:last-child { margin-bottom: 0; }
    .chat-md h1 { font-size: 1.3em; font-weight: 700; margin: 12px 0 6px; color: inherit; }
    .chat-md h2 { font-size: 1.15em; font-weight: 600; margin: 10px 0 4px; color: inherit; }
    .chat-md h3 { font-size: 1.05em; font-weight: 600; margin: 8px 0 4px; color: inherit; }
    .chat-md strong { font-weight: 600; }
    .chat-md em { font-style: italic; }
    .chat-md code:not(pre code) {
      background: rgba(128,128,128,0.15); padding: 1px 5px; border-radius: 3px;
      font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 0.88em;
    }
    .chat-md pre { margin: 8px 0; border-radius: 6px; overflow: hidden; }
    .chat-md pre:first-child { margin-top: 0; }
    .chat-md pre:last-child { margin-bottom: 0; }
    .chat-md ul, .chat-md ol { padding-left: 18px; margin: 6px 0; }
    .chat-md ul:first-child, .chat-md ol:first-child { margin-top: 0; }
    .chat-md ul:last-child, .chat-md ol:last-child { margin-bottom: 0; }
    .chat-md li { line-height: 1.55; margin-bottom: 2px; }
    .chat-md li > p { margin: 0; }
    .chat-md a { color: inherit; opacity: 0.85; text-decoration: underline; text-underline-offset: 2px; }
    .chat-md a:hover { opacity: 1; }
    .chat-md blockquote {
      border-left: 3px solid rgba(128,128,128,0.4); padding-left: 10px;
      margin: 6px 0; opacity: 0.85;
    }
    .chat-md hr { border: none; border-top: 1px solid rgba(128,128,128,0.3); margin: 10px 0; }
    .chat-md table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 0.9em; }
    .chat-md th, .chat-md td { border: 1px solid rgba(128,128,128,0.3); padding: 4px 8px; text-align: left; }
    .chat-md th { font-weight: 600; background: rgba(128,128,128,0.1); }
  `
  document.head.appendChild(style)
}

// --- Streamdown plugins (singleton) ------------------------------------------------
const streamdownPlugins = { code }

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

function WorkingDots({ color, size = 5 }: { color?: string; size?: number }): JSX.Element {
  const theme = useTheme()
  return (
    <span style={{ display: 'inline-flex', gap: 3, padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: size, height: size, borderRadius: '50%', background: color ?? theme.accent.base,
          animation: `chat-dot-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
        }} />
      ))}
    </span>
  )
}

// --- Component -------------------------------------------------------------------

export function ChatTile({ tileId, workspaceId, workspaceDir: _workspaceDir, width: _width, height: _height, settings, isConnected, isAutoConnected, connectedPeers = [] }: Props): JSX.Element {
  const theme = useTheme()
  const composerBackground = theme.chat.input
  const composerBorder = theme.chat.inputBorder
  const dropdownBackground = theme.chat.dropdownBackground
  const dropdownBorder = theme.chat.dropdownBorder
  const dropdownActiveBackground = theme.chat.dropdownActiveBackground
  const dropdownHoverBackground = theme.chat.dropdownHoverBackground
  const fontSans = settings?.fonts?.primary?.family ?? settings?.primaryFont?.family ?? FONT_SANS
  const fontMono = settings?.fonts?.mono?.family ?? settings?.monoFont?.family ?? FONT_MONO
  const fontSize = settings?.fonts?.primary?.size ?? settings?.primaryFont?.size ?? FONT_SIZE_DEFAULT
  const fontLineHeight = settings?.fonts?.primary?.lineHeight ?? 1.5
  const fontWeight = settings?.fonts?.primary?.weight ?? 400
  const monoSize = settings?.fonts?.mono?.size ?? settings?.monoFont?.size ?? MONO_SIZE_DEFAULT
  const fontSecondary = settings?.fonts?.secondary?.family ?? settings?.secondaryFont?.family ?? FONT_SANS
  const initialRuntimeStateRef = useRef<ChatTilePersistedState | null>(getChatTileRuntimeState<ChatTilePersistedState>(tileId))
  const initialProvider = initialRuntimeStateRef.current?.provider ?? DEFAULT_PROVIDER_ID
  const initialModel = initialRuntimeStateRef.current?.model
    ?? (isBuiltinProvider(initialProvider)
      ? DEFAULT_MODELS[initialProvider][0]?.id
      : DEFAULT_MODELS[DEFAULT_PROVIDER_ID][0]?.id)
    ?? ''
  const initialMode = initialRuntimeStateRef.current?.mode
    ?? (isBuiltinProvider(initialProvider)
      ? PROVIDER_MODES[initialProvider][0]?.id
      : EXTENSION_PROVIDER_MODE.id)
    ?? EXTENSION_PROVIDER_MODE.id

  const [messages, setMessages] = useState<ChatMessage[]>(() => initialRuntimeStateRef.current?.messages ?? [])
  const [input, setInput] = useState(() => initialRuntimeStateRef.current?.input ?? '')
  const [isStreaming, setIsStreaming] = useState(() => initialRuntimeStateRef.current?.isStreaming ?? false)
  const [provider, setProvider] = useState<string>(() => initialProvider)
  const [model, setModel] = useState(() => initialModel)
  const [mcpEnabled, setMcpEnabled] = useState(() => initialRuntimeStateRef.current?.mcpEnabled ?? true)
  const mcpServers = useMCPServers()
  const [disabledServers, setDisabledServers] = useState<Set<string>>(new Set())
  const peerToolNames = useMemo(() => {
    const discovered = new Set<string>()
    const validTool = new Set(getAllNodeTools().map(tool => tool.name))

    for (const peer of connectedPeers) {
      for (const cap of peer.capabilities) {
        if (!cap.startsWith('tool:')) continue
        const toolName = stripCapabilityPrefix(cap)
        if (toolName && validTool.has(toolName)) {
          discovered.add(toolName)
        }
      }
      // Extension actions are not in the static node tool set — include them directly
      if (peer.actions) {
        for (const action of peer.actions) {
          if (action.name) discovered.add(action.name)
        }
      }
    }

    return Array.from(discovered).sort()
  }, [connectedPeers])

  // Track current context values published by peer extension tiles
  const peerContextRef = useRef<Map<string, Record<string, unknown>>>(new Map())
  const [peerContextVersion, setPeerContextVersion] = useState(0)
  const connectedPeerSignature = useMemo(
    () => connectedPeers.map(peer => peer.peerId).sort().join('|'),
    [connectedPeers],
  )

  useEffect(() => {
    if (!workspaceId || connectedPeers.length === 0 || !window.electron?.tileContext) {
      if (peerContextRef.current.size > 0) {
        peerContextRef.current = new Map()
        setPeerContextVersion(v => v + 1)
      }
      return
    }

    let cancelled = false

    void Promise.all(connectedPeers.map(async (peer) => {
      const entries = await window.electron.tileContext.getAll(workspaceId, peer.peerId, 'ctx:')
      return [peer.peerId, Array.isArray(entries) ? entries : []] as const
    })).then((results) => {
      if (cancelled) return
      const next = new Map<string, Record<string, unknown>>()
      for (const [peerId, entries] of results) {
        const values: Record<string, unknown> = {}
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue
          const contextEntry = entry as { key?: unknown; value?: unknown }
          if (typeof contextEntry.key !== 'string') continue
          values[contextEntry.key] = contextEntry.value
        }
        next.set(peerId, values)
      }
      peerContextRef.current = next
      setPeerContextVersion(v => v + 1)
    }).catch(() => {})

    return () => { cancelled = true }
  }, [workspaceId, connectedPeerSignature])

  useEffect(() => {
    if (!window.electron?.bus) return
    const unsubs: Array<() => void> = []

    for (const peer of connectedPeers) {
      const channel = `ctx:${peer.peerId}`
      const subscriberId = `chat:${tileId}:peer-ctx:${peer.peerId}`
      const unsubscribe = window.electron.bus.subscribe(channel, subscriberId, (event: any) => {
        const p = event?.payload ?? event
        if (p?.action === 'context_changed' && p.key) {
          const existing = peerContextRef.current.get(peer.peerId) ?? {}
          peerContextRef.current.set(peer.peerId, { ...existing, [p.key]: p.value })
          setPeerContextVersion(v => v + 1)
        }
      })
      if (typeof unsubscribe === 'function') unsubs.push(unsubscribe)
    }

    return () => { for (const u of unsubs) u() }
  }, [connectedPeerSignature, tileId])
  const [mode, setMode] = useState(() => initialMode)
  const [thinking, setThinking] = useState(() => initialRuntimeStateRef.current?.thinking ?? 'adaptive')
  const [autoAgentMode, setAutoAgentMode] = useState(() => initialRuntimeStateRef.current?.autoAgentMode ?? false)
  const effectiveAgentMode = Boolean(isConnected || isAutoConnected || autoAgentMode)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const [showInsertMenu, setShowInsertMenu] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [showThinkingMenu, setShowThinkingMenu] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(() => initialRuntimeStateRef.current?.sessionId ?? null)
  const [opencodeModels, setOpencodeModels] = useState<ModelOption[]>(DEFAULT_MODELS.opencode)
  const [openclawAgents, setOpenclawAgents] = useState<ModelOption[]>(DEFAULT_MODELS.openclaw)
  const [modelFilter, setModelFilter] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>(() => initialRuntimeStateRef.current?.attachments ?? [])
  const [isDropTarget, setIsDropTarget] = useState(false)
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)
  const setMessagesSafe = useCallback((updater: React.SetStateAction<ChatMessage[]>) => {
    setMessages(prev => normalizeMessagesForMemory(typeof updater === 'function'
      ? (updater as (prev: ChatMessage[]) => ChatMessage[])(prev)
      : updater))
  }, [])
  const stateLoadedRef = useRef(false)
  const latestStateRef = useRef<ChatTilePersistedState | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestedProviderOptionsRef = useRef<{ opencode: boolean; openclaw: boolean }>({ opencode: false, openclaw: false })

  // Voice dictation state
  const [isDictating, setIsDictating] = useState(false)
  const [dictationText, setDictationText] = useState('')
  const recognitionRef = useRef<any>(null)

  // Autocomplete state
  const [acType, setAcType] = useState<'slash' | 'mention' | null>(null)
  const [acQuery, setAcQuery] = useState('')
  const [acIndex, setAcIndex] = useState(0)

  const messagesRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const showScrollToLatestRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const acRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const insertMenuRef = useRef<HTMLDivElement>(null)
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

  const mentionItems = useMemo<AutocompleteItem[]>(() => {
    const query = acQuery.trim().toLowerCase()
    const seenPaths = new Set<string>()
    const connectedFileItems: AutocompleteItem[] = []

    for (const peer of connectedPeers) {
      if (!peer.filePath || seenPaths.has(peer.filePath)) continue
      seenPaths.add(peer.filePath)

      const mentionPath = getRelativeMentionPath(peer.filePath, _workspaceDir)
      const searchText = [
        mentionPath,
        peer.filePath,
        peer.label ?? '',
        peer.peerType,
      ].join('\n').toLowerCase()

      if (query && !searchText.includes(query)) continue

      connectedFileItems.push({
        key: `connected-file:${peer.peerId}:${peer.filePath}`,
        value: `@${mentionPath}`,
        description: `Connected ${peer.peerType} · ${mentionPath}`,
        attachPath: peer.filePath,
        priority: peer.distance,
      })
    }

    connectedFileItems.sort((a, b) => {
      const priorityDelta = (a.priority ?? 0) - (b.priority ?? 0)
      if (priorityDelta !== 0) return priorityDelta
      return a.value.localeCompare(b.value)
    })

    const existingValues = new Set(connectedFileItems.map(item => item.value.toLowerCase()))
    const stubItems = MENTION_STUBS
      .filter(item => !query || `${item.value}\n${item.description}`.toLowerCase().includes(query))
      .filter(item => !existingValues.has(item.value.toLowerCase()))
      .map(item => ({ key: `mention-stub:${item.value}`, ...item }))

    return [...connectedFileItems, ...stubItems]
  }, [acQuery, connectedPeers, _workspaceDir])

  const acItems: AutocompleteItem[] = acType === 'slash'
    ? SLASH_COMMANDS
      .filter(c => c.value.toLowerCase().startsWith('/' + acQuery.toLowerCase()))
      .map(item => ({ key: `slash:${item.value}`, ...item }))
    : acType === 'mention'
      ? mentionItems
      : []

  const renderedMessages = useMemo(() => {
    if (messages.length <= CHAT_RENDER_WINDOW) return messages
    return messages.slice(-CHAT_RENDER_WINDOW)
  }, [messages])

  const hiddenMessageCount = Math.max(0, messages.length - renderedMessages.length)

  // Clamp index when filtered items change
  useEffect(() => {
    setAcIndex(i => Math.min(i, Math.max(0, acItems.length - 1)))
  }, [acItems.length])

  useEffect(() => { ensureShimmerStyle() }, [])

  // Subscribe once to async OpenCode model refreshes, but only request provider-specific
  // options lazily when that provider is actually selected.
  useEffect(() => {
    const unsubscribeOpencode = window.electron?.chat?.onOpencodeModelsUpdated?.((payload: any) => {
      if (payload?.models?.length) setOpencodeModels(payload.models)
    })

    return () => { unsubscribeOpencode?.() }
  }, [])

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
  }, [provider])

  useEffect(() => {
    const normalized = normalizeMessagesForMemory(messages)
    if (normalized !== messages) {
      setMessages(normalized)
      return
    }
  }, [messages])

  useEffect(() => {
    latestStateRef.current = {
      messages,
      input,
      attachments,
      provider,
      model,
      mcpEnabled,
      mode,
      thinking,
      agentMode: effectiveAgentMode,
      autoAgentMode,
      sessionId,
      isStreaming,
    }
    if (stateLoadedRef.current) {
      if (isChatTileRuntimeStateDisposed(tileId)) return
      setChatTileRuntimeState(tileId, latestStateRef.current)
    }
  }, [tileId, messages, input, attachments, provider, model, mcpEnabled, mode, thinking, effectiveAgentMode, autoAgentMode, sessionId, isStreaming])

  const persistLatestState = useCallback((stateOverride?: ChatTilePersistedState | null) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    const nextState = stateOverride ?? latestStateRef.current
    if (!workspaceId || !stateLoadedRef.current || !nextState || isChatTileRuntimeStateDisposed(tileId)) return
    void window.electron.canvas.saveTileState(workspaceId, tileId, nextState).catch(() => {})
  }, [workspaceId, tileId])

  useEffect(() => {
    reviveChatTileRuntimeState(tileId)
    stateLoadedRef.current = false

    const applySavedState = (saved: Partial<ChatTilePersistedState> | null | undefined) => {
      if (!saved) return
      if (Array.isArray(saved.messages)) setMessagesSafe(saved.messages)
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
      if (typeof saved.autoAgentMode === 'boolean') setAutoAgentMode(saved.autoAgentMode)
      if (typeof saved.sessionId === 'string' || saved.sessionId === null) setSessionId(saved.sessionId)
      if (typeof saved.isStreaming === 'boolean') setIsStreaming(saved.isStreaming)
    }

    const cached = initialRuntimeStateRef.current ?? getChatTileRuntimeState<ChatTilePersistedState>(tileId)
    if (cached) {
      applySavedState(cached)
      stateLoadedRef.current = true
      return
    }

    if (!workspaceId) {
      stateLoadedRef.current = true
      return
    }

    window.electron.canvas.loadTileState(workspaceId, tileId).then((saved: any) => {
      applySavedState(saved)
    }).catch(() => {}).finally(() => {
      stateLoadedRef.current = true
    })
  }, [workspaceId, tileId])

  useEffect(() => {
    if (!workspaceId || !stateLoadedRef.current || isChatTileRuntimeStateDisposed(tileId)) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      persistLatestState()
    }, isStreaming ? 250 : 100)

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
    }
  }, [workspaceId, tileId, messages, input, attachments, provider, model, mcpEnabled, mode, thinking, effectiveAgentMode, autoAgentMode, sessionId, isStreaming, persistLatestState])

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      const latest = latestStateRef.current
      if (!latest) return
      if (isChatTileRuntimeStateDisposed(tileId)) return
      setChatTileRuntimeState(tileId, latest)
      persistLatestState(latest)
    }
  }, [tileId, persistLatestState])

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
  }), [opencodeModels, openclawAgents])

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
  }, [connectedPeers, peerContextVersion])

  const providerEntries = useMemo<ProviderEntry[]>(() => [
    builtinProviderEntries.claude,
    builtinProviderEntries.codex,
    builtinProviderEntries.opencode,
    builtinProviderEntries.openclaw,
    builtinProviderEntries.hermes,
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

  // Close dropdowns on outside click or Escape
  const anyMenuOpen = showModelMenu || showProviderMenu || showInsertMenu || showModeMenu || showThinkingMenu
  const menuRefs = [modelMenuRef, providerMenuRef, insertMenuRef, modeMenuRef, thinkingMenuRef]

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      const targetEl = e.target instanceof Element ? e.target : null
      // If click is inside any menu button or portaled dropdown, let the menu handle it.
      const insideAnyMenu = menuRefs.some(ref => ref.current?.contains(target))
        || Boolean(targetEl?.closest('[data-chat-menu-portal="true"]'))
      if (insideAnyMenu) return
      // Click is outside all menus — close everything
      setShowModelMenu(false)
      setShowProviderMenu(false)
      setShowInsertMenu(false)
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
        setShowInsertMenu(false)
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

  const optionNoun = currentProviderEntry?.noun ?? 'model'
  const currentModel = currentProviderEntry?.models.find(m => m.id === model)
    ?? currentProviderEntry?.models[0]
    ?? { id: '', label: optionNoun === 'agent' ? 'No agent' : 'No model' }

  useEffect(() => {
    if (!currentProviderEntry) return
    if (currentProviderEntry.id !== provider) {
      setProvider(currentProviderEntry.id)
      setModel(currentProviderEntry.models[0]?.id ?? '')
      setMode(modeOptions[0]?.id ?? EXTENSION_PROVIDER_MODE.id)
      return
    }

    const options = currentProviderEntry.models
    if (options.length === 0) return
    if (!options.some(option => option.id === model)) {
      setModel(options[0].id)
    }
  }, [currentProviderEntry, provider, modeOptions, model])

  useEffect(() => {
    if (!modeOptions.some(option => option.id === mode)) {
      setMode(modeOptions[0]?.id ?? EXTENSION_PROVIDER_MODE.id)
    }
  }, [modeOptions, mode])

  const handleProviderChange = useCallback((providerId: string) => {
    const nextProvider = providerEntryById.get(providerId)
    if (!nextProvider) return
    setProvider(nextProvider.id)
    setModel(nextProvider.models[0]?.id ?? '')
    setMode(nextProvider.kind === 'builtin'
      ? (PROVIDER_MODES[nextProvider.id as BuiltinProvider]?.[0]?.id ?? 'default')
      : EXTENSION_PROVIDER_MODE.id)
    // Preserve thinking preference across providers
    setShowProviderMenu(false)
  }, [providerEntryById])

  const toggleMenu = useCallback((which: 'model' | 'provider' | 'insert' | 'mode' | 'thinking') => {
    setShowModelMenu(prev => { const next = which === 'model' ? !prev : false; if (!next) setModelFilter(''); return next })
    setShowProviderMenu(prev => which === 'provider' ? !prev : false)
    setShowInsertMenu(prev => which === 'insert' ? !prev : false)
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

  const isNearLatest = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_AUTO_SCROLL_THRESHOLD
  }, [])

  const syncScrollToLatestVisibility = useCallback((next: boolean) => {
    if (showScrollToLatestRef.current === next) return
    showScrollToLatestRef.current = next
    setShowScrollToLatest(next)
  }, [])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = messagesRef.current
    if (!el) return
    stickToBottomRef.current = true
    syncScrollToLatestVisibility(false)
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [syncScrollToLatestVisibility])

  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    const atLatest = isNearLatest(el)
    stickToBottomRef.current = atLatest
    syncScrollToLatestVisibility(!atLatest)
  }, [isNearLatest, syncScrollToLatestVisibility])

  // Auto-scroll only while the user is already following the latest messages.
  useLayoutEffect(() => {
    const el = messagesRef.current
    if (!el) return
    if (!stickToBottomRef.current) {
      syncScrollToLatestVisibility(true)
      return
    }
    el.scrollTop = el.scrollHeight
    syncScrollToLatestVisibility(false)
  }, [messages, syncScrollToLatestVisibility])

  // Stream listener -- handles all rich event types from Claude Agent SDK
  useEffect(() => {
    const cleanup = window.electron?.stream?.onChunk((event: any) => {
      if (event.cardId !== tileId) return

      const updateLast = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessagesSafe(prev => {
          const last = prev[prev.length - 1]
          if (last?.isStreaming) return [...prev.slice(0, -1), fn(last)]
          return prev
        })

      switch (event.type) {
        case 'session':
          if (event.sessionId) setSessionId(event.sessionId)
          break

        case 'text':
          if (event.text) updateLast(m => {
            const blocks = [...(m.contentBlocks ?? [])]
            const last = blocks[blocks.length - 1]
            if (last?.type === 'text') {
              blocks[blocks.length - 1] = { ...last, text: last.text + event.text }
            } else {
              blocks.push({ type: 'text', text: event.text })
            }
            return { ...m, content: m.content + event.text, contentBlocks: blocks }
          })
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

        case 'tool_start': {
          const toolId = event.toolId ?? `tool-${Date.now()}`
          updateLast(m => ({
            ...m,
            toolBlocks: [...(m.toolBlocks ?? []), {
              id: toolId,
              name: event.toolName ?? 'tool',
              input: '',
              status: 'running',
            }],
            contentBlocks: [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId }],
          }))
          break
        }

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
              blocks[idx] = { ...blocks[idx], input: event.toolInput ?? blocks[idx].input, status: 'done' }
            }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'tool_summary':
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            // Find the last done tool without a summary, or last running tool
            const idx = blocks.findLastIndex(b => b.status === 'done' && !b.summary)
            const target = idx >= 0 ? idx : blocks.findLastIndex(b => b.status === 'running')
            if (target >= 0) {
              blocks[target] = { ...blocks[target], summary: event.text, status: 'done' }
            }
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
          // Mark thinking as done and/or the last running tool as done when its block stops
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const lastRunning = blocks.findLastIndex(b => b.status === 'running')
            if (lastRunning >= 0) {
              blocks[lastRunning] = { ...blocks[lastRunning], status: 'done' }
            }
            return {
              ...m,
              thinking: m.thinking ? { ...m.thinking, done: true } : m.thinking,
              toolBlocks: blocks,
            }
          })
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

  // Subscribe to incoming MCP peer commands on this tile's bus channel
  useEffect(() => {
    if (!window.electron?.bus) return
    const unsubscribe = window.electron.bus.subscribe(`tile:${tileId}`, `chat:${tileId}:mcp`, (evt: any) => {
      if (!evt?.type?.startsWith('mcp_') && !String(evt.source || '').startsWith('mcp:')) return
      const payload = (evt.payload as Record<string, unknown>) || {}
      const command = typeof payload.command === 'string' ? payload.command : ''
      if (!command) return

      if (command === 'chat_send_message' || command === 'chat_acknowledge') {
        const text = typeof payload.message === 'string' ? payload.message : ''
        if (!text) return
        const prefix = command === 'chat_acknowledge' ? '🤝 ' : '📨 '
        const incomingMsg: ChatMessage = {
          id: `peer-${Date.now()}`,
          role: 'user',
          content: `${prefix}${text}`,
          timestamp: Date.now(),
          isStreaming: false,
        }
        setMessagesSafe(prev => [...prev, incomingMsg])
      }
    })
    return () => unsubscribe?.()
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
    ta.style.height = `${Math.max(CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT, Math.min(ta.scrollHeight, 134))}px`
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

  const openAttachmentPicker = useCallback(async () => {
    const paths = await window.electron.chat?.selectFiles()
    if (paths && paths.length > 0) addAttachments(paths)
    setShowInsertMenu(false)
  }, [addAttachments])

  const removeAttachment = useCallback((path: string) => {
    setAttachments(prev => prev.filter(item => item.path !== path))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  const handleTileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // During dragover, getData() is restricted — check types instead for internal drags
    const dt = e.dataTransfer
    const hasFiles = dt.types.includes('Files')
    const hasUri = dt.types.includes('text/uri-list')
    const hasPlain = dt.types.includes('text/plain')
    const hasFileRef = dt.types.includes('application/file-reference-path')
    if (!hasFiles && !hasUri && !hasPlain && !hasFileRef) return
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
    e.preventDefault()
    e.stopPropagation()
    setIsDropTarget(false)
    // Check file-reference-path first (from FileTile drags), then fall back to generic extraction
    const fileRef = e.dataTransfer.getData('application/file-reference-path')
    const droppedPaths = fileRef ? [fileRef] : getDroppedPaths(e.dataTransfer)
    if (droppedPaths.length === 0) return
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

    setMessagesSafe(prev => [...prev, userMsg])
    setInput('')
    setAcType(null)
    setAcQuery('')
    setAttachments([])
    setIsStreaming(true)
    stickToBottomRef.current = true

    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    focusComposer()

    window.electron?.bus?.publish(`tile:${tileId}`, 'activity', `chat:${tileId}`, {
      message: `User: ${userMsg.content.slice(0, 100)}`, role: 'user'
    })

    const assistantId = `msg-${Date.now() + 1}`
    setMessagesSafe(prev => [...prev, {
      id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true
    }])

    try {
      const peers = mcpEnabled ? connectedPeers.map(p => ({
        peerId: p.peerId,
        peerType: p.peerType,
        tools: p.capabilities.filter(c => c.startsWith('tool:')).map(c => stripCapabilityPrefix(c)),
        actions: p.actions,
        context: peerContextRef.current.get(p.peerId),
      })) : []

      await window.electron?.chat?.send({
        cardId: tileId,
        provider,
        model,
        providerTransport: currentProviderEntry?.transport ?? null,
        mode,
        thinking,
        workspaceDir: _workspaceDir,
        messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
        negotiatedTools: mcpEnabled ? peerToolNames : undefined,
        peers: peers.length > 0 ? peers : undefined,
        sessionId,
      })
    } catch (err) {
      setMessagesSafe(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: `Error: ${err}`, isStreaming: false } : m
      ))
      setIsStreaming(false)
      focusComposer()
    }
  }, [input, attachments, isStreaming, messages, tileId, provider, model, currentProviderEntry, mode, thinking, mcpEnabled, peerToolNames, peerContextVersion, focusComposer])

  const stopStreaming = useCallback(() => {
    window.electron?.chat?.stop?.(tileId)
    setIsStreaming(false)
    setMessagesSafe(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m))
    focusComposer()
  }, [tileId, focusComposer])

  const clearConversation = useCallback(() => {
    if (isStreaming) return
    setMessagesSafe([])
    setAttachments([])
    setSessionId(null)
    window.electron?.chat?.clearSession?.(tileId)
  }, [isStreaming, tileId])

  const selectAcItem = useCallback((item: AutocompleteItem) => {
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
    if (item.attachPath) {
      setAttachments(prev => {
        if (prev.some(existing => existing.path === item.attachPath)) return prev
        return [...prev, { path: item.attachPath, kind: isImagePath(item.attachPath) ? 'image' : 'file' }]
      })
    }
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

  const fontCtxValue = useMemo(() => ({ sans: fontSans, secondary: fontSecondary, mono: fontMono, size: fontSize, monoSize }), [fontSans, fontSecondary, fontMono, fontSize, monoSize])

  return (
    <FontCtx.Provider value={fontCtxValue}>
    <div
      onDragOver={handleTileDragOver}
      onDragLeave={handleTileDragLeave}
      onDrop={handleTileDrop}
      style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        background: theme.chat.background, color: theme.chat.text,
        fontFamily: fontSans, fontSize, lineHeight: fontLineHeight, fontWeight,
        position: 'relative',
      }}
    >

      {/* Header bar with session indicator */}
      {sessionId && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center',
          padding: '4px 14px', gap: 6,
          borderBottom: `1px solid ${theme.chat.divider}`, fontSize: monoSize - 3,
          color: theme.chat.muted, fontFamily: fontMono,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: theme.status.success, flexShrink: 0,
          }} />
          <span>Session {sessionId.slice(0, 8)}</span>
          <span style={{ flex: 1 }} />
          <button
            onClick={clearConversation}
            disabled={isStreaming}
            style={{
              background: 'none', border: 'none', cursor: isStreaming ? 'default' : 'pointer',
              color: theme.chat.subtle, padding: 2, display: 'flex', alignItems: 'center',
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
        onScroll={handleMessagesScroll}
        style={{
          flex: 1, overflowY: 'auto', padding: '12px 14px',
          minHeight: 0,
        }}
      >
        <div style={{
          width: '100%',
          maxWidth: CHAT_MESSAGE_MAX_WIDTH,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minHeight: '100%',
        }}>
          {messages.length === 0 && (
             <div style={{
               flex: 1, display: 'flex', flexDirection: 'column',
               alignItems: 'center', justifyContent: 'center', gap: 8,
               color: theme.chat.subtle, fontSize: 12,
             }}>
               <MessageSquare size={24} color={theme.chat.subtle} strokeWidth={1.5} style={{ opacity: 0.4 }} />
               <span>Start a conversation</span>
             </div>
           )}

          {hiddenMessageCount > 0 && (
            <div style={{
              alignSelf: 'center',
              maxWidth: CHAT_MESSAGE_MAX_WIDTH,
              padding: '8px 12px',
              borderRadius: 10,
              border: `1px solid ${theme.chat.divider}`,
              background: theme.chat.userBubble,
              color: theme.chat.muted,
              fontSize: 11,
              textAlign: 'center',
            }}>
              Showing the most recent {renderedMessages.length} messages to keep this block responsive. {hiddenMessageCount} older message{hiddenMessageCount === 1 ? '' : 's'} are still preserved in compacted session state.
            </div>
          )}
 
          {renderedMessages.map(msg => (
            <div key={msg.id} style={{
              display: 'flex', flexDirection: 'column',
              alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: msg.role === 'user' ? '60%' : '70%', minWidth: 0,
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: msg.role === 'user' ? 5 : 0,
              gap: 6,
            }}>
              {/* Thinking block — show immediately when streaming starts */}
              {(msg.thinking || (msg.isStreaming && !msg.content)) && (
                <ThinkingBlockView thinking={msg.thinking ?? { content: '', done: false }} />
              )}

              {/* Interleaved content blocks — text and tool calls in stream order */}
              {(msg.contentBlocks?.length ?? 0) > 0 ? (
                <>
                  {(() => {
                    const elements: JSX.Element[] = []
                    const blocks = msg.contentBlocks!
                    let i = 0
                    while (i < blocks.length) {
                      const block = blocks[i]
                      if (block.type === 'tool') {
                        // Collect consecutive tool blocks into a horizontal row
                        const toolGroup: JSX.Element[] = []
                        while (i < blocks.length && blocks[i].type === 'tool') {
                          const tb = msg.toolBlocks?.find(t => t.id === blocks[i].toolId)
                          if (tb) toolGroup.push(<ToolBlockView key={tb.id} block={tb} />)
                          i++
                        }
                        if (toolGroup.length > 0) {
                          elements.push(
                            <div key={`tools-${i}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                              {toolGroup}
                            </div>
                          )
                        }
                      } else {
                        const isLastBlock = i === blocks.length - 1
                        elements.push(
                          <div key={`text-${i}`} style={{
                            background: msg.role === 'user' ? theme.chat.userBubble : 'transparent',
                            border: msg.role === 'user' ? `1px solid ${theme.chat.userBubbleBorder}` : '0',
                            borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                            padding: '8px 12px',
                            fontSize, lineHeight: 1.55,
                            wordBreak: 'break-word',
                            color: theme.chat.text, position: 'relative',
                            width: '100%', minWidth: 0, overflow: 'hidden',
                          }}>
                            {msg.role === 'assistant' ? (
                              <ChatMarkdown text={block.text} isStreaming={msg.isStreaming && isLastBlock} />
                            ) : (
                              <span style={{ whiteSpace: 'pre-wrap' }}>{block.text}</span>
                            )}
                          </div>
                        )
                        i++
                      }
                    }
                    return elements
                  })()}
                </>
              ) : (
                <>
                  {/* Fallback: legacy layout for messages without contentBlocks */}
                  {msg.toolBlocks && msg.toolBlocks.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {msg.toolBlocks.map(tb => (
                        <ToolBlockView key={tb.id} block={tb} />
                      ))}
                    </div>
                  )}
                  {msg.content && (
                    <div style={{
                      background: msg.role === 'user' ? theme.chat.userBubble : 'transparent',
                      border: msg.role === 'user' ? `1px solid ${theme.chat.userBubbleBorder}` : '0',
                      borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                      padding: '8px 12px',
                      fontSize, lineHeight: 1.55,
                      wordBreak: 'break-word',
                      color: theme.chat.text, position: 'relative',
                      width: '100%', minWidth: 0, overflow: 'hidden',
                    }}>
                      {msg.role === 'assistant' ? (
                        <ChatMarkdown text={msg.content} isStreaming={msg.isStreaming} />
                      ) : (
                        <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                      )}
                      {msg.isStreaming && msg.content.length === 0 && !msg.toolBlocks?.length && (
                        <WorkingDots />
                      )}
                    </div>
                  )}
                </>
              )}
              {/* Cost/turns/time footer */}
              {!msg.isStreaming && msg.role === 'assistant' && msg.cost != null && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: monoSize - 3, color: theme.chat.muted, fontFamily: fontMono,
                  padding: '0 4px',
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <DollarSign size={9} /> ${msg.cost.toFixed(4)}
                  </span>
                  {msg.turns != null && (
                    <span>{msg.turns} turn{msg.turns !== 1 ? 's' : ''}</span>
                  )}
                  <span>{relativeTime(msg.timestamp)}</span>
                </div>
              )}
              {/* User message time footer */}
              {!msg.isStreaming && msg.role === 'user' && (
                <div style={{
                  fontSize: monoSize - 3, color: theme.chat.muted, fontFamily: fontMono,
                  padding: '0 4px', textAlign: 'right',
                }}>
                  {relativeTime(msg.timestamp)}
                </div>
              )}

              {/* Shimmer bar while streaming */}
              {msg.isStreaming && (
                <div style={{
                  height: 2, marginTop: 1, width: '60%', borderRadius: 1,
                  background: `linear-gradient(90deg, transparent 0%, ${theme.accent.soft} 30%, ${theme.accent.base}88 50%, ${theme.accent.soft} 70%, transparent 100%)`,
                  backgroundSize: '200% 100%',
                  animation: 'chat-shimmer 1.5s ease-in-out infinite',
                  alignSelf: 'flex-start',
                }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {showScrollToLatest && (
        <button
          onClick={() => scrollToLatest()}
          title="Jump to latest"
          style={{
            position: 'absolute',
            right: 20,
            bottom: 124,
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 10px',
            borderRadius: 999,
            border: `1px solid ${theme.chat.divider}`,
            background: theme.surface.panelElevated,
            color: theme.text.secondary,
            cursor: 'pointer',
            boxShadow: theme.shadow.panel,
            fontSize: 12,
            fontFamily: fontSans,
          }}
        >
          <ArrowDown size={13} />
          <span>Latest</span>
        </button>
      )}

      {/* Input bar */}
      <div style={{
        flexShrink: 0,
        width: `min(calc(100% - 8px), ${CHAT_COMPOSER_MAX_WIDTH}px)`,
        minWidth: `min(${CHAT_COMPOSER_MIN_WIDTH}px, calc(100% - 8px))`,
        margin: '0 auto 6px auto',
        minHeight: CHAT_COMPOSER_MIN_HEIGHT,
        border: isDropTarget ? `1px solid ${theme.accent.base}` : `1px solid ${composerBorder}`, borderRadius: 14,
        background: isDropTarget ? theme.surface.accentSoft : composerBackground,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: isDropTarget ? `0 0 0 1px ${theme.border.accent}, 0 0 22px ${theme.accent.soft}` : 'none',
        transition: 'border-color 120ms ease, background 120ms ease, box-shadow 120ms ease',
      }}>
        {/* Autocomplete popup */}
        {acType && acItems.length > 0 && (
          <div
            ref={acRef}
            style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0,
              marginBottom: 4,
              background: dropdownBackground, border: `1px solid ${dropdownBorder}`,
              borderRadius: 8, padding: 4,
              boxShadow: theme.shadow.panel,
              zIndex: 9999,
              maxHeight: 6 * 36, overflowY: 'auto',
            }}
          >
            {acType === 'mention' && !acQuery && (
              <div style={{
                padding: '6px 10px', fontSize: 11, color: theme.chat.muted,
                fontFamily: fontMono,
              }}>
                Connected files appear first. Type to search files...
              </div>
            )}
            {acItems.map((item, i) => (
              <div
                key={item.key}
                onMouseDown={(e) => { e.preventDefault(); selectAcItem(item) }}
                onMouseEnter={() => setAcIndex(i)}
                style={{
                  padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: i === acIndex ? dropdownActiveBackground : 'transparent',
                  transition: 'background 0.1s',
                }}
              >
                <span style={{
                  fontSize: 12, color: i === acIndex ? theme.accent.base : theme.chat.text,
                  fontFamily: fontMono, fontWeight: 500,
                }}>
                  {item.value}
                </span>
                <span style={{
                  fontSize: 11, color: theme.chat.muted, fontFamily: fontSans,
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
            padding: '4px 14px 0 14px', fontSize: 11, color: theme.status.danger,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: theme.status.danger,
              animation: 'chat-pulse 1s ease-in-out infinite',
            }} />
            <span>Recording{dictationText ? ': ' : ''}</span>
            {dictationText && <span style={{ color: theme.chat.muted, fontStyle: 'italic' }}>{dictationText}</span>}
          </div>
        )}

        {attachments.length > 0 && (
          <div style={{
            display: 'block', gap: 8, padding: '8px 14px 4px 14px',
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
                  border: `1px solid ${dropdownBorder}`,
                  background: theme.surface.panelElevated,
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
                    style={{ width: 54, height: 54, objectFit: 'cover', display: 'block', background: theme.chat.background, flexShrink: 0 }}
                  />
                ) : (
                  <div style={{
                    width: 36, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: theme.chat.muted, borderRight: `1px solid ${theme.border.subtle}`, fontSize: 15,
                  }}>
                    <FileText size={13} />
                  </div>
                )}
                <div style={{
                  minWidth: 0,
                  padding: '8px 26px 8px 10px',
                  display: 'flex', flexDirection: 'column', justifyContent: 'center',
                }}>
                  <div style={{ fontSize: 11, color: theme.chat.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{basename(item.path)}</div>
                  <div style={{ fontSize: 9, color: theme.chat.muted, fontFamily: fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.kind === 'image' ? 'image' : 'file'}</div>
                </div>
                <button
                  onClick={() => removeAttachment(item.path)}
                  style={{
                    position: 'absolute', top: 6, right: 6,
                    width: 16, height: 16, borderRadius: 8,
                    border: `1px solid ${theme.border.default}`, background: theme.surface.overlay,
                    color: theme.chat.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
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

        {effectiveAgentMode && (
          <div style={{
            position: 'absolute',
            top: -17,
            right: 14,
            textAlign: 'right',
            color: theme.chat.muted,
            fontSize: 10,
            fontFamily: fontMono,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            opacity: 0.95,
            pointerEvents: 'none',
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 5,
          }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: theme.chat.muted,
              opacity: 0.95,
            }} />
            <span>
              CONNECTED
            </span>
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
            width: '100%', boxSizing: 'border-box', flex: 1,
            background: 'transparent', color: theme.chat.text,
            border: 'none', padding: '12px 14px 6px 14px',
            fontSize, fontFamily: fontSans, lineHeight: 1.5,
            resize: 'none', outline: 'none', overflow: 'hidden',
            minHeight: CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT, opacity: 1,
          }}
        />

        {/* Toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '4px 8px 8px 8px', gap: 2,
        }}>
          {/* Insert menu */}
          <div ref={insertMenuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              aria-label="Open attachments and tools menu"
              title="Open attachments and tools menu"
              onClick={() => toggleMenu('insert')}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28,
                height: 28,
                minWidth: 28,
                borderRadius: '50%',
                border: 'none',
                background: showInsertMenu ? theme.surface.hover : theme.surface.panelMuted,
                color: showInsertMenu ? theme.chat.text : theme.chat.muted,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                transition: 'background 0.15s, color 0.15s',
                flexShrink: 0,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = theme.surface.hover
                e.currentTarget.style.color = theme.chat.text
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = showInsertMenu ? theme.surface.hover : theme.surface.panelMuted
                e.currentTarget.style.color = showInsertMenu ? theme.chat.text : theme.chat.muted
              }}
            >
              <Plus size={16} strokeWidth={2.2} />
            </button>
            {showInsertMenu && (
              <MenuPortal anchorRef={insertMenuRef}>
                <ComposerInsertMenu
                  onAttachFiles={openAttachmentPicker}
                  mcpEnabled={mcpEnabled}
                  onToggleMcpEnabled={() => setMcpEnabled(v => !v)}
                  mcpServers={mcpServers}
                  disabledServers={disabledServers}
                  setDisabledServers={setDisabledServers}
                  peerToolNames={peerToolNames}
                />
              </MenuPortal>
            )}
          </div>

          {/* Safety / Mode — icon only, label in dropdown */}
          <div ref={modeMenuRef} style={{ position: 'relative' }}>
            {(() => {
              const currentMode = modeOptions.find(m => m.id === mode) ?? modeOptions[0] ?? EXTENSION_PROVIDER_MODE
              return (
                <>
                  <ToolbarBtn
                    icon={<ShieldCheck size={TOOLBAR_ICON_SIZE} />}
                    tooltip={`Permissions: ${currentMode.label}`}
                    onClick={() => toggleMenu('mode')}
                  />
                  {showModeMenu && (
                    <MenuPortal anchorRef={modeMenuRef}>
                      <Dropdown>
                        {modeOptions.map(m => (
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
                    </MenuPortal>
                  )}
                </>
              )
            })()}
          </div>

          {/* Thinking — brain + signal bars icon, label in dropdown */}
          <div ref={thinkingMenuRef} style={{ position: 'relative' }}>
            <ToolbarBtn
              icon={<ThinkingIcon level={thinking} />}
              tooltip={`Thinking: ${THINKING_OPTIONS.find(t => t.id === thinking)?.label ?? 'Adaptive'}`}
              color={thinking === 'none' ? undefined : theme.chat.text}
              onClick={() => toggleMenu('thinking')}
            />
            {showThinkingMenu && (
              <MenuPortal anchorRef={thinkingMenuRef}>
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
              </MenuPortal>
            )}
          </div>

          {/* Provider */}
          <div ref={providerMenuRef} style={{ position: 'relative' }}>
            <ToolbarPill
              prefix={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
              label={currentProviderEntry?.label ?? 'Provider'}
              active={showProviderMenu}
              onClick={() => toggleMenu('provider')}
            />
            {showProviderMenu && (
              <MenuPortal anchorRef={providerMenuRef}>
                <Dropdown>
                  {providerEntries.map(entry => (
                    <DropdownItem
                      key={entry.id}
                      icon={entry.icon}
                      label={entry.label}
                      sublabel={entry.description}
                      active={provider === entry.id}
                      onClick={() => handleProviderChange(entry.id)}
                    />
                  ))}
                </Dropdown>
              </MenuPortal>
            )}
          </div>

          {/* Model */}
          <div ref={modelMenuRef} style={{ position: 'relative' }}>
            <ToolbarPill
              prefix={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
              label={currentModel.label}
              active={showModelMenu}
              onClick={() => toggleMenu('model')}
            />
            {showModelMenu && (
              <MenuPortal anchorRef={modelMenuRef}>
                <ModelDropdown
                  models={currentProviderEntry?.models ?? []}
                  activeId={model}
                  filter={modelFilter}
                  onFilterChange={setModelFilter}
                  providerIcon={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
                  noun={optionNoun}
                  onSelect={(id) => { setModel(id); setShowModelMenu(false); setModelFilter('') }}
                />
              </MenuPortal>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* Stop / Send */}
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: theme.status.danger, border: 'none',
                cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'background 0.15s', flexShrink: 0,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = theme.status.dangerHover)}
              onMouseLeave={e => (e.currentTarget.style.background = theme.status.danger)}
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
                background: input.trim() || attachments.length > 0 ? theme.accent.base : theme.surface.panelMuted,
                border: 'none',
                cursor: input.trim() || attachments.length > 0 ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'background 0.15s', flexShrink: 0,
              }}
              onMouseEnter={e => { if (input.trim() || attachments.length > 0) e.currentTarget.style.background = theme.accent.hover }}
              onMouseLeave={e => { if (input.trim() || attachments.length > 0) e.currentTarget.style.background = theme.accent.base }}
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
  const theme = useTheme()
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
          background: expanded ? theme.surface.selection : 'transparent',
          border: expanded ? `1px solid ${theme.surface.selectionBorder}` : '1px solid transparent',
          cursor: hasContent ? 'pointer' : 'default',
          color: isActive ? theme.accent.hover : theme.chat.muted,
          fontSize: 12, fontFamily: fonts.sans, fontWeight: 500,
          borderRadius: expanded ? '8px 8px 0 0' : 8,
          lineHeight: 1,
          backdropFilter: expanded ? 'blur(8px)' : 'none',
        }}
      >
        <Brain size={11} style={{ opacity: isActive ? 0.8 : 0.4, flexShrink: 0 }} />
        {isActive ? (
          <ShimmerText baseColor={theme.accent.hover} style={{ fontSize: 12, fontWeight: 500 }}>
            Thinking
          </ShimmerText>
        ) : (
          <span style={{ opacity: 0.6, fontSize: 12, fontWeight: 500 }}>Thought</span>
        )}
        {isActive && !hasContent && (
          <WorkingDots color={theme.accent.hover} size={3} />
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
          fontSize: 12, lineHeight: 1.6, color: theme.accent.hover,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: fonts.sans, maxHeight: 200, overflowY: 'auto',
          background: theme.surface.selection,
          border: `1px solid ${theme.surface.selectionBorder}`,
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
              background: theme.accent.hover, borderRadius: 1,
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
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const isRunning = block.status === 'running'

  return (
    <div style={{
      background: theme.chat.assistantBubble, border: `1px solid ${theme.chat.assistantBubbleBorder}`,
      borderRadius: 10, overflow: 'hidden', maxWidth: '100%', width: 'fit-content',
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          padding: '5px 10px', background: 'none', border: 'none',
          cursor: 'pointer', color: isRunning ? theme.chat.textSecondary : theme.chat.muted,
          fontSize: 12, fontFamily: fonts.sans, lineHeight: 1,
        }}
      >
        <Wrench size={11} style={{ opacity: isRunning ? 0.7 : 0.5, flexShrink: 0 }} />

        {/* Tool name + secondary label with shimmer when running */}
        {isRunning ? (
          <>
            <ShimmerText baseColor={theme.chat.textSecondary} style={{ fontSize: 13, fontFamily: fonts.sans, fontWeight: 500 }}>
              {block.name}
            </ShimmerText>
            {block.summary && (
              <ShimmerText baseColor={theme.chat.muted} style={{
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
                fontSize: 13, color: theme.chat.muted, fontWeight: 400,
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
            fontSize: 10, color: theme.chat.muted, display: 'flex', alignItems: 'center', gap: 3,
            fontFamily: fonts.mono, flexShrink: 0,
          }}>
            <Clock size={9} /> {block.elapsed.toFixed(1)}s
          </span>
        )}
        {!isRunning && !block.elapsed && (
          <Check size={11} color={theme.status.success} style={{ flexShrink: 0 }} />
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
          borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
        }}>
          <pre style={{
            margin: 0, padding: 8, borderRadius: 6,
            background: theme.surface.panelMuted, color: theme.chat.textSecondary,
            fontSize: 10, lineHeight: 1.4, fontFamily: fonts.mono,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 200, overflowY: 'auto',
          }}>
            {formatToolInput(block.input)}
          </pre>
          {block.summary && (
            <div style={{
              marginTop: 6, padding: '4px 0',
              fontSize: 11, color: theme.chat.muted, fontFamily: fonts.mono,
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
          background: `linear-gradient(90deg, transparent 0%, ${theme.accent.soft} 30%, ${theme.accent.base}88 50%, ${theme.accent.soft} 70%, transparent 100%)`,
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
  const theme = useTheme()
  const [h, setH] = useState(false)
  return (
    <button
      onClick={onClick}
      title={tooltip}
      style={{
        background: h ? theme.surface.hover : 'none',
        border: 'none', cursor: 'pointer',
        padding: '5px 7px', borderRadius: 6,
        color: color ?? (h ? theme.chat.text : theme.chat.muted),
        transition: 'color 0.1s, background 0.1s',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        ...NON_SELECTABLE_UI_STYLE,
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
  const theme = useTheme()
  const [h, setH] = useState(false)
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        background: active ? theme.surface.hover : (h ? theme.surface.panelMuted : 'transparent'),
        border: 'none',
        borderRadius: 6, padding: '4px 9px', cursor: 'pointer',
        fontSize: TOOLBAR_TEXT_SIZE, fontFamily: fonts.sans,
        color: color ?? (h ? theme.chat.text : theme.chat.textSecondary),
        transition: 'color 0.1s, background 0.1s',
        whiteSpace: 'nowrap',
        maxWidth: 180,
        overflow: 'hidden',
        ...NON_SELECTABLE_UI_STYLE,
      }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {prefix && <span style={{ display: 'flex', opacity: 0.8 }}>{prefix}</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <ChevronDown size={TOOLBAR_CHEVRON_SIZE} style={{ marginLeft: 1, opacity: 0.4, flexShrink: 0 }} />
    </button>
  )
}

// Renders children in a portal at document.body so they escape tile overflow:hidden clipping.
// Positions above the anchor element, right-aligned so menus don't overflow off the right edge.
function MenuPortal({ anchorRef, children }: { anchorRef: React.RefObject<HTMLElement | null>; children: React.ReactNode }): JSX.Element | null {
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

function Dropdown({ children }: { children: React.ReactNode }): JSX.Element {
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

function ComposerInsertMenu({
  onAttachFiles,
  mcpEnabled,
  onToggleMcpEnabled,
  mcpServers,
  disabledServers,
  setDisabledServers,
  peerToolNames,
}: {
  onAttachFiles: () => void
  mcpEnabled: boolean
  onToggleMcpEnabled: () => void
  mcpServers: MCPServerEntry[]
  disabledServers: Set<string>
  setDisabledServers: React.Dispatch<React.SetStateAction<Set<string>>>
  peerToolNames: string[]
}): JSX.Element {
  const fonts = useFonts()
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
          <span style={{ fontSize: 12, fontFamily: fonts.sans }}>Add photos & files</span>
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
            <span style={{ fontSize: 12, fontFamily: fonts.sans, flex: 1 }}>MCP Tools</span>
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
      </Dropdown>
    </div>
  )
}

function ModelDropdown({ models, activeId, filter, onFilterChange, providerIcon, noun, onSelect }: {
  models: ModelOption[]; activeId: string; filter: string; onFilterChange: (v: string) => void
  providerIcon: React.ReactNode; noun: 'model' | 'agent'; onSelect: (id: string) => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useFonts()
  const inputRef = useRef<HTMLInputElement>(null)
  const hasMany = models.length > 6

  useEffect(() => { if (hasMany) inputRef.current?.focus() }, [hasMany])

  const filtered = filter
    ? models.filter(m => m.label.toLowerCase().includes(filter.toLowerCase()) || m.id.toLowerCase().includes(filter.toLowerCase()))
    : models

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
        scrollbarWidth: 'thin',
      }}>
        {filtered.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 11, color: theme.chat.muted, fontFamily: fonts.sans }}>
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

function DropdownItem({ icon, label, sublabel, active, onClick }: {
  icon?: React.ReactNode; label: string; sublabel?: string; active: boolean; onClick: () => void
}): JSX.Element {
  const fonts = useFonts()
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
        fontFamily: fonts.sans,
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
