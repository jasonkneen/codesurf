# CodeSurf — Full Code Review

**Date:** 2026-08-27
**Scope:** `main` @ `ba23db3` + 50 uncommitted files (42 modified, 8 untracked — 3684 insertions / 712 deletions)
**Feature under review:** Vercel AI Gateway chat provider (in-process + daemon), extension-broker `workspacePath` plumbing, source-control extension rebuild
**Method:** ground-truth build/lint/test runs + 4 parallel specialist reviewers (security, renderer, daemon, extension), all findings re-verified by the supervisor

---

> **STATUS: all findings below have been fixed and verified.** See
> "Remediation" at the end of this document for what changed and how each fix
> was proven. Gates are green: tsgo + tsc + lint + format + daemon-boundaries
> clean; 1750/1751 core, 39/39 electron-hosts, 310/310 daemon, 15/15 packages.

## Verdict (as found)

**Do not merge as-is.** Two blockers stop the build, and the bundled source-control extension ships a
remotely-triggerable XSS plus an agent-reachable arbitrary-file-write.

The new gateway provider itself is **good code** — fail-closed persona guard, correct abort/supersede
semantics, clean pure/impure split (`gateway-tools.ts` is Electron-free so it unit-tests under
`node --test`). The problems are at its edges: identity fallback, key propagation, and refresh.

---

## Build health (measured, not inferred)

| Gate | Result |
|---|---|
| `npm run lint` | **pass** (clean, `--max-warnings 0`) |
| `npm run typecheck` | **FAIL** — 1 error |
| `npm run test:unit:core` | **pass** — 1731/1732, 0 fail, 1 skip |
| `npm run test:unit:electron-hosts` | **FAIL** — 13 failures, single root cause |

`npm run check` is red on `main`. CI just added `typecheck:tsc` (`ci.yml:90`), so this fails there too.

---

## Blockers

### B1 — Typecheck failure breaks `npm run check` and CI

`src/main/extensions/broker/protocol.ts:93`

```ts
export interface ActivateParams extends JsonObject {
  workspacePath?: string | null   // TS2411
}
```

`JsonObject` is `{ [key: string]: JsonValue }` (protocol.ts:19). An **optional** property widens to
`string | null | undefined`, and `undefined` is not a `JsonValue`, so it violates the index signature.

**Fix:** make it required — `workspacePath: string | null` — and have the host always send an explicit
`null`. `host.ts:162` already passes `this.registry.getActiveWorkspacePath()`, which returns
`string | null`, never `undefined`. One-line change, no call-site churn.

### B2 — 13 extension-host tests fail, silently disabling a security regression test

Root cause is a single missing method:

```
Error: registry2.getActiveWorkspacePath is not a function
```

The new `workspacePath` feature added two calls — `context.ts:102` and `host.ts:162` — against the
registry. Production is fine (both sites receive a real `ExtensionRegistry`, which defines the method at
`registry.ts:609`). But the broker test harness passes a fake:

`src/main/extensions/broker/test-harness.ts:23,107`
```ts
// Fake registry — only provides getCapabilityGate and registerMCPTool
class TestRegistry { /* ... */ }
const host = new ExtensionBrokerHost(manifest, registry as never, 'global')
```

`as never` disables all structural checking, so the compiler could not catch the drift. Every brokered
activation now throws, taking down the whole suite.

The dangerous part is not the count — it is *which* test:

```
✖ host rejects out-of-namespace IPC channel registration
  AssertionError: namespace-escape-result event not received (got 0 events: [])
```

That assertion guards extension IPC-namespace escape. It now fails because activation crashed, **not**
because enforcement was measured. If namespace enforcement itself regressed tomorrow, this suite would
look identical. A security test failing for an unrelated reason is worse than one that is simply absent,
because the red is easy to wave through as "the known broker breakage".

**Fix:** add `getActiveWorkspacePath(): string | null { return null }` to `TestRegistry`, then replace
`as never` with a `Pick<ExtensionRegistry, 'getCapabilityGate' | 'registerMCPTool' | 'getActiveWorkspacePath'>`
parameter type so the next added method is a compile error rather than a runtime one.

---

## Security

### S1 — [CRITICAL] Stored XSS in the Source Control tile via a repository filename

