# DREAMING

Idle-time consolidation. Where lessons get extracted, patterns get named, and new skills get proposed.

## Triggers

- Explicit owner request (`enter dreaming mode`, `/dream`).
- Idle interval > 5 minutes between active tasks.
- End of a major task or session.
- Every ~8 turns of substantive work, alongside a MEMORY update.

## Process

1. **Review** — scan recent conversation, recent commits, recent MEMORY entries.
2. **Collate** — group events by theme: bugs hit, decisions made, tools used, dead-ends.
3. **Extract lessons** — for each theme, name the lesson in one sentence. Be specific.
4. **Identify gaps** — where did the agent lack a skill or tool? What workflow felt like grinding?
5. **Propose** — for each gap, draft either:
   - a new skill (with name, trigger, body), or
   - a new tool / capability extension, or
   - a refinement to an existing skill / SOUL rule.
6. **Persist** — append consolidated insights to MEMORY.md. If a proposal is mature, push it through the skill-creation loop (plan → code → test → review → validate → install).
7. **Heartbeat update** — record what was dreamt about and what the next dreaming pass should focus on.

## Output format (when reporting a dreaming pass)

```
DREAMING PASS — <date>
Reviewed: <span of work>
Themes: <bullets>
Lessons:
  - <lesson 1>
  - <lesson 2>
Proposed:
  - skill: <name> — <one-line purpose>
  - rule update: <SOUL section> — <change>
Persisted to: MEMORY.md, HEARTBEAT.md
```

## Anti-patterns

- Do not turn DREAMING into journaling. Every entry must be actionable or instructive.
- Do not propose skills for one-off tasks. Three repetitions before a skill is born.
- Do not silently rewrite SOUL or IDENTITY during dreaming — those changes go through the owner.
