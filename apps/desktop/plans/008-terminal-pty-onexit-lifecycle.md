# Plan 008: Handle PTY exit — clean up dead terminal sessions and notify the renderer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 77e3c7d..HEAD -- src/main/ipc/terminal.ts src/preload/index.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `77e3c7d`, 2026-07-01

## Why this matters

The terminal subsystem never listens for the PTY process exiting. Three
consequences:

1. **Leak**: when a shell (or tmux client) exits, its entry in the `terminals`
   map — including a `Set<WebContents>` of listeners and up to 200 KB of scrollback
   buffer — lives until app quit. One leaked entry per terminal whose process ever
   exits.
2. **Frozen tile**: the renderer is never told the process died, so the terminal
   tile shows a dead shell that ignores input.
3. **Dead reattach**: `terminal:create` for the same `tileId` early-returns the
   existing session (with a dead pty), so the tile can never recover without
   deleting it. Subsequent `terminal:write` calls silently no-op forever.

## Current state

- `src/main/ipc/terminal.ts` — all terminal IPC. Key structures (lines ~166-185):

```ts
interface PtyInstance {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (data: string) => void) => void
}

interface TerminalSession {
  pty: PtyInstance
  listeners: Set<WebContents>
  buffer: string
  tmuxSession?: string
  shell: string
}

const terminals = new Map<string, TerminalSession>()
const terminalBuffers = new Map<string, { data: string; timer: ... }>()
```

`PtyInstance` is a wrapper interface; the underlying object is a `node-pty`
`IPty`, which DOES expose `onExit(cb: (e: { exitCode: number, signal?: number }) => void)`.
Find where the pty is spawned in this file (search `pty.spawn` / where the
`PtyInstance` wrapper is constructed) and confirm the raw `IPty` is available
there.

The reattach early-return (terminal.ts:~250-255) — returns a possibly-dead session:

```ts
const existing = terminals.get(tileId)
if (existing) {
  existing.listeners.add(event.sender)
  trackTerminalSender(event.sender, tileId)
  return { cols: 80, rows: 24, buffer: existing.buffer }
}
```

Data fan-out pattern to copy for the exit event (terminal.ts:~458-471):

```ts
term.onData((data: string) => {
  session.buffer = (session.buffer + data).slice(-200000)
  for (const listener of [...session.listeners]) {
    try {
      if (!listener.isDestroyed()) {
        listener.send(`terminal:data:${tileId}`, data)
        listener.send(`terminal:active:${tileId}`)
      } else {
        session.listeners.delete(listener)
      }
    } catch {
      session.listeners.delete(listener)
    }
  }
  ...
```

Cleanup pattern to copy (the `terminal:destroy` handler at terminal.ts:~534-545
deletes from `terminals`; also see `terminalBuffers` timer clearing nearby).

- `src/preload/index.ts` — exposes the terminal API to the renderer. Data
  subscription uses per-tile channels (`terminal:data:${tileId}`). Follow the
  same pattern for the new exit channel.
- `src/renderer/src/env.d.ts` — `ElectronAPI` interface; must be extended in
  lockstep with the preload (there is a `preload-parity` test that compares them).

Repo conventions: 2-space indent, no semicolons, strict TS. `handleTyped` (zod)
wraps side-effecting IPC handlers — the new work here adds no new renderer-callable
handler, so no schema changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (if needed) | `npm install` | exit 0 (slow; native rebuild) |
| Typecheck | `npm run typecheck` | no NEW errors in touched files (baseline is dirty elsewhere) |
| Parity test | `node --test test/preload-parity.test.ts` (if present; check `ls test | grep parity`) | no NEW failures vs before your change |

## Scope

**In scope** (the only files you should modify):
- `src/main/ipc/terminal.ts`
- `src/preload/index.ts` (add `onExit` subscription to the terminal API)
- `src/renderer/src/env.d.ts` (matching type)
- `src/renderer/src/components/TerminalTile.tsx` or equivalent terminal tile
  component (find it: `grep -rln "terminal:data:" src/renderer/src`) — display
  the exited state (minimal: a "process exited" line and allow re-create)
- `test/terminal-exit-lifecycle.test.ts` (create, if a pure helper is extracted)

**Out of scope** (do NOT touch):
- tmux session lifecycle policy — do NOT kill the tmux *session* on pty exit
  (detach/exit of the client is normal; the session may be intentionally
  persistent). Only clean up the app-side `TerminalSession`.
