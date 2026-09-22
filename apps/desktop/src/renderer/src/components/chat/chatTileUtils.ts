import type {
  ExtensionChatModel,
  ExtensionChatProviderConfig,
} from '../../../../shared/types'
import { isImagePath } from '../../utils/dnd'
import type { ToolBlock, ChatMessage, FileChange } from '../../../../shared/chat-types'
import { normalizeToolName } from '../../../../shared/tool-normalization.ts'
import type { SessionEntryHint } from '../../../../shared/session-types'
import { buildChatMessageHistoryFingerprint } from '../../../../shared/chat-history'
import { normalizeChatSurfacePayload, type ChatSurfacePayload } from '../chatSurfaceHostRpc'
import { isBuiltinProvider } from '../../config/providers'
import {
  loadTrustedRecentEditFiles,
  type RecentEditOrigin,
} from './recentEditContextReader.ts'
export { buildBlockNotesContext } from './boundedBlockNotes.ts'

export const CHAT_DEFAULT_SKILL_LOCATIONS = [
  '$HOME/.claude/commands',
  '$WORKSPACE/.claude/commands',
  '$HOME/.claude/skills',
  '$WORKSPACE/.claude/skills',
  '$HOME/.config/opencode/skills',
  '$WORKSPACE/.opencode/skills',
  '$WORKSPACE/.cursor/rules',
  '$WORKSPACE/.continue/prompts',
].join('\n')

