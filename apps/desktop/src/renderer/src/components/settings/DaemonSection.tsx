/**
 * Daemon settings section — extracted verbatim from SettingsPanel's
 * `case 'daemon'` render closure (A1 god-object split). Behaviour is unchanged:
 * the component reads theme/fonts from context and receives daemon + execution
 * state and callbacks as props. Types live here (the leaf) and are re-imported
 * by SettingsPanel to avoid a circular dependency.
 */
import React from 'react'
import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import type { AppSettings, AutoDreamSettings, ExecutionHostRecord, ExecutionMode } from '../../../../shared/types'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { NumInput, SectionLabel, SettingRow, TextInput, Toggle } from './controls'

export type DaemonStatus = {
  running: boolean
  info: {
    pid: number
    port: number
    startedAt: string
    protocolVersion: number
    appVersion: string | null
  } | null
}

export type ExecutionResolution = {
  host: ExecutionHostRecord
  fallback: boolean
  reason: string
}

export interface DaemonSectionProps {
  settings: AppSettings
  daemonStatus: DaemonStatus | null
  daemonLoading: boolean
  daemonRestarting: boolean
  daemonError: string | null
  loadDaemonStatus: () => void | Promise<void>
  handleRestartDaemon: () => void | Promise<void>
  updateAutoDreamPatch: (patch: Partial<AutoDreamSettings>) => void
  updateSettingsPatch: (patch: Partial<AppSettings>) => void
  executionHosts: ExecutionHostRecord[]
  executionHostsLoading: boolean
  executionHostsError: string | null
  executionResolution: ExecutionResolution | null
  saveExecutionHost: (host: ExecutionHostRecord) => Promise<void>
  removeExecutionHost: (id: string) => void | Promise<void>
  newHostLabel: string
  newHostUrl: string
  newHostToken: string
  setNewHostLabel: (value: string) => void
  setNewHostUrl: (value: string) => void
  setNewHostToken: (value: string) => void
}

