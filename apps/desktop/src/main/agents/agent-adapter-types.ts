export type AgentAdapterCapabilityId =
  | 'headlessRun'
  | 'streamJson'
  | 'resume'
  | 'modelSelect'
  | 'cwdSelect'
  | 'approvalMode'
  | 'mcp'
  | 'acp'
  | 'sessionImport'
  | 'readOnlyHistory'

export type AgentAdapterExecutionShape =
  | 'native-sdk'
  | 'headless-cli'
  | 'daemon-cli'
  | 'acp-capable'
  | 'server-capable'
  | 'import-only'

export type AgentAdapterReadinessStatus =
  | 'ready'
  | 'installed-needs-confirmation'
  | 'missing'
  | 'import-only'

export interface AgentAdapterCapability {
  id: AgentAdapterCapabilityId
  label: string
  enabled: boolean
  note?: string
}

export interface AgentAdapterDefinition {
  id: string
  displayName: string
  shortName?: string
  description: string
  executionShape: AgentAdapterExecutionShape
  binaryCandidates: string[]
  headlessCommandName: string
  versionArgs: string[]
  helpArgs: string[]
  installHint: string
  setupHint: string
  capabilities: AgentAdapterCapability[]
  docsUrl?: string
}

export interface AgentPathEntryLike {
  path: string | null
  version: string | null
  detectedAt: string
  confirmed: boolean
}

export interface AgentAdapterAvailabilitySummary {
  adapterId: string
  displayName: string
  status: AgentAdapterReadinessStatus
  canRun: boolean
  path: string | null
  version: string | null
  confirmed: boolean
  setupHint: string
  capabilities: AgentAdapterCapability[]
}
