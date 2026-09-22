import React, { useEffect, useSyncExternalStore } from 'react'

export type LoadableTileSnapshot<Component> =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'resolved', component: Component }
  | { status: 'rejected', error: unknown }

export type LoadableTileLoadContext = {
  attempt: number
  previousError: unknown | null
}

export type LoadableTileResource<Component> = {
  load: () => Promise<Component>
  reset: () => boolean
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => LoadableTileSnapshot<Component>
  /**
   * Returns the resolved component, null while idle/pending, and throws a
   * cached loader failure so the nearest React error boundary owns it.
   */
  read: () => Component | null
}

export function createLoadableTileResource<Component>(
  loader: (context: LoadableTileLoadContext) => Promise<Component>,
): LoadableTileResource<Component> {
  let snapshot: LoadableTileSnapshot<Component> = { status: 'idle' }
  let request: Promise<Component> | null = null
  let attempt = 0
  let previousError: unknown | null = null
  const listeners = new Set<() => void>()

  const publish = (next: LoadableTileSnapshot<Component>): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  return {
    load() {
      if (request) return request
      request = Promise.resolve()
        .then(() => loader({ attempt, previousError }))
        .then(
          component => {
            previousError = null
            publish({ status: 'resolved', component })
            return component
          },
          error => {
            previousError = error
            publish({ status: 'rejected', error })
            throw error
          },
        )
      publish({ status: 'pending' })
      return request
    },
    reset() {
      // A resource is shared by every mounted tile of this type. A stale error
      // boundary may retry after another sibling already recovered it; only a
      // currently rejected resource may be reset or that stale retry would
      // unmount every resolved sibling and discard their local editor state.
      if (snapshot.status !== 'rejected') return false
      request = null
      attempt += 1
      publish({ status: 'idle' })
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return snapshot
    },
    read() {
      if (snapshot.status === 'resolved') return snapshot.component
      if (snapshot.status === 'rejected') throw snapshot.error
      return null
    },
  }
}

type DynamicModuleImporter = (url: string) => Promise<unknown>

const importDynamicModule: DynamicModuleImporter = url => import(
  /* @vite-ignore */
  url
)

export function findRejectedDynamicImportUrl(error: unknown): string | null {
  const message = error instanceof Error
    ? `${error.message}\n${error.stack ?? ''}`
    : String(error ?? '')
  const matches = message.match(/(?:file|https?):\/\/[^\s"'<>]+?\.js(?:\?[^\s"'<>]*)?/g)
  return matches?.at(-1)?.replace(/[),.;]+$/, '') ?? null
}

/**
 * Chromium memoizes a rejected import() by its exact URL. A plain retry of the
 * same generated chunk therefore rethrows without issuing another request.
 * Recover by importing the failed production URL with a cache-busting query;
 * source/dev loads still use the statically analyzable loader.
 */
export async function loadDynamicModuleWithRetry<Module>(
  initialLoader: () => Promise<Module>,
  context: LoadableTileLoadContext,
  retryImporter: DynamicModuleImporter = importDynamicModule,
): Promise<Module> {
  if (context.attempt > 0 && context.previousError !== null) {
    const rejectedUrl = findRejectedDynamicImportUrl(context.previousError)
    if (rejectedUrl) {
      const retryUrl = new URL(rejectedUrl)
      retryUrl.searchParams.set('codesurf_retry', String(context.attempt))
      return await retryImporter(retryUrl.href) as Module
    }
  }
  return await initialLoader()
}

type LoadableTileErrorBoundaryProps = {
  children?: React.ReactNode
  onRetry: () => void
  renderError: (error: unknown, retry: () => void) => React.ReactNode
}

type LoadableTileErrorBoundaryState = {
  error: unknown | null
}

class LoadableTileErrorBoundary extends React.Component<
  LoadableTileErrorBoundaryProps,
  LoadableTileErrorBoundaryState
> {
  state: LoadableTileErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): LoadableTileErrorBoundaryState {
    return { error }
  }

  private readonly retry = (): void => {
    this.props.onRetry()
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error !== null) {
      return this.props.renderError(this.state.error, this.retry)
    }
    return this.props.children
  }
}

function defaultLoadErrorFallback(
  _error: unknown,
  retry: () => void,
): React.ReactNode {
  return React.createElement(
    'div',
    {
      role: 'alert',
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 12,
        fontSize: 12,
      },
    },
    React.createElement('span', null, 'Block failed to load'),
    React.createElement(
      'button',
      {
        type: 'button',
        'data-loadable-tile-retry': true,
        onClick: retry,
        style: {
          border: '1px solid currentColor',
          borderRadius: 5,
          background: 'transparent',
          color: 'inherit',
          padding: '4px 9px',
          cursor: 'pointer',
        },
      },
      'Retry',
    ),
  )
}

/**
 * Electron's production file:// renderer can intermittently leave a nested
 * React.lazy Suspense retry pending after the chunk has evaluated. This keeps
 * the same cached on-demand module boundary while committing resolution
 * through an external-store update that survives unmount/remount races.
 */
export function createLoadableTile<Props extends object>(
  loader: (
    context: LoadableTileLoadContext,
  ) => Promise<React.ComponentType<Props>>,
  renderFallback: () => React.ReactNode = () => React.createElement(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
      },
    },
    'Loading block…',
  ),
  renderError: (
    error: unknown,
    retry: () => void,
  ) => React.ReactNode = defaultLoadErrorFallback,
): React.ComponentType<Props> {
  const resource = createLoadableTileResource(loader)

  function LoadableTileBody(props: Props): React.ReactElement {
    useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)

    useEffect(() => {
      void resource.load().catch(() => {
        // The rejected snapshot triggers a render where read() rethrows to the
        // nearest error boundary. This catch only prevents an unhandled promise.
      })
    }, [])

    const Component = resource.read()
    if (!Component) {
      return React.createElement(React.Fragment, null, renderFallback())
    }
    return React.createElement(Component, props)
  }

  return function LoadableTile(props: Props): React.ReactElement {
    return React.createElement(
      LoadableTileErrorBoundary,
      {
        onRetry: () => {
          resource.reset()
        },
        renderError,
      },
      React.createElement(LoadableTileBody, props),
    )
  }
}

export function createLoadableModuleTile<
  Props extends object,
  Module,
>(
  loader: () => Promise<Module>,
  selectComponent: (module: Module) => React.ComponentType<Props>,
  renderFallback?: () => React.ReactNode,
  renderError?: (
    error: unknown,
    retry: () => void,
  ) => React.ReactNode,
): React.ComponentType<Props> {
  return createLoadableTile(
    context => loadDynamicModuleWithRetry(loader, context).then(selectComponent),
    renderFallback,
    renderError,
  )
}
