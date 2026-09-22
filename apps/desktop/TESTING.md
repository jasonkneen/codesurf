# Testing Guide

How to run the CodeSurf test tiers, read coverage, and avoid chasing
environment-backed failures that are not product bugs.

## Tiers

| Command | What it runs | Notes |
|---|---|---|
| `npm run test:unit:core` | ~1,700 node:test cases across `test/*.test.{ts,mjs}` + `test/{main,sidebar,daemon,platform}/` | Default concurrency. Needs the main-process build first (`pretest:unit` handles it via `npm test`). |
| `npm run test:unit:coverage` | Same suite with V8 coverage summary | Zero new dependencies; uses `--experimental-test-coverage`. Record a baseline before/after refactors of `src/main/ipc/` and `src/main/chat/providers/`. |
| `npm run test:unit:electron-hosts` | Real-Electron integration (serialized) | Requires a working Electron binary; see limitations below. |
| `npm run test:packages` | daemon / relay / terminal-gateway package suites | Includes the daemon package smoke test. |
| `npm run test:e2e` / `test:web-smoke` | Playwright (Electron + built web) | Requires full `npm run build` + `build:web` first; CI runs them after builds. |
| `npm run check` | lint + format + daemon boundaries + tsgo typecheck | The fast pre-push gate. |

Module mocking (`node:test`'s `mock.module`) is enabled suite-wide via
`--experimental-test-module-mocks`; tests that don't mock modules are
unaffected.

## Known environment limitations (not product failures)

These were observed in sandboxed/managed runtimes and documented during the
2026-07 remediation (`status.md`). On a normal dev machine they should not
occur — if they do locally, suspect your environment first:

- **Loopback listeners blocked** (`listen EPERM 127.0.0.1`): sandboxes that
  deny socket binds stop server-spawning suites (terminal-gateway integration,
  local-proxy backends) before product code runs.
- **Electron hosts SIGABRT**: managed runtimes can abort the Electron 41
  binary outright, failing most of `test:unit:electron-hosts`. Verify with
  `node_modules/.bin/electron --version`.
- **Concurrency contention**: running `test:unit:core` on a loaded machine can
  produce spurious timeouts in suites that spawn subprocesses or bind ports.
  Suites bind port 0 and use temp homes (`CODESURF_HOME` overrides), so a
  quiet machine passes cleanly; re-run failures serially before investigating.

## Why `src/main/db/` has no plain-node tests

`better-sqlite3` is rebuilt for **Electron's ABI** (`npm run rebuild`), so it
cannot load under system Node — which is what `test:unit:core` executes under.
The sqlite layer is exercised through the Electron-host tier instead. If you
need direct migration tests, either run them in an Electron host test or add a
Node-ABI build of better-sqlite3 for tests only.

## Coverage

```bash
npm run test:unit:coverage
```

Prints per-file V8 coverage at the end of the run. There is no enforced
threshold yet; when touching `src/main/ipc/stream.ts`,
`src/main/ipc/chat.ts`, or chat providers, check the delta rather than
regressing blind.

## Failure artifacts in CI

Failed Playwright runs upload `playwright-report/` and `test-results/` as
workflow artifacts (`web-smoke-failure-artifacts`, `e2e-failure-artifacts`,
7-day retention). Download from the CI run page instead of reproducing
flaky-looking failures by hand.
