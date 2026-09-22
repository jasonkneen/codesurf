# Command Code Harvest — Burst 5 Worktree

Worktree: `/Users/jkneen/clawd/codesurf-wt-command-skills`
Branch: `wt/command-skills-index`
Base commit: `87d82f6`

Goal: implement daemon-owned skill resolution/indexing off main without pushing.

Scope:
- Create `bin/skills-index.mjs`
- Modify `bin/codesurfd.mjs`
- Modify `src/main/daemon/client.ts`
- Modify `src/main/ipc/chat.ts`
- Review `src/main/ipc/skills.ts`
- Add `test/daemon/skills-index.test.mjs`
- Add `docs/daemon-skills.md`

Constraints:
- Do not touch or rebase `main`
- Do not push any branch
- Use small controlled bursts with commits on this worktree branch only
- Reuse existing UI surfaces only
- Follow TDD: failing test first, then implementation, then build/test verification

Target verification:
- `node --test test/daemon/skills-index.test.mjs`
- `npm run build`

Desired outcome:
- daemon routes for list/get/install skill metadata/content
- merged global + workspace skill roots
- prompt-side inspectable skill inclusion plumbing
- docs updated for the daemon-owned skill path
