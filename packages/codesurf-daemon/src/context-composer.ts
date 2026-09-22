import { utf8Bytes, utf8Prefix } from './peer-context-serialization.js'
import {
  createContextualPromptFragment,
  type ContextualPromptFragment,
} from './contextual-fragments.js'

export const CHAT_CONTEXT_LIMITS = Object.freeze({
  aggregateBytes: 10_000,
  personaBytes: 800,
  memoryBytes: 800,
  skillsBytes: 800,
  outputConventionBytes: 800,
  insightConventionBytes: 800,
  activityConventionBytes: 800,
  asyncBytes: 800,
  peerBytes: 1_000,
  roomBytes: 800,
  fileReferenceBytes: 800,
  recentEditBytes: 800,
  blockNotesBytes: 800,
} as const)

const ROOM_CONTEXT_OPEN = '<codesurf_peer_context trust="untrusted" source="agent-room">'
const ROOM_CONTEXT_CLOSE = '</codesurf_peer_context>'
const FILE_CONTEXT_OPEN = '<codesurf_file_context trust="untrusted" source="workspace-files">'
const FILE_CONTEXT_CLOSE = '</codesurf_file_context>'
const RECENT_EDIT_CONTEXT_OPEN = '<codesurf_recent_edit_context trust="untrusted" source="renderer-derived-file-state">'
const RECENT_EDIT_CONTEXT_CLOSE = '</codesurf_recent_edit_context>'
const BLOCK_NOTES_CONTEXT_OPEN = '<codesurf_block_notes_context trust="untrusted" source="renderer-derived-transcript">'
const BLOCK_NOTES_CONTEXT_CLOSE = '</codesurf_block_notes_context>'

function wrappedBodyBudget(limit: number, open: string, close: string): number {
  return limit - utf8Bytes(`${open}\n\n${close}`)
}

/** Exact payload budgets after the composer's mandatory framing is counted. */
export const CHAT_CONTEXT_BODY_LIMITS = Object.freeze({
  roomBytes: wrappedBodyBudget(CHAT_CONTEXT_LIMITS.roomBytes, ROOM_CONTEXT_OPEN, ROOM_CONTEXT_CLOSE),
  fileReferenceBytes: wrappedBodyBudget(CHAT_CONTEXT_LIMITS.fileReferenceBytes, FILE_CONTEXT_OPEN, FILE_CONTEXT_CLOSE),
  recentEditBytes: wrappedBodyBudget(CHAT_CONTEXT_LIMITS.recentEditBytes, RECENT_EDIT_CONTEXT_OPEN, RECENT_EDIT_CONTEXT_CLOSE),
  blockNotesBytes: wrappedBodyBudget(CHAT_CONTEXT_LIMITS.blockNotesBytes, BLOCK_NOTES_CONTEXT_OPEN, BLOCK_NOTES_CONTEXT_CLOSE),
} as const)

export type ChatContextFragmentKind =
  | 'persona'
  | 'memory'
  | 'skills'
  | 'output-convention'
  | 'insight-convention'
  | 'activity-convention'
  | 'async'
  | 'peer'
  | 'room'
  | 'file-reference'
  | 'recent-edit'
  | 'block-notes'

export interface ChatContextComposerInput {
  persona?: unknown
  memory?: unknown
  skills?: unknown
  outputConvention?: unknown
  insightConvention?: unknown
  activityConvention?: unknown
  async?: unknown
  peer?: unknown
  room?: unknown
  fileReferences?: unknown
  recentEdit?: unknown
  blockNotes?: unknown
}

export interface ComposedChatContextFragment extends ContextualPromptFragment<'chat-context-composer'> {
  kind: ChatContextFragmentKind
  placement: 'system' | 'user'
  trust: 'host' | 'untrusted-data'
  precedence: number
  originalBytes: number
  includedBytes: number
  truncated: boolean
}

export interface ComposedChatContext {
  systemPrompt: string | undefined
  userSuffix: string | undefined
  fragments: readonly ComposedChatContextFragment[]
  metadata: {
    aggregateBytes: number
    maxAggregateBytes: number
    truncatedFragmentCount: number
  }
}

