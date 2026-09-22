import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  createLoadableTile,
  createLoadableTileResource,
  findRejectedDynamicImportUrl,
  loadDynamicModuleWithRetry,
} from '../src/renderer/src/lib/loadableTile.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('loadable tile keeps one pending request across unmount and remount', async () => {
  const componentLoad = deferred<{ name: string }>()
  let loaderCalls = 0
  const resource = createLoadableTileResource(async () => {
    loaderCalls += 1
    return await componentLoad.promise
  })

  let firstMountNotifications = 0
  const unmount = resource.subscribe(() => {
    firstMountNotifications += 1
  })
  const firstRequest = resource.load()
  assert.deepEqual(resource.getSnapshot(), { status: 'pending' })
  assert.equal(firstMountNotifications, 1)

  unmount()
  let remountNotifications = 0
  const unmountAgain = resource.subscribe(() => {
    remountNotifications += 1
  })
  const remountRequest = resource.load()
  assert.strictEqual(remountRequest, firstRequest)

  const LoadedComponent = { name: 'LoadedTile' }
  componentLoad.resolve(LoadedComponent)
  assert.strictEqual(await remountRequest, LoadedComponent)
  assert.equal(loaderCalls, 1)
  assert.equal(firstMountNotifications, 1)
  assert.equal(remountNotifications, 1)
  assert.deepEqual(resource.getSnapshot(), {
    status: 'resolved',
    component: LoadedComponent,
  })
  assert.strictEqual(resource.read(), LoadedComponent)
  assert.strictEqual(resource.load(), firstRequest)
  unmountAgain()
})

test('loadable tile caches rejection and read rethrows it for an error boundary', async () => {
  const loadFailure = new Error('tile chunk failed')
  let loaderCalls = 0
  const resource = createLoadableTileResource(async () => {
    loaderCalls += 1
    throw loadFailure
  })

  const firstRequest = resource.load()
  await assert.rejects(firstRequest, error => error === loadFailure)
  assert.equal(loaderCalls, 1)
  assert.deepEqual(resource.getSnapshot(), {
    status: 'rejected',
    error: loadFailure,
  })
  assert.throws(
    () => resource.read(),
    error => error === loadFailure,
  )

  const remountRequest = resource.load()
  assert.strictEqual(remountRequest, firstRequest)
  await assert.rejects(remountRequest, error => error === loadFailure)
  assert.equal(loaderCalls, 1)
})

test('loadable tile publishes pending only after caching the shared request', async () => {
  const componentLoad = deferred<{ name: string }>()
  let listenerRequest: Promise<{ name: string }> | null = null
  const resource = createLoadableTileResource(() => componentLoad.promise)
  const unsubscribe = resource.subscribe(() => {
    if (resource.getSnapshot().status === 'pending') {
      listenerRequest = resource.load()
    }
  })

  const firstRequest = resource.load()
  assert.strictEqual(listenerRequest, firstRequest)

  componentLoad.resolve({ name: 'LoadedTile' })
  await firstRequest
  unsubscribe()
})

test('dynamic module retry cache-busts the rejected production chunk URL', async () => {
  const failedUrl = 'file:///Applications/CodeSurf.app/assets/NoteTile-test.js'
  const failure = new TypeError(`Failed to fetch dynamically imported module: ${failedUrl}`)
  const importedUrls: string[] = []
  let initialLoads = 0

  assert.equal(findRejectedDynamicImportUrl(failure), failedUrl)
  const module = await loadDynamicModuleWithRetry(
    async () => {
      initialLoads += 1
      return { recovered: false }
    },
    { attempt: 2, previousError: failure },
    async url => {
      importedUrls.push(url)
      return { recovered: true }
    },
  )

  assert.equal(initialLoads, 0)
  assert.deepEqual(module, { recovered: true })
  assert.deepEqual(importedUrls, [`${failedUrl}?codesurf_retry=2`])
})

