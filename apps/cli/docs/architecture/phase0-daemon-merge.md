# Phase 0 — @codesurf/daemon consolidation (merge plan & record)

**Branch:** `phase0/daemon-consolidation` · **Status:** canonical merged + validated in grok-cli AND collaborator dev-path rewired (2026-09-07); collaborator release-era tests/scripts conversion next round
Architecture context: `docs/architecture/v0.md` §11 (canonical home = grok-cli) and §1 (anti-duplication law).

## Evidence (measured 2026-09-03)

| | grok-cli copy (before) | collaborator-clone copy |
|---|---|---|
| version | `@codesurf/daemon@0.1.0` | `@codesurf/daemon@0.1.0` |
| packaging | source-direct (`main` → `src/index.js` barrel importing `*.ts`) | dist build (`main` → `dist/index.js`, `types` → `dist/index.d.ts`) |
| src modules | 10 (incl obsolete `src/index.js` barrel) | 21 (superset: chat-policy, context-budget/composer, peer-context/authority/serialization, node-tools, package-layout, process-tree, prompt-conventions, secure-file-reader) |
| bins | 18 | 27 (superset) |
| tests | 4 files | 42 files + dist-contract/package-contract/isolation checks |
| engines | node >=18 | node >=22.12 |
| identical files | `paths.ts`, `chat-session-store.ts` byte-identical | same |

**Export compatibility gate (PASS):** grok-cli consumers import only the package root and `./package.json`:
`src/daemon/codesurf-daemon.ts` (`createDaemonClient|Manager`, `DAEMON_PACKAGE_VERSION`, `defaultCodesurfHome`, `resolveDaemonScriptFromCandidates`, types) and `defaultCodesurfHome` in `src/storage/db.ts`, `agent/learning/skill-overlay.ts`, `self-learning.ts`. All names exist in the collab export surface (which is a superset).

## Decision

Canonical base = **collab's tree** (superset + build/contract/test infra), rehomed to `grok-cli/packages/codesurf-daemon`, because:
1. collab is a strict file superset (bins, modules, tests) with identical shared lineage files;
2. it carries the dist pipeline + isolation/dist-contract/package-contract checks + 42 tests;
3. peer-context/peer-authority machinery is federation-shaped and belongs in the ENGINE (v0 §11).

Import performed: byte-perfect copy of collab tree (excl `dist`, `node_modules`, `.tmp`, `package-lock.json`); obsolete grok `src/index.js` barrel deleted; grok's 4 extra test files (`chat-jobs.test.mjs`, `client.test.ts`, `harness.mjs`, `test/tsconfig.json`) retained pending validation.

## Review checklist — shared files that differ (no grok-only behaviour may be lost)

- `src/client.ts` (~1060 changed) — larger collab client (chat-jobs, bounds). Review grok diff hunks for grok-only features.
- `src/manager.ts` (~276) — daemon lifecycle. Same review.
- `src/sse.ts` — grok had a minimal 874 B parser; collab is the full implementation. API-compatible superset.
- `src/chat-cli.ts`, `src/index.ts`, `src/types.ts`, `src/persona-model-binding.ts`, `bin/*` — collab versions newer; verify no grok-only export/feature is dropped (compare against `git show HEAD:packages/codesurf-daemon/...`).

## Gates (in order)

1. `bun install` at repo root succeeds (workspace resolves new deps: `@ai-sdk/gateway@4.0.60`, `ai@7.0.74`, harness stable, claude-agent-sdk 0.2.141, better-sqlite3 12.8).
2. `node scripts/build-dist.mjs` (pkg) emits `dist/`.
3. pkg `npm test` (check-isolation → typecheck → verify:dist → test:unit) green.
4. grok-cli root typecheck green (`tsc -b packages/plugin-api packages/runtime && tsc --noEmit`) — consumers compile against new package.
5. Daemon smoke: `bin/codesurfd.mjs --help` / daemon start through `src/daemon` adapter.


## Lineage resolution (added 2026-09-07)

Git history shows the true relationship:

- **collaborator-clone daemon package = the actively maintained lineage**: unbroken commits 2026-07-31 → 2026-09-06 (self-contained packaging 08-12, exports freeze 08-11, review fixes M1/M8 on 09-05, "job starts idempotent + terminalize queue (D1, D3)" on 09-06).
- **grok-cli daemon package = June vendor + one fix commit**: `918f194` (2026-09-05) "land every 2026-09-05 review finding with regression tests" touched `bin/chat-jobs.mjs` (+150), `src/client.ts` (+17) and added 4 test files (701 insertions total).

