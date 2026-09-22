# Full Review Remediation — 2026-07-31

## Status

**REMEDIATION IN PROGRESS — final clean-checkout proof pending.**

This report supersedes the blocked 2026-07-30 snapshot. The review baseline is
`main` at `bc2d0a94`; implementation is isolated on
`review/full-remediation-2026-07-31`. The original `main` checkout and its
user-owned dirty files are not integration inputs and must remain unchanged.
Nothing from this review is pushed automatically.

## Outcome

The branch integrates the five 2026-07-30 plans and the later independent
hardening lanes as reviewable commits. The resulting product closes the
confirmed extension, filesystem, context, daemon, canvas, relay, agent-room,
permission, provider-policy, dependency-authority, BrowserTile, and Electrobun
defects. The final review also requires behavior-level BrowserTile and built-web
tests, release-gate parity, fail-on-flaky CI, a host-backed Electrobun facade,
and one bounded prompt-composition contract across every provider.

The integration is intentionally large because it combines independently
reviewed remediation branches. Change-size policy remains non-blocking at the
aggregate branch level; individual implementation stages and merge boundaries
are retained in history so the work remains reviewable.

## Finding disposition

| # | 2026-07-30 finding | Final disposition |
|---:|---|---|
| 1 | OpenCode cached-client authentication | Resolved: normal session, event, prompt, and abort clients share authenticated configuration. |
| 2 | Extension identity/discovery boundary | Resolved: canonical ids, serialized discovery authority, transactional installs, and collision parity. |
| 3 | Extension asset TOCTOU and unbounded reads | Resolved: retained no-follow handles, bounded positional reads, and attested media lifecycle. |
| 4 | Filesystem symlink/race boundary | Resolved with canonical path and handle revalidation. Node cannot provide a portable `openat`-style directory capability; that residual is documented rather than hidden. |
| 5 | Unbounded model-visible context | Resolved: host-authored fragments and untrusted observations pass the same deterministic per-item and final aggregate budgets. |
| 6 | Context privacy leakage | Resolved: private/local context is excluded from outbound bundles by policy. |
| 7 | Context section/aggregate caps | Resolved: deterministic precedence, count, byte, and truncation contracts. |
| 8 | Context filesystem I/O | Resolved: bounded reads and canonical traversal limits. |
| 9 | Daemon request/version lifecycle | Resolved: identity is preserved through startup, replacement, cancellation, and shutdown. |
| 10 | Daemon stale/recycled PID identity | Resolved: instance identity is revalidated before signalling or replacing a process. |
| 11 | Daemon shutdown identity loss | Resolved: shutdown retains authority until children and durable state settle. |
| 12 | Last canvas save lost on close/switch | Resolved: ordered save arbitration and renderer/main persistence barriers cover close, reload, quit, and workspace transitions. |
| 13 | Relay provider process containment | Resolved: bounded diagnostics, generation fencing, tree termination, and fail-closed shutdown. |
| 14 | Daemon SSE durability/backpressure | Resolved: bounded subscribers, frame/wire/event limits, schema sanitization, contiguous sequence validation, durable terminal ordering, strict replay validation, and restart repair. |
| 15 | Canvas drag hot-path scans | Resolved: indexed, RAF-coalesced drag/group/resize updates with real pointer E2E. |
| 16 | Vulnerable/undeclared Pi dependency chain | Resolved through locked dependency authority. CI/release now audit development and production trees for every maintained npm package; final exact-tip audit results remain pending. |
| 17 | Duplicated permission policy | Contract-aligned and regression-tested. Structural duplication remains a refactoring opportunity, not an observed correctness defect. |
| 18 | Mirrored provider policy | Runtime/daemon behavior is contract-tested and prompt composition is shared; large transport modules remain structural debt. |
| 19 | Daemon raw TypeScript exports | Resolved: compiled NodeNext API, declarations, deterministic dist verification, and clean consumer smoke. |
| 20 | Split dependency authority | Resolved: locked npm installs are authoritative; package-local runtime/dev ownership is enforced. |
| 21 | Daemon monoliths | No correctness defect remains from this review. `chat-jobs.mjs` and `codesurfd.mjs` are still intentionally documented decomposition targets. |
| 22 | Host bridge divergence | Resolved for maintained Electron, web, and Electrobun contracts, including failure propagation, host-validated authority, durable attachment selection receipts, and fenced process/session lifecycle. |
| 23 | `App.tsx` orchestration size | Focused hooks, ordered persistence, indexed canvas updates, and behavior E2E reduce risk. Further decomposition is non-blocking structural work. |
| 24 | BrowserTile lifecycle/evidence monolith | Resolved: lifecycle and evidence modules extracted; BrowserTile reduced substantially and covered by real guest navigation/restore/evidence E2E. |
| 25 | Oversized changes hidden from review | Resolved: CI reports change-size warnings; the remediation keeps coherent staged commits and reviewed merge boundaries. |
| 26 | Incomplete/duplicated aggregate gate | Resolved: one authoritative root unit lane plus each maintained package exactly once. |
| 27 | Package suites omitted from root tests | Resolved: daemon, relay, and terminal-gateway suites are installed and run explicitly in CI/release. |
| 28 | Slow/leaking daemon teardown fixtures | Resolved: shared bounded child lifecycle helpers and isolated homes. |
| 29 | E2E lacked real input/provider behavior | Resolved: real pointer workflows, local provider turn, BrowserTile guest behavior, and built-web bridge/persistence smoke. |
| 30 | MCP E2E silently skipped startup failure | Resolved: missing/invalid MCP startup state fails closed. |
| 31 | Narrow platform coverage | Improved with macOS product E2E, Linux portable contracts, Windows process containment, built-web Chromium, and Electrobun smoke. Native Zig packaging remains a separate target-specific release decision. |
| 32 | Source-shape-heavy tests | Material runtime boundaries now have behavior tests. A small number of wiring assertions remain where importing Electron main modules would create false integration. |
| 33 | Relay tests copied private validation logic | Resolved: production validation helpers are exercised directly. |
| 34 | Missing lint/format gate | Resolved: zero-warning ESLint and repository formatting checks run in CI and release. |
| 35 | Power-plugin trust disclosure | Resolved: runtime trust boundary and capability limitations are explicit in product and authoring documentation. |
| 36 | Broken plugin authoring references | Resolved: guides reference shipped packages and supported local workflows. |
| 37 | Stale agent context documentation | Resolved: `AGENTS.md` reflects the current architecture and versions. |
| 38 | Unsafe broad setup process kills | Resolved: locked, scoped startup and teardown replace broad process matching. |
| 39 | Incorrect workspace paths in README | Resolved: current file-based persistence paths and overrides are documented. |
| 40 | Compatibility loader drift | Resolved: runtime and compatibility instruction loading share one contract. |
| 41 | Historical plans presented as current | Resolved by this report, the regenerated plan index, archival headers, and refreshed generated memory. |

