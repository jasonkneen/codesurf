---
name: electron-ipc-security-audit
description: Systematic security audit of Electron IPC handlers covering path validation, process lifecycle, environment leakage, network security, and authentication gaps
source: auto-skill
extracted_at: '2026-06-22T14:40:44.079Z'
---

# Electron IPC Security Audit

Systematic approach to finding and fixing security vulnerabilities in Electron main process IPC handlers.

## Common Vulnerability Patterns

### 1. Path Validation Gaps

**Problem**: IPC handlers accept user-controlled paths without validation, enabling directory traversal or access to sensitive locations.

**Detection**:
- Search for `ipcMain.handle` calls that accept path/directory parameters
- Check if `validateFsPath` or equivalent validation is called before using the path
- Look for `shell.openExternal` with `file://` URLs that bypass path validation

**Example Fix**:
```typescript
ipcMain.handle('terminal:create', async (event, tileId: string, workspaceDir: string) => {
  // Validate before use
  const { validateFsPath } = await import('./fs.ts')
  try {
    workspaceDir = validateFsPath(workspaceDir)
  } catch (err) {
    return { error: `Access denied: ${(err as Error).message}` }
  }
  // Now safe to use workspaceDir
})
```

### 2. Process Lifecycle Guards

**Problem**: Broadcast helpers iterate windows without checking if they're destroyed, causing crashes when windows close during async operations.

**Detection**:
- Search for `BrowserWindow.getAllWindows()` followed by `.send()` calls
- Check for missing `isDestroyed()` or `webContents.isDestroyed()` guards
- Common in file watchers, MCP broadcasts, collab state updates

**Example Fix**:
```typescript
function broadcastMessageChange(payload: any): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('collab:messageChanged', payload)
  }
}
```

### 3. Environment Variable Leakage

**Problem**: PTY/agent spawns inherit entire `process.env`, leaking API keys and tokens to child processes.

**Detection**:
- Search for `spawn` or `exec` calls with `...process.env`
- Check terminal creation, agent CLI invocations, subprocess spawning
- Look for patterns like `env: { ...process.env, EXTRA_VAR: value }`

**Fix Pattern**:
```typescript
const SPAWN_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'TERM', 'TMPDIR',
  // Platform-specific essentials
  ...(process.platform === 'win32' ? ['SystemRoot', 'COMSPEC'] : []),
])
const SPAWN_ENV_DENYLIST_RE = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i

export function buildSafeSpawnEnv(extra = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (SPAWN_ENV_ALLOWLIST.has(key) && !SPAWN_ENV_DENYLIST_RE.test(key)) {
      env[key] = value
    }
  }
  return { ...env, ...extra }
}
```

### 4. DNS Rebinding SSRF

**Problem**: URL validation checks hostname strings but doesn't resolve DNS, allowing attacker domains that resolve to private IPs (127.0.0.1, 169.254.169.254).

**Detection**:
- Search for HTTP request functions that validate URLs with `assertSafeStreamUrl` or similar
- Check if `dns.lookup` or `dns.resolve` is called before connecting
- Look for patterns where hostname validation happens but IP validation doesn't

**Fix Pattern**:
```typescript
import { promises as dnsPromises } from 'dns'

// After URL validation, before HTTP request:
const lookup = await dnsPromises.lookup(url.hostname, { family: 0 })
const resolvedAddress = lookup.address

// Re-validate the resolved IP
assertSafeStreamUrl(`${url.protocol}//${resolvedAddress}:${url.port}${url.pathname}`)

// Use resolved IP for connection, preserve Host header
const options = {
  hostname: resolvedAddress,
  headers: { 'Host': url.host }
}
```

### 5. Unauthenticated Local Servers

**Problem**: Loopback-bound HTTP servers lack authentication, allowing any local process to use them.

**Detection**:
- Search for `http.createServer` or `http.Server` in main process
- Check for missing Bearer token or API key validation
- Look for predictable ports (1337, 8080, etc.) without auth

**Fix Pattern**:
```typescript
import { randomUUID } from 'crypto'

let proxyToken: string | null = null

function createProxyServer(port: number, token: string): http.Server {
  return http.createServer(async (req, res) => {
    // Health check doesn't need auth
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    // Require Bearer token for all other requests
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Missing or invalid bearer token' }))
      return
    }
    // ... handle request
  })
}

