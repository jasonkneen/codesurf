# CodeSurf provider and transport review

Date: 2026-09-05. Checkout HEAD: `3383e20`. Astra source review and offline probes only; no product code changed and no live provider or external daemon was exercised. Implementation remains assigned to the requested Spark workflow. General model-runtime cache/connect/dispose races are already covered by the Cordis plan and are not repeated here.

## Findings

### P1 — Codex cancellation releases a turn before upstream identity is known or retired

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/native/codex-provider.ts`. Each turn owns its state and identity: the start response id is captured, a cancellation that arrives before it is remembered and the interrupt is sent once the id is known, incoming notifications are routed by thread and turn so a retired generation's text, usage or completion cannot reach a replacement, and concurrent sends on one session are refused. Regression: `src/core/extensions/builtin/codex-provider.test.ts`.

`src/core/extensions/native/codex-provider.ts:489-524,550-554` resolves the active turn immediately on abort, sends an interrupt only when `activeTurnId` is already known, and accepts every later notification without checking thread or turn identity. Abort between `turn/start` and `turn/started` leaves the remote turn running without an interrupt. After local cleanup and a replacement turn, late text, usage, or completion from the cancelled turn can be delivered to the replacement controller or settle its promise. There is also no same-session concurrent-send guard.

Give each turn a state/identity owner, capture the start response ID, remember cancellation during startup, and drain/acknowledge interruption before permitting reuse. Route notifications by thread and turn; ignore retired generations. Regression: defer start notification, cancel A, begin B, then release A's text and completion; B receives neither, and A is interrupted once its ID becomes available. Test overlapping sends explicitly.

### P1 — Codex process exit does not settle a streaming turn; spawn failures lack handlers

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/native/codex-provider.ts`. Child `exit`/`close` rejects the active turn and any pending approvals rather than only outstanding RPC requests, `disconnect` awaits child close, child and stdin `error` events are handled so an asynchronous ENOENT surfaces as a turn failure, stderr is drained with a bound, and startup and request waits are bounded. Regression: `src/core/extensions/builtin/codex-provider.test.ts`.

`codex-provider.ts:115-130` handles child `exit` by rejecting only outstanding RPC requests. Once `turn/start` has returned, `sendTurn` waits on a separate `done` promise (`493-503`), which no exit path rejects or resolves. A child crash at this stage leaves the turn pending indefinitely. `disconnect` (`557-561`) also only stops the child and resets connection flags. Child `error` and piped stderr are not handled in `start`: an asynchronous ENOENT can surface as an unhandled event, and sustained stderr can fill its pipe. RPC requests have no deadline.

Make transport terminal failure notify its session owner, reject the active turn and approvals, and await child close on disposal. Attach child/stdin error handling, drain bounded stderr, and bound request/startup waits. Regressions: exit after successful start response; disconnect during generation; missing executable; stderr flood; never-replied initialize. These are source-established failure paths, not live Codex repros.

### P1 — Persistent stdio reuse can attribute timed-out or cancelled output to the next turn

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/builtin/transports/persistent-stdio-session.ts`. A timed-out or cancelled turn puts the session into a draining state that retires ownership and refuses to attribute later output to a new turn; disposal awaits process termination with bounded SIGTERM/SIGKILL escalation, and `AmpSession.disconnect` now returns that promise so provider disposal actually waits. Regression: `src/core/extensions/builtin/transports/persistent-stdio-session.test.ts` and `persistent-stdio-session.process.test.ts`.

`transports/persistent-stdio-session.ts:151-179,185-191,235-245` dispatches all incoming objects to the current `activeTurn`. Timeout clears that owner while leaving the process running. Host-signal cancellation similarly rejects immediately and only sends SIGINT. A new send is then allowed; delayed prior output can be decoded as the new turn, including its terminal assistant stop. `abortTurn` itself (`272-280`) only signals the child and does not settle or retire ownership.

Introduce a draining state until a reliable upstream boundary or child close; if the protocol cannot identify turns, recreate the transport before accepting another input. Regression: A times out or is cancelled, B is submitted, then A emits text and terminal stop; B must remain untouched. Add a child that ignores SIGINT. Cordis disposal must await process termination with bounded escalation, rather than returning immediately after a signal.

### P1 — Claude tool permission callback executes a fast path before host approval

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/native/claude-agent-provider.ts`. `buildCanUseTool` makes the host authorization decision first — the live yolo/dontAsk/acceptEdits policy, else a denial when there is no active turn or the previous turn is still draining, else the approval prompt on the active turn's controller — and only then chooses between the native ripgrep fast path and an SDK allow, so no read happens before or without approval and a late request from a retired turn cannot be authorized against its replacement. Regression: `src/core/extensions/builtin/claude-agent-provider-permission.test.ts`.

