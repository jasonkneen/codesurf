import React from 'react'
import * as ReactDOM from 'react-dom/client'
import App from './App'
import { PwaInstallBanner } from './components/PwaInstallBanner'
import { installHostBridge } from './platform'
import { registerCodesurfPwa } from './platform/pwa'

interface RootErrorBoundaryState {
  hasError: boolean
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[renderer] Unhandled error in app root', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#fff', background: '#1e1e1e' }}>
          <div>CodeSurf encountered an unexpected error. Check the console for details.</div>
        </div>
      )
    }
    return this.props.children
  }
}

export async function bootstrap(root: HTMLElement): Promise<void> {
  // Multi-target: Electron keeps preload IPC; browser/Native get daemon bridge.
  // Must run before App mounts so window.electron exists for useEffects.
  const host = await installHostBridge()

  // PWA only for browser / Native web targets — not full Electron.
  if (host.platform !== 'electron') {
    void registerCodesurfPwa({
      onNeedRefresh: () => {
        window.dispatchEvent(new Event('codesurf-pwa-need-refresh'))
      },
    })
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
        {host.platform !== 'electron' ? <PwaInstallBanner /> : null}
      </RootErrorBoundary>
    </React.StrictMode>
  )
}