export function resolveChatSkillLocations(raw: string, homePath: string, workspacePath: string | null): string[] {
  return raw
    .split('\n')
    .map(line => {
      // Strip optional surrounding quotes and convert shell-style escapes
      // (e.g. `Application\ Support`) into literal characters. Without this
      // a pasted shell path silently fails the `readDir` lookup.
      let l = line.trim()
      if (!l) return ''
      if ((l.startsWith('"') && l.endsWith('"')) || (l.startsWith("'") && l.endsWith("'"))) l = l.slice(1, -1)
      return l.replace(/\\([ \t()'"\\])/g, '$1')
    })
    .filter(Boolean)
    .filter(line => workspacePath || !line.startsWith('$WORKSPACE'))
    .map(line => line.replace(/^\$HOME/, homePath).replace(/^\$WORKSPACE/, workspacePath ?? ''))
}

export function shouldRenderToolBlock(block: ToolBlock): boolean {
  return block.status === 'running'
    || (block.fileChanges?.length ?? 0) > 0
    || (block.commandEntries?.length ?? 0) > 0
    || Boolean(block.summary?.trim())
    || Boolean(block.input?.trim())
}

/**
 * Heuristic: does a queued-message body look like pasted error output?
 *
 * Triggered when the user pastes a stack trace / console log into the
 * composer so the queue bar can flag it visually (red tint, alert icon).
 * Matches on common logger prefixes, error keywords, and file:line:col
 * patterns; requires the text to be either reasonably long OR to contain
 * an unambiguous signal like "Uncaught" so a plain message like
 * "fix the error in foo.ts" doesn't light up red.
 */
export function isUrgentQueuedContent(text: string): boolean {
  if (!text) return false
  const body = text.trim()
  if (body.length < 20) return false
  // Unambiguous error/panic markers — any one of these is enough.
  const strongPatterns = [
    /\buncaught\b/i,
    /\bunhandled (?:promise )?rejection\b/i,
    /\bstack trace\b/i,
    /\btraceback\b/i,
    /\bsegmentation fault\b/i,
    /\bfatal\b/i,
    /\bpanic:/i,
    /\bexception\b.*\bat\b/is,
    /^\s*at\s+\S+\s*\(.+:\d+:\d+\)/m,                  // JS stack frame
    /\bERR_[A-Z_]+\b/,                                  // Node error codes
    /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):/,
  ]
  for (const re of strongPatterns) {
    if (re.test(body)) return true
  }
  // Weaker signals: need multiple matches or bulk size to count.
  const weakPatterns = [
    /\berror\b/i,
    /\bwarning\b/i,
    /\bfailed\b/i,
    /\bcannot\s+(?:read|find|resolve|access)\b/i,
    /\[Violation\]/,
  ]
  let weakHits = 0
  for (const re of weakPatterns) {
    if (re.test(body)) weakHits += 1
    if (weakHits >= 2) return true
  }
  // A single weak hit plus a long body (≥300 chars) likely indicates a
  // pasted log excerpt rather than a short imperative like "fix the error".
  return weakHits >= 1 && body.length >= 300
}

export interface PendingAttachment {
  path: string
  kind: 'image' | 'file'
  /** Opaque, one-shot host authority for picker/temp attachments. */
  capability?: string
}

/**
 * Chat-surface extension mounted above the composer (e.g. Sketch/Builder).
 * Multiple surfaces can stay resident as tabs; the host caches the latest
 * payload via RPC and flushes the active/dirty payloads to temp files on send.
 */
export interface ActiveChatSurface {
  extId: string
  surfaceId: string
  label: string
  icon?: string
  instanceId: string
  entryUrl: string
  emits: 'image' | 'text'
  height: number
  minHeight: number
  /** Last payload pushed up from the iframe via surface.setPayload */
  payload: ChatSurfacePayload | null
  /** Per-surface state exposed through window.contex.tile.getState/setState. */
  tileState: Record<string, unknown>
  /** Lightweight local context store for chat-surface peer coordination. */
  context: Record<string, unknown>
  /** Actions registered by the surface via window.contex.actions.register(). */
  registeredActions: Array<{ name: string; description: string }>
}

export function hasVisibleFileChangeStats(change: Pick<FileChange, 'additions' | 'deletions'>): boolean {
  return change.additions > 0 || change.deletions > 0
}

export function hasRenderableFileChangeDiff(change: Pick<FileChange, 'diff'>): boolean {
  return change.diff.trim().length > 0
}

export interface DiscoveryPeer {
  peerId: string
  peerType: string
  capabilities: string[]
  distance: number
  lastSeen: number
  actions?: Array<{ name: string; description: string }>
  filePath?: string
  label?: string
}

export function mergeAttachments(...groups: PendingAttachment[][]): PendingAttachment[] {
  const seen = new Set<string>()
  const merged: PendingAttachment[] = []
  for (const group of groups) {
    for (const item of group) {
      const path = item.path.trim()
      const key = item.capability ?? path
      if (!path || seen.has(key)) continue
      seen.add(key)
      merged.push({ ...item, path })
    }
  }
  return merged
}

export function getImplicitPeerImageAttachments(peers: DiscoveryPeer[]): PendingAttachment[] {
  return peers
    .filter(peer => peer.peerType === 'image' && typeof peer.filePath === 'string' && isImagePath(peer.filePath))
    .map(peer => ({ path: peer.filePath!.trim(), kind: 'image' as const }))
    .filter(item => item.path.length > 0)
}

export function normalizePersistedChatSurfaces(value: unknown): ActiveChatSurface[] {
  if (!Array.isArray(value)) return []
  return value.map((item): ActiveChatSurface | null => {
    if (!item || typeof item !== 'object') return null
    const surface = item as Partial<ActiveChatSurface> & Record<string, unknown>
    const extId = typeof surface.extId === 'string' ? surface.extId : ''
    const surfaceId = typeof surface.surfaceId === 'string' ? surface.surfaceId : ''
    const instanceId = typeof surface.instanceId === 'string' ? surface.instanceId : ''
    const entryUrl = typeof surface.entryUrl === 'string' ? surface.entryUrl : ''
    if (!extId || !surfaceId || !instanceId || !entryUrl) return null
    const tileState = surface.tileState && typeof surface.tileState === 'object' && !Array.isArray(surface.tileState)
      ? { ...(surface.tileState as Record<string, unknown>) }
      : {}
    const context = surface.context && typeof surface.context === 'object' && !Array.isArray(surface.context)
      ? { ...(surface.context as Record<string, unknown>) }
      : {}
    const registeredActions = Array.isArray(surface.registeredActions)
      ? surface.registeredActions
        .filter((action: { name?: unknown; description?: unknown }) => action && typeof action.name === 'string')
        .map((action: { name: unknown; description?: unknown }) => ({ name: String(action.name), description: typeof action.description === 'string' ? action.description : '' }))
      : []
    return {
      extId,
      surfaceId,
      label: typeof surface.label === 'string' && surface.label ? surface.label : surfaceId,
      icon: typeof surface.icon === 'string' ? surface.icon : undefined,
      instanceId,
      entryUrl,
      emits: surface.emits === 'text' ? 'text' : 'image',
      height: typeof surface.height === 'number' && Number.isFinite(surface.height) ? surface.height : 260,
      minHeight: typeof surface.minHeight === 'number' && Number.isFinite(surface.minHeight) ? surface.minHeight : 160,
      payload: normalizeChatSurfacePayload(surface.payload ?? null),
      tileState,
      context,
      registeredActions,
    }
  }).filter((surface): surface is ActiveChatSurface => !!surface)
}

export function getToolDisplayName(name: string): string {
  return normalizeToolName(name).displayName
}

export function buildOutgoingMessageContent(draftInput: string, draftAttachments: PendingAttachment[]): string {
  const trimmedInput = draftInput.trim()
  const workspaceReferences = draftAttachments
    .filter(item => !item.capability)
    .map(item => item.path.replace(/[\r\n\0]/g, ''))
    .filter(path => path && !path.includes('"'))
    .map(path => `@file:"${path}"`)
    .join('\n')
  const capabilityBlock = draftAttachments.some(item => item.capability)
    ? [
        'Attached file capabilities:',
        ...draftAttachments
          .filter((item): item is PendingAttachment & { capability: string } => Boolean(item.capability))
          .map(item => `${item.capability}\t${item.path.replace(/[\r\n\t\0]/g, ' ').slice(0, 160)}`),
      ].join('\n')
    : ''
  return [trimmedInput, workspaceReferences, capabilityBlock].filter(Boolean).join('\n\n').trim()
}

export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function buildQueuedTurnPreview(content: string, attachmentCount: number): string {
  const trimmed = content.trim()
  const markerIndexes = ['Attached file paths:', 'Attached file capabilities:']
    .map(marker => trimmed.indexOf(marker))
    .filter(index => index >= 0)
  const attachmentMarkerIndex = markerIndexes.length > 0 ? Math.min(...markerIndexes) : -1
  const visibleText = attachmentMarkerIndex >= 0 ? trimmed.slice(0, attachmentMarkerIndex).trim() : trimmed
  const firstLine = visibleText.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const truncated = firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine
  if (truncated) return truncated
  if (attachmentCount > 0) return `Queued attachment${attachmentCount === 1 ? '' : 's'}`
  return 'Queued follow-up'
}

const RECENT_EDIT_CONTEXT_SNIPPET_LINE_LIMIT = 24
const RECENT_EDIT_CONTEXT_SURROUNDING_LINES = 4

export function shouldAttachRecentEditContext(userText: string): boolean {
  const normalized = userText.trim()
  if (!normalized) return false
  if (normalized.length > 320) return false

  const hasEditIntent = /\b(edit|change|adjust|tweak|move|nudge|shift|raise|lower|increase|decrease|reduce|make|set|resize|align|position|offset|widen|narrow|shorten|lengthen|bigger|smaller|higher|lower)\b/i.test(normalized)
    || /\b\d+(?:px|rem|em|%)\b/i.test(normalized)
  const refersToExistingThing = /\b(it|that|those|them|this|same|again|more|further|another|still|also|back|left|right|up|down|higher|lower|bigger|smaller)\b/i.test(normalized)
  return hasEditIntent && refersToExistingThing
}

export function resolveEditedFilePath(filePath: string, workspaceDir: string): string {
  const trimmed = String(filePath ?? '').trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('/')) return trimmed
  return `${workspaceDir.replace(/\/+$/, '')}/${trimmed.replace(/^\/+/, '')}`
}

export function extractChangedLineRangesFromDiff(diff: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const line of String(diff ?? '').split('\n')) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!match) continue
    const start = Number(match[1] ?? '0')
    const count = Number(match[2] ?? '1')
    if (!Number.isFinite(start) || start <= 0) continue
    const safeCount = Number.isFinite(count) && count > 0 ? count : 1
    ranges.push({ start, end: start + safeCount - 1 })
  }
  return ranges
}

