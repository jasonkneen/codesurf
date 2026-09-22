# Code Index — Implementation Handoff

## STOP — WRONG TARGET. SEE PIVOT.md FIRST.

This work was started in the wrong repo. The corrected target is the **CodeSurf
CLI** at `/Users/jkneen/Documents/GitHub/grok-cli/`, not the CodeSurf desktop
app (`collaborator-clone`).

**Read `PIVOT-2026-05-03-code-index.md` (same directory) before doing
anything else.** It explains:
- Why the target is wrong
- The long-term architecture (grok-cli will absorb the desktop daemon)
- What survives the pivot (~600 LOC of platform-agnostic Node modules)
- What dies (tiles, manifest, bridge wiring)
- The corrected `grok-cli/src/code-index/` layout
- The order of operations for the resuming session

Everything below this banner describes the wrong-target work that was done
before the pivot. It is preserved as a reference for what code can be
salvaged, NOT as instructions for what to build next.

---

## Original (wrong-target) handoff

### This was a CodeSurf desktop extension

Concretely:

- **All source code lives under one directory:**
  `examples/extensions/code-index/`
- **The host loads it from a runtime directory:**
  `~/.codesurf/extensions/code-index/` (we copy there as the install step)
- **The host's source (`src/`, root `package.json`, `electron.vite.config.ts`,
  any other `examples/extensions/<other>/`) is OFF-LIMITS.** Touching it will
  break the host for everyone.
- **The extension's own `package.json` and deps are isolated** — the host has
  its own dep tree, ours has another. They do not share node_modules.
- **The extension talks to the host via a documented bridge** (`ctx.mcp`,
  `ctx.bus`, `ctx.ipc`, etc.) — we do not import host modules, ever.
- **The "extension dev workspace" rules** are formally documented at
  `examples/extensions/CLAUDE.md` in this same worktree. Re-read it if in
  doubt.

If a task description ever appears to require touching host code, **stop and
escalate.** It almost certainly means the task should be solved inside the
extension via the bridge, or the plan is wrong.

---

**Date paused:** 2026-05-03
**Worktree:** `/Users/jkneen/clawd/collaborator-clone-code-index/` — this is a
git **worktree of the codesurf-host repo** (`collaborator-clone`), used purely
as the dev environment for this extension. The worktree directory name
includes `code-index` only because that's the feature branch — it is **not**
a standalone repo for the extension.
**Branch:** `feat/code-index` (off `main` of `collaborator-clone`)
**Last commit:** `0200d1e` — indexer core
**Tests:** 27/27 passing across 4 unit suites
**Spec:** `docs/superpowers/specs/2026-05-03-code-index-design.md`
**Plan:** `docs/superpowers/plans/2026-05-03-code-index.md` (18 implementation tasks, single source of truth)

---

## What's done (5 of 18 tasks)

| # | Task | Commit | Tests | Files |
|---|------|--------|-------|-------|
| 1.1 | Scaffold manifest + package | `2c42ecc` | n/a | `extension.json`, `package.json`, `.gitignore`, `package-lock.json` |
| 1.2 | Storage (atomic JSON + JSONL) | `6e62927` + `f43f691` | 6/6 | `lib/storage.js`, `evals/unit/storage.test.mjs`, `vitest.config.mjs` |
| 1.3 | Workspace resolution | `75e7ca1` | 5/5 | `lib/workspace.js`, `evals/unit/workspace.test.mjs` |
| 1.4 | HTTP ingest server | `32d9614` | 6/6 | `lib/ingest-server.js`, `evals/unit/ingest-server.test.mjs` |
| 2.1 | Indexer core (counters + hotness + co-occurrence) | `0200d1e` | 10/10 | `lib/indexer.js`, `evals/unit/indexer.test.mjs` |

**Cumulative:** 27/27 unit tests pass via `npm test` (in `examples/extensions/code-index/`).

### Deviations from the plan (committed, intentional)

1. **Added `vitest.config.mjs`** scoped to the extension. Without it, vitest walks up and tries to load the host repo's `postcss.config.js` (which references `@tailwindcss/postcss` — not a transitive dep here). The config sets `css: false` and disables postcss discovery. Captured in commit `6e62927` and the package.json `test` script (`f43f691`) was updated to pass `--config vitest.config.mjs` so `npm test` works without per-invocation flags.

2. **No other deviations.** All other modules match the plan byte-for-byte.

### Forward-looking concerns flagged during reviews

- **Task 4.2 (main.js wiring) — `actions` vs `mcpTools` distinction.** The CodeSurf manifest's `contributes.actions` block declares tile-callable commands. MCP tools the AI agent invokes must be registered programmatically via `ctx.mcp.registerTool` in `main.js`. The plan handles this correctly (Task 4.2 shows explicit `ctx.mcp.registerTool` calls), but when dispatching the implementer subagent for Task 4.2, **explicitly tell them**: "the manifest's `actions` block does NOT register MCP tools — those must be registered in main.js via `ctx.mcp.registerTool`."

- **`web-tree-sitter@^0.22.6`** is one major version behind current (0.25.x). Pinned intentionally for API stability; if Phase 3 hits grammar-loading issues, upgrade is non-trivial.

---

## What's left (13 tasks)

Each task is fully specified in `docs/superpowers/plans/2026-05-03-code-index.md`. Below is the execution mode chosen during brainstorm: **inline** (controller executes directly) vs **subagent** (controller dispatches general-purpose subagent + reviews).

