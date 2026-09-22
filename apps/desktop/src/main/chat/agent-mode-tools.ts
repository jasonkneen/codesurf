import type { AgentMode } from '../../shared/types'

// AgentMode.tools allow-list semantics, shared by the runtime chat providers
// (claude/codex/hermes). The daemon has a parallel implementation in
// packages/codesurf-daemon/bin/chat-jobs.mjs + harness-runtime.mjs (kept
// separate because the daemon is a self-contained Node ESM process spawned
// apart from the renderer build). The test/daemon suite imports BOTH this module
// and the daemon helpers and asserts they agree, guarding against drift.
//
// This module is intentionally dependency-free (only `import type`) so the
// node --test daemon suite can import it directly under type-stripping.
//
// Three states for AgentMode.tools:
//   null / undefined → unrestricted (provider default toolset)
//   []               → explicit deny-all
//   [names...]       → restricted to those tool names

export function resolveAgentToolAllowList(agentMode?: AgentMode | null): string[] | null {
  const tools = agentMode?.tools
  return Array.isArray(tools) ? tools : null
}

// A-PR1 BLOCKING-1 (security): a selected agent id WITHOUT its resolved
// definition must NEVER launch unrestricted. The renderer restores `agentId`
// synchronously from tile state but loads the agent definitions asynchronously,
// so there is a window where a request carries `agentId` (incl. a deny-all
// Codex agent) but `agentMode` is still null. Providers enforce persona + tools
// from `agentMode`, so launching in that window would silently bypass ALL
// agent-definition restrictions. We FAIL CLOSED: if an agentId is present but
// the agentMode has not resolved, refuse to launch. Loose `== null` catches
// both the explicit null the renderer sends and an omitted field.
export function agentModeUnresolved(req: { agentId?: string | null; agentMode?: AgentMode | null }): boolean {
  const id = typeof req?.agentId === 'string' ? req.agentId.trim() : ''
  return id !== '' && req?.agentMode == null
}

export const AGENT_MODE_UNRESOLVED_ERROR =
  'A selected agent could not be applied: its definition has not loaded yet (the agent persona and tool restrictions are unavailable). Refusing to launch unrestricted — wait a moment and resend, or clear the selected agent.'

// Normalize a tool name for comparison: lowercase + drop non-alphanumerics.
// AgentMode.tools uses Claude-style PascalCase (Read, WebSearch); other runtimes
// name the same capabilities differently. This makes both sides comparable.
export function normalizeToolName(name: string): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Tools that can mutate the filesystem or run arbitrary shell commands. Bash is
// write-capable (it can rm/write). Used to decide whether Codex must drop to a
// read-only sandbox — Codex's CLI has no per-tool allow-list, so the sandbox is
// the only real toolset lever it exposes.
const WRITE_CAPABLE_TOOLS = new Set(
  ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'apply_patch'].map(normalizeToolName),
)

// Does the allow-list grant ANY write-capable tool?
//   null  → unrestricted → writes allowed (true)
//   []    → deny-all → no writes (false)
//   names → true iff at least one write-capable tool is listed
export function allowListGrantsWrite(allowList: string[] | null): boolean {
  if (allowList == null) return true
  if (allowList.length === 0) return false
  return allowList.some(t => WRITE_CAPABLE_TOOLS.has(normalizeToolName(t)))
}

// The Codex sandbox is the real enforcement primitive. When an allow-list is
// present and grants no write-capable tool, Codex must run read-only regardless
// of the requested mode — otherwise it could still edit files the agent
// definition forbids. Returns true when the sandbox must be forced read-only.
export function codexShouldForceReadOnly(allowList: string[] | null): boolean {
  return allowList != null && !allowListGrantsWrite(allowList)
}

// HONEST LIMITATION (A-PR1 #1b): Codex's CLI cannot express a TRUE deny-all.
// Its most restrictive sandbox (`read-only`) STILL PERMITS READS, and Codex has
// no per-tool flag — so an explicit deny-all ([]) is NOT enforceable. Rather
// than silently downgrade deny-all to a read-capable sandbox (which would
// overclaim "deny-all" while still letting the agent read the whole workspace),
// the Codex paths FAIL CLOSED: they refuse to launch and surface this error.
// Returns true when the allow-list is an explicit empty deny-all.
export function codexDenyAllUnsupported(allowList: string[] | null): boolean {
  return allowList != null && allowList.length === 0
}

