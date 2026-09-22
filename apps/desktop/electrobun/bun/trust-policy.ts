import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, Workspace } from '../../src/shared/types.ts'
import type { ChatRequest } from '../../src/main/chat/types.ts'
import {
  loadAuthoritativeChatPeers,
  type AuthoritativeChatPeers,
} from '../../src/main/chat/peer-authority.ts'
import { resolveAuthoritativeAgentMode } from '../../src/main/chat/agent-mode-resolver.ts'
import { composeChatContext, type ComposedChatContext } from '../../src/main/chat/context-composer.ts'
import { buildAsyncExecutionPrompt } from '../../src/main/chat/prompt-builders.ts'
import {
  buildCodeSurfActivityConvention,
  buildCodeSurfInsightConvention,
  buildCodeSurfOutputConvention,
} from '../../src/main/chat/prompt-conventions.ts'
import {
  applyAuthoritativePersonaPolicy,
  canonicalizeElectronChatRequest,
} from '../../src/main/chat/request-policy.ts'
import {
  buildClaudeAgentModeOptions,
  buildCodexSpawnArgs,
  buildHermesSpawnArgs,
} from '../../src/main/chat/providers/agent-mode-payloads.ts'
import {
  validateCanonicalFsPathDetails,
  type FsPathIntent,
  type ValidatedFsPath,
} from '../../src/main/ipc/fs.ts'

export type ElectrobunChatRequest = Partial<ChatRequest> & Pick<ChatRequest, 'cardId'>

export interface ElectrobunWorkspaceAuthority {
  settings: AppSettings
  workspaces: Workspace[]
}

export interface AuthorizedElectrobunPath {
  path: ValidatedFsPath
  workspaceId: string | null
  allowedRoots: string[]
}

export interface TrustedElectrobunChatContext {
  memoryPrompt?: string
  contextBuckets?: ChatRequest['contextBuckets']
  skillsPrompt?: string
  skillsSummary?: string | null
  roomContext?: string
  roomAckSequence?: number
  expandedMessages?: ChatRequest['expandedMessages']
  fileReferencePrompt?: string
  imageAttachments?: ChatRequest['imageAttachments']
  consumedAttachmentCapabilities?: string[]
  asyncExecution?: ChatRequest['asyncExecution']
}

export interface ElectrobunProviderContext {
  systemPrompt: string | undefined
  userContent: string
  composed: ComposedChatContext
}

function workspaceRoots(workspace: Workspace | null | undefined): string[] {
  if (!workspace) return []
  const roots = new Set<string>()
  const candidates = [workspace.path, ...(workspace.projectPaths ?? [])]
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) roots.add(path.resolve(value))
  }
  return [...roots]
}

export function findElectrobunWorkspace(
  workspaces: Workspace[],
  workspaceId: unknown,
): Workspace {
  const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (!id) throw new Error('Access denied: workspaceId is required while filesystem scoping is enabled')
  const workspace = workspaces.find(candidate => candidate.id === id)
  if (!workspace) throw new Error(`Access denied: workspace not found: ${id}`)
  return workspace
}

export async function authorizeElectrobunFsPath(options: ElectrobunWorkspaceAuthority & {
  filePath: string
  intent: FsPathIntent
  workspaceId?: unknown
  allowReadOnlyOpenCodeConfig?: boolean
}): Promise<AuthorizedElectrobunPath> {
  const restrictToWorkspaceRoots = options.settings.security.restrictFsToWorkspaceRoots
  if (!restrictToWorkspaceRoots) {
    return {
      path: await validateCanonicalFsPathDetails(options.filePath, options.intent, {
        allowReadOnlyOpenCodeConfig: options.allowReadOnlyOpenCodeConfig,
      }),
      workspaceId: null,
      allowedRoots: [],
    }
  }

  const workspace = findElectrobunWorkspace(options.workspaces, options.workspaceId)
  const allowedRoots = workspaceRoots(workspace)
  return {
    path: await validateCanonicalFsPathDetails(options.filePath, options.intent, {
      restrictToWorkspaceRoots: true,
      allowedRoots,
      allowReadOnlyOpenCodeConfig: options.allowReadOnlyOpenCodeConfig,
    }),
    workspaceId: workspace.id,
    allowedRoots,
  }
}

/**
 * Terminal creation has no workspaceId field in the preload contract. Resolve
 * its cwd only by matching the canonical candidate against host-owned workspace
 * records, then run the same scoped path validator used by fs:* handlers.
 */
