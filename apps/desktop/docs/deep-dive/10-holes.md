# Holes — Coverage Gaps & New Risks

The preceding nine sections each audited a single dimension (refactor, memory, performance, reliability, testing, duplication, separation, daemon, self-learning). This section is the meta-pass: it asks what those dimensions structurally *could not see*. Two critics ran against the full nine-dimension audit. The **coverage critic** measured what the dimension audit did not reach — which files went unread, which axes were never defined. The **new-risk critic** audited the surfaces that no single dimension owns: security, trust boundaries, supply chain, and build/config hygiene.

The headline is that the nine dimensions contain **no security axis**, and almost every concrete finding below sits on that unaudited axis. Two of them are critical and exploitable with zero user interaction: opening or cloning a repo can run arbitrary Node in the Electron main process, and the local MCP HTTP server accepts unauthenticated command-execution requests. The two critics' findings overlap thematically (both touch security) but are kept in separate parts by source, not merged by topic — Part 1 is the coverage critic's view of *gaps*, Part 2 is the new-risk critic's view of *exploitable risks*.

> Note on provenance: unlike the dimension sections (which ran a generator→critic→verifier pipeline and carry `Verifier critique` blocks), these findings are raw critic output with no independent verification layer. Severities are carried exactly as the critics stated them. Each finding's cited `file:line` anchors were spot-checked against the source and confirmed accurate during transcription, but no severity was re-graded.

---

## Coverage gaps

What the nine-dimension audit did not reach.

The audit covered the right hotspots *within* its dimensions but left two structural holes. **First, there is no security dimension at all** — yet this is an Electron app that loads and executes agent/extension code, registers a custom privileged URL scheme, spawns local HTTP servers, injects a vendored 2433-LOC bundle into arbitrary browsed pages, and stores API keys. The audited axes (refactor, memory, performance, reliability, testing, duplication, separation, daemon, self-learning) contain no security/trust-boundary axis, so every concrete issue on that axis went unevaluated.

**Second, coverage breadth was thin.** Of 306 files / 107K LOC, the audit cited roughly 66 files; 250 files / 52K LOC got no attention. The largest genuinely-uncited source files were never read: `SettingsPanel.tsx` (2306 LOC, the largest non-vendored file, with a massive IPC surface and plaintext provider-key input), `ai-elements/prompt-input.tsx` (1464), `chat/ToolBlockView.tsx` (1274, a perf-hot tool-render path), `FileExplorerTile.tsx` (1246), `KanbanCard.tsx` (1017), `KanbanTile.tsx` (982, 3s polling), `PanelLayout.tsx` (976), `codesurf-relay/relay.ts` (755, flagged highest-leak-risk in the digest yet untested), `collab.ts` (651), `db/job-indexer.ts` (580, sync fs at startup), `extensions/registry.ts` (549), `extensions/protocol.ts`, and `localProxy.ts` (432). The security-relevant ones were swept for this pass; the pure-UI ones (prompt-input, ToolBlockView, FileExplorer, Kanban, PanelLayout) swept clean of `eval` / `dangerouslySetInnerHTML` / `postMessage('*')` and are genuine refactor/perf candidates the audit could still have named.

Shallow dimensions relative to surface area: **testing** cited test files but never noticed that the entire `packages/codesurf-relay` vitest suite — the agent-coordination core the digest calls the highest-leak-risk subsystem — never executes anywhere, and that CI has no PR/push gate. **Duplication/separation** never characterized the checked-in 2433-LOC minified third-party bundle or the systemic unconfined-`workspacePath` pattern. **Daemon** never reached the synchronous startup filesystem scan in `job-indexer.ts`.

### Findings

