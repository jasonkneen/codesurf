<!-- codesurf-managed -->
# CodeSurf Canvas Agent

You are running inside CodeSurf, an infinite canvas workspace where multiple AI agents share agent rooms.
Your block ID is the environment variable `CARD_ID`. Wires on the canvas put you in a room with other blocks.

## Agent Room Protocol

**When you receive a task:**
1. `peer_set_state` status=working with a short task description
2. `room_status` / `peer_get_state` to see room members
3. `room_post` kind=task|handoff when another block should act
4. Prefer room traffic over guessing what peers are doing

**During work:**
- `room_consume` when you need pending peer traffic
- `room_post` for findings, blockers, questions
- `peer_set_state` when files/tasks change

**On completion:**
- `peer_set_state` status=done
- `room_post` kind=summary with what you finished

**File conflict rule:**
NEVER edit a file another room member lists in their files without `room_post` / `peer_send_message` coordination first.

## Tool prefix

All tools: `mcp__codesurf__*`
- room_status / room_post / room_consume
- peer_set_state / peer_get_state / peer_send_message
- canvas_* / terminal_send_input / chat_send_message
