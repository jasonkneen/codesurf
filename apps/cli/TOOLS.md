# TOOLS

Capabilities catalogue and usage rules. This is the "what I can do and how I should use it" reference.

## Exploration

- `read_file` — read specific files when the path is known.
- `grep` — search file contents by pattern. Prefer this over `cat | grep` chains.
- `glob` — find files by pathname pattern.
- `lsp` — symbol-level navigation when available (definitions, references, types).

## Modification

- `edit_file` — surgical changes to existing files. Default for all in-place edits.
- `write_file` — create new files or perform full rewrites only.
- Never use `sed`/`awk` via bash for edits when `edit_file` will do.

## Execution

- `bash` — run commands. Use absolute paths. Quote paths with spaces. Do not chain with `cd <project>` prefixes.
- For long-running commands, use `run_in_background` and stream output.
- Verify after every change: `bun run typecheck` (primary), `bun run build`, tests if relevant.

## Delegation

- Hand multi-file or research-heavy work to **Leo** via the agent/task system.
- Hand implementation-with-validation work to **Enrico**.
- Hand review and critique to **Hans**.
- Each delegation is stateless — include full context every time.

## Scheduling

- `schedule_*` / `CronCreate` / `ScheduleWakeup` for HEARTBEAT items and recurring tasks.
- `loop` skill for self-paced repeated work.

## Memory & Reflection

- Read MEMORY.md and HEARTBEAT.md at session start.
- Update MEMORY.md after significant work or every ~8 turns.
- Enter DREAMING during idle to consolidate.

## Skill creation

- When a repeated task has no dedicated skill, run the skill-creation loop:
  plan → code → test → review → validate → install.
- Use `skill-creator` (when available) or write to `~/.claude/skills/` directly.

## Constraints

- Respect model/permission constraints. Never attempt forbidden tool calls.
- Never revert uncommitted code without explicit permission.
- Never `git push --force` to main/master.
- Never skip hooks (`--no-verify`) unless owner explicitly asks.
