# CodeSurf Session Persistence

## Overview

CodeSurf now implements **continuous session state persistence** to prevent session loss when Claude Code processes restart. This system ensures that:

1. **Session state survives process restarts** - CARD_ID, model, mode, and task context are saved to disk
2. **Sessions can be resumed automatically** - When a new Claude Code process starts, it can recover the previous session
3. **Peer state is continuously synchronized** - Each `peer_set_state()` call triggers a disk write to preserve state

## Architecture

### Components

#### 1. **Tile State Store** (`src/storage/tile-state.ts`)

Manages the persistence layer for CodeSurf tiles:

```typescript
interface TileState {
  cardId: string;           // CodeSurf tile ID
  model: string;            // Current model
  mode: AgentMode;          // Current mode (default, plan, etc.)
  cwdAtStart: string;       // Starting working directory
  cwdLast: string;          // Last working directory
  task: string | null;      // Current task/objective
  peerStatus: "idle" | "working" | "done";
  files: string[];          // Files being worked on
  daemonSessionId: string | null;  // Daemon conversation ID
  createdAt: string;        // Session creation time
  updatedAt: string;        // Last update time
}
```

State is stored in: `~/.contex/tile-<CARD_ID>/state.json`

#### 2. **CARD_ID Management** (`src/storage/card-id.ts`)

Manages persistence of the CodeSurf tile ID across process boundaries:

- Saves last used CARD_ID to `~/.contex/.last-card-id`
- Recovers CARD_ID from:
  1. Environment variable `CARD_ID`
  2. Explicit override via settings
  3. Last saved CARD_ID file
  4. Fall back to synthesizing new one

#### 3. **Tile State Integration** (`src/core/extensions/tile-state-integration.ts`)

Higher-level API for Claude Code sessions to interact with tile state:

```typescript
const context = getTileSessionContext(cardId);
context.updateTask("Building feature X");
context.updatePeerStatus("working");
context.setDaemonSessionId(sessionId);
```

#### 4. **CodeSurf Desktop Provider Integration** (`src/core/extensions/builtin/codesurf-desktop-provider.ts`)

The provider now:
- Initializes with tile state context on session creation
- Persists daemon sessionId when received
- Updates tile state after each turn completes
- Recovers CARD_ID from previous sessions

## How It Works

### Session Start Flow

```
Claude Code Process Starts
  ↓
Provider.connect() called
  ↓
CodesurfDesktopSession constructor
  ├─ Try to load CARD_ID from:
  │  1. CARD_ID env var
  │  2. Settings override
  │  3. ~/.contex/.last-card-id
  │  4. Synthesize new
  │
  ├─ Create TileSessionContext for CARD_ID
  │
  └─ Load previous tile state from ~/.contex/tile-<CARD_ID>/state.json
       (contains model, task, files, daemon sessionId, etc.)
```

### Turn Execution Flow

```
sendTurn(input) called
  ↓
Send request to daemon with cardId
  ↓
Stream events and handle them
  │
  ├─ On "session" event: persist daemon sessionId to tile state
  ├─ On other events: update tile state as needed
  │
  └─ After turn completes:
       ├─ Update model in tile state
       ├─ Update peerStatus to "idle"
       └─ Write state to disk
```

### State Recovery Flow

```
When Claude Code starts (next time)
  ↓
Provider tries to find CARD_ID
  ├─ Check ~/.contex/.last-card-id
  └─ If found, load from ~/.contex/tile-<CARD_ID>/state.json
       ├─ Recover model (may switch models if needed)
       ├─ Recover task context
       ├─ Recover daemon sessionId
       ├─ Restore files being worked on
       └─ Resume conversation continuity
```

## File Structure

```
~/.contex/
  ├─ .last-card-id                  # Last used CARD_ID
  ├─ tile-codesurf-<conv>/
  │  ├─ state.json                  # Current tile state
  │  ├─ objective.md                # Created by daemon
  │  ├─ skills.json                 # Created by daemon
  │  ├─ messages/                   # Conversation history
  │  └─ peers.md                     # Connected peers
  └─ tile-<other-id>/
     └─ ...
```

## API Usage

### For Claude Code Sessions