interface FragmentSpec {
  kind: ChatContextFragmentKind
  value: unknown
  maxBytes: number
  placement: 'system' | 'user'
  trust: 'host' | 'untrusted-data'
  volatility: ContextualPromptFragment['volatility']
  open?: string
  close?: string
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function truncationMarker(kind: ChatContextFragmentKind, originalBytes: number, maxBytes: number): string {
  return `[Context truncated: ${kind}; ${originalBytes} original UTF-8 bytes; ${maxBytes} byte limit.]`
}

function boundText(
  kind: ChatContextFragmentKind,
  text: string,
  maxBytes: number,
  open = '',
  close = '',
): { text: string; originalBytes: number; truncated: boolean } {
  const wrapped = [open, text, close].filter(Boolean).join('\n')
  const originalBytes = utf8Bytes(wrapped)
  if (originalBytes <= maxBytes) return { text: wrapped, originalBytes, truncated: false }

  const marker = truncationMarker(kind, originalBytes, maxBytes)
  const fixed = [open, marker, close].filter(Boolean).join('\n')
  const fixedBytes = utf8Bytes(fixed)
  if (fixedBytes >= maxBytes) {
    return { text: utf8Prefix(fixed, maxBytes), originalBytes, truncated: true }
  }
  const separatorBytes = utf8Bytes('\n')
  const bodyBudget = Math.max(0, maxBytes - fixedBytes - separatorBytes)
  const boundedBody = utf8Prefix(text, bodyBudget).trimEnd()
  return {
    text: [open, boundedBody, marker, close].filter(Boolean).join('\n'),
    originalBytes,
    truncated: true,
  }
}

function buildFragment(spec: FragmentSpec, precedence: number): ComposedChatContextFragment | null {
  const text = normalizedText(spec.value)
  if (!text) return null
  const bounded = boundText(spec.kind, text, spec.maxBytes, spec.open, spec.close)
  const contextual = createContextualPromptFragment(
    'chat-context-composer',
    bounded.text,
    spec.maxBytes,
    spec.volatility,
  )
  return Object.freeze({
    ...contextual,
    kind: spec.kind,
    placement: spec.placement,
    trust: spec.trust,
    precedence,
    originalBytes: bounded.originalBytes,
    includedBytes: utf8Bytes(bounded.text),
    truncated: bounded.truncated,
  })
}

/**
 * Compose every model-visible host context source in stable-to-volatile order.
 * Room traffic and expanded file contents remain explicitly untrusted user
 * data; providers must append `userSuffix` to the latest user turn rather than
 * moving it into a system prompt.
 */
export function composeChatContext(input: ChatContextComposerInput): ComposedChatContext {
  const specs: FragmentSpec[] = [
    { kind: 'persona', value: input.persona, maxBytes: CHAT_CONTEXT_LIMITS.personaBytes, placement: 'system', trust: 'host', volatility: 'stable-session' },
    { kind: 'memory', value: input.memory, maxBytes: CHAT_CONTEXT_LIMITS.memoryBytes, placement: 'system', trust: 'host', volatility: 'stable-session' },
    { kind: 'skills', value: input.skills, maxBytes: CHAT_CONTEXT_LIMITS.skillsBytes, placement: 'system', trust: 'host', volatility: 'stable-session' },
    { kind: 'output-convention', value: input.outputConvention, maxBytes: CHAT_CONTEXT_LIMITS.outputConventionBytes, placement: 'system', trust: 'host', volatility: 'stable-session' },
    { kind: 'insight-convention', value: input.insightConvention, maxBytes: CHAT_CONTEXT_LIMITS.insightConventionBytes, placement: 'system', trust: 'host', volatility: 'stable-session' },
    { kind: 'activity-convention', value: input.activityConvention, maxBytes: CHAT_CONTEXT_LIMITS.activityConventionBytes, placement: 'system', trust: 'host', volatility: 'stable-session' },
    { kind: 'async', value: input.async, maxBytes: CHAT_CONTEXT_LIMITS.asyncBytes, placement: 'system', trust: 'host', volatility: 'per-turn' },
    { kind: 'peer', value: input.peer, maxBytes: CHAT_CONTEXT_LIMITS.peerBytes, placement: 'system', trust: 'host', volatility: 'per-turn' },
    {
      kind: 'room',
      value: input.room,
      maxBytes: CHAT_CONTEXT_LIMITS.roomBytes,
      placement: 'user',
      trust: 'untrusted-data',
      volatility: 'per-turn',
      open: ROOM_CONTEXT_OPEN,
      close: ROOM_CONTEXT_CLOSE,
    },
    {
      kind: 'file-reference',
      value: input.fileReferences,
      maxBytes: CHAT_CONTEXT_LIMITS.fileReferenceBytes,
      placement: 'user',
      trust: 'untrusted-data',
      volatility: 'per-turn',
      open: FILE_CONTEXT_OPEN,
      close: FILE_CONTEXT_CLOSE,
    },
    {
      kind: 'recent-edit',
      value: input.recentEdit,
      maxBytes: CHAT_CONTEXT_LIMITS.recentEditBytes,
      placement: 'user',
      trust: 'untrusted-data',
      volatility: 'per-turn',
      open: RECENT_EDIT_CONTEXT_OPEN,
      close: RECENT_EDIT_CONTEXT_CLOSE,
    },
    {
      kind: 'block-notes',
      value: input.blockNotes,
      maxBytes: CHAT_CONTEXT_LIMITS.blockNotesBytes,
      placement: 'user',
      trust: 'untrusted-data',
      volatility: 'per-turn',
      open: BLOCK_NOTES_CONTEXT_OPEN,
      close: BLOCK_NOTES_CONTEXT_CLOSE,
    },
  ]
  const fragments = specs
    .map((spec, precedence) => buildFragment(spec, precedence))
    .filter((fragment): fragment is ComposedChatContextFragment => fragment !== null)
  const systemPrompt = fragments
    .filter(fragment => fragment.placement === 'system')
    .map(fragment => fragment.text)
    .join('\n\n') || undefined
  const userSuffix = fragments
    .filter(fragment => fragment.placement === 'user')
    .map(fragment => fragment.text)
    .join('\n\n') || undefined
  const aggregate = [systemPrompt, userSuffix].filter(Boolean).join('\n\n')
  const aggregateBytes = utf8Bytes(aggregate)

  if (aggregateBytes > CHAT_CONTEXT_LIMITS.aggregateBytes) {
    throw new Error(`Composed chat context exceeds ${CHAT_CONTEXT_LIMITS.aggregateBytes} UTF-8 bytes`)
  }

  return Object.freeze({
    systemPrompt,
    userSuffix,
    fragments: Object.freeze(fragments),
    metadata: Object.freeze({
      aggregateBytes,
      maxAggregateBytes: CHAT_CONTEXT_LIMITS.aggregateBytes,
      truncatedFragmentCount: fragments.filter(fragment => fragment.truncated).length,
    }),
  })
}