| ID | Title | Severity | Effort | Files |
|----|-------|----------|--------|-------|
| gap-01 | No security dimension: code-execution, custom-protocol, and secret surfaces never audited | high | L | `src/main/extensions/protocol.ts`, `src/main/extensions/registry.ts`, `src/main/ipc/localProxy.ts`, `src/main/secrets.ts`, `src/renderer/src/components/BrowserTile.tsx` |
| gap-02 | codesurf-relay test suite never executes — declared in vitest, not installed, excluded from `npm test` and CI | high | M | `package.json`, `packages/codesurf-relay/package.json`, `packages/codesurf-relay/src/runtime.test.ts` |
| gap-03 | Generation-provider API keys stored plaintext in settings.json while every other provider uses the OS keychain | medium | M | `src/renderer/src/components/SettingsPanel.tsx`, `src/main/ipc/workspace.ts`, `src/shared/types.ts`, `src/main/secrets.ts` |
| gap-04 | No CI on pull requests or pushes — tests gate releases, not merges | medium | S | `.github/workflows/release-on-tag.yml` |
| gap-05 | Hardcoded developer-machine absolute path shipped in the codesurf-ext:// protocol handler | low | S | `src/main/extensions/protocol.ts` |
| gap-06 | Renderer-supplied workspacePath is unconfined across the IPC filesystem layer | low | M | `src/main/ipc/collab.ts`, `src/main/ipc/fs.ts`, `src/main/ipc/canvas.ts`, `src/main/paths.ts` |
| gap-07 | job-indexer runs a synchronous filesystem scan of all job files on startup, blocking the main process | low | M | `src/main/db/job-indexer.ts` |
| gap-08 | cluso-embed.js: 2433-LOC vendored minified bundle checked into source, no integrity pin, injected into every browsed page | low | M | `src/renderer/src/assets/cluso/cluso-embed.js`, `src/renderer/src/components/BrowserTile.tsx` |

---

### gap-01 — No security dimension: code-execution, custom-protocol, and secret surfaces never audited

**Severity:** high · **Effort:** L · **Category:** security

**Problem.** The nine audited dimensions contain no security/trust-boundary axis. This is an Electron app whose core function is loading and executing third-party agent/extension code: `extensions/registry.ts` `require()`s and runs `manifest.main` (`loadPowerExtension`); `extensions/protocol.ts` registers a *privileged* `codesurf-ext://` scheme that reads files from disk; `localProxy.ts` spins up a localhost HTTP server translating Anthropic↔OpenAI; `BrowserTile` injects a 2433-LOC vendored bundle into arbitrary browsed pages; `secrets.ts` manages keychain keys. None of these surfaces — code-execution boundaries, the custom protocol's path-traversal handling, secret-at-rest storage, or renderer→main path trust — were evaluated. The concrete findings in both parts of this section are symptoms of this one missing axis.

**Evidence.**
- Audited dimensions: refactor, memory, performance, reliability, testing, duplication, separation, daemon, self-learning — no security.
- `src/main/extensions/registry.ts:307-309` — `loadPowerExtension(manifest, ctx)` on `manifest.main`.
- `src/main/extensions/protocol.ts:39-50` — `registerSchemesAsPrivileged({ standard, secure, supportFetchAPI })`.
- `src/main/extensions/protocol.ts:81` — `protocol.handle('codesurf-ext', ...)`.

**Recommendation.** Add a security pass as a distinct dimension. Minimum scope: (1) the `codesurf-ext://` protocol handler and its traversal defenses, (2) extension power-tier code execution and what manifests can do, (3) secret-storage consistency (keychain vs plaintext settings.json), (4) the localhost proxy's lack of auth, (5) renderer-supplied filesystem-path confinement across all IPC handlers. Treat extension/agent code as semi-trusted, not trusted.

---

### gap-02 — codesurf-relay test suite never executes — declared in vitest, not installed, excluded from `npm test` and CI

**Severity:** high · **Effort:** M · **Category:** testing

**Problem.** `packages/codesurf-relay` — the agent turn-scheduling/message-store core the architecture digest flags as the highest session/cleanup-leak risk — has four test files (`integration` / `runtime` / `markdown` / `validation` `.test.ts`) that never run. Its `package.json` test script is `vitest run`, but vitest is declared only in that package's devDeps (`^1.0.0`) and is not installed (no `node_modules/.bin/vitest`). The root `npm test` uses `node --test` globbing `test/**`, `test/main/**`, `test/sidebar/**`, `test/daemon/**` — it never touches `packages/**`. So the subsystem most likely to leak (per digest: 4 unbounded session Maps, silent mailbox-write failures, unbounded message growth) has zero executed test coverage despite tests existing on disk.

