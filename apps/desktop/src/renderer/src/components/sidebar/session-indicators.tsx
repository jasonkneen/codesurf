/**
 * Session sidebar indicators + read-watermark / pinned-session helpers —
 * extracted verbatim from Sidebar.tsx. Pure helpers plus the small
 * SessionSidebarIndicator presentational component.
 */
import React from 'react'
import { useTheme } from '../../ThemeContext'
import type { SessionEntry } from './types'
import { getSessionAgentKey, getSessionAgentLabel, SpinnerIcon } from './utils'

const GENERIC_SESSION_SOURCE_DETAILS = new Set(['transcript', 'conversation', 'project session', 'user session'])
const SESSION_READ_WATERMARKS_STORAGE_KEY = 'codesurf.sidebar.sessionReadWatermarks.v1'
const PINNED_SESSION_KEYS_STORAGE_KEY = 'codesurf.sidebar.pinnedSessionKeys.v1'
export type SessionReadWatermarks = Record<string, number>
export type PinnedSessionKeys = Record<string, true>

export function getSessionSidebarIndicatorColor(session: SessionEntry, theme: ReturnType<typeof useTheme>): string {
  const key = getSessionAgentKey(session)
  if (key === 'codex') return '#6ea8ff'
  if (key === 'claude') return '#d9a066'
  if (key === 'cursor') return '#b792ff'
  if (key === 'openclaw') return '#62cfa6'
  if (key === 'opencode') return '#64d2ff'
  if (key === 'csagent' || key === 'pi') return '#a78bfa'
  if (key === 'codesurf') return '#95a1b3'
  return theme.accent.base
}

export function getSessionActivityKey(session: SessionEntry): string {
  const agentKey = getSessionAgentKey(session)
  const sessionId = session.sessionId?.trim()
  if (sessionId) return `${agentKey}:session:${sessionId}`
  const filePath = session.filePath?.trim()
  if (filePath) return `${agentKey}:file:${filePath}`
  return `${agentKey}:entry:${session.workspaceId}:${session.id}`
}

export function getSessionSelectionKey(session: SessionEntry): string {
  return `${session.workspaceId}:${session.id}`
}

export function loadSessionReadWatermarks(): SessionReadWatermarks {
  try {
    const raw = window.localStorage.getItem(SESSION_READ_WATERMARKS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: SessionReadWatermarks = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== 'string' || typeof value !== 'number') continue
      if (!Number.isFinite(value) || value <= 0) continue
      next[key] = value
    }
    return next
  } catch {
    return {}
  }
}

export function saveSessionReadWatermarks(watermarks: SessionReadWatermarks): void {
  try {
    window.localStorage.setItem(SESSION_READ_WATERMARKS_STORAGE_KEY, JSON.stringify(watermarks))
  } catch {
    // Ignore storage failures; unread dots are a non-critical UI affordance.
  }
}

export function loadPinnedSessionKeys(): PinnedSessionKeys {
  try {
    const raw = window.localStorage.getItem(PINNED_SESSION_KEYS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: PinnedSessionKeys = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && value === true) next[key] = true
    }
    return next
  } catch {
    return {}
  }
}

export function savePinnedSessionKeys(keys: PinnedSessionKeys): void {
  try {
    window.localStorage.setItem(PINNED_SESSION_KEYS_STORAGE_KEY, JSON.stringify(keys))
  } catch {
    // Pinning is a local affordance; ignore storage failures.
  }
}

export function hasUnreadSessionUpdate(session: SessionEntry, watermarks: SessionReadWatermarks): boolean {
  const seenAt = watermarks[getSessionActivityKey(session)] ?? session.updatedAt
  return session.updatedAt > seenAt
}

export function SessionSidebarIndicator({
  session,
  streaming,
  muted = false,
  theme,
}: {
  session: SessionEntry
  streaming: boolean
  muted?: boolean
  theme: ReturnType<typeof useTheme>
}): React.JSX.Element {
  if (streaming) {
    return <SpinnerIcon size={14} color={muted ? theme.text.disabled : theme.text.muted} />
  }

  const dotColor = getSessionSidebarIndicatorColor(session, theme)
  return (
    <span
      aria-hidden="true"
      style={{
        width: 14,
        height: 14,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: muted ? 0.52 : 1,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${dotColor} 42%, transparent)`,
        }}
      />
    </span>
  )
}

export function formatSessionSidebarSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 0 : 1)}KB`
  if (bytes < 10 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes < 100 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

export function formatSessionSidebarMeta(session: SessionEntry): string {
  const parts: string[] = []
  const detail = String(session.sourceDetail ?? '').trim()
  const normalizedDetail = detail.toLowerCase()
  const sizeLabel = formatSessionSidebarSize(session.sizeBytes)

  parts.push(getSessionAgentLabel(session))
  if (detail && !GENERIC_SESSION_SOURCE_DETAILS.has(normalizedDetail)) {
    parts.push(detail)
  }
  if (sizeLabel) parts.push(sizeLabel)

  return parts.join(' • ')
}


