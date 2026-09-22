import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'vitest'
import { CodesurfRelay } from './relay'
import { RelayRuntime } from './runtime'
import type { RelayAgentExecutor } from './types'
import {
  BoundedSubprocessError,
  runBoundedSubprocess,
} from '../../../src/main/relay/bounded-subprocess'
import { WorkspaceRelayService } from '../../../src/main/relay/workspaceRelayService'
import { installAppQuitBarrier } from '../../../src/main/window-persistence-barrier'

const fixture = resolve(process.cwd(), '../../test/fixtures/relay-process/child.mjs')

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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`condition was not met within ${timeoutMs}ms`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 15))
  }
}

const posixTest = process.platform === 'win32' ? test.skip : test

posixTest(
  'app quit awaits relay service teardown until provider child and grandchild exit',
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'codesurf-relay-app-quit-'))
    try {
      const providerReadyPath = join(workspace, 'provider-ready')
      let providerError: BoundedSubprocessError | null = null
      const executor: RelayAgentExecutor = {
        async runTurn(_input, signal) {
          try {
            const result = await runBoundedSubprocess({
              command: process.execPath,
              args: [fixture, 'grandchild', providerReadyPath],
              label: 'app-shutdown process tree',
              timeoutMs: 10_000,
              stdoutMaxBytes: 1_024,
              stderrMaxBytes: 1_024,
              termGraceMs: 100,
              killWaitMs: 750,
              signal,
            })
            return result.stdout
          } catch (error) {
            if (error instanceof BoundedSubprocessError) providerError = error
            throw error
          }
        },
      }
      const service = new WorkspaceRelayService({
        createRelay: workspacePath => new CodesurfRelay({ workspacePath }),
        createRuntime: (relay, options) => new RelayRuntime(relay, options),
        createExecutor: () => executor,
        readTileState: async () => null,
        broadcast: () => {},
      })
      service.start()

      const spawning = service.spawnWorkspaceRelayAgent(workspace, {
        id: 'shutdown-agent',
        name: 'Shutdown Agent',
        provider: 'codex',
        task: 'Keep a child process tree alive until app quit',
      })
      const spawningOutcome = spawning.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )
      await waitFor(() => existsSync(providerReadyPath))
      const announcedGrandchildPid = Number(
        (await readFile(providerReadyPath, 'utf8')).trim(),
      )
      assert.ok(
        Number.isSafeInteger(announcedGrandchildPid)
          && announcedGrandchildPid > 0,
      )

      const app = new FakeApp()
      const shutdownErrors: unknown[] = []
      const disposeBarrier = installAppQuitBarrier(
        app,
        () => null,
        () => service.stopAll(),
        error => {
          shutdownErrors.push(error)
        },
      )

      app.quit()
      assert.equal(app.acceptedQuitCount, 0)
      await waitFor(() => app.acceptedQuitCount === 1)

      assert.equal(shutdownErrors.length, 0)
      assert.equal(app.quitCalls, 2)
      assert.ok(providerError, 'provider termination result was not observed')
      assert.equal(providerError.reason, 'abort')
      assert.ok(providerError.pid && providerError.pid > 0)
      const grandchildMatch = providerError.stdout.match(/grandchild:(\d+)/)
      assert.ok(
        grandchildMatch,
        `missing grandchild pid in ${JSON.stringify(providerError.stdout)}`,
      )
      const grandchildPid = Number(grandchildMatch[1])
      assert.equal(grandchildPid, announcedGrandchildPid)
      assert.equal(isPidAlive(providerError.pid), false)
      assert.equal(isPidAlive(grandchildPid), false)
      await spawningOutcome
      disposeBarrier()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  },
)
