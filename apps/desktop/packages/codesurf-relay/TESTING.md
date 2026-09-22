# Testing Guide for CodeSurf Relay

## Overview

The relay system now has comprehensive test coverage across multiple layers:

| Test File | Type | Coverage |
|-----------|------|----------|
| `markdown.test.ts` | Unit | Message serialization/parsing |
| `validation.test.ts` | Unit | Production input validation, prompt sanitization, and slugging exports |
| `atomicFileWrites.test.ts` | Unit | Transactional file replacement and rollback |
| `runtime.test.ts` | Unit/Mock | Agent lifecycle, cancellation, scheduling, and error handling |
| `integration.test.ts` | Integration | Full system with real filesystem |
| `app-shutdown.integration.test.ts` | Integration | Provider process-tree teardown during application shutdown |

## Running Tests

```bash
cd packages/codesurf-relay
npm test          # Run once
npm run test:watch # Watch mode
```

## Test Categories

### 1. Pure Function Tests (Fast, Deterministic)

**`markdown.test.ts`**
- Message rendering with frontmatter
- Message parsing from Markdown
- Roundtrip preservation
- Data block handling
- Special character escaping

**`validation.test.ts`**
- Path traversal protection
- Prompt injection sanitization
- Participant ID validation at exact length and runtime-type boundaries
- Safe slug generation

### 2. Runtime Behavior Tests (Mocked)

**`runtime.test.ts`**
- Agent spawning
- Turn execution scheduling
- Error event emission
- Timeout handling (with mock timers)
- Output parsing and message sending

### 3. Integration Tests (Real FS)

**`integration.test.ts`**
- Storage structure initialization
- Participant CRUD operations
- Direct message delivery
- Channel broadcasting
- Unread tracking
- Work context updates
- Relationship analysis
- Event emission
- Memory storage
- Path traversal rejection

## Key Test Patterns

### Testing Agent Timeout

```typescript
const runtime = new RelayRuntime(relay, {
  executorFactory: () => slowExecutor,
  turnTimeoutMs: 50, // Fast timeout for tests
})

// Agent that takes too long
await runtime.spawn({ id: 'slow-agent', ... })

// Expect timeout and error status
expect(mockRelay.setParticipantStatus).toHaveBeenCalledWith('slow-agent', 'error')
```

### Testing Message Flow

```typescript
// 1. Setup agents
await relay.upsertParticipant({ id: 'alice', ... })
await relay.upsertParticipant({ id: 'bob', ... })

// 2. Send message
await relay.sendDirectMessage('alice', { to: 'bob', ... })

// 3. Verify delivery
const bobInbox = await relay.listUnreadDirectMessages('bob')
expect(bobInbox.length).toBe(1)
expect(bobInbox[0].meta.from).toBe('alice')
```

### Testing Relationship Detection

```typescript
// Setup overlapping work contexts
await relay.updateWorkContext('agent-1', {
  branch: 'feature/auth',
  files: ['src/auth.ts'],
})

await relay.updateWorkContext('agent-2', {
  branch: 'feature/auth',  // Same branch
  files: ['src/auth.ts'],  // Same file
})

// Analyze
const relationships = await relay.analyzeRelationships()
expect(relationships[0].priority).toBe('high')
expect(relationships[0].sameBranch).toBe(true)
```

## Testability Improvements Made

### Before
- ❌ No tests existed
- ❌ Hard-coded file system calls
- ❌ Hard-coded Date/UUID generation
- ❌ No dependency injection

### After
- ✅ Comprehensive test suite
- ✅ Mockable executor interface
- ✅ Event-driven testing support
- ✅ Pure functions for core logic
- ✅ Integration tests with temp directories

## What's Still Hard to Test

| Component | Challenge | Workaround |
|-----------|-----------|------------|
| Real LLM calls | Non-deterministic, expensive | Mock executors |
| File watchers | Async, OS-dependent | Event simulation |
| Long-running agents | Time-based | Short timeouts in tests |
| Multi-agent coordination | Race conditions | Sequential test cases |

## Adding New Tests

### For New Pure Functions

```typescript
import { describe, it, expect } from 'vitest'
import { myNewFunction } from './my-module'

describe('myNewFunction', () => {
  it('should handle basic case', () => {
    expect(myNewFunction('input')).toBe('output')
  })
  
  it('should handle edge case', () => {
    expect(myNewFunction('')).toBe('default')
  })
})
```

### For New Runtime Features

```typescript
it('should do something with the runtime', async () => {
  const mockRelay = createMockRelay()
  const runtime = new RelayRuntime(mockRelay, {
    executorFactory: () => mockExecutor,
  })
  
  // Test your feature
  await runtime.myNewMethod()
  
  // Assert on mock calls
  expect(mockRelay.someMethod).toHaveBeenCalled()
  
  runtime.destroy()
})
```

### For Integration Scenarios

```typescript
it('should work end-to-end', async () => {
  const tempDir = mkdtempSync(...)
  const relay = new CodesurfRelay({ workspacePath: tempDir })
  await relay.init()
  
  // Run your scenario
  
  // Cleanup
  rmSync(tempDir, { recursive: true })
})
```

## Continuous Integration

Tests run in CI with:
- Node.js 20+
- Vitest test runner
- 60 second timeout
- Parallel execution disabled for integration tests

## Coverage Goals

| Module | Target | Current |
|--------|--------|---------|
| markdown.ts | 100% | ~95% |
| types.ts | N/A (types only) | N/A |
| relay.ts | 80% | ~60% |
| runtime.ts | 80% | ~70% |

## Debugging Failed Tests

### Enable Verbose Logging

```typescript
// In your test
const runtime = new RelayRuntime(relay, {
  executorFactory: (p) => {
    console.log('Creating executor for', p.name)
    return mockExecutor
  },
})
```

### Inspect Event Flow

```typescript
relay.on((event) => {
  console.log('Event:', event.type, event.payload)
})
```

### Check File System State

```typescript
console.log('Files:', readdirSync(join(tempDir, '.codesurf/relay/participants')))
```
