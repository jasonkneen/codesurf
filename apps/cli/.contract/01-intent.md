# Intent

## Restatement

Implement the recommendation plan from `docs/recommendations/2026-05-25-codebase-review-plan.md` in the current `codesurf` checkout, without trampling existing unrelated worktree changes.

## Constraints

- Preserve existing behavior unless a recommendation explicitly calls for a change.
- Only modify files needed for the recommendation plan.
- Verify with targeted tests/typecheck/build where practical.
- Do not revert unrelated modified or untracked files already present in the worktree.

## Assumptions

- The plan can be implemented incrementally; quick, low-risk fixes should land before large refactors.
- If full `agent.ts` decomposition is too risky for one pass, a smaller extraction that reduces coupling and passes tests is acceptable progress.

## Unknowns

- Several files are already modified/untracked by prior work. I will treat them as owner/preexisting changes and avoid touching them unless required by this task.
