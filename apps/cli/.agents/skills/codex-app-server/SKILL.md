---
name: codex-app-server
description: Reference for driving the OpenAI Codex CLI as a programmatic agent backend via `codex app-server` (newline-delimited JSON-RPC over stdio) or `codex exec --json`. Use when building or debugging any integration that runs Codex models from another process — provider extensions, MCP bridges, headless turn runners — or when you need the app-server protocol lifecycle, request/notification method names, approval routing, or how to regenerate the TypeScript bindings. Triggers: "codex app-server", "codex exec", "codex provider", "drive codex from code", "codex protocol", "codex models".
---

# Codex App-Server Protocol

`codex app-server` runs the same long-lived agent backend the Codex VSCode/desktop
clients use. It speaks **newline-delimited JSON** (one JSON object per line) over
stdio by default. This skill is the authoritative, empirically-verified protocol
reference (Codex CLI 0.134.0).

## Two integration surfaces

| Surface | Command | Shape | Use when |
| --- | --- | --- | --- |
| **App-server** | `codex app-server` | Persistent NDJSON-RPC over stdio (or `--listen unix://`/`ws://`) | Rich streaming, multi-turn, approvals, model list — the real client protocol. **Default choice for a provider.** |
| **Exec** | `codex exec --json -m <model> -C <cwd> "<prompt>"` | One-shot; emits JSONL events to stdout, exits | Headless single turn, scripting, no approval round-trips needed. |
| **MCP** | `codex mcp-server` | Codex as an MCP stdio server | Wire through codesurf's existing MCP support instead of a provider. |

## Framing (VERIFIED)

- One compact JSON object **per line**, `\n`-delimited. **No** `Content-Length`
  headers (not LSP framing). **No** `"jsonrpc":"2.0"` field — messages are
  `{id, result}` / `{id, error}` / `{method, params}`.
- Write a request, flush, read lines. Requests carry `id` (number or string);
  responses echo it. Notifications have `method`+`params`, no `id`.

Verified handshake:
```
→ {"method":"initialize","id":1,"params":{"clientInfo":{"name":"codesurf","title":"Codesurf","version":"0.1.0"},"capabilities":null}}
← {"id":1,"result":{"userAgent":"codesurf/0.134.0 ...","codexHome":"/Users/you/.codex","platformFamily":"unix","platformOs":"macos"}}
← {"method":"remoteControl/status/changed","params":{...}}   // server then streams notifications
```

## Turn lifecycle (v2 — the live protocol)

1. **`initialize`** → `InitializeResponse {userAgent, codexHome, platformFamily, platformOs}`. Send once per connection.
2. **`thread/start`** `ThreadStartParams {model?, cwd?, approvalPolicy?, sandbox?, baseInstructions?, developerInstructions?, config?}` → `ThreadStartResponse {thread:{id}, model, cwd, approvalPolicy, sandbox, reasoningEffort}`. Keep `thread.id`.
3. **`turn/start`** `TurnStartParams {threadId, input: UserInput[], model?, effort?, cwd?, approvalPolicy?, sandboxPolicy?, outputSchema?}` → streams notifications, then resolves `TurnStartResponse {turn}`.
4. Server streams **`ServerNotification`s** (deltas + item lifecycle, below).
5. Server may send **`ServerRequest`s** (approvals) — you MUST reply with the matching response or the turn blocks.
6. **`turn/completed`** notification (`{threadId, turn}`) ends the turn. `turn/interrupt` / `turn/steer` to cancel or redirect.

`UserInput` variants: `{type:"text", text, text_elements:[]}` | `{type:"image", url}` | `{type:"localImage", path}` | `{type:"skill", name, path}` | `{type:"mention", name, path}`.

## Notifications you care about (streaming a turn)

