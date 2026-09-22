/**
 * Per-workspace, per-tile chat message store with stream isolation.
 *
 * Transcript subscribers observe the messages snapshot (new reference whenever
 * messages change). Non-transcript "chrome" subscribers observe a chrome
 * snapshot that stays referentially stable across pure assistant-text stream
 * flushes (content / contentBlocks text growth on the last streaming message).
 *
 * One source of truth for live messages per workspace tile — React tiles
 * subscribe via useSyncExternalStore; stream buffer and stream handler write
 * here. Tile ids are only unique inside a workspace, so every store path must
 * include both ids.
 */

import type { ChatMessage } from '../../../../shared/chat-types'

export type ChatChromeSnapshot = {
  /** Bumps only when a non-text-only messages update lands. */
  revision: number
}

export type ChatMessagesSnapshot = {
  messages: readonly ChatMessage[]
  /** Bumps on every messages change (including pure text stream). */
  revision: number
}

type TileEntry = {
  messages: ChatMessage[]
  messagesRevision: number
  chromeRevision: number
  messagesSnapshot: ChatMessagesSnapshot
  chromeSnapshot: ChatChromeSnapshot
  listeners: Set<() => void>
}

const tiles = new Map<string, TileEntry>()

const EMPTY_MESSAGES: ChatMessage[] = []

function emptyMessagesSnapshot(): ChatMessagesSnapshot {
  return { messages: EMPTY_MESSAGES, revision: 0 }
}

function emptyChromeSnapshot(): ChatChromeSnapshot {
  return { revision: 0 }
}

function getWorkspaceTileKey(workspaceId: string, tileId: string): string {
  return JSON.stringify([workspaceId, tileId])
}

function ensureTile(workspaceId: string, tileId: string): TileEntry {
  const key = getWorkspaceTileKey(workspaceId, tileId)
  let entry = tiles.get(key)
  if (entry) return entry
  entry = {
    messages: [],
    messagesRevision: 0,
    chromeRevision: 0,
    messagesSnapshot: emptyMessagesSnapshot(),
    chromeSnapshot: emptyChromeSnapshot(),
    listeners: new Set(),
  }
  tiles.set(key, entry)
  return entry
}

/**
 * True when `next` only appends/extends streaming assistant text on the last
 * message vs `prev` (same length, same prefix refs, last message still streaming).
 */
export function isPureTextStreamUpdate(
  prev: readonly ChatMessage[],
  next: readonly ChatMessage[],
): boolean {
  if (prev.length !== next.length || prev.length === 0) return false
  for (let i = 0; i < prev.length - 1; i++) {
    if (prev[i] !== next[i]) return false
  }
  const a = prev[prev.length - 1]
  const b = next[prev.length - 1]
  if (!a || !b) return false
  if (a.id !== b.id || a.role !== 'assistant') return false
  if (!a.isStreaming || !b.isStreaming) return false
  // Structural / tool / thinking identity must be unchanged (same refs preferred).
  if (a.toolBlocks !== b.toolBlocks) return false
  if (a.thinkingBlocks !== b.thinkingBlocks) return false
  if (a.thinking !== b.thinking) return false
  if (a.note !== b.note) return false
  if (a.cost !== b.cost || a.turns !== b.turns) return false
  // Content must actually change for this to count as a text stream update.
  if (a.content === b.content && a.contentBlocks === b.contentBlocks) return false
  return true
}

function publish(
  entry: TileEntry,
  nextMessages: ChatMessage[],
  pureText: boolean,
): void {
  entry.messages = nextMessages
  entry.messagesRevision += 1
  if (!pureText) {
    entry.chromeRevision += 1
    entry.chromeSnapshot = { revision: entry.chromeRevision }
  }
  entry.messagesSnapshot = {
    messages: nextMessages,
    revision: entry.messagesRevision,
  }
  for (const listener of entry.listeners) {
    try { listener() } catch { /* ignore subscriber errors */ }
  }
}

export function getTileMessages(workspaceId: string, tileId: string): ChatMessage[] {
  return ensureTile(workspaceId, tileId).messages
}

export function getTileMessagesSnapshot(
  workspaceId: string,
  tileId: string,
): ChatMessagesSnapshot {
  return ensureTile(workspaceId, tileId).messagesSnapshot
}

export function getTileChromeSnapshot(
  workspaceId: string,
  tileId: string,
): ChatChromeSnapshot {
  return ensureTile(workspaceId, tileId).chromeSnapshot
}

export function subscribeTileMessages(
  workspaceId: string,
  tileId: string,
  listener: () => void,
): () => void {
  const entry = ensureTile(workspaceId, tileId)
  entry.listeners.add(listener)
  return () => { entry.listeners.delete(listener) }
}

/** Replace or update messages for a tile. Detects pure text stream updates. */
export function updateTileMessages(
  workspaceId: string,
  tileId: string,
  updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
): ChatMessage[] {
  const entry = ensureTile(workspaceId, tileId)
  const prev = entry.messages
  const next = typeof updater === 'function' ? updater(prev) : updater
  if (next === prev) return prev
  // Shallow equality of array contents (same refs, same length)
  if (
    next.length === prev.length
    && next.every((m, i) => m === prev[i])
  ) {
    return prev
  }
  const pureText = isPureTextStreamUpdate(prev, next)
  publish(entry, next, pureText)
  return next
}

/** Seed or hard-replace messages (e.g. session load). Always bumps chrome. */
export function replaceTileMessages(
  workspaceId: string,
  tileId: string,
  messages: ChatMessage[],
): void {
  const entry = ensureTile(workspaceId, tileId)
  publish(entry, messages, false)
}

/**
 * Append text onto the last streaming assistant message (stream buffer flush).
 * Pure-text path — chrome snapshot stays stable.
 */
export function appendStreamingAssistantText(
  workspaceId: string,
  tileId: string,
  text: string,
): ChatMessage[] {
  if (!text) return getTileMessages(workspaceId, tileId)
  return updateTileMessages(workspaceId, tileId, prev => {
    const last = prev[prev.length - 1]
    if (!last?.isStreaming || last.role !== 'assistant') return prev
    const blocks = [...(last.contentBlocks ?? [])]
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock?.type === 'text') {
      blocks[blocks.length - 1] = { ...lastBlock, text: lastBlock.text + text }
    } else {
      blocks.push({ type: 'text', text })
    }
    return [
      ...prev.slice(0, -1),
      { ...last, content: last.content + text, contentBlocks: blocks },
    ]
  })
}

/** Test / session teardown helper. */
export function clearTileMessages(workspaceId: string, tileId: string): void {
  tiles.delete(getWorkspaceTileKey(workspaceId, tileId))
}

/** Test helper: clear all tiles. */
export function clearAllTileMessages(): void {
  tiles.clear()
}