**Evidence.**
- `package.json:22` — `test = node --test test/*.test.ts test/*.test.mjs test/main/*.test.mjs test/sidebar/*.test.mjs test/daemon/*.test.mjs` (no `packages/`).
- `packages/codesurf-relay/package.json:11` — `test = vitest run`; devDeps declare `vitest ^1.0.0`.
- `ls node_modules/.bin/vitest` → not installed.
- Confirmed `test/*.ts` run fine under pinned node (`theme-resolution.test.ts`: 2 pass), so the isolation is cleanly to `packages/`.

**Recommendation.** Either add vitest to the root toolchain and invoke `npm --prefix packages/codesurf-relay test` (or a workspace test target) from the root test script and CI, or port the relay tests to `node:test` under `test/`. Confirm they pass — they may have rotted while never running.

---

### gap-03 — Generation-provider API keys stored plaintext in settings.json while every other provider uses the OS keychain

**Severity:** medium · **Effort:** M · **Category:** security

**Problem.** Image/video generation provider keys (Gemini, OpenAI, Anthropic image, etc.) are stored in `AppSettings.generationProviders[id].apiKey`, persisted via `daemonClient.setSettings` into `~/.codesurf/settings.json` as plaintext. Meanwhile TTS (`tts.ts`), STT (`transcribe.ts`), and `spokify.ts` deliberately route their API keys through the secrets module (Electron `safeStorage` / OS keychain). The SettingsPanel input masks the key with `type=password`, which gives a false impression that the key is protected — at rest it is unencrypted JSON readable by any process or backup with filesystem access. This is an inconsistent and weaker posture for one class of credentials.

**Evidence.**
- `src/shared/types.ts:584` — `generationProviders.gemini.apiKey: ''`.
- `src/renderer/src/components/SettingsPanel.tsx:1406-1407` — `input type=password` bound to `provider.apiKey` → `updateGenerationProvider`.
- `src/main/ipc/workspace.ts:14` — `SETTINGS_PATH = join(CODESURF_HOME, 'settings.json')`; `settings:set` → `daemonClient.setSettings` (plaintext JSON).
- The secrets module is used by `transcribe.ts` / `tts.ts` / `spokify.ts` but NOT for `generationProviders`.

**Recommendation.** Route `generationProviders[*].apiKey` through the same secrets/keychain path used by tts/transcribe/spokify; store only a reference (e.g. a secret name) in settings.json, or encrypt the field. At minimum, document the inconsistency and gate it behind `safeStorage.isEncryptionAvailable()` like the rest.

---

### gap-04 — No CI on pull requests or pushes — tests gate releases, not merges

**Severity:** medium · **Effort:** S · **Category:** ci

**Problem.** `.github/workflows/` contains only `release-on-tag.yml`, triggered on `push: tags v*.*.*` and `workflow_dispatch`. There is no workflow on `pull_request` or push-to-main. The only `npm test` invocation runs at release-tag time, after code is already merged. Broken or regressed code can land on main and only be caught at release. Combined with the relay suite never running anywhere (`gap-02`), the practical pre-merge test coverage of the agent-coordination layer is zero.

**Evidence.**
- `.github/workflows/release-on-tag.yml:4-8` — `on: push tags v*.*.* + workflow_dispatch`.
- `.github/workflows/release-on-tag.yml:71-72` — "Run release gate tests" → `run: npm test`.
- `.github/workflows/release-on-tag.yml:68-69` — install uses `npm ci --omit=optional`.
- `ls .github/workflows/` → only `release-on-tag.yml` exists.

**Recommendation.** Add a CI workflow on `pull_request` and push-to-main that runs `npm ci && npm test && npm run typecheck`. Include the relay/packages tests once wired (see `gap-02`).

---

### gap-05 — Hardcoded developer-machine absolute path shipped in the codesurf-ext:// protocol handler

**Severity:** low · **Effort:** S · **Category:** supply-chain

**Problem.** `extensions/protocol.ts` line 109 hardcodes `/Users/jkneen/clawd/runext/node_modules/@vscode/codicons` as a fallback candidate when serving codicon assets. On any machine other than the original developer's it silently falls through to 404 (functionally harmless), but it ships the developer's username and private directory layout into the distributed binary, and is dead/broken code for all users. It is also a maintenance smell — codicon serving depends on a path that exists on exactly one machine.

**Evidence.**
- `src/main/extensions/protocol.ts:106-110` — `candidates = [ join(codiconBase, ...restSegments), join('/Users/jkneen/clawd/runext/node_modules/@vscode/codicons', ...restSegments) ]`.
- It is the only hardcoded `/Users` path in shipped `src`.

