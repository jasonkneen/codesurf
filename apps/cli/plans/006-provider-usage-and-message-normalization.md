# Plan 006: One usage-snapshot mapper and one message normalizer across providers (fixes silent image drop)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0f643..HEAD -- src/core/extensions/builtin/openai-chat-utils.ts src/core/extensions/builtin/hermes-gateway-provider.ts src/core/extensions/builtin/codesurf-desktop-provider.ts src/core/extensions/builtin/codex-provider.ts src/core/extensions/builtin/omnigent-provider.ts src/core/extensions/builtin/claude-agent-provider.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (pairs well after 004)
- **Category**: tech-debt (includes one latent-bug fix)
- **Planned at**: commit `ed0f643`, 2026-07-15

## Why this matters

Two provider-cluster concerns are copy-pasted with **drift that is already a
latent bug**:

1. **Message stringification**: `stringifyContent` exists 3× —
   `openai-chat-utils.ts` (shared, renders image parts as `[image: <url>]`,
   joins with `\n`), a verbatim copy in `hermes-gateway-provider.ts`, and a
   DRIFTED copy in `codesurf-desktop-provider.ts` that **silently drops all
   non-text parts** (images vanish on the desktop/daemon path) and joins with
   `""`. Three behaviors for one job; one of them loses user content.
2. **Usage mapping**: converting a provider's token-usage record to
   `ProviderUsageSnapshot` is re-implemented 5× with inconsistent field
   coverage — `codex-provider.ts` never sets `cacheWriteTokens`, so cache
   accounting is silently absent on that path.

## Current state

- `src/core/extensions/builtin/openai-chat-utils.ts` — the shared helpers:
  private `stringifyContent` (handles `text`, `image_url` → `[image: url]`,
  other typed parts → `[type]`, joins `\n`) and exported
  `normalizeOpenAiMessages(input)` which maps roles/content/tool_calls and
  appends `input.prompt` as a final user turn if not already last.
- `src/core/extensions/builtin/hermes-gateway-provider.ts:91-110` — private
  `stringifyContent`, **verbatim identical** to the shared one;
  `normalizeMessages` at `:119-147` — same shape as `normalizeOpenAiMessages`
  incl. the append-prompt tail, with two small extras: it typeof-guards
  `tool_call_id` (string check) before passing it through.
- `src/core/extensions/builtin/codesurf-desktop-provider.ts:1162-1177` —
  drifted `stringifyContent`:
  ```ts
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; text?: string };
    if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("");
  ```
  (no image handling, no `[type]` placeholder, `""` join). Its
  `normalizeMessages` (`:975-998`, a class method) has a genuinely narrower
  output — `{ role: "user"|"assistant"|"system"; content: string }`, no
  tool_calls — so only `stringifyContent` is shared here, not the normalizer.
