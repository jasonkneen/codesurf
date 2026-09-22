# oc-extensions

OpenCode plugins by the grok-cli crew.

## pet

Animates your Codex/OpenPets desktop pet in response to OpenCode activity.

### Features

- **Auto-reactions** — Maps OpenCode events to pet emotions:
  - Model thinking → `thinking`
  - File edits → `editing`
  - Shell commands → `running`
  - Tool success → `success`
  - Tool failure → `error`
  - Session idle → `idle`
  - Task complete → `celebrating`

- **Pet management tools**:
  - `pet_list` — List all pets from `~/.codex/pets/` and OpenPets
  - `pet_select` — Select the active pet (persisted across sessions)
  - `pet_download` — Download a pet from OpenPets
  - `pet_status` — Show current pet state, lease, connection
  - `pet_react` — Manually trigger a reaction
  - `pet_say` — Make the pet say something

- **OpenPets integration** — Connects to the OpenPets desktop app via IPC, acquires a lease, and sends heartbeats every 30s. Falls back to local-only mode when OpenPets isn't running.

- **Local codex pets** — Scans `~/.codex/pets/` for installed spritesheet pets (bitty, r2d2, xenomorph, etc.)

### Install

```bash
cd oc-extensions
bun install
```

### Load in OpenCode

Add to your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../oc-extensions/src/pet.ts"]
}
```

Or copy to `.opencode/plugins/pet.ts` for auto-discovery.

### Usage

Ask the agent:
- "List available pets"
- "Select the bitty pet"
- "Download a pet from openpets"
- "What's my pet status?"
- "Make the pet wave"
- "Have the pet say hello"

Or use the `/pet` command in the TUI.

### Requirements

- **OpenPets desktop app** (optional) — for live animation. Without it, the plugin tracks pet state locally but can't drive the desktop pet.
- **Codex pets** in `~/.codex/pets/` — scanned automatically for listing and selection.

### How it works

```
OpenCode event          → Pet reaction
─────────────────────────────────────
session.execution.started → thinking
session.tool.called       → working
tool: edit/write/patch    → editing
tool: shell/bash          → running
session.tool.success      → success
session.tool.failed       → error
session.execution.succeeded → celebrating
session.idle (8s quiet)   → idle
```

The plugin acquires a lease from OpenPets on startup, sends reactions via IPC, and heartbeats every 30s. On cleanup, the lease is released.
