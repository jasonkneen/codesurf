// AgentMode.tools allow-list semantics for the CodeSurf daemon (Codex / Hermes /
// harness paths). This is the daemon-side mirror of the runtime providers'
// src/main/chat/agent-mode-tools.ts — kept separate because the daemon is a
// self-contained Node ESM process bundled apart from the renderer. The
// test/daemon suite imports BOTH and asserts they agree (cross-consistency
// guard against drift).
//
// Three states for AgentMode.tools:
//   null / undefined → unrestricted (provider default toolset)
//   []               → explicit deny-all
//   [names...]       → restricted to those tool names

export function resolveAgentToolAllowList(agentMode) {
  const tools = agentMode?.tools
  return Array.isArray(tools) ? tools : null
}

// A-PR1 BLOCKING-1 (security): a selected agent id WITHOUT its resolved
// definition must NEVER launch unrestricted. Mirror of
// src/main/chat/agent-mode-tools.ts (drift-guarded by the daemon test suite).
// The renderer restores `agentId` synchronously but loads agent definitions
// asynchronously, so a request can carry `agentId` (incl. a deny-all agent)
// while `agentMode` is still null. Enforcement reads persona + tools from
// `agentMode`, so launching in that window silently bypasses ALL agent-definition
// restrictions. FAIL CLOSED: agentId present + agentMode unresolved → refuse.
export function agentModeUnresolved(req) {
  const id = typeof req?.agentId === 'string' ? req.agentId.trim() : ''
  return id !== '' && req?.agentMode == null
}

export const AGENT_MODE_UNRESOLVED_ERROR =
  'A selected agent could not be applied: its definition has not loaded yet (the agent persona and tool restrictions are unavailable). Refusing to launch unrestricted — wait a moment and resend, or clear the selected agent.'

// Normalize a tool name for comparison: lowercase + drop non-alphanumerics.
// AgentMode.tools uses Claude-style PascalCase (Read, WebSearch); harness
// builtins are lowercase (read, webSearch). This makes both sides comparable.
export function normalizeToolName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Is `toolName` permitted by the agent definition's allow-list?
//   null/undefined → unrestricted → everything allowed (true)
//   []             → explicit deny-all → nothing allowed (false)
//   [names...]     → true iff the tool matches a listed name
export function isToolAllowedByAgent(toolName, allowList) {
  if (allowList == null) return true
  if (!Array.isArray(allowList)) return true
  if (allowList.length === 0) return false
  const wanted = normalizeToolName(toolName)
  if (!wanted) return false
  return allowList.some(entry => normalizeToolName(entry) === wanted)
}

// A-PR1 BLOCKING-2 (uniform fail-closed): the @ai-sdk/harness adapters
// (claude-code / pi) auto-approve the adapter's built-in READ tools under their
// most restrictive selectable mode (`allow-reads`). There is NO host hook that
// fires before that auto-approve, so the harness CANNOT deny reads. An agent
// definition whose allow-list does NOT permit reads (the literal deny-all `[]`,
// or any list that excludes Read) is therefore UNENFORCEABLE on the harness:
// launching would auto-approve reads while the definition claims they're denied.
// Rather than overclaim enforcement, the harness paths FAIL CLOSED — refuse to
// launch and surface this error — the same honest contract as the Codex
// deny-all fail-closed. Reuses isToolAllowedByAgent so the "is Read allowed?"
// question stays consistent with per-tool enforcement.
export function harnessReadsUnenforceable(allowList) {
  return allowList != null && !isToolAllowedByAgent('read', allowList)
}

export const HARNESS_READS_UNENFORCEABLE_ERROR =
  'This agent restricts file reads (its tool allow-list excludes Read), but the harness backend auto-approves built-in reads and cannot enforce that. Refusing to launch rather than running read-capable while claiming reads are denied — grant Read in the agent definition, or run this agent on a provider that can deny reads.'

// Tools that can mutate the filesystem or run arbitrary shell commands. Bash is
// write-capable (rm/write). Used to decide whether Codex must run read-only —
// Codex's CLI has no per-tool allow-list, so the sandbox is its only real lever.
const WRITE_CAPABLE_TOOLS = new Set(
  ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'apply_patch'].map(normalizeToolName),
)

export function allowListGrantsWrite(allowList) {
  if (allowList == null) return true
  if (allowList.length === 0) return false
  return allowList.some(t => WRITE_CAPABLE_TOOLS.has(normalizeToolName(t)))
}