**Recommendation.** Remove the hardcoded `/Users/jkneen/...` candidate; resolve codicons only from the app's bundled `node_modules` (or an env/config override). Add a lint/grep gate in before-build to reject `/Users/` absolute paths in `src/` and `packages/`.

---

### gap-06 — Renderer-supplied workspacePath is unconfined across the IPC filesystem layer

**Severity:** low · **Effort:** M · **Category:** security

**Problem.** `collab.ts` `assertSafeWorkspacePath` only `resolve()`s the incoming path — it does not confine it to any known workspace root. Handlers like `collab:writeObjective` / `writeSkills` / `writeState` `join('objective.md' / 'state.json')` under that arbitrary directory and `fs.writeFile` to it. The `tileId`/`filename` segments are correctly traversal-guarded, but the `workspaceRoot` itself is whatever the renderer passes. This is not unique to collab.ts: `fs.ts`, `canvas.ts`, and most IPC handlers accept a renderer-supplied `workspacePath` as the base. In the current single-trusted-renderer model the blast radius is limited, but a compromised/buggy renderer (or an extension webview that can reach these channels) could write known filenames anywhere the process can write.

**Evidence.**
- `src/main/ipc/collab.ts:31-35` — `assertSafeWorkspacePath = resolve(workspacePath)` with no allowlist check.
- `src/main/ipc/collab.ts:393-398` — `writeObjective` `mkdir + writeFile` under `collabDir(workspacePath, ...)`.
- `tileId` / `filename` are guarded by `assertSafePathSegment` / `resolveInside`, but the `workspaceRoot` is not.

**Recommendation.** Treat this as one cross-cutting observation, not a per-file bug. Introduce a single `assertWorkspaceInsideKnownRoots()` helper that validates `workspacePath` against the daemon's registered workspace list, and apply it in the shared path helpers (`src/main/paths.ts`) so every IPC handler inherits confinement.

---

### gap-07 — job-indexer runs a synchronous filesystem scan of all job files on startup, blocking the main process

**Severity:** low · **Effort:** M · **Category:** performance

**Problem.** `db/job-indexer.ts` uses synchronous fs (`readdirSync`, `readFileSync`, `statSync`) and `ensureInitialJobIndex()` / `indexAllJobs()` scans every job `.json` across workspaces at startup with no pagination or limit. The digest flagged it as a perf-hot/unbounded path but no finding cited it. Sync I/O on the Electron main thread during init blocks the event loop and delays window/IPC readiness proportional to job-history size; it also serializes DB writes behind the scan.

**Evidence.**
- `src/main/db/job-indexer.ts:24` — `import { readdirSync, readFileSync, statSync } from 'fs'`.
- `src/main/db/job-indexer.ts:291` — `jobFiles = readdirSync(JOBS_DIR).filter(...)`.
- `src/main/db/job-indexer.ts:372` — `for (const fname of jobFiles) { ...readFileSync... }`.
- `src/main/db/job-indexer.ts:547` — `ensureInitialJobIndex` → `:558` `indexAllJobs()`. No limit on `jobFiles` or workspace count.

**Recommendation.** Convert the initial scan to `fs.promises`, batch/yield between files, and cap or incrementally index (e.g. most-recent-N per workspace, lazy-fill the rest). Run it after first-window-ready rather than blocking startup.

---

### gap-08 — cluso-embed.js: 2433-LOC vendored minified bundle checked into source, no integrity pin, injected into every browsed page

**Severity:** low · **Effort:** M · **Category:** supply-chain

**Problem.** `src/renderer/src/assets/cluso/cluso-embed.js` is a 2433-LOC minified third-party bundle (React + the cluso annotation toolbar) committed directly to the repo and imported `?raw` into BrowserTile, then injected via `webview.executeJavaScript()` into arbitrary third-party pages after load. There is no provenance record, version pin, build-from-source step, or integrity hash. Updating it means hand-replacing minified code; a supply-chain compromise or accidental edit is invisible to review (it is the largest uncited file and not line-auditable). Injecting it into every page also runs full third-party JS in the context of whatever site the user browses.