test('loadable tile contains a rejection locally and retries without unmounting its neighbor', async () => {
  type Props = { label: string }
  const firstLoad = deferred<React.ComponentType<Props>>()
  const retryLoad = deferred<React.ComponentType<Props>>()
  let attempts = 0
  const loadContexts: Array<{ attempt: number; previousError: unknown | null }> = []
  const Loadable = createLoadableTile<Props>(context => {
    loadContexts.push(context)
    attempts += 1
    return attempts === 1 ? firstLoad.promise : retryLoad.promise
  })
  const Loaded: React.ComponentType<Props> = ({ label }) => React.createElement(
    'div',
    { 'data-loaded-tile': true },
    label,
  )
  const originalConsoleError = console.error
  console.error = () => {}

  let renderer: TestRenderer.ReactTestRenderer
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        'section',
        null,
        React.createElement('span', { 'data-neighbor': true }, 'neighbor'),
        React.createElement(Loadable, { label: 'recovered' }),
      ))
    })

    const neighborBefore = renderer!.root.findByProps({ 'data-neighbor': true })
    const loadFailure = new Error('chunk fetch failed')
    await act(async () => {
      firstLoad.reject(loadFailure)
      await firstLoad.promise.catch(() => {})
    })

    assert.equal(
      renderer!.root.findByProps({ 'data-neighbor': true }),
      neighborBefore,
    )
    const retryButton = renderer!.root.findByProps({
      'data-loadable-tile-retry': true,
    })

    await act(async () => {
      retryButton.props.onClick()
    })
    assert.equal(attempts, 2)
    assert.deepEqual(loadContexts, [
      { attempt: 0, previousError: null },
      { attempt: 1, previousError: loadFailure },
    ])

    await act(async () => {
      retryLoad.resolve(Loaded)
      await retryLoad.promise
    })

    assert.equal(
      renderer!.root.findByProps({ 'data-neighbor': true }),
      neighborBefore,
    )
    assert.equal(
      renderer!.root.findByProps({ 'data-loaded-tile': true }).children[0],
      'recovered',
    )
  } finally {
    console.error = originalConsoleError
    await act(async () => {
      renderer?.unmount()
    })
  }
})

test('a stale same-type retry preserves a recovered sibling identity and local state', async () => {
  type Props = { label: 'A' | 'B' }
  const firstLoad = deferred<React.ComponentType<Props>>()
  const retryLoad = deferred<React.ComponentType<Props>>()
  const loadFailure = new Error('shared chunk fetch failed')
  const loadContexts: Array<{ attempt: number; previousError: unknown | null }> = []
  const mounts = { A: 0, B: 0 }
  const unmounts = { A: 0, B: 0 }

  const Loaded: React.ComponentType<Props> = ({ label }) => {
    const [editCount, setEditCount] = React.useState(0)
    React.useEffect(() => {
      mounts[label] += 1
      return () => {
        unmounts[label] += 1
      }
    }, [label])
    return React.createElement(
      'button',
      {
        'data-loaded-label': label,
        onClick: () => setEditCount(value => value + 1),
      },
      `${label}:${editCount}`,
    )
  }

  let attempts = 0
  const Loadable = createLoadableTile<Props>(context => {
    loadContexts.push(context)
    attempts += 1
    return attempts === 1 ? firstLoad.promise : retryLoad.promise
  })
  const originalConsoleError = console.error
  console.error = () => {}

  let renderer: TestRenderer.ReactTestRenderer
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        'section',
        null,
        React.createElement(Loadable, { label: 'A' }),
        React.createElement(Loadable, { label: 'B' }),
      ))
    })

    await act(async () => {
      firstLoad.reject(loadFailure)
      await firstLoad.promise.catch(() => {})
    })

    const initialRetryButtons = renderer!.root.findAllByProps({
      'data-loadable-tile-retry': true,
    })
    assert.equal(initialRetryButtons.length, 2)

    await act(async () => {
      initialRetryButtons[0].props.onClick()
    })
    assert.equal(attempts, 2)

    await act(async () => {
      retryLoad.resolve(Loaded)
      await retryLoad.promise
    })

    const recoveredABefore = renderer!.root.findByProps({
      'data-loaded-label': 'A',
    })
    await act(async () => {
      recoveredABefore.props.onClick()
    })
    assert.equal(recoveredABefore.children[0], 'A:1')
    assert.deepEqual(mounts, { A: 1, B: 0 })
    assert.deepEqual(unmounts, { A: 0, B: 0 })

    const staleBRetry = renderer!.root.findByProps({
      'data-loadable-tile-retry': true,
    })
    await act(async () => {
      staleBRetry.props.onClick()
    })

    const recoveredAAfter = renderer!.root.findByProps({
      'data-loaded-label': 'A',
    })
    assert.strictEqual(recoveredAAfter, recoveredABefore)
    assert.equal(recoveredAAfter.children[0], 'A:1')
    assert.equal(
      renderer!.root.findByProps({ 'data-loaded-label': 'B' }).children[0],
      'B:0',
    )
    assert.equal(attempts, 2)
    assert.deepEqual(loadContexts, [
      { attempt: 0, previousError: null },
      { attempt: 1, previousError: loadFailure },
    ])
    assert.deepEqual(mounts, { A: 1, B: 1 })
    assert.deepEqual(unmounts, { A: 0, B: 0 })
  } finally {
    console.error = originalConsoleError
    await act(async () => {
      renderer?.unmount()
    })
  }
})
