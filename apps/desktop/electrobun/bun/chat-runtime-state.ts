import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { ChatRequest } from '../../src/main/chat/types.ts'
import {
  electrobunChatScopeKey,
  ElectrobunRoomTurnLifecycle,
  type ElectrobunChatTurn,
  type ElectrobunRoomAcknowledger,
} from './chat-room-lifecycle.ts'
import {
  DEFAULT_ELECTROBUN_KILL_WAIT_MS,
  DEFAULT_ELECTROBUN_TERM_GRACE_MS,
  forceTerminateElectrobunProcessTree,
  terminateElectrobunProcessTree,
  waitForElectrobunPromise,
  type ElectrobunStopResult,
} from './chat-process-tree.ts'
import {
  ElectrobunProcessOutputBudget,
  normalizeElectrobunProcessOutputLimits,
  type ElectrobunProcessOutputLimits,
} from './process-output-limits.ts'

export {
  forceTerminateElectrobunProcessTree,
  terminateElectrobunProcessTree,
  type ElectrobunStopResult,
} from './chat-process-tree.ts'

export type ElectrobunChatScope = Pick<ElectrobunChatTurn, 'workspaceId' | 'cardId'>

export interface ElectrobunProcessStreamOptions {
  onStdoutText?: (text: string) => void
  onStdoutLine?: (line: string) => void
  onClose?: (code: number | null, stderr: string) => void
  missingBinaryMessage: string
}

interface ProcessRecord {
  turnId: string
  process: ChildProcess
  termination?: Promise<ElectrobunStopResult>
}

interface LaunchRecord {
  turnId: string
  promise: Promise<unknown>
}

interface ElectrobunChatRuntimeOptions {
  termGraceMs?: number
  killWaitMs?: number
  launchWaitMs?: number
  outputLimits?: Partial<ElectrobunProcessOutputLimits>
  terminateProcessTree?: (
    process: ChildProcess,
    options: { termGraceMs: number, killWaitMs: number },
  ) => Promise<ElectrobunStopResult>
}

const DEFAULT_LAUNCH_WAIT_MS = 5_000

export class ElectrobunChatRuntimeState {
  private readonly processes = new Map<string, ProcessRecord>()
  private readonly launches = new Map<string, LaunchRecord>()
  private readonly sessions = new Map<string, string>()
  private readonly activeTurns = new Map<string, string>()
  private readonly failedTurns = new Set<string>()
  private readonly roomLifecycle: ElectrobunRoomTurnLifecycle
  private readonly emit: (scope: ElectrobunChatScope, event: Record<string, unknown>) => void
  private readonly options: Required<Pick<ElectrobunChatRuntimeOptions, 'termGraceMs' | 'killWaitMs' | 'launchWaitMs'>>
  private readonly outputLimits: ElectrobunProcessOutputLimits
  private readonly terminateProcessTree: NonNullable<ElectrobunChatRuntimeOptions['terminateProcessTree']>

  constructor(
    acknowledge: ElectrobunRoomAcknowledger,
    emit: (scope: ElectrobunChatScope, event: Record<string, unknown>) => void,
    options: ElectrobunChatRuntimeOptions = {},
  ) {
    this.roomLifecycle = new ElectrobunRoomTurnLifecycle(acknowledge)
    this.emit = emit
    this.options = {
      termGraceMs: options.termGraceMs ?? DEFAULT_ELECTROBUN_TERM_GRACE_MS,
      killWaitMs: options.killWaitMs ?? DEFAULT_ELECTROBUN_KILL_WAIT_MS,
      launchWaitMs: options.launchWaitMs ?? DEFAULT_LAUNCH_WAIT_MS,
    }
    this.outputLimits = normalizeElectrobunProcessOutputLimits(options.outputLimits)
    this.terminateProcessTree = options.terminateProcessTree ?? terminateElectrobunProcessTree
  }

