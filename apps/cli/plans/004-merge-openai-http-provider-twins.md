# Plan 004: Merge the byte-identical lightclaw/local-llm HTTP sessions into one shared class

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0f643..HEAD -- src/core/extensions/builtin/lightclaw-provider.ts src/core/extensions/builtin/local-llm-provider.ts`
> If either file changed since this plan was written, re-run the Step 1 diff
> before proceeding; on a mismatch with "Current state", treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `ed0f643`, 2026-07-15

## Why this matters

`LightclawSession` (`lightclaw-provider.ts:134`) and `LocalLlmSession`
(`local-llm-provider.ts:163`) are the same ~110-line class twice: a verified
`diff` of the two `sendTurn` bodies shows exactly **2 differing lines, both
error-message strings** ("lightclaw" vs "local-llm"). `local-llm-provider.ts`'s
own header comment says it "Mirrors `lightclaw-provider.ts` (the canonical
OpenAI-compatible-HTTP template)". Every streaming/abort/error fix currently
must land twice and will eventually drift. This plan extracts one shared
session class; both providers keep their own manifests, settings, and model
discovery.

## Current state

- `src/core/extensions/builtin/lightclaw-provider.ts` (375 lines) — OpenAI-
  compatible HTTP provider. `class LightclawSession implements ProviderSession`
  at `:134`; resolver-based constructor at `:140-154`:
  ```ts
  private readonly resolvers: {
    baseUrl: () => string;
    apiKey: () => string;
    timeoutMs: () => number;
    verbose: () => boolean;
  };
  constructor(resolvers: { ... same shape ... }) { this.resolvers = resolvers; }
  sendTurn = async (input: ProviderTurnInput, controller: ProviderStreamController)
    : Promise<{ usage?: ProviderUsageSnapshot }> => { ... }
  ```
  `sendTurn` (`:156-245`) POSTs `/chat/completions` with `stream: true` and
  pipes the response through the shared `consumeOpenAiSseStream` from
  `./openai-sse-consumer`.
- `src/core/extensions/builtin/local-llm-provider.ts` (414 lines) — same
  class shape at `:163`; `sendTurn` at `:185-274`. Verified diff vs
  lightclaw's `sendTurn`: only these two lines differ —
  `"lightclaw /chat/completions returned ${response.status}"` vs
  `"local-llm /chat/completions returned ${response.status}"`, and
  `"lightclaw /chat/completions returned no body"` vs
  `"local-llm /chat/completions returned no body"`.
- Shared helpers already in place: `consumeOpenAiSseStream`
  (`openai-sse-consumer.ts:48`), `normalizeOpenAiMessages`
  (`openai-chat-utils.ts`). Both providers already use them.
- `local-llm-provider.test.ts` exists;
  `lightclaw-provider.test.ts` does NOT.
- Repo conventions: builtin extensions are single files exporting an
  `ExtensionModule` (`manifest` + `activate`); shared provider helpers live as
  sibling modules in the same directory (`openai-sse-consumer.ts`,
  `openai-chat-utils.ts`). Follow that.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Install   | `bun install`                                  | exit 0              |
| Typecheck | `bun run typecheck`                            | exit 0, no errors   |
| Tests     | `bunx vitest run src/core/extensions/builtin/local-llm-provider.test.ts` | all pass |
| Lint      | `bun run lint`                                 | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/core/extensions/builtin/openai-http-session.ts` (create)
- `src/core/extensions/builtin/lightclaw-provider.ts`
- `src/core/extensions/builtin/local-llm-provider.ts`
- `src/core/extensions/builtin/openai-http-session.test.ts` (create, optional
  if you instead extend `local-llm-provider.test.ts`)

**Out of scope** (do NOT touch, even though they look related):
- `openai-sse-consumer.ts`, `openai-chat-utils.ts` — already shared; no
  changes needed.
- `hermes-gateway-provider.ts` — also OpenAI-shaped but has gateway-specific
  event handling (`hermes.tool.progress` via `onNamedEvent`); folding it in is
  a separate decision. Do not attempt it here.
- Provider manifests, settings definitions, model discovery (`listModels` /
  `discoverModels`) in both files — they genuinely differ; leave them.

## Git workflow

