# Findings — Claude (Opus 4.7) loses context on resume "via the codesurf extension"

**Status:** READ-ONLY investigation. No code changed.
**Repo of the bug:** **grok-cli** (`~/Documents/GitHub/grok-cli`), not `collaborator-clone`.
**Key correction:** My first hypothesis (provider "session-id pinning") was **empirically
REFUTED**. On-disk data shows Claude session ids are *stable* across resumed turns, the
provider session is *reused* per conversation, and the one real multi-turn grok-CLI
conversation on disk **worked**. So the named path is correct in the normal flow; the
failure is a *conditional* drop, and there is a strong **alternative path** the user may
actually be on. Details + the one data point that localizes it are below.

---

## The path "Claude Opus 4.7 via the codesurf extension"

grok-cli builtin **CodeSurf Desktop provider** → shared `codesurfd` daemon over HTTP+SSE
(same daemon the desktop app uses).

- Provider: `~/Documents/GitHub/grok-cli/src/core/extensions/builtin/codesurf-desktop-provider.ts`
- Model: `claude-opus-4-7` = "Opus 4.7 (Codesurf)" (lines **120–121**), downstream `claude`.
  **Model resolution is correct.**
- Daemon runner: `collaborator-clone/packages/codesurf-daemon/bin/chat-jobs.mjs:runClaudeJob` (1221).

## What the evidence PROVES (and rules out)

1. **Builtin desktop `chatClaude`** correct — `src/main/chat/providers/claude.ts:725`.
2. **Daemon resume wiring correct** — `chat-jobs.mjs:1354` (`{ resume: request.sessionId }`).
3. **Claude SDK session ids are STABLE across resumed turns.** `~/.codesurf/jobs/*.json`
   multi-turn conversations keep ONE id across all turns (e.g. `tile-1781509995375` 3 turns
   `514fe8eb…`; `tile-1780604484206` 5 turns; grok-CLI card `codesurf-f67b07da63ff` 3 same-day
   turns all `c92228fd…`). One turn emits exactly one id (`session`+`done` agree).
4. **The grok-CLI path threads resume CORRECTLY in the normal flow.** `codesurf-f67b07da63ff`
   is a *pure-CLI* run (`workspaceId:null`, `workspaceDir` is a filesystem cwd, not a `ws-…`
   desktop workspace). Its 3 same-day turns ran from the **same cwd** and shared one session
   id → resume worked. The provider session is cached per `(adapterId, conversationId)` and
   reused across turns (`grok-cli/src/core/extensions/model-runtime.ts:47,57-68`);
   `conversationId = services.session.id() ?? "ephemeral"` (`loader.ts:1347`), stable per
   conversation. The only `disposeProviderSession` triggers are API-key rotation
   (`agent.ts:589`, and `setApiKey` is constructor-only at `agent.ts:428` so it's a no-op
   there) and conversation switch (`agent.ts:888`) — **not** per-turn events.
5. **RETRACTED:** `setSessionId` pin-to-first (`codesurf-desktop-provider.ts:1118-1130`) is a
   no-op given (3); not the cause. (Still rests on a wrong premise — line **493** "upstreams
   that ignored resume" — and is worth deleting, but it does not lose Claude context.)
6. **Not the harness stopgap** — `shouldUseHarness` needs `useHarness===true`
   (`chat-jobs.mjs:753-757`); the grok payload never sets it.
7. **Not codex-style flag ordering** — SDK named option, not a CLI subcommand.

## The amplifier (why any miss = TOTAL amnesia, matching "Tell me more")

`runClaudeJob` sends **only the last user message** as the prompt and **discards the full
`messages` array** the provider sends, relying entirely on `resume` for history
(`chat-jobs.mjs:1222`, `1383`, `1354`). So if the session id is absent on any turn, that
turn loses **all** prior context, not just the last exchange.

## The concrete conditional drop points (file:line)

When the provider session IS disposed/recreated between turns (key rotation `agent.ts:589`;
conversation switch `agent.ts:888`; process restart; consumer error), `this.sessionId`
resets to null and continuity falls to recovery — which has two real defects:

- **D1 — cwd-filtered recovery misses.** `readDaemonSessionId`
  (`codesurf-desktop-provider.ts:590`, impl **881-929**) only accepts a prior job when
  `job.workspaceDir === process.cwd()` (**line 920**). If the next turn runs from a different
  cwd than the turn that created the session, recovery returns null → fresh Claude session →
  total context loss. (Directly observed: `codesurf-f67b07da63ff`'s 4th turn ran from
  `…/ideation-canvas` instead of `…/ideation-canvas/artifacts/ideation-canvas` and got a
  **fresh** id `09f9386c…`.)
- **D2 — the tile-state recovery channel is a dead-end write.** The provider *persists* the
  id via `tileSessionContext.setDaemonSessionId()` (`codesurf-desktop-provider.ts:999,1128`;
  impl `tile-state-integration.ts:98`) but **never reads it back**: there is no
  `getDaemonSessionId` getter, and neither the constructor (**522-554**) nor `sendTurn`
  (**590**) seeds `this.sessionId` from tile state. So after any dispose, the persisted id
  cannot rehydrate the session — recovery depends solely on the fragile D1 path.

**Minimal fix (in grok-cli, not this repo):** seed `this.sessionId` on connect from the
persisted tile-state id (add a `getDaemonSessionId` getter + read it in the constructor /
before `readDaemonSessionId` at line 590), and/or relax the `workspaceDir` equality in
`readDaemonSessionId` (line 920) to recover by `cardId` alone. Either makes continuity
survive a session dispose. (Optional defense-in-depth here: have `runClaudeJob` stop
discarding the transcript — `chat-jobs.mjs:1222` — so context doesn't ride solely on resume.)

## Strong ALTERNATIVE path to confirm with the user

"Opus 4.7" is also offered by grok-cli's **direct** Claude Agent SDK adapter,
`src/core/extensions/builtin/claude-agent-provider.ts` (`mode="persistent"`,
`strategy="singleton"`, lines **293-294**). It does NOT use daemon session-id resume — it
keeps one long-lived SDK subprocess and pushes a new message per turn, and on a `/sessions`
resume it **disposes the whole session and re-injects prior history via a "resume preface"**
(lines **257-266**, **325-328**, **553-569**). If the user actually selected Claude through
this adapter (not the CodeSurf-desktop provider), a failure in that preface re-hydration —
or the subprocess dying between turns — would drop context on the next turn. This is a
different root cause in a different file. **The phrase "codesurf extension" points at the
daemon provider, but the terminology is ambiguous enough to verify.**

## The one data point that settles it (please provide)

From the user's actual failing conversation:
1. Which extension/model entry was selected (CodeSurf-desktop provider vs Claude Agent SDK
   adapter vs omnigent/lightclaw)?
2. Did both turns run from the **same working directory**? (cwd change → D1.)
3. The two `~/.codesurf/jobs/<id>.json` records for turn 1 and turn 2: same `cardId`? Did
   turn 2 carry turn 1's `sessionId`, or a fresh one? (fresh → D1/D2; same id but still no
   context → re-open daemon resume.)

With (1)–(3) the candidate set collapses to a single few-line fix in grok-cli.
