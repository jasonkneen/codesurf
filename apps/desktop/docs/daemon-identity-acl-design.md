> Status: design note for architect sign-off — no daemon code until approved.

# C-D0 Design Note: CodeSurf Daemon Identity, Session ACLs, and Sharing

## Baseline From Code

Omnigent already separates transport auth, user identity, session permissions, and discovery. Identity is pluggable through `AuthProvider`, with header, OIDC, and accounts modes selected by configuration, and explicit reserved users `local` and `__public__` in `omnigent/server/auth.py:36-59`, `omnigent/server/auth.py:132-173`. It only falls back to the local user when explicit local single-user mode is enabled in `omnigent/server/auth.py:81-92`, `omnigent/server/auth.py:331-360`.

CodeSurf daemon today has one process-scoped bearer token, generated randomly at startup in `packages/codesurf-daemon/bin/codesurfd.mjs:32`. Every request is authorized only by that bearer token or a `token` query param in `packages/codesurf-daemon/bin/codesurfd.mjs:2815-2819`, and rejected before route dispatch in `packages/codesurf-daemon/bin/codesurfd.mjs:2821-2827`. The desktop daemon client simply sends that bearer token in `packages/codesurf-daemon/src/client.ts:45-91`, while daemon status persists `pid`, `port`, and `token` in `packages/codesurf-daemon/src/manager.ts:5-12`, `packages/codesurf-daemon/src/manager.ts:87-119`.

That means the migration should not replace the bearer token immediately. It should demote it to a daemon transport capability and add identity resolution behind it.

## 1. Identity Model

A CodeSurf `user` should be a stable user id string, not a daemon token, tile id, chat job id, or provider-native session id. The initial built-in users should mirror omnigent's reserved ids: `local` for local-first single-user operation and `__public__` as the public ACL sentinel. Omnigent defines those reserved values in `omnigent/server/auth.py:36-45`, and its permission store treats `__public__` as the public grant sentinel in `omnigent/stores/permission_store/__init__.py:1-6`.

CodeSurf should add identity after the existing daemon token check. The current `authorized(req, url)` remains the first transport gate in `packages/codesurf-daemon/bin/codesurfd.mjs:2815-2819`. A new `resolveRequestUser(req, url)` should then return:

- `local` when the daemon is in local-first mode and the bearer token is valid.
- A configured identity when multi-user mode is enabled, for example trusted proxy header, signed cookie/JWT, or accounts.
- No user when multi-user mode is enabled and identity is absent.

This matches omnigent's explicit local fallback only in single-user mode in `omnigent/server/auth.py:331-360`, while preserving CodeSurf's current bearer-token-only clients in `packages/codesurf-daemon/src/client.ts:45-91`.

Identity persistence should be file-backed at first, because CodeSurf daemon already persists daemon state under `~/.codesurf` using JSON files. The daemon defines `HOME`, workspace/project/host/settings/permission files in `packages/codesurf-daemon/bin/codesurfd.mjs:18-31`, writes JSON atomically in `packages/codesurf-daemon/bin/codesurfd.mjs:68-76`, and reads JSON via the same local file pattern in `packages/codesurf-daemon/bin/codesurfd.mjs:79-140`. Do not reuse the existing `PERMISSIONS_FILE`: it currently stores tool permission grants, not session ACLs, as shown by `readPermissionStore`, `writePermissionStore`, and tool-grant helpers in `packages/codesurf-daemon/bin/codesurfd.mjs:127-140`, `packages/codesurf-daemon/bin/codesurfd.mjs:203-237`, with matching types in `packages/codesurf-daemon/src/types.ts:161-189`.

Migration path:

1. Add a users store and identity resolver, defaulting all valid bearer-token requests to `local`.
2. Seed `local` as the owner for existing sessions lazily on first session list/state access.
3. Keep the current bearer token in the PID file and client path unchanged, so current single-user desktop use continues.
4. Add multi-user identity modes behind a flag; only then disable bearer-token-to-`local` fallback for shared/remote daemon use.

## 2. Session ACL Model

Use omnigent's permission levels exactly:

- `read = 1`
- `edit = 2`
- `manage = 3`
- `owner = 4`

Omnigent defines those constants in `omnigent/server/auth.py:56-59`. Its SQL model enforces levels `1..4` in `omnigent/db/db_models.py:195-233`, and grant requests expose levels `1..3` because ownership is protected in `omnigent/server/schemas.py:1867-1879`. Public grants should be allowed only for read-level sharing, matching omnigent's route guard in `omnigent/server/routes/sessions.py:16517-16523`.

CodeSurf should add session ACL types to `packages/codesurf-daemon/src/types.ts`, where session list entries currently have no owner, permission, parent, or root fields in `packages/codesurf-daemon/src/types.ts:33-61`. The renderer-side mirror in `src/shared/session-types.ts:16-41` needs the same fields so the sidebar can render permission-aware sessions. Suggested fields:

```ts
permissionLevel?: 1 | 2 | 3 | 4 | null
ownerUserId?: string | null
parentSessionEntryId?: string | null
rootSessionEntryId?: string | null
```

Store grants separately from sessions as `(userId, canonicalSessionId, level)`. Omnigent keeps ownership out of the conversation record and routes access through a permission store in `omnigent/stores/permission_store/__init__.py:13-19`. CodeSurf should follow that shape instead of embedding durable ownership only inside tile/chat state, because current session entries are aggregated from runtime session files, tile summary files, and job metadata in `packages/codesurf-daemon/bin/codesurfd.mjs:1987-2143`, `packages/codesurf-daemon/bin/codesurfd.mjs:2482-2532`.

The access-check choke point should be a daemon helper analogous to omnigent's `check_session_access`. Omnigent's access helper handles admin, missing sessions, parent-session delegation, and permission-store lookup in `omnigent/server/permissions.py:17-60`. CodeSurf should add helpers in `packages/codesurf-daemon/bin/codesurfd.mjs` near the existing session helpers:

- `resolveRequestUser(req, url)`
- `normalizeSessionIdentity(workspaceId, sessionEntryId | jobId | tileId | providerSessionId)`
- `resolveSessionAccess(userId, canonicalSessionId)`
- `requireSessionAccess(userId, canonicalSessionId, requiredLevel)`
- `listAccessibleLocalWorkspaceSessions(userId, workspaceId)`

Every local session read/write route must use these helpers. Today these routes are guarded only by the global bearer token:

- `GET /session/local/list` returns every local session for a workspace in `packages/codesurf-daemon/bin/codesurfd.mjs:2983-2989`.
- `GET /session/local/state` returns raw local state in `packages/codesurf-daemon/bin/codesurfd.mjs:3341-3348`.
- `POST /session/runtime/upsert` writes runtime session state in `packages/codesurf-daemon/bin/codesurfd.mjs:2993-3005`.
- Checkpoint create/list/restore routes are in `packages/codesurf-daemon/bin/codesurfd.mjs:3009-3048`.
- Chat job start/state/events/permission/cancel routes are in `packages/codesurf-daemon/bin/codesurfd.mjs:3197-3320`.
- Local delete/rename routes are in `packages/codesurf-daemon/bin/codesurfd.mjs:3352-3373`.

Recommended enforcement:

- List: fail closed and filter to sessions with read access.
- State/events: require read.
- Rename, checkpoint create/restore, chat continuation/tool answer/cancel: require edit.
- Permission grant/revoke/list: require manage.
- Delete and owner transfer: require owner, matching omnigent's delete-owner check in `omnigent/server/routes/sessions.py:16340-16381`.

## 3. Sharing And Discovery

Add sharing routes to the existing daemon route dispatcher in `packages/codesurf-daemon/bin/codesurfd.mjs`, adjacent to the current session routes at `packages/codesurf-daemon/bin/codesurfd.mjs:2983-3373`.

Proposed daemon endpoints to add:

- `GET /identity/me`
- `GET /session/local/permissions?workspaceId=...&sessionEntryId=...`
- `PUT /session/local/permissions`
- `DELETE /session/local/permissions`
- `GET /session/local/updates?workspaceId=...`

These are new endpoints, anchored to the existing daemon HTTP server and session route block. Their behavior should mirror omnigent's permission routes: require manage to grant, reject self-modification, prevent weakening owner grants, and announce newly visible sessions to the grantee. Omnigent implements those checks in `omnigent/server/routes/sessions.py:16485-16544`, revocation in `omnigent/server/routes/sessions.py:16546-16592`, and list-permissions in `omnigent/server/routes/sessions.py:16618-16650`.

Discovery must fail closed. Omnigent's session list uses `_require_user`, not optional identity, specifically to prevent anonymous listing of everything in `omnigent/server/routes/sessions.py:12056-12080`. CodeSurf's current `canvas:listSessions` calls `daemonClient.listLocalSessions(workspaceId)` and merges all returned sessions in `src/main/ipc/canvas.ts:819-867`; after ACLs, that daemon call must already be filtered per user.

For deltas, CodeSurf can use Server-Sent Events rather than WebSocket because the daemon already streams chat job events over an HTTP event route in `packages/codesurf-daemon/bin/codesurfd.mjs:3274-3296`. Omnigent uses a per-user discovery stream and announces newly granted sessions in `omnigent/server/routes/sessions.py:656-680`, then emits per-user updates over `/sessions/updates` in `omnigent/server/routes/sessions.py:12279-12308`, `omnigent/server/routes/sessions.py:12450-12477`.

