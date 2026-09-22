---
name: heartbeat-setup
description: Start or restart the 30-minute autonomous development heartbeat loop for this project.
---

# Heartbeat Setup

Create the durable 30-minute heartbeat cron job for this project.
Run this at the start of any new session to reactivate the loop.

## What the heartbeat does

Every 30 minutes (at :03 and :33), Claude wakes up and:
1. Reads `SOUL.md` — project identity and working principles
2. Reads `MEMORY.md` — running notes and recent context  
3. Reads `HEARTBEAT.md` — the task/idea list
4. Picks one unchecked item, acts on it or investigates it
5. Updates `HEARTBEAT.md` (checks off done items, adds new observations)
6. Appends a timestamped entry to `MEMORY.md`

## Steps

1. Use CronCreate with these exact parameters:
   - cron: `3,33 * * * *`
   - recurring: true
   - durable: true
   - prompt: (the full prompt below)

2. Tell the user the job ID and confirm it's running.

3. If `HEARTBEAT.md` doesn't exist, create it with a starter template.
   If `SOUL.md` doesn't exist, create it from the template in `docs/extension-dev-harness.md`.
   If `MEMORY.md` doesn't exist, create it with today's date as initial entry.

## The heartbeat prompt

---
This is your 30-minute heartbeat for the CodeSurf project.

1. Read SOUL.md — your identity and working principles.
2. Read MEMORY.md — recent notes and context.
3. Read HEARTBEAT.md — the task list.

If HEARTBEAT.md has no unchecked items and nothing interesting to note, append "HEARTBEAT_OK — nothing pending" with timestamp to MEMORY.md, then stop.

Otherwise:
- Pick ONE unchecked item from the Active section of HEARTBEAT.md.
- Either do the work (safe, small tasks: reading, analysing, writing docs, noting findings) or investigate and write up what you found.
- Do NOT modify src/ files, package.json, or config files unless the item is explicit in HEARTBEAT.md and clearly low-risk. When in doubt, write findings to MEMORY.md instead.
- Mark the item done with [x] and move it to the Done section with today's date.
- If you noticed something new while working, add it as a [ ] item in Active or Ideas.
- Append a short entry to MEMORY.md (## YYYY-MM-DD HH:MM) with what you did and found.
- Add one original observation about the codebase to HEARTBEAT.md Ideas if you have one.

One thing done well is better than three things half-done.
---

## Files

- `HEARTBEAT.md` — task list (edit freely to direct the agent)
- `SOUL.md` — project identity (edit to change agent behavior)
- `MEMORY.md` — agent's running notes (read to see what it's been doing)

## Cancelling

Use CronDelete with the job ID returned by CronCreate.
Or close the session — non-durable jobs die automatically.

## Note on the 7-day limit

Claude Code cron jobs auto-expire after 7 days. Run `/heartbeat-setup` again to renew.