export const CODEX_DENY_ALL_ERROR =
  'Codex cannot enforce a deny-all tool list (its most restrictive sandbox still permits file reads, and it has no per-tool gate). Refusing to launch this agent on Codex — pick a provider that can deny all tools, or grant at least Read.'

// Per-mode Codex sandbox + approval policy, as `codex exec` argv fragments.
// VERIFIED against codex-cli 0.139.0: `codex exec` exposes the sandbox via
// `-s/--sandbox <read-only|workspace-write|danger-full-access>` and the
// approval policy via `-c approval_policy=<value>`. The interactive
// `-a/--ask-for-approval` flag is NOT accepted by the `exec` subcommand, so the
// `-c` config override is the only way to set the policy non-interactively.
//
// UI mode → exec behavior:
//   default     → workspace-write + on-request  (risky actions ask; in
//                 non-interactive exec an unapprovable command is blocked)
//   auto        → workspace-write + on-failure  (run; escalate only on failure)
//   read-only   → read-only       + on-request
//   full-access → danger-full-access + never    (fully autonomous, no sandbox)
//
// A write-free (but non-empty) allow-list forces the sandbox to read-only
// regardless of mode — reads stay allowed (honest, NOT claimed as deny-all).
// THROWS CODEX_DENY_ALL_ERROR for an explicit deny-all ([]) so callers fail
// closed; they must catch and surface it rather than spawning Codex.
export type CodexUiMode = 'default' | 'auto' | 'read-only' | 'full-access'

const CODEX_MODE_POLICY: Record<CodexUiMode, { sandbox: string; approval: string }> = {
  'default': { sandbox: 'workspace-write', approval: 'on-request' },
  'auto': { sandbox: 'workspace-write', approval: 'on-failure' },
  'read-only': { sandbox: 'read-only', approval: 'on-request' },
  'full-access': { sandbox: 'danger-full-access', approval: 'never' },
}

export function codexSandboxApprovalFlags(mode: string, allowList: string[] | null): string[] {
  if (codexDenyAllUnsupported(allowList)) {
    throw new Error(CODEX_DENY_ALL_ERROR)
  }
  const policy = CODEX_MODE_POLICY[mode as CodexUiMode] ?? CODEX_MODE_POLICY.default
  // Write-free allow-list wins over the mode's sandbox (reads only).
  const sandbox = codexShouldForceReadOnly(allowList) ? 'read-only' : policy.sandbox
  return ['-s', sandbox, '-c', `approval_policy=${policy.approval}`]
}

// Hermes exposes coarse toolset *categories* (terminal/file/web/browser), not a
// per-tool allow-list. Map the agent's tool names to the categories they fall
// under — the finest restriction Hermes can actually enforce.
//
// Residual limitation: a list that allows some-but-not-all tools within a
// category enables the whole category (Hermes can't gate individual tools).
const HERMES_CATEGORY: Record<string, string> = {}
for (const t of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit', 'Glob', 'Grep', 'LS']) {
  HERMES_CATEGORY[normalizeToolName(t)] = 'file'
}
for (const t of ['Bash', 'BashOutput', 'KillBash']) HERMES_CATEGORY[normalizeToolName(t)] = 'terminal'
for (const t of ['WebSearch', 'WebFetch']) HERMES_CATEGORY[normalizeToolName(t)] = 'web'

const HERMES_CATEGORY_ORDER = ['terminal', 'file', 'web', 'browser']

// Derive a Hermes `--toolsets` value from the allow-list.
//   null  → null (caller falls back to mode/toolsets default)
//   []    → '' (deny-all → query-only, no toolsets)
//   names → canonical comma-joined categories the listed tools belong to
export function hermesToolsetsFromAllowList(allowList: string[] | null): string | null {
  if (allowList == null) return null
  const cats = new Set<string>()
  for (const t of allowList) {
    const norm = normalizeToolName(t)
    const cat = HERMES_CATEGORY[norm] ?? (norm.startsWith('browser') ? 'browser' : null)
    if (cat) cats.add(cat)
  }
  return HERMES_CATEGORY_ORDER.filter(c => cats.has(c)).join(',')
}

// The Claude Agent SDK's top-level `tools` option (and an AgentDefinition's
// `tools`) treats `[]` as "disable all built-in tools" and an omitted value as
// the default preset. So pass the allow-list through verbatim, returning
// undefined only when unrestricted (so the option is left off entirely).
export function claudeToolsForAllowList(allowList: string[] | null): string[] | undefined {
  return allowList == null ? undefined : allowList
}