export async function authorizeElectrobunTerminalPath(options: ElectrobunWorkspaceAuthority & {
  filePath: string
  intent?: FsPathIntent
}): Promise<AuthorizedElectrobunPath> {
  const intent = options.intent ?? 'directory'
  if (!options.settings.security.restrictFsToWorkspaceRoots) {
    return await authorizeElectrobunFsPath({ ...options, intent })
  }

  const unscoped = await validateCanonicalFsPathDetails(options.filePath, intent)
  const candidates: Array<{ workspace: Workspace, root: string }> = []
  for (const workspace of options.workspaces) {
    for (const root of workspaceRoots(workspace)) {
      try {
        const canonicalRoot = await realpath(root)
        if (
          unscoped.operationPath === canonicalRoot
          || unscoped.operationPath.startsWith(`${canonicalRoot}${path.sep}`)
        ) {
          candidates.push({ workspace, root: canonicalRoot })
        }
      } catch {
        // A missing or broken configured root cannot authorize a terminal cwd.
      }
    }
  }
  candidates.sort((left, right) => right.root.length - left.root.length)
  const selected = candidates[0]?.workspace
  if (!selected) {
    throw new Error(`Access denied: terminal path "${options.filePath}" is outside registered workspace roots`)
  }
  return await authorizeElectrobunFsPath({
    ...options,
    intent,
    workspaceId: selected.id,
  })
}

function primaryWorkspaceRoot(workspace: Workspace | null | undefined): string | null {
  return workspaceRoots(workspace)[0] ?? null
}

export async function canonicalizeElectrobunChatRequest(
  request: ElectrobunChatRequest,
  workspaces: Workspace[],
): Promise<ChatRequest> {
  const canonical = await canonicalizeElectronChatRequest(
    request as ChatRequest,
    workspaceId => primaryWorkspaceRoot(
      workspaces.find(workspace => workspace.id === workspaceId),
    ),
  )
  const resolution = await resolveAuthoritativeAgentMode({
    agentId: canonical.agentId ?? null,
    resolveWorkspaceRoot: () => canonical.workspaceDir ?? null,
  })
  if (!resolution.ok) throw new Error(resolution.error)
  return applyAuthoritativePersonaPolicy({
    ...canonical,
    // Renderer-supplied runtime topology is useful input, but execution-host
    // claims are privileged. The host derives these again after policy binding.
    asyncExecution: undefined,
    roomContext: undefined,
    roomAckSequence: undefined,
  }, resolution.agentMode)
}

function trustedOptionalString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

function trustedRoomAckSequence(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined
}

export async function prepareElectrobunChatRequest(
  request: ElectrobunChatRequest,
  workspaces: Workspace[],
  loadTrustedContext: (request: ChatRequest) => Promise<TrustedElectrobunChatContext>,
  loadAuthoritativePeers: (
    workspaceId: string,
    tileId: string,
    submittedPeers?: unknown,
  ) => Promise<AuthoritativeChatPeers> = loadAuthoritativeChatPeers,
): Promise<ChatRequest> {
  const canonical = await canonicalizeElectrobunChatRequest(request, workspaces)
  return await prepareCanonicalElectrobunChatRequest(
    canonical,
    request.peers,
    loadTrustedContext,
    loadAuthoritativePeers,
  )
}

export async function prepareCanonicalElectrobunChatRequest(
  canonical: ChatRequest,
  submittedPeers: unknown,
  loadTrustedContext: (request: ChatRequest) => Promise<TrustedElectrobunChatContext>,
  loadAuthoritativePeers: (
    workspaceId: string,
    tileId: string,
    submittedPeers?: unknown,
  ) => Promise<AuthoritativeChatPeers> = loadAuthoritativeChatPeers,
): Promise<ChatRequest> {
  const peerAuthority = await loadAuthoritativePeers(
    String(canonical.workspaceId ?? ''),
    canonical.cardId,
    submittedPeers,
  )
  const authoritative = {
    ...canonical,
    peers: peerAuthority.peers,
    untrustedPeerContext: peerAuthority.untrustedPeerContext,
  }
  const trusted = await loadTrustedContext(authoritative)
  return {
    ...authoritative,
    memoryPrompt: trustedOptionalString(trusted.memoryPrompt),
    contextBuckets: trusted.contextBuckets,
    skillsPrompt: trustedOptionalString(trusted.skillsPrompt),
    skillsSummary: trustedOptionalString(trusted.skillsSummary) ?? null,
    roomContext: trustedOptionalString(trusted.roomContext),
    roomAckSequence: trustedRoomAckSequence(trusted.roomAckSequence),
    expandedMessages: trusted.expandedMessages,
    fileReferencePrompt: trustedOptionalString(trusted.fileReferencePrompt),
    imageAttachments: trusted.imageAttachments,
    asyncExecution: trusted.asyncExecution,
  }
}

