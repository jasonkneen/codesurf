/**
 * Pure transcript window selection — unmounts older messages above the visible
 * limit so long histories do not mount the full DOM list by default.
 *
 * Policy (shipped):
 * - Combine historical (prepended) + live messages, deduping by id when both exist.
 * - If combined length ≤ limit, render all.
 * - Otherwise render the last `limit` messages (latest window).
 * - Raising the limit reveals older messages without inventing duplicates.
 */

import type { ChatMessage } from '../../../../shared/chat-types'
// Numeric policy only — keep this module free of React so node:test can import it.
// Must stay in lockstep with chatTileLayout.ts (CHAT_RENDER_PAGE_SIZE * INITIAL_PAGES).
export const CHAT_RENDER_PAGE_SIZE = 20
export const CHAT_INITIAL_RENDER_PAGES = 2
export const CHAT_INITIAL_RENDER_WINDOW = CHAT_RENDER_PAGE_SIZE * CHAT_INITIAL_RENDER_PAGES

export type TranscriptWindowResult = {
  /** Messages that should mount in the transcript UI. */
  rendered: ChatMessage[]
  /** Full combined history (historical prefix + live), id-deduped. */
  combined: ChatMessage[]
  /** How many combined messages are hidden above the window. */
  hiddenCount: number
}

/**
 * Merge historical + live messages (historical first; live ids win on conflict),
 * then select the latest `visibleLimit` for rendering.
 */
export function selectTranscriptWindow(
  liveMessages: ChatMessage[],
  historicalMessages: ChatMessage[] = [],
  visibleLimit: number = CHAT_INITIAL_RENDER_WINDOW,
): TranscriptWindowResult {
  const limit = Math.max(0, Math.floor(visibleLimit))
  let combined: ChatMessage[]
  if (historicalMessages.length > 0) {
    const liveIds = new Set(liveMessages.map(m => m.id))
    combined = [
      ...historicalMessages.filter(m => !liveIds.has(m.id)),
      ...liveMessages,
    ]
  } else {
    combined = liveMessages
  }

  if (limit <= 0) {
    return { rendered: [], combined, hiddenCount: combined.length }
  }
  if (combined.length <= limit) {
    return { rendered: combined, combined, hiddenCount: 0 }
  }
  const rendered = combined.slice(-limit)
  return {
    rendered,
    combined,
    hiddenCount: combined.length - rendered.length,
  }
}

/** Grow the visible window by one page (scroll-up / load earlier). */
export function expandTranscriptWindow(
  currentLimit: number,
  pageSize: number = CHAT_RENDER_PAGE_SIZE,
): number {
  return currentLimit + Math.max(1, pageSize)
}

/** Reset to the default initial window (stick-to-bottom / jump to latest). */
export function resetTranscriptWindow(
  initial: number = CHAT_INITIAL_RENDER_WINDOW,
): number {
  return initial
}
