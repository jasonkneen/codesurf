# Full Code Review — 2026-07-30

> **Historical snapshot.** This report records the original blocked review at
> `bc2d0a94`. It is superseded by the integrated remediation report at
> [`2026-07-31-full-review-remediation.md`](2026-07-31-full-review-remediation.md).
> Findings and branch statuses below are preserved as they were observed; do
> not use them as current release status.

## Verdict

**BLOCK**

The live application builds and its existing Electron, web, relay, and E2E
smoke lanes pass, but the repository is not yet safe to call ship-ready. The
review found concrete security-boundary, daemon-lifecycle, context-privacy,
clean-install, dependency, and last-write persistence defects. Five focused
implementation branches were created in isolated worktrees; the authoritative
clean-checkout lane remains blocked and several owner-coordination/backlog
items remain on `main`.

The review baseline is `main` at `bc2d0a94`. Existing dirty source files were
treated as user-owned and were not modified by the reviewer. No remediation
branch was merged or pushed.

## Verification evidence

- `npm run typecheck`: pass.
- `npm run typecheck:tsc`: pass.
- `npm run build`: pass, warnings only.
- `npm run build:web`: pass, warnings only.
- `npm run test:e2e`: 10/10 pass.
- `npm run test:relay`: 40 pass, 2 todo.
- Focused extension remediation: 27/27 at final revision
  `7a6cec5d0441a4bf36bfaeea6e74e5cca9e6e2c7`.
- Focused filesystem remediation: 46/46 at final revision
  `51ff016a7717d478d79ce0ec766a11c0275508d2`.
- Focused context remediation: 39/39 at final revision
  `e1c31cff78178471707689a03670f342098693bd`.
- Focused daemon remediation: 45/45 at final revision
  `39e6b2ac12500f938f39a05f3f61e3e4d638e46d`.
- `npm audit --omit=dev --audit-level=high`: 27 findings
  (12 high, 14 moderate, 1 low).

The clean-checkout experiment deliberately remains red:

- Root tests reached 1018/1022; four tests import
  `dist-electron/main/index.js` before building it.
- Relay startup fails after `npm ci --omit=optional` because
  `lightningcss.darwin-arm64.node` is absent.
- Typecheck fails after that install because
  `@typescript/native-preview-darwin-arm64` is absent.
- The terminal-gateway lane runs its first three tests and then retains real
  PTY/TCP handles instead of exiting.

## Isolated remediation branches

| Plan | Branch | Current result |
|---|---|---|
| [012](012-extension-boundary-hardening.md) | `advisor/epic-012-extension` @ `7a6cec5d0441a4bf36bfaeea6e74e5cca9e6e2c7` | Ready for integration review; 27/27 focused tests |
| [013](013-fs-symlink-boundary.md) | `advisor/epic-013-fs-symlink` @ `51ff016a7717d478d79ce0ec766a11c0275508d2` | Ready for integration review; 46/46 focused tests; documented Node mutation caveat |
| [014](014-context-budget-contract.md) | `advisor/epic-014-context-budget` @ `e1c31cff78178471707689a03670f342098693bd` | Ready for integration review; 39/39 focused tests |
| [015](015-clean-checkout-verification.md) | `advisor/epic-015-verification` @ `573d5f3b7c79e61b99caf8d4831a1bbca65cd9ea` | **BLOCKED; do not merge as complete** |
| [016](016-daemon-request-lifecycle.md) | `advisor/epic-016-daemon` @ `39e6b2ac12500f938f39a05f3f61e3e4d638e46d` | Ready for integration review; 45/45 focused tests |

## Findings

Statuses mean:

- **Ready in branch** — fixed and verified in an isolated branch, not merged.
- **Blocked** — implementation exposed a prerequisite/failure that must be
  resolved first.
- **Owner coordination** — the affected live file already contains user-owned
  uncommitted work.
- **Backlog** — verified issue, not selected for this remediation wave.

### Security and runtime correctness

