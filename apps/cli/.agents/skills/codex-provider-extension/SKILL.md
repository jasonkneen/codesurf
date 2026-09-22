---
name: codex-provider-extension
description: Build recipe for adding an OpenAI Codex model provider to codesurf as a kernel owning-adapter extension — driven by `codex app-server` via ProviderSession.sendTurn. Use when implementing, extending, or debugging the Codex provider extension in src/core/extensions/builtin, when mapping Codex app-server notifications onto ProviderStreamEvents, when wiring approval routing / sandbox / effort settings for Codex, or when registering a new owning-adapter model provider in this repo. Triggers: "codex extension", "codex provider", "add codex models", "codex owning adapter", "codex sendTurn". Read the `codex-app-server` skill first for the protocol.
---

# Codex Provider Extension (codesurf owning adapter)

Codex maps cleanly onto codesurf's **owning-adapter** path: a provider that holds
a persistent subprocess and streams its own deltas via `sendTurn`, exactly like
`builtin.provider-claude-agent`. The `ProviderStreamEvent` union in
`src/core/extensions/api.ts` already names "Codex CLI" in its docstrings — the
contract was designed for this.

**Prereq:** read the `codex-app-server` skill for protocol framing, lifecycle,
methods, and approvals. This skill is the codesurf-side wiring only.

## The template

Copy the structure of `src/core/extensions/builtin/claude-agent-provider.ts`.
It is the canonical owning-adapter. The pieces you reproduce:

1. **A `ProviderSession` class** (e.g. `CodexSession`) holding the persistent
   `codex app-server` child process + an NDJSON read loop + a request-id→resolver map.
2. **`api.registerModelProvider({...})`** in `activate()`.
3. **`api.registerSetting(...)`** for Codex-specific knobs (sandbox, approval policy, effort).
4. Register the extension in `src/core/extensions/builtin/index.ts` (import + add to the array near the other providers, after `claudeAgentProviderExtension`).

## Registration shape

```ts
const PROVIDER_ID = "openai"
const ADAPTER_ID = "openai.codex-app-server"

api.registerModelProvider({
  id: ADAPTER_ID,
  label: "Codex (app-server)",
  description: "Persistent codex app-server subprocess. Auth delegated to the codex CLI login.",
  providerId: PROVIDER_ID,
  shape: "provider-family",
  transport: "stdio",
  connectionMode: "persistent",
  sessionStrategy: "singleton",            // one subprocess per conversation
  capabilities: { streaming: true, tools: true, images: true, reasoning: true },
  listModels: async () => /* call model/list, map Model[] -> RegisteredModel[] */,
  auth: { mode: "agent-sdk", check: checkCodexLogin },   // CLI-delegated, no API key
  adapter: { connect: async (ctx) => new CodexSession(ctx) },
})
```

- Implement **`sendTurn(input, controller)`**, NOT `getModel` — that selects the owning path.
- `sessionStrategy: "singleton"` + `connectionMode: "persistent"`: spawn the subprocess + `initialize` once (slow start), reuse across turns, `disconnect()` kills it.
- Prefer `listModels` (live `model/list`) over a static catalog; fall back to a small inline `models: [...]` if the list call fails.

## Connection lifecycle inside CodexSession

- **Lazy start (first `sendTurn`):** `spawn("codex", ["app-server"])` → write `initialize` → on response, write `thread/start` `{model: ctx.modelId, cwd, approvalPolicy, sandbox}` → store `threadId`.
- **One persistent read loop** over stdout split on `\n`; `JSON.parse` each line; dispatch by `id` (resolve a pending request) or `method` (notification / server-request). Never use a request/reply-only loop — approvals arrive mid-turn on the same stream (see codex-app-server gotchas).
- **Per turn:** write `turn/start` `{threadId, input:[{type:"text", text: input.prompt, text_elements:[]}], model: input.modelId, effort}`; translate notifications to events on `controller.emit`; resolve `sendTurn` on `turn/completed` (or `error`).
- **`abortTurn()`** → write `turn/interrupt {threadId, turnId}`. **`disconnect()`** → kill child + reject pending.
- History: codesurf passes `input.messages` (ai-sdk ModelMessage[]). Codex threads are stateful, so for a fresh thread, seed prior turns via `baseInstructions`/`developerInstructions` on `thread/start` or replay as `turn/start` inputs — mirror `provider-history-preface.ts` (`formatHistoryAsPreface`) used by the Claude adapter.

