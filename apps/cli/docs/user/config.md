# CodeSurf Configuration

User settings live in the resolved config dir (`~/.codesurf`), as
`user-settings.json` (legacy `~/.grok/user-settings.json` is one-time copied
forward). Edits are picked up automatically.

## Tool-chip aliases (editable, not code)

Tool/agent call chips show compact labels and expand on click. You control the
mapping in settings — no code change:

```json
{
  "chipAliases":   { "COMMAND": "RUN", "EDIT_FILE": "FILE", "MODIFY_TRACK": "CHANGE" },
  "chipOrgHeads":  ["BUDDY"]
}
```

- `chipAliases` — exact upper tool name → short chip label. Defaults are merged
  under yours (e.g. `COMMAND → RUN`).
- `chipOrgHeads` — namespace heads that collapse to the org alone
  (`BUDDY.BLOUBTEAMCONTROL → BUDDY`).

## Model & auth

```json
{
  "apiKey": "xai-…",
  "defaultModel": "grok-…",
  "defaultModelAdapterId": "…"
}
```

## Other common keys

| Key | Meaning |
|---|---|
| `sandboxMode` | `"off"` / `"shuru"` |
| `sandbox` | sandbox settings object |
| `telegram` | Telegram remote-control settings |
| `mcp` | MCP server config |
| `theme` | UI theme id |
| `subAgents` | custom subagent definitions |
| `hooks` | hook configuration |
| `payments` | payment chain/approval settings |

## Env vars that matter

- `CODESURF_API_KEY` — API key for the active provider (Claude, Codex/xAI, etc.).
- `CODESURF_TOOL_PRESENTATION=code|both` — PTC presentation (see [ptc.md](./ptc.md)).
- `CODESURF_CONFIG_DIR` — explicit config-dir override.