## Additional final-review closure

- Agent-room storage, MCP tools, chat streams, credentials, terminal delivery,
  and room acknowledgements are workspace-scoped, bounded, and lifecycle-safe.
- Peer topology and authority are host-validated. User-role observations remain
  untrusted: both Electron and daemon provider boundaries safely serialize,
  canonically order, and bound them before prompt use. The rendered peer
  fragment is limited to 1,000 UTF-8 bytes.
- Recent-edit context requires main-process attestation and an exact match on
  workspace, tile, provider, execution target, and session. Reads use a bounded
  workspace-scoped host operation; remote or stale provenance yields no file
  content.
- Foreground chat sends acquire preparation leases before replacement. Stop,
  clear, disposal, or a newer send invalidates older asynchronous work before
  capability redemption, daemon start, or provider launch. Runtime-session
  persistence is serialized by scope, and authoritative clear prevents old
  writes from resurrecting state.
- Daemon SSE decoding is incremental and bounded across frames, total wire
  bytes, sanitized payloads, strings, collections, and error diagnostics.
  Renderer-bound events must carry the expected job identity and a contiguous
  sequence and terminate at the first accepted `done`.
- The managed local proxy caps request/backend bodies, stream lines, aggregate
  bytes, and queued backpressure. It validates roles, tears down both request
  sides on cancellation/failure, and acknowledges room context only after an
  accepted event or clean explicit terminal marker.
- Attachments are one-shot, host-attested capabilities. Reads revalidate device,
  inode, size, modification time, and change time under per-file/per-request
  limits; owned temporary materializations are cleaned without deleting user
  source files.
- Electrobun enforces registered workspaces/personas, canonical filesystem and
  terminal roots, safe provider environments, explicit RPC failures, and
  generation-fenced tile hydration. Chat replacements supersede before context
  preparation; late process/session/stream callbacks are rejected; process-tree
  termination waits for bounded graceful shutdown before escalation and final
  completion. Claude stream parsing preserves errors without delta/result
  duplication.
- BrowserTile uses a real local guest-page E2E for navigation, history,
  lifecycle/console evidence, capture, persistence, and restore.
- Built-web Playwright smoke validates runtime configuration, bridge install,
  daemon health, workspace creation, canvas persistence, and reload behavior.
- Tag releases run the same release-critical checks as normal CI, and CI
  retries cannot turn a flaky E2E into a green gate.

## Verification

### Implemented verification surface

The branch defines root/package unit lanes, lint and formatting gates, two
TypeScript compilers, deterministic daemon-dist and context-mirror checks,
Electron and built-web behavior suites, npm-package smoke, Electrobun
smoke/acceptance, and development/production audits for every maintained npm
tree. CI and tag release install nested packages from their committed lockfiles
before their declared gates; the exact-tip proof additionally runs the full
Electrobun acceptance command.

### Pending exact-tip proof

No final gate result is claimed in this document yet. The authoritative
integration and clean-checkout results will be recorded after the exact final
product commit passes every gate from a detached worktree without inherited
`node_modules`, generated daemon output, renderer builds, or browser artifacts.
Plan 015 remains IN PROGRESS until that proof and the original-checkout
preservation check are complete.

## Known non-blocking limitations

- Portable Node filesystem APIs cannot express a retained directory capability
  equivalent to POSIX `openat` for every mutation; canonical and handle
  revalidation substantially narrow, but cannot mathematically eliminate, that
  external same-user race.
- `chat-jobs.mjs`, `codesurfd.mjs`, and `App.tsx` remain large orchestration
  surfaces. They are protected by focused modules and behavior tests; future
  decomposition should preserve those contracts.
- Native Zig shell packaging is not claimed by the Electron/web/Electrobun
  release proof unless a target-specific signing/package gate is run.
