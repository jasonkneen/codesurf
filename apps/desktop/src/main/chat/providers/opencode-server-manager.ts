import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import {
  openCodePrelaunchBoundary,
  providerLaunchIsCurrent,
  type ProviderLaunchGuard,
} from '../provider-launch-guard.ts'

export interface OpenCodeServerTermination {
  confirmed: boolean
  detail: string
}

export interface OpenCodeServerManagerDependencies {
  resolveBinary(): string | null
  findAvailablePort(): Promise<number>
  spawnServer(binary: string, port: number, password: string): ChildProcess
  terminateProcessTree(process: ChildProcess): Promise<OpenCodeServerTermination>
  startupTimeoutMs?: number
  log?(...args: unknown[]): void
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

export class OpenCodeServerManager {
  private server: ChildProcess | null = null
  private port: number | null = null
  private ready = false
  private startPromise: Promise<{ port: number; url: string }> | null = null
  private readonly startWaiters = new Set<{ guard?: ProviderLaunchGuard }>()
  private readonly sharedStartGuard: ProviderLaunchGuard = {
    isCurrent: () => [...this.startWaiters].some(waiter => (
      providerLaunchIsCurrent(waiter.guard)
    )),
  }
  private readonly serverPassword = randomUUID()
  private readonly startupTimeoutMs: number
  private readonly dependencies: OpenCodeServerManagerDependencies
  private lifecycleGeneration = 0
  private closing = false
  private readonly terminationPromises = new WeakMap<ChildProcess, Promise<void>>()

  constructor(dependencies: OpenCodeServerManagerDependencies) {
    this.dependencies = dependencies
    this.startupTimeoutMs = Math.max(1, dependencies.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
  }

  getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`opencode:${this.serverPassword}`).toString('base64')}`,
    }
  }

  async ensureRunning(launchGuard?: ProviderLaunchGuard): Promise<{ port: number; url: string }> {
    if (this.closing) throw new Error('OpenCode server manager is shutting down')
    if (this.isRunning()) {
      return { port: this.port!, url: `http://127.0.0.1:${this.port}` }
    }

    const waiter = { guard: launchGuard }
    this.startWaiters.add(waiter)
    try {
      if (!this.startPromise) {
        // A server is shared across cards. Keep startup alive while any caller
        // that joined it is still current; one cleared card must not cancel a
        // concurrent current card's server preparation.
        const generation = this.lifecycleGeneration
        this.startPromise = this.startServer(this.sharedStartGuard, generation).catch((error) => {
          this.startPromise = null
          throw error
        })
      }
      return await this.startPromise
    } finally {
      this.startWaiters.delete(waiter)
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    this.lifecycleGeneration += 1
    const pendingStart = this.startPromise
    const server = this.server
    const termination = server ? this.terminateServer(server) : null
    if (pendingStart) {
      await pendingStart.catch(() => {})
    }
    if (termination) await termination
    const lateServer = this.server
    if (lateServer) await this.terminateServer(lateServer)
    this.startPromise = null
    this.closing = false
  }

  isRunning(): boolean {
    return Boolean(
      this.ready
      && this.server
      && this.port
      && this.server.exitCode === null
      && this.server.signalCode === null,
    )
  }

  private async startServer(launchGuard: ProviderLaunchGuard | undefined, generation: number): Promise<{ port: number; url: string }> {
    const staleServer = this.server
    if (staleServer && !this.isRunning()) await this.terminateServer(staleServer)

    const launched = await openCodePrelaunchBoundary.run({
      guard: launchGuard,
      prepare: async () => {
        const binary = this.dependencies.resolveBinary()
        if (!binary) {
          throw new Error('opencode CLI not found. Install: go install github.com/opencodeco/opencode@latest')
        }
        const port = await this.dependencies.findAvailablePort()
        if (!this.isGenerationCurrent(generation)) {
          throw new Error('OpenCode server launch superseded by shutdown')
        }
        return { binary, port, url: `http://127.0.0.1:${port}` }
      },
      launch: prepared => {
        if (!this.isGenerationCurrent(generation)) {
          throw new Error('OpenCode server launch superseded by shutdown')
        }
        const server = this.dependencies.spawnServer(
          prepared.binary,
          prepared.port,
          this.serverPassword,
        )
        this.server = server
        this.port = prepared.port
        this.ready = false

        return new Promise<{ port: number; url: string }>((resolve, reject) => {
          let settled = false
          const timeout = setTimeout(() => {
            void failStartup(new Error(`OpenCode server startup timeout (${this.startupTimeoutMs}ms)`))
          }, this.startupTimeoutMs)

          const failStartup = async (cause: Error): Promise<void> => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            try {
              await this.terminateServer(server)
              reject(cause)
            } catch (terminationError) {
              reject(new Error(
                `${cause.message}; process-tree termination failed: ${
                  terminationError instanceof Error ? terminationError.message : String(terminationError)
                }`,
              ))
            }
          }

          server.stdout?.on('data', (data: Buffer) => {
            const output = data.toString()
            this.dependencies.log?.('opencode stdout:', output.trim().slice(0, 200))
            if (!settled && output.includes('listening on')) {
              settled = true
              clearTimeout(timeout)
              if (this.server === server) this.ready = true
              resolve({ port: prepared.port, url: prepared.url })
            }
          })

          server.stderr?.on('data', (data: Buffer) => {
            this.dependencies.log?.('opencode stderr:', data.toString().trim().slice(0, 200))
          })

          server.on('error', (error) => {
            if (!settled) void failStartup(error)
          })

          server.on('exit', (code) => {
            if (!settled) {
              void failStartup(new Error(`OpenCode server exited with code ${code}`))
              return
            }
            if (this.server === server) {
              this.server = null
              this.port = null
              this.ready = false
              this.startPromise = null
            }
          })
        })
      },
    })
    if (!launched.ok) throw new Error('OpenCode server launch superseded')

    const running = await launched.value
    if (!this.isGenerationCurrent(generation) || !providerLaunchIsCurrent(launchGuard)) {
      if (this.server) await this.terminateServer(this.server)
      throw new Error('OpenCode server launch superseded')
    }
    return running
  }

  private async terminateServer(server: ChildProcess): Promise<void> {
    const existingTermination = this.terminationPromises.get(server)
    if (existingTermination) return existingTermination
    const termination = this.terminateServerOnce(server)
    this.terminationPromises.set(server, termination)
    return termination
  }

  private async terminateServerOnce(server: ChildProcess): Promise<void> {
    if (this.server === server) {
      this.ready = false
      this.port = null
    }
    if (server.exitCode === null && server.signalCode === null) {
      const termination = await this.dependencies.terminateProcessTree(server)
      if (!termination.confirmed) {
        throw new Error(termination.detail || 'OpenCode server process-tree termination was not confirmed')
      }
    }
    if (this.server === server) this.server = null
  }

  private isGenerationCurrent(generation: number): boolean {
    return !this.closing && generation === this.lifecycleGeneration
  }
}