1. **CORRECTNESS-01 — High — Owner coordination.** OpenCode enables password
   auth when spawning the server at `src/main/chat/providers/opencode.ts:107-121`
   and supplies auth headers to the one-off abort client at
   `src/main/chat/providers/opencode.ts:332-342`, but the cached normal client
   at `src/main/chat/providers/opencode.ts:349-366` omits those headers.
   Session creation, event subscription, and prompt delivery at
   `src/main/chat/providers/opencode.ts:407-456` can therefore receive 401.

2. **SECURITY-01 / EXT-01 — P0 — Ready in extension branch.** Manifest ids flowed into
   settings/install paths, lightweight discovery did not establish the active
   workspace, and archive identity could differ between `package.json` and the
   effective manifest. Baseline evidence:
   `src/main/extensions/registry.ts:279-359`,
   `src/main/ipc/extensions.ts:177-218,277-306,430`, and
   `src/main/extensions/light-scan.ts:78-138`. Plan 012 centralizes the id
   contract, serializes workspace discovery, validates the effective installed
   identity, and commits archive installs transactionally. Final review also
   found lightweight/full collision precedence drift and explicit `null`
   retaining the old workspace at
   `src/main/extensions/registry.ts:198-241` and
   `src/main/ipc/extensions.ts:419-470`; commit `7a6cec5d` aligns winning
   manifests across sidebar/tile IPC and clears workspace state only for
   explicit `null`.

3. **SECURITY-03 — P0 — Ready in extension branch.** Extension assets were authorized
   by canonical path and then reopened, permitting a directory/symlink swap
   between validation and read. Baseline evidence:
   `src/main/extensions/protocol.ts:71-84,137-192` and
   `src/main/extensions/registry.ts:625-636`. Plan 012 binds authorization and
   serving to a retained no-follow file handle; text injection reads are
   bounded and binary assets remain streamed. A later review found the 4 MiB
   text path still called unbounded `readFile` after `stat`; final
   `src/main/extensions/resource-path.ts:111-156` uses positional reads capped
   at `maxBytes + 1`, detects post-open growth, and always closes the handle.

4. **SECURITY-02 — P0 — Ready in filesystem branch.** Filesystem IPC originally scoped
   lexical paths, so child symlinks could escape workspace boundaries.
   Baseline evidence: `src/main/ipc/fs.ts:66-125,245-365,658-903`.
   Plan 013 separates canonical kernel paths from lexical renderer identity,
   validates both endpoints, and adds real handler tests. A final spot-check
   additionally reproduced an ancestor-directory swap at
   `src/main/ipc/fs.ts:443,462,791`, inability to delete a safe workspace
   symlink at `src/main/ipc/fs.ts:226,807`, a retargeted-root watcher leak at
   `src/main/ipc/fs.ts:945,983`, and `watchStop` overtaking async
   `watchStart`. Final commit `51ff016a` revalidates parent/target identity
   around handle I/O, performs inode-safe failed-create cleanup, uses
   `delete-link`, reference-counts watcher lifecycles, serializes watch
   operations, and exercises the real handlers. Node's lack of portable
   `openat`/`unlinkat` leaves an explicitly documented transient empty-create
   and path-based unlink/rename/mkdir race window.

5. **CONTEXT-01 — P0 — Ready in context branch.** Model-visible instructions, recursive
   imports, skills, persona prompts, and transcript copies were unbounded at
   `packages/codesurf-daemon/bin/memory-loader.mjs:5-63,236-263,302-326`,
   `packages/codesurf-daemon/bin/skills-index.mjs:193-215,240-345`,
   `packages/codesurf-daemon/bin/chat-jobs.mjs:686-707,2595-2639`, and
   `src/main/ipc/chat.ts:1031-1064`. Plan 014 adds byte/item/depth/aggregate
   limits, trusted-boundary revalidation, and bounded transcript previews.

6. **CONTEXT-PRIVACY-01 — High — Ready in context branch.** A final spot-check
   showed that lexical import classification at
   `packages/codesurf-daemon/bin/memory-loader.mjs:494-510` occurred before
   canonical validation at `:516-537`; `public-alias -> .codesurf` could make a
   local-only secret appear remote-safe in a cloud prompt. The final branch
   classifies the canonical target before content read.

