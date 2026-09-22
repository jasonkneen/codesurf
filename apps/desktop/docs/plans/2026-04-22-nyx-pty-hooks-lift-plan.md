# Nyx PTY + hooks lift plan for CodeSurf

Date: 2026-04-22
Target repo: /Users/jkneen/clawd/collaborator-clone
Source repo analyzed: /tmp/nyx-re

## Executive summary

Best recommendation: do not replace CodeSurf's existing tmux-backed generic terminal first.

Instead:
1. Add a new isolated agent-shell PTY subsystem, derived from Nyx, for terminal-native agent CLIs.
2. Port Nyx hooks as an optional reliability layer for Claude Code / Codex / Droid shells only.
3. Reimplement Nyx's renderer state detector in TypeScript from the extracted spec below.
4. Reuse CodeSurf's existing BrowserTile + Cluso + extension chat-surface stack for review/comment flows, and port only the lightweight Nyx pieces that add value: exact element screenshot capture, selector badges, and cheap inspect-mode fallback.
5. Persist daemon session ids in CodeSurf tile state only for the new agent-shell block. Leave the current terminal block alone until the new stack proves stable.

If you only do one thing next session: create a namespaced `agent-pty` stack beside the current `terminal` IPC, not inside it.

## Files analyzed

### Nyx PTY subsystem
- `electron/pty.cjs`
- `electron/pty-daemon/index.cjs`
- `electron/pty-daemon/protocol.cjs`
- `electron/pty-daemon/server.cjs`
- `electron/pty-daemon/session.cjs`
- `electron/pty-daemon/lifecycle.cjs`
- `electron/platform.cjs`
- `shared/agent-command-resolver.cjs`
- `shared/node-pty-helper.cjs`
- `electron/preload.cjs`
- `electron/shell-integration/nyx-zsh.sh`
- `electron/shell-integration/nyx-bash.sh`
- `electron/shell-integration/zsh/.zshenv`
- renderer bundles with relevant logic:
  - `dist/assets/AgentTile-DTBFBU1f.js`
  - `dist/assets/TerminalTile-hHm-KWgy.js`
  - `dist/assets/index-CfGPzkNa.js`
  - `dist/assets/workspace-store-Dw2BSQpn.js`

### Nyx hooks subsystem
- `electron/hook-config-manager.cjs`
- `electron/hook-templates/claude-code.cjs`
- `electron/hook-templates/codex.cjs`
- `electron/hook-templates/droid.cjs`
- `electron/cc-hooks-bridge.cjs`
- `electron/main.cjs`
- `electron/preload.cjs`

### Nyx inspect/browser/comment patterns
- `electron/inspect.cjs`
- `dist/assets/BrowserTile-QhideX9e.js`
- `dist/assets/DiffTile-CIxUYxXx.js`