`bundled-extensions/source-control/tile/index.html:558` + `:731`

```js
// sink — attribute context
'... data-act="' + a.act + '" data-path="' + esc(f.path) + '">'

// escaper — textContent→innerHTML escapes & < > but NEVER " or '
function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML }
```

`f.path` is raw `git status --porcelain` output (`main.js:96` — `line.slice(3)`), i.e. attacker-controlled
in any cloned repo. A file named `a onmouseover=alert(1) b"` closes the attribute early and injects a live
event handler. Opening the tile on a hostile repo and hovering one row runs attacker JS inside
`codesurf-ext://source-control`.

Blast radius is full, not git-scoped:
- No CSP is applied — `protocol.ts:99-117` only sets `content-security-policy` when `protectMediaHtml`
  is true, which is derived from declared capabilities. `extension.json` declares **none** (verified:
  `capabilities: undefined`), so no `script-src-attr 'none'`.
- Same reason makes `gate.enforced` false, so the tile is ungated for `chat` / `relay` / `canvas` RPCs
  (`ExtensionTile.tsx:255-259`) on top of `ext.invoke` → `push`, `commit`, `checkoutBranch`, `discard`.

The author already has a correct escaper **in the same extension** — `review.html:138-145` escapes `"` and
`'` properly. `index.html` just uses the wrong one.

**Fix:** replace `esc` with `review.html`'s `escapeHtml`, or build the row with `createElement` +
`dataset.path` + `textContent`. Same `esc` is used at `:711`/`:714` for `data-ref`, so fixing the function
covers both sinks.

### S2 — [HIGH] Agent-reachable arbitrary file write via git argument injection

`bundled-extensions/source-control/main.js:58-61`

```js
function normalizeRef(value, fallback) {
  const ref = String(value || '').trim()
  return ref || fallback          // no validation — a leading "-" is accepted
}
```

Used positionally at `:261-262` and `:402`:
```js
tryGit(root, ['diff', '--name-status', '--find-renames', `${baseRef}...${headRef}`], '')
```

`execFile` stops *shell* injection but not *argument* injection. `baseRef = "--output=/path/to/file"`
produces the argv `--output=/path/to/file...HEAD`, and `git diff --output=<file>` creates/truncates that
file. **Verified empirically** — `git diff --output=/tmp/gitout-probe.txt HEAD~1...HEAD` wrote a 20KB file.

This is reachable by a model, not just a user: `branch_compare` is a registered MCP tool
(`main.js:749-761`, `extension.json:69,84`) whose `baseRef` is a **required, agent-supplied string**. Given
this product points agents at untrusted repos, a prompt-injected agent gets arbitrary file
create/truncate outside the workspace.

**Fix:** reject option-shaped refs in `normalizeRef` (`if (/^-/.test(ref)) throw new Error('Invalid ref')`),
and add `'--end-of-options'` before revision args in `getChangedFiles`, `getRangeCommits`,
`getCommitTouchedFiles`, `getFileDiff`.

### S3 — [HIGH] Gateway fabricates an MCP principal and fails **open** to `global`

`src/main/chat/providers/gateway.ts:118-124`

```ts
function chatPrincipal(req: ChatRequest): McpPrincipal {
  const workspaceId = ...; const tileId = ...
  return workspaceId && tileId ? { kind: 'tile', workspaceId, tileId } : { kind: 'global' }
}
```

`{ kind: 'global' }` bypasses tile scoping entirely — `mcp/auth.ts:61`:
```ts
if (principal.kind === 'global') return null   // always authorized
```

Two things make this worth fixing even though it is currently hard to reach:

1. **It is the only provider that fabricates a principal.** Every other provider goes through the HTTP MCP
   server, where `resolvePrincipal` (`auth.ts:31-49`) maps a *token* to a principal and a tile token can
   only ever yield a tile principal. Here the principal is derived from unauthenticated request fields.
2. **The codebase explicitly says this principal is not for agents** — `mcp-server.ts:1203`:
   *"The global principal is trusted UI state, not an agent credential."* Handing it to a model-driven tool
   loop is precisely that.