Renderer bridge:

- Extend `packages/codesurf-daemon/src/client.ts`, where local session client methods already live in `packages/codesurf-daemon/src/client.ts:204-218`.
- Extend `src/main/ipc/canvas.ts` near current session IPC handlers in `src/main/ipc/canvas.ts:819-952`.
- Initially forward daemon session deltas as the existing `canvas:sessionsChanged` notification, which is already debounced and broadcast in `src/main/ipc/canvas.ts:514-543`.
- Later expose richer changed/removed payloads once the renderer consumes them directly.

## 4. Spawn Tree And Session Identity

Omnigent has first-class spawn-tree fields on conversations: `kind`, `parent_conversation_id`, and `root_conversation_id` in `omnigent/entities/conversation.py:25-50`, with persisted fields in `omnigent/entities/conversation.py:181-203`. Its SQL store sets top-level roots to self and child roots to the parent root in `omnigent/stores/conversation_store/sqlalchemy_store.py:539-649`. Access to a sub-agent session delegates to the parent session in `omnigent/server/permissions.py:31-39`.

CodeSurf currently has only flat relay participants and channels. `RelayParticipant` has `tileId`, channels, and metadata in `packages/codesurf-relay/src/types.ts:30-48`. `RelaySpawnRequest` has `tileId`, channels, provider/model, task, and metadata, but no typed parent/root ids in `packages/codesurf-relay/src/types.ts:157-169`. The relay runtime upserts participants from that flat request and preserves metadata in `packages/codesurf-relay/src/runtime.ts:143-160`. The main process syncs chat tiles to relay participants by tile id in `src/main/relay/service.ts:65-105`.

Incremental model:

1. Add parent/root fields to session registry and aggregated session entries.
2. Pass `parentSessionEntryId`, `rootSessionEntryId`, and `parentTileId` through relay `metadata` first, because metadata already exists in `RelaySpawnRequest`.
3. Promote those metadata fields into typed relay fields only after the daemon/session registry behavior stabilizes.
4. Implement parent-aware access in `requireSessionAccess`: if a session has a parent, read/edit/manage checks delegate to the parent unless an explicit child grant exists. This follows omnigent's parent-aware rule in `omnigent/server/permissions.py:31-39`.

The top risk is identity reconciliation:

- Tile id is the UI/runtime anchor. CodeSurf writes runtime session state per `workspaceId` and `tileId` in `packages/codesurf-daemon/bin/codesurfd.mjs:1819-1833`, and chat runtime upserts by `req.cardId` in `src/main/chat/runtime.ts:40-47`.
- Chat job id is daemon-owned. Job metadata is created with `workspaceId`, `cardId`, and optional `sessionId` in `packages/codesurf-daemon/bin/chat-jobs.mjs:1772-1809`.
- Provider-native session id may appear later. Job events update metadata `sessionId` when events arrive in `packages/codesurf-daemon/bin/chat-jobs.mjs:835-901`.
- The UI already dedupes sessions by provider/native `sessionId` where possible in `src/main/ipc/canvas.ts:655-703` and `src/renderer/src/components/Sidebar.tsx:1315-1326`.

Therefore the daemon needs a session alias registry before enforcing sharing broadly. A grant must attach to a canonical CodeSurf session id, while aliases map `codesurf-runtime:${tileId}`, `codesurf-job:${jobId}`, tile summary ids, and `provider:${provider}:${sessionId}` to that canonical id. Without this, a session shared before the provider-native `sessionId` exists can later appear as a different session after merge/dedupe.

## 5. Phasing

PR 1: identity foundation, no enforcement change. Add `local` user resolution after the current bearer-token gate, a users store, ACL store types, and daemon-client `GET /identity/me`. Current bearer-token clients remain valid. Security-sensitive point: multi-user mode must not silently fall back to `local`.

PR 2: session registry and owner seeding. Create canonical session ids and alias records for runtime sessions, tile summaries, and chat jobs. Seed existing sessions to `local` owner lazily. Touch the aggregation paths in `packages/codesurf-daemon/bin/codesurfd.mjs:1987-2143` and job metadata path in `packages/codesurf-daemon/bin/chat-jobs.mjs:1772-1809`.

PR 3: read enforcement. Gate `GET /session/local/list`, `GET /session/local/state`, checkpoint list, and dreaming/session aggregation with read checks. This is the first fail-closed change. It must be cross-reviewed carefully because omnigent explicitly avoided anonymous list-all behavior in `omnigent/server/routes/sessions.py:12056-12080`.

PR 4: write enforcement. Gate runtime upsert, rename, delete, checkpoint create/restore, chat job state-changing routes, and tool permission answers by edit/manage/owner as appropriate. Security-sensitive point: `chat/job/events` should not leak job output to users without read access.

