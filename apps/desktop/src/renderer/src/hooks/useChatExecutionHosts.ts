import { useState, useEffect, useMemo } from 'react'
import type { ExecutionHostRecord, ExecutionPreference } from '../../../shared/types'

export interface UseChatExecutionHostsOptions {
  executionPreference?: ExecutionPreference | null
  executionTarget: 'local' | 'cloud'
  cloudHostId: string | null
}

export interface UseChatExecutionHostsResult {
  executionHosts: ExecutionHostRecord[]
  localExecutionLabel: string
  remoteHosts: ExecutionHostRecord[]
  activeCloudHost: ExecutionHostRecord | null
  executionDisplayLabel: string
  executionDisplayDetail: string
}

export function useChatExecutionHosts({
  executionPreference,
  executionTarget,
  cloudHostId,
}: UseChatExecutionHostsOptions): UseChatExecutionHostsResult {
  const [executionHosts, setExecutionHosts] = useState<ExecutionHostRecord[]>([])
  const [localExecutionLabel, setLocalExecutionLabel] = useState('Local')

  useEffect(() => {
    const listHosts = (window as any).electron?.execution?.listHosts
    if (typeof listHosts !== 'function') {
      setExecutionHosts([])
      return
    }

    listHosts()
      .then((hosts: ExecutionHostRecord[]) => setExecutionHosts(Array.isArray(hosts) ? hosts : []))
      .catch(() => setExecutionHosts([]))
  }, [])

  useEffect(() => {
    if (!executionPreference) {
      setLocalExecutionLabel('Instant')
      return
    }
    const resolveTarget = (window as any).electron?.execution?.resolveTarget
    if (typeof resolveTarget !== 'function') {
      setLocalExecutionLabel('Instant')
      return
    }

    resolveTarget(executionPreference)
      .then((resolution: any) => {
        // Map resolution.host.type to our short two-word vocab:
        //   'local-daemon' → "Local"  (full daemon execution)
        //   'runtime'      → "Instant" (in-process fallback)
        //   anything else  → use the host label verbatim
        const type = (resolution.host as { type?: string } | null)?.type
        if (type === 'local-daemon') setLocalExecutionLabel('Local')
        else if (type === 'runtime') setLocalExecutionLabel('Instant')
        else setLocalExecutionLabel(resolution.host.label || 'Instant')
      })
      .catch(() => {
        setLocalExecutionLabel('Instant')
      })
  }, [executionPreference])

  const remoteHosts = useMemo(
    () => executionHosts.filter(host => host.type === 'remote-daemon' && host.enabled !== false),
    [executionHosts],
  )

  const activeCloudHost = remoteHosts.find(host => host.id === cloudHostId) ?? remoteHosts[0] ?? null

  const executionDisplayLabel = executionTarget === 'cloud'
    ? (activeCloudHost?.label ?? (remoteHosts.length > 0 ? 'Cloud' : 'No remote daemon'))
    : localExecutionLabel

  const executionDisplayDetail = executionTarget === 'cloud'
    ? (activeCloudHost?.url ?? (remoteHosts.length > 0 ? 'Cloud workspace' : 'No remote daemon configured'))
    : ''

  return {
    executionHosts,
    localExecutionLabel,
    remoteHosts,
    activeCloudHost,
    executionDisplayLabel,
    executionDisplayDetail,
  }
}
