import type { ExecutionHostRecord, ExecutionPreference } from '../../shared/types'

export const RUNTIME_HOST_ID = 'local-runtime'
export const LOCAL_DAEMON_HOST_ID = 'local-daemon'

export type ExecutionTargetResolution = {
  host: ExecutionHostRecord
  fallback: boolean
  reason: string
}

export function getBuiltinExecutionHosts(): ExecutionHostRecord[] {
  return [
    {
      id: RUNTIME_HOST_ID,
      type: 'runtime',
      label: 'This app',
      enabled: true,
      url: null,
      authToken: null,
    },
    {
      id: LOCAL_DAEMON_HOST_ID,
      type: 'local-daemon',
      label: 'Local daemon',
      enabled: true,
      url: 'http://127.0.0.1',
      authToken: null,
    },
  ]
}

function canonicalHostOrder(host: ExecutionHostRecord): number {
  if (host.id === RUNTIME_HOST_ID) return 0
  if (host.id === LOCAL_DAEMON_HOST_ID) return 1
  return 2
}

export function mergeExecutionHosts(records: ExecutionHostRecord[] | null | undefined): ExecutionHostRecord[] {
  const merged = new Map<string, ExecutionHostRecord>()

  for (const builtin of getBuiltinExecutionHosts()) {
    merged.set(builtin.id, builtin)
  }

  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.id) continue
    const trimmedId = String(record.id).trim()
    if (!trimmedId) continue
    const base = merged.get(trimmedId)
    merged.set(trimmedId, {
      ...(base ?? {}),
      ...record,
      id: trimmedId,
      label: String(record.label ?? base?.label ?? trimmedId).trim() || trimmedId,
      enabled: record.enabled !== false,
      url: typeof record.url === 'string' && record.url.trim().length > 0 ? record.url.trim() : null,
      authToken: typeof record.authToken === 'string' && record.authToken.trim().length > 0 ? record.authToken.trim() : null,
    })
  }

  return [...merged.values()].sort((a, b) => {
    const orderDelta = canonicalHostOrder(a) - canonicalHostOrder(b)
    if (orderDelta !== 0) return orderDelta
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  })
}

export function resolveExecutionTarget(args: {
  hosts: ExecutionHostRecord[]
  preference: ExecutionPreference
  localDaemonAvailable: boolean
}): ExecutionTargetResolution {
  const hosts = mergeExecutionHosts(args.hosts)
  const enabledHosts = hosts.filter(host => host.enabled !== false)
  const byId = new Map(enabledHosts.map(host => [host.id, host]))
  const runtime = byId.get(RUNTIME_HOST_ID) ?? getBuiltinExecutionHosts()[0]
  const localDaemon = byId.get(LOCAL_DAEMON_HOST_ID) ?? getBuiltinExecutionHosts()[1]

  switch (args.preference.mode) {
    case 'runtime-only':
      return { host: runtime, fallback: false, reason: 'Execution is pinned to the in-process runtime.' }
    case 'daemon-only':
      if (args.localDaemonAvailable) {
        return { host: localDaemon, fallback: false, reason: 'Execution requires the local daemon and it is available.' }
      }
      return { host: runtime, fallback: true, reason: 'Local daemon is unavailable, so the runtime is the only viable fallback.' }
    case 'specific-host': {
      const selected = args.preference.hostId ? byId.get(args.preference.hostId) : null
      if (selected) {
        return { host: selected, fallback: false, reason: `Execution is pinned to ${selected.label}.` }
      }
      if (args.localDaemonAvailable) {
        return { host: localDaemon, fallback: true, reason: 'Pinned host is missing or disabled, so execution fell back to the local daemon.' }
      }
      return { host: runtime, fallback: true, reason: 'Pinned host is missing or disabled, so execution fell back to the runtime.' }
    }
    case 'prefer-local-daemon':
      if (args.localDaemonAvailable) {
        return { host: localDaemon, fallback: false, reason: 'Execution prefers the local daemon and it is available.' }
      }
      return { host: runtime, fallback: true, reason: 'Local daemon is unavailable, so execution fell back to the runtime.' }
    case 'auto':
    default:
      if (args.localDaemonAvailable) {
        return { host: localDaemon, fallback: false, reason: 'Auto mode selected the local daemon.' }
      }
      return { host: runtime, fallback: true, reason: 'Auto mode fell back to the runtime because the local daemon is unavailable.' }
  }
}
