import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  createWindowPersistenceBarrierRegistry,
  installAppQuitBarrier,
  MAX_QUIT_CLEANUP_ATTEMPTS,
  WINDOW_PERSISTENCE_READY_CHANNEL,
  WINDOW_PERSISTENCE_REQUEST_CHANNEL,
  type PersistenceBarrierIpc,
  type PersistenceBarrierWebContents,
  type PersistenceBarrierWindow,
} from '../src/main/window-persistence-barrier.ts'

class FakeWebContents implements PersistenceBarrierWebContents {
  destroyed = false
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  readonly id: number

  constructor(id: number) {
    this.id = id
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }
}

class FakeWindow extends EventEmitter implements PersistenceBarrierWindow {
  destroyed = false
  acceptedCloseCount = 0
  readonly webContents: FakeWebContents

  constructor(webContents: FakeWebContents) {
    super()
    this.webContents = webContents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    this.emit('close', event)
    if (event.defaultPrevented) return
    this.acceptedCloseCount += 1
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit('closed')
  }

  focusForTest(): void {
    this.emit('focus')
  }
}

class FakeIpc extends EventEmitter implements PersistenceBarrierIpc {}

class FakeApp extends EventEmitter {
  quitCalls = 0
  acceptedQuitCount = 0

  quit(): void {
    this.quitCalls += 1
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    this.emit('before-quit', event)
    if (!event.defaultPrevented) this.acceptedQuitCount += 1
  }
}

async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function latestNonce(contents: FakeWebContents): string {
  const payload = contents.sent.at(-1)?.payload as { nonce?: unknown } | undefined
  assert.equal(typeof payload?.nonce, 'string')
  return payload.nonce
}

function acknowledge(
  ipc: FakeIpc,
  contents: FakeWebContents,
  nonce = latestNonce(contents),
): void {
  ipc.emit(WINDOW_PERSISTENCE_READY_CHANNEL, { sender: contents }, { nonce })
}

