import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import type { AppTheme } from '../../theme'

// --- Types ----------------------------------------------------------------------

// `never` = persistent deny (mirrors `forever` but negative). Future calls
// for the same provider/tool/workspace are auto-rejected without prompting.
export type ToolPermissionDecision = 'deny' | 'never' | 'once' | 'session' | 'today' | 'forever'

export interface ToolPermissionRequest {
  toolId: string | null
  toolName: string
  provider: string
  title?: string | null
  description?: string | null
  blockedPath?: string | null
  workspaceDir?: string | null
}

export interface ToolPermissionOption {
  id: ToolPermissionDecision
  label: string
  hint: string
  tone: 'deny' | 'allow' | 'scope'
}

export interface ToolPermissionFonts {
  sans: string
  mono: string
}

export const DEFAULT_PERMISSION_OPTIONS: ToolPermissionOption[] = [
  { id: 'deny', label: 'Deny', hint: 'Block this call', tone: 'deny' },
  { id: 'never', label: 'Never', hint: 'Always block this tool', tone: 'deny' },
  { id: 'once', label: 'Allow Once', hint: 'Just this call', tone: 'allow' },
  { id: 'session', label: 'This Session', hint: 'Until chat resets', tone: 'scope' },
  { id: 'today', label: 'All Day', hint: 'Expires tonight', tone: 'scope' },
  { id: 'forever', label: 'Always', hint: 'Persist across reloads', tone: 'scope' },
]

const DEFAULT_FONTS: ToolPermissionFonts = {
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace',
}

// --- Shared context (map of pending + resolved permissions per card) ------------

export interface ToolPermissionContextValue {
  cardId: string
  pending: Map<string, ToolPermissionRequest>
  resolved: Map<string, ToolPermissionDecision>
  onDecide?: (args: { cardId: string; toolId: string; decision: ToolPermissionDecision }) =>
    Promise<{ ok: boolean; error?: string } | void> | void
}

export const ToolPermissionContext = createContext<ToolPermissionContextValue | null>(null)

export function useToolPermissionContext(): ToolPermissionContextValue | null {
  return useContext(ToolPermissionContext)
}

export interface ToolPermissionProviderProps {
  cardId: string
  pending: Map<string, ToolPermissionRequest>
  resolved: Map<string, ToolPermissionDecision>
  onDecide?: ToolPermissionContextValue['onDecide']
  children: React.ReactNode
}

export function ToolPermissionProvider({
  cardId,
  pending,
  resolved,
  onDecide,
  children,
}: ToolPermissionProviderProps): JSX.Element {
  const value = useMemo<ToolPermissionContextValue>(() => ({
    cardId,
    pending,
    resolved,
    onDecide,
  }), [cardId, pending, resolved, onDecide])
  return <ToolPermissionContext.Provider value={value}>{children}</ToolPermissionContext.Provider>
}

// --- Card component -------------------------------------------------------------

export interface ToolPermissionCardProps {
  /** Stable id used for the data attribute + IPC round-trip. Usually the ToolBlock.id. */
  toolId: string
  /** Request payload with tool metadata (title, description, blockedPath). */
  request?: ToolPermissionRequest | null
  /** Fallback name when request is absent (e.g. resolved state without a pending request). */
  fallbackToolName?: string
  /** If set, renders in resolved mode (no buttons). */
  resolvedDecision?: ToolPermissionDecision | null
  /** Override the button list. Defaults to DEFAULT_PERMISSION_OPTIONS. */
  options?: ToolPermissionOption[]
  /** Decide handler. If omitted, falls back to context.onDecide. */
  onDecide?: ToolPermissionContextValue['onDecide']
  /** Theme override. Defaults to useTheme(). */
  theme?: AppTheme
  /** Font overrides. Defaults to app fonts. */
  fonts?: ToolPermissionFonts
}