export function buildSnippetFromRanges(
  fileContent: string,
  ranges: Array<{ start: number; end: number }>,
  maxChars = RECENT_EDIT_CONTEXT_MAX_CHARS,
): string {
  if (maxChars <= 0) return ''
  const lines = String(fileContent ?? '').split(/\r?\n/)
  if (lines.length === 0) return ''
  const windows = ranges.length > 0
    ? ranges.slice(0, 3)
    : [{ start: 1, end: Math.min(lines.length, 8) }]

  const merged: Array<{ start: number; end: number }> = []
  for (const range of windows) {
    const next = {
      start: Math.max(1, range.start - RECENT_EDIT_CONTEXT_SURROUNDING_LINES),
      end: Math.min(lines.length, range.end + RECENT_EDIT_CONTEXT_SURROUNDING_LINES),
    }
    const previous = merged[merged.length - 1]
    if (previous && next.start <= previous.end + 2) {
      previous.end = Math.max(previous.end, next.end)
    } else {
      merged.push(next)
    }
  }

  let emittedLines = 0
  let emittedChars = 0
  const parts: string[] = []
  const appendPart = (value: string): boolean => {
    const separatorChars = parts.length > 0 ? 1 : 0
    const remaining = maxChars - emittedChars - separatorChars
    if (remaining <= 0) return false
    const part = value.length <= remaining
      ? value
      : `${value.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`
    parts.push(part)
    emittedChars += separatorChars + part.length
    return value.length <= remaining
  }
  for (const range of merged) {
    if (emittedLines >= RECENT_EDIT_CONTEXT_SNIPPET_LINE_LIMIT || emittedChars >= maxChars) break
    if (parts.length > 0 && !appendPart('...')) break
    for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
      if (emittedLines >= RECENT_EDIT_CONTEXT_SNIPPET_LINE_LIMIT) {
        appendPart('...')
        break
      }
      if (!appendPart(`${lineNumber}: ${lines[lineNumber - 1] ?? ''}`)) break
      emittedLines += 1
    }
  }
  return parts.join('\n').trim()
}