```typescript
import { getTileStateStore } from "../../storage";

const tileStore = getTileStateStore();

// Load previous state
const state = tileStore.loadState(cardId);

// Update state
tileStore.updateState(cardId, {
  task: "Implementing feature X",
  peerStatus: "working",
  files: ["/path/to/file1.ts", "/path/to/file2.ts"],
});

// Set peer status
tileStore.setPeerStatus(cardId, "working", "Task X", ["file1.ts"]);

// Find latest session
const latest = tileStore.findLatestTile();
if (latest) {
  console.log(`Resume tile ${latest.cardId} (updated ${latest.state.updatedAt})`);
}
```

### For MCP Peer Bridge

When `peer_set_state()` is called from Claude Code:

```typescript
// This is called by Claude Code's MCP bridge
mcp__contex__peer_set_state({
  tile_id: "tile-codesurf-12345",
  tile_type: "terminal",
  status: "working",
  task: "Building feature X",
  files: ["src/app.ts", "src/utils.ts"]
})

// → Automatically persists to ~/.contex/tile-codesurf-12345/state.json
```

## Session Recovery Examples

### Example 1: Automatic Resume

Claude Code process 1 (starts, runs, exits):
```
CARD_ID → codesurf-abc123
Model → claude-opus-4-6
Task → Building authentication
→ State saved to ~/.contex/tile-codesurf-abc123/state.json
```

Claude Code process 2 (starts later):
```
Reads ~/.contex/.last-card-id → codesurf-abc123
Loads state from ~/.contex/tile-codesurf-abc123/state.json
→ Resumes with previous model, task, files, daemon sessionId
→ Conversation continuity maintained
```

### Example 2: Manual Tile Selection

User sets CARD_ID to a specific desktop tile:

```bash
CARD_ID="tile-user-pasted-id" claude dev
```

→ Session joins the desktop tile
→ Session state saved and can be recovered even if user clears environment

### Example 3: Multiple Parallel Sessions

```
~/.contex/
  ├─ tile-codesurf-project1/
  │  └─ state.json (model: opus, task: feature-x)
  ├─ tile-codesurf-project2/
  │  └─ state.json (model: sonnet, task: bug-fix)
  └─ .last-card-id → codesurf-project2
```

Next session resumes project2, but user can manually switch to project1

## Benefits

1. **No More Lost Context** - Session state survives process restarts
2. **Automatic Resume** - New processes automatically rejoin previous sessions
3. **Conversation Continuity** - Daemon sessionId is recovered, so conversation thread persists
4. **Works Offline** - Session recovery doesn't require network access
5. **Transparent** - No user configuration needed for basic recovery
6. **Debuggable** - State files are readable JSON for inspection

## Limitations & Future Improvements

### Current Limitations

- State is updated after each turn (not real-time streaming updates)
- `peer_set_state()` updates from Claude Code must be explicitly hooked
- No conflict resolution if multiple processes access same tile

### Future Improvements

1. **Real-time State Sync** - Update state.json continuously as peer_set_state() calls arrive
2. **State Versioning** - Keep history of state changes for recovery/audit
3. **Lock File** - Prevent concurrent access to same tile
4. **MCP Hook** - Auto-hook peer_set_state() to write to disk
5. **Cleanup Policy** - Archive or delete old tiles after N days
6. **Compression** - Compress state.json for long-running sessions

## Testing

```bash
# Run session persistence tests
npm run test -- tile-state

# Manual test: start session
CARD_ID=test-session claude dev

# Verify state was saved
cat ~/.contex/tile-test-session/state.json

# Kill Claude Code process and restart
# Should resume in same tile
```

## Troubleshooting

### Sessions Not Resuming

Check if `.contex` directory exists and is writable:
```bash
ls -la ~/.contex/
cat ~/.contex/.last-card-id
```

### Stale Session State

Delete old sessions:
```bash
rm -rf ~/.contex/tile-codesurf-old-id
```

### Force New Session

```bash
CARD_ID="" claude dev  # Forces creation of new tile
```

### Debug State File

```bash
cat ~/.contex/tile-<CARD_ID>/state.json | jq .
```

## References

- **Tile State**: `src/storage/tile-state.ts`
- **CARD_ID Management**: `src/storage/card-id.ts`
- **Integration Layer**: `src/core/extensions/tile-state-integration.ts`
- **Provider Integration**: `src/core/extensions/builtin/codesurf-desktop-provider.ts`