- Branch: `advisor/004-merge-openai-http-provider-twins`
- Conventional commits, e.g. `refactor(providers): share one OpenAI-HTTP session class`
- Do NOT push or open a PR (pushes are blocked on this repo by history-based
  push protection; commit locally only).

## Steps

### Step 1: Prove the duplication is still exact

```
sed -n '134,250p' src/core/extensions/builtin/lightclaw-provider.ts > /tmp/lc.txt
sed -n '163,279p' src/core/extensions/builtin/local-llm-provider.ts > /tmp/ll.txt
diff /tmp/lc.txt /tmp/ll.txt
```
Expected: only the class name line and the two error-string lines differ (line
ranges may have shifted slightly — locate `class LightclawSession` /
`class LocalLlmSession` and diff from the class keyword through the end of
`sendTurn`). If ANY logic line differs, STOP and report the diff.

### Step 2: Create the shared class

Create `src/core/extensions/builtin/openai-http-session.ts` exporting:

```ts
export interface OpenAiHttpResolvers {
  baseUrl: () => string;
  apiKey: () => string;
  timeoutMs: () => number;
  verbose: () => boolean;
}

export class OpenAiHttpSession implements ProviderSession {
  constructor(
    private readonly providerLabel: string, // used in error messages
    private readonly resolvers: OpenAiHttpResolvers,
    // plus whatever identity fields the current classes carry
    // (adapterId etc.) — copy them as constructor params
  ) {}
  // sendTurn / abortTurn / disconnect: moved VERBATIM from LightclawSession,
  // with the two error strings templated:
  //   `${this.providerLabel} /chat/completions returned ${response.status}`
  //   `${this.providerLabel} /chat/completions returned no body`
}
```

Copy the class body from `LightclawSession` verbatim; the ONLY edits are the
class name, the constructor signature, and templating those two strings.
Bring the imports the body needs (`consumeOpenAiSseStream`,
`normalizeOpenAiMessages`, the `Provider*` types from `../api`).
Add a file-header comment in the style of the existing sibling helpers
(one paragraph: what it is, who uses it).

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Point both providers at it

In each provider file: delete the local session class; construct
`new OpenAiHttpSession("lightclaw", resolvers, ...)` /
`new OpenAiHttpSession("local-llm", resolvers, ...)` at the former
construction sites. Remove now-unused imports in both files.

**Verify**: `bun run typecheck` → exit 0;
`bunx vitest run src/core/extensions/builtin/local-llm-provider.test.ts` → all pass;
`grep -n "class LightclawSession\|class LocalLlmSession" src/core/extensions/builtin/` → no matches.

### Step 4: Cover the shared class

`local-llm-provider.test.ts` exercises the session indirectly — read it. If it
mocks fetch/SSE at the session boundary, add one test (there or in a new
`openai-http-session.test.ts`, mirroring its structure) asserting the error
message includes the provider label for a non-OK response, for BOTH labels.

**Verify**: `bunx vitest run src/core/extensions/builtin/local-llm-provider.test.ts src/core/extensions/builtin/openai-http-session.test.ts` → all pass (adjust to wherever the test landed).

## Test plan

Covered in Steps 1 and 4. Net line delta should be roughly −100 lines across
the two provider files (report the actual `git diff --stat`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bunx vitest run src/core/extensions/builtin/local-llm-provider.test.ts` exits 0
- [ ] `grep -rn "class LightclawSession\|class LocalLlmSession" src/` → no matches
- [ ] Both providers construct `OpenAiHttpSession` with distinct labels
      (`grep -n "new OpenAiHttpSession" src/` → exactly 2 matches)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's diff shows ANY difference beyond the class name and the two error
  strings.
- Either provider's session carries provider-specific fields/methods not
  present in the other (the classes are no longer twins).
- `local-llm-provider.test.ts` fails for a reason you can't attribute to a
  mechanical import/rename issue after one honest fix attempt.

## Maintenance notes

- Future OpenAI-compatible HTTP providers should use `OpenAiHttpSession` +
  their own manifest/settings, not a copy. Update the header comment in
  `local-llm-provider.ts` (which currently says it "mirrors"
  lightclaw) to say both delegate to the shared session.
- `hermes-gateway-provider.ts` is the natural third adopter once its
  `onNamedEvent` hook is threaded through as an option — deferred (see
  backlog DEBT-02/DEBT-05 in `plans/README.md`).
