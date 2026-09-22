# Plan 015: Make clean-checkout verification authoritative

## Status

- **State**: IN PROGRESS
- **Priority**: P1
- **Effort**: S-M
- **Risk**: LOW
- **Category**: testing, CI, release
- **Planned against**: `bc2d0a94`, 2026-07-30
- **Scoped implementation**: `573d5f3b7c79e61b99caf8d4831a1bbca65cd9ea`
- **Integrated source**: `review/full-remediation-2026-07-31` (being reconciled onto `main`)
- **Remaining requirement**: prove the exact final branch tip from a new detached
  worktree with no inherited dependencies or generated artifacts

This plan stays IN PROGRESS until that exact-tip proof succeeds. Passing gates
in the integration worktree is useful evidence but is not a substitute for the
clean-checkout run.

## Why this matters

The 2026-07-30 review found that the former aggregate test path could appear
green while omitting package suites, running relay twice, depending on nested
packages that CI had not installed, or skipping MCP startup failure. A later
clean install also exposed missing build prerequisites, native optional-package
assumptions, and a terminal-gateway fixture that retained PTY/TCP handles.

The release contract must therefore be reproducible from committed files alone:

- every maintained package is installed from its committed npm lockfile;
- each package suite runs exactly once in the aggregate unit lane;
- generated daemon output is verified rather than trusted from the worktree;
- browser and host behavior gates fail closed when startup is incomplete;
- normal CI and tag release use the same release-critical checks;
- development and production dependency trees are both audited.

## Implemented contract

### Test lanes

Root scripts now have one meaning each:

- `test:unit` runs the root core and Electron-host unit suites.
- `test:daemon-package` runs `packages/codesurf-daemon`.
- `test:relay` runs `packages/codesurf-relay`.
- `test:terminal-gateway` runs `packages/codesurf-terminal-gateway`.
- `test:packages` runs those three package suites exactly once.
- `test` runs root unit tests followed by `test:packages`.
- `test:all` aliases the authoritative aggregate `test` lane.

The duplicated daemon test block was removed, the terminal-gateway fixtures now
own and close their local handles, and MCP startup absence is an E2E failure
instead of a skip.

### Build and generated-output authority

- Daemon source builds to committed `dist/` through the package build script.
- `verify:daemon-dist` checks the daemon distribution and shared chat-context
  mirrors without trusting inherited build products.
- Electron, built-web, npm-package, and Electrobun gates use the maintained root
  build paths.
- The built-web verifier checks that required runtime/PWA assets are present.

### CI and release parity

The CI and tag-release workflows install the root plus the daemon, relay,
terminal-gateway, and chat-app packages with `npm ci` before invoking their
gates. They include:

- lint, formatting, and both TypeScript compilers;
- the authoritative aggregate unit lane;
- Electron build and behavior E2E;
- web build verification and built-web smoke;
- chat-app and npm-package builds;
- Electrobun smoke where the host matrix supports it;
- development and production dependency audits for every maintained npm tree;
- fail-on-flaky behavior for release-critical browser tests.

## Final exact-tip proof

The verifier must create a detached worktree at the final commit. It must not
reuse the integration worktree's `node_modules`, daemon `dist/`, renderer build,
or Playwright artifacts.

### Install

```bash
npm ci
npm --prefix packages/codesurf-daemon ci
npm --prefix packages/codesurf-relay ci
npm --prefix packages/codesurf-terminal-gateway ci
npm --prefix apps/chat-app ci
```

### Static and generated-output gates

```bash
npm run verify:daemon-dist
npm run lint
npm run format:check
npm run typecheck:go
npm run typecheck:tsc
git diff --check
```

### Unit, build, package, and behavior gates

```bash
npm test
npm run build
npm run build:web
npm run verify:web-build
npm --prefix apps/chat-app run build
npm run test:npm-package
npm run test:e2e
npm run test:web-smoke
npm run smoke:electrobun
npm run acceptance:electrobun
```

### Dependency authority

Run both development and production audits for each maintained npm tree:

```bash
npm audit
npm audit --omit=dev
npm --prefix packages/codesurf-daemon audit
npm --prefix packages/codesurf-daemon audit --omit=dev
npm --prefix packages/codesurf-relay audit
npm --prefix packages/codesurf-relay audit --omit=dev
npm --prefix packages/codesurf-terminal-gateway audit
npm --prefix packages/codesurf-terminal-gateway audit --omit=dev
npm --prefix apps/chat-app audit
npm --prefix apps/chat-app audit --omit=dev
```

### Post-build reproducibility

```bash
npm run verify:daemon-dist
git diff --exit-code
git diff --check
git fsck
```

## Verification record

Pending. The root integrator will record the final commit, clean worktree path,
gate results, test counts, audit results, and any platform-qualified evidence
after the exact tip completes.

## Done criteria

- [x] Aggregate unit scripts include each maintained package suite exactly once
- [x] CI/release install nested packages before testing them
- [x] Daemon package tests parse and have an explicit isolated-package contract
- [x] Missing MCP startup fails E2E
- [x] CI and release share the release-critical gate structure
- [x] Development and production audit lanes cover every maintained npm tree
- [ ] The exact final commit passes all clean-worktree install, static, unit,
  build, package, E2E, Electrobun, audit, and reproducibility gates
- [ ] The original user checkout is rechecked and remains untouched

## STOP conditions

Stop and report rather than weakening the gate if:

- any committed lockfile fails with `npm ci`;
- a nested package resolves a prerequisite only from the parent worktree;
- a package or aggregate test retains handles when run alone;
- MCP, daemon, renderer, or Electrobun startup is absent or ambiguous;
- a generated-output verifier changes tracked files;
- a gate succeeds only after a retry that would hide flakiness.
