# Lazar Agent SDK Extension

A codesurf/grok-cli builtin extension that exposes the local
[`lazar`](https://github.com/jkneen/lazar) Rust agent kernel as a model
provider. Adds a new provider called **Lazar** with a small set of Anthropic
models, and wires per-turn streaming through `lazar -p ... --output-format
stream-json`.

## What lazar is

Lazar is a self-evolving agent harness with:

- **One tool**: `execute(command)` — bash, sandboxed via `sandbox-exec`.
- **One protocol**: skills as filesystem entries under `~/lazar/skills/`.
- **Memory**: durable notes under `~/lazar/memory/`.
- **A workspace**: scratchpad / project root under `~/lazar/workspace/`.
- **An infinite log**: append-only `~/lazar/logs/stream.jsonl`.

The kernel is a small Rust binary (`~/lazar/bin/lazar`) that:

1. Takes a prompt via `-p`.
2. Calls Claude (SSE-streamed) with one tool, `execute(command)`.
3. Runs the bash through `sandbox-exec` and feeds the output back.
4. Loops until the model emits `stop_reason: end_turn`.

State lives on disk. New skills become available the moment their
`SKILL.md` file exists — no recompile, no registration code.

## What this extension adds

| Surface | Value |
|---|---|
| Extension id | `builtin.provider-lazar` |
| Extension name | `Lazar Agent SDK` |
| Provider id | `lazar` |
| Adapter id | `lazar.cli` |
| Default state | **disabled** (toggle on via `/extensions`) |
| Models | `claude-sonnet-4-6` (default), `claude-opus-4-7`, `claude-opus-4-6`, `claude-haiku-4-5` |
| Capabilities | streaming, tools (lazar's own), no images, no reasoning surface |
| Connection mode | `stateless` |
| Session strategy | `per-conversation` |
| Transport | `stdio` (subprocess) |

## Files changed

- **New**: `src/core/extensions/builtin/lazar-provider.ts` — the provider.
- **Edited**: `src/core/extensions/builtin/index.ts` — import + register
  `lazarProviderExtension` after `codesurfDesktopProviderExtension`.

Nothing else was touched. The lazar Rust binary and its source were not
modified — this extension is a pure consumer.

## How a turn flows

```
host                    extension                   lazar binary
 │                          │                              │
 │ sendTurn(input,ctrl) ───►│                              │
 │                          │ spawn lazar -p <prompt>      │
 │                          │   --session <id>             │
 │                          │   --output-format stream-json│
 │                          │   --model <id>               │
 │                          │ ─────────────────────────────►
 │                          │                              │ (SSE stream
 │                          │                              │  from Claude)
 │                          │ stdout JSONL events ◄────────┤
 │ ◄── text-delta ──────────┤                              │
 │ ◄── tool-call ───────────┤  (parses event.type)         │
 │ ◄── tool-result ─────────┤                              │
 │     ...                  │                              │
 │ ◄── done ────────────────┤  (process exit, code 0)      │
 │                          │                              ▼
```

### Event translation

| Lazar JSONL event       | Forwarded as                           |
|-------------------------|----------------------------------------|
| `text_delta`            | `{ type: "text-delta", delta }`        |
| `tool_use`              | `{ type: "tool-call", id, toolName, args }` |
| `tool_result`           | `{ type: "tool-result", id, result }`  |
| `error`                 | `{ type: "error", message }`           |
| `invoke_end`            | captured for terminal `stop_reason`    |
| process exit (code 0)   | `{ type: "done", stopReason }`         |
| process exit (non-zero) | `{ type: "error", ... }` + reject      |
| `text_done`, `invoke_start` | ignored (informational)            |

Lazar does NOT emit token usage in `stream-json` mode (only in
`--output-format json`), so `usage` is left empty.

## Conversation continuity

Lazar is **not** a held long-lived process. Each turn = a fresh
`lazar -p ...` subprocess. Continuity comes from `--session <id>`: lazar
prepends prior turns from `~/lazar/logs/sessions/<id>.jsonl` to the next
turn automatically.

The session id is generated once per `ProviderSession` (≈ one user
conversation) from a sanitized form of the host's conversation id plus a
short timestamp suffix, capped at 64 chars. Allowed alphabet `[a-zA-Z0-9._-]`
matches the kernel's whitelist.

### `/sessions` rehydration

If the host re-creates a provider session by reloading a transcript from
disk (`/sessions` modal), lazar's own session log won't have the prior
turns. On the **first** `sendTurn` after such a rehydrate, the extension
serializes prior `input.messages` into a single `<restored_context>` preface
and prepends it to the current prompt — same trick the
`claude-agent-provider` uses. Tool-call fidelity is lost (text only) but
the model regains awareness of what was discussed.

## Auth

`auth.check(ctx)` runs three guards:

1. Binary exists at the resolved path → otherwise `needsUserAction:
   "install-cli"`.
2. Binary is executable → otherwise `needsUserAction: "install-cli"`.
3. `ANTHROPIC_API_KEY` is set → otherwise `needsUserAction: "paste-api-key"`.

Lazar itself reads `ANTHROPIC_API_KEY` from its inherited environment.

## Settings (registered under section "Lazar Agent SDK")

| Key                                    | Type    | Default                          | Notes |
|----------------------------------------|---------|----------------------------------|-------|
| `lazar.cli.binPath`                    | string  | `~/lazar/bin/lazar`              | Falls back to `LAZAR_BIN` env if unset. |
| `lazar.cli.lazarHome`                  | string  | `~/lazar`                        | Falls back to `LAZAR_HOME` env. Exported into the child env. |
| `lazar.cli.verbose`                    | boolean | `false`                          | Adds `--verbose` to the spawn args. |
| `lazar.cli.toolTimeoutSecs`            | number  | `120`                            | Sets `LAZAR_TOOL_TIMEOUT_SECS` in the child env. |
| `lazar.cli.inheritApiKeyToTools`       | boolean | `false`                          | Sets `LAZAR_TOOL_INHERIT_ANTHROPIC_API_KEY=1`. Off by default for secret isolation; turn on if you need nested `lazar -p` recursion inside tool calls. |

## Tool ownership

Host tools are **not** forwarded to lazar. Lazar has exactly one tool
(`execute`/bash) and owns its execution end-to-end via `sandbox-exec`. The
extension just translates lazar's `tool_use` / `tool_result` JSONL into
display events. This matches the same posture as `claude-agent-provider`
and `codesurf-desktop-provider` — owning adapters drive their own tool
runtime.

## Abort

- `ProviderTurnInput.abortSignal` → `child.kill("SIGTERM")` (best-effort).
- `session.abortTurn()` → same SIGTERM.
- `session.disconnect()` → marks disconnected, then aborts any in-flight
  child. Called when the extension is disabled or the host shuts down.

## Usage

1. Build / install lazar: `bash ~/lazar/setup.sh` (or follow the lazar
   README). Confirm `~/lazar/bin/lazar --help` runs.
2. Export your key: `export ANTHROPIC_API_KEY=sk-...`.
3. Start codesurf / grok-cli.
4. Open `/extensions` and toggle **Lazar Agent SDK** on.
5. Open `/models` and pick one of the `... (Lazar)` entries (default is
   `claude-sonnet-4-6`).
6. Optionally disable peer providers (`Claude Agent SDK`, `Anthropic`, etc.)
   from the same `/extensions` modal if you want lazar to be the sole
   route.

> **Note**: disabling skills, claude-agent-sdk, etc. is a runtime user
> action via `/extensions`. The extension does not — and should not —
> automate that on your behalf.

## Trade-offs and concerns

1. **Not actually a long-lived socket.** Lazar is a per-call Rust binary;
   there is no held subprocess between turns. The "streaming long-life
   connection" feel comes from `--session <id>` (lazar prepends prior
   turns from disk itself). Encoded honestly as `connectionMode:
   "stateless"` + `sessionStrategy: "per-conversation"`. If you want a
   held streaming socket, lazar would need to support
   `--input-format stream-json` (currently reserved/unimplemented), or
   we'd need a separate long-running shim.
2. **No token usage in stream.** Lazar emits token usage only in
   `--output-format json`. We could add a second-pass `--output-format
   json` to fetch usage post-hoc, but it isn't free. Usage is empty for
   now.
3. **Tool fidelity loss on `/sessions` rehydration.** The preface trick
   captures text only — prior tool calls become opaque text blocks in the
   restored context.
4. **Path discrepancy.** Your initial wording was `~/users/jkneen/lazar`;
   actual is `/Users/jkneen/lazar/bin/lazar`. The setting defaults to that
   path; `LAZAR_BIN` env or the `lazar.cli.binPath` setting overrides it.
5. **Default off.** `enabledByDefault: false` so the extension is opt-in.
   This avoids surprising users who installed the host without lazar
   present.

## Verifying it loaded

```bash
bun -e '
import { loadBuiltinExtensions } from "./src/core/extensions/builtin/index";
const exts = await loadBuiltinExtensions();
const lazar = exts.find(e => e.manifest.id === "builtin.provider-lazar");
console.log("registered:", !!lazar, "name:", lazar?.manifest.name);
'
# → registered: true name: Lazar Agent SDK
```

## Related files in the host

- `src/core/extensions/api.ts` — host API contract (`ExtensionModule`,
  `RegisteredModelProvider`, `ProviderSession`, `ProviderStreamEvent`).
- `src/core/extensions/manifest.ts` — manifest schema + validation.
- `src/core/extensions/builtin/claude-agent-provider.ts` — closest pattern
  reference (persistent SDK, but same event-translation shape).
- `src/core/extensions/builtin/codesurf-desktop-provider.ts` — closest
  pattern reference for per-turn streaming subprocess.