- Usage mappers (5 sites):
  - `codex-provider.ts:404-412` `usageFromTokens` — reads
    `inputTokens|input_tokens`, `outputTokens|output_tokens`,
    `cachedInputTokens|cache_read_tokens`; **never sets `cacheWriteTokens`**.
  - `omnigent-provider.ts:282-299` `usageFromValue` — snake_case Anthropic
    fields incl. `cache_creation_input_tokens`; returns `undefined` when all
    four absent.
  - `claude-agent-provider.ts:1068-1075` — inline mapping of
    `message.usage` snake_case fields.
  - `opencode-provider.ts:146-157` `usageFromMessage` — nested
    `tokens.cache.read/write` shape (structurally different — LEAVE it).
  - `openai-sse-consumer.ts:200-206` — OpenAI `prompt_tokens`/
    `completion_tokens` shape (different vocabulary — LEAVE it, but note in
    the new helper's doc comment).
- `ProviderUsageSnapshot` is defined in `src/core/extensions/api.ts` (fields:
  `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`).
- Tests exist: `hermes-gateway-provider.test.ts`, `codex-provider.test.ts`,
  `omnigent-provider.test.ts`, `knowledge-extensions.test.ts` etc. in the same
  directory. NOTE: ~9 extension tests are known to fail under `bunx vitest`
  (bun:sqlite, pre-existing) — establish which BEFORE changing anything:
  run the test files below once on a clean tree and record results.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Install   | `bun install`                                  | exit 0              |
| Typecheck | `bun run typecheck`                            | exit 0, no errors   |
| Baseline tests (run BEFORE changes) | `bunx vitest run src/core/extensions/builtin/hermes-gateway-provider.test.ts src/core/extensions/builtin/codex-provider.test.ts src/core/extensions/builtin/omnigent-provider.test.ts` | record pass/fail per file |
| Lint      | `bun run lint`                                 | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/core/extensions/builtin/openai-chat-utils.ts` (export
  `stringifyContent`; port the `tool_call_id` typeof guard)
- `src/core/extensions/builtin/provider-usage.ts` (create) + its test
- `src/core/extensions/builtin/hermes-gateway-provider.ts`
- `src/core/extensions/builtin/codesurf-desktop-provider.ts`
- `src/core/extensions/builtin/codex-provider.ts`
- `src/core/extensions/builtin/omnigent-provider.ts`
- `src/core/extensions/builtin/claude-agent-provider.ts`

**Out of scope** (do NOT touch):
- `opencode-provider.ts` and `openai-sse-consumer.ts` usage mappers (different
  shapes, documented above).
- SSE parsing, abort wiring, registration boilerplate — known duplication,
  separate backlog items (DEBT-02/05/07).
- The daemon itself (`packages/codesurf-daemon`) — the desktop provider's wire
  format must keep working against it.

## Git workflow

- Branch: `advisor/006-provider-usage-and-normalization`
- Conventional commits, e.g. `refactor(providers): shared usage mapper + stringifyContent (fix image drop)`
- Do NOT push or open a PR (pushes are blocked on this repo by history-based
  push protection; commit locally only).

## Steps

### Step 0: Baseline

Run the baseline test command from the table; record per-file results. Any
file already failing on a clean tree is excluded from later "must pass"
judgments (bun:sqlite issue) — run those under `bun test <file>` instead and
record that result too.

### Step 1: Create the shared usage mapper

Create `src/core/extensions/builtin/provider-usage.ts`:

```ts
import type { ProviderUsageSnapshot } from "../api";

/** Map a loosely-shaped usage record (Anthropic/Codex style, snake_case or
 *  camelCase) to a ProviderUsageSnapshot. Field aliases cover every provider
 *  in this directory EXCEPT opencode (nested tokens.cache shape) and the
 *  OpenAI SSE consumer (prompt_tokens vocabulary) — those keep local mappers.
 *  Returns undefined when no recognized field is present. */
export function usageFromRecord(value: unknown): ProviderUsageSnapshot | undefined {
  const u = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!u) return undefined;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) if (typeof u[k] === "number") return u[k] as number;
    return undefined;
  };
  const snapshot: ProviderUsageSnapshot = {
    inputTokens: num("inputTokens", "input_tokens"),
    outputTokens: num("outputTokens", "output_tokens"),
    cacheReadTokens: num("cacheReadTokens", "cachedInputTokens", "cache_read_tokens", "cache_read_input_tokens"),
    cacheWriteTokens: num("cacheWriteTokens", "cachedCreationInputTokens", "cache_write_tokens", "cache_creation_input_tokens"),
  };
  return snapshot.inputTokens === undefined && snapshot.outputTokens === undefined &&
    snapshot.cacheReadTokens === undefined && snapshot.cacheWriteTokens === undefined
    ? undefined
    : snapshot;
}
```

Add `provider-usage.test.ts` beside it: snake_case in, camelCase in, mixed,
empty object → undefined, non-object → undefined, and the codex regression
case (`cache_creation_input_tokens` present → `cacheWriteTokens` set).

**Verify**: `bunx vitest run src/core/extensions/builtin/provider-usage.test.ts` → all pass.

### Step 2: Adopt it at the three compatible sites

- `codex-provider.ts`: replace `usageFromTokens`'s body with
  `return usageFromRecord((params.usage as ...) ?? params) ?? {};` — PRESERVE
  its current contract of returning `{}` (not undefined) if that's what
  callers expect (read the call sites of `usageFromTokens` first). This is the
  bug fix: codex turns now report `cacheWriteTokens` when present.
- `omnigent-provider.ts`: replace `usageFromValue` body with
  `return usageFromRecord(value);` (contract matches: undefined when empty).
- `claude-agent-provider.ts:1068-1075`: replace the inline object with
  `usageFromRecord(message.usage) ?? {}` in the success branch (keep the `{}`
  for the non-success branch).

**Verify**: `bun run typecheck` → exit 0; re-run the Step 0 test files →
same-or-better than baseline (files that were green stay green).

### Step 3: Export and adopt the shared `stringifyContent`

In `openai-chat-utils.ts`: change `function stringifyContent` to
`export function stringifyContent`, and add the `tool_call_id` string
typeof-guard from hermes to `normalizeOpenAiMessages` (pass it only when
`typeof msg.tool_call_id === "string"`) — strictly safer, no behavior loss.

In `hermes-gateway-provider.ts`: delete the private `stringifyContent`
(`:91-110`) and `normalizeMessages` (`:119-147`); import
`normalizeOpenAiMessages` (and nothing else) from `./openai-chat-utils` and
use it where `normalizeMessages(input)` was called. Before swapping, diff the
two normalizers line by line — their intent is identical (verified at
planning), but if you find ANY semantic difference beyond the tool_call_id
guard you just ported, STOP.

**Verify**: `bun run typecheck` → exit 0; hermes test file → same-or-better
than baseline.

### Step 4: Fix the desktop provider's image drop (deliberate behavior change)

In `codesurf-desktop-provider.ts`: delete the private `stringifyContent`
(`:1162-1177`) and import the shared one from `./openai-chat-utils`. Its
`normalizeMessages` method stays (narrower output shape), now calling the
shared `stringifyContent`.

Consequences to state in your report (intended, not accidental):
- Multi-part messages on the desktop/daemon path now join text parts with
  `\n` instead of `""`.
- Image parts now appear as `[image: <url>]` placeholders instead of
  disappearing entirely. The daemon receives plain strings either way — this
  cannot break its wire format, only change string content.

**Verify**: `bun run typecheck` → exit 0. If a desktop-provider test exists
(`ls src/core/extensions/builtin/codesurf-desktop-provider*.test.ts`), run it
and reconcile any exact-string expectations with the two documented changes.

## Test plan

- New: `provider-usage.test.ts` (Step 1, ≥6 cases including the codex
  cache-write regression).
- Baseline-relative: the three provider test files from Step 0 — every file
  green at baseline must be green after.
- Report net line delta (`git diff --stat`); expect roughly −80 lines.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0 and `bun run lint` exits 0
- [ ] `bunx vitest run src/core/extensions/builtin/provider-usage.test.ts` exits 0
- [ ] Step 0-green test files still pass
- [ ] `grep -rn "function stringifyContent" src/core/extensions/builtin/` →
      exactly 1 match (openai-chat-utils.ts)
- [ ] `grep -n "cacheWriteTokens" src/core/extensions/builtin/codex-provider.ts`
      → present via the shared mapper (i.e. `usageFromTokens` now delegates)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Hermes's `normalizeMessages` differs semantically from
  `normalizeOpenAiMessages` beyond the tool_call_id guard (Step 3 diff).
- Any call site of the replaced usage mappers depends on a field or fallback
  the shared mapper doesn't cover (read call sites before replacing).
- Evidence appears that the daemon path REQUIRES the `""` join or the absence
  of image placeholders (e.g. a daemon-side parser splitting on exact
  strings) — check `packages/codesurf-daemon/src/` for consumers of message
  content before Step 4 if in doubt.
- A baseline-green test fails after your change and one honest fix attempt
  doesn't restore it.

## Maintenance notes

- New providers should use `usageFromRecord` unless their usage shape is
  genuinely different (then document why locally, as opencode now does).
- Reviewer attention: Step 4 is a user-visible behavior change on the desktop
  path (images become placeholders instead of vanishing) — worth a manual
  desktop-app smoke if available.
- Deferred (backlog): unifying the 4 SSE parse loops (DEBT-02) and the ~9
  abort/timeout wirings (DEBT-05) — bigger, riskier, do after this lands.
