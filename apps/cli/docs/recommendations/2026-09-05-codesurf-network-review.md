# CodeSurf network and remote bridge review — 2026-09-05

Read-only product review. No provider requests, Telegram messages, credentials, or product changes were used. Two local reproductions ran with synthetic data. The requested Spark implementation remains separate from this review.

## Findings

### NET-1 — High: approved Telegram identities reuse private history in group chats

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/telegram/bridge.ts`. Private chats are the only supported ingress: `ensureApprovedUser`, `/start` and `/pair` ignore group, supergroup and channel traffic (no agent invocation, no reply, no pairing code). Chat-scoped sessions for intentional group support were not added. Regressions: `src/telegram/bridge.test.ts` (`chat isolation`).

`src/telegram/bridge.ts:103-116` authorizes only `ctx.from.id`. Text and audio handlers (`:250-309`) never require a private chat or an approved chat ID. `:146` selects the agent by user ID while replies and file uploads target `ctx.chat.id` (`:148-154`, `:209-211`, `:217`). The headless factory at `src/telegram/headless-bridge.ts:67-106` caches and resumes by user ID alone.

Trigger: an approved user sends a message delivered to this bot in a group. The same agent used for their private conversation processes it and replies into that group, including potentially private conversation context or requested files. This is a source-confirmed routing path, not a demonstrated live disclosure. Telegram delivery settings can affect which group messages arrive; they do not add a check inside the handler.

Recommendation: make private chats the default supported ingress; require explicit chat authorization and separate `(bot, workspace, chat, thread)` session identity before supporting groups. Regression: drive registered handlers with a fake approved sender in a different/group chat and assert no agent invocation, reply content, or upload; separately test intentional chat-scoped sessions.

### NET-2 — High: undrained MCP stderr can stall local servers

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/mcp/runtime.ts`. `createStdioTransport` attaches a drain to the SDK's stderr PassThrough at construction and keeps a bounded tail (2,000 chars) that is appended to the server's error entry when setup fails. Regression: `src/mcp/stdio-stderr.test.ts` spawns a child that floods 4 MiB to stderr before its first JSON-RPC message and asserts delivery.

`src/mcp/runtime.ts:29-36` constructs `StdioClientTransport` with `stderr: "pipe"` and never retains/drains its stderr. Installed SDK implementation `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:53-54,97-98` pipes child stderr into a `PassThrough`. Backpressure can block a verbose child, delaying initialization or tool results. Server setup is sequential (`runtime.ts:228-273`), so one stalled setup delays later servers too.

Executed local reproduction: instantiate that installed transport with a synthetic Bun child which writes 8 MiB to stderr before sending a JSON-RPC notification. After 100 ms, notification received was `false`; call `transport.stderr.resume()`, wait another 100 ms, received becomes `true`; close transport. No MCP service or external network involved. This verifies the buffering mechanism, not a production server outage.

Recommendation: explicitly drain stderr into bounded, redacted diagnostics (or discard it), preserve transport ownership, and bound connection/discovery lifetime. Regression: run a noisy fixture through `buildMcpToolSet` and assert successful discovery and process teardown.

### NET-3 — Medium: batch timeout does not bound pagination or individual requests

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/grok/batch.ts`. Polling composes the caller's signal with an absolute deadline that covers the fetch, body consumption, pagination and the sleep between polls, a repeated pagination cursor is rejected, the remaining sleep is capped by the deadline, and caller-abort stays distinguishable from timeout. Regression: `src/grok/batch.test.ts`.

`src/grok/batch.ts:205-234` checks `timeoutMs` only after `findBatchResult` and `getBatchStatus` complete. Pagination (`:263-280`) has no repeated-token detection or deadline; requests (`:313-321`) carry only the caller's optional signal. A hung fetch or repeating cursor can therefore prevent the configured timeout from ever being evaluated. Poll delay can also exceed the remaining budget.

Executed local reproduction: replace global fetch with a synthetic 5 ms response returning `{ results: [], pagination_token: "same" }`; run `pollBatchRequestResult` with `timeoutMs: 10` and an independent controller aborted at 100 ms. Observed `elapsedMs: 102`, `calls: 14`, error `Request aborted`. It failed from the independent abort rather than its own 10 ms deadline. No actual network calls occurred.

Recommendation: compose caller cancellation with an absolute deadline covering fetch, response consumption, pagination and sleeps; reject repeated cursors and cap remaining sleep. Regression: hanging fetch, repeating cursor, large valid pagination, and near-deadline sleep. Preserve caller-abort versus timeout classification.

### NET-4 — Medium: bridge error/stop paths do not reliably release lifecycle ownership

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/telegram/bridge.ts`. One idempotent `releasePolling` (clear the polling flag, unregister the module-global conflict handler, free the poller lock) runs from `stop()`'s `finally`, from every session-guarded settlement of `bot.start()` and from the conflict path, while a separate `stopping` promise makes concurrent stops join one shutdown and is cleared from a continuation so a stop that ran while not polling cannot wedge later starts. Regression: `src/telegram/bridge.lifecycle.test.ts`.

