# CodeSurf CLI — Commands & Run Modes

## Interactive TUI (default)

```bash
codesurf                      # boot the OpenTUI agent (serverless by default)
codesurf -d /path/to/repo     # pick a working directory
codesurf --connect ws://127.0.0.1:3948   # attach as a wire front to a codesurf node
```

The status line always shows which mode you're in: `· serverless` (local, in-process
Agent) or `· wire ws://…` (attached to a node). Boot also prints the mode.

### `--connect` — the wire front

When attached, the TUI is a thin front: turns are **handed off to the node**, responses
**stream live** back, and you can keep sending messages. Client-death resilience means
killing the TUI does **not** stop the node's turn. If the node is unreachable, the TUI
falls back to the local, in-process Agent so you're never stuck.

## Headless

```bash
codesurf --prompt "run the tests"                          # one prompt, then exit
codesurf -p "…" --format json                              # machine-readable output
codesurf -p "…" --max-tool-rounds 30                       # bound the tool loop
codesurf -p "…" --batch-api                                # cheap async runs
codesurf --verify                                          # repo health check
```

### Headless over the wire

```bash
codesurf --connect ws://127.0.0.1:3949 --prompt "…"
```

Routes the prompt to a session on the node and **streams the reply back** — no local
API key needed (the node owns the Agent):

```text
[codesurf: wire session sess-1 on ws://127.0.0.1:3949]
<streamed reply>
```

## Server selector (in the TUI footer)

The footer is **serverless** (green) by default; tap it and a **Servers** picker lists
detected `codesurf node` workers (localhost probe via the session channel). Click one
to **attach live** — the TUI becomes a wire front, turns route to that node, and the
chip flips to `· wire ws://…` (accent). Pick Serverless to detach and go back to local.

## Server node

```bash
codesurf node --port 3948
```

Boots an `EngineNode`: a hub + session host (sessions that outlive fronts) +
distributed-compute jobs + fleet telemetry + distributed tracing + an auto-reaper
(evicts abandoned sessions/jobs/traces, disposing evicted Agents). Fronts attach
over `ws://127.0.0.1:<port>`.

## Gateway server

```bash
codesurf serve --port 3947 --presentation code|both|native
```

Exposes the engine as OpenAI/ACP/MCP surfaces. For PTC testing, create sessions with
`presentation: "code"` over ACP/MCP — note the OpenAI-compatible
`/v1/chat/completions` endpoint always creates `native` sessions.

## Other

- `codesurf mcp` — MCP server surface.
- `codesurf models` — list provider models.
- `codesurf update` / `uninstall` — self-management (script installs only).
- `--sandbox / --no-sandbox` — sandbox mode for agent shell commands.
- `--connect <url>` — see the wire front, above.