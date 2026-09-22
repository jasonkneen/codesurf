# CodeSurf terminal gateway

`@codesurf/terminal-gateway` is the small, deployable terminal broker used by
CodeSurf's Native wrapper and hosted web application. It is deliberately **not
a generic CORS proxy**. It accepts a short, authenticated request to create a
tenant-scoped terminal session, then upgrades a separate WebSocket using a
single-use attachment token.

The package has two adapters:

- `local` (default) starts a real `node-pty` process. Use it only for the
  trusted loopback Native sidecar.
- `docker` starts an isolated Docker container for each authenticated terminal
  session. It is disabled unless explicitly enabled and is the appropriate
  starting point for a hosted web deployment.

## Install and run

The package is self-contained and can be run directly from this repository:

```sh
npm --prefix packages/codesurf-terminal-gateway install
npm --prefix packages/codesurf-terminal-gateway start
```

It intentionally fails closed when its tenant mapping, filesystem roots, or
origin allowlist are absent. No token is accepted in a URL query parameter.

## Native sidecar configuration

The Native wrapper starts this on loopback and reads a short-lived runtime
config file. The static tenant mapping must still name every filesystem root
that the sidecar is allowed to open.

```sh
export CODESURF_TERMINAL_GATEWAY_BIND=127.0.0.1
export CODESURF_TERMINAL_GATEWAY_PORT=0
export CODESURF_TERMINAL_TOKEN="$(openssl rand -base64 32)"
export CODESURF_TERMINAL_ALLOWED_ORIGINS='zero://app'
export CODESURF_TERMINAL_TENANTS_JSON='{
  "native": {
    "roots": ["/absolute/path/to/allowed-workspaces"]
  }
}'
export CODESURF_TERMINAL_RUNTIME_CONFIG_PATH="$TMPDIR/codesurf-terminal-gateway.json"

npm --prefix packages/codesurf-terminal-gateway start
```

Once listening, the gateway atomically writes this file with mode `0600`:

```json
{
  "endpoint": "http://127.0.0.1:49321",
  "token": "the-sidecar-bearer-token"
}
```

`CODESURF_TERMINAL_TOKEN` supplies the `native` tenant's bearer token when
that tenant does not set `bearerToken` itself. It is also the only token the
runtime config file can safely expose. The sidecar/web host must read that file
locally; never serve it as an app asset or log its contents.

If a tenant explicitly has `bearerToken`, it must equal
`CODESURF_TERMINAL_TOKEN` whenever that runtime token is set; mismatches fail
at startup rather than writing an unusable credential file.

The custom scheme must provide the explicit `Origin: zero://app` configured
above. A `null` origin is intentionally rejected.

## Hosted web deployment

Put the gateway behind a TLS reverse proxy and configure its public HTTPS URL.
The browser receives `wss://…` in the session response, while the gateway can
continue to bind to loopback or a private network interface.

```sh
export CODESURF_TERMINAL_GATEWAY_BIND=127.0.0.1
export CODESURF_TERMINAL_GATEWAY_PORT=8787
export CODESURF_TERMINAL_PUBLIC_URL=https://terminals.example.com
export CODESURF_TERMINAL_ALLOWED_ORIGINS=https://app.example.com
export CODESURF_TERMINAL_ADAPTER=docker
export CODESURF_TERMINAL_ENABLE_DOCKER=1
export CODESURF_TERMINAL_DOCKER_IMAGE=codesurf-terminal-sandbox:2026-07
export CODESURF_TERMINAL_TOKEN="$(openssl rand -base64 32)"
export CODESURF_TERMINAL_TENANTS_JSON='{
  "acme": {
    "roots": ["/srv/codesurf/tenants/acme"],
    "workspaces": {
      "workspace_123": "/srv/codesurf/tenants/acme/project"
    }
  }
}'
```

