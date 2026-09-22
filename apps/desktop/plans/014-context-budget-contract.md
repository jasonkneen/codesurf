# Plan 014: Bound model-visible context deterministically

> **Executor instructions**: Read this plan fully before editing. Work in the
> assigned isolated worktree. Preserve instruction precedence and privacy
> buckets. Do not merge or push.
>
> **Drift check**: `git diff --stat bc2d0a94..HEAD -- packages/codesurf-daemon/bin/memory-loader.mjs packages/codesurf-daemon/bin/instruction-context.mjs packages/codesurf-daemon/bin/skills-index.mjs packages/codesurf-daemon/bin/chat-jobs.mjs src/main/ipc/chat.ts`

## Status

- **Priority**: P0
- **Effort**: M-L
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: reliability, performance, cost control
- **Planned at**: commit `bc2d0a94`, 2026-07-30
- **Implemented at**: branch `advisor/epic-014-context-budget`, final commit
  `e1c31cff78178471707689a03670f342098693bd`
- **Review result**: done in the isolated branch. Independent review first
  found regressions in candidate counting, cloud privacy quota allocation,
  room-context precedence, and skill truncation summaries. A final spot-check
  then reproduced cloud privacy leakage through a symlink alias, raw-section
  overflow during recursion unwind, silent root omission, unbounded root
  candidate I/O, and a refundable canonical-validation quota. The final branch
  classifies canonical targets before reads, reserves primary workspace
  candidates, and independently caps raw sections, root attempts, visible
  imports, and canonical-validation I/O. The six focused suites pass 39/39,
  both typechecks pass, and syntax/diff checks pass. The package aggregate
  still encounters the baseline duplicate import tracked by Plan 015.

## Why this matters

Instruction and memory loaders read and concatenate full files, recursive
imports have cycle detection but no depth/count budget, selected skills are
unbounded, and caller-provided memory/persona/skill prompts cross the daemon
boundary without aggregate validation:

- `memory-loader.mjs:5-63,236-263,302-326`
- `instruction-context.mjs:4-40,94-120`
- `skills-index.mjs:193-215,240-279,305-345`
- `chat-jobs.mjs:686-707,2595-2604,2626-2639`
- `src/main/ipc/chat.ts:1031-1064`

A large file or import graph can overflow a provider context, trigger
unpredictable truncation, duplicate large prompts into transcript events, and
destroy prompt-cache reuse.

## Scope

In scope:

- `packages/codesurf-daemon/bin/context-budget.mjs` (new)
- `memory-loader.mjs`
- `instruction-context.mjs`
- `skills-index.mjs`
- `chat-jobs.mjs`
- Relevant daemon tests
- A minimal main-process guard in `src/main/ipc/chat.ts` only if needed

Out of scope:

- Provider/model-specific context-window claims
- Rewriting user instruction files
- Summarizing content with an LLM
- Changing local-only versus remote-safe bucket policy
- Removing the compatibility `instruction-context` export

## Required contract

Create one shared, pure budget module with named constants and structured
metadata. Use UTF-8 byte counts, not JavaScript string length.

Initial limits:

- Maximum bytes read from one context file: 32 KiB
- Maximum included instruction sections: 32
- Maximum import depth: 8
- Maximum aggregate instruction bytes: 128 KiB
- Maximum selected skills: 24
- Maximum skill-description bytes: 2 KiB
- Maximum persona prompt bytes: 16 KiB
- Maximum transcript preview for any injected context tool input: 8 KiB

These are product safety limits, not claims about any specific model. Export
the constants so tests and future settings can reference one source of truth.

Every accepted fragment should carry:

```js
{
  source,
  displayPath,
  scope,
  bucket,
  precedence,
  originalBytes,
  includedBytes,
  truncated,
  truncationReason,
}
```

### Precedence and truncation

- Preserve the current rule that later instruction sections override earlier
  sections.
- Allocate the aggregate budget from highest precedence to lowest, then render
  sections in their original order.
- Never silently truncate: append a deterministic marker naming the limit.
- Read at most the per-file limit plus one byte so oversized files never enter
  memory in full. Use a file handle or bounded stream.
- Import count/depth overflow must appear in metadata and the user-visible
  context summary. Cycles remain deduplicated.
- A selected skill over its description cap is truncated with a marker.
  Selections beyond 24 are reported as omitted by count.

### Trusted-boundary enforcement

`chat-jobs.mjs` must re-validate `request.memoryPrompt`,
`request.skillsPrompt`, `request.skillsSummary`, and
`request.agentMode.systemPrompt`; main-process validation alone is not enough.
Use the same deterministic truncation helper before any provider builder sees
them.

The transcript's `Workspace Instructions` and `Included Skills` tool inputs
must use the 8 KiB preview and a summary of omitted/truncated content, not the
entire provider prompt.

## Test plan

Extend `test/daemon/memory-loader.test.mjs`,
`test/daemon/instruction-context.test.mjs`, and the skills/chat-job tests:

- Exact-limit and one-byte-over files.
- UTF-8 multibyte content is budgeted by bytes and remains valid text.
- A 9-level import chain stops at depth 8 with visible metadata.
- More than 32 unique imports cannot exceed section or aggregate limits.
- High-precedence workspace-local instructions survive when lower-precedence
  user content exhausts the aggregate budget.
- Remote-safe/local-only filtering happens before aggregate allocation for the
  selected execution target.
- More than 24 selected skills produces a bounded prompt and omission count.
- Oversized inbound memory, skills, and persona prompts are bounded again by
  the daemon.
- Transcript tool input is at most 8 KiB while the provider prompt retains the
  larger allowed aggregate.
- Existing small fixtures render byte-for-byte identically.

## Verification

```bash
node --test test/daemon/memory-loader.test.mjs
node --test test/daemon/instruction-context.test.mjs
node --test test/daemon/context-buckets.test.mjs
node --test test/daemon/provider-context-policy.test.mjs
npm --prefix packages/codesurf-daemon test
npm run typecheck
npm run typecheck:tsc
git diff --check
```

## Done criteria

- [x] All model-visible context sources have per-item and aggregate bounds
- [x] Import depth/count and skill count are bounded
- [x] Precedence and privacy buckets remain deterministic
- [x] Every truncation is visible in metadata or rendered markers
- [x] The daemon revalidates caller-provided context
- [x] Transcript previews no longer duplicate full context
- [x] Existing small-context behavior remains unchanged

## STOP conditions

Stop and report if:

- A provider requires a different precedence order than the existing layered
  instruction rule.
- Bounding context would require silently dropping local-only/remote-safe
  privacy metadata.
- A test can pass only by loading the entire oversized file first.
- The change expands into provider-specific token counting. This plan uses
  deterministic bytes deliberately.
