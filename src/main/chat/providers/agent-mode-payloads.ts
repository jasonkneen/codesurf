// Pure, dependency-free constructors for the agent-mode-relevant portion of each
// runtime provider's launch payload (Hermes argv, Codex argv, Claude tool/persona
// options). chatHermes/chatCodex/chatClaude call THESE — they do not reconstruct
// the payload inline — so the daemon `node --test` suite can assert the REAL
// constructed payload (not a source-regex) and a regression in the actual call
// path fails the test (A-PR1 BLOCKING-3 / #1c).
//
// This module is intentionally dependency-free at runtime (only `import type` +
// imports from other dependency-free modules: agent-mode-tools, hermes-prompt,
// agent-cli-contracts, prompt-builders, prompt-conventions) so it loads under
// node's type-stripping in the test runner.
//
// Both fail-closed checks live INSIDE these builders so they THROW (the same
// pattern as the daemon `buildCodexExecArgs`): callers catch-and-surface, which
// makes BLOCKING-1's runtime guard behaviorally testable rather than a regex.

import type { Persona } from '../../../shared/types'
// Relative imports carry the .ts extension so the daemon `node --test` runner
// can load this module under native type-stripping (no bundler). The repo enables
// allowImportingTsExtensions, and esbuild/tsgo resolve these the same way.
import { buildHermesChatArgs } from '../../agents/agent-cli-contracts.ts'
import { buildHermesTurnPrompt } from './hermes-prompt.ts'
import {
  resolveAgentToolAllowList,
  hermesToolsetsFromAllowList,
  claudeToolsForAllowList,
  codexSandboxApprovalFlags,
  agentModeUnresolved,
  AGENT_MODE_UNRESOLVED_ERROR,
} from '../agent-mode-tools.ts'

interface AgentModeSelection {
  agentId?: string | null
  // Field name `agentMode` retained for cross-process wire compatibility; its
  // type is now Persona (the renamed concept).
  agentMode?: Persona | null
}

// ── Hermes ───────────────────────────────────────────────────────────────────

const HERMES_MODE_TOOLSETS: Record<string, string> = {
  full: 'terminal,file,web,browser',
  terminal: 'terminal,file',
  web: 'web,browser',
  query: '',
}

export interface HermesSpawnInput extends AgentModeSelection {
  mode?: string
  model: string
  userContent: string
  existingSessionId?: string | null
  contextPrompt?: string
  /** Only set after probing `hermes chat --help` for `--stream-json`. */
  streamJson?: boolean
}

// Build the `hermes chat` argv chatHermes spawns. AgentMode.tools maps onto
// Hermes' coarse toolset categories (the finest restriction it can enforce);
// the persona rides inside the turn prompt (Hermes has no system-prompt flag).
export function buildHermesSpawnArgs(input: HermesSpawnInput): string[] {
  if (agentModeUnresolved(input)) throw new Error(AGENT_MODE_UNRESOLVED_ERROR)
  const agentToolsets = hermesToolsetsFromAllowList(resolveAgentToolAllowList(input.agentMode))
  const toolsets = agentToolsets ?? (HERMES_MODE_TOOLSETS[input.mode ?? ''] ?? 'terminal,file,web')
  const prompt = buildHermesTurnPrompt({
    userContent: input.userContent,
    contextPrompt: input.contextPrompt,
  })
  return buildHermesChatArgs({
    prompt,
    model: input.model,
    resumeSessionId: input.existingSessionId ?? undefined,
    toolsets,
    streamJson: input.streamJson === true,
  })
}

// ── Codex ────────────────────────────────────────────────────────────────────

function buildCodexPrompt(
  userText: string,
  contextPrompt: string | undefined,
): string {
  const preamble = contextPrompt?.trim() || undefined
  return preamble ? `${preamble}\n\n## User Request\n${userText}` : userText
}

export interface CodexSpawnInput extends AgentModeSelection {
  mode?: string
  model: string
  userContent: string
  resumeThreadId?: string | null
  workspaceDir?: string
  contextPrompt?: string
  /** Legacy fields are intentionally ignored; only host composition is model-visible. */
  peerPrompt?: string
  memoryPrompt?: string
  skillsPrompt?: string
  asyncExecution?: unknown
}