For a browser deployment, keep the long-lived bearer token in a trusted
CodeSurf web backend or authenticated reverse proxy. The browser can call a
same-origin application route such as `/api/terminal/sessions`; that trusted
route validates the user's normal app session, forwards the request to
`POST /v1/terminal/sessions`, and injects the tenant bearer server-side. Do
**not** bundle `CODESURF_TERMINAL_TOKEN` into browser JavaScript. The browser
only receives the short-lived, one-use `attachToken` after its normal
application session has been authorized.

`CODESURF_TERMINAL_PUBLIC_URL` is required whenever TLS terminates upstream;
without it the gateway can only infer an unproxied `ws://` URL from the request
host.

### Reverse proxy requirements

Proxy both the HTTP creation path and WebSocket attachment path. The proxy
must preserve `Origin`, support upgrades, and terminate TLS. For example,
inside a TLS-enabled nginx `server` block:

```nginx
location /v1/terminal/ {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Origin $http_origin;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

Restrict network access so only this proxy reaches the private gateway port.
The gateway's CORS allowlist is an additional browser control, not a substitute
for application authentication, TLS, rate limiting, or perimeter policy.

## Docker sandbox adapter

Build the supplied minimal sandbox image, then extend it only with CLIs that
your tenants are permitted to run:

```sh
docker build \
  -f packages/codesurf-terminal-gateway/deploy/sandbox.Dockerfile \
  -t codesurf-terminal-sandbox:2026-07 \
  packages/codesurf-terminal-gateway
```

For every authenticated terminal session, the Docker adapter creates one
short-lived PTY-backed container. Tenants never share a container. It mounts
only the resolved tenant/workspace root and starts in the resolved `cwd`.
Unknown CodeSurf `workspaceId` values do not grant access: they fall back to
the tenant-root check for `cwd`. A configured matching `workspaceId` narrows
the directory scope further.

The adapter enforces these Docker arguments:

- `--network none`
- `--read-only` root filesystem and a bounded writable `/tmp` tmpfs
- `--cap-drop ALL` and `no-new-privileges`
- PID, memory, and CPU limits
- an explicit unprivileged UID/GID (override with
  `CODESURF_TERMINAL_DOCKER_USER` only when necessary)

The workspace bind mount is writable because an interactive development CLI
needs to edit files. Use tenant roots that contain no other tenants or host
secrets. The gateway process itself needs permission to invoke Docker, which
is highly privileged; do not expose the Docker socket to the sandbox container
and do not run an unreviewed gateway configuration on a shared host.

The Docker adapter remains disabled unless all three are set:

```sh
CODESURF_TERMINAL_ADAPTER=docker
CODESURF_TERMINAL_ENABLE_DOCKER=1
CODESURF_TERMINAL_DOCKER_IMAGE=codesurf-terminal-sandbox:2026-07
```

Useful optional limits are `CODESURF_TERMINAL_DOCKER_MEMORY` (default `1g`),
`CODESURF_TERMINAL_DOCKER_CPUS` (default `1`), and
`CODESURF_TERMINAL_DOCKER_PIDS_LIMIT` (default `256`). The adapter never
enables container networking.

## HTTP and WebSocket protocol

Create a session with an authenticated JSON request:

```http
POST /v1/terminal/sessions
Authorization: Bearer <tenant bearer>
Origin: https://app.example.com
Content-Type: application/json