PR 5: sharing API and per-user updates. Add permission list/grant/revoke endpoints and `GET /session/local/updates`. Bridge updates through `packages/codesurf-daemon/src/client.ts` and `src/main/ipc/canvas.ts`, initially by reusing `canvas:sessionsChanged`.

PR 6: spawn-tree inheritance. Add parent/root propagation through relay metadata and enforce parent-aware access. This should be local-first only until the tile/job/provider alias registry is proven.

PR 7: remote/shared hosts. Only after local ACLs are enforced, decide whether remote hosts participate in v1. Host records currently store only daemon endpoint credentials like `authToken` in `packages/codesurf-daemon/src/types.ts:22-31` and `src/shared/types.ts:23-33`; remote user identity is not modeled today.

Porting cost: omnigent's implementation is Python/FastAPI/SQLAlchemy with route dependencies and SQL permission stores, for example `omnigent/server/routes/_auth_helpers.py:97-180` and `omnigent/stores/permission_store/sqlalchemy_store.py:238-304`. CodeSurf daemon is a hand-written Node HTTP server with JSON-file persistence in `packages/codesurf-daemon/bin/codesurfd.mjs:68-140` and route dispatch in `packages/codesurf-daemon/bin/codesurfd.mjs:2821-3373`. The model ports cleanly, but the code does not; CodeSurf needs native Node helpers and tests rather than direct reuse.

## 6. Open Questions For Architect

1. Auth backend: trusted proxy header, signed cookie/JWT, local accounts, or all three behind config? Omnigent supports all three styles in `omnigent/server/auth.py:132-173`; CodeSurf has none today beyond bearer token.

2. Storage engine: keep JSON files for local-first ACLs, or move session ACLs/users to SQLite before remote sharing? JSON matches current daemon persistence, but concurrent remote sharing makes SQLite safer.

3. Remote host scope in v1: should multi-user sharing apply only to the local daemon first, or also to remote hosts? Current host records have endpoint/auth token but no user identity in `packages/codesurf-daemon/src/types.ts:22-31`.

4. Public sharing: should `__public__` read grants be enabled in CodeSurf v1? Omnigent allows public read only, but CodeSurf sessions may expose local paths, terminal output, and checkpoint data.

5. External/provider-native sessions: should external sessions be imported into the CodeSurf session registry before they can be shared, or remain private/user-local until imported?

6. Owner transfer and admins: should CodeSurf have daemon admins like omnigent's permission store supports in `omnigent/stores/permission_store/sqlalchemy_store.py:208-236`, or should owner recovery stay local-only?

7. Relay API shape: should parent/root ids become typed fields immediately in `packages/codesurf-relay/src/types.ts:157-169`, or remain metadata until the daemon registry proves the canonical session model?

8. Comments/review surface: if CodeSurf adds comments later, it should follow omnigent's read/edit/author model from `omnigent/server/routes/comments.py:190-341`; decide now whether that is in scope for the first sharing milestone.

## 7. Architect Decisions (sign-off)

Recorded from the architect:
1. **Auth backend: ALL THREE** — trusted proxy header + signed cookie/JWT + local accounts, all behind config.
2. **Storage: implementer's choice, but MUST preserve compatibility with existing "normal storage"** (claude CLI session files etc.) — do not break formats current clients read/write. Implies a hybrid: keep JSON/file session storage for compat; ACL/users/registry may live in SQLite.
3. **Scope: remote AND local AND multiple hosts** — multi-host is in scope, not deferred.
4. **Public sharing: YES** — enable `__public__` read grants in v1 (mind local-path/terminal/checkpoint exposure).
5. Provider-native sessions: do it the right way (ADR to recommend).
6. Admins/owner transfer: recommend best (ADR).
7. Relay API shape: recommend best (ADR).
8. Comments/review surface: **YES**, in scope for the first sharing milestone.

### Strategic directive (supersedes the earlier "extend the Node daemon" assumption)
- Pre-release product: **breaking changes are acceptable** to reach the best architecture.
- Second client exists: **grok-cli (branded "codesurf")**, a Bun/TS CLI that talks to the codesurf daemon. Keep the public daemon API compatible **or** update grok-cli — both allowed.
- **Goal: ONE "daemon gateway" serving BOTH the Electron IDE and grok-cli.**
- **Authority granted to make this as-good-or-BETTER than omnigent — including porting CodeSurf onto an omnigent substrate if that is the best solution.**

=> Requires a build-vs-adopt **ADR** before any C-PR. Two decision-grounding explores in flight: (1) omnigent-as-substrate feasibility; (2) codesurf-daemon <-> grok-cli public API + storage-compat constraints. ADR will recommend one of: (A) extend the Node daemon, (B) adopt omnigent as gateway substrate, (C) hybrid gateway. No daemon code until the path is chosen.