// Build the `codex exec` argv chatCodex spawns. Codex's CLI has no per-tool
// allow-list, so AgentMode.tools maps onto the sandbox (the only real lever):
// codexSandboxApprovalFlags forces read-only for a write-free list and THROWS
// CODEX_DENY_ALL_ERROR for an unenforceable deny-all ([]). chatCodex catches and
// surfaces the throw (fail closed) rather than spawning Codex.
/**
 * Codex session ids are opaque tokens minted by the CLI, but `resumeThreadId`
 * arrives from the renderer/IPC and is not covered by
 * PRIVILEGED_CHAT_CONTEXT_FIELDS or canonicalizeElectronChatRequest. It is
 * emitted as a bare positional after `resume`, so anything starting with `-` is
 * read by clap as an option instead: `--config=sandbox_mode="danger-full-access"`
 * would override the host-selected sandbox, and `--last` would resume an
 * unrelated workspace's thread. Accept only the shape a real session id has.
 */
const CODEX_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

export function assertValidCodexSessionId(value: string): string {
  if (!CODEX_SESSION_ID.test(value)) {
    throw new Error(`Refusing to resume codex with an invalid session id: ${JSON.stringify(value)}`)
  }
  return value
}

export function buildCodexSpawnArgs(input: CodexSpawnInput): string[] {
  if (agentModeUnresolved(input)) throw new Error(AGENT_MODE_UNRESOLVED_ERROR)
  const codexMode = input.mode === 'default' || input.mode === 'auto' || input.mode === 'read-only' || input.mode === 'full-access'
    ? input.mode
    : 'default'
  const sandboxApprovalFlags = codexSandboxApprovalFlags(codexMode, resolveAgentToolAllowList(input.agentMode))
  const promptText = buildCodexPrompt(
    input.userContent,
    input.contextPrompt,
  )

  // Codex CLI grammar is `codex exec [OPTIONS] resume <SESSION_ID> [PROMPT]`:
  // every exec-level OPTION (--json, --model, sandbox/approval flags,
  // --ignore-user-config, --skip-git-repo-check, -C <dir>) MUST precede the
  // `resume` subcommand — only SESSION_ID and PROMPT follow it. Emitting
  // `resume` before the options makes codex reject the trailing flags with
  // `error: unexpected argument '-C' found`, breaking multi-turn resume. So push
  // all options first, THEN (when resuming) `resume <threadId>`, THEN the prompt.
  const args: string[] = ['exec']
  args.push('--json', '--model', input.model)
  args.push(...sandboxApprovalFlags)
  args.push('--ignore-user-config')
  if (input.workspaceDir) args.push('--skip-git-repo-check', '-C', input.workspaceDir)
  else args.push('--skip-git-repo-check')
  if (input.resumeThreadId) args.push('resume', assertValidCodexSessionId(input.resumeThreadId))
  args.push(promptText)
  return args
}

// ── Claude ───────────────────────────────────────────────────────────────────

export interface ClaudeAgentModeOptions {
  // SDK `tools` restriction: undefined = unrestricted (option omitted), [] =
  // deny-all (true on the SDK path), [names] = restricted.
  tools: string[] | undefined
  // AgentMode persona (systemPrompt), or undefined when none.
  persona: string | undefined
}

// Resolve the agent-mode portion of the Claude SDK options chatClaude assembles:
// the tools allow-list (→ options.tools and the active agent's own tools) and the
// persona. Throws when a selected agent has no resolved definition (fail closed).
export function buildClaudeAgentModeOptions(input: AgentModeSelection): ClaudeAgentModeOptions {
  if (agentModeUnresolved(input)) throw new Error(AGENT_MODE_UNRESOLVED_ERROR)
  const tools = claudeToolsForAllowList(resolveAgentToolAllowList(input.agentMode))
  const persona = input.agentMode?.systemPrompt?.trim() || undefined
  return { tools, persona }
}
