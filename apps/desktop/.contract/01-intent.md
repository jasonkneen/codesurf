## Restatement

Implement the concrete changes from the full project review, prioritizing security boundary fixes and release-gate correctness.

## Constraints

- Keep changes surgical and compatible with the existing Electron/React architecture.
- Do not revert unrelated dirty worktree changes.
- Preserve intended IDE capabilities where possible.

## Assumptions

- Security-critical protocol, iframe RPC, browser bridge, and collab path fixes are higher priority than broad UX/performance cleanups.
- Typecheck has many pre-existing failures; fix straightforward blockers only if they are directly tied to reviewed changes or obvious release health issues.

## Unknowns

- Whether workspace power extensions should be disabled by default or allowed after a trust prompt. Proceeding with documentation/guardrail-oriented fixes rather than removing the feature outright.