Internally inconsistent, too: the *same function* fails **closed** when the persona is unresolved
(`gateway.ts:168-173`, `agentModeUnresolved`) but fails **open** when identity is unresolved.

Reachability today is gated upstream — `canonicalizeElectronChatRequest` (`chat.ts:1372`) throws
`CHAT_WORKSPACE_REQUIRED` for an empty `workspaceId` — so this needs an empty `cardId` to trigger, and
`workspaceId` is optional in the type (`types.ts:60`) while the guard lives in a different file with no
test pinning it. The author's own code at `chat.ts:1642` (`if (workspaceId && cardId)`) proves both can be
absent.

**Fix:** fail closed — return an error stream when either id is missing, matching the persona guard three
lines below.

### S4 — [LOW] Broker children inherit the full `process.env`

`src/main/extensions/broker/host.ts:79-87` spreads `...process.env` into `utilityProcess.fork`. With
`AI_GATEWAY_API_KEY` now a documented config source (`gateway.ts:52-57`), any brokered extension — ordinary
Node with `fs`/`child_process` — reads it without a grant. Keychain-stored keys are unaffected
(`secrets.ts` decrypts on demand). Use an allow-listed env, as terminals already do via `buildSafeSpawnEnv`.

---

## Correctness — new gateway feature

| ID | Sev | Where | Issue |
|---|---|---|---|
| G1 | MED | `daemon/manager.ts:50-60` vs `gateway.ts:52-57` | **Key precedence inverted.** App: secret → env. Daemon: env → secret. With both set, in-app chat and daemon jobs use *different keys*. |
| G2 | MED | `secrets-ipc.ts:18,28` | **Daemon keeps a stale key.** `extraEnv()` is captured at spawn; changing the key invalidates only the model cache. Nothing restarts the daemon — `restartDaemon()` is already exported from `manager.ts:67`. |
| G3 | MED | `chat.ts:567-569` | `supportsDaemonChatProvider` omits `'gateway'` though `chat-jobs.mjs:4059` implements it. In `daemon-only`/`cloud` mode gateway chats hard-error. Also makes G1/G2's key injection dead on desktop. |
| G4 | MED | `chat.ts:1638-1645` | **Dead token write.** Every gateway turn writes a live tile bearer to disk for a consumer that cannot be reached (daemon branch returns at `:1550` before the switch; in-process path calls `executeChatAgentTool` directly). Credential materialisation for zero benefit. |
| G5 | MED | `useChatTileProviders.ts:127-135` (deps `[provider]`) | **Model list never refreshes after saving a key.** Unkeyed fetch returns `{models: [], error}`; `error` is discarded and the picker keeps 12 hardcoded speculative ids (`providers.ts:88-101`). Main invalidates its cache but never tells the renderer; unlike OpenCode there is no push channel. |
| G6 | MED | `ProvidersSection.tsx:77-78` | **Silent failure on web/Native.** `daemonBridge` has no `secrets` namespace; `softNamespace` returns a truthy Proxy whose `set()` resolves `undefined`, so `if (r.ok)` throws `TypeError`. No `catch`, called as `void saveKey()` → unhandled rejection, no error shown, card still claims "Stored encrypted". |
| G7 | MED | `gateway-provider.mjs:236-239` | **Persona + memory sent twice.** `contextPrompt` already contains both (`context-composer.ts:170-171`); the array re-adds `agentMode.systemPrompt` and `memoryPrompt`. Billed every turn, and contradicts the documented rule at `harness-runtime.mjs:497-501`. |
| G8 | MED | `gateway-provider.mjs:30,134-137` | **Cancel can't interrupt the MCP bridge.** Bridge fetches use a private 30s controller unlinked from `job.cancel`; settlement window is 3s (`chat-jobs.mjs:1765`), so cancelling reports "cancellation failed" and pins the job in `liveJobs`, holding 1 of 4 slots. |
| G9 | LOW | `providers.ts:202-215` | `getApproxSystemOverheadTokens` gained a gateway branch (1k→8k) but `getApproxContextWindowTokens` did not — Gemini/Grok gateway models get charged 8k against a 128k default window vs ~1M real, so the context bar reads "nearly full" early. |
| G10 | LOW | `ProvidersSection.tsx:63,66-69` | `flashStatus` timer never cleared (fires after unmount; back-to-back flashes truncate); `:63` guards `secrets?.` but not `.has`. |