- `terminal:cd`, allowlist/injection logic, `flushTerminalToBus` — unrelated.

## Git workflow

- Branch: `fix/terminal-pty-exit`
- Commits per logical unit; imperative messages (match `git log --oneline` style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Expose `onExit` on `PtyInstance`

Add `onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void`
to the `PtyInstance` interface and wire it through wherever the wrapper is
constructed (delegate to the underlying node-pty `IPty.onExit`). If there is a
non-node-pty implementation of `PtyInstance` in the file (e.g. an electrobun or
test fake), give it a no-op or equivalent hook — search the repo for other
implementers first: `grep -rn "PtyInstance" src/`.

**Verify**: `npm run typecheck` → no new errors.

### Step 2: Register the exit handler next to `term.onData`

In the `terminal:create` handler where `term.onData(...)` is registered, add:

```ts
term.onExit(({ exitCode }) => {
  const current = terminals.get(tileId)
  if (!current || current.pty !== term) return // superseded by a newer session
  for (const listener of [...current.listeners]) {
    try {
      if (!listener.isDestroyed()) listener.send(`terminal:exit:${tileId}`, exitCode)
    } catch { /* listener gone */ }
  }
  const buf = terminalBuffers.get(tileId)
  if (buf?.timer) clearTimeout(buf.timer)
  terminalBuffers.delete(tileId)
  terminals.delete(tileId)
  bus.publish({
    channel: `tile:${tileId}`,
    type: 'system',
    source: `terminal:${tileId}`,
    payload: { action: 'exited', exitCode }
  })
})
```

Match the exact `bus.publish` shape used by the `created`/`reattached` publish
already in this handler.

**Verify**: `grep -n "terminal:exit" src/main/ipc/terminal.ts` → present in the
exit handler.

### Step 3: Preload + types

In `src/preload/index.ts`, alongside the existing terminal `onData`-style
subscription, add an `onExit(tileId, cb)` subscription for `terminal:exit:${tileId}`
returning an unsubscribe function (copy the existing per-tile listener pattern
exactly). Mirror the type in `src/renderer/src/env.d.ts`.

**Verify**: `npm run typecheck` → no new errors; if `test/preload-parity.test.ts`
exists, run it → no NEW failures (it has 1 known pre-existing failure on some
baselines — compare against a pre-change run).

### Step 4: Renderer shows exit and allows respawn

In the terminal tile component, subscribe to `onExit`; on exit, render a
"[process exited (code N)] — press Enter to restart" affordance (or the
minimal equivalent consistent with the tile's existing UI) that calls the
existing create/attach path again. Because Step 2 deletes the dead session,
`terminal:create` will now spawn fresh instead of returning the dead one.

**Verify**: `npm run typecheck` → no new errors.

### Step 5: Manual smoke (only if you can run the app)

`npm run dev`, open a terminal tile, type `exit`. Expected: the tile shows the
exited state instead of freezing; re-activating spawns a fresh shell; and a
second `exit` repeats cleanly.

## Test plan

- If you extract the exit-cleanup into a pure helper (recommended:
  `handlePtyExit(tileId, exitCode, deps)` taking the maps as params), add
  `test/terminal-exit-lifecycle.test.ts` (node --test, model after
  `test/security-hardening.test.ts` style) covering: session removed from map,
  buffers timer cleared, superseded-pty guard (old pty exit after respawn does
  NOT delete the new session).
- The superseded-pty guard case is the regression this plan most needs pinned.

## Done criteria

- [ ] `term.onExit` registered; `terminals` and `terminalBuffers` entries removed on exit
- [ ] Renderer receives `terminal:exit:${tileId}` and can respawn
- [ ] Superseded-pty guard present (`current.pty !== term` check or equivalent)
- [ ] `npm run typecheck` shows no new errors in touched files
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- `PtyInstance` has multiple implementers whose underlying object lacks an exit
  hook (report which, don't fake it).
- The tmux integration turns out to route exit differently (e.g. tmux client
  exits but the pty stays alive) in a way that makes `onExit` fire at the wrong
  time — report observed behavior instead of guessing policy.
- The renderer terminal component's structure makes Step 4 require touching
  more than ~2 renderer files.

## Maintenance notes

- If terminal persistence/reattach across app restarts is added later, the
  exit-cleanup must coordinate with tmux session persistence (today only the
  app-side session is cleaned; the tmux session survives by design).
- Reviewer: scrutinize the superseded guard — `terminal:create` may replace a
  session while the old pty's exit event is still in flight.
