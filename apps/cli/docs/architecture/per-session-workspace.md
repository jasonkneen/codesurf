# Per-session workspace: one server, many folders

## Problem

A `codesurf node` hosts many sessions in one process, but before this change
every session ran in the node process's own folder. The Agent and its tools read
the working folder through two process-wide sources:

- `getHostServices().bash`: one `BashTool` bound by `builtin.tools.bash`. It is
  read about 90 times across `src/agent/**`, the kernel tools (bash, file, grep),
  the hooks sink, sub-agents, delegations and schedules.
- `process.cwd()`: project settings (`.grok/settings.json`), providers'
  workspace folders, MCP stdio spawns and a few defaults.

So a TUI in `~/projectB`, attached to a server started in `~/projectA`, edited
projectA.

The Agent constructor also binds three process-global sinks: `subagents`,
`schedule` and `hooks`. The last Agent constructed wins, so with two node
sessions, session A's `task` tool ran on session B's Agent. `Agent.cleanup()`
also affected the whole process: evicting one session killed every session's
provider connections (`disposeAllProviderSessions`) and background processes
(the global `bash.cleanup()`).

## Design

### The seam: a per-session `WorkspaceScope` (AsyncLocalStorage)

`src/utils/workspace-scope.ts` holds an `AsyncLocalStorage<WorkspaceScope>`:

```ts
interface WorkspaceScope {
  root: string              // realpath of the session folder (fixed)
  bash: BashSink            // the session's own shell (live cwd, sandbox)
  subagents / schedule / hooks: sink | null  // bound by the Agent built in scope
}
runInWorkspace(scope, fn)   // enter the scope
currentWorkspaceScope()     // undefined outside a scope
workspaceRoot()             // scope.root ?? process.cwd()
scopeAsyncIterable(scope, it) // runs every next()/return()/throw() in scope
```

The process-wide readers check the scope first and fall back to the old globals:

| Reader | In a scope | No scope (TUI, serverless) |
|---|---|---|
| `services.bash.*` (`requireBashSink`) | `scope.bash` | global sink |
| `services.workspace.cwd()`, mentions index | `scope.bash.cwd()` | `cwdProvider ?? process.cwd()` |
| `services.subagents/schedule/hooks` | scope's sink | global sink |
| `setSubagentsSink/setScheduleSink/setHooksSink` | write the scope | write the global |
| `loadProjectSettings()` / `saveProjectSettings()` | `<root>/.grok/settings.json` | `process.cwd()` |
| provider/MCP folder defaults | `root` | `process.cwd()` |

**Why ambient state and not an explicit `Agent({ workspace })` option.** The
lead's brief preferred threading an explicit per-Agent workspace. The folder is
not read only by the Agent, though. The kernel tools (bash, file, grep), the
hooks sink, the sub-agent and schedule bridges and the provider connect context
all resolve it lazily through `getHostServices()`, which is part of the plugin
API. To thread it explicitly, every plugin contract would need a new parameter,
plus about 40 mechanical edits in `src/agent/**`. The scope changes the few
places that *resolve* the folder and leaves every *reader* alone. With no
scope, every resolver returns exactly what it did before, so the serverless TUI
path is unchanged by construction. There is precedent: `runInTelegramTurn` in
`sinks.ts` fences Telegram turns the same way.

**Generator rule.** An async generator runs in the context of whoever calls
`next()`. It does not keep the context it was created in. So the node wraps the
*consumer* side (`scopeAsyncIterable`), not just generator creation. Anything
started inside a turn inherits the scope: detached delegations, timers, provider
subprocess callbacks and MCP connects.

### Node side

- `SessionFrameIn` (`action: "create"`) gains `cwd?`, `sandboxMode?` and
  `sandboxSettings?`. `SessionStatus` gains `cwd`.
- `EngineNode` gives `NodeSessionHost` a `resolveWorkspace` hook,
  `resolveSessionWorkspace` in `src/relay/session-workspace.ts`. It requires
  an absolute path that exists and is a directory, then takes its realpath. A
  missing cwd means the node's `process.cwd()`. An invalid cwd throws, and the
  stream server answers with an error frame (`action: "create"`) so the client's
  `createSession` rejects instead of timing out.
- `HostedTurnRunner` gets the session's resolved workspace as a 4th argument.
- `NodeAgentHost` builds one `WorkspaceScope` per session, with its own
  `BashTool` rooted at the folder. It constructs the Agent inside the scope, so
  the Agent's sinks bind to the scope, `SessionStore`, the model selection and
  sandbox read that folder, and its sandbox mode lands on the session shell and
  not the node's. Every turn is consumed through `scopeAsyncIterable`, and
  `cleanup()` runs in scope. Sandbox mode is the client's value if given,
  otherwise `getCurrentSandboxMode()` for that folder. Sandbox settings are the
  folder's settings, merged with the client's.