async function startProxyServer(port: number) {
  proxyToken = randomUUID()
  const server = createProxyServer(port, proxyToken)
  // ... start server
}
```

### 6. Streaming Parser Duplicate Events

**Problem**: SSE/NDJSON parsers emit `done` events on both protocol signals (`message_stop`, `[DONE]`) and HTTP `end` event, causing duplicate terminal events.

**Detection**:
- Search for streaming parsers that handle both protocol-level completion and HTTP stream end
- Look for multiple `sendStream({ type: 'done' })` calls in same parser
- Check Claude, Codex, OpenAI format parsers

**Fix Pattern**:
```typescript
export function parseClaudeStream(cardId: string, res: IncomingMessage): void {
  let doneSent = false
  const sendDone = (): void => {
    if (doneSent) return
    doneSent = true
    sendStream(cardId, { cardId, type: 'done' })
  }

  res.on('data', (chunk) => {
    // ... parse SSE events
    if (evt.type === 'message_stop') {
      sendDone()  // Protocol-level completion
    }
  })

  res.on('end', () => sendDone())  // HTTP stream end
}
```

### 7. IPC Handler Extraction from Monolithic Entry Files

**Problem**: Main process entry file (`index.ts`) accumulates 30+ inline `ipcMain.handle` calls alongside window management, app lifecycle, and branding code.

**Detection**:
- Count `ipcMain.handle` calls in entry file vs dedicated `src/main/ipc/*.ts` modules
- Look for feature domains (owl, updater, window, appearance, MCP config) implemented inline
- Check for dynamic `await import('fs')` patterns unique to inline handlers

**Extraction Pattern**:
```typescript
// src/main/ipc/owl.ts
import { ipcMain } from 'electron'
import { getOwlSupervisor, stopOwlSupervisor } from '../owl/runtime'

export function registerOwlIPC(): void {
  ipcMain.handle('owl:health', () => getOwlSupervisor().call('health', {}))
  // ... other handlers
}

// src/main/index.ts — replace inline handlers with:
import { registerOwlIPC } from './ipc/owl'
// In app.whenReady():
registerOwlIPC()
```

For handlers that need shared state (window creation, title maps), pass a context object:
```typescript
export interface WindowIPCContext {
  createWindow: (opts?) => BrowserWindow
  windowTitles: Map<number, string>
  broadcastWindowList: () => void
}

export function registerWindowIPC(ctx: WindowIPCContext): void {
  ipcMain.handle('window:setTitle', (event, title) => {
    ctx.windowTitles.set(event.sender.id, title)
    ctx.broadcastWindowList()
  })
}
```

### 8. React Canvas Performance: useState→useRef for High-Frequency Updates

**Problem**: Canvas pointer position stored as `useState` triggers full App re-render on every mouse move (60fps), even when no component reads the value during render.

**Detection**:
- Search for `useState` values that are SET on every mousemove/wheel/pointer event
- Check if the value is actually READ during render (vs passed through to children)
- Profile: does setting this state cause expensive re-renders?

**Fix Pattern**:
```typescript
// Before: triggers re-render on every mouse move
const [canvasPointerWorld, setCanvasPointerWorld] = useState<{x,y} | null>(null)

// After: ref + callback, no re-renders
const canvasPointerWorldRef = useRef<{x,y} | null>(null)
const setCanvasPointerWorld = useCallback(
  (value: {x,y} | null | ((prev) => {x,y} | null)) => {
    canvasPointerWorldRef.current = typeof value === 'function'
      ? value(canvasPointerWorldRef.current) : value
  }, [])
```

### 9. Stabilize useCallback Identity by Reading from Refs

**Problem**: `useCallback` hooks that depend on `viewport` state create new function references on every pan/zoom frame, busting downstream `React.memo` comparisons.

**Detection**:
- Find `useCallback` with `[viewport]` or similar frequently-changing state in dependency array
- Check if the function only needs to READ the current value (not close over it)
- Look for a corresponding `viewportRef` that already exists

**Fix Pattern**:
```typescript
// Before: new function reference on every viewport change
const worldToScreen = useCallback((point) => (
  worldToScreenPoint(point, viewport)
), [viewport])

// After: stable identity, reads from ref at call time
const worldToScreen = useCallback((point) => (
  worldToScreenPoint(point, viewportRef.current)
), [viewportRef])
```

Same pattern applies to event listeners:
```typescript
// Before: listener torn down and recreated on every viewport change
useEffect(() => {
  const onWheel = (e) => setViewport(zoomAtPoint(viewport, ...))
  el.addEventListener('wheel', onWheel)
  return () => el.removeEventListener('wheel', onWheel)
}, [canvasRef, viewport])

// After: stable listener reads from ref
useEffect(() => {
  const onWheel = (e) => {
    const vp = viewportRef.current
    setViewport(zoomAtPoint(vp, ...))
  }
  el.addEventListener('wheel', onWheel)
  return () => el.removeEventListener('wheel', onWheel)
}, [canvasRef, viewportRef])
```

### 10. Per-Entity Token Registries

**Problem**: A single global bearer token is shared across all clients (terminals, agents, renderer). If one client's token leaks, all operations are compromised.

**Detection**:
- Search for `randomUUID()` or token generation in server modules
- Check if the same token is used for auth validation across all clients
- Look for token written to disk files (`.mcp.json`, `mcp-server.json`)

**Fix Pattern**:
```typescript
import { randomUUID } from 'crypto'

const GLOBAL_TOKEN = randomUUID()
const entityTokens = new Map<string, string>()

export function generateEntityToken(entityId: string): string {
  const existing = entityTokens.get(entityId)
  if (existing) return existing
  const token = randomUUID()
  entityTokens.set(entityId, token)
  return token
}

export function revokeEntityToken(entityId: string): void {
  entityTokens.delete(entityId)
}

// Auth validation checks both global and per-entity tokens
function requireAuth(token: string): boolean {
  if (token === GLOBAL_TOKEN) return true
  if (token && entityTokens.has(token)) return true
  return false
}

// Wire into entity lifecycle
ipcMain.handle('terminal:destroy', (_, tileId) => {
  // ... cleanup terminal
  revokeEntityToken(tileId)
})
```

### 11. CORS Origin Allowlist

**Problem**: MCP/HTTP servers reflect any `Origin` header as `Access-Control-Allow-Origin`, allowing any website to make credentialed cross-origin requests.

**Detection**:
- Search for `setHeader('Access-Control-Allow-Origin'` in server code
- Check if origin is reflected verbatim from `req.headers.origin`
- Look for wildcard `*` fallback when no origin is present

**Fix Pattern**:
```typescript
function setCorsHeaders(res: ServerResponse, req?: IncomingMessage): void {
  const origin = req?.headers.origin
  const isAllowedOrigin = !origin ||
    origin === 'null' ||                          // file:// in production
    origin.startsWith('http://localhost:') ||      // dev server
    origin === 'http://localhost' ||
    origin.startsWith('app://') ||                 // custom Electron schemes
    origin === 'app://codesurf'
  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    if (origin) res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}
```

### 12. Silent Catch Audit

**Problem**: Empty `catch {}` or `catch { /**/ }` blocks swallow errors silently, making debugging impossible when critical operations fail.

**Detection**:
- Search for `catch \{[\s]*\}` and `catch \{[\s]*/\*\*/[\s]*\}` patterns
- Categorize by severity: config writes, data operations, cleanup, file-existence checks
- Priority: MCP server config writes > data persistence > terminal spawn > cleanup

**Fix Pattern** (ENOENT-tolerant logging):
```typescript
// Before: silent failure on config read
try {
  const raw = await fs.readFile(configPath, 'utf8')
  config = JSON.parse(raw)
} catch { /**/ }