## Event mapping (Codex notification → ProviderStreamEvent)

| Codex `method` | emit |
| --- | --- |
| `turn/started` | `{type:"status", status:"streaming"}` |
| `item/agentMessage/delta` | `{type:"text-delta", delta}` |
| `item/reasoning/textDelta` (+ summaryTextDelta) | `{type:"reasoning-delta", delta}` |
| `item/started` (command/fileChange/mcpToolCall item) | `{type:"tool-call", id:itemId, toolName, args}` |
| `item/completed` (tool item) | `{type:"tool-result", id:itemId, result, isError?}` |
| `item/completed` (final message item) | nothing extra — text already streamed |
| `thread/tokenUsage/updated` | `{type:"usage", usage:{inputTokens, outputTokens, ...}}` |
| `error` | `{type:"error", message}` |
| `turn/completed` | `{type:"done", stopReason}` + resolve `sendTurn` with `{usage}` |

`ThreadItem` (in `item/started`/`item/completed`) is a tagged union — switch on its kind to pull `toolName`/`args`/`result`. Get exact field names from generated `v2/ThreadItem.ts`.

## Approval routing (the owning-adapter handshake)

Codex `ServerRequest` ⇄ codesurf approval UI:

1. On `item/commandExecution/requestApproval` (or fileChange/permissions), emit
   `{type:"tool-approval-request", approvalId, toolName, input}`. Use the server
   request's `id` (and v2 `approvalId` when present) as the codesurf `approvalId`;
   keep a map `approvalId → server request id`.
2. The host renders its permission UI and later calls
   `session.respondToToolApproval(approvalId, approved)`.
3. In `respondToToolApproval`, write the JSON-RPC **response** to that server
   request id: `{id, result:{decision: approved ? "accept" : "decline"}}`
   (v2 `CommandExecutionApprovalDecision`; use `ReviewDecision` `"approved"`/`"denied"`
   for the legacy `execCommandApproval`/`applyPatchApproval` methods).
4. **Bypass option:** set `approvalPolicy:"never"` + `sandbox:"workspace-write"`
   (or `danger-full-access`) on `thread/start` so Codex never asks — appropriate
   when codesurf's own tool gating is authoritative. Make it a setting.

## Settings to register (scoped under ADAPTER_ID)

- `openai.codex-app-server.sandbox` — select: `read-only` | `workspace-write` | `danger-full-access`.
- `openai.codex-app-server.approvalPolicy` — `AskForApproval`: `untrusted` | `on-failure` | `on-request` | `never` (plus an advanced `{granular:{...}}` object variant; skip it for the select).
- `openai.codex-app-server.effort` — select reasoning effort. Full `ReasoningEffort` enum: `none` | `minimal` | `low` | `medium` | `high` | `xhigh`. Read at `turn/start`.

Mirror the Claude adapter's `registerSetting` calls (keys immutable once shipped; scope under the adapter id so providers never collide).

## Auth check

```ts
async function checkCodexLogin(): Promise<CredentialStatus> {
  // logged in if `codex login status` exits 0, or ~/.codex/auth.json exists.
  // else: { ok:false, reason:"Run `codex login`", needsUserAction:"install-cli" | "reauth" }
}
```
Advertise `auth.mode = "agent-sdk"` so the host does not prompt for an API key.

## Validate

`bun run typecheck` → `bun run build` → `node dist/index.js`, select a Codex model,
run a turn (watch `~/.codex` logs). Add a unit test next to the extension that
feeds canned NDJSON lines through the notification→event mapper (no real subprocess),
like the existing provider tests. Three preexisting suite failures are unrelated —
flag, don't fix.

## Scope discipline

Spike with `codex exec --json` first if app-server wiring is heavy — it proves the
model + auth path with zero protocol surface, then graduate to app-server for
streaming + approvals.
