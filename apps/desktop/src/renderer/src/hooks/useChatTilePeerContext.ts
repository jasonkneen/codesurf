import { useEffect, useMemo, useRef, useState } from 'react'
import { isTileContextChangeForScope, tileContextChannel } from '../../../shared/tileContextScope'
import { getImplicitPeerImageAttachments, type DiscoveryPeer } from '../components/chat/chatTileUtils'

export function useChatTilePeerContext(options: {
  tileId: string
  workspaceId: string
  connectedPeers: DiscoveryPeer[]
}) {
  const { tileId, workspaceId, connectedPeers } = options
  const peerContextRef = useRef<Map<string, Record<string, unknown>>>(new Map())
  const [peerContextVersion, setPeerContextVersion] = useState(0)
  const connectedPeerSignature = useMemo(
    () => connectedPeers.map(peer => peer.peerId).sort().join('|'),
    [connectedPeers],
  )
  const implicitPeerImageAttachments = useMemo(
    () => getImplicitPeerImageAttachments(connectedPeers),
    [connectedPeers],
  )

  useEffect(() => {
    if (!workspaceId || connectedPeers.length === 0 || !window.electron?.tileContext) {
      if (peerContextRef.current.size > 0) {
        peerContextRef.current = new Map()
        setPeerContextVersion(v => v + 1)
      }
      return
    }

    let cancelled = false

    void Promise.all(connectedPeers.map(async (peer) => {
      const entries = await window.electron.tileContext?.getAll(workspaceId, peer.peerId, 'ctx:') ?? []
      return [peer.peerId, Array.isArray(entries) ? entries : []] as const
    })).then((results) => {
      if (cancelled) return
      const next = new Map<string, Record<string, unknown>>()
      for (const [peerId, entries] of results) {
        const values: Record<string, unknown> = {}
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue
          const contextEntry = entry as { key?: unknown; value?: unknown }
          if (typeof contextEntry.key !== 'string') continue
          values[contextEntry.key] = contextEntry.value
        }
        next.set(peerId, values)
      }
      peerContextRef.current = next
      setPeerContextVersion(v => v + 1)
    }).catch(() => {})

    return () => { cancelled = true }
  }, [workspaceId, connectedPeerSignature])

  useEffect(() => {
    if (!workspaceId || !window.electron?.bus) return
    const unsubs: Array<() => void> = []

    for (const peer of connectedPeers) {
      const channel = tileContextChannel(workspaceId, peer.peerId)
      const subscriberId = `chat:${workspaceId}:${tileId}:peer-ctx:${peer.peerId}`
      const unsubscribe = window.electron.bus.subscribe(channel, subscriberId, (event) => {
        const p = event?.payload ?? event
        if (isTileContextChangeForScope(p, workspaceId, peer.peerId) && p.action === 'context_changed' && p.key) {
          const existing = peerContextRef.current.get(peer.peerId) ?? {}
          peerContextRef.current.set(peer.peerId, { ...existing, [p.key]: p.value })
          setPeerContextVersion(v => v + 1)
        }
      })
      if (typeof unsubscribe === 'function') unsubs.push(unsubscribe)
    }

    return () => { for (const u of unsubs) u() }
  }, [connectedPeerSignature, tileId, workspaceId])

  return {
    peerContextRef,
    peerContextVersion,
    implicitPeerImageAttachments,
  }
}