// After: log non-ENOENT errors, silently skip missing files
try {
  const raw = await fs.readFile(configPath, 'utf8')
  config = JSON.parse(raw)
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.warn('[mcp] Failed to read existing config:', err)
  }
}
```

**Acceptable silent catches** (no change needed):
- Temp file cleanup: `try { unlinkSync(tempDb) } catch {}`
- File existence checks: `try { await fs.access(path) } catch { return false }`
- Process teardown: `try { proc.kill() } catch {}`

### 13. O(n²) Computation Gating During Interaction

**Problem**: Expensive O(n²) computations (discovery graphs, connection candidates) run on every render frame during tile drags, causing frame drops with many tiles.

**Detection**:
- Search for nested loops over `tiles` array in `useMemo` hooks
- Check if the `useMemo` depends on `tiles` (changes on every drag frame)
- Look for `findDiscoveryMatch` or similar O(n) functions called in a loop

**Fix Pattern**:
```typescript
const negotiatedDiscoveryState = useMemo(() => {
  // ... build connection graph from worker results ...

  // Skip O(n²) auto-discovery during active drags — connections
  // don't need to be recomputed while tiles are moving
  const isActiveDrag = dragState.type === 'tile' ||
    dragState.type === 'group' ||
    dragState.type === 'resize' ||
    dragState.type === 'connection'

  if (autoConnectionsEnabled && !isActiveDrag) {
    for (const tile of tiles) {
      const discovery = findDiscoveryMatch(tile.id, tiles, ...)
      // ... process discovery match
    }
  }

  return { connectedTileIds, byTileConnections, ambientRoutes }
}, [autoConnectionsEnabled, tiles, dragState, ...])
```

## Audit Workflow

1. **Recon**: Read package.json, AGENTS.md, check `src/main/ipc/` directory structure
2. **Parallel Audits**: Launch subagents for security, correctness, performance, architecture, tests
3. **Vetting**: Spot-check findings against actual code, reject false positives
4. **Implementation**: Start with S-effort fixes, batch related changes
5. **Verification**: Run typecheck and test suite after each batch

## Common False Positives

- **CORS on loopback servers**: Often flagged but may be intentional for local dev tools
- **`process.env` in test files**: Usually acceptable in test contexts
- **Missing auth on health endpoints**: Health checks typically don't need auth

## Verification Commands

```bash
# Typecheck
npx tsgo -p tsconfig.tsgo.json --noEmit

# Run security-focused tests
node --test test/stream-ssrf.test.ts test/security-hardening.test.ts test/mcp-auth.test.ts

# Run full test suite
npm test
```
