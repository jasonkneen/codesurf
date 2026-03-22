/**
 * ExtensionTile — renders extension tile content inside a sandboxed iframe (webview).
 *
 * Safe tier: sandbox + CSP, no node integration.
 * Power tier: gets a bridge script injected for bus/state/MCP communication.
 */

import { useEffect, useRef, useState } from 'react'

const el = (window as any).electron

interface ExtensionTileProps {
  tileId: string
  extType: string  // e.g. 'ext:timer'
  width: number
  height: number
  workspaceId?: string
}

export function ExtensionTile({ tileId: _tileId, extType, width, height }: ExtensionTileProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [entryUrl, setEntryUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function resolve() {
      try {
        // Get all extension tiles to find the one matching our type
        const tiles = await el.extensions?.listTiles?.() ?? []
        const match = tiles.find((t: any) => t.type === extType)
        if (!match) {
          setError(`Extension tile type "${extType}" not found.`)
          setLoading(false)
          return
        }

        const url = await el.extensions?.tileEntry?.(match.extId, extType)
        if (!url) {
          setError(`No entry URL for extension "${match.extId}".`)
          setLoading(false)
          return
        }

        setEntryUrl(url)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }
    resolve()
  }, [extType])

  if (loading) {
    return (
      <div style={{
        width, height: height - 36,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#555', fontSize: 12,
      }}>
        Loading extension…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        width, height: height - 36,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#e87070', fontSize: 12, padding: 20, textAlign: 'center',
      }}>
        {error}
      </div>
    )
  }

  if (!entryUrl) return null

  return (
    <div style={{
      position: 'relative',
      width,
      height: height - 36,
      overflow: 'hidden',
      background: '#1e1e1e',
    }}>
      <iframe
        ref={iframeRef}
        src={entryUrl}
        sandbox="allow-scripts allow-same-origin"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          border: 'none',
          background: 'transparent',
        }}
        title={extType}
      />
    </div>
  )
}
