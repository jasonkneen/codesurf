# Relay Extension - Critical Fixes Plan

## Status: ✅ COMPLETED

## P0 (Critical) - DONE

### 1. Add Timeout to Agent Execution (Prevent Hung Agents) ✅
**File:** `packages/codesurf-relay/src/runtime.ts`
- Added `turnTimeoutMs` option to `RelayRuntimeOptions` (default: 5 minutes)
- Created `RelayTimeoutError` class for timeout scenarios
- Added `runTurnWithTimeout()` method with Promise.race pattern
- Applied timeout to all provider executors (Claude, Codex, OpenCode)

### 2. Prompt Injection Protection ✅
**File:** `packages/codesurf-relay/src/runtime.ts`
- Added `sanitizeForPrompt()` function to escape code fences and special tokens
- Added `sanitizeMessageForPrompt()` function for message sanitization
- Added clear delimiters (`<<<BEGIN MESSAGES>>>` / `<<<END MESSAGES>>>`) around injected content
- Limits message body length to 4000 chars

## P1 (High) - DONE

### 3. Path Traversal Protection ✅
**File:** `packages/codesurf-relay/src/relay.ts`
- Added `INVALID_ID_PATTERN` regex to detect `..`, `/`, `\`, and null bytes
- Added `validateParticipantId()` function
- Added `validateChannelId()` function
- Validation applied in `participantDir()`, `channelDir()`, and `upsertParticipant()`

### 4. Error Event Emission ✅
**File:** `packages/codesurf-relay/src/runtime.ts`
- Added `runAgentTickWithErrorHandling()` wrapper method
- Emits `error` event with `{ participantId, error }` payload on tick failure
- Sets participant status to `error` and stops agent on failure

### 5. Implement OpenCode Executor ✅
**File:** `src/main/relay/provider-executor.ts`
- Added `runOpenCodeTurn()` function
- Maps modes to OpenCode approval modes
- Extracts JSON from stdout output
- Added timeout support with SIGTERM on timeout

## Additional Fixes - DONE

### 6. Claude Executor Timeout ✅
**File:** `src/main/relay/provider-executor.ts`
- Added Promise.race pattern with configurable timeout
- Default timeout: 5 minutes

### 7. Codex Executor Timeout ✅
**File:** `src/main/relay/provider-executor.ts`
- Added setTimeout with SIGTERM on timeout
- Proper cleanup of timer on success/error

### 8. Type Safety Improvements ✅
**Files:** `packages/codesurf-relay/src/relay.ts`, `packages/codesurf-relay/src/runtime.ts`
- Fixed type narrowing for event payloads
- Removed unused imports
- Fixed missing `RelayEventMap` import
- Added proper type assertions for payload access

## Summary of Changes

| File | Changes |
|------|---------|
| `packages/codesurf-relay/src/types.ts` | Added `timeoutMs` to `RelaySpawnRequest` |
| `packages/codesurf-relay/src/relay.ts` | Added path validation, fixed types |
| `packages/codesurf-relay/src/runtime.ts` | Added timeout, sanitization, error handling |
| `packages/codesurf-relay/src/index.ts` | Export `RelayTimeoutError` |
| `src/main/relay/provider-executor.ts` | Implemented OpenCode, added timeouts to all providers |