In the inspected permission handler, `claude-agent-provider.ts:775-835` runs matching Bash/ripgrep requests through `executeGrep` at line 793 before checking host auto-allow policy at line 874 or creating an approval prompt. A request that reaches this callback for host permission therefore performs the read without that permission decision. The no-active-turn branch (`878-883`) also returns allow, although absence of a controller does not establish authorization to execute a late tool request.

Decide authorization before selecting native versus SDK execution. Deny or cancel out-of-turn execution unless an explicit policy permits it. Regression: with a prompt-required policy, a matching ripgrep request performs zero reads before approval and none after denial; a late request after turn retirement is denied. Preserve the explicitly supported yolo/dontAsk behavior. This finding does not assert shell injection in the ripgrep parser, which was not reviewed here.

### P2 — Shared SSE parser loses CRLF streams and can buffer without a frame bound

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/builtin/openai-sse-consumer.ts`. Framing is incremental and line-based: LF, CRLF and bare CR all terminate lines and a trailing CR is held back so a split across chunks reassembles, the decoder runs in streaming mode and is flushed at end of stream, and an event exceeding the exported `MAX_SSE_EVENT_CHARS` bound (4 MiB, overridable) throws and cancels the reader instead of buffering without limit. Regression: `src/core/extensions/builtin/openai-sse-consumer.test.ts` (`framing`).

`openai-sse-consumer.ts:69-75` recognizes only `\n\n` boundaries. A stream framed with `\r\n\r\n` never reaches event parsing; at EOF the function reports successful completion without content. Its accumulated buffer also has no limit, so a long unterminated event retains arbitrary response data.

Offline Bun probe against the actual consumer supplied CRLF-framed `hello` plus `[DONE]`; the only emitted events were empty usage and done/stop. Implement incremental line-based framing that tolerates CR/LF splits, impose a documented event-size bound, and reject oversized/malformed framing. Regressions should split framing and UTF-8 bytes across chunks and compare LF/CRLF output.

### P2 — Usage-only SSE chunks are skipped and completion is emitted twice

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/builtin/openai-sse-consumer.ts`. Usage is read independently of choices, so a trailing `{choices: [], usage: …}` chunk is counted, and exactly one terminal event is emitted after trailing usage, retaining the real finish reason instead of a second hardcoded `stop` from `[DONE]` or end of stream. Regression: `src/core/extensions/builtin/openai-sse-consumer.test.ts` (`usage and termination`).

`openai-sse-consumer.ts:157-160` skips events without a first choice before usage is read at `200-207`. A `{ choices: [], usage: ... }` chunk therefore loses accounting. A choice finish reason emits done at line 196, and `[DONE]` emits another done with hardcoded `stop` at `114-117`; natural EOF has the same second-completion behavior (`213-215`). This discards the semantic distinction between a length limit, tool calls, and ordinary stop for consumers that retain the last terminal event.

Offline probe: a `length` finish followed by an empty-choice usage record with 10 input/5 output tokens and `[DONE]` emitted done/length, empty usage, done/stop; the returned usage was undefined. Process usage independently of choices and emit one terminal event after trailing usage, retaining the real reason. Regressions must assert both returned usage and the exact terminal event count/reason. The probe establishes provider contract behavior, not a downstream UI failure.

### P2 — Shared HTTP timeout stops at headers, not turn completion

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/builtin/openai-http-session.ts`. The turn keeps a named controller and its deadline through body consumption, so a server that sends headers and then stalls is timed out; the host abort listener is removed in `finally`, and `abortTurn`/`disconnect` abort the active request instead of being no-ops. Regression: `src/core/extensions/builtin/openai-http-session.test.ts`.

`openai-http-session.ts:62,91,108-113` clears the request timeout immediately after fetch resolves and consumes the body using only the host signal. A server that sends headers and then stops delivering SSE can keep the turn open forever despite the configured timeout. The anonymous host abort listener is not removed after success; `abortTurn` and `disconnect` are no-ops (`122-128`), leaving no session-owned termination path.

Offline fake-fetch probe used a never-ending body and 5 ms timeout; after 30 ms the turn was still pending and the request signal remained un-aborted. The probe then cancelled through the host signal and cleaned up. Retain a named turn controller and deadline through body consumption, remove listeners in finally, and abort active work on disposal. `hermes-gateway-provider.ts:212-328` already demonstrates whole-body timeout and listener cleanup and is useful existing code to preserve. Test headers-then-stall, timeout during body, disconnect, and balanced listeners.

### P2 — One-shot cancellation can hang indefinitely on a child ignoring SIGTERM

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/builtin/transports/oneshot-stdio-turn.ts`. A pre-aborted signal rejects before spawn; on abort the turn owns termination with SIGTERM, SIGKILL after a grace period and one further bounded wait, and it settles exactly once — on the child's `exit`, or immediately if the child had already exited, rather than on `close`, which a descendant holding the inherited pipes can postpone indefinitely. Regression: `src/core/extensions/builtin/transports/oneshot-stdio-turn.test.ts`, whose abort-after-exit case hangs against the pre-fix guard.

