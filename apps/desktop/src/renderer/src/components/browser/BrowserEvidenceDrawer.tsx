import React from 'react'
import { Bug, ClipboardCheck, ClipboardList, Trash2 } from 'lucide-react'
import type {
  BrowserEvidenceEvent,
  BrowserEvidenceSummary,
  BrowserPageHealth,
} from '../../../../shared/browserEvidence'
import { useAppFonts } from '../../FontContext'
import { useTheme } from '../../ThemeContext'
import {
  BROWSER_EVIDENCE_FILTERS,
  filterBrowserEvidence,
  type BrowserEvidenceFilter,
} from './browserEvidenceViewModel'

export interface BrowserEvidenceDrawerState {
  events: readonly BrowserEvidenceEvent[]
  filter: BrowserEvidenceFilter
  health: BrowserPageHealth
  summary: BrowserEvidenceSummary
  pageLabel: string
  healthColor: string
  copyStatus: string
  lastSnapshotAt: number | null
}

export interface BrowserEvidenceDrawerActions {
  close: () => void
  selectFilter: (filter: BrowserEvidenceFilter) => void
  captureSnapshot: () => void
  copyReport: () => void
  openQaWorkbench: () => void
  attachQaReportToChat: () => void
  clearEvidence: () => void
  markInteracting: () => void
}

interface Props {
  width: number
  height: number
  state: BrowserEvidenceDrawerState
  actions: BrowserEvidenceDrawerActions
}

export function BrowserEvidenceDrawer({
  width,
  height,
  state,
  actions,
}: Props): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const events = filterBrowserEvidence(state.events, state.filter)
  const actionStyle: React.CSSProperties = {
    border: `1px solid ${theme.border.default}`,
    borderRadius: 8,
    background: theme.surface.input,
    color: theme.text.secondary,
    cursor: 'pointer',
    padding: '6px 7px',
    fontSize: fonts.secondarySize - 1,
  }
  const iconActionStyle: React.CSSProperties = {
    ...actionStyle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  }

  return (
    <div
      aria-label="Evidence drawer"
      onMouseDown={event => {
        event.stopPropagation()
        actions.markInteracting()
      }}
      onClick={event => event.stopPropagation()}
      style={{
        position: 'absolute',
        top: 42,
        right: 8,
        width: Math.min(Math.max(width - 24, 260), 430),
        maxHeight: Math.max(160, height - 54),
        zIndex: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 10,
        borderRadius: 12,
        border: `1px solid ${theme.border.strong}`,
        background: theme.surface.panelElevated,
        boxShadow: theme.shadow.modal,
        color: theme.text.primary,
        fontSize: fonts.secondarySize,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: state.healthColor }} />
            Browser evidence
          </div>
          <div style={{
            color: theme.text.muted,
            fontSize: fonts.secondarySize - 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {state.health.label} · {state.summary.total} events · {state.pageLabel}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close evidence drawer"
          onClick={actions.close}
          style={{
            border: 'none',
            borderRadius: 6,
            background: theme.surface.hover,
            color: theme.text.secondary,
            cursor: 'pointer',
            padding: '3px 7px',
            fontSize: fonts.secondarySize,
          }}
        >
          Close
        </button>
      </div>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {BROWSER_EVIDENCE_FILTERS.map(filter => (
          <button
            key={filter.id}
            type="button"
            onClick={() => actions.selectFilter(filter.id)}
            style={{
              border: `1px solid ${state.filter === filter.id ? theme.border.accent : theme.border.default}`,
              borderRadius: 999,
              background: state.filter === filter.id ? theme.surface.selection : 'transparent',
              color: state.filter === filter.id ? theme.text.primary : theme.text.secondary,
              cursor: 'pointer',
              padding: '3px 8px',
              fontSize: fonts.secondarySize - 1,
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" title="Capture snapshot" onClick={actions.captureSnapshot} style={iconActionStyle}>
          <ClipboardList size={12} />
          Capture snapshot
        </button>
        <button type="button" title="Copy report" onClick={actions.copyReport} style={actionStyle}>
          Copy report
        </button>
        <button type="button" title="Open QA Workbench" onClick={actions.openQaWorkbench} style={iconActionStyle}>
          <Bug size={12} />
          Workbench
        </button>
        <button type="button" title="Attach QA report to chat" onClick={actions.attachQaReportToChat} style={iconActionStyle}>
          <ClipboardCheck size={12} />
          Attach to chat
        </button>
        <button type="button" title="Clear evidence" onClick={actions.clearEvidence} style={iconActionStyle}>
          <Trash2 size={12} />
          Clear evidence
        </button>
      </div>

      {(state.copyStatus || state.lastSnapshotAt) && (
        <div style={{ color: theme.text.muted, fontSize: fonts.secondarySize - 1 }}>
          {state.copyStatus || 'Snapshot captured'}
          {state.lastSnapshotAt ? ` · ${new Date(state.lastSnapshotAt).toLocaleTimeString()}` : ''}
        </div>
      )}

      <div style={{
        overflow: 'auto',
        minHeight: 72,
        borderTop: `1px solid ${theme.border.subtle}`,
        paddingTop: 8,
      }}>
        {events.length === 0 ? (
          <div style={{ color: theme.text.muted, padding: '12px 4px' }}>
            No browser evidence matches this filter yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {events.map(event => (
              <div
                key={event.id}
                style={{
                  border: `1px solid ${theme.border.subtle}`,
                  borderLeft: `3px solid ${
                    event.severity === 'error'
                      ? theme.status.danger
                      : event.severity === 'warning'
                        ? theme.status.warning
                        : theme.border.accent
                  }`,
                  borderRadius: 8,
                  background: theme.surface.panel,
                  padding: '7px 8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{
                    color: event.severity === 'error'
                      ? theme.status.danger
                      : event.severity === 'warning'
                        ? theme.status.warning
                        : theme.text.secondary,
                    fontWeight: 700,
                  }}>
                    {event.kind} · {event.severity}
                  </span>
                  <span style={{ color: theme.text.muted, fontSize: fonts.secondarySize - 2 }}>
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div style={{
                  marginTop: 4,
                  color: theme.text.primary,
                  lineHeight: 1.35,
                  wordBreak: 'break-word',
                }}>
                  {event.message}
                </div>
                {(event.url || event.source || typeof event.line === 'number') && (
                  <div style={{
                    marginTop: 4,
                    color: theme.text.muted,
                    fontSize: fonts.secondarySize - 1,
                    lineHeight: 1.3,
                    wordBreak: 'break-word',
                  }}>
                    {event.url || event.source}
                    {typeof event.line === 'number' ? `:${event.line}` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
