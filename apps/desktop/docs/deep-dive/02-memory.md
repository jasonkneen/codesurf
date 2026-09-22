# Memory Usage

This section reviews how the contex main and renderer processes allocate, retain, and reclaim memory across the lifetime of a long-running session. The dominant theme is **missing teardown on tile deletion**: several per-card data structures (chat session maps, bus channel ring buffers, stream handles, runtime tombstones) accumulate entries that are never reclaimed when a tile is destroyed, and one of them (`session-ids.json`) is persisted to disk and grows across the entire install lifetime. None are fast leaks — entries are small and growth is slow — but they are genuinely unbounded over time, and one watcher path is additionally incorrect across multiple windows. All findings are low-to-medium severity with mostly small, well-scoped fixes.

## Findings

| ID | Title | Severity | Effort | Files |
|----|-------|----------|--------|-------|
| mem-01 | Chat session/permission maps never evicted on tile delete; persisted `sessionIds` grows unbounded forever | medium | S | `src/main/ipc/chat.ts`, `src/renderer/src/App.tsx` |
| mem-02 | `stream.ts` has no renderer-disconnect cleanup — `activeStreams` + live HTTP request leak on window crash/reload | medium | S | `src/main/ipc/stream.ts` |
| mem-03 | Orphaned bus channels: `card:${id}` and `ctx:${id}` ring buffers never dropped on tile cleanup | medium | S | `src/main/ipc/system.ts`, `src/main/event-bus.ts`, `src/main/mcp-server.ts`, `src/main/ipc/tile-context.ts` |
| mem-04 | `fs.ts` shares one `FSWatcher` per path keyed globally — second window silently loses its watch and orphans on teardown | low | M | `src/main/ipc/fs.ts` |
| mem-05 | `disposedChatTileIds` Set grows monotonically across tile disposals | low | S | `src/renderer/src/components/chatTileRuntimeState.ts` |
| mem-06 | `BrowserTile` holds a full Electron webview guest parked offscreen for 15s after tile delete | low | M | `src/renderer/src/components/BrowserTile.tsx` |

---

### mem-01 — Chat session/permission maps never evicted on tile delete; persisted `sessionIds` grows unbounded forever

**Severity:** medium · **Effort:** S · **Category:** unbounded-growth / missing-teardown

**Problem.** Per-card chat state (session ids, permission mode) leaks in memory for every deleted chat tile, and the persisted `sessionIds` file plus its in-memory mirror grow without bound across the entire install lifetime.

**Evidence.** The main process keeps five card-keyed maps in `src/main/ipc/chat.ts`: `cardPermissionModes` (L441), `sessionIds` (L452), `opencodeSessionIds` (L2859), `openclawSessionIds` (L3248), and `hermesSessionIds` (L3457). When a chat tile is deleted, `App.tsx` `cleanupTileResources` (`src/renderer/src/App.tsx` L2241-2260) calls `disposeChatTileRuntimeState(tileId)` + `system.cleanupTile(tileId)` + `deleteTileArtifacts`, but never calls `chat:stop` or `chat:clearSession` — the only two paths that evict from these maps (`chat:stop` L3844-3864, `chat:clearSession` L3886-3892). So every map retains its entry indefinitely after the tile is gone.

Worse, `sessionIds` is persisted to `~/.codesurf/session-ids.json` via `persistSessionIds()` (`src/main/ipc/chat.ts` L458-471, writing every key at L464). On startup `loadPersistedSessionIds()` only *adds* keys it does not already have and never prunes:

```ts
// chat.ts L479-480
if (typeof value === 'string' && value && !sessionIds.has(key)) {
  sessionIds.set(key, value)
}
```

The on-disk map therefore grows by one entry for every chat tile/session ever created and is reloaded into memory on every main-process start. Entries are tiny UUID strings, so growth is slow, but it is unbounded across the app's lifetime.

**Recommendation.** Add a `chat:disposeCard(cardId)` IPC that deletes `cardId` from all five maps (and removes it from the persisted file), then call it from `App.tsx` `cleanupTileResources` for `tile.type === 'chat'`. At minimum, prune `session-ids.json` against the set of live workspace tile ids on load.