`transports/oneshot-stdio-turn.ts:78-87,140-154` sends one SIGTERM and settles only at child close. No grace deadline or escalation exists. It also starts the child before checking an already-aborted signal. A child that ignores termination, or descendants retaining inherited pipes, can leave cancellation waiting indefinitely.

Check cancellation before spawn, use an owned termination sequence with bounded grace and escalation, and settle exactly once after teardown. Regress with a local fixture that ignores SIGTERM and with a pre-aborted input; do not require a real provider. Keep process-group behavior platform-aware and distinguish owned children from unrelated processes.

### P2 — OpenCode can recreate owned resources after disconnect during startup

**Implementation status (2026-09-05, resumed in Claude Code):** partially repaired in `src/core/extensions/native/opencode-provider.ts`. The session keeps an ownership epoch that `disconnect()` advances before any I/O, so a server or session that finishes starting under a stale epoch is closed rather than adopted and its turn rejects; the per-turn controller is created before startup so disconnect aborts an in-flight prompt, including on an externally configured server, and every path resolves the directory through the host workspace service instead of `process.cwd()`. Regression: `src/core/extensions/builtin/opencode-provider.test.ts`. Two of the three remaining items are now repaired; the third is blocked by the dependency.

- **Closed:** the server boot call receives the turn's abort signal. `createOpencodeServer` accepts `signal` (`@opencode-ai/sdk/dist/server.d.ts`), so `ensureClient` passes the session's per-turn controller and a Stop during a cold boot ends the wait instead of running to the start timeout. Regression: `opencode-provider.test.ts` ("hands the turn's abort signal to the server boot").
- **Closed:** model discovery no longer competes for the configured port. Its throwaway server — used for one `config.providers` read — starts on port 0, so it cannot fight the session server or the user's own `opencode serve` for the listener. To read models *from* an already-running server, point the base-URL setting at it. Regression: the discovery test now asserts `port: 0`.
- **Blocked, not deferred:** disposal still cannot await the owned process's close. `createOpencodeServer` resolves to `{ url: string; close(): void }` — `close` returns `void` and the child process is not exposed, so there is nothing to await. Closing this needs an upstream SDK change (a promise from `close`, or the child handle); it cannot be done from this side.

`opencode-provider.ts:185-215,224-225,282-287` awaits server/session creation without a disposal flag or ownership epoch. Disconnect while startup is pending sees no server, returns, and the suspended startup later stores a server/client/session and continues. Disconnect from an externally configured server also does not abort the active prompt. The configured workspace service is ignored in favor of `process.cwd()` throughout these paths.

Use a plugin-owned server connection plus conversation-owned session children; disposal invalidates pending startup and closes late resources, aborts active prompts, and waits for owned process close. Resolve the workspace through injected host services. Regression: defer server startup, disconnect, release startup, assert close and zero prompt calls; repeat with remote prompt cancellation and differing host workspace/process cwd. This is provider-internal resource ownership, distinct from the model-runtime cache race.

### P2 — Omnigent POST failure leaves its already-started stream task unowned

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/native/omnigent-provider.ts`. The stream reader and the POST are joined under one turn scope, so a rejected POST aborts and awaits the reader before ownership is released — no later emissions, no pending task and no unhandled rejection. Regression: `src/core/extensions/builtin/omnigent-provider.test.ts`.

In `omnigent-provider.ts:571-595`, the stream reader starts before awaiting `postMessageEvent`. If the POST rejects, control skips the await of `streamPromise`; finally clears the timeout and drops `activeAbort` without aborting or joining the reader. A reader that remains open can continue emitting after sendTurn failed; a later rejection can be unhandled. The surrounding class was only partially inspected.

Join the stream and POST under one turn scope; on either failure abort and await the sibling before releasing ownership. Regression: open a controllable SSE stream, reject POST, and assert reader cancellation, no later controller emissions, no pending task, and no unhandled rejection.

### P2 — Credential probes do not consistently follow configured executables or remain asynchronous

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/native/amp-provider.ts`, `grok-provider.ts` and `codex-provider.ts`. The availability probe and execution share one executable resolution, so a valid absolute configured executable outside `PATH` passes the credential gate, and the checks are bounded and asynchronous — replacing the unbounded synchronous `codex login status` fallback. Regression: `src/core/extensions/builtin/amp-provider.test.ts` and `grok-provider.test.ts`.