### CodeSurf comparison set
- `src/main/index.ts`
- `src/main/ipc/terminal.ts`
- `src/main/ipc/chat.ts`
- `src/main/ipc/agents.ts`
- `src/main/ipc/extensions.ts`
- `src/main/extensions/registry.ts`
- `src/main/extensions/bridge.ts`
- `src/main/extensions/context.ts`
- `src/preload/index.ts`
- `src/shared/types.ts`
- `src/main/agent-paths.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/config/providers.ts`
- `src/renderer/src/components/icons/providerIcons.tsx`
- `src/renderer/src/components/TerminalTile.tsx`
- `src/renderer/src/components/BrowserTile.tsx`
- `src/renderer/src/components/ExtensionTile.tsx`
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/BlockNoteAffordance.tsx`
- `src/main/daemon/client.ts`

## 1. Nyx PTY subsystem: isolated design

## 1.1 Main-process boundary

Nyx's PTY system is intentionally split in two layers:

1. `electron/pty.cjs`
   - Electron-facing IPC adapter.
   - Handles renderer IPC.
   - Connects to a detached PTY daemon over a Unix socket / named pipe.
   - Falls back to direct `node-pty` if daemon startup or connection fails.

2. `electron/pty-daemon/*`
   - Standalone Node process.
   - Owns PTY sessions independently of renderer windows.
   - Keeps a headless xterm copy of session output for attach/restore.
   - Self-shuts down only when no clients and no sessions remain.

This split is the most reusable part of the Nyx lift.

## 1.2 Wire protocol

`electron/pty-daemon/protocol.cjs` defines a tiny NDJSON protocol:
- request: Electron -> daemon
- response: daemon -> Electron
- event: daemon -> Electron

Methods in use:
- `create`
- `attach`
- `write`
- `resize`
- `kill`
- `clearScrollback`
- `updateStatus`
- `list`
- `shutdown`

Events in use:
- `output`
- `exit`
- `activity`

Renderer-facing Electron IPC in `electron/pty.cjs` stays stable even when the daemon is used:
- `create_pty`
- `attach_pty`
- `write_to_pty`
- `resize_pty`
- `clear_scrollback`
- `list_daemon_sessions`
- `update_pty_status`
- `kill_pty`
- `resolve_agent_command`

Renderer event channels are per-session:
- `pty-output-${id}`
- `pty-exit-${id}`
- `pty-activity-${id}`

Important reusable property: the daemon API is session-id based, not tile-id based.

## 1.3 Session persistence model

Nyx PTY persistence is not tmux-based.

It persists by:
- keeping the daemon alive independently of the Electron window
- keeping each PTY process alive in daemon memory
- mirroring output into a headless xterm buffer
- serializing that buffer on `attach`

`electron/pty-daemon/session.cjs` uses:
- `node-pty`
- optional `@xterm/headless`
- optional `@xterm/addon-serialize`

Key behavior:
- active PTY output is written both to listeners and to headless xterm
- `serialize()` returns terminal state for restore
- exited sessions hibernate after a 60s grace period
- hibernation caches serialized output and disposes the headless xterm to save memory

That hibernate step is a strong portability feature if CodeSurf wants restart-safe agent shells without depending on tmux scrollback.

## 1.4 Lifecycle policy

`electron/pty-daemon/lifecycle.cjs` no longer kills sessions by status timeout.

Current behavior:
- sessions are tracked with statuses for metadata only
- only the daemon self-shutdown timer remains
- daemon shuts down after `daemonTimeoutMs` only when:
  - no connected Electron clients
  - no tracked sessions

Nyx comments explicitly say older status-based auto-kill caused unexpected context loss.

Recommendation for CodeSurf: keep this policy. Do not auto-kill active agent shells based on idle/done timers.

## 1.5 Environment shaping and command resolution

### `shared/agent-command-resolver.cjs`

This is worth porting almost verbatim.

It does three jobs:
1. augment PATH with common user tool locations
2. resolve special agent executables
3. resolve a sane cwd

Supported special resolution in Nyx:
- `claude-code`
- `codex`
- `gemini`
- generic PATH/known-location lookup for others

Important codex-specific behavior:
- detects a healthy Node runtime
- injects `CODEX_JS_REPL_NODE_PATH`

Important portability note:
- Hermes, Droid, and custom commands are mostly pass-through in Nyx; they rely on PATH augmentation plus user-supplied command strings.

### `electron/pty.cjs` / `pty-daemon/server.cjs`

Nyx aggressively normalizes env for interactive shells:
- sets `TERM=xterm-256color`
- sets `COLORTERM=truecolor`
- forces color:
  - `FORCE_COLOR=3`
  - `CLICOLOR=1`
  - `CLICOLOR_FORCE=1`
- sets locale vars on non-Windows:
  - `LANG`
  - `LC_ALL`
  - `LC_CTYPE`
- removes anti-interactive flags inherited from CI/batch contexts:
  - `NO_COLOR`
  - `CI`
  - `DEBIAN_FRONTEND`
  - `GCM_INTERACTIVE`
  - `GIT_TERMINAL_PROMPT`
  - `GIT_ASKPASS`
  - `SSH_ASKPASS`

For agent sessions it also injects:
- `NYX_AGENT_ID=<agentId>`

This is exactly the sort of behavior CodeSurf's current terminal layer does not have.

## 1.6 Shell integration

Nyx shell integration is smaller than the comments imply.

Files:
- `electron/shell-integration/nyx-zsh.sh`
- `electron/shell-integration/nyx-bash.sh`
- `electron/shell-integration/zsh/.zshenv`

What these scripts actually do in the extracted tree:
- emit OSC 7 cwd updates on prompt/chdir
- bootstrap zsh with a temporary `ZDOTDIR` wrapper so user dotfiles still load

Observed actual behavior in the extracted scripts:
- no explicit OSC 133/633 shell-boundary emission is present in these shell scripts
- command boundary tracking for generic terminal tiles appears to be handled renderer-side via output parsing rather than shell-side markers

For CodeSurf this means:
- port OSC 7 cwd tracking immediately
- do not assume Nyx already solved shell-side command boundaries in bash/zsh
- if you want precise generic command boundary tracking, keep CodeSurf's current parser or add explicit OSC 133/633 later

## 1.7 Fallback behavior

Nyx degrades cleanly.

If daemon connection fails:
- `electron/pty.cjs` lazy-loads `node-pty`
- sessions live in-process
- buffer + activity counters are maintained locally
- IPC API stays the same

This is a good pattern for CodeSurf because it allows shipping the daemon without making startup brittle.

## 1.8 Relevant renderer behavior in Nyx

### Agent tile

Nyx's agent tile uses daemon sessions, not a generic terminal only.

Observed responsibilities in `dist/assets/AgentTile-DTBFBU1f.js`:
- create or attach to a PTY session
- persist `_ptyId` and `ptyDaemonSessionId` on the tile
- stream output into xterm
- wire the state detector
- call `window.nyx.terminal.updateStatus(id, status)` when detector transitions
- mark prompt submissions from local input heuristics
- capture last prompt and last idle tail for resume labeling

### Cross-workspace monitoring

`dist/assets/index-CfGPzkNa.js` + `workspace-store-Dw2BSQpn.js` show a second important pattern:
- Nyx stores `workspaceSnapshots` for agents in non-current workspaces
- snapshot records include `ptySessionId`
- while another workspace is not visible, Nyx still attaches a hidden headless xterm to the daemon session and runs the same detector
- when status changes to idle/done/error, the snapshot store is updated

This is more advanced than CodeSurf currently needs, but it is a useful second-phase feature.

### Generic terminal tile

Nyx's generic terminal tile is simpler:
- attaches to a PTY id
- uses a parser to derive `command-start`, `command-finish`, `cwd-change`
- shows command-complete toasts and updates current cwd

This does not depend on the agent hooks subsystem.

## 2. Nyx hook subsystem: exact state detection behavior

## 2.1 Hook installation and config mutation

Main files:
- `electron/hook-config-manager.cjs`
- `electron/hook-templates/*.cjs`
- `electron/main.cjs`

Supported hook-managed agent shells:
- `claude-code`
- `codex`
- `droid`

Startup behavior from `electron/main.cjs`:
- always run `cleanupStale()` first
- auto-enable hooks on startup if `~/.nyx/config.json` does not set `reliableStateTracking` to false

Config targets:
- Claude Code: `~/.claude/settings.json`
- Codex: `~/.codex/hooks.json` plus `~/.codex/config.toml` feature flag patch
- Droid: `~/.factory/settings.json` plus `~/.factory/hooks/hooks.json` output-suppression patch

Mutation strategy:
- backup user config before first write
- tag Nyx-managed blocks with `_source: 'nyx'` or detect legacy markers
- merge user blocks with Nyx blocks instead of replacing full hook config
- remove stale Nyx blocks by marker / command path heuristics

The config manager is safe-ish and idempotent, but it is still dotfile mutation. In CodeSurf this must be opt-in and discoverable.

## 2.2 Hook bridge payload format

`hook-config-manager.cjs` generates `~/.nyx/hook-bridge.cjs`.

That bridge:
- reads stdin JSON from the CLI hook invocation
- extracts:
  - `tool_name`
  - `session_id`
  - `message`
- infers `notify` subtype:
  - default `idle-prompt`
  - `permission` if message mentions permission/approval
  - `auth-success` if message mentions auth success
- writes this OSC 777 payload to `/dev/tty`:

`ESC ] 777;nyx:<agent>:<json> BEL`

Extracted JSON shape:
- `kind`
- optional `tool`
- optional `subtype`
- optional `sessionId`

Accepted `kind` values in the renderer detector:
- `prompt-submit`
- `tool-start`
- `tool-end`
- `notify`
- `stop`
- `subagent-stop`
- `session-end`

## 2.3 Exact hook-driven detector transitions

Extracted from Nyx renderer bundle (`index-CfGPzkNa.js`):

### Hook event parser
- accepts only agents in `['claude-code','codex','droid']`
- parses OSC 777 payloads matching `nyx:<agent>:<json>`
- rejects malformed JSON
- ignores unsupported `kind`

### Hook detector state machine (`Bc`)

Internal behavior:
- stores current state
- stores `sessionId`
- ignores events from other session ids after the first primary session is established
- ignores `subagent-stop` completely

Special tool set that means "agent is waiting on the human":
- `AskUser`
- `AskUserQuestion`
- `ask_user`
- `ExitPlanMode`
- `exit_plan_mode`

Exact transitions:
- `prompt-submit` -> `working`
- `tool-start`:
  - if tool is one of the AskUser set -> `waiting-for-user`
  - else -> `working`
- `tool-end`:
  - if tool is one of the AskUser set -> `working`
  - else no forced transition
- `notify`:
  - subtype `idle-prompt` -> `idle`
  - subtype `permission` -> `waiting-for-user`
  - subtype `auth-success` -> no transition
- `stop` -> `idle`
- `session-end` -> `idle` and clear stored `sessionId`

Subagent filtering behavior:
- if an event carries a `sessionId` that differs from the main tracked session id, it is ignored
- this specifically prevents Claude/Droid task-tool subagents from flipping the main session to idle early

## 2.4 Exact heuristic fallback detector

When hook events are unavailable, Nyx falls back to a snapshot classifier + small state machine.

### Snapshot classifier adapters

Extracted adapter table:

- `claude-code`
  - working if full output matches spinner/thinking patterns
  - idle if last non-empty line matches `❯\s*$`
- `codex`
  - working if full output matches `Working(\d+s`
  - idle if last non-empty line matches `›\s*$`
- `hermes`
  - working if full output matches `deliberating|formulating|thinking|planning...`
  - idle if last non-empty line matches `Type your message|/help for commands|You:|>>>`
- `droid`
  - working if full output matches `⏳|Running|Thinking`
  - idle if last non-empty line matches `? for help|>\s*Type|❯\s*$`
- `gemini`
  - working if full output matches `Thinking...` or braille spinner chars
  - idle if last non-empty line matches `Type your message`
- custom fallback
  - idle if last non-empty line looks like a shell prompt `[$#%❯›>]\s*$`

### Heuristic state machine (`Lc` + `Rc`)

Events fed into the machine:
- `snapshot`
- `submit`
- `silence-tick`

Behavior:
- initial state null
  - idle snapshot -> idle
  - working snapshot -> working
  - submit -> working and start a 2s probation window
- idle state
  - working snapshot -> working
  - submit -> working and start a 2s probation window
- working state
  - working snapshot -> reset idle streak
  - idle snapshot:
    - ignore during probation window
    - ignore within 150ms of entering working
    - otherwise increment idle streak
    - transition to idle only after 2 consecutive idle snapshots
  - submit -> extend 2s probation and clear idle streak
  - silence tick -> idle if no snapshot/submit signal for >30s

Sampling strategy (`$c` in renderer):
- snapshot current xterm viewport on animation frame
- debounce forced sample after resize
- when detector is in `working`, send `silence-tick` every 500ms

This is the exact extracted behavior to reimplement in TypeScript.

## 2.5 Optional legacy Claude-only bridge

`electron/cc-hooks-bridge.cjs` is older and separate.

It:
- patches `~/.claude/settings.json`
- writes hook event JSON files into `${tmpdir}/nyx-cc-hooks`
- `electron/main.cjs` polls that temp dir every 500ms and forwards `cc-hook-event`

I would not port this first.

Reason:
- Nyx's generic hook manager already covers Claude Code through the OSC 777 bridge
- this path is redundant unless CodeSurf needs backward compatibility with a Claude hook schema that cannot emit the generic hook bridge events cleanly

Recommendation: treat `cc-hooks-bridge.cjs` as a compatibility fallback, not part of the first lift.

## 3. Focused comparison against current CodeSurf architecture

## 3.1 CodeSurf terminal stack today

Current files:
- `src/main/ipc/terminal.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/TerminalTile.tsx`

Current behavior:
- generic terminal sessions are keyed by `tileId`
- persistence is tmux-backed when tmux is available
- fallback is direct `node-pty`
- session state is stored in a main-process `Map`, plus tmux session names derived from tile id
- renderer reconnects through the same `tileId`
- no separate daemon process
- no renderer-visible PTY status channel beyond raw output and active notifications
- no per-session state detector
- no hook manager

Important difference from Nyx:
- CodeSurf terminal persistence is tile-identity + tmux based
- Nyx agent persistence is daemon-session-id + serialized xterm based

That means Nyx is not a drop-in replacement for the existing terminal block.

## 3.2 CodeSurf agent shells today

Current files:
- `src/main/ipc/agents.ts`
- `src/main/agent-paths.ts`
- `src/renderer/src/config/providers.ts`
- `src/renderer/src/components/icons/providerIcons.tsx`
- `src/main/ipc/chat.ts`

Current situation:
- CodeSurf knows provider brands and model labels for:
  - Claude
  - Codex
  - OpenCode
  - OpenClaw
  - Hermes
- it also detects additional binaries in `agents:detect`:
  - cursor
  - aider
  - goose
  - continue
  - cline
  - gemini
  - shell
- chat execution is mostly SDK/CLI driven from `chat.ts`, not attached to the terminal tile PTY lifecycle
- terminal launches can directly spawn some agent CLIs, but this is still just a terminal, not a stateful agent-shell surface

Gap versus Nyx:
- CodeSurf has agent/provider metadata and icons already
- CodeSurf does not have a terminal-native agent shell block with state tracking and hook reliability

## 3.3 CodeSurf browser/review stack today

Current files:
- `src/renderer/src/components/BrowserTile.tsx`
- `src/main/index.ts` comment: BrowserView IPC removed; renderer uses `<webview>` directly
- `src/renderer/src/components/ExtensionTile.tsx`
- `src/main/extensions/bridge.ts`
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/BlockNoteAffordance.tsx`

Current behavior already present in CodeSurf:
- BrowserTile uses managed `<webview>` instances with reattach/parking behavior
- injects a `window.contex` bus bridge into the page via console transport
- injects Cluso embed assets into the page
- Cluso can mark, copy, send, clear, and export forensic payloads back to the app
- BrowserTile relays bus events to connected peers
- extension chat surfaces already exist and can push payloads with `surface.setPayload`
- chat blocks already support attached side-notes through `BlockNoteAffordance`

Gap versus Nyx:
- CodeSurf already has a richer review/comment/send workflow than Nyx's inspect path
- Nyx contributes a simpler element-picker + exact element screenshot capture + numbered selector badges
- CodeSurf does not need to import Nyx browser UX wholesale

## 3.4 CodeSurf extension/block architecture today

Current files:
- `src/shared/types.ts`
- `src/main/extensions/registry.ts`
- `src/main/ipc/extensions.ts`
- `src/main/extensions/bridge.ts`
- `src/renderer/src/components/ExtensionTile.tsx`
- `src/renderer/src/App.tsx`

Current architecture:
- built-in block types and `ext:*` extension blocks share the same canvas
- extensions can contribute:
  - tiles
  - chat surfaces
  - MCP tools
  - context menu items
  - settings
  - actions
- extension iframes get a rich bridge:
  - tile state
  - event bus
  - canvas create/list tile
  - chat streaming hooks
  - peer actions
  - context APIs
  - surface payload APIs

This is the biggest architectural difference from Nyx.

Nyx assumes built-in tiles.
CodeSurf can absorb Nyx features either as:
- a new built-in block
- a bundled extension
- an extension chat surface
- an event-bus/peer-context pattern

## 4. What to port verbatim vs adapt

## 4.1 Port nearly verbatim

These modules are already isolated and should be copied with minimal behavioral change, then renamed:

1. `shared/node-pty-helper.cjs`
   - package-path probing
   - chmod best-effort repair

2. `shared/agent-command-resolver.cjs`
   - PATH augmentation
   - cwd resolution
   - Claude/Codex/Gemini special resolution
   - Codex Node runtime probing

3. `electron/pty-daemon/protocol.cjs`
   - NDJSON protocol exactly as-is

4. `electron/pty-daemon/session.cjs`
   - PTY + headless xterm + serialize/hibernate

5. `electron/pty-daemon/lifecycle.cjs`
   - self-shutdown-only orphan policy

6. shell integration bootstrap scripts
   - OSC 7 cwd tracking bits

## 4.2 Reimplement from extracted spec, not verbatim bundle copy

These are only visible in dist bundles and should be rewritten in TS:

1. hook detector parser + state machines
   - `Lc`
   - `Rc`
   - `Bc`
   - classifier table
   - workspace snapshot monitor logic

2. agent tile runtime behavior
   - xterm wiring
   - prompt submission marking
   - status -> daemon updates
   - session restore behavior

3. browser inspect overlay logic
   - if you decide to use it at all

## 4.3 Adapt heavily for CodeSurf

1. `electron/pty.cjs`
   - rename channels to CodeSurf conventions
   - integrate with preload `window.electron.*`
   - do not collide with current `terminal:*` handlers

2. `hook-config-manager.cjs`
   - path roots should be CodeSurf-owned, not `~/.nyx`
   - expose opt-in settings + diagnostics UI
   - likely write `~/.codesurf/` or `~/.codesurf/agent-hooks/` scripts

3. `main.cjs` lifecycle policy
   - CodeSurf is multi-window and already has other daemons/services
   - startup/shutdown semantics must be integrated rather than copied

4. workspace snapshot persistence
   - Nyx uses a custom workspace store in the renderer bundle
   - CodeSurf should persist shell session ids in `TileState` and/or canvas tile state, not in a separate Nyx-only store shape

## 5. Recommended CodeSurf module boundaries

## 5.1 Main-process modules to add

Suggested new tree:

`src/main/agent-pty/`
- `client.ts`            <- adapted from `electron/pty.cjs`
- `protocol.ts`          <- verbatim/near-verbatim
- `session.ts`           <- verbatim/near-verbatim
- `server.ts`            <- adapted from daemon server
- `lifecycle.ts`         <- near-verbatim
- `index.ts`             <- daemon entrypoint
- `platform.ts`          <- socket/named-pipe paths
- `command-resolver.ts`  <- ported from shared resolver
- `node-pty-helper.ts`   <- ported helper
- `shell-integration/`   <- OSC 7 scripts

`src/main/agent-hooks/`
- `config-manager.ts`
- `templates/claude-code.ts`
- `templates/codex.ts`
- `templates/droid.ts`
- `hook-bridge.ts`       <- generated bridge content or writer helper
- `compat/cc-hooks.ts`   <- optional later fallback only

## 5.2 Shared contracts to add

Suggested shared files:
- `src/shared/agent-shells.ts`
- `src/shared/agent-pty-types.ts`
- `src/shared/agent-hook-types.ts`

Suggested shell registry shape:
- `id`
- `label`
- `icon`
- `defaultModelLabel?`
- `resolveCommandType?`
- `supportsHooks`
- `hookAgentId?`
- `supportsHeuristicDetection`
- `customClassifier?`
- `sendTaskOnReady?`

Suggested initial shell ids:
- `claude-code`
- `codex`
- `droid`
- `hermes`
- `gemini`
- `custom`

## 5.3 Preload surface to add

Do not overload current `window.electron.terminal` in burst 1.

Add a sibling namespace first:
- `window.electron.agentPty.create(...)`
- `window.electron.agentPty.attach(...)`
- `window.electron.agentPty.write(...)`
- `window.electron.agentPty.resize(...)`
- `window.electron.agentPty.clearScrollback(...)`
- `window.electron.agentPty.updateStatus(...)`
- `window.electron.agentPty.kill(...)`
- `window.electron.agentPty.listSessions()`
- `window.electron.agentPty.resolveCommand(type, command)`
- `window.electron.agentPty.onData(id, cb)`
- `window.electron.agentPty.onExit(id, cb)`
- `window.electron.agentPty.onActivity(id, cb)`

And a hook namespace:
- `window.electron.agentHooks.enable(agent)`
- `window.electron.agentHooks.disable(agent)`
- `window.electron.agentHooks.status()`
- `window.electron.agentHooks.cleanupStale()`

This keeps the current terminal block untouched.

## 5.4 Renderer modules to add

Suggested renderer tree:

`src/renderer/src/agent-shell/`
- `detector.ts`           <- TS reimplementation of Nyx state detector
- `classifiers.ts`
- `sampler.ts`
- `types.ts`
- `useAgentShellSession.ts`
- `useBackgroundShellMonitors.ts`
- `AgentShellTile.tsx`
- `agentShellStore.ts`

This should be separate from the generic `TerminalTile.tsx`.

## 6. Rename suggestions

Nyx names are very Nyx-specific. Suggested CodeSurf names:

- `NYX_AGENT_ID` -> `CODESURF_AGENT_SESSION_ID`
- `NYX_DAEMON_SOCKET` -> `CODESURF_AGENT_PTY_SOCKET`
- `NYX_DAEMON_PID` -> `CODESURF_AGENT_PTY_PID`
- `~/.nyx/hook-bridge.cjs` -> `~/.codesurf/agent-hooks/hook-bridge.cjs`
- `pty-daemon` -> `agent-pty-daemon`
- `reliableStateTracking` -> `agentHookStateTracking`
- `create_pty` -> `agentPty:create`
- `attach_pty` -> `agentPty:attach`
- `write_to_pty` -> `agentPty:write`
- `update_pty_status` -> `agentPty:updateStatus`

## 7. Variant shell port points

## 7.1 Recommended shell registry mapping

| Shell | Command resolution | Hook mode | Fallback mode | Icon/model source |
|---|---|---|---|---|
| Claude Code | Nyx resolver `claude-code` branch | yes | heuristics | reuse CodeSurf `ClaudeIcon` + Claude model labels |
| Codex | Nyx resolver `codex` branch + `CODEX_JS_REPL_NODE_PATH` | yes | heuristics | reuse `CodexIcon` + Codex model labels |
| Droid | pass-through command + PATH augmentation | yes | heuristics | add Droid icon/label |
| Hermes | pass-through command + PATH augmentation | no in Nyx | heuristics | reuse `HermesIcon` + Hermes model labels |
| Gemini | Nyx resolver `gemini` branch | no in Nyx | heuristics | add Gemini icon/label |
| Custom | pass-through | no | custom prompt classifier | generic icon + user label |

## 7.2 Important nuance

Nyx hooks are not universal.

Nyx only ships hook templates for:
- Claude Code
- Codex
- Droid

Hermes, Gemini, and custom shells rely on the heuristic detector only.

So for CodeSurf:
- keep hook support per-shell, not global
- store `supportsHooks` and `supportsHeuristicDetection` separately
- allow user-provided custom idle regex for `custom`

## 7.3 UI metadata reuse

CodeSurf already has the right provider/icon/model assets for:
- Claude
- Codex
- Hermes

Use them for shell-launch UI too.

Add only the missing shell-brand entries:
- `GeminiIcon`
- `DroidIcon`
- maybe `CustomShellIcon`

Do not make model labels protocol-critical. Keep them as optional UI metadata.

## 8. How this should slot into CodeSurf concretely

## 8.1 Do not replace current `terminal` IPC first

CodeSurf's current terminal block already gives:
- tmux persistence
- direct shell access
- drag-and-drop paths
- font/theme integration

Nyx lift should target a new surface:
- `agent-shell` built-in block, or
- a bundled `ext:agent-shell` block if you want to prove it as extension-first

Recommendation: built-in block.

Reason:
- PTY daemon + hooks + status are core collaboration/runtime features
- they need preload/main access anyway
- they will likely become part of the product's permanent shell story

## 8.2 Tile state additions

Current CodeSurf `TileState` only has:
- `launchBin?`
- `launchArgs?`

For Nyx-style agent shells, add at least:
- `ptySessionId?: string`
- `agentShellType?: 'claude-code' | 'codex' | 'droid' | 'hermes' | 'gemini' | 'custom'`
- `agentShellLabel?: string`
- `agentModelLabel?: string`

Prefer storing these on a new built-in tile type instead of stuffing them into every terminal tile.

## 8.3 Where the state lives

Suggested split:
- persisted in tile/canvas state:
  - `ptySessionId`
  - shell type
  - launch command metadata
- ephemeral renderer store:
  - current detector state
  - last prompt
  - last idle tail
  - attention flags
  - live listeners / cleanup handles

That mirrors Nyx's effective behavior without copying its exact bundle store shape.

## 8.4 Bus integration

Normalize agent-shell status changes onto CodeSurf's EventBus.

Suggested events on `tile:${tileId}`:
- `type: 'activity'` source `agent-shell:${tileId}` payload `{ state: 'working'|'idle'|'waiting-for-user'|'done'|'error' }`
- `type: 'ask'` when detector enters `waiting-for-user`
- `type: 'task'` when a session starts or exits

This makes agent-shell status visible to:
- peers
- extensions
- sidebar/activity feed
- future relay/collab tools

## 9. Browser / review / comment mapping

## 9.1 What Nyx has

Nyx browser inspect path gives:
- hover overlay
- React component name/source lookup through DevTools global hook
- CSS selector generation
- click-to-select element
- exact element screenshot capture via `webContents.capturePage()` + crop
- numbered badges for saved annotations

Nyx diff/comment pattern gives:
- Monaco gutter affordance
- lightweight per-line comment markers

## 9.2 What CodeSurf already has

CodeSurf already has the stronger browser review substrate:
- BrowserTile with managed webviews
- Cluso embed toolbar
- marker/copy/send/clear controls
- bus bridge from web content -> host
- peer relay on `tile:*`
- extension chat surfaces with `surface.setPayload`
- chat block notes via `BlockNoteAffordance`

## 9.3 Recommended mapping

### Nyx BrowserTile inspect -> CodeSurf BrowserTile + chat surface

Do not port the whole Nyx BrowserTile UX.

Port only:
1. `electron/inspect.cjs` main-process screenshot capture
2. lightweight inspect-mode selector/badge logic as an optional fallback or alternate mode
3. annotation object shape

Map saved annotations to one of these CodeSurf patterns:
- BrowserTile tile-state annotations
- extension chat surface payloads
- chat block notes after send
- tile context entries if peer-visible review state is desired

Best concrete fit:
- keep Cluso as the primary review UI
- when user selects an element or marker region, use Nyx-style exact screenshot capture to generate cleaner chat attachments
- publish saved annotations to BrowserTile tile-state and expose them to chat as structured attachments

### Nyx DiffTile comments -> CodeSurf note/comment primitives

Immediate mapping:
- use `BlockNoteAffordance` ideas for comment UX patterns
- keep comments attached to blocks/messages/review items, not just files

Later mapping:
- create a Monaco gutter comment extension for CodeTile or a future diff block
- reuse Nyx's small-plus-glyph + active-comment-glyph interaction pattern

### Nyx Todo/Notes/Editor/Image patterns

These mostly map to existing CodeSurf blocks already:
- TodoTile -> KanbanTile / task drawer
- NotesTile -> NoteTile
- EditorTile -> CodeTile
- ImageTile -> Image/File/media surfaces

The key lift is not the tile bodies; it is the agent-shell + inspect/comment glue.

## 9.4 Browser inspect/review/comment flow for CodeSurf

Recommended target flow:
1. User opens BrowserTile.
2. User enters review mode from existing Cluso toolbar or a new "Pick element" action.
3. Selection creates:
   - selector
   - DOM snippet / forensic data
   - exact screenshot crop via ported Nyx `inspect.captureElement`
4. Result is cached as:
   - BrowserTile annotation
   - optional extension chat-surface payload
5. User sends to chat.
6. Chat block renders with `BlockNoteAffordance` for follow-up comments.
7. Optional: publish annotation summaries to connected peers through EventBus / relay.

This is a better fit than trying to port Nyx's inspect popup 1:1.

## 10. Risks and gotchas

1. Dotfile mutation risk
   - Nyx hook manager edits user config files in `~/.claude`, `~/.codex`, `~/.factory`
   - CodeSurf must make this opt-in and reversible

2. `/dev/tty` assumption
   - Nyx generic hook bridge writes OSC payloads to `/dev/tty`
   - that is Unix-centric
   - Windows support will need a different emission path or a direct stdout/stderr injection strategy

3. Two persistence systems
   - CodeSurf generic terminals already use tmux
   - adding Nyx daemon sessions for all terminals immediately would create duplicated persistence semantics
   - keep the new daemon scoped to agent-shell blocks first

4. Renderer logic source quality
   - Nyx detector implementation is only available in built JS here
   - reimplement it in typed source with tests rather than copying minified output

5. Hook schema drift
   - Codex and Claude hook config formats can change
   - keep the config manager isolated and testable

6. Multiple daemons already exist in CodeSurf
   - CodeSurf already has a local HTTP daemon/client pattern for other features
   - startup and shutdown ordering must not be hand-waved

7. Session identity mismatch
   - Nyx uses daemon session ids separate from tile ids
   - CodeSurf's current terminal stack keys persistence by tile id
   - mixing them without a clear type boundary will cause restore bugs

## 11. Recommended implementation order in small controlled bursts

## Burst 1: shared shell registry + command resolution only

Goal:
- no UI changes yet
- no dotfile changes yet

Work:
- add `src/shared/agent-shells.ts`
- port `agent-command-resolver` + `node-pty-helper`
- add `agentPty:resolveCommand` preload/main API
- add tests for resolver behavior and PATH augmentation

Why first:
- safe
- low side effects
- immediately useful to both terminal and future agent-shell UI

## Burst 2: isolated daemon skeleton

Goal:
- create/attach/write/resize/kill works behind new namespace
- still no user-facing hook patching

Work:
- add `src/main/agent-pty/{protocol,session,server,lifecycle,index,client}.ts`
- start daemon lazily
- expose `agentPty:*` IPC/preload API
- verify create/attach/kill using a hidden test harness or manual local block

Keep current `terminal:*` intact.

## Burst 3: renderer detector library

Goal:
- typed reimplementation of Nyx state detection
- no hook patching yet

Work:
- implement hook parser + heuristic detector in TS
- add tests for:
  - submit -> working
  - 2 idle snapshots -> idle
  - silence tick >30s -> idle
  - AskUser tool -> waiting-for-user
  - permission notify -> waiting-for-user
  - sessionId filtering
  - subagent-stop ignored

This is the highest-value logic port after the daemon.

## Burst 4: minimal `agent-shell` block

Goal:
- new block type for Claude/Codex first
- generic terminal still unchanged

Work:
- add built-in `agent-shell` tile/component
- persist `ptySessionId` in tile state
- render xterm
- attach detector
- wire `agentPty:updateStatus`
- show compact status badge + provider icon

Do only Claude Code and Codex first.

## Burst 5: hook manager opt-in

Goal:
- reliable state transitions for supported shells

Work:
- port hook manager and templates
- add settings UI / diagnostics for enable-disable-cleanup
- support Claude Code + Codex first
- add Droid only after the first two are stable
- do not port `cc-hooks-bridge` unless needed for compatibility

## Burst 6: browser capture bridge

Goal:
- use Nyx's useful inspect primitives without replacing CodeSurf's review UX

Work:
- port `inspect.captureElement`
- add BrowserTile helper that turns current selection / Cluso marker into exact element crop
- push results into chat-surface payloads or BrowserTile annotation state

## Burst 7: cross-workspace session monitoring

Goal:
- optional parity with Nyx workspace snapshots

Work:
- add a background shell monitor store keyed by `ptySessionId`
- keep agent-shell states current even when tiles/workspaces are not focused

This is valuable, but definitely not first-wave.

## 12. Concrete first-burst checklist

Smallest useful first PR:
- `src/shared/agent-shells.ts`
- `src/main/agent-pty/command-resolver.ts`
- `src/main/agent-pty/node-pty-helper.ts`
- `src/main/ipc/agentPty.ts` with only `resolveCommand`
- preload bridge additions for `window.electron.agentPty.resolveCommand`
- tests for resolver + executable lookup + Codex node runtime detection
- no UI changes

Smallest second PR after that:
- daemon protocol/server/session/client
- `agentPty:create/attach/write/resize/kill`
- hidden/manual test harness or temporary developer-only tile
- still no hook patching

Smallest third PR after that:
- detector TS library + tests
- hook parser and heuristic classifier table
- no dotfile mutation yet

## 13. Most important port recommendations

1. Keep CodeSurf's generic tmux terminal and Nyx-derived agent-shell PTY separate at first.
2. Port Nyx's command resolver, env shaping, and daemon/session protocol before any UI work.
3. Reimplement the detector from spec in TS; do not depend on copied minified bundle code.
4. Treat hooks as an opt-in reliability layer for Claude Code / Codex / Droid only.
5. Reuse CodeSurf's BrowserTile + Cluso + chat-surface architecture; port only Nyx screenshot capture and lightweight inspect helpers.
6. Persist daemon session ids on the new agent-shell block, not on every terminal tile.
7. Skip `cc-hooks-bridge` initially unless a real Claude compatibility gap appears.

## 14. Recommended next-session handoff

If the next session wants a low-risk path, start here:
- build the new `agentPty` namespace only
- get `resolveCommand`, `create`, `attach`, `write`, `resize`, `kill` working
- add zero dotfile mutations
- add the detector as a pure TS module with tests
- only then build the first `agent-shell` block

That sequencing preserves today's CodeSurf behavior while making the Nyx lift reusable and reversible.