**Evidence.**
- `src/renderer/src/components/BrowserTile.tsx:18` — `import clusoEmbedJs from '../assets/cluso/cluso-embed.js?raw'`.
- `src/renderer/src/components/BrowserTile.tsx:1107` — `js: clusoEmbedJs`.
- `src/renderer/src/components/BrowserTile.tsx:1134` — `webview.executeJavaScript(script)`.
- `src/renderer/src/components/BrowserTile.tsx:1180` — second injection site. File is 2433 LOC minified, no version/hash in repo.

**Recommendation.** Track cluso-embed as a pinned, version-recorded build artifact produced from a known source (the `agentation-real` / `cluso-widget` package referenced in `electron.vite.config`), with a checksum recorded in the repo. Document its provenance and the injection surface. Consider gating injection behind explicit per-tile user opt-in rather than every page load.

---

## New risks

Security, supply-chain, and build/config issues that no single dimension owns.

The new-risk critic audited the surfaces dimension auditors structurally miss: trust boundaries, code-execution paths, and cross-cutting correctness. Two findings are critical and exploitable with no user interaction: (1) workspace-scoped "power" extensions auto-activate and run arbitrary Node in the Electron main process simply by opening/cloning a repo that ships a `.contex/extensions/` manifest — a classic RCE-on-clone supply-chain hole; (2) the local MCP HTTP server has no authentication (a token is generated and written to config but never checked), and its `/inject` endpoint writes and submits arbitrary commands into terminal tiles, giving any local process full command execution. Both are amplified by a world-readable `mcp-server.json` (`0o644`, unlike `secrets.json`'s `0o600`).

Lower-severity findings cover `codesurf-file://` exfil via webviews, git option injection, a silent plaintext-secrets fallback, a stale 798KB committed bundle of unclear provenance, and full-cookie-jar injection into untrusted webview partitions. DB migrations and the collab/fs path-traversal guards were checked and are solid.

### Findings

| ID | Title | Severity | Effort | Files |
|----|-------|----------|--------|-------|
| risk-01 | RCE on workspace open: per-workspace power extensions auto-activate without consent | critical | M | `src/main/extensions/registry.ts`, `src/main/extensions/loader.ts`, `src/main/ipc/extensions.ts` |
| risk-02 | Local MCP HTTP server has no authentication; /inject grants arbitrary command execution | critical | S | `src/main/mcp-server.ts` |
| risk-03 | mcp-server.json (port + auth token) is world-readable; secrets.json is 0o600 but this isn't | high | S | `src/main/mcp-server.ts`, `src/main/permissions.ts`, `src/main/secrets.ts` |
| risk-04 | codesurf-file:// privileged scheme is a cross-origin exfil channel reachable from navigated webviews | medium | M | `src/main/file-protocol.ts`, `src/main/index.ts` |
| risk-05 | git branch operations pass user input as argv, enabling git option injection | medium | S | `src/main/ipc/git.ts` |
| risk-06 | Chrome cookie sync injects all site cookies into webview partitions accessible to untrusted pages/agents | medium | M | `src/main/chrome-sync/cookies.ts`, `src/main/chrome-sync/keychain.ts`, `src/renderer/src/components/BrowserTile.tsx` |
| risk-07 | Secrets fall back to plaintext base64 when safeStorage is unavailable, silently | low | S | `src/main/secrets.ts` |
| risk-08 | Stale 798KB bundled index.js committed at repo root with unclear provenance | low | S | `index.js`, `package.json`, `.gitignore` |

---

### risk-01 — RCE on workspace open: per-workspace power extensions auto-activate without consent

**Severity:** critical · **Effort:** M · **Category:** security

**Problem.** `ExtensionRegistry.scanWorkspace()` calls `scanDir(wsDir)` with no `defaultEnabled:false` option. In `loadExtension()`, `defaultEnabled = opts?.defaultEnabled !== false` evaluates to true for workspace dirs, so for any newly-seen extension id (not in `disabledIds`) `_enabled` resolves to true. The loader then runs `loadPowerExtension()` for `tier:'power'` + `main` + `_enabled`, which does `require(join(manifest._path, manifest.main))` — executing attacker-controlled Node code in the Electron **main** process (full fs/network/child_process; contextIsolation does not apply here). `rescan()` / `scanWorkspace()` fires on workspace switch. Net effect: opening or cloning any repository that ships a `.contex/extensions/<x>/extension.json` with `"tier":"power"` and a `"main"` file runs that code with zero user interaction or enable step. Catalog extensions are correctly gated default-off (`scanDir(catalogDir, { defaultEnabled:false })`), but the workspace branch is wide open — exactly the trust-boundary asymmetry a refactor/dup auditor would not catch.

**Evidence.**
- `src/main/extensions/registry.ts:104-106` — `scanWorkspace` → `scanDir`, no `defaultEnabled`.
- `src/main/extensions/registry.ts:274-280` — `_enabled` defaults true for workspace.
- `src/main/extensions/registry.ts:307-316` — `loadPowerExtension` on `_enabled`.
- `src/main/extensions/loader.ts:13-21` — `require()` of `manifest.main`.
- `src/main/ipc/extensions.ts:56` — rescan on workspace switch.
- Contrast `src/main/extensions/registry.ts:100` — catalog scan uses `{ defaultEnabled:false }`.

**Recommendation.** Gate workspace (and global) power-tier extensions behind explicit per-extension user enablement, identical to the catalog flow: pass `{ defaultEnabled:false }` for `scanWorkspace` and require membership in a persisted enabled set (analogous to `enabledCatalogIds`) before `loadPowerExtension` runs. At minimum, never auto-`require()` a power extension discovered inside a workspace dir; show a trust prompt that names the extension id, path, and that it runs unsandboxed Node. Consider signing/pinning bundled extensions and refusing power tier entirely from workspace scope.

---

### risk-02 — Local MCP HTTP server has no authentication; /inject grants arbitrary command execution

**Severity:** critical · **Effort:** S · **Category:** security

**Problem.** `startMCPServer` binds an HTTP server on `127.0.0.1:<random>` but the auth check is explicitly disabled ("Auth check disabled — MCP server is localhost-only"). A bearer token (`MCP_TOKEN`) is generated and written to `~/.codesurf/mcp-server.json` but never validated on any request. Any local process — a malicious npm/postinstall script, a compromised dependency, another user, or any agent on the box — reads the port from that config file and drives the server. `POST /inject` sends `{card_id, message, append_newline=true}` which the renderer writes into the target terminal tile *with* a trailing newline, so the command is submitted to that shell = arbitrary command execution. `POST /push` injects arbitrary renderer events, and `POST /mcp` exposes all 17+ tools (note read/write, kanban mutation, image gen, file open). CORS is wildcard `*` with no Host-header validation, so DNS-rebinding from a visited website is not structurally blocked (weaker vector since the random port is not web-readable, but undefended).

**Evidence.**
- `src/main/mcp-server.ts:1887` — auth-disabled comment, no check.
- `src/main/mcp-server.ts:1991` — `listen` on `127.0.0.1`.
- `src/main/mcp-server.ts:32` and `:2023` — token generated and written to config, but unused.
- `src/main/mcp-server.ts:1922-1953` — `/inject` writes to terminal with `append_newline` default true.
- `src/main/mcp-server.ts:1839-1843` — `Access-Control-Allow-Origin: '*'`.

**Recommendation.** Validate `Authorization: Bearer <MCP_TOKEN>` on every non-OPTIONS request (the token already exists at line 32 and is already written to config). Re-enable the auth gate at line 1887. Restrict CORS to a fixed allowlist / drop the wildcard, and validate the Host header to defeat DNS rebinding. Treat `/inject` and `/push` as privileged: they should require the same token. Keep the `127.0.0.1` binding.

---

### risk-03 — mcp-server.json (port + auth token) is world-readable; secrets.json is 0o600 but this isn't

**Severity:** high · **Effort:** S · **Category:** security

**Problem.** The MCP config containing the server port and the bearer token is written via `fs.writeFile(configPath, ...)` with no mode option, so on a multi-user machine it lands at the default `0o644` — readable by every local account. `secrets.json` correctly uses `mode:0o600`. This both (a) hands the (currently-unchecked) token to any local user and (b) will keep the MCP server trivially drivable by other users even after `risk-02` is fixed by adding token auth, because the token leaks via this file.

**Evidence.**
- `src/main/mcp-server.ts:2034` and `:2089` — `writeFile` with no mode.
- `src/main/secrets.ts:58` — `mode:0o600` reference.
- `src/main/permissions.ts:25-30` — `atomicWriteJson` with no mode either.

**Recommendation.** Write `mcp-server.json` with `{ mode:0o600 }` and `chmod` it on create, matching `secrets.json`. Audit other `~/.contex` / `~/.codesurf` JSON writes (`permissions.json` uses `atomicWriteJson` without mode too) for the same default-permission leak.

---

### risk-04 — codesurf-file:// privileged scheme is a cross-origin exfil channel reachable from navigated webviews

**Severity:** medium · **Effort:** M · **Category:** security

**Problem.** The `codesurf-file://` scheme is registered globally as standard + secure + corsEnabled, and every response sets `access-control-allow-origin: *`. Its only access control is: block files whose first home-dir segment is one of `.ssh` / `.gnupg` / `.aws` / `.config`, and require a known media/document extension. Any other readable file with a whitelisted extension is served — e.g. `~/Documents/contract.pdf`, `~/Desktop/secret.png`, project source renamed `*.svg`. Because the scheme is global with wildcard CORS and `webviewTag` is enabled, a page navigated inside a browser-tile webview can `fetch('codesurf-file:///Users/.../file.pdf')` cross-origin and exfiltrate it. The MIME-extension gate is not a security boundary (attacker controls the extension), and the 4-dir denylist misses `~/.config` siblings like `~/.kube`, `~/.docker`, `~/.netrc`, browser profile dirs, etc.

**Evidence.**
- `src/main/file-protocol.ts:19` — 4-dir denylist.
- `src/main/file-protocol.ts:52-73` — extension + denylist gate.
- `src/main/file-protocol.ts:89-100` — corsEnabled scheme.
- `src/main/file-protocol.ts:118` — `Access-Control-Allow-Origin: '*'`.
- `src/main/index.ts:419` — `webviewTag: true`.

**Recommendation.** Restrict `codesurf-file://` to the trusted main renderer only (do not register it as corsEnabled with `ACAO:*` for webview partitions), OR confine served paths to an explicit allowlist of workspace/media roots rather than a small home-dir denylist. Drop the `access-control-allow-origin: *` header. Stop using file extension as an authorization signal.

---

### risk-05 — git branch operations pass user input as argv, enabling git option injection

**Severity:** medium · **Effort:** S · **Category:** security

**Problem.** `git:checkoutBranch` and `git:createBranch` pass `branchName` straight into `execFile('git', ['checkout', branchName])` / `['checkout', '-b', branchName]`. `execFile` avoids shell-metachar injection, but a `branchName` beginning with `-` is parsed by git as an option, and git checkout/switch have flags with file-writing/side-effecting behavior. The source is the user's own renderer, so this is not remote RCE, but combined with the unauthenticated MCP/peer command surface (`risk-02`, which can drive renderer actions) it is worth hardening.

**Evidence.**
- `src/main/ipc/git.ts:114` — `checkout branchName`.
- `src/main/ipc/git.ts:129` — `checkout -b branchName`. No leading-dash rejection or `--` separator.

**Recommendation.** Insert `--end-of-options` (or use `git switch` / `git switch -c`) before `branchName`, and reject names with a leading `-` or containing control chars. Apply the same to any other `execFile` call that forwards user/agent strings into git argv.

---

### risk-06 — Chrome cookie sync injects all site cookies into webview partitions accessible to untrusted pages/agents

**Severity:** medium · **Effort:** M · **Category:** security

**Problem.** `syncCookiesToPartition` decrypts the full Chrome cookie jar via the Keychain-derived AES-128-CBC key and injects every non-expired cookie — including auth/session cookies for every site the user visits — into the Electron session partition `persist:browser-tile-${tileId}`. Browser tiles then navigate arbitrary attacker-chosen URLs inside that same cookie-populated partition. A malicious or compromised page loaded in a browser tile thus operates as the logged-in user across all synced domains (CSRF-style: same-origin requests carry the injected cookies). Agents driving browser tiles inherit the same authority. This is the user's own data (not a decryption vuln), but the blast radius — full ambient authority handed to untrusted navigations — is a real privacy/security amplification that no dimension auditor would flag.

**Evidence.**
- `src/main/chrome-sync/cookies.ts:90-141` — decrypt all cookies, inject into partition.
- `src/main/chrome-sync/keychain.ts:14-27` — Keychain password via `security find-generic-password`.
- `src/renderer/src/components/BrowserTile.tsx:1427-1428` — `syncCookies` into `persist:browser-tile-${tileId}`.
- `src/renderer/src/components/BrowserTile.tsx:281` — webview partition.

**Recommendation.** Scope cookie injection to explicitly user-approved domains rather than the whole jar; consider per-tile ephemeral partitions cleared on navigation away from trusted origins; warn the user that enabling sync exposes their logged-in sessions to any site/agent that drives the tile. Do not auto-sync the entire cookie store on partition creation.

---

### risk-07 — Secrets fall back to plaintext base64 when safeStorage is unavailable, silently

**Severity:** low · **Effort:** S · **Category:** security

**Problem.** When `safeStorage.isEncryptionAvailable()` returns false (early-boot Linux without a keyring, headless), `setSecret` stores API keys as plain base64 in `plainKeys` within `secrets.json`. The file is `0o600` so it is user-scoped, and this is a documented tradeoff, but there is no user-visible warning that keys are being written effectively in cleartext, and `getSecret` silently swallows decryption failures (returns null), which can mask key-loss vs absence.

**Evidence.**
- `src/main/secrets.ts:79-83` — `plainKeys` fallback.
- `src/main/secrets.ts:87-104` — silent null on decrypt failure.

**Recommendation.** Surface a one-time warning when falling back to `plainKeys` ("API keys stored unencrypted: OS keychain unavailable") and expose encryption status in Settings. Consider refusing to persist secrets unless encryption is available, or re-encrypting `plainKeys` once `safeStorage` becomes ready.

---

### risk-08 — Stale 798KB bundled index.js committed at repo root with unclear provenance

**Severity:** low · **Effort:** S · **Category:** supply-chain

**Problem.** A 798KB esbuild bundle is committed and git-tracked at repo root `/index.js` (last touched by commit `6b302a0` "Add bundled index.js and update configs"). It bundles the Electron main process (contains mcp-server, safeStorage, node-pty, better-sqlite3 references) but is NOT the runtime entrypoint — `package.json` `main` points to `dist-electron/main/index.js` (gitignored), and it does not match the electrobun app bundle. It is unreferenced, unauditable in review, and drifts from source. Build artifacts in VCS are a supply-chain hygiene risk: reviewers cannot diff it meaningfully, and a tampered bundle could ship if anything ever does reference it.

**Evidence.**
- `git ls-files` confirms `/index.js` is tracked (798193 bytes).
- `package.json:6` — `main = dist-electron/main/index.js` (gitignored per `.gitignore:2`).
- `cmp` shows root `index.js` differs from the `build-electrobun` app bundle.

**Recommendation.** Remove `/index.js` from version control and add it (and dist outputs already partially ignored) to `.gitignore`. Confirm nothing references the root bundle. Keep build artifacts out of the repo; produce them in CI.

---

## Not yet audited — residual scope and follow-ups

The new-risk critic verified several adjacent surfaces as solid and explicitly named others it did **not** reach. These are genuine known-unknowns, not clean bills of health, and should seed the next pass.

**Verified solid this pass:** DB migrations (`db/index.ts`, `db/migrations.ts`, `001_bootstrap.ts`) — transaction-wrapped, version-gated, `IF NOT EXISTS`, pre-migration backup. Path-traversal guards in `collab.ts` and `fs.ts` — `assertSafePathSegment` / `resolveInside` reject `..` and escapes; `fs.ts` blocks `..` and sensitive dirs. Terminal spawn allowlist (`terminal.ts`).

**Not deeply audited — declared gaps:**
- **Daemon HTTP router** (`packages/codesurf-daemon/bin/codesurfd.mjs`) — 62 inline local routes with the same localhost-trust / no-auth question as the MCP server. If it binds without auth it likely shares `risk-02`'s class. Highest-priority follow-up.
- **electrobun dual build path** (`src/electrobun/*`, `electrobun.config.ts`, `smoke-electrobun.mjs`) — whether its Bun↔webview RPC re-exposes main-process capability.
- **IPC input validation** across the remaining ~28 `ipc/` handlers beyond git/terminal/secrets/collab/fs/chromeSync (spot-checked, not exhaustive).
- **Migration content of 002–005** — only `001` plus the runner were read in full.
- **`child_process` usage** in `relay/provider-executor.ts` and `session-title-generation.ts` (`execFileSync` with agent-controlled args) — not traced for injection.