export function DaemonSection(props: DaemonSectionProps): React.JSX.Element {
  const {
    settings,
    daemonStatus,
    daemonLoading,
    daemonRestarting,
    daemonError,
    loadDaemonStatus,
    handleRestartDaemon,
    updateAutoDreamPatch,
    updateSettingsPatch,
    executionHosts,
    executionHostsLoading,
    executionHostsError,
    executionResolution,
    saveExecutionHost,
    removeExecutionHost,
    newHostLabel,
    newHostUrl,
    newHostToken,
    setNewHostLabel,
    setNewHostUrl,
    setNewHostToken,
  } = props
  const theme = useTheme()
  const fonts = useAppFonts()

  const daemonRunning = daemonStatus?.running === true
  const daemonInfo = daemonStatus?.info ?? null
  const daemonStartedLabel = daemonInfo?.startedAt
    ? new Date(daemonInfo.startedAt).toLocaleString()
    : 'Unavailable'

  return (
    <>
      <SectionLabel label="Daemon" />
      <SettingRow label="Status" description="The detached CodeSurf daemon persists workspaces, projects, settings, and session indexing outside the renderer.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: daemonRunning ? theme.status.success : theme.status.danger,
              boxShadow: daemonRunning ? `0 0 8px ${theme.status.success}66` : 'none',
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: fonts.secondarySize, color: daemonRunning ? theme.text.secondary : theme.status.danger }}>
            {daemonLoading
              ? 'Checking…'
              : daemonRunning
                ? `Active${daemonInfo?.pid ? ` · PID ${daemonInfo.pid}` : ''}${daemonInfo?.port ? ` · port ${daemonInfo.port}` : ''}`
                : 'Offline'}
          </span>
        </div>
      </SettingRow>
      <SettingRow label="Runtime" description="Daemon boot time and protocol metadata.">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span style={{ fontSize: fonts.secondarySize, color: theme.text.secondary }}>
            Started {daemonStartedLabel}
          </span>
          <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontFamily: fonts.mono }}>
            protocol {daemonInfo?.protocolVersion ?? '—'} · app {daemonInfo?.appVersion ?? '—'}
          </span>
        </div>
      </SettingRow>
      <SettingRow label="Control" description="Refresh the status view or restart the daemon without quitting the app.">
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => { void loadDaemonStatus() }}
            disabled={daemonLoading || daemonRestarting}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              fontSize: fonts.secondarySize,
              fontWeight: 600,
              border: `1px solid ${theme.border.default}`,
              background: theme.surface.input,
              color: theme.text.secondary,
              cursor: daemonLoading || daemonRestarting ? 'not-allowed' : 'pointer',
              opacity: daemonLoading || daemonRestarting ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => { void handleRestartDaemon() }}
            disabled={daemonRestarting}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              fontSize: fonts.secondarySize,
              fontWeight: 600,
              border: `1px solid ${theme.border.default}`,
              background: theme.accent.soft,
              color: theme.accent.hover,
              cursor: daemonRestarting ? 'not-allowed' : 'pointer',
              opacity: daemonRestarting ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <RotateCcw size={14} />
            {daemonRestarting ? 'Restarting…' : 'Restart daemon'}
          </button>
        </div>
      </SettingRow>
      {daemonError && (
        <div style={{ fontSize: fonts.secondarySize, color: theme.status.danger, padding: '4px 2px' }}>
          {daemonError}
        </div>
      )}
      <SectionLabel label="Dreaming" />
      <SettingRow
        label="Auto-dream"
        description="Let the daemon consolidate recent workspace sessions into generated .codesurf/DREAMING.md memory."
      >
        <Toggle
          value={settings.autoDream.enabled}
          onChange={enabled => updateAutoDreamPatch({ enabled })}
        />
      </SettingRow>
      <SettingRow
        label="Fresh sessions"
        description="Minimum new or changed sessions required before the daemon starts an automatic dream."
      >
        <NumInput
          value={settings.autoDream.minSessions}
          min={1}
          max={20}
          onChange={value => updateAutoDreamPatch({ minSessions: Math.max(1, Math.min(20, Math.round(value || 1))) })}
        />
      </SettingRow>
      <SettingRow
        label="Cooldown"
        description="Minimum minutes between successful automatic dreams. Manual runs are still available from the dream API."
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <NumInput
            value={Math.round((settings.autoDream.minIntervalMs ?? 0) / 60000)}
            min={0}
            max={240}
            onChange={value => updateAutoDreamPatch({ minIntervalMs: Math.max(0, Math.min(240, Math.round(value || 0))) * 60000 })}
          />
          <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>min</span>
        </div>
      </SettingRow>
      <details style={{ marginBottom: 8 }}>
        <summary style={{ cursor: 'pointer', color: theme.text.disabled, fontSize: fonts.secondarySize, padding: '6px 2px' }}>
          Advanced auto-dream cadence
        </summary>
        <div style={{ marginTop: 8 }}>
          <SettingRow
            label="Sweep interval"
            description="Minutes between daemon background sweeps for externally written sessions. Set 0 to disable periodic sweeps."
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <NumInput
                value={Math.round((settings.autoDream.sweepMs ?? 0) / 60000)}
                min={0}
                max={120}
                onChange={value => updateAutoDreamPatch({ sweepMs: Math.max(0, Math.min(120, Math.round(value || 0))) * 60000 })}
              />
              <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>min</span>
            </div>
          </SettingRow>
          <SettingRow
            label="Trigger debounce"
            description="Seconds to wait after session updates before evaluating auto-dream thresholds."
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <NumInput
                value={Math.round((settings.autoDream.debounceMs ?? 0) / 1000)}
                min={0}
                max={120}
                onChange={value => updateAutoDreamPatch({ debounceMs: Math.max(0, Math.min(120, Math.round(value || 0))) * 1000 })}
              />
              <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>sec</span>
            </div>
          </SettingRow>
        </div>
      </details>
      <SectionLabel label="Execution" />
      <SettingRow
        label="Default routing"
        description="Choose whether new work prefers the local daemon, stays in-process, or pins to a specific registered host."
      >
        <select
          value={settings.execution?.mode ?? 'auto'}
          onChange={e => {
            const mode = e.target.value as ExecutionMode
            updateSettingsPatch({
              execution: {
                mode,
                hostId: mode === 'specific-host'
                  ? (settings.execution?.hostId ?? executionHosts.find(host => host.type === 'remote-daemon')?.id ?? null)
                  : null,
              },
            })
          }}
          style={{
            minWidth: 220,
            padding: '7px 32px 7px 10px',
            fontSize: fonts.secondarySize,
            fontWeight: 600,
            background: theme.surface.input,
            color: theme.text.secondary,
            border: `1px solid ${theme.border.default}`,
            borderRadius: 8,
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          <option value="auto">Auto</option>
          <option value="prefer-local-daemon">Prefer daemon</option>
          <option value="runtime-only">Runtime only</option>
          <option value="daemon-only">Daemon only</option>
          <option value="specific-host">Specific host</option>
        </select>
      </SettingRow>
      {(settings.execution?.mode ?? 'auto') === 'specific-host' && (
        <SettingRow
          label="Pinned host"
          description="Use one registered remote daemon for new work until you change the policy."
        >
          <select
            value={settings.execution?.hostId ?? ''}
            onChange={e => updateSettingsPatch({
              execution: {
                ...settings.execution,
                mode: 'specific-host',
                hostId: e.target.value || null,
              },
            })}
            style={{
              minWidth: 220,
              padding: '6px 10px',
              fontSize: fonts.secondarySize,
              background: theme.surface.input,
              color: theme.text.secondary,
              border: `1px solid ${theme.border.default}`,
              borderRadius: 8,
              outline: 'none',
            }}
          >
            <option value="">Select host…</option>
            {executionHosts.filter(host => host.type === 'remote-daemon' && host.enabled !== false).map(host => (
              <option key={host.id} value={host.id}>
                {host.label} · {host.type}
              </option>
            ))}
          </select>
        </SettingRow>
      )}
      <SettingRow
        label="Resolved target"
        description="What the current policy resolves to right now, using the daemon status and registered hosts."
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, maxWidth: 420 }}>
          <span style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, fontWeight: 600 }}>
            {executionResolution
              ? `${executionResolution.host.label}${executionResolution.fallback ? ' · fallback' : ''}`
              : 'Unavailable'}
          </span>
          <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, textAlign: 'right', lineHeight: 1.4 }}>
            {executionResolution?.reason ?? 'Execution routing has not been resolved yet.'}
          </span>
        </div>
      </SettingRow>
      <SectionLabel label="Hosts" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
        {executionHostsLoading && (
          <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, padding: '4px 2px' }}>
            Loading hosts…
          </div>
        )}
        {executionHosts.map(host => {
          const builtin = host.type !== 'remote-daemon'
          return (
            <div
              key={host.id}
              style={{
                background: theme.surface.panelMuted,
                border: `1px solid ${theme.border.default}`,
                borderRadius: 10,
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 600 }}>{host.label}</span>
                  <span style={{ fontSize: 10, color: theme.text.disabled, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{host.type}</span>
                  {builtin && (
                    <span style={{ fontSize: 10, color: theme.text.disabled, textTransform: 'uppercase', letterSpacing: '0.06em' }}>built-in</span>
                  )}
                </div>
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: host.url ? fonts.mono : undefined, marginTop: 3 }}>
                  {host.url || (host.type === 'runtime' ? 'In-process Electron main runtime' : 'Detached daemon on this machine')}
                </div>
              </div>
              {!builtin && (
                <>
                  <Toggle
                    value={host.enabled !== false}
                    onChange={value => { void saveExecutionHost({ ...host, enabled: value }) }}
                  />
                  <button
                    type="button"
                    onClick={() => { void removeExecutionHost(host.id) }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: theme.text.disabled,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          )
        })}
        <div
          style={{
            background: theme.surface.panelMuted,
            border: `1px dashed ${theme.border.default}`,
            borderRadius: 10,
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 600 }}>Add remote daemon</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <TextInput value={newHostLabel} onChange={setNewHostLabel} width={180} placeholder="Mac Mini" />
            <TextInput value={newHostUrl} onChange={setNewHostUrl} width={240} placeholder="https://daemon.example.com" />
            <TextInput value={newHostToken} onChange={setNewHostToken} width={200} placeholder="Optional token" />
            <button
              type="button"
              onClick={() => {
                const trimmedLabel = newHostLabel.trim()
                const trimmedUrl = newHostUrl.trim()
                if (!trimmedLabel || !trimmedUrl) return
                const id = trimmedLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `host-${Date.now()}`
                void saveExecutionHost({
                  id,
                  type: 'remote-daemon',
                  label: trimmedLabel,
                  url: trimmedUrl,
                  authToken: newHostToken.trim() || null,
                  enabled: true,
                }).then(() => {
                  setNewHostLabel('')
                  setNewHostUrl('')
                  setNewHostToken('')
                })
              }}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                fontSize: fonts.secondarySize,
                fontWeight: 600,
                border: `1px solid ${theme.border.default}`,
                background: theme.accent.soft,
                color: theme.accent.hover,
                cursor: 'pointer',
              }}
            >
              Add host
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled }}>
            <span>Label</span>
            <span>URL</span>
            <span>Token</span>
          </div>
        </div>
      </div>
      {executionHostsError && (
        <div style={{ fontSize: fonts.secondarySize, color: theme.status.danger, padding: '4px 2px' }}>
          {executionHostsError}
        </div>
      )}
    </>
  )
}