7. **CONTEXT-CAP-01 — High — Ready in context branch.** The 32-section root
   loop at `packages/codesurf-daemon/bin/memory-loader.mjs:48-54` could exit
   without omission metadata, while recursion unwinding at `:434-460` could
   append a 33rd raw section. A high-precedence import fan-out could silently
   remove primary `AGENTS.md`. The final branch caps raw sections, reserves
   primary workspace candidates, and reports untraversed roots/parents.

8. **CONTEXT-IO-01 — Medium — Ready in context branch.** Root candidate
   generation at `packages/codesurf-daemon/bin/memory-loader.mjs:276-364` is
   proportional to every project path; missing/empty roots did not consume the
   import-attempt limit. The final branch separately caps root attempts at 128,
   visible imports at 128, and non-refundable canonical-validation I/O at 512
   while reserving primary workspace candidates.

9. **CORRECTNESS-02 / CORRECTNESS-03 / PERFORMANCE-03 — Ready in daemon
   branch.** Mutation requests could be replayed after timeout, healthy
   mismatched-version daemons were reused, and request bodies were unbounded.
   Baseline evidence: `packages/codesurf-daemon/src/client.ts:62-100`,
   `packages/codesurf-daemon/src/manager.ts:356-404`,
   `packages/codesurf-daemon/bin/codesurfd.mjs:2796-2818,3848-3853`.
   Plan 016 makes mutations no-retry/outcome-unknown, performs deliberate
   version replacement, and caps bodies at 1 MiB with stable 413 responses.

10. **DAEMON-IDENTITY-01 — Ready in daemon branch.** Recycled/stale PIDs could
    be signalled from `packages/codesurf-daemon/src/manager.ts:366-385`, and a
    forced restart could be lost behind the active startup promise at `:413`.
    The branch authenticates `pid`, `startedAt`, port, and token via `/health`,
    queues replacement startup, and ensures later callers receive it.

11. **DAEMON-SHUTDOWN-01 — Ready in daemon branch.** First revision
    re-authenticated before SIGKILL, but `codesurfd` removed its PID/lock at
    shutdown entry (`packages/codesurf-daemon/bin/codesurfd.mjs:4027-4038`),
    making safe escalation impossible after a slow cleanup
    (`packages/codesurf-daemon/src/manager.ts:430-440`). Final commit
    `39e6b2ac` retains authenticated shutdown identity until process exit and
    marks `/health` as shutting down so it is never reused.

12. **CORRECTNESS-04 — High — Backlog.** The 500 ms canvas save is cancelled
    during cleanup at `src/renderer/src/hooks/useCanvasEngine.ts:340-345` while
    the actual write is delayed at `:382-405`; window close and app quit have no
    renderer/main flush handshake at `src/main/index.ts:514-517,925-933`.
    The last interaction can be lost.

13. **ARCHITECTURE-01 — High — Backlog.** Relay provider subprocess timeouts
    signal only the direct child and concatenate stdout/stderr without a cap:
    `src/main/relay/provider-executor.ts:197-249,252-308,356-413,416-498`.
    Descendants and main-process memory can leak.

14. **PERFORMANCE-01 — High — Backlog.** Daemon SSE returns the
    `res.write()` backpressure signal at
    `packages/codesurf-daemon/bin/chat-jobs.mjs:1048-1056`, but fan-out ignores
    it at `:1218-1222`; heartbeat writes also ignore it at `:1114-1125`, and
    subscribers remain attached until close at `:2830-2841`.

15. **PERFORMANCE-02 — Medium — Backlog.** Canvas drag is RAF-coalesced, but
    each frame still maps all tiles and repeatedly searches snapshots at
    `src/renderer/src/hooks/useCanvasDragSync.ts:281-282,310-312,370-372,410-412`.
    The listener effect is reinstalled with drag state at `:503-535`.

16. **DEPENDENCIES-01 — High — Backlog.** The direct Pi harness dependency at
    `packages/codesurf-daemon/package.json:41-47` resolves
    `@earendil-works/pi-coding-agent@0.77.0` at
    `packages/codesurf-daemon/package-lock.json:112-125,338-367`; the current
    production audit reports high-severity transitive advisories.

