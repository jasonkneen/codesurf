# Command CLI Harvest Status

Status: documented only. No destructive cleanup performed.

Current branch at time of writing: `main`
Current HEAD at time of writing: `72f69f6`

## Executive summary

The useful Command CLI harvest work is already in the repository. The picking phase is effectively complete.

What was harvested into product code:
- daemon-owned skill indexing
- daemon file-reference expansion
- inspectable context buckets
- supporting daemon/client/chat plumbing
- supporting tests and docs

What still counts as "bones":
- the burst handoff plan docs that were created to coordinate off-main worktree execution

This document is intentionally non-destructive. It records what is in the repo and what would be considered optional cleanup later, but it does not remove or modify any harvested functionality.

## Picked product work now present

The following feature work landed during the Command harvest sequence:
- `27e86e0` feat: add daemon skill indexing
- `2fd8ae6` Add daemon file reference expansion
- `db0b43b` feat: add inspectable context bucket bundles
- `dbeb1e2` feat: surface context buckets in workspace instruction chips
- `4aafad3` docs: describe daemon skill roots
- `7d593e7` Document file reference expansion

Those changes were then integrated through merge commits including:
- `93f161c` Merge branch 'wt/command-skills-index'
- `97cfe94` merge branch 'wt/command-context-buckets'
- `e6f94d5` merge branch 'wt/command-file-reference-expansion'
- `bbaef88` feat: merge command harvest worktrees

## Files that represent the harvested product work

Core daemon/modules/tests/docs now present:
- `bin/skills-index.mjs`
- `bin/file-references.mjs`
- `bin/context-buckets.mjs`
- `bin/chat-jobs.mjs`
- `bin/codesurfd.mjs`
- `bin/memory-loader.mjs`
- `src/main/daemon/client.ts`
- `src/main/ipc/chat.ts`
- `test/daemon/skills-index.test.mjs`
- `test/daemon/file-references.test.mjs`
- `test/daemon/context-buckets.test.mjs`
- `docs/daemon-skills.md`
- `docs/file-reference-expansion.md`

These are the actual Command harvest outputs worth keeping.

## What counts as bones

The following files are coordination artifacts rather than product behavior:
- `docs/plans/2026-04-21-command-harvest-burst-5-skills.md`
- `docs/plans/2026-04-21-command-harvest-burst-6-file-refs.md`
- `docs/plans/2026-04-21-command-harvest-burst-7-context-buckets.md`

They are not harmful, but they are planning/handoff material rather than runtime functionality.

## Recommended interpretation

If the goal is to ask "do we have what we wanted from Command CLI?" the answer is yes.

If the goal is to ask "is there anything left to clean up?" the only obvious remaining cleanup is whether to keep or later prune the three burst handoff plan docs above.

## No-destruction note

No deletion, pruning, reset, or other destructive cleanup was performed as part of this documentation step.

This file is only a status record so future sessions can distinguish:
- harvested functionality to keep
- handoff/bones docs that are optional cleanup later
