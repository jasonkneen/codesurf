# Plan 010: Enforce per-tile scope for tile MCP tokens (`/inject`, `/push`, tool calls)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 77e3c7d..HEAD -- src/main/mcp-server.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1 (security)
- **Effort**: M
- **Risk**: MED (could break legitimate cross-tile agent workflows — see Step 4)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `77e3c7d`, 2026-07-01

## Why this matters

The MCP server maintains a per-tile token registry whose stated purpose
(mcp-server.ts:32) is to "limit blast radius if a tile's token leaks". But
authentication is a boolean: `requireMcpAuth` accepts *any* tile token for
*any* request, and the handlers never learn which principal authenticated. So a
single leaked tile token — handed to every spawned agent via
`CODESURF_MCP_TILE_TOKEN` and written into workspace `.mcp.json` files — can
inject terminal input into ANY tile (`POST /inject` with attacker-chosen
`card_id`), push SSE events to any tile, and call every MCP tool. The
isolation the design claims does not exist; only revocation does. This plan
makes tile tokens actually tile-scoped.

## Current state

All in `src/main/mcp-server.ts`:

- Token registry (lines 29-53): `MCP_TOKEN = randomUUID()` (global), plus
  `tileTokens = new Map<string, string>()` mapping **tileId → token**, with
  `generateTileToken`/`revokeTileToken`/`getTileToken`.

- Auth check (lines 483-502) — boolean, no principal:

```ts
export function requireMcpAuth(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { allowQueryToken?: boolean, url?: URL },
): boolean {
  const bearer = readBearerToken(req)
  const queryToken = options?.allowQueryToken && options.url
    ? readQueryToken(options.url)
    : null
  const token = bearer ?? queryToken

  // Check against global token first, then per-tile tokens
  if (token === MCP_TOKEN) return true
  if (token && tileTokens.has(token)) return true   // ← NOTE: also a lookup bug, see Step 1

  setCorsHeaders(res, req)
  res.writeHead(401, ...)
  return false
}
```

**Important pre-existing wrinkle**: `tileTokens` maps tileId→token, so
`tileTokens.has(token)` checks whether the presented token equals some
**tileId**, not some token. Tile-token auth as written likely only works
because callers also hold the global token, or it silently never matches.
Verify this during Step 1 and record what you find in the status row.

- Request routing (lines 519-680): after `requireMcpAuth` passes, handlers for
  `GET /events` (SSE, `card_id` from query), `POST /push` (`card_id` from JSON
  body → `pushSSE` + `sendToRenderer`), `POST /inject` (`card_id` from body →
  `broadcastToRenderer('mcp:inject', ...)` which types into that tile's
  terminal), and `POST /`|`/mcp` → `handleMCP(mcpReq)` → `handleTool(name, args)`
  (line 371) → `dispatchTool` from `./mcp/registry`.

- Tool context: `handleTool`/`dispatchTool` take an `McpToolContext`
  (`src/main/mcp/types.ts`) — read that type; it is the natural carrier for the
  authenticated principal.

Repo conventions: 2-space indent, no semicolons. Security helpers live in
`src/main/security/` with node --test coverage in `test/security-hardening.test.ts`
and `test/mcp-*.test.ts` (check `ls test | grep mcp` for existing MCP server
tests to model after).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (if needed) | `npm install` | exit 0 |
| Typecheck | `npm run typecheck` | no NEW errors in touched files |
| MCP tests | `node --test test/mcp-*.test.ts` (adjust glob to what exists) | all pass, plus your new ones |

## Scope

**In scope**:
- `src/main/mcp-server.ts`
- `src/main/mcp/types.ts` (only if threading the principal through `McpToolContext`)
- `src/main/mcp/registry.ts` (only if `dispatchTool` needs the principal param)
- `test/mcp-tile-token-scope.test.ts` (create)

**Out of scope** (do NOT touch):
- The daemon (`packages/codesurf-daemon`) — separate auth model.
- Token *generation/distribution* call sites (`generateTileToken` callers in
  terminal/chat code) — the token handed out stays the same; only enforcement
  changes.
- CORS / Host-header / body-cap logic — already correct; don't reshuffle it.

## Git workflow

- Branch: `security/mcp-tile-token-scope`
- Commit per step; imperative messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Return a principal from auth (and fix the token lookup)

Change `requireMcpAuth` to return a principal instead of a boolean:

```ts
type McpPrincipal = { kind: 'global' } | { kind: 'tile', tileId: string }
// returns McpPrincipal | null; null means it already wrote the 401 response
```

