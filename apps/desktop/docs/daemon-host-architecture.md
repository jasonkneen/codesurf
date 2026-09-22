# CodeSurf Host And Daemon Architecture

## Core model

- `Workspace`: top-level canvas tab and layout container
- `Project`: mounted folder or repo inside a workspace
- `Thread`: chat/session attached to a project
- `Host`: where a thread executes

## Host types

- `runtime`
  - Electron main process executes the task in-process
  - fallback path when no daemon is available
- `local-daemon`
  - detached daemon on the same machine executes the task
  - preferred local execution path
- `remote-daemon`
  - registered remote daemon executes the task off-machine
  - cloud/offload path

## Chat run modes

- `foreground`
  - current tile owns the live stream
  - a new foreground turn replaces any existing foreground execution for that tile
- `background`
  - daemon-backed only
  - job runs detached from the tile stream and continues independently
  - intended for orchestration/offload work so the foreground chat can keep talking about something else

## Async preference model

When daemon execution is available, chat reasoning should understand three async paths:

1. provider-native backgrounding
   - preferred for Claude/Codex subagents if the provider offers a stronger native workflow
2. daemon-detached orchestration
   - preferred when the main conversation should remain free while work continues in CodeSurf infrastructure
3. foreground streaming
   - default interactive mode for normal conversational turns

## Routing policy

Execution routing is stored in `settings.execution`:

- `auto`
  - prefer `local-daemon`
  - fall back to `runtime`
- `prefer-local-daemon`
  - same behavior as `auto`, but semantically explicit
- `runtime-only`
  - never leave Electron
- `daemon-only`
  - require daemon execution, falling back only if no viable daemon exists
- `specific-host`
  - pin new work to one registered host

## Persistence

Host registry is stored separately from workspaces and settings:

- `~/.codesurf/hosts/hosts.json`
- `~/.codesurf/settings.json`
- `~/.codesurf/projects/projects.json`
- `~/.codesurf/workspaces/workspaces.json`

This separation keeps infrastructure state independent from UI state.

## Built-in hosts

The daemon always materializes two built-ins:

- `local-runtime`
- `local-daemon`

Remote daemons are user-managed entries layered on top.

## Current implementation status

Implemented now:

- shared types for execution hosts and routing preference
- daemon-backed host registry
- IPC bridge for list/upsert/delete/resolve
- settings UI for execution preference and remote host registration
- router contract for choosing the effective host
- daemon-backed chat/job execution for `claude` and `codex`
- persisted `jobs/<job-id>.json` metadata plus append-only `timelines/<job-id>.jsonl`
- SSE job replay/resume endpoints for local and remote daemon streams

Not implemented yet:

- full provider parity beyond `claude` and `codex`
- remote repo provisioning
- richer remote workspace/environment sync

## Next phase

The next phase is moving chat execution from `src/main/ipc/chat.ts` into daemon-owned jobs:

1. create `jobs/<job-id>.json`
2. append timeline events in `timelines/<job-id>.jsonl`
3. subscribe renderer to job streams
4. keep Electron as a client/controller only
5. allow local daemon and remote daemon jobs to continue after Electron exits
