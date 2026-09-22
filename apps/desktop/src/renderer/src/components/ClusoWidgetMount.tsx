import { Component, type ReactNode } from "react"

interface ErrorBoundaryState {
  hasError: boolean
}

class ClusoErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}

let Cluso: (() => ReactNode) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("cluso-widget")
  Cluso = mod.Cluso
} catch {
  // cluso-widget is an optional dependency — silently degrade
}

export function ClusoWidgetMount() {
  if (!Cluso) return null
  return (
    <ClusoErrorBoundary>
      <Cluso />
    </ClusoErrorBoundary>
  )
}