---

### mem-02 — `stream.ts` has no renderer-disconnect cleanup; `activeStreams` + live HTTP request leak on window crash/reload

**Severity:** medium · **Effort:** S · **Category:** missing-teardown

**Problem.** A renderer crash, reload, or tile destroy that bypasses `stream:stop` orphans a live HTTP/SSE request and its `Map` entry in the main process, with no reclamation path.

**Evidence.** `src/main/ipc/stream.ts` keeps `activeStreams = new Map<string, ...>()` (L15). `stream:start` registers the request with `activeStreams.set(req.cardId, httpReq)` (L63). The *only* cleanup paths are the explicit `stream:stop` handler (L67-70) and a same-`cardId` restart that destroys the prior request (L20-23). Unlike its siblings — `bus.ts` (`senderCleanupAttached`), `terminal.ts` (`sender.once('destroyed')` at L247), and `fs.ts` (`sender.once('destroyed')` at L19) — `stream.ts` attaches **no** `'destroyed'` listener to `event.sender`. If the renderer window crashes, reloads, or the tile is destroyed without calling `stream:stop`, the underlying `http.ClientRequest` (and any SSE socket it holds) stays open and the `Map` entry persists for the life of the main process.

**Recommendation.** Track `sender → cardIds` (a `WeakMap` plus `sender.once('destroyed')`) exactly as `terminal.ts`/`bus.ts`/`fs.ts` do, and on `'destroyed'` call `activeStreams.get(cardId)?.destroy()` + `delete` for each `cardId` owned by that sender.

---

### mem-03 — Orphaned bus channels: `card:${id}` and `ctx:${id}` ring buffers never dropped on tile cleanup

**Severity:** medium · **Effort:** S · **Category:** unbounded-growth

**Problem.** The bus channel *count* grows without bound for every card/ctx ever active; each channel's ring buffer (up to 500 events) is retained for the life of the process.

**Evidence.** `system:cleanupTile` in `src/main/ipc/system.ts` (L215-224) only calls `bus.dropChannelsMatching(\`tile:${tileId}\`)` (L218). But the bus is also published to on two other prefixes:

- `card:${cardId}` — five publish sites in `src/main/mcp-server.ts` (L1269, L1282, L1295, L1308, L1321)
- `ctx:${tileId}` — `src/main/mcp-server.ts` L1731 and `src/main/ipc/tile-context.ts` L21

`dropChannel` / `dropChannelsMatching` are never invoked for the `card:` or `ctx:` prefixes anywhere in main. In `src/main/event-bus.ts`, history is a per-channel `Map` (L17) and each ring is capped at `MAX_HISTORY = 500` (L4, L34-36) — but only the per-channel *size* is bounded; the *number of channels* is not. Over a long-lived app that creates and destroys many cards and tiles, the channel count in `EventBus.history` grows monotonically.

**Recommendation.** In `system:cleanupTile` (or a dedicated dispose path), also call `bus.dropChannelsMatching(\`card:${tileId}\`)` and `bus.dropChannelsMatching(\`ctx:${tileId}\`)`. Optionally add a periodic sweep that drops channels with no matching live tile.

---

### mem-04 — `fs.ts` shares one `FSWatcher` per path keyed globally; second window silently loses its watch and orphans on teardown

**Severity:** low · **Effort:** M · **Category:** missing-teardown / correctness

**Problem.** Multi-window file watching is incorrect: the second window never receives events, and the shared watcher is torn down when the first window closes even if other windows still need it.

**Evidence.** In `src/main/ipc/fs.ts`, `watchers` is keyed by *resolved path* globally (L8), but ownership tracking (`senderWatchPaths`) is per-`WebContents` (L9). If window A watches a path, then window B calls `fs:watchStart` for the same path, the handler short-circuits before registering B:

```ts
// fs.ts L257-258
const resolved = validateFsPath(dirPath)
if (watchers.has(resolved)) return   // returns BEFORE trackWatchSender (L270)
```

