# Command Code Harvest — Burst 6 Worktree

Worktree: `/Users/jkneen/clawd/codesurf-wt-command-file-refs`
Branch: `wt/command-file-reference-expansion`
Base commit: `87d82f6`

Goal: implement daemon file-reference expansion (`@path`, `@file`) off main without pushing.

Scope:
- Create `bin/file-references.mjs`
- Modify `bin/codesurfd.mjs`
- Modify `src/main/daemon/client.ts`
- Modify `src/main/ipc/chat.ts`
- Add `test/daemon/file-references.test.mjs`
- Add `docs/file-reference-expansion.md`

Constraints:
- Do not touch or rebase `main`
- Do not push any branch
- Use small controlled bursts with commits on this worktree branch only
- Reuse existing UI surfaces only
- Follow TDD: failing test first, then implementation, then build/test verification

Target verification:
- `node --test test/daemon/file-references.test.mjs`
- `npm run build`

Desired outcome:
- daemon route to expand file references safely from workspace context
- sanitization and relative path handling
- local/cloud-aware expansion behavior
- inspectable expanded reference summaries through existing chat/tool surfaces