**No-loss check (marker evidence):** the collab tree independently implements the same review fixes — `src/client.ts` contains `startRequestId` ×5, retry logic ×10, "unknown outcome" handling (D1 idempotent job start); `chat-cli.ts` contains stale-context + permission-stall handling (M1/M8); 09-06 commit terminalizes the queue on shutdown (D1/D3). Grok's 4 regression-test files (`chat-jobs.test.mjs` D1–D4, `client.test.ts` D1) are **superseded** by collab's suite: `chat-jobs-idempotent-start`, `chat-jobs-process-termination`, `chat-jobs-loop-hardening`, `chat-jobs-snapshot-dedup`, `daemon-client-chat-jobs`, etc.

**Decision:** canonical = collab tree as imported; grok's 4 hybrid test files (`harness.mjs` imports `vitest` undeclared → isolation violation) removed with justification above. grok's `src/index.js` barrel deleted (obsolete; dist-based packaging adopted). Export-surface regression: none (55→74 root exports; per-module no losses; grok-cli imports root + `./package.json` only).

## Follow-on (next rounds)

- Resolve review-checklist diffs explicitly (document any grok-only hunks re-applied).
- Decide fate of grok's 4 kept test files (update vs remove vs port into suite).
- Rewire `collaborator-clone`: delete its `packages/codesurf-daemon`; depend on canonical via `file:` (owner decision 2026-09-07: **no npm publish**; cross-machine distribution mechanism deferred — see decision log). Verify IDE builds/tests.
- Decide `dist` policy in grok-cli (currently `dist/` + `packages/*/dist` gitignored → build before use; consider a root `predev`/watch convenience).
- Note: pkg engines `>=22.12` vs grok-cli root `>=18` — grok-cli daemon path already requires modern node (verified 22.18); align root engines.

## Gate results (2026-09-07)

1. `bun install` (root workspace) — ✅ (21 new packages; `bun.lock` committed `263ee5c`).
2. `node scripts/build-dist.mjs` — ✅ dist emitted for all 21 modules.
3. pkg suite — ✅ **318/318 pass** (check-isolation, typecheck, verify:dist, unit). npm required on PATH (nvm node bin); standalone `package-lock.json` (byte-matched collab manifest) committed to satisfy package-contract tests.
4. grok-cli root typecheck — ✅ exit 0.
5. Smoke — ✅ node import of `@codesurf/daemon` root exposes full superset incl policy/persona exports; daemon boot covered by package-smoke test (`clean tarball consumer ... boots native-backed codesurfd`).

**Commits on `phase0/daemon-consolidation`:** `b7919b8` (canonical merge, 102 files, +32k/−4k; lint-staged/biome applied) · `263ee5c` (lockfile).
**Remaining:** (a) collaborator-clone rewiring — delete its vendored `packages/codesurf-daemon`, consume canonical (dev: `file:` to grok-cli; **no npm publish** — owner decision); (b) cross-repo verification + collaborator commit; (c) note: biome reformat of imported tree may require a dist rebuild before further packs (dist is gitignored; rebuild is one command).

## Collaborator rewiring — round 2 progress (2026-09-07, branch `phase0/daemon-consolidation` in collaborator-clone)

Done and verified:
- Vendored `packages/codesurf-daemon` (145 files) deleted from collaborator-clone.
- dep `"@codesurf/daemon": "file:../../Documents/GitHub/grok-cli/packages/codesurf-daemon"` (**no registry publish** — owner decision 2026-09-07; stays a `file:` dependency on the dev machine); `package-lock.json` relinked (stale embedded entry removed).
- tsconfig/tsconfig.tsgo daemon path mappings removed; `bin/codesurfd.mjs` launcher now resolves the canonical bin; `electrobun.config.ts` sources daemon files from the canonical dir (destination layout preserved); `scripts/check-daemon-canonical.mjs` added (wired into `prepack` + `test:packages`); `e2e/helpers/launch-electron.ts` imports `@codesurf/daemon/manager`.
- Tests converted to canonical resolution and passing: `dependency-authority` (2/2), `build-npm-package-manifest` (1/1), `agent-cli-contracts` (22/22), `host-stable-context-load` (3/3).
- **collaborator app typecheck (`tsc -p tsconfig.json --noEmit`) = exit 0** against canonical dist types.

Remaining (next round): convert/relocate IDE daemon-bin test layer (`test/daemon/*` + `test/electron-multimodal-runtime` + `test/chat-process-lifecycle`, which import `packages/codesurf-daemon/bin/*` relative paths) and `scripts/check-daemon-boundaries.mjs`/`before-build.js`; run broader IDE core suite; commit collaborator branch; final cross-verify + docs.
