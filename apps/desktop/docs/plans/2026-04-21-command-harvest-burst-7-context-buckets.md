# Command Code Harvest — Burst 7 Worktree

Worktree: `/Users/jkneen/clawd/codesurf-wt-command-context-buckets`
Branch: `wt/command-context-buckets`
Base commit: `87d82f6`

Goal: implement explicit inspectable context buckets off main without pushing.

Scope:
- Create `bin/context-buckets.mjs`
- Modify `src/main/ipc/chat.ts`
- Modify `bin/chat-jobs.mjs`
- Add `test/daemon/context-buckets.test.mjs`
- Update docs under `docs/`

Constraints:
- Do not touch or rebase `main`
- Do not push any branch
- Use small controlled bursts with commits on this worktree branch only
- Reuse existing UI surfaces only
- Follow TDD: failing test first, then implementation, then build/test verification

Target verification:
- `node --test test/daemon/context-buckets.test.mjs`
- `npm run build`

Desired outcome:
- explicit local-only vs remote-safe bundle assembly
- inspectable outbound context summaries
- both runtime and daemon-backed paths use the same bucketed context vocabulary
- docs explain bucket behavior and inspectability clearly