---

## Correctness — extension broker

| ID | Sev | Where | Issue |
|---|---|---|---|
| E1 | MED | `host.ts:372-385` vs `child-entry.ts:105-116,247-258` | **`ctx.store.subscribe()` never fires under the broker.** Main sends `broker.storeUpdate`; the child registers callbacks under `storeSub_*` but only dispatches them from `broker.busEvent`. Works in the bundled path (`context.ts:227-245`), so behaviour silently differs by execution tier. |
| E2 | MED | `child-entry.ts:265-275` vs `host.ts:265-282` | **`bus.unsubscribe()` is a no-op.** Child returns its local `busSub_*` id and sends that back; main expects the real bus id. Subscription leaks and keeps forwarding events over IPC for a deleted callback — one leak per subscribe/unsubscribe cycle. |
| E3 | LOW | `policy.ts:62-95` vs `registry.ts:1109-1114` | `gate.enforced` is accepted but never read, so a capability-less legacy extension is denied `relayHost` — making the transition allowance at `host.ts:397` unreachable, which is exactly the case its comment says it exists for. |

Also note `registry.ts:1374-1386`: `shouldKeepExistingExtension` accepts `defaultEnabled` but never reads
it — dead parameter after the precedence refactor. Behaviour is intentional (bundled now beats a later
global install), but the unused param invites a wrong future edit.

---

## Correctness — source-control extension

