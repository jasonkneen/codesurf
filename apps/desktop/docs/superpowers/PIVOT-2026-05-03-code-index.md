# Code Index — Target Pivot

**Date:** 2026-05-03
**Why this doc exists:** the original spec and plan targeted the wrong product. This doc captures the corrected target, what survives the pivot, what dies, and the long-term architecture the design must accommodate.

---

## The mistake

The spec at `docs/superpowers/specs/2026-05-03-code-index-design.md` and the plan at `docs/superpowers/plans/2026-05-03-code-index.md` were written for the **CodeSurf desktop app** (`collaborator-clone`, the Electron host). Five tasks were implemented in that worktree before the user caught it.

The intended target is the **CodeSurf CLI**, which is the project at:

    /Users/jkneen/Documents/GitHub/grok-cli/

`grok-cli` is being rebranded to `codesurf`. They are the same product — `grok-cli` is the codename, `codesurf` is the public name. The binary `/usr/local/bin/codesurf` is a symlink to `grok-cli/scripts/codesurf.sh`.

---

## Long-term architecture (must inform design choices)

### The architectural NorthStar

> **The desktop is dumb as shit. The daemon is smart.**

All intelligence — agent loop, tools, MCP, indexing, planning, hooks, memory,
inference — lives in **`grok-cli`** (the daemon). The desktop is a
**UI shell**: it renders, takes input, and forwards everything to the daemon.
It owns no logic that the CLI doesn't already own.

Putting code-index in the desktop app is wrong **twice**:
1. Wrong product (this is CLI feature territory).
2. Wrong **layer** (any logic in the dumb shell is misplaced even if the
   product targeting were right).

### The user's statements, captured verbatim

> "eventually this will merge with the daemon in codesurf so they will be one
> and the same then the desktop app will use this as it's daemon and cli too"

> "so there is no need for it to be in desktop, and if it's in the electron
> app and not the daemon well that's worse because the desktop itself should
> be dumb as shit"

### Decoded

1. **Now:** `grok-cli` (CLI/TUI/daemon-in-progress) and the CodeSurf desktop
   app (`collaborator-clone`, Electron) are two separate codebases.
2. **Soon:** `grok-cli` absorbs / becomes the CodeSurf daemon. They unify.
3. **Eventually:** the desktop app drops all logic and becomes a **rendering
   shell** that talks to the merged `grok-cli`. The desktop owns no agent,
   no tools, no index, no nothing — just UI.

### Implications for code-index

- **Build it in `grok-cli`.** That is where it will live forever.
- **Keep `lib/*` as platform-agnostic Node modules** so they survive any
  process boundary the merge introduces. They already are.
- **Expose the index via clean interfaces** (in-process function calls + MCP
  server). Any future desktop UI consumes those same interfaces — never
  reimplements logic.
- **Do NOT design for the desktop app's tile bridge.** That layer goes away
  or gets reshaped when the desktop becomes a thin shell.
- **Hook integration goes through `grok-cli/src/hooks/`** — the in-process
  hook system grok-cli already has.
- **Anything that could conceivably belong in the desktop UI must NOT live
  there.** Index queries, ranking, freshness checks, parser invocations —
  all daemon-side. The desktop only ever asks "give me the data, I'll render
  it."

### YAGNI guard

Do not pre-build for the merge. Design clean interfaces, ship for the CLI,
let the merge happen when it happens. The "dumb desktop" principle is a
**constraint that simplifies design**, not a feature to engineer toward.

---

## What survives the pivot (reuse intact)

Five tasks were committed on `feat/code-index` in this worktree (`/Users/jkneen/clawd/collaborator-clone-code-index/`). Every commit hash is in `HANDOFF-2026-05-03-code-index.md`. The reusable artefacts:

| File | Reusable? | Notes |
|------|-----------|-------|
| `lib/storage.js` | **Yes, as-is** | Atomic JSON write, debounced, JSONL append + rotation. Pure Node. Drop-in for `grok-cli/src/code-index/lib/storage.ts` (port to TS). |
| `lib/indexer.js` | **Yes, as-is** | Counters, hotness with decay, co-occurrence with session windows. Pure logic. Port to TS. |
| `lib/workspace.js` | **Yes, as-is** | `cwd → workspace root` resolution with `.git` walk + env override. |
| `lib/ingest-server.js` | **Probably drop** | HTTP localhost ingest. Not needed when hooks run in-process inside grok-cli. Keep the file in case the future desktop merge wants an HTTP endpoint, but do not wire it in for the CLI MVP. |
| `evals/unit/*.test.mjs` | **Yes, port** | Test bodies survive; convert to vitest TS in grok-cli's existing test setup. |
| `vitest.config.mjs` | **Drop** | grok-cli has its own. |
| `extension.json` | **Drop** | CodeSurf-desktop manifest. Irrelevant for CLI. |
| `package.json` | **Drop** | grok-cli has its own deps. |

**~600 LOC of working, tested code carries over.** The ~hour spent on `extension.json` scaffolding, the desktop-extension review loop, and the desktop tile design (Task 7.1 in the plan) are the actual loss.

## What dies

- **Tiles.** No tiles in a CLI. If observability is needed, ship a `codesurf code-index status` subcommand or a `--json` MCP tool response that pretty-prints in the terminal.
- **`extension.json`.** No CodeSurf-desktop manifest. grok-cli does not load extensions this way.
- **`main.js` shape.** The current main.js was written around `ctx.bus`, `ctx.mcp.registerTool`, `ctx.workspacePath`. None of that exists in grok-cli. The new entrypoint is a stdio MCP server.
- **Hook config snippet for Claude Code's `settings.json`.** Wrong tool. The new hook config goes in grok-cli's hook config format (see `grok-cli/src/hooks/config.ts` and `types.ts`).
- **Plan tasks 4.2 (main.js wiring around ctx) and 7.1 (dashboard tile).** Replace with grok-cli-shaped equivalents.

## What stays valid conceptually

The spec's design decisions are target-agnostic. These all carry forward:

- 3 query MCP tools + 2 admin tools (`find`, `hot`, `related`, `backfill`, `stats`).
- Hotness formula: `Σ weight × exp(-age_days / 14)` with `read=1, edit=3, write=5`.
- Co-occurrence: 30-min sliding session window, dedup pairs per session.
- Per-workspace storage, keyed by sha1(workspace-root).
- Companion skill at `~/.claude/skills/code-index/`.
- Eval suite shape: unit (gates CI) + agent-loop (nightly) + replay harness.
- Privacy stance: paths + symbol names + counters only, never file contents.

---

## Corrected layout (target: grok-cli)

```
grok-cli/
  src/
    code-index/
      index.ts                  # public API: createIndexer(), getMcpServer()
      indexer.ts                # ported from lib/indexer.js (TS)
      storage.ts                # ported from lib/storage.js
      workspace.ts              # ported from lib/workspace.js
      parser.ts                 # tree-sitter wrapper (Phase 3 of plan)
      ranker.ts                 # Phase 4
      backfill.ts               # Phase 5
      mcp-server.ts             # stdio MCP server entrypoint exposing 3+2 tools
      hooks.ts                  # PostToolUse hook handler (registered with grok-cli's hook system)
      grammars/
        *.wasm                  # downloaded by scripts/fetch-grammars
      evals/
        unit/*.test.ts          # ported test bodies
        fixtures/               # ported sample-repos + transcripts
        agent-loop/             # uses `codesurf -p` instead of `claude -p`
        replay/
  docs/
    superpowers/
      specs/
        2026-05-03-code-index-design.md     # NEW — corrected for CLI
      plans/
        2026-05-03-code-index.md            # NEW — corrected for CLI

~/.claude/skills/code-index/                # companion skill, unchanged design
~/.codesurf/code-index/data/<workspace>/    # runtime data dir (or wherever
                                            #   grok-cli prefers; check its
                                            #   storage conventions)
```