export function ToolPermissionCard({
  toolId,
  request = null,
  fallbackToolName,
  resolvedDecision = null,
  options = DEFAULT_PERMISSION_OPTIONS,
  onDecide: onDecideProp,
  theme: themeProp,
  fonts: fontsProp,
}: ToolPermissionCardProps): JSX.Element {
  const ctx = useContext(ToolPermissionContext)
  const contextTheme = useTheme()
  const theme = themeProp ?? contextTheme
  const fonts = fontsProp ?? DEFAULT_FONTS
  const handler = onDecideProp ?? ctx?.onDecide

  const [submitting, setSubmitting] = useState<ToolPermissionDecision | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveRequest: ToolPermissionRequest = request ?? {
    toolId,
    toolName: fallbackToolName ?? 'Tool',
    provider: 'claude',
    title: null,
    description: null,
    blockedPath: null,
    workspaceDir: null,
  }

  const cardId = ctx?.cardId

  const decide = useCallback(async (decision: ToolPermissionDecision) => {
    if (!handler) {
      setError('No decision handler configured')
      return
    }
    if (!cardId) {
      setError('Missing card context')
      return
    }
    setSubmitting(decision)
    setError(null)
    try {
      const res = await handler({ cardId, toolId, decision })
      if (res && res.ok === false) {
        setError(res.error ?? 'Failed to submit')
        setSubmitting(null)
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to submit')
      setSubmitting(null)
    }
  }, [handler, cardId, toolId])

  const isDenyDecision = resolvedDecision === 'deny' || resolvedDecision === 'never'
  const headerLabel = resolvedDecision
    ? (isDenyDecision ? (resolvedDecision === 'never' ? 'Blocked' : 'Denied') : 'Allowed')
    : 'Permission needed'
  const headerColor = isDenyDecision
    ? theme.status.danger
    : resolvedDecision
      ? theme.status.success
      : theme.status.warning

  return (
    <div
      data-tool-permission={toolId}
      style={{
        background: theme.chat.assistantBubble,
        border: `1px solid ${theme.chat.assistantBubbleBorder}`,
        borderLeft: `3px solid ${headerColor}`,
        borderRadius: 10,
        overflow: 'hidden',
        alignSelf: 'stretch',
        width: '100%',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px',
        fontSize: 10.5,
        fontFamily: fonts.sans,
        color: theme.chat.muted,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
      }}>
        <ShieldCheck size={11} color={headerColor} />
        <span style={{ color: headerColor }}>{headerLabel}</span>
        <span style={{ textTransform: 'none', letterSpacing: 0, color: theme.chat.text, fontWeight: 500 }}>
          {effectiveRequest.toolName}
        </span>
      </div>

      <div style={{
        padding: '0 12px 10px',
        fontSize: 12,
        fontFamily: fonts.sans,
        color: theme.chat.text,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {effectiveRequest.title && (
          <div style={{ fontWeight: 500 }}>{effectiveRequest.title}</div>
        )}
        {effectiveRequest.description && (
          <div style={{ color: theme.chat.muted }}>{effectiveRequest.description}</div>
        )}
        {effectiveRequest.blockedPath && (
          <div style={{ color: theme.chat.muted, fontFamily: fonts.mono, fontSize: 11 }}>
            {effectiveRequest.blockedPath}
          </div>
        )}
      </div>

      {!resolvedDecision && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 6,
          padding: '0 12px 12px',
        }}>
          {options.map(opt => {
            const busy = submitting !== null
            const isSelf = submitting === opt.id
            const tone = opt.tone
            const bg = tone === 'deny'
              ? '#3a1a1a'
              : tone === 'allow'
                ? '#1a3a1a'
                : theme.chat.assistantBubble
            const borderColor = tone === 'deny'
              ? '#5a2a2a'
              : tone === 'allow'
                ? '#2a5a2a'
                : theme.chat.assistantBubbleBorder
            return (
              <button
                key={opt.id}
                onClick={() => decide(opt.id)}
                disabled={busy}
                style={{
                  background: bg,
                  border: `1px solid ${borderColor}`,
                  color: theme.chat.text,
                  padding: '6px 10px',
                  borderRadius: 6,
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: busy && !isSelf ? 0.5 : 1,
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                  gap: 2,
                  minWidth: 92,
                }}
                title={opt.hint}
              >
                <span style={{ fontWeight: 500 }}>{opt.label}</span>
                <span style={{ fontSize: 10, color: theme.chat.muted }}>{opt.hint}</span>
              </button>
            )
          })}
        </div>
      )}

      {resolvedDecision && (
        <div style={{
          padding: '0 12px 10px',
          fontSize: 11,
          fontFamily: fonts.sans,
          color: theme.chat.muted,
        }}>
          {resolvedDecision === 'deny'
            ? 'Tool call blocked.'
            : resolvedDecision === 'never'
              ? 'Tool blocked — future calls will be auto-rejected.'
              : resolvedDecision === 'once'
                ? 'Allowed for this call.'
                : resolvedDecision === 'session'
                  ? 'Allowed for this session.'
                  : resolvedDecision === 'today'
                    ? 'Allowed for the rest of today.'
                    : 'Allowed always.'}
        </div>
      )}

      {error && (
        <div style={{
          padding: '0 12px 10px',
          fontSize: 11,
          color: theme.status.danger,
        }}>
          {error}
        </div>
      )}
    </div>
  )
}
