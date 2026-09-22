import type { ChildProcess } from 'node:child_process'
import {
  terminateProcessTree,
  type ProcessTreeTerminationOptions,
  type ProcessTreeTerminationResult,
} from '@codesurf/daemon/process-tree'

export type ChatProcessStopResult = ProcessTreeTerminationResult & {
  scopeKey: string
}

/**
 * Owns CLI process identity for chat turns. A process becomes non-current as
 * soon as stop begins, but remains tracked until tree termination is proven.
 * This closes the grace-period race where a TERM-resistant old turn could
 * continue publishing output while a replacement turn was being launched.
 */
export class ChatProcessLifecycle {
  readonly processes = new Map<string, ChildProcess>()
  private readonly stopping = new WeakSet<ChildProcess>()
  private readonly stopPromises = new Map<string, Promise<ChatProcessStopResult>>()
  private readonly terminationOptions: ProcessTreeTerminationOptions

  constructor(terminationOptions: ProcessTreeTerminationOptions = {}) {
    this.terminationOptions = terminationOptions
  }

  register(scopeKey: string, proc: ChildProcess): boolean {
    const current = this.processes.get(scopeKey)
    if (current && current !== proc) return false
    this.processes.set(scopeKey, proc)
    return true
  }

  isCurrent(scopeKey: string, proc: ChildProcess): boolean {
    return this.processes.get(scopeKey) === proc && !this.stopping.has(proc)
  }

  release(scopeKey: string, proc: ChildProcess): boolean {
    if (this.processes.get(scopeKey) !== proc) return false
    this.processes.delete(scopeKey)
    this.stopping.delete(proc)
    return true
  }

  async stop(scopeKey: string): Promise<ChatProcessStopResult | null> {
    const existing = this.stopPromises.get(scopeKey)
    if (existing) return await existing

    const proc = this.processes.get(scopeKey)
    if (!proc) return null
    this.stopping.add(proc)

    const pending = terminateProcessTree(proc, this.terminationOptions).then(result => {
      if (result.confirmed) this.release(scopeKey, proc)
      return { ...result, scopeKey }
    }).finally(() => {
      if (this.stopPromises.get(scopeKey) === pending) {
        this.stopPromises.delete(scopeKey)
      }
    })
    this.stopPromises.set(scopeKey, pending)
    return await pending
  }

  async stopAll(): Promise<ChatProcessStopResult[]> {
    const keys = [...this.processes.keys()]
    const results = await Promise.all(keys.map(async scopeKey => {
      const result = await this.stop(scopeKey)
      return result
    }))
    return results.filter((result): result is ChatProcessStopResult => result !== null)
  }
}