const RECENT_EDIT_CONTEXT_FILE_LIMIT = 3
const RECENT_EDIT_CONTEXT_MAX_CHARS = 5000

export async function buildRecentEditContext(
  messages: ChatMessage[],
  workspaceDir: string,
  userText: string,
  workspaceId?: string,
  activeOrigin?: RecentEditOrigin,
): Promise<string | null> {
  if (!shouldAttachRecentEditContext(userText) || !workspaceDir.trim() || !window.electron?.fs?.readFilePrefix) return null

  const recentChanges = await loadTrustedRecentEditFiles(
    messages,
    workspaceDir,
    activeOrigin,
    window.electron.fs,
    workspaceId,
    RECENT_EDIT_CONTEXT_FILE_LIMIT,
  )

  if (recentChanges.length === 0) return null

  let combined = 'Recent edit context from the immediately previous implementation pass. Use this only as fast-follow context if the user is referring to the same change area.'
  let sectionCount = 0
  for (const change of recentChanges) {
    try {
      const sectionPrefix = `${sectionCount > 0 ? '\n\n---\n\n' : '\n\n'}File: ${change.displayPath}\nRecent change type: ${change.changeType}\nCurrent nearby code:\n`
      const remaining = RECENT_EDIT_CONTEXT_MAX_CHARS - combined.length - sectionPrefix.length
      if (remaining <= 0) break
      const snippet = buildSnippetFromRanges(
        change.fileContent,
        extractChangedLineRangesFromDiff(change.diff),
        remaining,
      )
      if (!snippet) continue
      combined += sectionPrefix + snippet
      sectionCount += 1
      if (combined.length >= RECENT_EDIT_CONTEXT_MAX_CHARS) break
    } catch {
      // If the file no longer exists or can't be read, skip it quietly.
    }
  }

  return sectionCount > 0 ? combined : null
}

export function splitMessageAttachmentPaths(text: string): {
  bodyText: string
  attachmentPaths: string[]
} {
  const markers = ['Attached file capabilities:', 'Attached file paths:']
  const normalized = String(text ?? '')
  const marker = markers.find(candidate => normalized.includes(candidate))
  const attachmentMarkerIndex = marker ? normalized.indexOf(marker) : -1
  if (attachmentMarkerIndex < 0) {
    return {
      bodyText: normalized,
      attachmentPaths: [],
    }
  }

  const bodyText = normalized.slice(0, attachmentMarkerIndex).trim()
  const attachmentText = normalized.slice(attachmentMarkerIndex + marker!.length).trim()
  const attachmentPaths = attachmentText
    .split(/\r?\n/)
    .map(line => line.includes('\t') ? line.slice(line.indexOf('\t') + 1).trim() : line.trim())
    .filter(Boolean)

  if (attachmentPaths.length === 0) {
    return {
      bodyText: normalized,
      attachmentPaths: [],
    }
  }

  return {
    bodyText,
    attachmentPaths,
  }
}

/**
 * Extracts the set of absolute file paths that the model demonstrably "read"
 * across a conversation. We only consider tools that actually load file
 * bytes into the model's context:
 *   - `Read` — canonical file read (images returned as image blocks by the harness)
 *   - `NotebookEdit` / `NotebookRead` — ditto for notebooks
 *
 * Paths referenced by write/edit tools are excluded: writing to a path does
 * not guarantee the model loaded the file contents first. The output is only
 * used to drive the "image was read" tick on attachment chips, so being
 * conservative here is important — the tick must never lie.
 */
