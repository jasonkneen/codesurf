import type { ChildProcess, SpawnOptions } from 'node:child_process'

export const PROCESS_TREE_TERM_GRACE_MS: number
export const PROCESS_TREE_KILL_WAIT_MS: number

export type ProcessTreeTerminationResult = {
  confirmed: boolean
  pid: number | null
  stage: 'already-exited' | 'sigterm' | 'sigkill' | 'taskkill' | 'failed'
  detail: string
}

export type ProcessTreeTerminationOptions = {
  termGraceMs?: number
  killWaitMs?: number
  spawnProcess?: typeof import('node:child_process').spawn
}

export function processTreeSpawnOptions<T extends SpawnOptions>(options?: T): T & SpawnOptions
export function terminateProcessTree(
  proc: ChildProcess,
  options?: ProcessTreeTerminationOptions,
): Promise<ProcessTreeTerminationResult>

export const __test: {
  isPosixProcessGroupAlive(pid: number): boolean
  runWindowsTaskkill(
    pid: number,
    timeoutMs: number,
    spawnProcess?: typeof import('node:child_process').spawn,
  ): Promise<{ confirmed: boolean, detail: string }>
  waitForPosixProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean>
}