`amp-provider.ts:102,172-173` and `grok-provider.ts:169,255-256` use the configured binary for execution but check only the default executable for availability. A valid absolute configured executable outside PATH can therefore fail the credential gate. `codex-provider.ts:573-579` falls back to unbounded `execFileSync("codex", ["login", "status"])` when the default auth file is absent, blocking the caller/event loop until completion.

Share executable resolution between probes and execution, and use bounded asynchronous credential checks cached through the host service. Test custom executable with absent default PATH entry and a nonreturning login-status fixture. No credential values were read during this review.

## Native Cordis ownership recommendations

- Keep pure wire helpers (`provider-usage`, history projection, SSE/NDJSON framing and event translation) independent of host UI, settings singletons and concrete tools. Expose explicit input/output contracts through the provider package.
- Let provider plugin fibers own model/discovery registration and connection factories; create conversation/turn child scopes for sockets, readers, processes, RPC requests, approval continuations, watchdogs and listeners. Cleanup must abort, join tasks, and await child close before replacement.
- Inject workspace, credentials/configuration, approved tool execution, contribution registries and transport factories. The Claude ripgrep optimization should call the approved tool service rather than import a concrete tool directly.
- Preserve provider/adapter/model identity separately from upstream thread/session identity. Keep protocol-specific permission decisions in adapters, but require one host policy decision before any local execution. Do not infer permission from an absent turn/controller.
- Separate OpenCode server ownership from conversation ownership and discovery. Current discovery (`349-378`) independently starts a server on the same configured port as a session; a shared service should serialize/acquire that owned server instead of competing for the port.
- Do not mark a native conversion complete by wrapping `activate(api)`. Migrate real resource lifetimes, and retain existing useful cleanup in Hermes and turn-signal cleanup in Grok.

## Exact coverage and limits

Fully read implementation files, all paths relative to `src/core/extensions/builtin/`:

- `amp-provider.ts` (273 lines)
- `anthropic-provider.ts` (143)
- `codex-provider.ts` (706)
- `grok-provider.ts` (342; initially truncated combined output was filled by a targeted tail read)
- `lightclaw-provider.ts` (262)
- `local-llm-provider.ts` (300)
- `opencode-provider.ts` (528; import/header gap filled by separate read)
- `xai-provider.ts` (120)
- `openai-chat-utils.ts` (98)
- `openai-http-session.ts` (129)
- `openai-sse-consumer.ts` (289)
- `provider-history-preface.ts` (85)
- `provider-usage.ts` (32)
- `transports/index.ts` (complete)
- `transports/ndjson.ts` (complete)
- `transports/oneshot-stdio-turn.ts` (complete)
- `transports/persistent-stdio-session.ts` (complete)

Fully read tests: `openai-http-session.test.ts` (69 lines), `openai-sse-consumer.test.ts` (18). The latter tests text splitting only; no claim is made that other provider suites lack SSE coverage.

Partially read implementation:

- `claude-agent-provider.ts:715-950`: abort, permission callback, disconnect and watchdog entry only.
- `hermes-gateway-provider.ts:190-333`: send, abort, disconnect and warm-cache introductory comment only.
- `omnigent-provider.ts:520-642`: session fields, send, abort/disconnect and URL resolution only.
- `src/agent/turns/session-turn.ts:140-174`: cancellation boundary and provider input/controller construction only, outside this review's implementation ownership.

Search-only, not reviewed: `codesurf-desktop-provider.ts`, `lazar-provider.ts`, `fractal-provider.ts`, `claude-grok-skills-provider.ts`. Unread remainder includes their helpers/tests, `anthropic-models-catalog.ts`, `transports/anthropic-stream-json.ts`, `transports/transports.test.ts`, all unlisted provider tests, and omitted sections of the partial files. File inventories, line counts and grep hits are not full review coverage. Model catalog identifiers were not declared valid/invalid or checked against live availability.

Validation here comprises the two in-memory SSE probe cases and one fake-fetch timeout probe described above. No tests were added and no typecheck/build/full-suite rerun was needed for this documentation-only change. Remaining lifecycle and permission findings need deterministic regression fixtures before claiming runtime reproduction or repair.
