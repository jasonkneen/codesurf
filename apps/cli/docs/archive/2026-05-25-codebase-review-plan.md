# Codebase Recommendation Plan — 2026-05-25

Scope: full-structure review of the `codesurf` agentic harness (~38k LOC across 21 `src/` dirs). Decomposition priorities, structural debt, and CI gaps.

---

## Priority 1: Decompose `src/agent/agent.ts` (3,457 lines)

**Problem.** The agent loop is the largest file in the repo by 2.5x. The extension kernel absorbed tool ownership but the core loop, plan mode, verify, subagent dispatch, compaction, session management, and vision input all remain in one file. This makes auditing any single path (e.g. `sendTurn` vs `streamText` branching) difficult.

**Plan.**
1. Extract `src/agent/loop.ts` — `processMessage`, `processMessageViaSession`, turn coordination, the `streamText` loop body.
2. Extract `src/agent/plan.ts` — `processPlan`, plan-mode branching, plan question handling.
3. Extract `src/agent/verify.ts` — verify flow, recipe detection, sandbox spawn.
4. Extract `src/agent/subagent.ts` — `runTask`, `runDelegation`, delegation persistence.
5. Extract `src/agent/compaction.ts` — migration of existing `src/agent/compaction.ts` integration (note: compaction already exists as a sibling; the agent.ts import points at it — ensure nothing else is buried).

**Risks.**
- `agent.ts` uses ~60 private methods that reference each other across domains. A naive split will create cross-file coupling. Mitigation: extract bottom-up (pure helpers first, then subsystems, leaving the turn loop as the slimmed-down `agent.ts`).
- The `XaiProvider` / `KernelModelRuntime` dual path means branching on `runtime.session?.sendTurn` in multiple places — those branches should move with their owning subsystem.

**Effort:** medium. ~2 dedicated sessions.

---

## Priority 2: Consolidate sink management in the loader

**Problem.** Every cross-cutting concern (toast, chat, assistant, UI actions, cwd, session-id, context-stats, telegram, subagents, schedule, bash, hooks, MCP, input) gets its own `set*Sink()` / `clear*Sink()` exported function pair. There are 24 such exports from `loader.ts`. Adding a new sink requires touching 5+ sites: the sink interface, the module-level variable, the setter export, the `buildHostServices` slot, `clearAllSinks`, `shutdownExtensions`, and `__resetExtensionsForTests`.

**Recommendation.** Replace the individual function pairs with a single `SinkRegistry` object:

```ts
interface SinkRegistry {
  toast: SinkSlot<HostToast, void>;
  chat: SinkSlot<string, void>;
  assistant: SinkSlot<string, void>;
  uiAction: SinkSlot<HostAction, void>;
  // ...
}
```

Each slot is a typed container (`set/clear/get` with unbound → no-op semantics). The loader holds one `SinkRegistry` instance; `clearAllSinks` becomes a single call. New sinks add one line to the interface and one to the instance.

**`clearAllSinks` grows a line every time a new sink is added.** Deadline: before the 13th sink (currently at 12). **Hit.** Current count: 12 individual null assignments + 2 Set/array clears + 1 Map clear = 15 lines. Every new sink adds 3-4 surface spots. A registry would collapse to ~1-2 lines of setup per new sink.

**Effort:** low. Mechanical refactor, no behavioural change. ~1 session.

---

## Priority 3: Add test runner to CI

**Problem.** `typecheck.yml` runs `tsc --noEmit` and `release.yml` builds. Neither runs `bun run test` (Vitest). There are 40+ test files and 349+ passing tests — they should gate merges.

**Recommendation.** Add a CI workflow `test.yml`:

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run test
```

Or merge into `typecheck.yml` as an additional step.

**Effort:** trivial. ~15 minutes.

---

## Priority 4: Add eviction to `mentionsIndexByCwd`

**Problem.** The `mentionsIndexByCwd` Map in `loader.ts:119` grows unbounded. Each unique `cd` destination creates a new `FileIndex` that is never released. Over a long-running session with many working directory changes (or a plan mode that synthesises paths), this leaks file handles and index memory.

**Recommendation.** Wrap with an LRU (or simple bounded cache, max ~10 entries). Evict oldest on insert when over limit. `FileIndex` already supports `updateCwd()` — the cache could also refresh an existing entry's position in the LRU order on hit.

**Effort:** low. ~1 hour.

---

## Priority 5: Unify `KernelModelRuntime` and `GrokRuntimeModel`

**Problem.** `model-runtime.ts:222-239` has two `biome-ignore` suppressions for `noExplicitAny` casting `LanguageModel` to `GrokRuntimeModel` and vice versa. The types are structurally compatible at the `streamText` consumer level but the type system doesn't know that.

**Recommendation.** Define a shared minimal `LanguageModel` shape that both the kernel and the xAI path accept, or narrow the consumer (Agent) to use `LanguageModel` directly from `ai` package rather than the xAI-specific `GrokRuntimeModel`. The `model` field on `KernelModelRuntime` should be `LanguageModel | null`, not `any`.

**Effort:** low-medium. Requires understanding `GrokRuntimeModel`'s divergence from `LanguageModel`.

---

## Priority 6: Add extension-API version negotiation

**Problem.** `EXTENSIONS_V1_API_VERSION = "1.0.0"` is purely declarative. The loader asserts it matches, so any non-V1 extension (third-party or older builtin) fails at bootstrap. There's no concept of "I support versions X-Y" or graceful degradation.

**Recommendation.**
1. Define a supported range (e.g. `"^1.0.0"`) using semver.
2. For extensions within the range but not exactly matching the current patch, log a warning and continue.
3. Add a `hostApiVersion` field to the `ExtensionHostApi` object passed to `activate()` so extensions can feature-detect.

**Effort:** low. ~1 session.

---

## Not now (deferred / low signal)

| Item | Reason |
|------|--------|
| Encrypted credential storage | Valid concern but the attack model is "attacker with filesystem access" — at that point the running process could be ptrace'd anyway. Worth documenting in SECURITY.md, not worth building. |
| Database layer for sessions | JSON files are fine for a CLI tool. Revisit if multi-user or cloud sync is added. |
| Migration story for settings | No breaking changes observed in the commit history. Add when the first migration is needed, not before. |

---

## Summary

| Priority | Effort | Impact |
|----------|--------|--------|
| 1. Split agent.ts | medium | High — maintainability, auditability |
| 2. SinkRegistry | low | Medium — reduces boilerplate for every new sink |
| 3. CI tests | trivial | High — prevents regressions |
| 4. LRU mentions index | low | Medium — fixes resource leak |
| 5. Unify model types | low-medium | Low — two suppressions, no runtime bug |
| 6. Version negotiation | low | Low — prepares for third-party extensions |