- Batch jobs (`batchRunner`) also run in a scope on the node's folder. That way
  their `cleanup()` cannot tear down session state.

### Agent side (two small changes)

- `cleanup()`: inside a scope, dispose only this conversation's provider
  sessions (`disposeProviderSession(id)`), not all of them. `services.bash` and
  the LSP folder already resolve to the scope.
- `model-runtime.ts`: inside a scope, the provider connect context's
  `workspace.cwd()` is bound to that scope's shell. It stays bound for provider
  callbacks that fire outside the turn. The session-cache key includes the scope
  root, so two folders sharing a conversation id (`"ephemeral"`) never share a
  provider session.

## Inventory of `process.cwd()` / `bash.cwd()` readers

(a) must become per-session, (b) process-level and fine, (c) UI only.

| Site | Class | Resolution |
|---|---|---|
| `src/agent/**` `getHostServices().bash.cwd()` (~40 sites: session store, hooks payloads, prompt instructions and skills, delegations, schedules, subagents, compaction hooks) | a | automatic: `services.bash` resolves to the scope |
| `agent.ts` subagents/schedule/hooks sink binding | a | setters write the scope |
| `turn-control.ts` `cleanup()` | a | per-conversation dispose inside a scope |
| kernel bash / process tools (`ctx.bash`) | a | automatic via host bindings, then `requireBashSink` |
| file tools, grep tool (`ctx.workspace.cwd()`) | a | `workspace.cwd()` scope-aware |
| `loader.ts` `workspace.cwd()` / `currentWorkspaceCwd()` | a | scope first |
| `model-runtime.ts` connect `workspace` + cache key | a | scope-bound |
| `utils/settings.ts` `load/saveProjectSettings` (feeds model selection, sandbox mode/settings, LSP settings) | a | `workspaceRoot()` |
| `claude-agent-provider.ts:548,934,1723` | a | `workspaceRoot()` |
| `codex-provider.ts:650` thread cwd | a | `workspaceRoot()` |
| `omnigent-provider.ts:722` workspace | a | `workspaceRoot()` |
| `codesurf-desktop-provider.ts:630,954,1043` | a | `workspaceRoot()` |
| amp/grok/fractal/opencode/claude-skills `ctx.workspace?.cwd()` | a | automatic via the connect context |
| `mcp/runtime.ts` stdio spawn cwd, `mcp/command-exists.ts` default | a | `server.cwd ?? workspaceRoot()` |
| `bash-tools.ts:225` global `BashTool(process.cwd())` | b | the node/TUI default shell |
| `tools/bash.ts:109` constructor default | b | callers pass a cwd |
| `tools/schedule.ts:164,437` defaults | b | the Agent passes the scoped `getCwd` |
| `opencode-provider.ts:488-489` model-catalog listing | b | the catalog is node-wide |
| `relay/ws-transport.ts:171` `fileRoots` (GET /files) | b | **gap**: see below |
| `utils/workspace-trust.ts` defaults | b | every caller passes a cwd |
| `utils/workflows.ts`, `utils/claude-plugins.ts` project roots | b | slash commands and plugins load once per process |
| `telegram/headless-bridge.ts`, `daemon/*`, `src/index.ts` | b | process entrypoints |
| `tile-state-integration.ts`, `storage/tile-state.ts` | b | CodeSurf canvas tile record for the process |
| `ui/local-file-paths.ts`, `ui/terminal/manager.ts`, `editor-command.tsx` | c | TUI only |

## Left process-global (by design or deferred)

- **`setKernelMode`**: a module-global mirror of the current mode. ToolSet
  builds already pass the mode explicitly (see `session-toolsets.ts`). Only the
  `/extensions` UI view reads the global.
- **Tool enablement, plugin catalog, user settings**: machine-wide by design.
- **`services.session.id()`**: `null` on a node, since only the TUI binds it.
  Hook payloads on a node carry no session id, same as before this change.
- **GET /files roots** (`ws-transport.ts`): still the node's folder plus tmpdir.
  A web front cannot fetch files from a session folder elsewhere. Adding session
  roots means the stream server has to tell the file server about them. Not in
  scope here.
- **Telegram, chat, input, toast sinks**: TUI-only surfaces.