// True when the allow-list is present and grants no write-capable tool, so Codex
// must be forced to a read-only sandbox regardless of the requested mode.
export function codexShouldForceReadOnly(allowList) {
  return allowList != null && !allowListGrantsWrite(allowList)
}

// HONEST LIMITATION (A-PR1 #1b): Codex's CLI cannot express a TRUE deny-all. Its
// most restrictive sandbox (`read-only`) STILL PERMITS READS, and Codex has no
// per-tool flag — so an explicit deny-all ([]) is NOT enforceable. Rather than
// silently downgrade deny-all to a read-capable sandbox (overclaiming
// "deny-all"), the Codex paths FAIL CLOSED: refuse to launch and surface this
// error. Mirror of src/main/chat/agent-mode-tools.ts (drift-guarded by the
// daemon test suite).
export function codexDenyAllUnsupported(allowList) {
  return allowList != null && allowList.length === 0
}

export const CODEX_DENY_ALL_ERROR =
  'Codex cannot enforce a deny-all tool list (its most restrictive sandbox still permits file reads, and it has no per-tool gate). Refusing to launch this agent on Codex — pick a provider that can deny all tools, or grant at least Read.'

// Per-mode Codex sandbox + approval policy as `codex exec` argv fragments.
// VERIFIED against codex-cli 0.139.0: `codex exec` exposes the sandbox via
// `-s/--sandbox <read-only|workspace-write|danger-full-access>` and the approval
// policy via `-c approval_policy=<value>`. The interactive `-a/--ask-for-approval`
// flag is NOT accepted by the `exec` subcommand, so `-c` is the only way to set
// the policy non-interactively.
//
// UI mode → exec behavior:
//   default     → workspace-write + on-request
//   auto        → workspace-write + on-failure
//   read-only   → read-only       + on-request
//   full-access → danger-full-access + never
//
// A write-free (non-empty) allow-list forces read-only regardless of mode (reads
// stay allowed — honest, NOT claimed as deny-all). THROWS CODEX_DENY_ALL_ERROR
// for an explicit deny-all ([]) so callers fail closed.
const CODEX_MODE_POLICY = {
  'default': { sandbox: 'workspace-write', approval: 'on-request' },
  'auto': { sandbox: 'workspace-write', approval: 'on-failure' },
  'read-only': { sandbox: 'read-only', approval: 'on-request' },
  'full-access': { sandbox: 'danger-full-access', approval: 'never' },
}

export function codexSandboxApprovalFlags(mode, allowList) {
  if (codexDenyAllUnsupported(allowList)) {
    throw new Error(CODEX_DENY_ALL_ERROR)
  }
  const policy = CODEX_MODE_POLICY[mode] ?? CODEX_MODE_POLICY.default
  const sandbox = codexShouldForceReadOnly(allowList) ? 'read-only' : policy.sandbox
  return ['-s', sandbox, '-c', `approval_policy=${policy.approval}`]
}

// Hermes exposes coarse toolset categories (terminal/file/web/browser), not a
// per-tool allow-list. Map tool names to the categories they belong to — the
// finest restriction Hermes can enforce. (Residual: allowing some-but-not-all
// tools in a category enables the whole category.)
const HERMES_CATEGORY = {}
for (const t of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit', 'Glob', 'Grep', 'LS']) {
  HERMES_CATEGORY[normalizeToolName(t)] = 'file'
}
for (const t of ['Bash', 'BashOutput', 'KillBash']) HERMES_CATEGORY[normalizeToolName(t)] = 'terminal'
for (const t of ['WebSearch', 'WebFetch']) HERMES_CATEGORY[normalizeToolName(t)] = 'web'

const HERMES_CATEGORY_ORDER = ['terminal', 'file', 'web', 'browser']

// Derive a Hermes `--toolsets` value from the allow-list.
//   null  → null (caller falls back to mode/toolsets default)
//   []    → '' (deny-all → query-only)
//   names → canonical comma-joined categories the listed tools belong to
export function hermesToolsetsFromAllowList(allowList) {
  if (allowList == null) return null
  const cats = new Set()
  for (const t of allowList) {
    const norm = normalizeToolName(t)
    const cat = HERMES_CATEGORY[norm] ?? (norm.startsWith('browser') ? 'browser' : null)
    if (cat) cats.add(cat)
  }
  return HERMES_CATEGORY_ORDER.filter(c => cats.has(c)).join(',')
}
