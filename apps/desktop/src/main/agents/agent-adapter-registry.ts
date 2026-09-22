import type {
  AgentAdapterAvailabilitySummary,
  AgentAdapterCapability,
  AgentAdapterCapabilityId,
  AgentAdapterDefinition,
  AgentPathEntryLike,
} from './agent-adapter-types.ts'

function capabilities(enabled: AgentAdapterCapabilityId[], notes: Partial<Record<AgentAdapterCapabilityId, string>> = {}): AgentAdapterCapability[] {
  const labels: Record<AgentAdapterCapabilityId, string> = {
    headlessRun: 'Headless run',
    streamJson: 'JSON stream',
    resume: 'Resume',
    modelSelect: 'Model select',
    cwdSelect: 'Workspace/cwd',
    approvalMode: 'Approval mode',
    mcp: 'MCP',
    acp: 'ACP',
    sessionImport: 'Session import',
    readOnlyHistory: 'Read-only history',
  }
  return (Object.keys(labels) as AgentAdapterCapabilityId[]).map(id => ({
    id,
    label: labels[id],
    enabled: enabled.includes(id),
    ...(notes[id] ? { note: notes[id] } : {}),
  }))
}

export const AGENT_ADAPTER_DEFINITIONS: AgentAdapterDefinition[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    shortName: 'Claude',
    description: 'Native Claude Code SDK integration with persistent sessions and tool permissions.',
    executionShape: 'native-sdk',
    binaryCandidates: ['claude'],
    headlessCommandName: 'claude',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    setupHint: 'Install Claude Code and sign in before using Claude-backed CodeSurf lanes.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'cwdSelect', 'approvalMode', 'mcp']),
  },
  {
    id: 'codex',
    displayName: 'Codex',
    description: 'OpenAI Codex CLI execution lane.',
    executionShape: 'headless-cli',
    binaryCandidates: ['codex'],
    headlessCommandName: 'codex',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    installHint: 'npm install -g @openai/codex',
    setupHint: 'Install Codex CLI and authenticate it for local headless runs.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'cwdSelect', 'approvalMode', 'mcp']),
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    description: 'OpenCode SDK/server and one-shot run integration lane.',
    executionShape: 'server-capable',
    binaryCandidates: ['opencode'],
    headlessCommandName: 'opencode',
    versionArgs: ['--version'],
    helpArgs: ['run', '--help'],
    installHint: 'go install github.com/opencodeco/opencode@latest',
    setupHint: 'Install OpenCode and keep SDK/server lifecycle separate from one-shot opencode run calls.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'cwdSelect', 'approvalMode', 'mcp', 'sessionImport']),
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    description: 'OpenClaw JSON agent/session execution lane.',
    executionShape: 'daemon-cli',
    binaryCandidates: ['openclaw'],
    headlessCommandName: 'openclaw',
    versionArgs: ['--version'],
    helpArgs: ['agent', '--help'],
    installHint: 'npm install -g openclaw',
    setupHint: 'Install OpenClaw and configure at least one stable agent for JSON agent calls.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'approvalMode', 'sessionImport']),
  },
  {
    id: 'hermes',
    displayName: 'Hermes Agent',
    shortName: 'Hermes',
    description: 'Hermes Agent CLI lane with explicit CodeSurf-owned context policy.',
    executionShape: 'headless-cli',
    binaryCandidates: ['hermes'],
    headlessCommandName: 'hermes',
    versionArgs: ['--version'],
    helpArgs: ['chat', '--help'],
    installHint: 'Install Hermes Agent and ensure hermes is on PATH.',
    setupHint: 'Install Hermes Agent and let CodeSurf pass inspected context with hermes chat --query.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'cwdSelect', 'approvalMode', 'mcp']),
  },
  {
    id: 'cursor-agent',
    displayName: 'Cursor Agent',
    shortName: 'Cursor',
    description: 'Cursor headless coding agent. Use cursor-agent for automation, not the GUI cursor command.',
    executionShape: 'headless-cli',
    binaryCandidates: ['cursor-agent'],
    headlessCommandName: 'cursor-agent',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    installHint: 'Install Cursor Agent from Cursor and make cursor-agent available on PATH.',
    setupHint: 'Install Cursor Agent and use cursor-agent --print for headless CodeSurf lanes.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'cwdSelect', 'approvalMode']),
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    shortName: 'Gemini',
    description: 'Google Gemini CLI headless prompt integration.',
    executionShape: 'headless-cli',
    binaryCandidates: ['gemini'],
    headlessCommandName: 'gemini',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    installHint: 'npm install -g @google/gemini-cli',
    setupHint: 'Install Gemini CLI and authenticate it before using Gemini headless lanes.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'cwdSelect', 'approvalMode', 'mcp']),
  },
  {
    id: 'cline',
    displayName: 'Cline',
    description: 'Cline CLI task runner and optional ACP lane.',
    executionShape: 'acp-capable',
    binaryCandidates: ['cline'],
    headlessCommandName: 'cline',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    installHint: 'Install Cline CLI and authenticate providers through Cline.',
    setupHint: 'Install Cline CLI. CodeSurf should use task/json mode for headless runs and keep ACP separate.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'cwdSelect', 'approvalMode', 'acp', 'sessionImport']),
  },
  {
    id: 'amp',
    displayName: 'Amp',
    description: 'Amp execute-mode CLI integration with thread-based resume.',
    executionShape: 'headless-cli',
    binaryCandidates: ['amp'],
    headlessCommandName: 'amp',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    installHint: 'Install Amp and configure AMP_API_KEY outside CodeSurf.',
    setupHint: 'Install Amp, authenticate it outside CodeSurf, and prefer --execute --stream-json with --no-ide.',
    capabilities: capabilities(['headlessRun', 'streamJson', 'resume', 'modelSelect', 'approvalMode', 'mcp', 'sessionImport']),
  },
  {
    id: 'kilo',
    displayName: 'Kilo Code',
    shortName: 'Kilo',
    description: 'Kilo Code CLI adapter, discovery-first until the binary is installed and contract-tested.',
    executionShape: 'acp-capable',
    binaryCandidates: ['kilo'],
    headlessCommandName: 'kilo',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    installHint: 'npm install -g @kilocode/cli',
    setupHint: 'Install with npm install -g @kilocode/cli, then use kilo run / kilo session / kilo export as supported.',
    capabilities: capabilities(['headlessRun', 'resume', 'modelSelect', 'approvalMode', 'mcp', 'acp', 'sessionImport', 'readOnlyHistory']),
  },
]

