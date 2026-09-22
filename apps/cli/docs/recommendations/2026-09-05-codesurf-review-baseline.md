# CodeSurf review baseline — 2026-09-05

Scope: CodeSurf, package `codesurf` 1.1.5, checkout HEAD `3383e20`.
Pre-existing dirty file: `.codesurf/DREAMING.md`; preserved.

## Validation observed

| Check | Result |
| --- | --- |
| `bun run typecheck` | Pass |
| `bun run build` | Pass |
| `bun run lint` | Pass; 566 files checked |
| `bun run test` | 1283 passed, 27 failed across 172 files |
| `bun run test:bun` | 22 passed, 2 failed |
| Bun suite with temporary `CODESURF_CONFIG_DIR` | 24 passed, 0 failed |
| Three affected Vitest files with temporary `CODESURF_CONFIG_DIR` | 30 passed, 0 failed |
| Full Vitest suite with temporary `CODESURF_CONFIG_DIR` | 1308 passed, 2 failed; 171 files passed, 1 failed |

The plain-suite failures are EPERM attempts to write outside this sandbox:
`subagent-contract.test.ts`, `user-interrupt.test.ts`, and `file-tools.test.ts`
write settings under the real `~/.codesurf` directory. All three pass with the
supported config override pointing at a fresh directory under `/private/tmp`.
The two Bun adaptive-routing failures also disappear with that override.
`npm-cache.test.ts` creates fixtures under `~/.grok/cache/lsp`, matching the
hardcoded production cache root. It requires explicit test isolation.
The isolated full-suite rerun confirms those two LSP tests are the only
remaining failures in this environment.

Logs for this run are under `/private/tmp/codesurf-review-*.log`; these are
temporary local evidence, not portable project artifacts. Passing typecheck,
build, lint, and unit tests does not establish live TUI rendering correctness.

## Requested execution models

The local Codex model catalog contains both `gpt-6-astra` and
`gpt-5.3-codex-spark`. Astra planning and independent source review were launched
with the available collaboration runtime.

The Spark probe using `codex exec --ephemeral --ignore-user-config` with
`-m gpt-5.3-codex-spark`, `workspace-write`, and approval policy `never` fails
before model execution: `failed to initialize in-process app-server client:
Operation not permitted (os error 1)`.

A separate `codex app-server` probe fails with `failed to initialize sqlite
state runtime under /Users/jkneen/.codex`. That directory is outside the writable
roots. This establishes a local runtime initialization blocker, not that Spark
is an invalid or unavailable model. No replacement model was used for product
implementation, and no sandbox permissions were broadened.

## Next execution gate

### Spark implementation started through collaboration

Direct `collaboration.spawn_agent` with `model: gpt-5.3-codex-spark` successfully
executed the file-edit fix, despite that identifier being absent from the tool's
advertised model list. The local CLI failure is not proof that this separate
execution path is unavailable.

Completed T2: `src/tools/file.ts` now performs literal substitution in execution
and preview, and explicitly rejects an empty search string. Two regressions in
`src/tools/file.test.ts` cover special-dollar text, UTF-8 bytes, preview parity,
and empty-search no-write behavior. Parent independently ran both the file suite
and the extension file-tools suite with `CODESURF_CONFIG_DIR` isolation: 24 tests
passed. Typecheck and build passed. The repository formatter was applied to the
Spark-authored test; full lint and `git diff --check` then passed.

Three subsequent Spark workers (Cordis foundation, Agent safety, UI races)
terminated with an explicit Spark usage limit and a service retry time of
5:39 AM (timezone not specified by the error). Worktree inspection confirmed
they left no product changes. No plugin has yet been converted; all remaining
implementation requires renewed Spark capacity or the owner's model choice.