export function composeElectrobunProviderContext(
  request: ChatRequest,
  userContent: string,
  options: { includePersona?: boolean, includeStableContext?: boolean } = {},
): ElectrobunProviderContext {
  const includeStableContext = options.includeStableContext !== false
  const composed = composeChatContext({
    persona: includeStableContext && options.includePersona !== false
      ? request.agentMode?.systemPrompt
      : undefined,
    memory: includeStableContext ? request.memoryPrompt : undefined,
    skills: includeStableContext ? request.skillsPrompt : undefined,
    outputConvention: includeStableContext ? buildCodeSurfOutputConvention() : undefined,
    insightConvention: includeStableContext ? buildCodeSurfInsightConvention() : undefined,
    activityConvention: includeStableContext ? buildCodeSurfActivityConvention() : undefined,
    // Execution topology is host-owned but can change between turns, so Codex
    // continuation turns must receive it even after stable context is installed.
    async: buildAsyncExecutionPrompt(request.asyncExecution),
    // Canvas topology is host-validated functional state, but tile metadata
    // remains user-controlled data. synchronizeRoom carries it in the
    // untrusted user suffix instead of granting it system-prompt authority.
    peer: undefined,
    room: request.roomContext,
    fileReferences: request.fileReferencePrompt,
    recentEdit: request.recentEditContext,
    blockNotes: request.blockNotesContext,
  })
  return {
    systemPrompt: composed.systemPrompt,
    userContent: composed.userSuffix
      ? `${userContent}\n\n${composed.userSuffix}`
      : userContent,
    composed,
  }
}

function claudePermissionMode(mode: unknown): string {
  switch (mode) {
    case 'acceptEdits':
    case 'auto':
    case 'bypassPermissions':
    case 'dontAsk':
    case 'plan':
      return mode
    case 'read-only':
      return 'plan'
    default:
      return 'manual'
  }
}

export function buildElectrobunClaudeSpawnArgs(
  request: ChatRequest,
  prompt: string,
  resumeSessionId?: string | null,
  options: { streamInput?: boolean } = {},
): string[] {
  const { tools } = buildClaudeAgentModeOptions(request)
  const context = composeElectrobunProviderContext(request, prompt)
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages']
  if (options.streamInput) args.push('--input-format', 'stream-json')
  if (request.model) args.push('--model', request.model)
  args.push('--permission-mode', claudePermissionMode(request.mode))
  if (context.systemPrompt) args.push('--append-system-prompt', context.systemPrompt)
  if (tools !== undefined) args.push('--tools', tools.join(','))
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  if (!options.streamInput) args.push(context.userContent)
  return args
}

export function buildElectrobunCodexSpawnArgs(
  request: ChatRequest,
  prompt: string,
  workspaceDir: string,
  resumeThreadId?: string | null,
  options: { includeStableContext?: boolean } = {},
): string[] {
  // Callers that have not installed the acceptance-gated ledger use the
  // provider's resume flag as the conservative public-helper default. The
  // Electrobun runtime passes an explicit decision from
  // ElectrobunCodexStableContextRuntime, so a bare id can never suppress
  // context in the production path without a committed session proof.
  const includeStableContext = options.includeStableContext ?? !resumeThreadId
  const context = composeElectrobunProviderContext(request, prompt, {
    includeStableContext,
  })
  return buildCodexSpawnArgs({
    agentId: request.agentId,
    agentMode: request.agentMode,
    mode: request.mode,
    model: request.model || 'gpt-5.5',
    userContent: context.userContent,
    resumeThreadId,
    workspaceDir,
    contextPrompt: context.systemPrompt,
  })
}

export function buildElectrobunHermesSpawnArgs(
  request: ChatRequest,
  prompt: string,
  resumeSessionId?: string | null,
): string[] {
  const context = composeElectrobunProviderContext(request, prompt)
  return buildHermesSpawnArgs({
    agentId: request.agentId,
    agentMode: request.agentMode,
    mode: request.mode,
    model: request.model,
    userContent: context.userContent,
    existingSessionId: resumeSessionId,
    contextPrompt: context.systemPrompt,
  })
}

export function buildElectrobunPersonaPrompt(
  prompt: string,
  request: ChatRequest,
): string {
  const context = composeElectrobunProviderContext(request, prompt)
  return context.systemPrompt
    ? `${context.systemPrompt}\n\n## User Request\n${context.userContent}`
    : context.userContent
}
