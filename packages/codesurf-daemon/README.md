# @codesurf/daemon

The CodeSurf local HTTP daemon (`codesurfd`) and its process supervisor.

This package is consumed by:

- **collaborator-clone** (Electron desktop app) — adapter at `src/main/daemon/manager.ts`
- **Browser / Native shells** — via `scripts/web-host.mjs` (proxies `/d/*` with auth; see `docs/multi-target.md`)
- **grok-cli / codesurf TUI** — adapter at `src/daemon/manager.ts`

All clients spawn / supervise the same daemon binary and talk to it over an
authenticated localhost HTTP socket. State lives under `~/.codesurf/`.
Electron remains the full-capability host; web/Native use the daemon for the
shared core (workspaces, chat jobs, sessions).

## Layout

```
bin/
  codesurfd.mjs         # the HTTP server entrypoint
  chat-jobs.mjs         # chat job manager (uses @anthropic-ai/claude-agent-sdk)
  checkpoints.mjs       # file-snapshot store
  memory-loader.mjs     # memory / context bucket loader
  skills-index.mjs      # skill discovery & install
  file-references.mjs   # @-mention expansion
  session-index.mjs     # external session indexer
  context-buckets.mjs   # context bucket policy
  project-context.mjs   # project context policy
  instruction-context.mjs
vendor/
  dreaming.mjs          # autonomous research runner (was @codesurf/dreaming)
src/
  *.ts                  # canonical TypeScript APIs and shared policy modules
dist/
  *.js                  # committed NodeNext runtime modules
  *.d.ts                # generated public declarations
test/
  *.test.mjs            # package-owned unit and daemon integration contracts
  helpers/              # package-local process lifecycle harness
  fixtures/             # package-local test data and child processes
```

Production consumers import the package exports, which resolve to `dist/`.
Authored `bin/` modules are package-private implementation; `codesurfd` is the
only executable boundary and is exposed through the manifest's `bin` field.
The package is the source authority for context composition, prompt conventions,
peer policy, and node-tool contracts; host-side files are compatibility facades
only. Build hosts consume `@codesurf/daemon/package-layout`, making this
manifest's `files` and compiled `exports` the single packaging contract instead
of duplicating private directory lists. No root build step writes into this
package. The committed build is verified byte-for-byte before packaging, so
stale generated output fails closed instead of silently shipping. The umbrella
`codesurf` npm artifact bundles this package and promotes its exact runtime
dependencies into the published manifest, so a clean consumer does not rely on
workspace-only dependency hoisting.

## Development

```bash
npm run build          # regenerate dist/ from src/
npm run typecheck      # check the NodeNext source graph without emitting
npm run verify:dist    # prove committed dist/ matches a clean compilation
npm test               # verify the package contract and packaged runtime
```

From the repository root, `npm run check:daemon-interface` compares the live
recursive feature surface with `contracts/recursive-interface.json`. Intentional
interface changes require the explicit `npm run update:daemon-interface`
command. Set `FEATURES_BIN=/absolute/path/to/features` when the `features` CLI is
not on `PATH`.

## Usage (host adapter)

```ts
import { createDaemonManager } from '@codesurf/daemon/manager'
import { createDaemonClient } from '@codesurf/daemon/client'
import { CODESURF_HOME } from '@codesurf/daemon/paths'

const manager = createDaemonManager({
  homeDir: CODESURF_HOME,
  getAppVersion: () => '1.2.3',
  resolveDaemonScriptPath: () => /* path to bin/codesurfd.mjs */,
})

const daemonClient = createDaemonClient({
  ensureRunning: manager.ensureDaemonRunning,
  getStatus: manager.getDaemonStatus,
  invalidate: manager.invalidateDaemonCache,
})

await daemonClient.listWorkspaces()
```

## Codex Execution Providers

Daemon-backed Codex jobs use the native `codex exec` CLI path by default. That
path remains the shipping baseline because it supports CodeSurf's config
isolation flag (`--ignore-user-config`).

The official `@openai/codex-sdk` provider is available as an opt-in daemon
backend. It maps CodeSurf's Codex permission modes onto the SDK's
`sandboxMode`/`approvalPolicy` options and resumes multi-turn jobs with
`resumeThread(request.sessionId)`.

Enable it with either:

```json
{
  "settings": {
    "codex": {
      "executionProvider": "sdk"
    }
  }
}
```

or:

```bash
CODESURF_CODEX_PROVIDER=sdk codesurfd
```

`CODESURF_CODEX_SDK=1` is also accepted. `CODESURF_CODEX_PROVIDER=cli` forces
the default CLI provider. The SDK currently does not expose a
`--ignore-user-config` equivalent; keep the CLI provider for runs that require
isolated Codex config.
