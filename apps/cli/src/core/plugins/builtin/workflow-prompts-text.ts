// Canned prompt bodies for the workflow-prompts extension.
//
// Extracted from workflow-prompts.ts so the command-wiring stays readable and
// the long prompt content lives in one place. Kept as TS string constants
// (not runtime-loaded `.md`) on purpose: the project ships a `bun build
// --compile` standalone binary that bundles no loose files, so the content
// must be importable/bundled, not read from disk at runtime.

export const REVIEW_PROMPT = `Review all current changes in this repository. Follow these steps:

1. Run \`git status\` to see which files have been modified, staged, or are untracked.
2. Run \`git diff\` to see unstaged changes and \`git diff --cached\` to see staged changes.
3. If there are no changes at all, say so and stop.
4. Read any changed files in full if needed for context.

Then produce a **Review Report** in this exact structure:

## Summary
One paragraph overview of what changed and why (inferred from the diff).

## Files Changed
For each changed file, list the filename and a brief description of the change.

## Issues Found
List any bugs, logic errors, security concerns, missing error handling, or correctness problems. If none, say "No issues found."

## Suggestions
Code quality, naming, performance, and best-practice improvements. If none, say "No suggestions."

## Risk Assessment
Rate the overall risk of these changes as **Low**, **Medium**, or **High** with a short justification.`;

export const COMMIT_PUSH_PROMPT = `Create a git commit for the current repository changes and push the current branch to its remote.

Before committing, inspect the current branch. If it is not already a feature branch, create and switch to a new feature branch with a descriptive name based on the changes.

Follow the repository's commit workflow and safety checks. Inspect the current changes, stage any relevant untracked files, create an appropriate commit message, and push the branch if a commit was created. If there is nothing to commit, say so and stop.`;

export const COMMIT_PR_PROMPT = `Create a git commit for the current repository changes and open a pull request for the current branch.

Before committing, inspect the current branch. If it is not already a feature branch, create and switch to a new feature branch with a descriptive name based on the changes.

Follow the repository's commit and pull request workflows. Inspect the current changes, stage any relevant untracked files, create an appropriate commit, push the branch if needed, then open a pull request with a concise summary and test plan. Return the pull request URL. If there is nothing to commit or open in a pull request, explain why and stop.`;

export const DREAM_PROMPT = `Run a DREAMING pass following \`DREAMING.md\` in this repository. This is idle-time consolidation, not new work.

1. **Review** — scan the recent conversation, the most recent commits (\`git log --oneline -20\`), and the current contents of \`.agent-memory/MEMORY.md\`, \`.agent-memory/.scratch.md\`, and \`HEARTBEAT.md\`. Note what work was actually done since the last DREAMING entry, treating \`.scratch.md\` as ephemeral hook-nudge input rather than durable memory.
2. **Collate** — group recent events by theme (bugs hit, decisions made, tools used, dead-ends, repeated workflows).
3. **Extract lessons** — for each theme, name the lesson in one specific sentence. No platitudes; if you can't be specific, drop it.
4. **Identify gaps** — where did the agent lack a skill, tool, or rule? Which workflow felt like grinding? Apply the rule of three: only flag a gap if it has happened at least three times.
5. **Propose** — for each qualifying gap, draft one of: a new skill (name, trigger, body), a new tool/capability, or a refinement to an existing skill or SOUL rule. Do not silently rewrite SOUL or IDENTITY — those changes go to the owner for review.
6. **Persist** — append a dated entry to \`.agent-memory/MEMORY.md\` using the canonical format from DREAMING.md ("DREAMING PASS — <date>"). Update \`HEARTBEAT.md\`'s "Last check-in" and add any follow-ups under "Pending". If \`.agent-memory/.scratch.md\` contained only hook nudges that were consumed by this pass, clear it after persisting.
7. **Report** — print the same DREAMING PASS block back to the user so they can see what changed.

Anti-patterns to avoid: journaling instead of acting, proposing skills for one-off tasks, restating SOUL values, generating filler. If the recent span has nothing actionable, say "No actionable lessons this pass" and only update the HEARTBEAT timestamp.`;