Follow-up runtime probe: the documented `sqlite_home` and `log_dir` overrides
pointed at `/private/tmp/codesurf-spark-runtime` allow SQLite initialization and
backfill to complete (3,956 indexed threads). Afterward, the no-tool Spark
`codex exec` probe still exits with the same in-process app-server EPERM; a
separate app-server probe with these overrides also exits EPERM. The original
database-path problem is therefore only one startup obstacle. No model turn
executed. Configuration source: [official reference](https://developers.openai.com/codex/config-reference).

The initial [file coverage ledger](2026-09-05-codesurf-review-coverage.csv)
enumerates 596 source/test files without equating passing tests or a plugin
inventory with completed source review. Entries marked `coverage_not_established`
remain review work; targeted-path entries do not claim whole-file review.

Use the Astra migration plan alongside this baseline. Implementation must run
with the requested Spark model in a runtime that can initialize within its
authorized filesystem. The complete Cordis migration, defect repairs, package
partitioning, performance measurements, and interactive rendering validation
remain uncompleted; a plan or compatibility bridge does not satisfy them.

## Resumed implementation session — 2026-09-05 (Claude Code)

Environment differs from the Codex sandbox: the home directory is writable, so
every test run used `CODESURF_CONFIG_DIR` pointed at a session scratch
directory to keep the real `~/.codesurf` untouched. `npm-cache.test.ts` still
writes its fixtures under the real `~/.grok/cache/lsp` (the hardcoded cache
root noted above) and passes here; that isolation defect remains open.

| Check | Result |
| --- | --- |
| `bun run typecheck` | Pass |
| `bun run build` | Pass |
| `bun run lint` | Pass; 576 files checked |
| Full Vitest suite with `CODESURF_CONFIG_DIR` override | 1365 passed, 0 failed; 180 files |
| `bun run test:bun` | 24 passed, 0 failed |
| `git diff --check` | Clean |

Baseline before this session's edits in the same environment: 1312 Vitest
tests passing across 172 files. The 53 added tests cover the repairs recorded
in the per-report status lines and the plan's execution status section. No
commit was made.

## Fleet implementation session — 2026-09-05 (Claude Code, orchestrated)

The remaining review findings were implemented by two orchestrated fleets of
subagents working in file-disjoint clusters in this same checkout, each cluster
attacked afterwards by an adversarial verifier that re-ran its tests and tried
to refute it. Both fleets were cut short by the account's session limit; the
surviving blocking critiques and the clusters whose verifier died were repaired
and checked in the main loop. Every test run used the `CODESURF_CONFIG_DIR`
scratch override.

| Check | Result |
| --- | --- |
| `bun run typecheck` | Pass |
| `bun run build` | Pass |
| `bun run lint` | Pass; 608 files checked |
| Full Vitest suite with `CODESURF_CONFIG_DIR` override | 1,730 passed, 0 failed; 213 files |
| `bun run test:bun` | 30 passed, 0 failed |
| `packages/codesurf-daemon`: `node --test test/*.test.mjs` | 7 passed, 0 failed |
| `packages/codesurf-daemon`: `bun test test/client.test.ts` | 4 passed, 0 failed |
| `git diff --check` | Clean |
| Built CLI smoke (`bun dist/index.js --help`) | Renders usage |

Progression in this environment: 1,312 tests / 172 files at the campaign's
start, 1,365 / 180 after the first resumed session, 1,730 / 213 now — 365 tests
added by the fleets, plus the daemon package's first 11 tests (it had none).
The daemon package is not part of the root Vitest run; its two commands are
listed separately above. `npm-cache.test.ts` no longer writes to the real
`~/.grok/cache/lsp`: the cache root now resolves through the shared
config-directory helper, closing the isolation defect recorded above.

Verification is uneven and the plan's execution status section splits it into
three tiers: ten clusters were accepted by an independent adversarial verifier;
six were refuted on a named item, repaired, and then re-checked only in the
main loop; and four (daemon D1-D4, UI1/UI3, verification V1-V3, schedule
T12-T14) had no verifier at all and were self-verified by reading the diffs and
running the tests. Nothing was committed.

### Test-isolation observation found while validating

Running two full Vitest suites at once (used here to stress the added
concurrency tests) surfaces a pre-existing pattern unrelated to the campaign:
seven test files create a fixed fixture root and delete that whole root in
`afterEach`, so a second run of the same file removes the first run's
fixtures mid-test. `src/storage/prompt-history.test.ts` and
`src/storage/sessions.test.ts` broke this session's validation runs and now
delete only their own `mkdtemp` directories. The same pattern remains in
`src/storage/traces.test.ts`, `src/storage/transcript.test.ts`,
`src/agent/trace-collection.test.ts`, `src/agent/adaptive-routing.test.ts`,
`src/agent/learning/skill-optimizer.test.ts` and
`src/core/extensions/builtin/host-actions.test.ts`; it does not affect the
project's actual contract (one suite at a time), which passes 1,730/1,730 on
three consecutive runs.
