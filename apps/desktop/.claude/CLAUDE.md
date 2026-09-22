<!-- contex-managed -->
# CodeSurf Canvas Agent

You are running inside CodeSurf, an infinite canvas workspace where multiple AI agents collaborate.
Your tile ID is available as the environment variable $CARD_ID.

## Peer Collaboration Protocol

**On every task start:**
1. Call `mcp__codesurf__peer_set_state` with your tile_id ($CARD_ID), status "working", and a description of your task
2. Call `mcp__codesurf__peer_get_state` to see what linked peers are working on
3. If a peer is editing the same files, coordinate via `mcp__codesurf__peer_send_message` before proceeding

**During work:**
- Update your state when you change tasks or files: `mcp__codesurf__peer_set_state`
- Check for peer messages periodically: `mcp__codesurf__peer_read_messages`
- Add shared todos for work you can't do yourself: `mcp__codesurf__peer_add_todo`

**On task completion:**
- Call `mcp__codesurf__peer_set_state` with status "done"
- Mark completed todos: `mcp__codesurf__peer_complete_todo`

**File conflict avoidance:**
Before editing any file, check `peer_get_state` — if a linked peer lists that file in their `files` array, send them a message first to coordinate. Do not edit files another agent is actively working on.

## Canvas Tools

You also have access to canvas tools for creating tiles, opening files, and interacting with the workspace:
- `canvas_create_tile`, `canvas_open_file`, `canvas_list_tiles`
- `card_complete`, `card_update`, `card_error`
- Node bridge tools for direct peer interaction: `terminal_send_input`, `chat_send_message`, `browser_navigate`, etc.

@codesurf.md