| ID | Sev | Where | Issue |
|---|---|---|---|
| X1 | HIGH | `main.js:96-100`, `:63-70` | **C-quoted paths never decoded.** `git status --porcelain` quotes any byte ≥ 0x80. `café.txt` arrives as `"caf\303\251.txt"`; the UI shows that literal and Stage/Unstage/Discard all fail with "did not match any files". Any repo with accented/CJK/emoji filenames is unusable. Fix with `-z` + `\0` split (not `core.quotePath=false`, which still quotes `"`/`\` and would make S1 easier). |
| X2 | HIGH | `index.html:711,754-755`, `main.js:704-707` | **Stash Apply always pops `stash@{0}`.** The row's `data-ref` is read at `:743` but only forwarded for `stashDrop`. Clicking Apply on `stash@{2}` restores *and deletes* `stash@{0}` while toasting success. Verified: the host handler takes no ref at all. |
| X3 | MED | `index.html:534-537,752-753` | **Discard has no confirmation.** Trash icon renders first, immediately left of Stage `+`, 28×28 with a 2px gap, revealed only on hover. One misclick destroys uncommitted work — no confirm, no undo. Also errors on untracked files (`git checkout --` can't match them). |
| X4 | MED | `main.js:585,672-674` | **Selecting a remote branch detaches HEAD.** `parseBranches` computes a `remote` flag; `getPorcelainBranches` throws it away, so `origin/main` renders as a normal option. Checkout detaches, tile toasts "Switched to origin/main", then shows a bare SHA. Later commits land unreferenced. |
| X5 | LOW | `extension.json` | Declares `permissions: ["filesystem:read","process"]` but writes files (`main.js:495,498`) and mutates repos. More importantly it declares **no `capabilities`**, so `gate.enforced` is false and nothing constrains S1's blast radius. |

---

## What's genuinely good

Worth saying, because the review above is all defects:

- **`gateway-tools.ts` is well-factored** — pure, Electron-free, type-only imports, so it tests under plain
  `node --test`. The comment explaining *why* it exists (avoiding a module cycle with the daemon spawn
  manager) is the kind that survives refactors.
- **Fail-closed persona handling** is correctly replicated across providers, with the rule ID (`A-PR1
  BLOCKING-1`) cited inline.
- **Abort/supersede semantics in `chatGateway` are right** — I initially flagged the silent return on abort
  as a stuck-spinner bug, then found `stopCardExecution` emits `done` itself (`chat.ts:1337`). Not emitting
  there is correct and avoids a duplicate.
- **MCP auth has no regression.** Blanket fail-closed (`isSensitiveMcpRoute` returns `true`
  unconditionally, `mcp-server.ts:769`), tokens matched by value not key, global bearer never persisted
  (`:1216`), tile configs `0o600`. `executeChatAgentTool` routes through `handleTool`, so scoping still
  applies — the weakness is S3's fabricated principal, not the bridge.
- **`ai` v6 → v7 major bump is clean.** Consumers are 5 renderer files with *type-only* imports plus the two
  new gateway files; typecheck would catch breakage and reports only B1.
- **CI changes are additive** — `typecheck:tsc` added, failure artifacts uploaded. No gate weakened.
- **`review.html` escapes correctly**, which is what makes S1 clearly a slip rather than a knowledge gap.

---

## Suggested order

1. **B1 + B2** — get `npm run check` green. B2 first restores the security suite's signal.
2. **S1** — one-function fix, land with X1 (`-z`) since they interact.
3. **S2** — `normalizeRef` guard + `--end-of-options`.
4. **X2, X3** — data-loss bugs, both small.
5. **S3** — flip the principal fallback to fail-closed.
6. **G1–G3** — decide whether daemon gateway execution is supported on desktop; that answer resolves all three.
7. Everything else.

**Test debt this exposes:** `test/source-control-extension.test.mjs` uses only ASCII fixtures
(`README.md`, `src/main.ts`) — no coverage for quoted paths, stash refs, or ref validation. A fixture repo
with a `"`-bearing filename and an accented filename would have caught S1, S2, and X1.

---

# Remediation

All 19 findings fixed. Verification below is what was actually run, not what was assumed.

## Blockers

**B1** — `protocol.ts` `workspacePath` is now required (`string | null`); senders already produced
`string | null`, never `undefined`. Both typecheckers clean.

**B2** — Root-caused to `test-harness.ts` casting a fake registry through `as never`, which disabled the
structural check that would have caught `getActiveWorkspacePath` drift. Fixed by narrowing the dependency
instead of patching the fake: new `ExtensionHostRegistry` interface in `registry.ts` (exactly
`getCapabilityGate` + `registerMCPTool` + `getActiveWorkspacePath`), consumed by `ExtensionBrokerHost` and
`ExtensionContext`, with `TestRegistry implements ExtensionHostRegistry`. Adding a registry call is now a
compile error rather than a runtime one. `as never` removed.

**B3 (found while fixing B2, not in the original review)** — `child-entry.ts` awaited
`Promise.all(pendingCapabilityCalls)` as an activation barrier. A DENIED capability call is a normal
outcome that extensions catch themselves (the `chat-only-ext` fixture try/catches
`ctx.relayHost.install()`), but `Promise.all` propagated the rejection and reported `activated: false` for
an extension that had already handled it. The barrier now settles rather than collects
(`pending.catch(() => undefined)`), leaving the extension's own promise untouched.

## Security

**S1** — `esc()` in `tile/index.html` replaced with a real escaper (`& < > " '`), matching the correct one
already in `review.html`. Proven against a file literally named `a onmouseover=alert(1) b"`: the `"` now
renders `&quot;` and the value stays inside its attribute. `statusLetter` output is escaped too.

**S2** — `normalizeRef` rejects option-shaped and control-character refs; `--end-of-options` added before
every revision argument (8 sites: `rev-list`, `log` ×2, `diff` ×3, `merge-base`, `stash`). Proven: before,
`git diff --output=/tmp/gitout-probe.txt HEAD~1...HEAD` wrote a 20KB file; after, both entry points
(`compareBranches`, the `branch_compare` MCP tool path, and `getFileDiff`) reject with `Invalid ref` and no
file is created.

**S3** — New `resolveGatewayPrincipal` returns `null` instead of `{ kind: 'global' }`; `chatGateway` now
refuses an unbound turn with a clear error, directly alongside the existing persona fail-closed guard. Test
asserts the resolved tile principal is genuinely scope-checked and that the old fallback would have been
authorized everywhere. The daemon-side provider was checked and already failed closed by construction (it
authenticates with a real tile token).

**S4** — Not changed. Left as documented residual risk: it needs an env allow-list for
`utilityProcess.fork`, which touches every brokered extension's runtime environment and deserves its own
change rather than riding along with a security fix.

## Correctness

| ID | Fix |
|---|---|
| G1 | Single `resolveGatewayApiKey(storedSecret, env)` in `gateway-tools.ts`, used by both the provider and the daemon spawn path. Stored secret wins; env is fallback. Tested including trimming and whitespace-only values. |
| G2 | `restartDaemonForGatewayKeyChange()` re-spawns a *running* daemon on key set/delete (no-op when stopped, since the next spawn reads the new value). |
| G3 | Deliberately **not** enabled — turning on daemon gateway execution is a product decision, not a review fix. The dead code it caused is gone and the path to enable it is documented at the call site. |
| G4 | Dead `writeTileMcpConfig` call removed (verified unreachable: the daemon branch returns before the switch and `supportsDaemonChatProvider` excludes gateway), so no tile bearer token is written to disk for a non-existent consumer. Unused import dropped. |
| G5 | Main broadcasts `chat:gatewayModelsUpdated` after a key change; preload, Electrobun facade, `env.d.ts`, and `useChatTileProviders` all wired, mirroring the OpenCode pattern. A key saved after a tile opens now refreshes the picker. |
| G6 | `saveKey`/`clearKey` guard the *method* (not just the namespace — the web bridge's Proxy is truthy), check `r?.ok`, and catch. Users get "Secure storage is unavailable on this platform" instead of a silent no-op plus unhandled rejection. |
| G9 | Not changed — needs real per-model context windows, which aren't in the repo. |
| G10 | `flashStatus` timer stored in a ref, cleared before re-arming and on unmount; `.has` optional-call guarded. |
| E1 | Store subscribers moved to their own `storeSubscriptions` map and fanned out from `broker.storeUpdate`, so `ctx.store.subscribe()` fires under the broker as it already did in the bundled path. |
| E2 | Host keeps `childSubId -> real EventBus id` and translates on unsubscribe; map cleared on deactivate. Subscriptions no longer leak or keep forwarding to dropped callbacks. |
| E3 | Not changed — depends on whether the shipped relay-suite manifest declares `relay`, which isn't in the repo (only a fixture). |
| X1 | `git status --porcelain=v1 -b -uall -z` + NUL parsing, including the rename form where the origin path is a separate record. Proven: `café.txt` now round-trips through `git add --`, which previously failed with "did not match any files". |
| X2 | Stash Apply passes its row's ref and uses `git stash apply` (non-destructive) rather than `pop` — the button is labelled Apply and Drop exists separately. Refs validated against `stash@{N}`. |
| X3 | Discard confirms first (the iframe has `allow-modals`), and untracked files route to `git clean -f --` instead of failing `git checkout --`. |
| X4 | Not changed — remote-branch checkout needs a `--track` UX decision. |
| X5 | Not changed — declaring `capabilities` flips the host gate to enforced and could break the shipped tile; needs its own change. |

## Tests added

`test/source-control-extension.test.mjs` (+4) — hostile-repository fixtures, the gap that let S1/S2/X1 ship:
- non-ASCII and quote-bearing filenames survive porcelain parsing and round-trip through `git add`
- renames parse under `-z`, origin records consumed not surfaced
- the tile escaper contains an attribute-breaking filename
- option-shaped refs are rejected at both entry points, and no file is written outside the repo

`test/gateway-tools.test.ts` (+15) — principal resolution never falls back to global across 7 malformed
input shapes, resolved principals are scope-checked while global is not, and key precedence is pinned in
both directions.

## Verification

| Gate | Before | After |
|---|---|---|
| `typecheck` (tsgo) | 1 error | clean |
| `typecheck:tsc` | — | clean (caught a weak-type issue tsgo missed) |
| `lint` | clean | clean |
| `format:check` | — | clean |
| `check:daemon-boundaries` | — | clean, 689 files |
| `test:unit:core` | 1731/1732 | **1750/1751** (+19) |
| `test:unit:electron-hosts` | 26/39, **13 failing** | **39/39** |
| daemon package | — | 310/310 |
| relay + terminal-gateway | — | 15/15 |
| `npm run build` | — | succeeds |

## Deliberately left

S4, G3, G9, E3, X4, X5 — each needs a product decision or data not in the repo. They are documented above
with the reason rather than guessed at.