{"cwd":"/srv/codesurf/tenants/acme/project","workspaceId":"workspace_123","cols":120,"rows":36}
```

`cols` must be 20–500 and `rows` 5–300. `cwd` must resolve to an existing
directory under a configured tenant root. `workspaceId` is optional CodeSurf
metadata, never a filesystem path.

Chat terminal mode can request a provider CLI that resumes the chat session in
the terminal. The request carries a bare allowlisted binary and argv only; the
gateway validates the provider-specific grammar and never invokes a shell:

```json
{"cwd":"/srv/codesurf/tenants/acme/project","workspaceId":"workspace_123","launchBin":"claude","launchArgs":["--resume","session-id"]}
```

Supported launch binaries are `claude`, `codex`, `opencode`, `openclaw`,
`hermes`, and `pi`. Session identifiers are bounded to safe ASCII characters;
provider flags are fixed (`--resume`, `resume`, `--session`, or `tui`) and
unknown binaries or argument shapes are rejected before a process starts.

The `201` response is exactly:

```json
{
  "sessionId": "uuid",
  "attachToken": "one-time-random-token",
  "websocketUrl": "wss://terminals.example.com/v1/terminal/attach"
}
```

`websocketUrl` never contains a credential or query token. Connect with the
same allowed `Origin`, then make this the first text frame:

```json
{"type":"attach","attachToken":"one-time-random-token"}
```

The server emits:

```json
{"type":"ready","sessionId":"uuid","cols":120,"rows":36}
{"type":"data","data":"terminal bytes as text"}
{"type":"exit","exitCode":0,"signal":null}
```

After `ready`, the client may send:

```json
{"type":"write","data":"pwd\r"}
{"type":"resize","cols":160,"rows":48}
{"type":"close"}
```

Malformed requests, rejected origins, oversized bodies/messages, and terminal
startup failures receive a compact JSON error and are closed. Attachment tokens
are consumed before the PTY starts, so reconnecting with the same token is not
allowed.

## Security and lifecycle defaults

| Control | Default |
| --- | --- |
| Session attachment deadline | 30 seconds |
| Session lifetime | 30 minutes |
| HTTP body / WebSocket frame | 64 KiB |
| Per-write input | 16 KiB |
| Output backlog | 512 KiB |
| Gateway / per-tenant sessions | 100 / 10 |

All are environment-configurable with the corresponding
`CODESURF_TERMINAL_*` limit variable. Output is chunked and bounded; a client
that cannot drain output causes its terminal to close instead of accumulating
unbounded server memory. Browser disconnects, process exit, attachment expiry,
and gateway shutdown clean up the PTY and session state.

`GET /healthz` returns only `{ "ok": true }` and does not expose tenant,
session, path, or token data.

## Configuration reference

| Variable | Purpose |
| --- | --- |
| `CODESURF_TERMINAL_TENANTS_JSON` | Required JSON tenant mapping. Each tenant needs absolute `roots`; `workspaces` is optional. |
| `CODESURF_TERMINAL_TOKEN` | Single-tenant bearer-token fallback and Native runtime-config token. |
| `CODESURF_TERMINAL_ALLOWED_ORIGINS` | Required comma-separated exact origins; wildcards and `null` are rejected. |
| `CODESURF_TERMINAL_GATEWAY_BIND` / `CODESURF_TERMINAL_BIND_HOST` | Bind address, default `127.0.0.1`. |
| `CODESURF_TERMINAL_GATEWAY_PORT` / `CODESURF_TERMINAL_PORT` | Bind port, default `0` (ephemeral). |
| `CODESURF_TERMINAL_PUBLIC_URL` | HTTPS public base URL used to produce `wss://` URLs. |
| `CODESURF_TERMINAL_RUNTIME_CONFIG_PATH` | Absolute local path for atomically-written `{endpoint,token}` mode-0600 config. |
| `CODESURF_TERMINAL_ADAPTER` | `local` (default) or `docker`. |
| `CODESURF_TERMINAL_ENABLE_DOCKER` | Must be `1` when `ADAPTER=docker`. |
| `CODESURF_TERMINAL_DOCKER_IMAGE` | Required hardened image when Docker is enabled. |

## Verification

```sh
npm --prefix packages/codesurf-terminal-gateway test
```

The integration suite starts the actual HTTP and WebSocket server, verifies
tenant/origin/root enforcement, single-use attachment tokens, lifecycle and
backpressure cleanup, mode-0600 Native runtime config output, Docker
fail-closed configuration, and a real `node-pty` local shell. On Darwin,
package install and test setup narrowly validate the current-architecture
`node-pty` spawn helper and repair its executable mode when npm installs it as
mode 0644.
