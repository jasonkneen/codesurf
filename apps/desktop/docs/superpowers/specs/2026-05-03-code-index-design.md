# Code Index — Design Spec

**Date:** 2026-05-03
**Author:** jkneen + Claude (brainstorm)
**Status:** Approved, ready for implementation plan

## Problem

When Claude Code works in a repo over many sessions, the conversation history accumulates a record of which files have been read and edited. That record is currently invisible to future turns — every "find me X" starts from scratch with `Grep`, even when the agent (or a previous session) edited the exact file holding `X` an hour ago.

We can do better by maintaining a small, fast, persistent index of *what's been touched and where the symbols live*, driven by the same tool-use events that already happen. The agent then locates known symbols in O(lookup) instead of O(repo grep), and the human gets a window into "what is this session actually working on."

## Goal

A drop-in CodeSurf extension that:

1. Watches Claude Code's tool-use activity per workspace.
2. Builds an incremental, on-disk index of touched files + their top-level symbols.
3. Exposes MCP tools the agent calls to find symbols, see hot files, and discover related files.
4. Surfaces the index in a single read-only dashboard tile.
5. Has measurable evals proving it actually saves the agent work vs. plain grep.

## Non-Goals (YAGNI)

- Full-codebase indexing (we only index files that have been touched — that's the point).
- Storing file contents or diffs.
- Replacing Grep / ripgrep for cold search. The skill explicitly tells the agent to fall back to Grep on a miss.
- Multi-machine sync. Index is per-machine, per-workspace.
- A second tile, a graph viz, a settings UI. One tile, three sections.
- SQLite, vector embeddings, semantic search.

## Hard Constraints

- **Cross-platform.** macOS, Windows, Linux all from the same code path. No native deps (rules out `better-sqlite3` and similar). Tree-sitter via WASM only.
- **Self-contained extension.** No edits to CodeSurf host source. All code lives under `examples/extensions/code-index/` and installs to `~/.codesurf/extensions/code-index/`.
- **Privacy.** Index stores file paths, language, symbol names with line numbers, and activity counters. Never file contents.
- **Cost-bounded.** WASM bundle ≤ 15MB total. Hook overhead ≤ 10ms p99 per tool call. Index disk write debounced 5s, atomic.
- **No emoji in tile UI** (per CodeSurf extension rules).

## Decisions Locked During Brainstorm

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | What does the index store? | Activity + symbol map (not content snippets) | Honors "no code storage" intent; symbol-level locator is enough to save grep cost |
| 2 | Data source | Hybrid: PostToolUse hooks + admin backfill from transcripts | Hooks give live capture; backfill seeds existing projects |
| 3 | MCP surface | Three query tools (`find`, `hot`, `related`) + two admin tools (`backfill`, `stats`) | Maps to three distinct cognitive moves; minimises agent mis-routing |
| 4 | Symbol extraction | Tree-sitter via `web-tree-sitter` (WASM) | Only zero-install cross-platform option; mature; accurate |
| 5 | Eval shape | Layered: unit (CI gate) + agent-loop (nightly) + replay harness (utility) | Unit alone proves code runs; agent-loop is the only honest measure of value |
| 6 | UI | Single observability tile (search + hot + recent) | Keeps the system inspectable without scope creep |

## Architecture

### Data flow

```
Claude Code session
    │
    ├─ PostToolUse hook (Read|Edit|Write|MultiEdit)
    │     │
    │     ▼
    │   POST {cwd, tool, path, ts} → http://127.0.0.1:<port>/ingest
    │
    └─ MCP tools registered by extension main.js

Extension main.js (CodeSurf power tier)
    │
    ├─ HTTP ingest server (localhost only, ephemeral port written to disk)
    │
    ├─ Indexer
    │     ├─ cwd → workspace root (walk up for .git; fallback to cwd; env override)
    │     ├─ Increment counters; update timestamps
    │     ├─ On Edit/Write: re-parse file (debounced 500ms per path)
    │     ├─ Update co-occurrence graph (30-min sliding session window)
    │     └─ Debounced disk write (5s after last mutation, atomic temp+rename)
    │
    ├─ Tree-sitter WASM (web-tree-sitter + bundled grammars)
    │     └─ ts, tsx, js, jsx, py, go, rs, md (starter set)
    │
    └─ Bus publishes "code-index" channel events for the tile
```

### Components (file → purpose)

| File | Purpose |
|------|---------|
| `main.js` | Extension entry. Wires hook server, MCP tools, bus publishing, returns cleanup fn |
| `lib/indexer.js` | Core index ops: ingest event, update counters, hotness, co-occurrence. Pure logic — no Electron deps so evals can import it |
| `lib/parser.js` | Tree-sitter wrapper, language detection by extension, symbol extraction |
| `lib/ranker.js` | Hotness computation, query result ranking (exact > prefix > substring) |
| `lib/storage.js` | Atomic JSON write, JSONL append, log rotation at 10MB |
| `lib/workspace.js` | `cwd → workspace root` resolution (`.git` walk + env override + fallback) |
| `tiles/dashboard/index.html` | Single tile: search box + hot files + recent activity |
| `hook/INSTALL.md` | Per-platform copy-paste hook snippets (macOS/Linux bash, Windows PowerShell), troubleshooting. No script file ships — the hook is a one-liner inlined into `settings.json` so it stays portable. |
| `grammars/*.wasm` | Bundled tree-sitter grammars |

## Storage

### Layout

```
~/.codesurf/extensions/code-index/data/
  port                                # ephemeral port for the ingest server
  <sha1(workspace-root)>/
    index.json                        # main index (atomic write)
    activity.jsonl                    # append-only event log (rotated at 10MB)
    meta.json                         # workspace path, version, created_at, last_compacted
```

### `index.json` schema

```json
{
  "version": 1,
  "workspace": "/Users/jkneen/Documents/GitHub/cursorbuddy",
  "files": {
    "src/lib/bezier-flight.ts": {
      "reads": 12,
      "edits": 5,
      "writes": 1,
      "lastTouched": 1730568000,
      "hotness": 47.3,
      "language": "typescript",
      "size": 4821,
      "symbols": [
        {"name": "smoothstep", "kind": "function", "line": 14},
        {"name": "BezierFlight", "kind": "class", "line": 32},
        {"name": "computeArc", "kind": "method", "line": 51}
      ],
      "parseError": null
    }
  },
  "cooccurrence": {
    "src/lib/bezier-flight.ts": {
      "src/stores/cursor-store.ts": 8,
      "src/hooks/use-buddy-navigation.ts": 6
    }
  }
}
```

### Hotness formula

```
hotness(file) = Σ event_weight × exp(-age_days / 14)

event_weight: read=1, edit=3, write=5
half-life:    14 days
```

Recomputed lazily on query, not on every event.

### Co-occurrence

For each pair of files touched within the same 30-minute session window, increment `cooccurrence[A][B]` and `cooccurrence[B][A]` once per session. Decayed identically to hotness.

## MCP Tool Surface

### Query tools (in the agent's daily loop, taught by the skill)

```ts
code_index_find({
  name: string,
  kind?: "function" | "class" | "method" | "component" | "export" | "any",
  limit?: number  // default 10
})
→ { results: [{file, line, kind, name, hotness, lastTouched}], totalMatched, queryMs }

code_index_hot({
  path?: string,    // omit = top files; provide = top symbols in that file
  limit?: number    // default 20
})
→ when omitted: { files: [{path, hotness, reads, edits, writes, lastTouched, topSymbols}] }
  when provided: { symbols: [{name, kind, line}], stats: {reads, edits, writes, hotness} }

code_index_related({
  path: string,
  limit?: number  // default 10
})
→ { related: [{path, coOccurrenceCount, hotness}], basedOn: "co-touched within 30-min sessions" }
```

### Admin tools (documented but not in the daily-trigger table)

```ts
code_index_backfill({
  transcriptPath?: string  // default: auto-detect ~/.claude/projects/<hash>/
})
→ { scanned, ingested, parseErrors, durationMs }

code_index_stats()
→ { workspace, indexedFiles, totalSymbols, totalEvents, indexSizeKb,
    topLanguages, oldestEvent, newestEvent }
```

### Ranking rules

- `find`: exact name match → prefix match → substring match. Within each tier: hotness desc, then recency desc.
- `hot` (no path): hotness desc.
- `hot` (path): symbol order is source-order (line asc).
- `related`: co-occurrence desc, then hotness desc.

## Companion Skill

Path: `~/.claude/skills/code-index/SKILL.md`

### Frontmatter

```yaml
---
name: code-index
description: Use when locating symbols, functions, or files you (or a recent session) have touched before. Faster than grep for "where is X defined" and "what files relate to Y" in active workspaces.
---
```

### Body — what the skill teaches

Three triggers + one anti-pattern + a maintenance section.

| Trigger | Tool | Example |
|---------|------|---------|
| "Where is X defined?" / "find the function that…" | `code_index_find(name)` **before** Grep | "update the bezier easing" → `code_index_find("ease")` |
| "What did we touch last?" / orientation | `code_index_hot()` | Resuming a session |
| About to edit a file → check related | `code_index_related(path)` | Before editing `cursor-store.ts` |

**Anti-pattern (explicit in skill):** Don't call `code_index_find` for symbols in files you've never opened in this workspace — the index only knows what's been touched. On 0 results, fall back to Grep, do not retry.

**Maintenance section:** documents `code_index_backfill` and `code_index_stats` for one-time setup and health checks.

References folder: `~/.claude/skills/code-index/references/mcp-tools.md` with full tool reference (parameter schemas, response shapes, error codes).

## Tile UI

Single tile, 400×500 default, three collapsible sections:

```
┌─ Code Index ────────────────────────── 400×500 ─┐
│ workspace: cursorbuddy        [⟳ refresh]      │
│                                                 │
│ ┌─ Search ────────────────────────────────────┐ │
│ │ [ smoothstep                              ] │ │
│ │   src/lib/bezier-flight.ts:14 · function   │ │
│ │   src/components/BlueCursorTriangle.tsx:42 │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ┌─ Hot files ─────────────────────────── ▼ ──┐ │
│ │ 47.3  src/lib/bezier-flight.ts   12r 5e 1w │ │
│ │ 31.0  src/stores/cursor-store.ts  8r 2e    │ │
│ │ ...                                         │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ┌─ Recent activity ──────────────────── ▼ ──┐  │
│ │ 14:02  Edit  src/lib/bezier-flight.ts     │  │
│ │ 14:01  Read  src/stores/cursor-store.ts   │  │
│ │ ...                                         │ │
│ └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Behavior

- **Search box:** runs the same `code_index_find` call the agent uses. Live filter, debounced 150ms. Click result → emit `ctx:open-file` on the bus for other tiles to consume.
- **Hot / Recent sections:** collapsible (standard CodeSurf section-collapse pattern).
- **Live updates:** subscribes to bus channel `code-index`. On `activity` events, prepend to recent list and bump hot.
- **Health banner:** if zero ingest events in last 24h, show "Hook not detected — see hook/INSTALL.md".
- **Read-only.** No mutations from the tile. The indexer is hook-driven.

## Eval Suite

Three layers, layered per Decision 5:

### Layer 1 — Unit (gates CI, runs in <5s)

```
evals/unit/
  parsing.test.ts        # tree-sitter extracts right symbols at right lines
  indexer.test.ts        # counters, hotness decay, co-occurrence math
  ranking.test.ts        # exact > prefix > substring; tiebreak by hotness
  backfill.test.ts       # canned transcript → expected index state
  hook-server.test.ts    # POST /ingest happy path + malformed payloads
evals/fixtures/
  sample-repos/{ts-react, py-flask, go-cli}/
  transcripts/cursorbuddy-7days.jsonl
```

Runs on every commit. Failure blocks merge.

### Layer 2 — Agent-loop (nightly + on-demand, 5–10 scenarios)

```
evals/agent-loop/
  runner.ts              # spawns `claude -p` in fixture workspace
  scenarios/
    001-find-by-name.yaml
    002-related-files.yaml
    003-resume-session.yaml
    ...
  scoreboard.md          # auto-updated, committed, trend over time
```

Scenario format:

```yaml
id: 001-find-by-name
description: "Modify smoothstep — should find via index, not grep"
fixture_repo: ts-react
seed_transcript: transcripts/ts-react-3-prior-edits.jsonl
prompt: "Change the smoothstep curve to use cubic ease-in-out"
budget:
  max_tool_calls: 15
  max_tokens: 8000
success:
  must_edit: ["src/lib/easing.ts"]
  must_call_first: "code_index_find"
baseline:
  expected_extra_grep_calls: 2
```

**Token budget guard:** runaway agents fail with `RUNAWAY_AGENT`, the run continues. No single scenario can burn the whole budget.

### Layer 3 — Replay harness (utility CLI)

```
evals/replay/
  replay.ts              # CLI: replay <transcript-path> → simulated index state
  report.ts              # "would the index have helped at turn N?"
```

Reuses the indexer module. Lets us validate against real `~/.claude/projects/` history without manufacturing scenarios.

## Repo Layout

```
examples/extensions/code-index/
  extension.json
  main.js
  lib/
    indexer.js
    parser.js
    ranker.js
    storage.js
    workspace.js
  grammars/
    tree-sitter-typescript.wasm
    tree-sitter-tsx.wasm
    tree-sitter-javascript.wasm
    tree-sitter-python.wasm
    tree-sitter-go.wasm
    tree-sitter-rust.wasm
    tree-sitter-markdown.wasm
  tiles/
    dashboard/
      index.html
  hook/
    INSTALL.md           # macOS/Linux + Windows PowerShell hook snippets
  evals/                 # full eval suite
  package.json           # deps: web-tree-sitter only
  README.md
  CLAUDE.md              # for future agents working on this extension
```

Companion skill installed separately at `~/.claude/skills/code-index/`.

## Implementation Phasing (high level — `writing-plans` will detail)

1. **Foundation:** manifest, main.js skeleton, ingest HTTP server, JSON storage with atomic write, workspace resolution.
2. **Indexer core:** counters, hotness, co-occurrence, debounced disk write. Unit tests for ranker + indexer.
3. **Parser:** tree-sitter WASM wrapper, language detection, starter grammar set, symbol extraction. Unit tests for parsing fixture repos.
4. **MCP tools:** `find`, `hot`, `related`, `stats`. Wire to indexer. Unit tests against fixture index.
5. **Backfill:** transcript scanner, replay into indexer. Unit test against canned transcript.
6. **Hook integration:** `code-index-hook.sh`, `INSTALL.md`, health banner logic.
7. **Tile:** dashboard HTML, bus subscription, search/hot/recent sections.
8. **Companion skill:** `SKILL.md` + `references/mcp-tools.md`.
9. **Eval suite:** unit tests harness, agent-loop runner, fixture repos, scenario YAMLs, replay CLI, scoreboard generation.
10. **Docs:** `README.md`, `CLAUDE.md` for the extension, install instructions.

Each phase ships independently testable; phases 1–4 are the critical path; 5–8 layer on; 9–10 ship before declaring done.

## Risks & Open Questions

| Risk | Mitigation |
|------|------------|
| Hook setup is manual JSON paste | Provide copy-paste snippet in `hook/INSTALL.md`. Tile shows "Hook not detected" banner after 24h silence. |
| Workspace resolution edge case in monorepos | Git root wins by default. `CODE_INDEX_WORKSPACE_ROOT` env var overrides. Documented. |
| Parser failures must not break ingest | Catch tree-sitter errors per file; store `parseError` on record; counters still increment. Eval covers. |
| Concurrent writes from multiple Claude sessions | Serialize writes inside the indexer; debounce + atomic disk write; no data loss, ~5s lag worst case. |
| Privacy — what does the index leak? | File paths + symbol names + counters only. Never contents. Documented in README. |
| Bundle size (~10MB for WASM grammars) | Acceptable for dev tool; documented in README. |
| Skill discoverability | If agent doesn't reach for it, agent-loop evals will show "would-have-helped but wasn't called." Iterate on skill description after first eval run. |
| Backfill cost on long histories | Opt-in admin tool. Default cap: 90 days. `--all` override. Reports progress. |

## Out of Scope (explicitly)

- Cold-search across the whole repo (use Grep).
- File content storage, diff history, blame.
- Multi-machine sync, cloud index.
- Vector embeddings, semantic search.
- More than one tile.
- Settings UI (use CodeSurf settings contract if needed).
- Auto-installing the hook into settings.json (security boundary — user installs manually).

## Acceptance

This spec is approved when:

- All Layer 1 unit tests pass.
- At least 3 Layer 2 agent-loop scenarios pass with measurable improvement vs. baseline.
- Replay harness runs cleanly against a real transcript.
- Hook install instructions are verified end-to-end on macOS (Windows + Linux smoke-tested).
- README + CLAUDE.md committed; skill installed and triggers correctly in a manual test.