describe('window persistence barrier', () => {
  test('accepts readiness only from the challenged sender with the exact nonce', async () => {
    const ipc = new FakeIpc()
    const registry = createWindowPersistenceBarrierRegistry(ipc, {
      createNonce: () => 'nonce-main',
    })
    const webContents = new FakeWebContents(11)
    const otherSender = new FakeWebContents(12)
    const window = new FakeWindow(webContents)
    registry.install(window, { role: 'primary-canvas' })

    window.close()
    await settle()

    assert.equal(window.acceptedCloseCount, 0)
    assert.deepEqual(webContents.sent, [{
      channel: WINDOW_PERSISTENCE_REQUEST_CHANNEL,
      payload: { nonce: 'nonce-main', reason: 'close', canvasOwner: true },
    }])

    ipc.emit(WINDOW_PERSISTENCE_READY_CHANNEL, { sender: otherSender }, { nonce: 'nonce-main' })
    ipc.emit(WINDOW_PERSISTENCE_READY_CHANNEL, { sender: webContents }, { nonce: 'wrong' })
    assert.equal(window.acceptedCloseCount, 0)

    acknowledge(ipc, webContents, 'nonce-main')
    await settle()
    assert.equal(window.acceptedCloseCount, 1)

    acknowledge(ipc, webContents, 'nonce-main')
    assert.equal(window.acceptedCloseCount, 1)
    registry.dispose()
  })

  test('reuses the barrier for reload actions and creates a fresh nonce each time', async () => {
    const ipc = new FakeIpc()
    const nonces = ['reload-1', 'reload-2']
    const registry = createWindowPersistenceBarrierRegistry(ipc, {
      createNonce: () => nonces.shift() ?? 'unexpected',
    })
    const contents = new FakeWebContents(15)
    const window = new FakeWindow(contents)
    registry.install(window, { role: 'primary-canvas' })
    const actions: string[] = []

    const first = registry.requestPersistence(window, 'reload').then(() => {
      actions.push('reload')
    })
    await settle()
    assert.deepEqual(contents.sent, [{
      channel: WINDOW_PERSISTENCE_REQUEST_CHANNEL,
      payload: { nonce: 'reload-1', reason: 'reload', canvasOwner: true },
    }])
    acknowledge(ipc, new FakeWebContents(99), 'reload-1')
    acknowledge(ipc, contents, 'wrong')
    await settle()
    assert.deepEqual(actions, [])

    acknowledge(ipc, contents, 'reload-1')
    await first
    assert.deepEqual(actions, ['reload'])

    const second = registry.requestPersistence(window, 'force-reload').then(() => {
      actions.push('force-reload')
    })
    await settle()
    assert.deepEqual(contents.sent.at(-1), {
      channel: WINDOW_PERSISTENCE_REQUEST_CHANNEL,
      payload: {
        nonce: 'reload-2',
        reason: 'force-reload',
        canvasOwner: true,
      },
    })
    acknowledge(ipc, contents, 'reload-2')
    await second
    assert.deepEqual(actions, ['reload', 'force-reload'])
    registry.dispose()
  })

  test('application reload menu routes through the reusable persistence request', async () => {
    const mainSource = await readFile(
      join(process.cwd(), 'src/main/index.ts'),
      'utf8',
    )
    assert.doesNotMatch(mainSource, /\{\s*role:\s*'reload'\s*\}/)
    assert.doesNotMatch(mainSource, /\{\s*role:\s*'forceReload'\s*\}/)
    assert.match(
      mainSource,
      /windowPersistenceBarrierRegistry\?\.requestPersistence\(win, reason\)/,
    )
  })

  test('issues one close challenge and fails open once when the timeout expires', async () => {
    const ipc = new FakeIpc()
    let timeoutCallback: (() => void) | null = null
    let clearedTimeouts = 0
    const registry = createWindowPersistenceBarrierRegistry(ipc, {
      createNonce: () => 'nonce-timeout',
      setTimeout: callback => {
        timeoutCallback = callback
        return 41
      },
      clearTimeout: () => {
        clearedTimeouts += 1
      },
    })
    const contents = new FakeWebContents(21)
    const window = new FakeWindow(contents)
    registry.install(window, { role: 'primary-canvas' })

    window.close()
    window.close()
    await settle()

    assert.equal(contents.sent.length, 1)
    assert.ok(timeoutCallback)
    timeoutCallback()
    timeoutCallback()
    await settle()

    assert.equal(window.acceptedCloseCount, 1)
    assert.equal(clearedTimeouts, 1)
    acknowledge(ipc, contents, 'nonce-timeout')
    assert.equal(window.acceptedCloseCount, 1)
    registry.dispose()
  })

  test('flushes auxiliary windows first and the most recently focused primary last', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'codesurf-window-order-'))
    const artifactPath = join(artifactDir, 'canvas-state.json')
    const ipc = new FakeIpc()
    let nonceIndex = 0
    const registry = createWindowPersistenceBarrierRegistry(ipc, {
      createNonce: () => `nonce-${++nonceIndex}`,
    })
    const olderFocusedContents = new FakeWebContents(10)
    const newerContents = new FakeWebContents(20)
    const auxiliaryContents = new FakeWebContents(30)
    const olderFocused = new FakeWindow(olderFocusedContents)
    const newer = new FakeWindow(newerContents)
    const auxiliary = new FakeWindow(auxiliaryContents)
    registry.install(olderFocused, { role: 'primary-canvas' })
    registry.install(newer, { role: 'primary-canvas' })
    registry.install(auxiliary, { role: 'auxiliary' })

    // Creation order says window 20 is newer, but focus ownership says window
    // 10 is authoritative and must therefore be the final writer.
    newer.focusForTest()
    olderFocused.focusForTest()

    try {
      const persistAndAcknowledge = async (
        contents: FakeWebContents,
        canvas: { owner: string; tiles: Array<{ id: string }> },
      ): Promise<void> => {
        await writeFile(
          artifactPath,
          JSON.stringify({ workspaceId: 'shared-workspace', canvas }),
          'utf8',
        )
        acknowledge(ipc, contents)
      }

      const closeAll = registry.closeAll()
      await settle()
      assert.equal(auxiliaryContents.sent.length, 1)
      assert.deepEqual(auxiliaryContents.sent[0]?.payload, {
        nonce: 'nonce-1',
        reason: 'quit',
        canvasOwner: false,
      })
      assert.equal(newerContents.sent.length, 0)
      assert.equal(olderFocusedContents.sent.length, 0)
      await persistAndAcknowledge(auxiliaryContents, {
        owner: 'auxiliary-mini-chat',
        tiles: [{ id: 'auxiliary-state' }],
      })

      await settle()
      assert.equal(newerContents.sent.length, 1)
      assert.equal(olderFocusedContents.sent.length, 0)
      await persistAndAcknowledge(newerContents, {
        owner: 'newer-unfocused-primary',
        tiles: [{ id: 'newer-state' }],
      })

      await settle()
      assert.equal(olderFocusedContents.sent.length, 1)
      await persistAndAcknowledge(olderFocusedContents, {
        owner: 'older-focused-primary',
        tiles: [{ id: 'authoritative-state' }],
      })
      await closeAll

      const finalArtifact = JSON.parse(await readFile(artifactPath, 'utf8'))
      assert.deepEqual(finalArtifact, {
        workspaceId: 'shared-workspace',
        canvas: {
          owner: 'older-focused-primary',
          tiles: [{ id: 'authoritative-state' }],
        },
      })
      assert.equal(auxiliary.acceptedCloseCount, 1)
      assert.equal(newer.acceptedCloseCount, 1)
      assert.equal(olderFocused.acceptedCloseCount, 1)
    } finally {
      registry.dispose()
      await rm(artifactDir, { recursive: true, force: true })
    }
  })

  test('promotes a pending individual close into a fresh final quit challenge', async () => {
    const ipc = new FakeIpc()
    let nonceIndex = 0
    const registry = createWindowPersistenceBarrierRegistry(ipc, {
      createNonce: () => `promote-${++nonceIndex}`,
    })
    const winnerContents = new FakeWebContents(10)
    const precedingContents = new FakeWebContents(20)
    const winner = new FakeWindow(winnerContents)
    const preceding = new FakeWindow(precedingContents)
    registry.install(winner, { role: 'primary-canvas' })
    registry.install(preceding, { role: 'primary-canvas' })
    winner.focusForTest()

    winner.close()
    await settle()
    assert.deepEqual(winnerContents.sent[0]?.payload, {
      nonce: 'promote-1',
      reason: 'close',
      canvasOwner: true,
    })

    const closeAll = registry.closeAll()
    await settle()
    assert.equal(precedingContents.sent.length, 1)
    acknowledge(ipc, winnerContents, 'promote-1')
    await settle()
    assert.equal(winner.acceptedCloseCount, 0)

    acknowledge(ipc, precedingContents)
    await settle()
    assert.equal(winnerContents.sent.length, 2)
    assert.deepEqual(winnerContents.sent[1]?.payload, {
      nonce: 'promote-3',
      reason: 'quit',
      canvasOwner: true,
    })

    acknowledge(ipc, winnerContents, 'promote-3')
    await closeAll
    assert.equal(preceding.acceptedCloseCount, 1)
    assert.equal(winner.acceptedCloseCount, 1)
    registry.dispose()
  })

  test('uses the lowest primary webContents id as the stable final-writer fallback', async () => {
    const ipc = new FakeIpc()
    const registry = createWindowPersistenceBarrierRegistry(ipc)
    const high = new FakeWebContents(90)
    const low = new FakeWebContents(40)
    registry.install(new FakeWindow(low), { role: 'primary-canvas' })
    registry.install(new FakeWindow(high), { role: 'primary-canvas' })

    const closeAll = registry.closeAll()
    await settle()
    assert.equal(high.sent.length, 1)
    assert.equal(low.sent.length, 0)
    acknowledge(ipc, high)
    await settle()
    assert.equal(low.sent.length, 1)
    acknowledge(ipc, low)
    await closeAll
    registry.dispose()
  })

  test('settles every window then resumes whole-app quit exactly once', async () => {
    const ipc = new FakeIpc()
    const registry = createWindowPersistenceBarrierRegistry(ipc)
    const mainContents = new FakeWebContents(31)
    const miniContents = new FakeWebContents(32)
    registry.install(new FakeWindow(mainContents), { role: 'primary-canvas' })
    registry.install(new FakeWindow(miniContents), { role: 'auxiliary' })

    const app = new FakeApp()
    let cleanupCount = 0
    const disposeQuitBarrier = installAppQuitBarrier(app, () => registry, () => {
      cleanupCount += 1
    })

    app.quit()
    app.quit()
    await settle()

    assert.equal(app.acceptedQuitCount, 0)
    assert.equal(cleanupCount, 0)
    assert.equal(miniContents.sent.length, 1)
    assert.equal(mainContents.sent.length, 0)

    acknowledge(ipc, miniContents)
    await settle()
    assert.equal(mainContents.sent.length, 1)
    assert.equal(app.acceptedQuitCount, 0)
    assert.equal(cleanupCount, 0)

    acknowledge(ipc, mainContents)
    await settle()

    assert.equal(app.quitCalls, 3)
    assert.equal(app.acceptedQuitCount, 1)
    assert.equal(cleanupCount, 1)
    disposeQuitBarrier()
    registry.dispose()
  })

  test('resumes whole-app quit after a renderer persistence timeout', async () => {
    const ipc = new FakeIpc()
    let timeoutCallback: (() => void) | null = null
    const registry = createWindowPersistenceBarrierRegistry(ipc, {
      createNonce: () => 'nonce-timeout-app',
      setTimeout: callback => {
        timeoutCallback = callback
        return 51
      },
    })
    registry.install(
      new FakeWindow(new FakeWebContents(41)),
      { role: 'primary-canvas' },
    )
    const app = new FakeApp()
    let cleanupCount = 0
    const disposeQuitBarrier = installAppQuitBarrier(app, () => registry, () => {
      cleanupCount += 1
    })

    app.quit()
    await settle()
    assert.equal(app.acceptedQuitCount, 0)
    assert.ok(timeoutCallback)
    timeoutCallback()
    await settle()

    assert.equal(app.quitCalls, 2)
    assert.equal(app.acceptedQuitCount, 1)
    assert.equal(cleanupCount, 1)
    disposeQuitBarrier()
    registry.dispose()
  })

  test('does not resume app quit until asynchronous cleanup settles', async () => {
    const app = new FakeApp()
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>(resolve => {
      releaseCleanup = resolve
    })
    const disposeQuitBarrier = installAppQuitBarrier(
      app,
      () => null,
      () => cleanup,
    )

    app.quit()
    await settle()
    assert.equal(app.acceptedQuitCount, 0)
    assert.equal(app.quitCalls, 1)

    releaseCleanup()
    await settle()
    assert.equal(app.quitCalls, 2)
    assert.equal(app.acceptedQuitCount, 1)
    disposeQuitBarrier()
  })

  test('does not resume app quit when asynchronous cleanup fails', async () => {
    const app = new FakeApp()
    const cleanupError = new Error('provider tree exit was not confirmed')
    const errors: unknown[] = []
    const disposeQuitBarrier = installAppQuitBarrier(
      app,
      () => null,
      async () => {
        throw cleanupError
      },
      error => {
        errors.push(error)
      },
    )

    app.quit()
    await settle()
    assert.equal(app.quitCalls, 1)
    assert.equal(app.acceptedQuitCount, 0)
    assert.deepEqual(errors, [cleanupError])
    disposeQuitBarrier()
  })

  test('a failed cleanup is retried on the next quit instead of wedging forever', async () => {
    // H5: resumeScheduled stayed latched and cleanupPromise memoized the
    // rejection, so every later quit was preventDefault'd and re-awaited the
    // same cached failure — the app could only be force-quit.
    const app = new FakeApp()
    const errors: unknown[] = []
    let attempts = 0
    const disposeQuitBarrier = installAppQuitBarrier(
      app,
      () => null,
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error('provider tree exit was not confirmed')
      },
      error => { errors.push(error) },
    )

    app.quit()
    await settle()
    assert.equal(attempts, 1, 'first quit attempts cleanup')
    assert.equal(app.acceptedQuitCount, 0, 'first quit still fails closed')

    // Second quit must genuinely re-run cleanup, not re-await the cached rejection.
    app.quit()
    await settle()
    assert.equal(attempts, 2, 'the second quit retries cleanup')
    assert.equal(app.acceptedQuitCount, 1, 'a recovered cleanup lets the app quit')
    assert.equal(errors.length, 1)
    disposeQuitBarrier()
  })

  test('quits anyway after MAX_QUIT_CLEANUP_ATTEMPTS consecutive failures', async () => {
    const app = new FakeApp()
    const errors: unknown[] = []
    let attempts = 0
    const disposeQuitBarrier = installAppQuitBarrier(
      app,
      () => null,
      async () => {
        attempts += 1
        throw new Error('cleanup always fails')
      },
      error => { errors.push(error) },
    )

    for (let i = 0; i < MAX_QUIT_CLEANUP_ATTEMPTS; i += 1) {
      app.quit()
      await settle()
    }

    assert.equal(attempts, MAX_QUIT_CLEANUP_ATTEMPTS, 'every attempt genuinely re-ran cleanup')
    assert.equal(app.acceptedQuitCount >= 1, true, 'the user is never trapped in an unquittable app')
    assert.ok(
      errors.some(e => String((e as Error)?.message).includes('quitting anyway')),
      'the give-up is reported, not silent',
    )
    disposeQuitBarrier()
  })
})