### Architecture and dependency coherence

17. **ARCH-01 — Medium — Backlog.** Permission storage/policy is separately
    implemented in `src/main/permissions.ts:8-29`,
    `bin/codesurf.cjs:17,109-168`,
    `packages/codesurf-daemon/bin/codesurfd.mjs:32,127-260`, and
    `packages/codesurf-daemon/bin/chat-jobs.mjs:101-168`. Semantics can drift.

18. **ARCH-02 — High — Backlog.** Provider execution policy is mirrored across
    Electron and daemon:
    `src/main/chat/agent-mode-tools.ts:87-121`,
    `packages/codesurf-daemon/bin/agent-mode-tools.mjs:105-134`,
    `src/main/chat/providers/agent-mode-payloads.ts:119-145`, and
    `packages/codesurf-daemon/bin/chat-jobs.mjs:643-848`.
    The daemon Codex builder omits the Electron builder's
    `--ignore-user-config` at
    `src/main/chat/providers/agent-mode-payloads.ts:145`.

19. **DEP-01 / API-01 — High — Backlog.** `@codesurf/daemon` claims Node
    `>=18` while dependencies require Node 22/22.19 and advertised subpath
    exports point directly at raw TypeScript:
    `packages/codesurf-daemon/package.json:9-27,41-50`,
    `packages/codesurf-daemon/package-lock.json:36-53,112-125,338-367`.
    A clean Node 24 import of `@codesurf/daemon/manager` fails with
    `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

20. **DEP-02 — Medium — Backlog.** Dependency authority is split: root asks
    for Claude SDK `^0.2.118` at `package.json:103`, daemon asks for
    `^0.2.114` at `packages/codesurf-daemon/package.json:46`, and the current
    hoisted install contains harness/adapters canary `.10/.6` while the daemon
    manifest asks for `.9/.5` at `packages/codesurf-daemon/package.json:42-45`.

21. **ARCH-03 / ARCH-04 — Medium — Backlog.**
    `packages/codesurf-daemon/bin/chat-jobs.mjs:1` is a 2,945-line
    provider/job/permissions/SSE monolith and
    `packages/codesurf-daemon/bin/codesurfd.mjs:1` is a 3,984-line
    route/lifecycle/dashboard monolith.

22. **ARCH-05 — Medium — Backlog.** Preload, ambient renderer types, web
    daemon bridge, and Electrobun maintain divergent host contracts.
    `src/preload/index.ts:81-106` exposes `deleteFile`/`renameFile`, while
    `src/renderer/src/env.d.ts:29-46` additionally declares nonexistent Electron
    `delete`, `rename`, and `basename`. The preload is 807 lines and the
    ambient interface reaches `src/renderer/src/env.d.ts:666`.

23. **ARCH-06 — Medium — Backlog.** `src/renderer/src/App.tsx:1` remains a
    1,788-line orchestration surface with 13 `useState` and 28 `useEffect`
    calls despite the extraction wave.

24. **ARCH-07 — Medium — Backlog.**
    `src/renderer/src/components/BrowserTile.tsx:1` remains 1,464 lines; the
    webview lifecycle effect spans `:445-750`, the MCP/peer bridge begins at
    `:879`, and the evidence drawer occupies `:1194-1420`.

25. **CHANGE-SIZE-01 — Medium — Backlog.** Recent commits were too broad for
    reliable review (`ed7af61f`: 50 files, +2101/-617; `beb6536c`: 26 files,
    +2555/-781; `d4bcebb6`: 10 files, +2593/-2242). There is no diff-size
    warning among the repository scripts at `package.json:20-69`.

### Tests, CI, and tooling

26. **TEST-01 / CI-01 — High — Blocked in Plan 015.** Root `npm test`
    invokes relay, while `test:all` invokes it again at `package.json:21-24`.
    CI runs root tests before installing relay and uses `npm install` for the
    nested package at `.github/workflows/ci.yml:31-44`.

27. **TEST-02 — High — Blocked in Plan 015.** The aggregate omits
    `packages/codesurf-daemon` and `packages/codesurf-terminal-gateway`, and the
    daemon package cannot parse because
    `packages/codesurf-daemon/test/codex-exec-args.test.mjs:74-77` duplicates
    imports. Commit `573d5f3b` fixes the duplicate and declares lanes, but the
    resulting clean gate exposes the blockers recorded above.

28. **TEST-03 — Medium — Backlog.** Daemon fixtures wait five seconds, send
    SIGKILL if needed, but do not await a final exit:
    `test/daemon/codesurfd.test.mjs:106-113` and
    `test/daemon/memory-loader.test.mjs:72-79`. This is consistent with the
    leaked handles seen in package verification.

29. **TEST-04 — High — Backlog.** E2E exercises models/history and direct
    persistence/custom events rather than visible human workflows:
    `e2e/chat.spec.ts:6-39`,
    `e2e/canvas.spec.ts:7-91,95-139`. It does not pointer-drag/resize/group,
    send a provider turn, expand transcript chips, or assert rendered state.

30. **TEST-05 — High — Blocked in Plan 015.** MCP auth E2E returns a
    `skipped` sentinel when the server port is missing and calls `test.skip` at
    `e2e/security.spec.ts:11-28`. Commit `573d5f3b` makes startup fail closed.

31. **TEST-06 — Medium — Backlog.** CI has only one macOS Electron lane at
    `.github/workflows/ci.yml:19-50` although `package.json:41-64` exposes
    web/PWA/Native/Electrobun/Windows/Linux targets. Root typecheck configs do
    not cover every secondary host and E2E surface.

32. **TEST-07 — Medium — Backlog.** A material fraction of tests asserts
    source shape instead of runtime behavior; representative examples are
    `test/extension-loading-hardening.test.ts:6-28`,
    `test/app-canvas-interaction-composition.test.ts:7-10`, and
    `test/agent-cli-contracts.test.ts:275-304`.

33. **TEST-08 — Medium — Backlog.** Relay validation tests copy private helper
    implementations rather than exercise production code, and the participant
    id checks remain TODO:
    `packages/codesurf-relay/src/validation.test.ts:3-5,30-50,94-102`.

34. **TEST-09 / TOOLING-01 — Medium — Backlog.** No lint or formatting gate is
    defined in `package.json:20-69`, so style/unused-code drift is detected only
    incidentally by compilers and reviewers.

### Product trust, setup, and documentation

35. **TRUST-01 — High — Backlog.** Capability consent is only a gate over the
    brokered `ctx` API; power-plugin child code retains ambient Node access:
    `src/main/extensions/broker/child-entry.ts:11-15` and
    `src/main/extensions/broker/policy.ts:8-13`. The Gallery presents only
    “Wants” capability chips at
    `src/renderer/src/components/ExtensionsGallery.tsx:480-531`, and enablement
    records them as consent at `src/main/extensions/registry.ts:671-678`.
    The user-visible surface should explicitly say that power plugins can still
    access filesystem/process APIs outside those grants.

36. **PLUGIN-01 — Medium — Backlog.** The v2 quickstart points workspace users
    to legacy `.contex/extensions` at `docs/plugins/01-authoring.md:7-10` and
    tells authors to import unavailable/unpublished `@codesurf/ui` and
    `@codesurf/plugin` at `:51-57,111-121`. `docs/extensions.md:6-11` itself
    contradicts the canonical `.codesurf` location.

37. **CONTEXT-02 — Medium — Backlog.** `AGENTS.md` is stale: App is now 1,788
    lines rather than the claimed ~1,944 (`AGENTS.md:22`), Claude SDK is
    `^0.2.118` rather than `0.2.79` (`AGENTS.md:40`), and persistence paths at
    `AGENTS.md:60-63` do not match current artifact paths. It also contains an
    emoji despite the repository's current no-emoji instruction.

38. **SETUP-01 — High — Backlog.** `setup.sh:5-8` broadly kills every process
    matching Electron/electron-vite, deletes build output, uses
    `npm install --legacy-peer-deps`, rebuilds only node-pty, then invokes
    undocumented Bun at `setup.sh:10-20`. This conflicts with the npm-only
    setup documented at `README.md:29-45`; root `package.json` also has no Node
    engine contract.

39. **DOCS-01 — Medium — Backlog.** README says default workspaces live at
    `~/codesurf/workspaces` (`README.md:104-114`), while the canonical home is
    `~/.codesurf` (`src/main/paths.ts:22-31`) and artifacts are nested under
    `.codesurf` filenames at
    `src/main/storage/workspaceArtifacts.ts:63-88`.

40. **CONTEXT-03 — Medium — Backlog.** The exported compatibility loader at
    `packages/codesurf-daemon/bin/instruction-context.mjs:4-74,94-120`
    implements different candidates, privacy metadata, imports, and error
    behavior than the runtime loader at
    `packages/codesurf-daemon/bin/memory-loader.mjs:145-245`.

41. **DOCS-02 — Low — Backlog.** Historical plans still present completed or
    superseded work as current:
    `docs/BACKLOG_PLAN.md:11-29`,
    `docs/REMEDIATION_PLAN.md:3,49-59`. The code-index plan contains a broken
    relative link at
    `docs/superpowers/plans/2026-05-03-code-index.md:3172`.

## Post-implementation review record

The initial “tests pass” result was not accepted as completion. Independent
reviewers inspected every remediation diff and forced additional revisions:

- **Extension tests:** protocol and settings assertions initially inspected
  helpers/source rather than registered handler behavior; observable protocol,
  store/settings IPC, scan-queue, and sidebar-to-tile collision tests were
  added in `test/extension-boundary-security.test.ts` and
  `test/extension-loading-hardening.test.ts:245-335`.
- **Extension security:** reviewers found a canonical-path reopen race
  (`src/main/extensions/resource-path.ts:18`,
  `src/main/extensions/protocol.ts:176,190`), package/effective-id mismatch
  (`src/main/ipc/extensions.ts:97,177,184`), and adapter output written before
  validation (`src/main/extensions/adapters/index.ts:31`,
  `src/main/extensions/adapters/raycast.ts:98`). A final spot-check then found
  discovery collision precedence drift, explicit `null` workspace retention,
  and a size-prechecked but unbounded text read. Final commit `7a6cec5d`
  closes all of them.
- **Context:** reviewers found candidate quota before existence, local-only
  quota consumption, room suffix truncation, and missing skill-summary notices
  in the first implementation. The next review reproduced the cloud symlink
  alias, recursion unwind overflow, silent root omission, unbounded
  root-candidate I/O, and a refundable canonical-validation quota recorded in
  Findings 6–8. Final commit `e1c31cff` closes all of them.
- **Daemon:** reviewers found unauthenticated PID signalling, a lost forced
  restart behind `startupPromise`, and HTTP 408 mutation ambiguity in the first
  implementation. A final spot-check then found shutdown identity was removed
  too early for safe escalation; final commit `39e6b2ac` closes all four.
- **Filesystem:** reviewers first found broken unrelated roots, canonical paths
  leaking into renderer identity, and validator-only tests. The next spot-check
  reproduced the ancestor swap, safe-link deletion failure, watcher key leak,
  and missing handler coverage. A final concurrency review found
  `watchStop` could overtake async `watchStart`. Final commit `51ff016a`
  closes the actionable cases and documents the kernel-API limitation.

## Recommended integration order

1. Integrate Plans 012, 013, 014, and 016 in that order and rerun their 27,
   46, 39, and 45 focused tests plus the root typechecks and product E2E.
   Reconcile Plan 012's macOS archive fixtures on the release platforms.
2. Resolve Plan 015's build-before-test, native optional-dependency, and
   terminal teardown failures; then rerun from a genuinely clean checkout.
3. Coordinate the OpenCode cached-client auth fix with the owner of the dirty
   file.
4. Fix last-canvas-save loss and the high dependency/audit chain.
5. Only then promote the repository from **BLOCK** to a release-candidate
   review.
