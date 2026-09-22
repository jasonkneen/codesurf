import { useEffect, useState } from 'react'
import { onContext, type BridgeContext } from '@codesurf/chat-bridge'
import { Thread } from './Thread'
import { CodesurfRuntimeProvider } from './runtime/CodesurfRuntimeProvider'

export function ChatApp() {
  const [ctx, setCtx] = useState<BridgeContext | null>(null)
  const [bridgeStatus, setBridgeStatus] = useState<'idle' | 'connected' | 'standalone'>('idle')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBridgeStatus(prev => (prev === 'idle' ? 'standalone' : prev))
    }, 1500)

    const unsubscribe = onContext((next) => {
      window.clearTimeout(timer)
      setCtx(next)
      setBridgeStatus('connected')
      const root = document.documentElement
      for (const [key, value] of Object.entries(next.theme ?? {})) {
        root.style.setProperty(key, String(value))
      }
      for (const [key, value] of Object.entries(next.fonts ?? {})) {
        root.style.setProperty(key, String(value))
      }
    })

    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  return (
    <CodesurfRuntimeProvider context={ctx}>
      <div className="flex h-full w-full flex-col bg-background text-foreground">
        <Header status={bridgeStatus} ctx={ctx} />
        <div className="flex min-h-0 flex-1 flex-col">
          <Thread />
        </div>
      </div>
    </CodesurfRuntimeProvider>
  )
}

function Header({ status, ctx }: { status: 'idle' | 'connected' | 'standalone'; ctx: BridgeContext | null }) {
  const dotColor = status === 'connected' ? '#10b981' : status === 'standalone' ? '#f59e0b' : '#6b7280'
  const label = status === 'connected'
    ? `${ctx?.tileId?.slice(0, 8) ?? 'tile'} · ${ctx?.workspaceDir ?? ''}`
    : status === 'standalone'
      ? 'Standalone preview'
      : 'Connecting…'
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full" style={{ background: dotColor }} />
      <span className="truncate">{label}</span>
      <span className="ml-auto opacity-60">codesurf chat</span>
    </div>
  )
}