| `method` | params (key fields) | Meaning |
| --- | --- | --- |
| `turn/started` | `{threadId, turn}` | turn began |
| `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` | assistant **text** chunk |
| `item/reasoning/textDelta` | `{threadId, turnId, itemId, delta, contentIndex}` | **reasoning** chunk |
| `item/reasoning/summaryTextDelta` | `{..., delta}` | reasoning summary chunk |
| `item/started` | `{item: ThreadItem, threadId, turnId, startedAtMs}` | an item began (message / command / fileChange / mcpToolCall) |
| `item/completed` | `{item: ThreadItem, threadId, turnId, completedAtMs}` | item finished (final text / tool result) |
| `item/commandExecution/outputDelta` | `{..., chunk}` | shell stdout/stderr stream |
| `item/fileChange/patchUpdated` | `{...}` | proposed patch updated |
| `thread/tokenUsage/updated` | `{...usage}` | token usage |
| `turn/completed` | `{threadId, turn}` | **turn done** |
| `error` | `{...}` | turn-level error |

Full method list: `grep '"method"' ServerNotification.ts` in generated bindings (~70 methods incl. realtime/audio, mcp, account — most irrelevant to a text turn).

## Server requests = approvals (you must answer)

The server BLOCKS until you respond. `ServerRequest` methods:

| `method` | params | response |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `CommandExecutionRequestApprovalParams {threadId, turnId, itemId, approvalId?, command?, cwd?, reason?}` | `{decision: CommandExecutionApprovalDecision}` |
| `item/fileChange/requestApproval` | `FileChangeRequestApprovalParams {threadId, turnId, itemId, reason?, grantRoot?}` | `{decision}` |
| `item/permissions/requestApproval` | `PermissionsRequestApprovalParams` | `{decision}` |
| `execCommandApproval` / `applyPatchApproval` | legacy v1 equivalents | `{decision: ReviewDecision}` |
| `item/tool/requestUserInput` | tool wants structured input | structured response |

- **v2 `CommandExecutionApprovalDecision`**: `"accept"` | `"acceptForSession"` | `{acceptWithExecpolicyAmendment:{...}}` | `{applyNetworkPolicyAmendment:{...}}` | `"decline"` | `"cancel"`.
- **v1 `ReviewDecision`**: `"approved"` | `"approved_for_session"` | `"denied"` | `"abort"` | `"timed_out"` | amendment variants.
- Set `approvalPolicy: "never"` + `sandbox: "danger-full-access"` (or `workspace-write`) on `thread/start` to avoid approval round-trips entirely when the host already gates tools.

## Models

`model/list` `ModelListParams {cursor?, limit?, includeHidden?}` → `ModelListResponse {data: Model[], nextCursor}`.
`Model {id, model, displayName, description, hidden, supportedReasoningEfforts, defaultReasoningEffort, inputModalities, isDefault, contextWindow?}`. Prefer dynamic `model/list` over a hardcoded catalog — Codex model availability is account/plan-dependent.

## Auth

- Codex auth lives in `$CODEX_HOME` (default `~/.codex`, see `initialize.codexHome`). `~/.codex/auth.json` present ⇒ logged in.
- Programmatic check: `codex login status` (exit 0 + status line when authed). `codex login` / `codex logout` to manage.
- App-server uses the host's existing Codex login — **no API key to pass**. Advertise `agent-sdk`-style auth (CLI-delegated), not `api-key`.

## Regenerating the bindings (authoritative truth)

```
codex app-server generate-ts --out <DIR>           # TypeScript types (ClientRequest, ServerNotification, ServerRequest, v2/*)
codex app-server generate-json-schema --out <DIR>  # JSON Schema bundle
codex app-server generate-ts --enable <feature> --out <DIR>  # include experimental methods
```
Key files: `ClientRequest.ts` (all client→server methods), `ServerNotification.ts`, `ServerRequest.ts`, `v2/*` (current params/responses), `index.ts`. Regenerate whenever the Codex CLI is updated — the protocol moves.

## Gotchas

- **NDJSON, not LSP framing.** A Content-Length reader will hang forever.
- **Read continuously.** Notifications and the response to your request are interleaved on the same stream; a request/reply-only loop will deadlock when the server emits an approval `ServerRequest` mid-turn.
- The server emits unsolicited notifications immediately after `initialize` (e.g. `remoteControl/status/changed`) — ignore unknown methods, don't treat them as errors.
- `params` can be `undefined`/absent for no-arg methods (`account/logout`, `windowsSandbox/readiness`).
- `codex exec --json` is the low-ceremony path: no approval protocol, just JSONL events to stdout and exit — good for a first spike before committing to app-server.