On a non-conflict polling failure, `src/telegram/bridge.ts:338-346` sets `running = false` and frees the lock but leaves `reportConflict` in the module-global `liveConflictHandlers`. `stop()` at `:350-355` returns early when not running, so later disposal cannot remove that stale closure. Separately, a rejecting `bot.stop()` bypasses `running = false` and lock release because neither is in a `finally`. These are source-confirmed paths; no fake-bot runtime reproduction was executed.

Recommendation: one idempotent cleanup owner invoked by stop and every polling exit; unregister callbacks and free the local lock in `finally`. Track stopping separately from polling. Regression: reject start with a normal error then stop; reject stop; repeat create/start/fail/dispose and assert no retained handler/lock.

### NET-5 — Medium: Telegram preview/audio operations lack cancellation ownership

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/telegram/bridge.ts`, `preview-stream.ts`, `audio-input.ts`, `typing-refresh.ts` and the STT engine. The bridge owns an ingress `AbortController` that `stop()` aborts; each turn derives a signal from it and the coordinator fence and threads it through grammy send/edit/typing, `getFile`, the download fetch, an abortable 429 back-off, `agent.abort()` and the STT request itself, with audio downloads bounded to 20 MB. Regression: `src/telegram/audio-input.test.ts`, `src/telegram/preview-stream.test.ts` and `src/telegram/typing-refresh.test.ts`.

`src/telegram/preview-stream.ts:16-31` can sleep on 429 responses up to 12 times without an abort signal; its API send/edit calls also carry no signal. `runTelegramPartialReply` has no signal input. These calls occur inline while consuming the agent stream, so provider progress waits for Telegram retries. `src/telegram/audio-input.ts:55-100` likewise has no cancellation/deadline for `getFile`, fetch, body download, or transcription. The temp directory is removed in `finally`, but a pending operation delays reaching it. `startTypingRefresh` can start overlapping requests if each request outlasts 3.5 seconds.

Recommendation: bridge/turn-owned abort signals through preview retries, send/edit, audio and typing; bounded download size; stop must cancel in-flight ingress as well as polling. Regression: abort during 429 sleep, hanging audio fetch/transcription, and typing API slower than its refresh interval. These are source observations; end-to-end stop latency was not measured.

### NET-6 — Medium: resetting serialization leaves the active global Telegram sink unfenced

**Implementation status (2026-09-05, resumed in Claude Code):** partially repaired in `src/core/extensions/sinks.ts` and `src/telegram/turn-coordinator.ts`. `acquireTelegramSink` returns an ownership token and `releaseTelegramSink` is compare-and-release, so a late finalizer cannot clear a newer turn's sink, and `reset()` aborts the running generation's fence so the bridge aborts the agent and the fenced turn's own sink closure refuses to send. Regression: `src/core/extensions/sinks.test.ts` and `src/telegram/turn-coordinator.test.ts`. **Closed 2026-09-05.** Turn-context destination dispatch now exists. A Telegram-driven turn runs inside an `AsyncLocalStorage` scope carrying its own sink-ownership token (`runInTelegramTurn`, `src/core/extensions/sinks.ts`; the bridge wraps its turn body), and the loader's `telegram.sendFile` refuses a send whose ambient turn is no longer the sink's owner rather than delivering through whatever sink is globally installed. That is what closes the gap compare-and-release could not: it stopped a stale turn *unbinding* the newer turn's sink, not a stale turn *sending* through it. Callers with no ambient turn — the legacy `setTelegramSink` bind, anything not driven by the bridge — are deliberately unfenced; there is no turn to fence against. Regression: `src/core/extensions/sinks.test.ts` ("telegram turn-context destination dispatch", including ownership held across an await, which is where the real overlap happens) and `src/core/extensions/native/telegram-tools.test.ts` ("refuses a send from a turn a newer turn has superseded" — the review's own scenario, asserting nothing reached B's chat).

`src/telegram/turn-coordinator.ts:23-32,46-48` fences queued starts by generation but does not cancel or fence work already running. After reset a new chain can run while the former callback remains alive. Telegram turns install a global sink at `bridge.ts:148` and unconditionally clear it in `finally` at `:246`; `src/core/extensions/sinks.ts:225-226` is a plain assignment. A late old finalizer can therefore clear a newer turn's sink. More generally a turn may see another turn's destination if they overlap. The UI reset call at `src/ui/hooks/use-session-lifecycle.ts:71-84` shows this reset mechanism is reachable after abort.

This is a source-supported concurrency risk requiring an integration regression, not an executed cross-chat misdelivery. Exact overlap depends on the owner and provider's cancellation behavior. Recommendation: scoped sink ownership tokens, compare-and-release cleanup, and turn-context destination dispatch; abort/reset may free the UI without granting stale callbacks current-turn authority. Regression: hold turn A, reset, start B with its own sink, finish A, then verify B still owns its destination and A cannot send.

## Additional implementation checks

- MCP tool names overwrite on sanitized ID collisions (`runtime.ts:25-26,259-263`), e.g. `a.b` and `a_b`; validation only requires nonempty IDs. Reject collisions before setup, including duplicate raw IDs. No caller/config collision reachability repro executed. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/mcp/runtime.ts`: servers whose sanitized ids collide (and duplicate raw ids) are rejected before setup instead of silently overwriting each other's tools. Regression: `src/mcp/runtime-collisions.test.ts`.
- MCP command preflight checks the host PATH/cwd rather than `server.env` and `server.cwd` (`runtime.ts:239`, `command-exists.ts:13-24`); valid server-relative executables can be rejected. Add isolated executable fixtures for configured cwd and PATH. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/mcp/runtime.ts` and `command-exists.ts`: the preflight resolves the executable against the server's configured `cwd` and `PATH` rather than the host's, so a valid server-relative executable is no longer rejected. Regression: `src/mcp/runtime-preflight.test.ts`.
- Pairing disk synchronization is an unlocked read-modify-write (`pairing.ts:59-95`) despite documented cross-process approval support. Concurrent registrations/approvals can lose writes or consume a code twice. Reproduce with barriers in separate processes before changing storage. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/telegram/pairing.ts`: the read-prune-modify-rename cycle is held under an exclusive lock file next to the store, with stale-owner takeover and a bounded wait after which the cycle proceeds unlocked rather than refusing to pair, so two processes cannot lose a registration or consume one code twice. Regression: `src/telegram/pairing.crossprocess.test.ts`, whose two-process barrier cases and the lock-held case fail against the pre-fix module.
- Media generation downloads entire remote sources and synchronously writes arbitrary requested output paths (`media.ts:95-104,152-161,219-264`), and does not re-check abort immediately before committing output. Permission/sandbox enforcement at callers was not reviewed here, so this is not a confirmed sandbox bypass. Verify caller approval and cancellation fences before asserting security impact. — **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/grok/media.ts`: downloads are size-bounded and the abort signal is re-checked immediately before the output file is committed. Regression: `src/grok/media.test.ts`.
- The model catalogue was read to inspect runtime selection; no claim is made that any listed model, price, or context window is currently valid/invalid. Unknown identifiers pass through normalization.

## Coverage and verification boundary

Fully read production files (22):

```text
src/mcp/catalog.ts
src/mcp/command-exists.ts
src/mcp/parse-headers.ts
src/mcp/runtime.ts
src/mcp/validate.ts
src/telegram/audio-input.ts
src/telegram/bridge.ts
src/telegram/headless-bridge-paths.ts
src/telegram/headless-bridge.ts
src/telegram/index.ts
src/telegram/limits.ts
src/telegram/pairing.ts
src/telegram/poller-lock.ts
src/telegram/preview-stream.ts
src/telegram/send-file.ts
src/telegram/turn-coordinator.ts
src/telegram/typing-refresh.ts
src/grok/batch.ts
src/grok/client.ts
src/grok/media.ts
src/grok/models.ts
src/grok/tool-schemas.ts
```

Fully read supporting tests: `src/telegram/bridge.test.ts`, `src/telegram/turn-coordinator.test.ts`, `src/mcp/runtime.test.ts`. Other tests/fixtures in these directories were inventoried but not read. No existing test suite was rerun by this reviewer; parent baseline evidence is separate. Both executed reproductions above were one-off `bun --eval` commands and left no fixture files.

Partial supporting reads/searches: `src/core/extensions/sinks.ts:205-242`; `src/ui/hooks/use-session-lifecycle.ts:55-100`; installed MCP stdio transport lines matching stderr construction/piping; references in `src/core/extensions`, `src/ui/app.tsx`, `src/agent/agent.ts`, `src/ui/hooks`. These are not full-file reviews. Persona files and `.agent-memory/MEMORY.md` were read for instructions; historical findings were not treated as current proof.

No performance benchmark, live provider interaction, Telegram integration session, or live TUI verification was performed. Recommend fixing the confirmed destination/lifetime/deadline defects before general module restructuring.