  async start(request: ChatRequest): Promise<ElectrobunChatTurn> {
    const scope = {
      workspaceId: String(request.workspaceId ?? ''),
      cardId: request.cardId,
    }
    const stopped = await this.stop(scope)
    if (!stopped.confirmed) {
      throw new Error(stopped.error ?? 'Unable to stop the previous chat process')
    }
    const turn = { ...scope, turnId: randomUUID() }
    this.activeTurns.set(electrobunChatScopeKey(turn), turn.turnId)
    this.roomLifecycle.register(turn, request)
    return turn
  }

  bindRequest(turn: ElectrobunChatTurn, request: ChatRequest): boolean {
    if (!this.isCurrent(turn)) return false
    this.roomLifecycle.register(turn, request)
    return true
  }

  isCurrent(turn: ElectrobunChatTurn): boolean {
    return this.activeTurns.get(electrobunChatScopeKey(turn)) === turn.turnId
  }

  send(turn: ElectrobunChatTurn, event: Record<string, unknown>): void {
    if (!this.isCurrent(turn)) return
    if (this.failedTurns.has(turn.turnId) && event.type !== 'done') return
    if (event.type === 'error') {
      this.failedTurns.add(turn.turnId)
      this.roomLifecycle.settle(turn, 'failed')
    } else if (
      (event.type === 'text' && typeof event.text === 'string' && event.text.length > 0)
      || event.type === 'tool_summary'
      || event.type === 'prompt_accepted'
    ) {
      this.roomLifecycle.settle(turn, 'delivered')
    } else if (event.type === 'done') {
      this.roomLifecycle.settle(turn, 'stopped')
    }
    this.emit({ workspaceId: turn.workspaceId, cardId: turn.cardId }, event)
    if (event.type === 'done') {
      this.failedTurns.delete(turn.turnId)
      this.activeTurns.delete(electrobunChatScopeKey(turn))
    }
  }

  sendDirect(scope: ElectrobunChatScope, event: Record<string, unknown>): void {
    this.emit(scope, event)
  }

  reject(turn: ElectrobunChatTurn): void {
    this.roomLifecycle.settle(turn, 'failed')
    this.failedTurns.delete(turn.turnId)
    if (this.isCurrent(turn)) this.activeTurns.delete(electrobunChatScopeKey(turn))
  }

  async registerProcess(turn: ElectrobunChatTurn, process: ChildProcess): Promise<boolean> {
    const key = electrobunChatScopeKey(turn)
    const record: ProcessRecord = {
      turnId: turn.turnId,
      process,
    }
    if (!this.isCurrent(turn)) {
      await this.terminateRecord(record)
      return false
    }
    const previous = this.processes.get(key)
    if (previous && previous.process !== process) {
      const stopped = await this.terminateRecord(previous)
      if (!stopped.confirmed || !this.isCurrent(turn)) {
        await this.terminateRecord(record)
        return false
      }
    }
    if (!this.isCurrent(turn)) {
      await this.terminateRecord(record)
      return false
    }
    this.processes.set(key, record)
    return true
  }

  releaseProcess(turn: ElectrobunChatTurn, process: ChildProcess): void {
    const key = electrobunChatScopeKey(turn)
    if (this.processes.get(key)?.process === process) this.processes.delete(key)
  }

  runLaunch<T>(turn: ElectrobunChatTurn, launch: () => Promise<T>): Promise<T> {
    const key = electrobunChatScopeKey(turn)
    const promise = Promise.resolve().then(async () => {
      if (!this.isCurrent(turn)) throw new Error('Chat turn was superseded before launch')
      return await launch()
    })
    const tracked = promise.finally(() => {
      if (this.launches.get(key)?.promise === tracked) this.launches.delete(key)
    })
    this.launches.set(key, { turnId: turn.turnId, promise: tracked })
    return tracked
  }