| # | Task | Mode | Notes |
|---|------|------|-------|
| 3.1 | Language detection | inline | Trivial map lookup, 13 tests |
| 3.2 | Fetch tree-sitter WASM grammars | inline | Runs `scripts/fetch-grammars.mjs` against jsdelivr CDN; needs network |
| 3.3 | Symbol extraction with tree-sitter | **subagent** | Per-language judgment on which AST nodes count as symbols; 8 tests; will likely need 1-2 iterations on the variable_declarator query |
| 4.1 | Ranker module | inline | Pure functions, 8 tests |
| 4.2 | Wire `main.js` + 4 MCP tools | **subagent** | Multi-file integration. **Brief implementer on actions-vs-mcpTools.** |
| 5.1 | Backfill from transcripts + MCP tool | inline | File I/O + replay; 3 tests + main.js modification |
| 6.1 | `hook/INSTALL.md` | inline | Docs only — macOS/Linux + Windows PowerShell hook snippets |
| 7.1 | Dashboard tile | **subagent** | UI judgment; ~330 lines HTML/CSS/JS; theme var integration; bus subscription |
| 8.1 | Companion skill + install script | inline | `~/.claude/skills/code-index/SKILL.md` + references + install.sh |
| 9.1 | Agent-loop runner + 3 scenarios | **subagent** | Subprocess spawning of `claude -p`, YAML parsing, scoreboard generation |
| 9.2 | Replay CLI | inline | Wraps existing modules |
| 10.1 | README + extension `CLAUDE.md` | inline | Docs only |
| 10.2 | Install + e2e verification | **subagent** | Runs install commands, verifies tile renders, MCP tools respond, agent-loop scenarios run |

**Final step:** dispatch superpowers:code-reviewer for the entire branch, then invoke `superpowers:finishing-a-development-branch`.

---

## How to resume

In a fresh session:

1. Read this handoff doc.
2. Read the spec: `docs/superpowers/specs/2026-05-03-code-index-design.md`
3. Read the plan: `docs/superpowers/plans/2026-05-03-code-index.md`
4. `cd /Users/jkneen/clawd/collaborator-clone-code-index/`
5. Verify: `cd examples/extensions/code-index && npm test` should report **27/27 passing**.
6. Pick up at **Task 3.1** (Language detection — inline).

### TodoWrite seed for resume

```
- Task 3.1: Language detection [in_progress]
- Task 3.2: Fetch tree-sitter WASM grammars [pending]
- Task 3.3: Symbol extraction with tree-sitter (subagent) [pending]
- Task 4.1: Ranker module [pending]
- Task 4.2: Wire main.js + 4 MCP tools (subagent, watch actions vs mcpTools) [pending]
- Task 5.1: Backfill scanner + MCP tool [pending]
- Task 6.1: Hook INSTALL.md [pending]
- Task 7.1: Dashboard tile (subagent) [pending]
- Task 8.1: Companion skill + install script [pending]
- Task 9.1: Agent-loop runner + 3 scenarios (subagent) [pending]
- Task 9.2: Replay CLI [pending]
- Task 10.1: README + CLAUDE.md [pending]
- Task 10.2: Install + e2e verification (subagent) [pending]
- Final code review + finishing-a-development-branch [pending]
```

---

## Hard rules to carry forward

These come from the user's CLAUDE.md and the codesurf-extension skill:

1. **This is a CodeSurf extension.** See the "READ THIS FIRST" section at the
   top of this doc. All code lives in `examples/extensions/code-index/`.
   The host (`src/`, root configs, other extensions) is off-limits. The
   extension communicates with the host only via the documented bridge.
2. **Cross-platform always.** No native deps. Tree-sitter via WASM only. Hook
   snippets must work on macOS, Linux, Windows (PowerShell).
3. **Privacy.** File paths, symbol names, line numbers, counters only. Never
   file contents.
4. **TDD.** Each task has a failing-test step before implementation. Skip at
   your peril.
5. **Frequent commits.** One logical change per commit. Use the commit
   messages from the plan.
6. **No emoji** in tile UI or anywhere else unless the user explicitly asks.
7. **No `prefers-color-scheme`** in tile CSS. Dark mode comes from `--ct-*`
   vars injected by the host.
8. **One in_progress task at a time** in TodoWrite.
9. **Two deliverable surfaces beyond the extension:** the companion Claude
   skill (installs to `~/.claude/skills/code-index/`) and the eval suite
   (lives inside the extension dir at `examples/extensions/code-index/evals/`).
   Both are part of "ship" — the extension alone is not done.

---

## Key file locations (absolute paths)

- Worktree root: `/Users/jkneen/clawd/collaborator-clone-code-index/`
- Extension source: `/Users/jkneen/clawd/collaborator-clone-code-index/examples/extensions/code-index/`
- Spec: `/Users/jkneen/clawd/collaborator-clone-code-index/docs/superpowers/specs/2026-05-03-code-index-design.md`
- Plan: `/Users/jkneen/clawd/collaborator-clone-code-index/docs/superpowers/plans/2026-05-03-code-index.md`
- This doc: `/Users/jkneen/clawd/collaborator-clone-code-index/docs/superpowers/HANDOFF-2026-05-03-code-index.md`
- Future install target: `~/.codesurf/extensions/code-index/`
- Future skill target: `~/.claude/skills/code-index/`
- Reference extension dev guide: `/Users/jkneen/clawd/collaborator-clone-code-index/examples/extensions/CLAUDE.md`
