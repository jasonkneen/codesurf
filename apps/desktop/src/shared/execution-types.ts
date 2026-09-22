export type ExecutionHostType = 'runtime' | 'local-daemon' | 'remote-daemon'
export type ExecutionMode = 'auto' | 'runtime-only' | 'prefer-local-daemon' | 'daemon-only' | 'specific-host'

export interface ExecutionHostRecord {
  id: string
  type: ExecutionHostType
  label: string
  enabled: boolean
  url?: string | null
  authToken?: string | null
}

export interface ExecutionPreference {
  mode: ExecutionMode
  hostId: string | null
}