  streamProcess(
    turn: ElectrobunChatTurn,
    process: ChildProcess,
    options: ElectrobunProcessStreamOptions,
  ): void {
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let terminalEventSent = false
    const budget = new ElectrobunProcessOutputBudget(this.outputLimits)
    const terminateForOutputLimit = (message: string): void => {
      if (terminalEventSent) return
      terminalEventSent = true
      void this.terminateProcessForLimit(turn, process).then(stopped => {
        if (!this.isCurrent(turn)) return
        this.send(turn, {
          type: 'error',
          error: stopped.confirmed
            ? message
            : `${message} ${stopped.error ?? 'Process-tree termination could not be confirmed.'}`,
        })
        this.send(turn, { type: 'done' })
      })
    }
    process.stdout?.on('data', (chunk: Buffer | string) => {
      if (!this.isCurrent(turn) || terminalEventSent) return
      const violation = budget.accept('stdout', chunk)
      if (violation) {
        terminateForOutputLimit(violation)
        return
      }
      const text = chunk.toString()
      try {
        if (options.onStdoutText) {
          options.onStdoutText(text)
          return
        }
        stdoutBuffer += text
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!this.isCurrent(turn) || terminalEventSent) break
          options.onStdoutLine?.(line)
        }
      } catch (error) {
        terminateForOutputLimit(
          `Provider output handler failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
    process.stderr?.on('data', (chunk: Buffer | string) => {
      if (!this.isCurrent(turn) || terminalEventSent) return
      const violation = budget.accept('stderr', chunk)
      if (violation) {
        terminateForOutputLimit(violation)
        return
      }
      stderrBuffer += chunk.toString()
    })
    process.on('close', code => {
      const current = this.isCurrent(turn)
      this.releaseProcess(turn, process)
      if (!current || terminalEventSent) return
      terminalEventSent = true
      try {
        if (!options.onStdoutText && stdoutBuffer) options.onStdoutLine?.(stdoutBuffer)
        options.onClose?.(code, stderrBuffer)
      } catch (error) {
        this.send(turn, {
          type: 'error',
          error: `Provider output handler failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      } finally {
        this.send(turn, { type: 'done' })
      }
    })
    process.on('error', error => {
      const current = this.isCurrent(turn)
      this.releaseProcess(turn, process)
      if (!current || terminalEventSent) return
      terminalEventSent = true
      const message = error.message.includes('ENOENT') ? options.missingBinaryMessage : error.message
      this.send(turn, { type: 'error', error: message })
      this.send(turn, { type: 'done' })
    })
  }

  waitForAcceptedSpawn(
    process: ChildProcess,
    missingBinaryMessage: string,
  ): Promise<{ ok: boolean, error?: string }> {
    return new Promise(resolve => {
      const cleanup = (): void => {
        process.off('spawn', onSpawn)
        process.off('error', onError)
      }
      const onSpawn = (): void => {
        cleanup()
        resolve({ ok: true })
      }
      const onError = (error: Error): void => {
        cleanup()
        resolve({
          ok: false,
          error: error.message.includes('ENOENT') ? missingBinaryMessage : error.message,
        })
      }
      process.once('spawn', onSpawn)
      process.once('error', onError)
    })
  }

  getSession(scope: ElectrobunChatScope, provider: string): string | null {
    return this.sessions.get(this.sessionKey(scope, provider)) ?? null
  }

  setSession(turn: ElectrobunChatTurn, provider: string, sessionId: string): boolean {
    if (!this.isCurrent(turn)) return false
    this.sessions.set(this.sessionKey(turn, provider), sessionId)
    return true
  }

  clearSessions(scope: ElectrobunChatScope): void {
    for (const key of this.sessions.keys()) {
      try {
        const [workspaceId, cardId] = JSON.parse(key) as [string, string]
        if (workspaceId === scope.workspaceId && cardId === scope.cardId) {
          this.sessions.delete(key)
        }
      } catch {
        // Ignore malformed legacy entries.
      }
    }
  }

  async stopAndClearSessions(scope: ElectrobunChatScope): Promise<ElectrobunStopResult> {
    const stopped = await this.stop(scope)
    if (stopped.confirmed) this.clearSessions(scope)
    return stopped
  }

  async stop(scope: ElectrobunChatScope): Promise<ElectrobunStopResult> {
    const key = electrobunChatScopeKey(scope)
    const turnId = this.activeTurns.get(key)
      ?? this.processes.get(key)?.turnId
      ?? this.launches.get(key)?.turnId
    if (turnId) {
      this.roomLifecycle.settle({ ...scope, turnId }, 'stopped')
      this.failedTurns.delete(turnId)
      if (this.activeTurns.get(key) === turnId) this.activeTurns.delete(key)
    }

    let hadProcess = false
    let confirmed = true
    let error: string | undefined
    const initialProcess = this.processes.get(key)
    if (initialProcess) {
      hadProcess = true
      const stopped = await this.terminateRecord(initialProcess)
      confirmed &&= stopped.confirmed
      error = stopped.error ?? error
      if (stopped.confirmed && this.processes.get(key) === initialProcess) this.processes.delete(key)
    }

    const launch = this.launches.get(key)
    if (launch && (!turnId || launch.turnId === turnId)) {
      const settled = await waitForElectrobunPromise(launch.promise, this.options.launchWaitMs)
      confirmed &&= settled
      if (!settled) error = 'Timed out waiting for chat launch cancellation'
    }

    const lateProcess = this.processes.get(key)
    if (lateProcess && lateProcess !== initialProcess) {
      hadProcess = true
      const stopped = await this.terminateRecord(lateProcess)
      confirmed &&= stopped.confirmed
      error = stopped.error ?? error
      if (stopped.confirmed && this.processes.get(key) === lateProcess) this.processes.delete(key)
    }

    return { confirmed, hadProcess, ...(error ? { error } : {}) }
  }

  async stopAll(): Promise<ElectrobunStopResult[]> {
    const keys = new Set([
      ...this.activeTurns.keys(),
      ...this.processes.keys(),
      ...this.launches.keys(),
    ])
    return await Promise.all([...keys].map(async key => {
      const [workspaceId, cardId] = JSON.parse(key) as [string, string]
      return await this.stop({ workspaceId, cardId })
    }))
  }

  forceStopAll(): void {
    for (const [key, turnId] of this.activeTurns) {
      const [workspaceId, cardId] = JSON.parse(key) as [string, string]
      this.roomLifecycle.settle({ workspaceId, cardId, turnId }, 'stopped')
    }
    this.activeTurns.clear()
    this.failedTurns.clear()
    for (const record of this.processes.values()) {
      forceTerminateElectrobunProcessTree(record.process)
    }
    this.processes.clear()
  }

  private async terminateRecord(record: ProcessRecord): Promise<ElectrobunStopResult> {
    if (!record.termination) {
      record.termination = this.terminateProcessTree(record.process, {
        termGraceMs: this.options.termGraceMs,
        killWaitMs: this.options.killWaitMs,
      })
    }
    try {
      const result = await record.termination
      if (!result.confirmed) record.termination = undefined
      return result
    } catch (error) {
      record.termination = undefined
      return {
        confirmed: false,
        hadProcess: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async terminateProcessForLimit(
    turn: ElectrobunChatTurn,
    process: ChildProcess,
  ): Promise<ElectrobunStopResult> {
    const key = electrobunChatScopeKey(turn)
    const registered = this.processes.get(key)
    const record = registered?.process === process
      ? registered
      : { turnId: turn.turnId, process }
    const stopped = await this.terminateRecord(record)
    if (stopped.confirmed && this.processes.get(key) === record) this.processes.delete(key)
    return stopped
  }

  private sessionKey(scope: ElectrobunChatScope, provider: string): string {
    return JSON.stringify([scope.workspaceId, scope.cardId, provider])
  }
}
