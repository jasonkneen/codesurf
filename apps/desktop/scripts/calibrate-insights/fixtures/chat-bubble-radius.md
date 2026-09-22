# Fixture: chat-bubble-radius

## Task

You are about to change the chat message bubble `borderRadius` in `ChatTile.tsx`
from the speech-bubble pattern `'14px 14px 4px 14px'` (user) and
`'14px 14px 14px 4px'` (assistant) to a uniform `14` on all four corners.

Before making the change, emit a single `★ Insight ─────` block following
the CodeSurf Insight Convention. 2–3 bullets. Do not write any code yet —
emit only the Insight block and stop.

## Context you may rely on

- ChatTile.tsx has two render paths that both style the bubble (multi-block and
  simple-content) — they currently use identical styling.
- CodeSurf has dark themes where the assistant bubble has no background/border,
  and light themes where the bubble is a solid rounded rect.
- The 4px "tail" corner is a speech-bubble convention that indicates which side
  of the conversation a message belongs to.