export const AGENT_ADAPTER_IDS = AGENT_ADAPTER_DEFINITIONS.map(adapter => adapter.id)

function cloneAdapter(adapter: AgentAdapterDefinition): AgentAdapterDefinition {
  return {
    ...adapter,
    binaryCandidates: [...adapter.binaryCandidates],
    versionArgs: [...adapter.versionArgs],
    helpArgs: [...adapter.helpArgs],
    capabilities: adapter.capabilities.map(capability => ({ ...capability })),
  }
}

export function getAgentAdapterDefinitions(): AgentAdapterDefinition[] {
  return AGENT_ADAPTER_DEFINITIONS.map(cloneAdapter)
}

export function getAgentAdapterDefinition(adapterId: string): AgentAdapterDefinition | null {
  const adapter = AGENT_ADAPTER_DEFINITIONS.find(candidate => candidate.id === adapterId) ?? null
  return adapter ? cloneAdapter(adapter) : null
}

export function summarizeAgentAdapterAvailability(
  adapter: AgentAdapterDefinition,
  entry: AgentPathEntryLike | null | undefined,
): AgentAdapterAvailabilitySummary {
  const hasRunnableCapability = adapter.capabilities.some(capability => capability.id === 'headlessRun' && capability.enabled)
  const hasImportOnlyCapability = adapter.capabilities.some(capability => capability.id === 'sessionImport' && capability.enabled)
    || adapter.capabilities.some(capability => capability.id === 'readOnlyHistory' && capability.enabled)

  if (!hasRunnableCapability && hasImportOnlyCapability) {
    return {
      adapterId: adapter.id,
      displayName: adapter.displayName,
      status: 'import-only',
      canRun: false,
      path: entry?.path ?? null,
      version: entry?.version ?? null,
      confirmed: Boolean(entry?.confirmed),
      setupHint: adapter.setupHint,
      capabilities: adapter.capabilities.map(capability => ({ ...capability })),
    }
  }

  if (!entry?.path) {
    return {
      adapterId: adapter.id,
      displayName: adapter.displayName,
      status: 'missing',
      canRun: false,
      path: null,
      version: null,
      confirmed: false,
      setupHint: adapter.setupHint,
      capabilities: adapter.capabilities.map(capability => ({ ...capability })),
    }
  }

  return {
    adapterId: adapter.id,
    displayName: adapter.displayName,
    status: entry.confirmed ? 'ready' : 'installed-needs-confirmation',
    canRun: hasRunnableCapability,
    path: entry.path,
    version: entry.version,
    confirmed: entry.confirmed,
    setupHint: adapter.setupHint,
    capabilities: adapter.capabilities.map(capability => ({ ...capability })),
  }
}