export function collectModelReadPaths(messages: ChatMessage[]): Set<string> {
  const paths = new Set<string>()
  for (const msg of messages) {
    const blocks = msg.toolBlocks
    if (!blocks || blocks.length === 0) continue
    for (const block of blocks) {
      if (block.name !== 'Read' && block.name !== 'NotebookRead') continue
      // Only count a read as successful if the tool finished without error —
      // a failed Read (e.g. file missing) did not actually load anything into
      // context, so the tick would be misleading.
      if (block.status !== 'done') continue
      if (!block.input) continue
      try {
        const parsed = JSON.parse(block.input) as Record<string, unknown>
        const filePath = typeof parsed.file_path === 'string' ? parsed.file_path : null
        if (filePath) paths.add(filePath)
      } catch {
        // Non-JSON input — skip rather than guess.
      }
    }
  }
  return paths
}

export function canUsePagedLinkedHistory(
  linkedSessionEntryId: string | null | undefined,
  linkedSessionHint: SessionEntryHint | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!linkedSessionEntryId || !linkedSessionHint || !sessionId) return false
  return linkedSessionHint.source !== 'codesurf'
}

export function mergeHistoricalMessages(
  previous: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  if (incoming.length === 0) return previous
  const seen = new Set<string>()
  const out: ChatMessage[] = []
  for (const message of [...previous, ...incoming]) {
    const key = buildChatMessageHistoryFingerprint(message)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(message)
  }
  out.sort((a, b) => a.timestamp - b.timestamp)
  return out
}

// Hex color helper: append an alpha component (00..ff) to a #rrggbb color.
// Used to derive a subtle accent-tinted background from theme.accent.base.
export function withAlpha(hex: string, alphaHex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
  return hex + alphaHex
}

export function looksLikeUnfencedDiff(text: string): boolean {
  const lines = text.split('\n')
  const hasHunk = lines.some(line => /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line.trim()))
  const hasReviewDiffHeader = lines.some(line => /^review diff\s+a\/.+\s+(?:→|->)\s+b\/.+@@/.test(line.trim()))
  const markdownTrapLines = lines.filter(line => /^[+-]\s{2,}\S/.test(line)).length
  return (hasHunk || hasReviewDiffHeader) && markdownTrapLines >= 2
}

export type ExternalAgentMarkupSegment =
  | { kind: 'md'; text: string }
  | { kind: 'tool'; block: ToolBlock }

export function splitExternalAgentMarkup(text: string): ExternalAgentMarkupSegment[] {
  const pattern = /\[external_agent_tool_call:\s*([^\]]+)\]([\s\S]*?)\[\/external_agent_tool_call\]|\[external_agent_tool_result(?::\s*([^\]]+))?\]([\s\S]*?)\[\/external_agent_tool_result\]/g
  const segments: ExternalAgentMarkupSegment[] = []
  let lastIndex = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index == null) continue
    const before = text.slice(lastIndex, match.index)
    if (before) segments.push({ kind: 'md', text: before })
    const callName = (match[1] ?? '').trim()
    const resultLabel = (match[3] ?? '').trim()
    const body = (match[2] ?? match[4] ?? '').trim()
    const isResult = !callName
    const isError = isResult && resultLabel.toLowerCase() === 'error'
    segments.push({
      kind: 'tool',
      block: {
        id: `external-agent-${match.index}-${index++}`,
        name: callName || resultLabel || 'result',
        input: body,
        status: isError ? 'error' : 'done',
      },
    })
    lastIndex = match.index + match[0].length
  }
  const tail = text.slice(lastIndex)
  if (tail) segments.push({ kind: 'md', text: tail })
  return segments.length > 0 ? segments : [{ kind: 'md', text }]
}

export function getExternalAgentToolBlocks(text: string): ToolBlock[] {
  return splitExternalAgentMarkup(text)
    .filter((segment): segment is Extract<ExternalAgentMarkupSegment, { kind: 'tool' }> => segment.kind === 'tool')
    .map(segment => segment.block)
}

export function isExternalAgentToolOnlyText(text: string): boolean {
  const segments = splitExternalAgentMarkup(text)
  return segments.some(segment => segment.kind === 'tool')
    && segments.every(segment => segment.kind === 'tool' || segment.text.trim().length === 0)
}

export function normalizeExtensionModels(value: unknown): ExtensionChatModel[] {
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

export function normalizeExtensionProviders(value: unknown): ExtensionChatProviderConfig[] {
  const rawProviders = Array.isArray(value) ? value : [value]
  return rawProviders.flatMap((item): ExtensionChatProviderConfig[] => {
    if (!item || typeof item !== 'object') return []
    const provider = item as Record<string, unknown>
    const id = typeof provider.id === 'string' ? provider.id.trim() : ''
    const label = typeof provider.label === 'string' ? provider.label.trim() : ''
    const transport = provider.transport
    if (!id || !label || !transport || typeof transport !== 'object') return []
    if (isBuiltinProvider(id)) return []

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

export function relativeTime(ts: number): string {
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
