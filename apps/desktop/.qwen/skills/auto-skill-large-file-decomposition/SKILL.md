---
name: large-file-decomposition
description: Systematic approach to breaking up god modules (>1000 lines) in TypeScript projects using domain extraction, barrel re-exports, and orchestrator patterns
source: auto-skill
extracted_at: '2026-06-22T18:54:04.136Z'
---

# Large-File Decomposition

Systematic approach to breaking up monolithic TypeScript files (god modules) into domain-specific modules while preserving backward compatibility.

## When to Apply

- File exceeds ~1000 lines
- File contains types/functions from 3+ unrelated domains
- File has high fan-in (imported by 50+ other files)
- Edits to the file trigger full-project type-checks
- Adding a new feature requires editing a file you don't fully understand

## Three Decomposition Strategies

### Strategy A: Barrel Re-Export (for type-heavy files)

Best for files that are primarily type declarations with some runtime code.

**Steps:**
1. Inventory all exports with line numbers
2. Group exports by domain (canvas, settings, extensions, etc.)
3. Create domain-specific files: `shared/extension-types.ts`, `shared/canvas-types.ts`, etc.
4. Move runtime functions to a `*-runtime.ts` or `*-utils.ts` file
5. Replace original file with barrel re-exports:
```typescript
// shared/types.ts — barrel
export * from './activity-types.ts'
export * from './canvas-utils.ts'
export * from './collab-types.ts'
export * from './settings-runtime.ts'
// ... remaining types that don't fit a domain stay here
```

**Result:** Original file shrinks 80-90%, existing imports continue to work unchanged.

**Example:** `shared/types.ts` went from 1344 lines → 243 lines by extracting 9 domain modules.

### Strategy B: Provider/Module Decomposition (for monolithic processing files)

Best for files that handle multiple providers/formats/strategies in one place.

**Steps:**
1. Identify the provider/module boundaries (Claude, Codex, etc.)
2. Extract shared helpers to `shared.ts`
3. Extract cross-cutting utilities to `tool-blocks.ts` or `utils.ts`
4. Create per-provider modules: `claude.ts`, `codex.ts`, `pi-agent.ts`
5. Create orchestrator `index.ts` that:
   - Re-exports the public API
   - Contains dispatch logic that delegates to provider modules
6. Replace original file with barrel: `export * from './session-sources/index'`

**Key patterns:**
- Each provider module exports its own `list*Sessions()` and `parse*ChatState()` functions
- Shared module exports helpers used by 2+ providers
- Orchestrator contains the fan-out loop and cache management

**Example:** `session-sources.ts` went from 2627 lines → 2 lines + 10 provider modules.

### Strategy C: IPC Handler Extraction (for monolithic entry files)

Best for Electron main process entry files that accumulate inline IPC handlers.

**Steps:**
1. Count inline `ipcMain.handle` calls vs dedicated `register*IPC()` modules
2. Group inline handlers by feature domain (owl, updater, window, appearance)
3. Create `src/main/ipc/<domain>.ts` for each group
4. For handlers needing shared state, use a context interface:
```typescript
export interface WindowIPCContext {
  createWindow: (opts?) => BrowserWindow
  windowTitles: Map<number, string>
  broadcastWindowList: () => void
}

export function registerWindowIPC(ctx: WindowIPCContext): void {
  ipcMain.handle('window:new', () => { ctx.createWindow({ fresh: true }) })
}
```
5. Replace inline handlers with `register*IPC()` calls in `app.whenReady()`
6. Clean up now-unused imports

**Result:** Entry file shrinks 25-40%, each domain becomes independently testable.

**Example:** `index.ts` went from 1249 lines (36 inline handlers) → 906 lines (0 inline handlers).

## Workflow

1. **Inventory**: List all exports with line numbers, group by domain
2. **Verify imports**: `grep` for all importers to understand blast radius
3. **Extract largest domain first**: Start with the cluster that has the most exports
4. **Barrel re-export immediately**: Don't update import sites — backward compat via barrel
5. **Typecheck after each extraction**: Catch broken references early
6. **Test after all extractions**: Verify runtime behavior unchanged

## Verification

```bash
# After each extraction
npx tsgo -p tsconfig.json --noEmit 2>&1 | grep "error TS" | grep -v "TS6133\|TS6196"

# After all extractions
node --test test/*.test.ts test/*.test.mjs
```

## Pitfalls

- **Don't update import sites in the same PR** — barrel re-exports provide backward compatibility; migrating imports is a separate, lower-risk change
- **Runtime code in type files** — extract functions/constants to `*-runtime.ts` or `*-utils.ts`, not into type modules
- **Circular dependencies** — if domain A imports from domain B and vice versa, they may need to be in the same module or share a common base
- **Private helpers** — non-exported functions used by multiple domains should go into a `shared.ts` or `internal.ts` module
- **Test files importing from the original path** — barrel re-exports handle this automatically

## Metrics to Track

| Metric | Before | After |
|--------|--------|-------|
| File lines | 1344 | 243 |
| Export count in original | 95 | 15 (rest re-exported) |
| Domain modules created | 0 | 9 |
| Importers broken | — | 0 (barrel compat) |
| Typecheck errors added | — | 0 |