So B is never associated via `trackWatchSender`, and the watcher callback (L261-268) only ever sends `fs:watch:${dirPath}` to **A's** captured `event.sender`. When A's window is destroyed, its `'destroyed'` handler closes and deletes the shared watcher (L23-26), leaving B with a stale watch reference that fires for nobody. The `FSWatcher` itself is closed (so this is not a classic leak), but the teardown is wrong across windows.

**Recommendation.** Refcount watchers per resolved path (`Map<path, { watcher, refs: Set<WebContents> }>`); only `close()` when the last referencing sender is destroyed, and always `trackWatchSender` even when reusing an existing watcher. Broadcast watch events to all referencing senders rather than a single captured sender.

---

### mem-05 — `disposedChatTileIds` Set grows monotonically across tile disposals

**Severity:** low · **Effort:** S · **Category:** unbounded-growth

**Problem.** A per-renderer-session tombstone set of disposed chat tile ids grows without bound; negligible per entry but never reclaimed.

**Evidence.** In `src/renderer/src/components/chatTileRuntimeState.ts`, `disposeChatTileRuntimeState(tileId)` correctly deletes the runtime `Map` entry, but it *also* adds `tileId` to a tombstone `Set` `disposedChatTileIds` (L2) that is only ever cleared by `reviveChatTileRuntimeState` (L20):

```ts
// chatTileRuntimeState.ts L14-17
export function disposeChatTileRuntimeState(tileId: string): void {
  disposedChatTileIds.add(tileId)
  chatTileRuntimeState.delete(tileId)
}
```

Since tile ids are unique UUIDs, every chat tile ever deleted leaves a permanent string in this `Set` for the renderer session lifetime. The runtime `Map` itself is freed correctly; only the tombstone `Set` leaks (small strings).

**Recommendation.** Either cap the tombstone set, or drop the tombstone mechanism in favor of relying on `Map.has()`. The disposed check exists to guard late async writes (`setChatTileRuntimeState` early-returns at L10 when disposed), so a short-lived timeout-based tombstone or a generation counter would bound it.

---

### mem-06 — `BrowserTile` holds a full Electron webview guest parked offscreen for 15s after tile delete

**Severity:** low · **Effort:** M · **Category:** delayed-disposal

**Problem.** Permanently-deleted browser tiles retain a live webview guest process for up to 15s, multiplying transient memory when several are closed at once.

**Evidence.** In `src/renderer/src/components/BrowserTile.tsx`, `WEBVIEW_DISPOSE_DELAY_MS = 15000` (L28). On unmount the webview is appended to an offscreen parking root and disposal is scheduled 15s later via `scheduleManagedWebviewDisposal` (L1471-1479), to preserve page/session state across view switches. Disposal *does* run — `removeChild` + `remove` + `registry.delete` (L318-324) — so this is bounded and not a leak. The cost is that a heavy Electron webview guest (its own renderer process and memory) lingers for up to 15s after a tile is permanently deleted, even when no reuse will occur. Closing many browser tiles in quick succession multiplies this transient retention.

**Recommendation.** Distinguish "tile permanently deleted" from "view switched away" — the former is already known in `App.tsx` `cleanupTileResources` — and dispose the webview immediately for permanent deletes, keeping the 15s grace only for transient view switches.

---

## Quick wins

- **mem-02** (S): mirror the existing `sender.once('destroyed')` cleanup from `terminal.ts`/`fs.ts` into `stream.ts` to reclaim orphaned HTTP/SSE requests on renderer crash or reload.
- **mem-03** (S): add `bus.dropChannelsMatching('card:'+tileId)` and `bus.dropChannelsMatching('ctx:'+tileId)` to `system:cleanupTile` so bus channel count stops growing per card/ctx.
- **mem-01** (S): add a `chat:disposeCard(cardId)` IPC that evicts the five session/permission maps and prunes `session-ids.json`, wired from `cleanupTileResources` — stops both the in-memory and on-disk unbounded growth.
- **mem-05** (S): cap or remove the `disposedChatTileIds` tombstone set to stop monotonic growth in the renderer session.