## What the resuming session should do (in order)

1. **Read this doc.** All of it.
2. **Read `HANDOFF-2026-05-03-code-index.md`** for the existing-work snapshot.
3. **Confirm with user** they still want option 1 (salvage + relocate into `grok-cli/src/code-index/`) before doing anything destructive. Mention options 2 (native built-in tool in `src/tools/`) and 3 (standalone MCP package) for completeness.
4. **Open `grok-cli`** (`/Users/jkneen/Documents/GitHub/grok-cli/`).
5. **Read its conventions:**
   - `AGENTS.md`, `TOOLS.md`, `CHANGELOG.md`
   - `src/hooks/{config,executor,index,types}.ts` — hook system
   - `src/mcp/{catalog,runtime,validate}.ts` — MCP server runtime
   - `src/tools/*.ts` — built-in tool patterns
   - Existing `docs/superpowers/specs/` and `plans/` — house style
   - Test setup (`vitest.config.ts`)
6. **Write a corrected spec** at `grok-cli/docs/superpowers/specs/2026-05-03-code-index-design.md`. Reuse the design decisions table from the original spec. Replace the architecture section with the grok-cli-native one.
7. **Write a corrected plan** at `grok-cli/docs/superpowers/plans/2026-05-03-code-index.md`. Drop the desktop-specific tasks. Add tasks for: porting lib/* to TS, MCP server entrypoint, in-process hook handler, integration with grok-cli's MCP catalog.
8. **Get spec + plan approval** from the user before resuming code work.
9. **Port `lib/storage.js`, `lib/indexer.js`, `lib/workspace.js`** as the first three implementation tasks. The original tests transfer almost verbatim.
10. **Continue from there.**

## Salvage commands

When ready to copy the reusable lib over (do this AFTER the new spec + plan are approved):

```bash
# From this worktree:
cp /Users/jkneen/clawd/collaborator-clone-code-index/examples/extensions/code-index/lib/storage.js \
   /Users/jkneen/Documents/GitHub/grok-cli/src/code-index/storage.ts.draft

cp /Users/jkneen/clawd/collaborator-clone-code-index/examples/extensions/code-index/lib/indexer.js \
   /Users/jkneen/Documents/GitHub/grok-cli/src/code-index/indexer.ts.draft

cp /Users/jkneen/clawd/collaborator-clone-code-index/examples/extensions/code-index/lib/workspace.js \
   /Users/jkneen/Documents/GitHub/grok-cli/src/code-index/workspace.ts.draft

# Then port .js → .ts (mostly type annotations, CommonJS → ESM).
# Then port the test bodies from evals/unit/*.test.mjs into grok-cli's test setup.
```

## What to do with the desktop-extension worktree

Two options:

- **A. Leave it.** Branch `feat/code-index` stays as a record of the wrong-target attempt. No PR. Eventually delete the branch. The committed work stays available if anyone wants to reference the lib modules.
- **B. Revert.** `git push origin :feat/code-index` once the lib has been salvaged into grok-cli. Cleaner, loses the audit trail.

User decision when they get there. Default to **A** until told otherwise.

---

## TL;DR for the next session

> **Wrong target, wrong layer.** Code Index belongs in `grok-cli` (= the
> CodeSurf CLI/daemon), not in `collaborator-clone` (the Electron desktop
> shell). The desktop is dumb as shit — all logic lives in the daemon.
> Future state: grok-cli absorbs the daemon role, the desktop becomes a
> pure UI shell that consumes daemon interfaces.
>
> ~600 LOC of pure-Node modules (storage, indexer, workspace) salvages
> cleanly. The desktop-extension scaffolding (`extension.json`, tile UI,
> `ctx.bus`/`ctx.mcp` bridge wiring, localhost HTTP ingest) is throwaway —
> grok-cli's hooks run in-process so no HTTP server is needed.
>
> New spec + plan must be written in `grok-cli/docs/superpowers/` and
> approved before any code moves.
