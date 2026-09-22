---
name: update-heartbeat
description: Use when the agent finishes a phase, ticks off planned work, identifies new pending items, or starts a session and needs to refresh `HEARTBEAT.md` (the persona's check-in / pending-work file at the repo root). Trigger phrases include "update heartbeat", "tick off the heartbeat", "log a check-in", or any moment a planned task transitions from pending to done. Also fires implicitly at the end of every substantive piece of work in a persona-equipped repo.
---

# Update Heartbeat

`HEARTBEAT.md` lives at the repo root and tracks (a) the last check-in timestamp, (b) what's currently in flight, (c) done items by phase, and (d) pending follow-ups. It is the persona's short-term plan — read at session start, updated whenever the plan moves.

## When to Use This Skill

Trigger this skill whenever any of the following are true:

- A bullet under "## Pending" can now be marked `[x]` (work was actually completed and verified).
- New follow-up work has been identified that should not be lost.
- A phase boundary has been crossed (e.g., "phase 3a complete, moving to phase 3b").
- The session is starting and `HEARTBEAT.md`'s `Last check-in` timestamp is more than a day old.
- The user explicitly asks to update the heartbeat.

If `HEARTBEAT.md` does not exist at the repo root, bail out — this skill is for repos that have adopted the decomposed persona pattern (SOUL/IDENTITY/USER/TOOLS/AGENTS/HEARTBEAT/DREAMING/MEMORY).

## File Shape

`HEARTBEAT.md` is expected to follow this structure:

```markdown
# HEARTBEAT

Scheduled check-ins and pending agent maintenance items.

## Conventions

- Read at session start.
- Tick off completed items.
- Add new check-ins as they're identified.
- Update `Last check-in` timestamp on every pass.

## State

**Last check-in:** <ISO-date>  (e.g., 2026-04-28)
**Status:** <one-line summary of current phase>

## Done (phase N)

- [x] <completed item>

## Pending (phase N+1)

- [ ] <work to do>

## Notes for next agent picking this up

- <context the next session needs>

## Recurring

- <items that fire on a cadence>

## Next heartbeat

<when the next pass should happen>
```

## Procedure

1. **Read `HEARTBEAT.md`** at the repo root. If missing, stop.
2. **Resolve pending items.** For every `- [ ]` bullet under any "## Pending" section, ask: was this just completed? If yes, change it to `- [x]` and move it under the matching "## Done" header (creating one if absent).
3. **Add new pending items.** If the session uncovered work that future-agent should pick up, append `- [ ] <one-line description>` under "## Pending" of the active phase.
4. **Update the State block.**
   - `Last check-in:` → today's UTC date (`YYYY-MM-DD`).
   - `Status:` → one short sentence describing where things stand.
5. **Update "Notes for next agent picking this up"** if new architectural insight surfaced (file paths, gotchas, do-not-touch warnings).
6. **Set "Next heartbeat"** — when should the next pass happen? Common values: "After first full session using new structure", "After next user request", "End of next dreaming pass".
7. **Do not** delete completed items — they form the audit trail. Only re-classify pending → done.
8. **Do not** rewrite the Conventions or top-level structure without explicit owner approval. The shape is part of the contract.

## Output

After editing, briefly report what changed to the user:

```
HEARTBEAT updated:
  Ticked: <count> items
  Added pending: <count> items
  Last check-in → <date>
```

## Anti-patterns

- Do not log speculative future work as a Done item.
- Do not strip the "Conventions" block.
- Do not move pending items between phases without justification.
- Do not invent phase numbers; use whatever the file already names.