- Global token → `{ kind: 'global' }`.
- Tile token: iterate `tileTokens` entries and match on the **value**
  (`token === storedToken`), returning `{ kind: 'tile', tileId }`. If the
  current `.has(token)` behavior was load-bearing somewhere (i.e. something
  authenticates by presenting a tileId), that is itself a bug — record it, fix
  callers to present the token.
- Consider maintaining a reverse map (`token → tileId`) if `tileTokens` is
  consulted per-request; the map is small, iteration is fine.

Update the one routing call site (line ~544-549) to capture the principal.

**Verify**: `npm run typecheck` → no new errors; `grep -n "kind: 'tile'" src/main/mcp-server.ts` → present.

### Step 2: Scope `/inject`, `/push`, and `/events`

For each handler, after parsing `card_id`:

```ts
if (principal.kind === 'tile' && card_id !== principal.tileId) {
  setCorsHeaders(res, req)
  res.writeHead(403, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Forbidden: token is scoped to a different tile' }))
  return
}
```

For `GET /events`, apply the same check to the `card_id` query param (a
tile-scoped token may only subscribe to its own card's stream; `global`
subscriptions require the global token).

**Verify**: write/extend a unit test (Step 5) or, minimally, trace each of the
three handlers and confirm the guard precedes the side effect
(`broadcastToRenderer` / `pushSSE` / SSE registration).

### Step 3: Scope tool calls

Thread the principal into `handleMCP` → `handleTool` → `dispatchTool` via
`McpToolContext` (add e.g. `principal?: McpPrincipal`). Enforcement policy for
this plan (deliberately minimal):

- Tools whose args include a tile/card identifier (search the tool schemas in
  `src/main/mcp/tools/*.ts` for `card_id` / `tile_id` params — e.g. kanban
  card updates, peer-bridge sends, terminal input tools): reject when a
  tile-scoped principal targets a different tile.
- Tools with no tile target (list tiles, read context, create tile): allow for
  now — restricting reads is a policy decision for the maintainer, not this plan.

Keep the enforcement in ONE place (a small helper
`assertTileScope(principal, targetTileId)`) rather than scattered per-tool.

**Verify**: `npm run typecheck` → no new errors.

### Step 4: Preserve legitimate cross-tile workflows

Peer-collaboration tools (`peer_send_message` etc.) exist precisely for
cross-tile interaction. Decide with evidence: read
`src/main/mcp/tools/peer-bridge.ts` (and `.claude/CLAUDE.md`'s peer protocol).
If peer messaging is tile-to-tile *by design*, exempt the peer tools from the
target check (sender identity should instead be stamped from
`principal.tileId` so a tile cannot spoof another sender). Document each
exemption with a one-line comment.

**Verify**: `grep -n "assertTileScope" src/main/mcp/tools/*.ts src/main/mcp-server.ts`
→ guard applied at the intended sites; exemptions commented.

### Step 5: Tests

`test/mcp-tile-token-scope.test.ts` (node --test). If the auth function is
exported (it is), unit-test it directly with fake `IncomingMessage`-ish objects
or extract a pure `resolvePrincipal(token)` helper for testability. Cases:

- global token → global principal
- registered tile token → tile principal with the right tileId
- tileId presented AS a token → rejected (regression pin for the Step 1 lookup bug)
- unknown token → null/401
- `assertTileScope`: global passes any target; tile passes own target; tile
  rejected for another target.

**Verify**: `node --test test/mcp-tile-token-scope.test.ts` → all pass.

## Done criteria

- [ ] `requireMcpAuth` (or successor) returns a principal; no `tileTokens.has(token)` value/key confusion remains
- [ ] `/inject`, `/push`, `/events` enforce tile scope for tile principals
- [ ] Tile-targeted MCP tools enforce scope through one shared helper; exemptions documented
- [ ] New tests pass; existing `test/mcp-*` tests still pass
- [ ] `npm run typecheck` shows no new errors in touched files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- You find call sites that authenticate by presenting a **tileId** as the
  bearer token (the Step 1 wrinkle turns out to be load-bearing) — list them
  and wait for a decision before changing distribution.
- Enforcing scope on `/events` breaks an existing consumer visible in the code
  (grep for `/events?card_id` producers) — report which.
- The tool-context threading requires touching more than `mcp-server.ts`,
  `mcp/types.ts`, `mcp/registry.ts`, and individual tool guard lines.

## Maintenance notes

- Every NEW MCP tool that takes a tile/card target must call `assertTileScope`.
  Consider a registry-level assertion (tool schema declares its target param;
  registry enforces) as a follow-up so this can't be forgotten.
- Reviewer: the exemption list from Step 4 is the risk surface — each exemption
  is a deliberate cross-tile capability; verify sender-identity stamping.
