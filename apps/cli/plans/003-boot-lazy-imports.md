# Plan 003: Lazy-load grammy and the Anthropic SDK off the CLI boot path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0f643..HEAD -- src/index.ts src/core/extensions/builtin/anthropic-provider.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ed0f643`, 2026-07-15

## Why this matters

Boot time is an active concern in this repo (see commit `ed0f643` "perf(boot):
stop executing CLIs just to ask whether they exist"). Two heavyweight
dependencies still load eagerly on EVERY launch of the TUI even though almost
no launch needs them: **grammy** (the Telegram bot framework — only the
`telegram-bridge` subcommand uses it) and **@ai-sdk/anthropic** (only needed
when the user actually connects an Anthropic API-key model). The repo already
has an established lazy-import pattern for exactly this (wallet, payments,
daemon, and even the UI itself are `await import(...)`ed); these two are the
stragglers.

## Current state

- `src/index.ts` — CLI entrypoint (Commander).
  - Eager import at `index.ts:32`:
    ```ts
    import { runTelegramHeadlessBridge } from "./telegram/headless-bridge";
    ```
    `src/telegram/headless-bridge.ts:18` imports `createTelegramBridge` from
    `./bridge`, and `src/telegram/bridge.ts:1` is `import { Bot } from "grammy"`
    (a value import) — so grammy and its transitive deps evaluate at process
    start on every launch.
  - Its only use is inside the subcommand action: `.command("telegram-bridge")`
    at `index.ts:499`, calling `await runTelegramHeadlessBridge({...})` at
    `index.ts:516`.
  - The established lazy pattern to copy (same file):
    ```ts
    // index.ts:589
    const { WalletManager } = await import("./wallet/manager");
    // index.ts:661
    const { SchedulerDaemon } = await import("./daemon/scheduler");
    ```
- `src/core/extensions/builtin/anthropic-provider.ts` — builtin provider,
  loaded at boot via the static builtin barrel
  (`src/core/extensions/builtin/index.ts` imports all builtin modules, and
  `src/index.ts:13` pulls that barrel).
  - Eager SDK import at `anthropic-provider.ts:9`:
    ```ts
    import { createAnthropic } from "@ai-sdk/anthropic";
    ```
  - Sole use, `anthropic-provider.ts:76-92`:
    ```ts
    function createSession(ctx: ProviderConnectionContext): ProviderSession {
      const apiKey = resolveApiKey(ADAPTER_ID, ENV_VAR);
      if (!apiKey) {
        throw new Error(`Anthropic API key not configured. Set ${ENV_VAR} or paste one via /models.`);
      }
      // Construct once per session; the SDK client is stateless and cheap.
      const anthropic = createAnthropic({ apiKey });
      return {
        adapterId: ctx.adapterId,
        providerId: ctx.providerId,
        mode: "stateless",
        strategy: "per-turn",
        getModel: (modelId) => anthropic(modelId),
      };
    }
    ```
    wired as `connect: createSession` at `anthropic-provider.ts:132`.
  - The provider contract explicitly allows async connect —
    `src/core/extensions/api.ts:593`:
    ```ts
    connect: (ctx: ProviderConnectionContext) => ProviderSession | Promise<ProviderSession>;
    ```
  - Contrast/exemplar: `claude-agent-provider.ts` and `codex-provider.ts`
    already defer their heavy SDKs behind `await import(...)` with type-only
    top-level imports. Match that.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Install   | `bun install`                                  | exit 0              |
| Typecheck | `bun run typecheck`                            | exit 0, no errors   |
| Build     | `bun run build`                                | exit 0              |
| Tests     | `bunx vitest run src/core/extensions/builtin/__tests__/` | all pass (skip known bun:sqlite failures if any) |
| Subcommand smoke | `node dist/index.js telegram-bridge --help` | help text, exit 0 |
| Boot timing (before AND after) | `time node dist/index.js --help` | wall time recorded |

## Scope

**In scope** (the only files you should modify):
- `src/index.ts`
- `src/core/extensions/builtin/anthropic-provider.ts`

**Out of scope** (do NOT touch, even though they look related):
- `src/telegram/bridge.ts`, `src/telegram/headless-bridge.ts` — no changes
  needed; only the import site moves.
- The builtin barrel `src/core/extensions/builtin/index.ts` and extension
  activation order — a prior regression (R1, activation order) makes this
  sensitive; this plan deliberately does NOT restructure the barrel.
- Other provider modules, even if you spot similar eager imports — note them
  in your report instead.

## Git workflow

- Branch: `advisor/003-boot-lazy-imports`
- Conventional commits, e.g. `perf(boot): lazy-load grammy and @ai-sdk/anthropic`
- Do NOT push or open a PR (pushes are blocked on this repo by history-based
  push protection; commit locally only).

## Steps

### Step 0: Record the baseline

`bun run build` then run `time node dist/index.js --help` three times; record
the best wall time in your final report.

### Step 1: Lazy-load the telegram headless bridge

In `src/index.ts`: delete the static import at line 32. Inside the
`telegram-bridge` action (the function containing `index.ts:516`), add as the
first line of the action body:

```ts
const { runTelegramHeadlessBridge } = await import("./telegram/headless-bridge");
```

(The action is already async — confirm; if not, make it async, Commander
supports async action handlers and the other subcommands use them.)

**Verify**: `bun run typecheck` → exit 0. `bun run build` → exit 0.
`node dist/index.js telegram-bridge --help` → prints help, exit 0.
`grep -n "telegram/headless-bridge" src/index.ts` → only the dynamic import
inside the action.

### Step 2: Lazy-load @ai-sdk/anthropic behind async connect

In `src/core/extensions/builtin/anthropic-provider.ts`:

1. Change line 9 to a type-only import if any types are used from the
   package; otherwise delete it.
2. Add a module-level cached loader:
   ```ts
   let createAnthropicPromise: Promise<typeof import("@ai-sdk/anthropic")> | null = null;
   function loadAnthropicSdk() {
     createAnthropicPromise ??= import("@ai-sdk/anthropic");
     return createAnthropicPromise;
   }
   ```
3. Make `createSession` async and await the SDK before constructing:
   ```ts
   async function createSession(ctx: ProviderConnectionContext): Promise<ProviderSession> {
     const apiKey = resolveApiKey(ADAPTER_ID, ENV_VAR);
     if (!apiKey) { /* unchanged throw */ }
     const { createAnthropic } = await loadAnthropicSdk();
     const anthropic = createAnthropic({ apiKey });
     return { /* unchanged object */ };
   }
   ```
   `connect: createSession` stays as-is — the contract accepts
   `Promise<ProviderSession>` (`api.ts:593`).

**Verify**: `bun run typecheck` → exit 0.
`grep -n "from \"@ai-sdk/anthropic\"" src/core/extensions/builtin/anthropic-provider.ts`
→ either no matches or only `import type`.

### Step 3: Confirm no other eager loader pulls the packages at boot

```
grep -rn "from \"grammy\"" src/ --include='*.ts' | grep -v "src/telegram/"
grep -rn "from \"@ai-sdk/anthropic\"" src/ --include='*.ts' | grep -v "import type"
```
Expected: no matches outside `src/telegram/` for grammy; no non-type matches
for the Anthropic SDK. If matches remain on the boot path, report them —
do not chase them beyond the two in-scope files.

### Step 4: Re-measure

`bun run build`, then `time node dist/index.js --help` three times; report
best-of-three before vs after.

## Test plan

- `bunx vitest run src/core/extensions/builtin/__tests__/` and
  `bunx vitest run src/core/extensions/builtin/local-llm-provider.test.ts`
  (nearest provider tests) → pass, excluding the repo's known pre-existing
  bun:sqlite failures (~9 extension tests fail under vitest regardless of
  this change — compare against a pre-change run if unsure).
- Runtime smoke for the Anthropic path requires an API key; if
  `ANTHROPIC_API_KEY`/stored credential is unavailable, state that in the
  report — typecheck + the async-connect contract cover the wiring.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0 and `bun run build` exits 0
- [ ] `bun run lint` exits 0
- [ ] `node dist/index.js --help` exits 0
- [ ] `node dist/index.js telegram-bridge --help` exits 0
- [ ] Step 3 greps return clean
- [ ] Boot timing before/after recorded in the report
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at "Current state" locations doesn't match the excerpts.
- The `telegram-bridge` action turns out not to be an async-compatible
  Commander action after one honest attempt.
- Anything other than `connect:` consumes `createSession` (grep for it) — an
  additional call site may not tolerate the new Promise return.
- Typecheck reveals `@ai-sdk/anthropic` types are structurally embedded in the
  module's exported types (forcing the value import back).

## Maintenance notes

- Reviewers should check the R1 activation-order test still passes (builtin
  extension registration order is a known past regression).
- Future providers should follow this pattern from day one: type-only
  top-level SDK imports, `await import` inside `connect`/`activate`.
- Deferred: auditing the other 40+ builtin modules in the barrel for eager
  heavyweight imports (PERF-23's broader half) — worth a follow-up sweep with
  `bun build --analyze` or a require-graph dump.
