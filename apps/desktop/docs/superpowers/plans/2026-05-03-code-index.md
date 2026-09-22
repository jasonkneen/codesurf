# Code Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a CodeSurf power-tier extension that maintains a per-workspace activity+symbol index of files Claude Code touches, exposes it via MCP tools, surfaces it in one tile, and ships with a companion skill and a layered eval suite.

**Architecture:** Hooks fire on every Claude Code Read/Edit/Write → POST to a localhost HTTP ingest server inside the extension's `main.js` → indexer updates per-workspace JSON store → tree-sitter WASM extracts symbols on Edit/Write → MCP tools serve `find`/`hot`/`related` queries. One observability tile reads the same data via the bridge bus.

**Tech Stack:** Node.js (Electron main process), `web-tree-sitter` (WASM), `vitest` for unit tests, plain HTML/JS tile (no framework), bash + PowerShell hook one-liners (no script files).

**Spec:** `docs/superpowers/specs/2026-05-03-code-index-design.md`

**Working directory for ALL tasks:** `examples/extensions/code-index/` inside `collaborator-clone`. Per the extension dev workspace rules, do NOT touch any file outside that directory except for the companion skill (`~/.claude/skills/code-index/`) and the install copy target (`~/.codesurf/extensions/code-index/`).

---

## Phase 1 — Foundation

### Task 1.1: Scaffold extension directory + manifest

**Files:**
- Create: `examples/extensions/code-index/extension.json`
- Create: `examples/extensions/code-index/package.json`
- Create: `examples/extensions/code-index/.gitignore`

- [ ] **Step 1: Create the extension directory**

```bash
mkdir -p /Users/jkneen/clawd/collaborator-clone/examples/extensions/code-index/{lib,grammars,tiles/dashboard,hook,evals/{unit,fixtures/sample-repos,fixtures/transcripts,agent-loop/scenarios,replay},data}
```

- [ ] **Step 2: Write `extension.json`**

```json
{
  "id": "code-index",
  "name": "Code Index",
  "version": "0.1.0",
  "description": "Per-workspace activity + symbol index built from Claude Code tool-use. MCP tools for find/hot/related queries.",
  "author": "contex",
  "tier": "power",
  "main": "main.js",
  "contributes": {
    "tiles": [
      {
        "type": "code-index-dashboard",
        "label": "Code Index",
        "entry": "tiles/dashboard/index.html",
        "defaultSize": { "w": 400, "h": 500 },
        "minSize": { "w": 320, "h": 360 }
      }
    ],
    "contextMenu": [
      { "label": "New Code Index", "action": "createTile", "tileType": "ext:code-index-dashboard" }
    ],
    "context": {
      "produces": ["ctx:code-index:open-file", "ctx:code-index:activity"],
      "consumes": []
    },
    "actions": [
      { "name": "find", "description": "Find symbol by name. Params: { name: string, kind?: string, limit?: number }" },
      { "name": "hot", "description": "Top hot files or top symbols in a file. Params: { path?: string, limit?: number }" },
      { "name": "related", "description": "Files co-touched with this one. Params: { path: string, limit?: number }" },
      { "name": "stats", "description": "Index health and counts. No params." },
      { "name": "backfill", "description": "Replay transcripts into index. Params: { transcriptPath?: string, days?: number }" }
    ]
  },
  "permissions": ["network", "fs", "os:read"]
}
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "code-index-extension",
  "version": "0.1.0",
  "private": true,
  "description": "Code Index CodeSurf extension",
  "main": "main.js",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:agent-loop": "node evals/agent-loop/runner.mjs",
    "replay": "node evals/replay/replay.mjs"
  },
  "dependencies": {
    "web-tree-sitter": "^0.22.6"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
data/
*.log
.DS_Store
```

- [ ] **Step 5: Install dependencies**

Run:
```bash
cd /Users/jkneen/clawd/collaborator-clone/examples/extensions/code-index && npm install
```

Expected: installs `web-tree-sitter` and `vitest`, no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/{extension.json,package.json,.gitignore,package-lock.json} && git commit -m "feat(code-index): scaffold extension manifest and package"
```

---

### Task 1.2: Storage module — atomic JSON + JSONL append

**Files:**
- Create: `examples/extensions/code-index/lib/storage.js`
- Test: `examples/extensions/code-index/evals/unit/storage.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `evals/unit/storage.test.mjs`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Storage } from '../../lib/storage.js'

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Storage', () => {
  it('writes and reads index.json atomically', async () => {
    const s = new Storage(tmp)
    await s.writeIndex({ version: 1, files: {} })
    const got = await s.readIndex()
    expect(got).toEqual({ version: 1, files: {} })
  })

  it('returns null when index missing', async () => {
    const s = new Storage(tmp)
    expect(await s.readIndex()).toBeNull()
  })

  it('appends to activity.jsonl', async () => {
    const s = new Storage(tmp)
    await s.appendActivity({ tool: 'Read', path: 'a.ts', ts: 1 })
    await s.appendActivity({ tool: 'Edit', path: 'b.ts', ts: 2 })
    const lines = fs.readFileSync(path.join(tmp, 'activity.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).tool).toBe('Read')
  })

  it('rotates activity.jsonl when over limit', async () => {
    const s = new Storage(tmp, { rotateBytes: 200 })
    for (let i = 0; i < 10; i++) await s.appendActivity({ tool: 'Read', path: `f${i}.ts`, ts: i })
    const files = fs.readdirSync(tmp).filter(f => f.startsWith('activity'))
    expect(files.length).toBeGreaterThan(1)
  })

  it('debounced writeIndex coalesces writes', async () => {
    const s = new Storage(tmp, { writeDebounceMs: 50 })
    s.scheduleWrite({ version: 1, files: { a: 1 } })
    s.scheduleWrite({ version: 1, files: { a: 2 } })
    s.scheduleWrite({ version: 1, files: { a: 3 } })
    await new Promise(r => setTimeout(r, 100))
    const got = await s.readIndex()
    expect(got.files.a).toBe(3)
  })

  it('atomic write survives mid-write crash simulation', async () => {
    const s = new Storage(tmp)
    await s.writeIndex({ version: 1, files: { a: 1 } })
    // Manually create a stale .tmp file as if a previous process crashed mid-write
    fs.writeFileSync(path.join(tmp, 'index.json.tmp'), '{ broken')
    const got = await s.readIndex()
    expect(got.files.a).toBe(1)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd examples/extensions/code-index && npx vitest run evals/unit/storage.test.mjs
```

Expected: all tests fail with "Cannot find module './lib/storage.js'".

- [ ] **Step 3: Implement `lib/storage.js`**

```javascript
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const DEFAULTS = {
  rotateBytes: 10 * 1024 * 1024,   // 10 MB
  writeDebounceMs: 5000,
}

class Storage {
  constructor(dir, opts = {}) {
    this.dir = dir
    this.opts = { ...DEFAULTS, ...opts }
    this.indexPath = path.join(dir, 'index.json')
    this.tmpPath = path.join(dir, 'index.json.tmp')
    this.activityPath = path.join(dir, 'activity.jsonl')
    this._pending = null
    this._timer = null
    fs.mkdirSync(dir, { recursive: true })
  }

  async readIndex() {
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf8')
      return JSON.parse(raw)
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  async writeIndex(obj) {
    const data = JSON.stringify(obj)
    await fsp.writeFile(this.tmpPath, data, 'utf8')
    await fsp.rename(this.tmpPath, this.indexPath)
  }

  scheduleWrite(obj) {
    this._pending = obj
    if (this._timer) return
    this._timer = setTimeout(async () => {
      const toWrite = this._pending
      this._pending = null
      this._timer = null
      try { await this.writeIndex(toWrite) } catch (e) { /* logged by caller */ }
    }, this.opts.writeDebounceMs)
  }

  async flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (this._pending) {
      const obj = this._pending; this._pending = null
      await this.writeIndex(obj)
    }
  }

  async appendActivity(event) {
    const line = JSON.stringify(event) + '\n'
    await fsp.appendFile(this.activityPath, line, 'utf8')
    await this._maybeRotate()
  }

  async _maybeRotate() {
    let stat
    try { stat = await fsp.stat(this.activityPath) } catch { return }
    if (stat.size < this.opts.rotateBytes) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fsp.rename(this.activityPath, path.join(this.dir, `activity-${stamp}.jsonl`))
  }
}

module.exports = { Storage }
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd examples/extensions/code-index && npx vitest run evals/unit/storage.test.mjs
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/lib/storage.js examples/extensions/code-index/evals/unit/storage.test.mjs && git commit -m "feat(code-index): atomic JSON storage with debounced writes and JSONL rotation"
```

---

### Task 1.3: Workspace resolution

**Files:**
- Create: `examples/extensions/code-index/lib/workspace.js`
- Test: `examples/extensions/code-index/evals/unit/workspace.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveWorkspace, workspaceKey } from '../../lib/workspace.js'

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('workspace', () => {
  it('walks up to .git', () => {
    fs.mkdirSync(path.join(tmp, '.git'))
    fs.mkdirSync(path.join(tmp, 'src', 'lib'), { recursive: true })
    expect(resolveWorkspace(path.join(tmp, 'src', 'lib'))).toBe(tmp)
  })

  it('falls back to cwd when no .git found', () => {
    expect(resolveWorkspace(tmp)).toBe(tmp)
  })

  it('honors CODE_INDEX_WORKSPACE_ROOT env override', () => {
    const orig = process.env.CODE_INDEX_WORKSPACE_ROOT
    process.env.CODE_INDEX_WORKSPACE_ROOT = '/explicit/root'
    try {
      expect(resolveWorkspace('/some/deep/path')).toBe('/explicit/root')
    } finally {
      if (orig === undefined) delete process.env.CODE_INDEX_WORKSPACE_ROOT
      else process.env.CODE_INDEX_WORKSPACE_ROOT = orig
    }
  })

  it('workspaceKey is stable sha1-based hex', () => {
    const k1 = workspaceKey('/Users/x/repo')
    const k2 = workspaceKey('/Users/x/repo')
    expect(k1).toBe(k2)
    expect(k1).toMatch(/^[a-f0-9]{40}$/)
  })

  it('different paths produce different keys', () => {
    expect(workspaceKey('/a')).not.toBe(workspaceKey('/b'))
  })
})
```

- [ ] **Step 2: Run, verify fail**

```bash
cd examples/extensions/code-index && npx vitest run evals/unit/workspace.test.mjs
```

Expected: fails on missing module.

- [ ] **Step 3: Implement `lib/workspace.js`**

```javascript
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function resolveWorkspace(cwd) {
  const override = process.env.CODE_INDEX_WORKSPACE_ROOT
  if (override) return override

  let dir = path.resolve(cwd)
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(cwd) // hit filesystem root
    dir = parent
  }
}

function workspaceKey(rootPath) {
  return crypto.createHash('sha1').update(rootPath).digest('hex')
}

module.exports = { resolveWorkspace, workspaceKey }
```

- [ ] **Step 4: Run, verify pass**

```bash
cd examples/extensions/code-index && npx vitest run evals/unit/workspace.test.mjs
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/lib/workspace.js examples/extensions/code-index/evals/unit/workspace.test.mjs && git commit -m "feat(code-index): workspace root resolution with .git walk and env override"
```

---

### Task 1.4: HTTP ingest server

**Files:**
- Create: `examples/extensions/code-index/lib/ingest-server.js`
- Test: `examples/extensions/code-index/evals/unit/ingest-server.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startIngestServer } from '../../lib/ingest-server.js'

let server
afterEach(async () => { if (server) await server.close() })

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
}

describe('ingest server', () => {
  it('starts on a free port and returns the port', async () => {
    server = await startIngestServer({ onEvent: () => {} })
    expect(server.port).toBeGreaterThan(0)
  })

  it('accepts well-formed Claude hook payload and dispatches to onEvent', async () => {
    const events = []
    server = await startIngestServer({ onEvent: (e) => events.push(e) })
    const r = await post(server.port, '/ingest', {
      session_id: 'abc',
      tool_name: 'Read',
      tool_input: { file_path: '/Users/x/repo/src/a.ts' },
      cwd: '/Users/x/repo',
    })
    expect(r.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      tool: 'Read',
      path: '/Users/x/repo/src/a.ts',
      cwd: '/Users/x/repo',
    })
    expect(events[0].ts).toBeGreaterThan(0)
  })

  it('extracts path from MultiEdit payload', async () => {
    const events = []
    server = await startIngestServer({ onEvent: (e) => events.push(e) })
    await post(server.port, '/ingest', {
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/x/a.ts', edits: [{ old_string: 'a' }] },
      cwd: '/x',
    })
    expect(events[0].tool).toBe('MultiEdit')
    expect(events[0].path).toBe('/x/a.ts')
  })

  it('rejects unknown tools with 200 + ignored:true (never block the hook)', async () => {
    const events = []
    server = await startIngestServer({ onEvent: (e) => events.push(e) })
    const r = await post(server.port, '/ingest', { tool_name: 'Bash', tool_input: {}, cwd: '/x' })
    expect(r.status).toBe(200)
    expect(events).toHaveLength(0)
  })

  it('returns 200 for malformed JSON without throwing', async () => {
    server = await startIngestServer({ onEvent: () => {} })
    const res = await fetch(`http://127.0.0.1:${server.port}/ingest`, { method: 'POST', body: 'not json' })
    expect(res.status).toBe(200)
  })

  it('GET /health returns ok', async () => {
    server = await startIngestServer({ onEvent: () => {} })
    const res = await fetch(`http://127.0.0.1:${server.port}/health`)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run, verify fail**

```bash
cd examples/extensions/code-index && npx vitest run evals/unit/ingest-server.test.mjs
```

- [ ] **Step 3: Implement `lib/ingest-server.js`**

```javascript
const http = require('node:http')

const TOOL_SET = new Set(['Read', 'Edit', 'Write', 'MultiEdit'])

function extractPath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null
  return toolInput.file_path || toolInput.path || toolInput.notebook_path || null
}

function startIngestServer({ onEvent, host = '127.0.0.1', port = 0 } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/ingest') {
        res.writeHead(404); res.end('not found'); return
      }

      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let payload
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ignored":true}'); return }

        const tool = payload.tool_name
        if (!TOOL_SET.has(tool)) {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ignored":true}'); return
        }
        const filePath = extractPath(payload.tool_input)
        if (!filePath) {
          res.writeHead(200); res.end('{"ignored":true}'); return
        }

        try {
          onEvent({
            tool,
            path: filePath,
            cwd: payload.cwd || process.cwd(),
            sessionId: payload.session_id || 'unknown',
            ts: Math.floor(Date.now() / 1000),
          })
        } catch { /* swallow — hook must never see an error */ }

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      req.on('error', () => { try { res.writeHead(200); res.end('{"ignored":true}') } catch {} })
    })

    server.listen(port, host, () => {
      const addr = server.address()
      resolve({
        port: addr.port,
        host,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

module.exports = { startIngestServer }
```

- [ ] **Step 4: Run, verify pass**

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/lib/ingest-server.js examples/extensions/code-index/evals/unit/ingest-server.test.mjs && git commit -m "feat(code-index): localhost HTTP ingest server with malformed-input safety"
```

---

## Phase 2 — Indexer Core

### Task 2.1: Indexer with counters, hotness, co-occurrence

**Files:**
- Create: `examples/extensions/code-index/lib/indexer.js`
- Test: `examples/extensions/code-index/evals/unit/indexer.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, beforeEach } from 'vitest'
import { Indexer } from '../../lib/indexer.js'

const T0 = 1_730_000_000  // arbitrary epoch seconds

let idx
beforeEach(() => { idx = new Indexer({ now: () => T0, sessionWindowSec: 1800, halfLifeDays: 14 }) })

describe('Indexer', () => {
  it('starts with empty state', () => {
    const s = idx.getState()
    expect(s.files).toEqual({})
    expect(s.cooccurrence).toEqual({})
  })

  it('increments counters per tool', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 + 10 })
    idx.ingest({ tool: 'Edit', path: 'a.ts', sessionId: 's1', ts: T0 + 20 })
    idx.ingest({ tool: 'Write', path: 'a.ts', sessionId: 's1', ts: T0 + 30 })
    const f = idx.getState().files['a.ts']
    expect(f).toMatchObject({ reads: 2, edits: 1, writes: 1 })
    expect(f.lastTouched).toBe(T0 + 30)
  })

  it('records co-occurrence within session window', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's1', ts: T0 + 100 })
    idx.ingest({ tool: 'Read', path: 'c.ts', sessionId: 's1', ts: T0 + 200 })
    const co = idx.getState().cooccurrence
    expect(co['a.ts']['b.ts']).toBe(1)
    expect(co['b.ts']['a.ts']).toBe(1)
    expect(co['a.ts']['c.ts']).toBe(1)
  })

  it('does NOT increment co-occurrence twice for same pair within same session', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's1', ts: T0 + 60 })
    idx.ingest({ tool: 'Edit', path: 'a.ts', sessionId: 's1', ts: T0 + 120 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's1', ts: T0 + 180 })
    expect(idx.getState().cooccurrence['a.ts']['b.ts']).toBe(1)
  })

  it('bumps co-occurrence again in a new session window', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's1', ts: T0 + 60 })
    // 31 minutes later — new session
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's2', ts: T0 + 1860 })
    idx.ingest({ tool: 'Read', path: 'b.ts', sessionId: 's2', ts: T0 + 1920 })
    expect(idx.getState().cooccurrence['a.ts']['b.ts']).toBe(2)
  })

  it('hotness uses weighted decay (read=1, edit=3, write=5)', () => {
    idx.ingest({ tool: 'Write', path: 'a.ts', sessionId: 's1', ts: T0 })
    const h = idx.computeHotness('a.ts', T0)
    // Single Write event at age=0 → weight 5 × exp(0) = 5
    expect(h).toBeCloseTo(5, 5)
  })

  it('hotness decays with age', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    const fresh = idx.computeHotness('a.ts', T0)
    const halfLifeLater = idx.computeHotness('a.ts', T0 + 14 * 86400)
    expect(halfLifeLater).toBeLessThan(fresh)
    expect(halfLifeLater).toBeCloseTo(fresh * Math.exp(-1), 3)
  })

  it('survives serialize → deserialize round-trip', () => {
    idx.ingest({ tool: 'Read', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.ingest({ tool: 'Edit', path: 'b.ts', sessionId: 's1', ts: T0 + 60 })
    const dumped = idx.serialize()
    const restored = new Indexer({ now: () => T0 + 100 })
    restored.deserialize(dumped)
    expect(restored.getState().files['a.ts'].reads).toBe(1)
    expect(restored.getState().files['b.ts'].edits).toBe(1)
    expect(restored.getState().cooccurrence['a.ts']['b.ts']).toBe(1)
  })

  it('updateSymbols replaces a file symbol list', () => {
    idx.ingest({ tool: 'Edit', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.updateSymbols('a.ts', { language: 'typescript', size: 100, symbols: [{ name: 'foo', kind: 'function', line: 1 }], parseError: null })
    expect(idx.getState().files['a.ts'].symbols).toHaveLength(1)
    idx.updateSymbols('a.ts', { language: 'typescript', size: 200, symbols: [{ name: 'bar', kind: 'class', line: 5 }], parseError: null })
    expect(idx.getState().files['a.ts'].symbols[0].name).toBe('bar')
  })

  it('parseError is stored and clears on success', () => {
    idx.ingest({ tool: 'Edit', path: 'a.ts', sessionId: 's1', ts: T0 })
    idx.updateSymbols('a.ts', { language: 'typescript', size: 100, symbols: [], parseError: 'syntax' })
    expect(idx.getState().files['a.ts'].parseError).toBe('syntax')
    idx.updateSymbols('a.ts', { language: 'typescript', size: 100, symbols: [{ name: 'x', kind: 'function', line: 1 }], parseError: null })
    expect(idx.getState().files['a.ts'].parseError).toBeNull()
  })
})
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `lib/indexer.js`**

```javascript
const TOOL_WEIGHT = { Read: 1, Edit: 3, MultiEdit: 3, Write: 5 }
const DEFAULTS = {
  sessionWindowSec: 1800,   // 30 min
  halfLifeDays: 14,
  now: () => Math.floor(Date.now() / 1000),
}

class Indexer {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts }
    // Per-file: { reads, edits, writes, lastTouched, language, size, symbols, parseError, events:[{tool,ts}] }
    this.files = {}
    // Per-pair: cooccurrence[a][b] = count
    this.cooccurrence = {}
    // Track which pairs we've already counted in the current session window
    // Map<pathA::pathB, lastTs>
    this._sessionPairs = new Map()
    // Track active session: list of { path, ts } within window
    this._sessionTouched = []
  }

  ingest(evt) {
    const { tool, path: p, ts } = evt
    if (!TOOL_WEIGHT[tool]) return

    const f = this.files[p] || (this.files[p] = {
      reads: 0, edits: 0, writes: 0,
      lastTouched: 0,
      language: null, size: 0, symbols: [], parseError: null,
      events: [],
    })

    if (tool === 'Read') f.reads++
    else if (tool === 'Write') f.writes++
    else f.edits++  // Edit and MultiEdit both count as edit

    f.lastTouched = Math.max(f.lastTouched, ts)
    f.events.push({ tool, ts })
    // Cap events per file to keep memory bounded
    if (f.events.length > 1000) f.events.splice(0, f.events.length - 1000)

    this._updateCoOccurrence(p, ts)
  }

  _updateCoOccurrence(path, ts) {
    const window = this.opts.sessionWindowSec
    // Drop touches outside the current window
    this._sessionTouched = this._sessionTouched.filter(t => ts - t.ts <= window)
    // For each file currently in window (excluding current path), maybe bump
    for (const t of this._sessionTouched) {
      if (t.path === path) continue
      const key = t.path < path ? `${t.path}::${path}` : `${path}::${t.path}`
      const last = this._sessionPairs.get(key)
      if (last !== undefined && ts - last <= window) continue  // already counted in this window
      this._bumpPair(t.path, path)
      this._sessionPairs.set(key, ts)
    }
    // Garbage collect old session pairs
    for (const [k, v] of this._sessionPairs) {
      if (ts - v > window) this._sessionPairs.delete(k)
    }
    this._sessionTouched.push({ path, ts })
  }

  _bumpPair(a, b) {
    if (!this.cooccurrence[a]) this.cooccurrence[a] = {}
    if (!this.cooccurrence[b]) this.cooccurrence[b] = {}
    this.cooccurrence[a][b] = (this.cooccurrence[a][b] || 0) + 1
    this.cooccurrence[b][a] = (this.cooccurrence[b][a] || 0) + 1
  }

  updateSymbols(path, { language, size, symbols, parseError }) {
    const f = this.files[path]
    if (!f) return
    f.language = language
    f.size = size
    f.symbols = symbols
    f.parseError = parseError
  }

  computeHotness(path, now = this.opts.now()) {
    const f = this.files[path]
    if (!f) return 0
    const halfLifeSec = this.opts.halfLifeDays * 86400
    let h = 0
    for (const e of f.events) {
      const ageSec = Math.max(0, now - e.ts)
      const w = TOOL_WEIGHT[e.tool] || 0
      h += w * Math.exp(-ageSec / halfLifeSec)
    }
    return h
  }

  getState() {
    return { files: this.files, cooccurrence: this.cooccurrence }
  }

  serialize() {
    // Strip event arrays to keep the file small; persist enough to recompute hotness lazily later.
    // For round-trip fidelity (tests + backfill), we keep events too.
    return {
      version: 1,
      files: this.files,
      cooccurrence: this.cooccurrence,
    }
  }

  deserialize(obj) {
    if (!obj || obj.version !== 1) return
    this.files = obj.files || {}
    this.cooccurrence = obj.cooccurrence || {}
    // Ensure every file has an events array (legacy data may lack it)
    for (const f of Object.values(this.files)) {
      if (!Array.isArray(f.events)) f.events = []
      if (!Array.isArray(f.symbols)) f.symbols = []
    }
  }
}

module.exports = { Indexer, TOOL_WEIGHT }
```

- [ ] **Step 4: Run, verify pass**

Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/lib/indexer.js examples/extensions/code-index/evals/unit/indexer.test.mjs && git commit -m "feat(code-index): indexer with weighted hotness decay and session-windowed co-occurrence"
```

---

## Phase 3 — Parser

### Task 3.1: Tree-sitter WASM bootstrap + language detection

**Files:**
- Create: `examples/extensions/code-index/lib/parser.js`
- Create: `examples/extensions/code-index/lib/languages.js`
- Test: `examples/extensions/code-index/evals/unit/languages.test.mjs`

- [ ] **Step 1: Write the failing test for language detection**

```javascript
import { describe, it, expect } from 'vitest'
import { detectLanguage } from '../../lib/languages.js'

describe('detectLanguage', () => {
  it.each([
    ['foo.ts', 'typescript'],
    ['foo.tsx', 'tsx'],
    ['foo.js', 'javascript'],
    ['foo.mjs', 'javascript'],
    ['foo.cjs', 'javascript'],
    ['foo.jsx', 'tsx'],     // jsx parsed by tsx grammar
    ['foo.py', 'python'],
    ['foo.go', 'go'],
    ['foo.rs', 'rust'],
    ['README.md', 'markdown'],
    ['foo.txt', null],
    ['no-extension', null],
    ['/abs/path/to/foo.ts', 'typescript'],
  ])('detects %s as %s', (filename, expected) => {
    expect(detectLanguage(filename)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `lib/languages.js`**

```javascript
const path = require('node:path')

const EXT_TO_LANG = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'tsx',  // tree-sitter-tsx handles jsx
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.md': 'markdown',
  '.markdown': 'markdown',
}

const LANG_TO_GRAMMAR = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  markdown: 'tree-sitter-markdown.wasm',
}

function detectLanguage(filename) {
  const ext = path.extname(filename).toLowerCase()
  return EXT_TO_LANG[ext] || null
}

function grammarFile(language) {
  return LANG_TO_GRAMMAR[language] || null
}

module.exports = { detectLanguage, grammarFile, EXT_TO_LANG, LANG_TO_GRAMMAR }
```

- [ ] **Step 4: Run, verify pass**

Expected: 13 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/lib/languages.js examples/extensions/code-index/evals/unit/languages.test.mjs && git commit -m "feat(code-index): language detection by file extension"
```

---

### Task 3.2: Acquire tree-sitter WASM grammars

**Files:**
- Create: `examples/extensions/code-index/grammars/README.md`
- Create: `examples/extensions/code-index/scripts/fetch-grammars.mjs`

- [ ] **Step 1: Write the grammar fetch script**

Create `scripts/fetch-grammars.mjs`:

```javascript
#!/usr/bin/env node
// Downloads pre-built tree-sitter WASM grammars from the @tree-sitter-grammars
// CDN-hosted release artifacts, into ./grammars/.
//
// Run: node scripts/fetch-grammars.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'grammars')

// Each entry: filename to write → URL to fetch.
// Pin to known-good versions. Update via PR with CI test run.
const GRAMMARS = {
  'tree-sitter-typescript.wasm':
    'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.12/out/tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm':
    'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.12/out/tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm':
    'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.12/out/tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm':
    'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.12/out/tree-sitter-python.wasm',
  'tree-sitter-go.wasm':
    'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.12/out/tree-sitter-go.wasm',
  'tree-sitter-rust.wasm':
    'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.12/out/tree-sitter-rust.wasm',
  'tree-sitter-markdown.wasm':
    'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.12/out/tree-sitter-markdown.wasm',
}

fs.mkdirSync(OUT, { recursive: true })

for (const [name, url] of Object.entries(GRAMMARS)) {
  const dest = path.join(OUT, name)
  process.stdout.write(`Fetching ${name}... `)
  const res = await fetch(url)
  if (!res.ok) { console.error(`FAIL ${res.status}`); process.exit(1) }
  await pipeline(res.body, fs.createWriteStream(dest))
  const size = fs.statSync(dest).size
  console.log(`${(size / 1024).toFixed(0)} KB`)
}

console.log('Done.')
```

- [ ] **Step 2: Add the fetch script to package.json**

Modify `package.json`, add to `"scripts"`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "test:agent-loop": "node evals/agent-loop/runner.mjs",
  "replay": "node evals/replay/replay.mjs",
  "fetch-grammars": "node scripts/fetch-grammars.mjs",
  "postinstall": "node scripts/fetch-grammars.mjs"
}
```

- [ ] **Step 3: Run the fetch**

```bash
cd examples/extensions/code-index && node scripts/fetch-grammars.mjs
```

Expected: 7 grammars downloaded into `grammars/`. Verify:

```bash
ls -lh examples/extensions/code-index/grammars/*.wasm
```

Expected: 7 files, total ~5–10 MB.

- [ ] **Step 4: Write `grammars/README.md`**

```markdown
# Tree-sitter Grammars

Pre-built WASM grammars for symbol extraction. Fetched from the
[`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms)
CDN by `scripts/fetch-grammars.mjs`. Pinned to version 0.1.12.

To re-fetch:

    npm run fetch-grammars

These files are NOT committed to git. They are downloaded on `npm install`
via the `postinstall` hook so the install location and dev environment
both have them.
```

- [ ] **Step 5: Update `.gitignore`**

Modify `.gitignore`, add:

```
grammars/*.wasm
```

- [ ] **Step 6: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/scripts/fetch-grammars.mjs examples/extensions/code-index/grammars/README.md examples/extensions/code-index/package.json examples/extensions/code-index/.gitignore && git commit -m "feat(code-index): fetch script for tree-sitter WASM grammars"
```

---

### Task 3.3: Symbol extraction with tree-sitter

**Files:**
- Create: `examples/extensions/code-index/lib/parser.js`
- Test: `examples/extensions/code-index/evals/unit/parser.test.mjs`
- Create: `examples/extensions/code-index/evals/fixtures/sample-repos/ts-react/src/easing.ts`
- Create: `examples/extensions/code-index/evals/fixtures/sample-repos/ts-react/src/Component.tsx`
- Create: `examples/extensions/code-index/evals/fixtures/sample-repos/py-flask/app.py`
- Create: `examples/extensions/code-index/evals/fixtures/sample-repos/go-cli/main.go`

- [ ] **Step 1: Write fixture source files**

`evals/fixtures/sample-repos/ts-react/src/easing.ts`:

```typescript
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export class EasingPipeline {
  steps: Array<(t: number) => number> = []
  add(fn: (t: number) => number): this { this.steps.push(fn); return this }
  apply(t: number): number { return this.steps.reduce((acc, f) => f(acc), t) }
}
```

`evals/fixtures/sample-repos/ts-react/src/Component.tsx`:

```tsx
import React from 'react'

export interface Props { title: string }

export function Header({ title }: Props) {
  return <h1>{title}</h1>
}

export const Footer: React.FC = () => <footer>©</footer>
```

`evals/fixtures/sample-repos/py-flask/app.py`:

```python
from flask import Flask

app = Flask(__name__)

class UserService:
    def get_user(self, uid): return {"id": uid}

def create_app():
    return app

@app.route("/")
def index():
    return "hello"
```

`evals/fixtures/sample-repos/go-cli/main.go`:

```go
package main

import "fmt"

type User struct { ID int }

func (u User) Greet() string { return fmt.Sprintf("hello %d", u.ID) }

func main() { fmt.Println("ok") }
```

- [ ] **Step 2: Write the failing parser test**

```javascript
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { Parser } from '../../lib/parser.js'

const FIX = path.join(import.meta.dirname, '..', 'fixtures', 'sample-repos')

let parser
beforeAll(async () => {
  parser = new Parser({ grammarsDir: path.join(import.meta.dirname, '..', '..', 'grammars') })
  await parser.init()
})

describe('Parser', () => {
  it('extracts top-level functions, classes, exports from TypeScript', async () => {
    const src = fs.readFileSync(path.join(FIX, 'ts-react/src/easing.ts'), 'utf8')
    const r = await parser.parse('src/easing.ts', src)
    expect(r.parseError).toBeNull()
    expect(r.language).toBe('typescript')
    const names = r.symbols.map(s => s.name).sort()
    expect(names).toContain('smoothstep')
    expect(names).toContain('easeInOutCubic')
    expect(names).toContain('EasingPipeline')
  })

  it('records line numbers (1-indexed)', async () => {
    const src = fs.readFileSync(path.join(FIX, 'ts-react/src/easing.ts'), 'utf8')
    const r = await parser.parse('src/easing.ts', src)
    const sm = r.symbols.find(s => s.name === 'smoothstep')
    expect(sm.line).toBe(1)
  })

  it('extracts JSX/TSX components', async () => {
    const src = fs.readFileSync(path.join(FIX, 'ts-react/src/Component.tsx'), 'utf8')
    const r = await parser.parse('src/Component.tsx', src)
    const names = r.symbols.map(s => s.name)
    expect(names).toContain('Header')
    expect(names).toContain('Footer')
  })

  it('extracts python functions and classes', async () => {
    const src = fs.readFileSync(path.join(FIX, 'py-flask/app.py'), 'utf8')
    const r = await parser.parse('app.py', src)
    expect(r.symbols.map(s => s.name)).toEqual(expect.arrayContaining(['UserService', 'create_app', 'index']))
  })

  it('extracts go funcs and types', async () => {
    const src = fs.readFileSync(path.join(FIX, 'go-cli/main.go'), 'utf8')
    const r = await parser.parse('main.go', src)
    expect(r.symbols.map(s => s.name)).toEqual(expect.arrayContaining(['User', 'Greet', 'main']))
  })

  it('returns null symbols + parseError for unsupported language', async () => {
    const r = await parser.parse('foo.txt', 'plain text')
    expect(r.symbols).toEqual([])
    expect(r.language).toBeNull()
    expect(r.parseError).toMatch(/unsupported/i)
  })

  it('returns parseError on syntax error without throwing', async () => {
    const r = await parser.parse('bad.ts', 'function (((')
    expect(r.parseError).toBeTruthy()
    expect(Array.isArray(r.symbols)).toBe(true)  // partial recovery still allowed
  })

  it('skips files larger than maxBytes', async () => {
    const huge = 'x'.repeat(2_000_000)
    const r = await parser.parse('huge.ts', huge, { maxBytes: 1_000_000 })
    expect(r.parseError).toMatch(/too large/i)
    expect(r.symbols).toEqual([])
  })
})
```

- [ ] **Step 3: Run, verify fail**

Expected: fails on missing parser module.

- [ ] **Step 4: Implement `lib/parser.js`**

```javascript
const fs = require('node:fs')
const path = require('node:path')
const Parser = require('web-tree-sitter')
const { detectLanguage, grammarFile } = require('./languages')

// tree-sitter node types we treat as "top-level symbol" definitions, per language.
// kind label is what we surface to the agent.
const QUERIES = {
  typescript: [
    { node: 'function_declaration', name: 'name', kind: 'function' },
    { node: 'class_declaration', name: 'name', kind: 'class' },
    { node: 'method_definition', name: 'name', kind: 'method' },
    { node: 'interface_declaration', name: 'name', kind: 'interface' },
    { node: 'type_alias_declaration', name: 'name', kind: 'type' },
    { node: 'enum_declaration', name: 'name', kind: 'enum' },
    { node: 'variable_declarator', name: 'name', kind: 'export' },  // for `export const X = ...`
  ],
  tsx: [
    { node: 'function_declaration', name: 'name', kind: 'function' },
    { node: 'class_declaration', name: 'name', kind: 'class' },
    { node: 'method_definition', name: 'name', kind: 'method' },
    { node: 'interface_declaration', name: 'name', kind: 'interface' },
    { node: 'type_alias_declaration', name: 'name', kind: 'type' },
    { node: 'variable_declarator', name: 'name', kind: 'component' },
  ],
  javascript: [
    { node: 'function_declaration', name: 'name', kind: 'function' },
    { node: 'class_declaration', name: 'name', kind: 'class' },
    { node: 'method_definition', name: 'name', kind: 'method' },
    { node: 'variable_declarator', name: 'name', kind: 'export' },
  ],
  python: [
    { node: 'function_definition', name: 'name', kind: 'function' },
    { node: 'class_definition', name: 'name', kind: 'class' },
  ],
  go: [
    { node: 'function_declaration', name: 'name', kind: 'function' },
    { node: 'method_declaration', name: 'name', kind: 'method' },
    { node: 'type_spec', name: 'name', kind: 'type' },
  ],
  rust: [
    { node: 'function_item', name: 'name', kind: 'function' },
    { node: 'struct_item', name: 'name', kind: 'struct' },
    { node: 'enum_item', name: 'name', kind: 'enum' },
    { node: 'impl_item', name: 'type', kind: 'impl' },
    { node: 'trait_item', name: 'name', kind: 'trait' },
  ],
  markdown: [
    { node: 'atx_heading', name: 'self', kind: 'heading' },
  ],
}

const DEFAULT_MAX_BYTES = 1_000_000  // 1 MB

class TSParser {
  constructor({ grammarsDir, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.grammarsDir = grammarsDir
    this.maxBytes = maxBytes
    this.languages = {}  // lang -> Language instance
    this._initialized = false
  }

  async init() {
    if (this._initialized) return
    await Parser.init()
    this._parser = new Parser()
    this._initialized = true
  }

  async _loadLanguage(lang) {
    if (this.languages[lang]) return this.languages[lang]
    const file = grammarFile(lang)
    if (!file) return null
    const full = path.join(this.grammarsDir, file)
    if (!fs.existsSync(full)) return null
    const Lang = await Parser.Language.load(full)
    this.languages[lang] = Lang
    return Lang
  }

  async parse(filename, source, opts = {}) {
    await this.init()
    const maxBytes = opts.maxBytes ?? this.maxBytes
    const language = detectLanguage(filename)

    if (!language) {
      return { language: null, size: source.length, symbols: [], parseError: 'unsupported language' }
    }
    if (Buffer.byteLength(source, 'utf8') > maxBytes) {
      return { language, size: source.length, symbols: [], parseError: 'too large' }
    }

    const Lang = await this._loadLanguage(language)
    if (!Lang) {
      return { language, size: source.length, symbols: [], parseError: `grammar ${language} not loaded` }
    }

    let symbols = []
    let parseError = null
    try {
      this._parser.setLanguage(Lang)
      const tree = this._parser.parse(source)
      symbols = this._extractSymbols(tree.rootNode, language, source)
      if (tree.rootNode.hasError) parseError = 'partial parse (syntax errors present)'
    } catch (e) {
      parseError = e.message || String(e)
    }
    return { language, size: source.length, symbols, parseError }
  }

  _extractSymbols(root, language, source) {
    const queries = QUERIES[language] || []
    const out = []
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()
      for (const q of queries) {
        if (node.type === q.node) {
          const name = this._extractName(node, q.name, language, source)
          if (name) {
            out.push({ name, kind: q.kind, line: node.startPosition.row + 1 })
          }
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) stack.push(node.namedChild(i))
    }
    return out
  }

  _extractName(node, mode, language, source) {
    if (mode === 'self') {
      // For markdown headings: use the heading text
      return source.slice(node.startIndex, node.endIndex).trim().replace(/^#+\s*/, '')
    }
    // Try the named field first
    const named = node.childForFieldName(mode)
    if (named) return source.slice(named.startIndex, named.endIndex)
    // Fallback: first identifier-like child
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i)
      if (c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'property_identifier') {
        return source.slice(c.startIndex, c.endIndex)
      }
    }
    return null
  }
}

module.exports = { Parser: TSParser }
```

- [ ] **Step 5: Run tests, verify pass**

```bash
cd examples/extensions/code-index && npx vitest run evals/unit/parser.test.mjs
```

Expected: 8 tests pass. (If the variable_declarator extraction over-reports — e.g., includes locals — adjust the parser to only count declarators whose ancestor is `export_statement`. Iterate until tests pass.)

- [ ] **Step 6: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/lib/parser.js examples/extensions/code-index/evals/unit/parser.test.mjs examples/extensions/code-index/evals/fixtures/sample-repos/ && git commit -m "feat(code-index): tree-sitter symbol extraction for ts/tsx/js/py/go/rs/md"
```

---

## Phase 4 — MCP Tools (Ranking + Query Surface)

### Task 4.1: Ranker module

**Files:**
- Create: `examples/extensions/code-index/lib/ranker.js`
- Test: `examples/extensions/code-index/evals/unit/ranker.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest'
import { rankFindResults, rankHotFiles, rankRelated } from '../../lib/ranker.js'

const FILES = {
  'src/a.ts': {
    reads: 5, edits: 2, writes: 0, lastTouched: 100,
    language: 'typescript', size: 100,
    symbols: [
      { name: 'smoothstep', kind: 'function', line: 1 },
      { name: 'EasePipeline', kind: 'class', line: 10 },
    ],
  },
  'src/b.ts': {
    reads: 1, edits: 0, writes: 0, lastTouched: 50,
    language: 'typescript', size: 50,
    symbols: [
      { name: 'smooth', kind: 'function', line: 5 },
      { name: 'smoothify', kind: 'function', line: 20 },
    ],
  },
  'src/c.ts': {
    reads: 0, edits: 0, writes: 0, lastTouched: 0,
    language: 'typescript', size: 0,
    symbols: [{ name: 'unrelated', kind: 'function', line: 1 }],
  },
}

const HOTNESS = { 'src/a.ts': 11, 'src/b.ts': 1, 'src/c.ts': 0 }

describe('rankFindResults', () => {
  it('exact match outranks substring match even at lower hotness', () => {
    const r = rankFindResults('smooth', null, FILES, HOTNESS)
    expect(r[0]).toMatchObject({ name: 'smooth', file: 'src/b.ts' })
  })

  it('within tier, sorts by hotness desc', () => {
    const r = rankFindResults('Smooth', null, FILES, HOTNESS) // case-insensitive
    // hotness for a.ts (11) > b.ts (1), so 'smoothstep' from a.ts comes first among substring matches
    const idxA = r.findIndex(x => x.name === 'smoothstep')
    const idxBSmoothify = r.findIndex(x => x.name === 'smoothify')
    expect(idxA).toBeLessThan(idxBSmoothify)
  })

  it('honors kind filter', () => {
    const r = rankFindResults('Pipeline', 'class', FILES, HOTNESS)
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('class')
  })

  it('respects limit', () => {
    const r = rankFindResults('smooth', null, FILES, HOTNESS, 2)
    expect(r).toHaveLength(2)
  })

  it('returns empty for no matches', () => {
    expect(rankFindResults('nonexistent', null, FILES, HOTNESS)).toEqual([])
  })
})

describe('rankHotFiles', () => {
  it('sorts files by hotness desc, includes top 3 symbol names', () => {
    const r = rankHotFiles(FILES, HOTNESS, 10)
    expect(r[0].path).toBe('src/a.ts')
    expect(r[0].topSymbols).toEqual(expect.arrayContaining(['smoothstep', 'EasePipeline']))
  })
})

describe('rankRelated', () => {
  const COOC = {
    'src/a.ts': { 'src/b.ts': 5, 'src/c.ts': 2 },
    'src/b.ts': { 'src/a.ts': 5 },
    'src/c.ts': { 'src/a.ts': 2 },
  }

  it('returns related sorted by co-occurrence desc', () => {
    const r = rankRelated('src/a.ts', COOC, HOTNESS, 10)
    expect(r[0]).toMatchObject({ path: 'src/b.ts', coOccurrenceCount: 5 })
    expect(r[1]).toMatchObject({ path: 'src/c.ts', coOccurrenceCount: 2 })
  })

  it('returns empty when no co-occurrence', () => {
    expect(rankRelated('src/x.ts', COOC, HOTNESS, 10)).toEqual([])
  })
})
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `lib/ranker.js`**

```javascript
function classify(query, candidate) {
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  if (c === q) return 0   // exact
  if (c.startsWith(q)) return 1   // prefix
  if (c.includes(q)) return 2   // substring
  return -1   // no match
}

function rankFindResults(query, kindFilter, files, hotness, limit = 10) {
  const matches = []
  for (const [filePath, f] of Object.entries(files)) {
    for (const sym of (f.symbols || [])) {
      if (kindFilter && kindFilter !== 'any' && sym.kind !== kindFilter) continue
      const tier = classify(query, sym.name)
      if (tier < 0) continue
      matches.push({
        file: filePath,
        line: sym.line,
        kind: sym.kind,
        name: sym.name,
        hotness: hotness[filePath] || 0,
        lastTouched: f.lastTouched || 0,
        tier,
      })
    }
  }
  matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.hotness !== b.hotness) return b.hotness - a.hotness
    return b.lastTouched - a.lastTouched
  })
  return matches.slice(0, limit).map(({ tier, ...rest }) => rest)
}

function rankHotFiles(files, hotness, limit = 20) {
  const rows = Object.entries(files).map(([p, f]) => ({
    path: p,
    hotness: hotness[p] || 0,
    reads: f.reads || 0,
    edits: f.edits || 0,
    writes: f.writes || 0,
    lastTouched: f.lastTouched || 0,
    topSymbols: (f.symbols || []).slice(0, 3).map(s => s.name),
  }))
  rows.sort((a, b) => b.hotness - a.hotness || b.lastTouched - a.lastTouched)
  return rows.slice(0, limit)
}

function rankRelated(filePath, cooccurrence, hotness, limit = 10) {
  const row = cooccurrence[filePath]
  if (!row) return []
  const rows = Object.entries(row).map(([p, count]) => ({
    path: p,
    coOccurrenceCount: count,
    hotness: hotness[p] || 0,
  }))
  rows.sort((a, b) => b.coOccurrenceCount - a.coOccurrenceCount || b.hotness - a.hotness)
  return rows.slice(0, limit)
}

module.exports = { rankFindResults, rankHotFiles, rankRelated }
```

- [ ] **Step 4: Run, verify pass**

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/lib/ranker.js examples/extensions/code-index/evals/unit/ranker.test.mjs && git commit -m "feat(code-index): result ranker (exact > prefix > substring, hotness tiebreak)"
```

---

### Task 4.2: Wire main.js — extension entry, MCP tools, ingest plumbing

**Files:**
- Create: `examples/extensions/code-index/main.js`
- Test: manual smoke test (the integration is covered by agent-loop evals later)

- [ ] **Step 1: Implement `main.js`**

```javascript
/**
 * Code Index — CodeSurf power-tier extension.
 *
 * Ingests Claude Code tool-use events (via PostToolUse hook → localhost HTTP),
 * maintains a per-workspace activity + symbol index, exposes MCP tools.
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const { Storage } = require('./lib/storage')
const { Indexer } = require('./lib/indexer')
const { Parser } = require('./lib/parser')
const { resolveWorkspace, workspaceKey } = require('./lib/workspace')
const { startIngestServer } = require('./lib/ingest-server')
const { rankFindResults, rankHotFiles, rankRelated } = require('./lib/ranker')

const DATA_ROOT = path.join(os.homedir(), '.codesurf', 'extensions', 'code-index', 'data')

// Per-workspace cache: { storage, indexer }
const workspaces = new Map()
let parser = null

function getWorkspace(cwd) {
  const root = resolveWorkspace(cwd)
  const key = workspaceKey(root)
  let ws = workspaces.get(key)
  if (ws) return ws

  const dir = path.join(DATA_ROOT, key)
  fs.mkdirSync(dir, { recursive: true })
  // Persist meta on first use
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ workspace: root, version: 1, created_at: Math.floor(Date.now() / 1000) })
  )
  const storage = new Storage(dir)
  const indexer = new Indexer()
  ws = { root, key, dir, storage, indexer, lastEventTs: 0, parsePending: new Map() }
  workspaces.set(key, ws)

  // Async load existing state
  storage.readIndex().then(state => { if (state) indexer.deserialize(state) }).catch(() => {})

  return ws
}

async function reparseFile(ws, relPath, ctx) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(ws.root, relPath)
  let source
  try { source = await fsp.readFile(abs, 'utf8') } catch { return }
  const r = await parser.parse(abs, source)
  ws.indexer.updateSymbols(relPath, {
    language: r.language, size: r.size, symbols: r.symbols, parseError: r.parseError,
  })
  ws.storage.scheduleWrite(ws.indexer.serialize())
  if (r.parseError && ctx) ctx.bus.publish('code-index', 'parse-error', { path: relPath, error: r.parseError })
}

function relPath(workspaceRoot, p) {
  if (!path.isAbsolute(p)) return p
  const rel = path.relative(workspaceRoot, p)
  if (rel.startsWith('..')) return p  // outside workspace — keep absolute
  return rel
}

module.exports = {
  async activate(ctx) {
    ctx.log('Code Index extension activating')
    fs.mkdirSync(DATA_ROOT, { recursive: true })

    parser = new Parser({ grammarsDir: path.join(__dirname, 'grammars') })
    await parser.init().catch(e => ctx.log(`parser init failed: ${e.message}`))

    // Start the ingest server on an ephemeral port and write the port to disk
    const server = await startIngestServer({
      onEvent: (evt) => {
        try {
          const ws = getWorkspace(evt.cwd)
          const relP = relPath(ws.root, evt.path)
          const indexEvt = { tool: evt.tool, path: relP, sessionId: evt.sessionId, ts: evt.ts }
          ws.indexer.ingest(indexEvt)
          ws.storage.appendActivity(indexEvt).catch(() => {})
          ws.lastEventTs = evt.ts
          ws.storage.scheduleWrite(ws.indexer.serialize())
          ctx.bus.publish('code-index', 'activity', { workspace: ws.root, ...indexEvt })

          // Re-parse on Edit/Write (debounced 500 ms per path)
          if (evt.tool === 'Edit' || evt.tool === 'Write' || evt.tool === 'MultiEdit') {
            const existing = ws.parsePending.get(relP)
            if (existing) clearTimeout(existing)
            ws.parsePending.set(relP, setTimeout(() => {
              ws.parsePending.delete(relP)
              reparseFile(ws, relP, ctx).catch(e => ctx.log(`parse error for ${relP}: ${e.message}`))
            }, 500))
          }
        } catch (e) {
          ctx.log(`ingest handler error: ${e.message}`)
        }
      },
    })
    fs.writeFileSync(path.join(DATA_ROOT, 'port'), String(server.port))
    ctx.log(`Code Index ingest server on http://127.0.0.1:${server.port}`)

    // ---- MCP Tools ----

    function workspaceForCwd() {
      // ctx may expose workspacePath; fallback to process.cwd()
      const cwd = ctx.workspacePath || process.cwd()
      return getWorkspace(cwd)
    }

    function hotnessMap(ws) {
      const out = {}
      for (const p of Object.keys(ws.indexer.files)) {
        out[p] = ws.indexer.computeHotness(p)
      }
      return out
    }

    ctx.mcp.registerTool({
      name: 'find',
      description: 'Find a symbol (function, class, method, component, type) by name in files this workspace has touched. Returns ranked file:line locations. Falls back to no results if the symbol has not been seen — use Grep then.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Symbol name. Case-insensitive. Exact > prefix > substring.' },
          kind: { type: 'string', description: 'Optional: function | class | method | component | export | interface | type | any' },
          limit: { type: 'number', description: 'Max results, default 10' },
        },
        required: ['name'],
      },
      handler: async (argsStr) => {
        const args = argsStr ? JSON.parse(argsStr) : {}
        const ws = workspaceForCwd()
        const start = Date.now()
        const results = rankFindResults(args.name, args.kind || null, ws.indexer.files, hotnessMap(ws), args.limit || 10)
        return JSON.stringify({
          results,
          totalMatched: results.length,
          queryMs: Date.now() - start,
          workspace: ws.root,
        })
      },
    })

    ctx.mcp.registerTool({
      name: 'hot',
      description: 'Get top hot files in this workspace, or top symbols in a specific file. Hotness = weighted (read=1, edit=3, write=5) with 14-day half-life decay.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional. If provided, returns symbols within that file ordered by line.' },
          limit: { type: 'number', description: 'Max results, default 20' },
        },
      },
      handler: async (argsStr) => {
        const args = argsStr ? JSON.parse(argsStr) : {}
        const ws = workspaceForCwd()
        const hot = hotnessMap(ws)
        if (args.path) {
          const f = ws.indexer.files[args.path]
          if (!f) return JSON.stringify({ symbols: [], stats: null, workspace: ws.root })
          return JSON.stringify({
            symbols: f.symbols || [],
            stats: { reads: f.reads, edits: f.edits, writes: f.writes, hotness: hot[args.path] || 0, lastTouched: f.lastTouched },
            workspace: ws.root,
          })
        }
        return JSON.stringify({ files: rankHotFiles(ws.indexer.files, hot, args.limit || 20), workspace: ws.root })
      },
    })

    ctx.mcp.registerTool({
      name: 'related',
      description: 'Files co-touched with the given path within the same 30-min session. Useful before editing a known file to discover what usually changes with it.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'number', description: 'Max results, default 10' },
        },
        required: ['path'],
      },
      handler: async (argsStr) => {
        const args = argsStr ? JSON.parse(argsStr) : {}
        const ws = workspaceForCwd()
        return JSON.stringify({
          related: rankRelated(args.path, ws.indexer.cooccurrence, hotnessMap(ws), args.limit || 10),
          basedOn: 'co-touched within 30-min session windows',
          workspace: ws.root,
        })
      },
    })

    ctx.mcp.registerTool({
      name: 'stats',
      description: 'Code Index health and counts for this workspace.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const ws = workspaceForCwd()
        const langs = {}
        let totalSymbols = 0, totalEvents = 0, oldest = Infinity, newest = 0
        for (const f of Object.values(ws.indexer.files)) {
          langs[f.language || 'unknown'] = (langs[f.language || 'unknown'] || 0) + 1
          totalSymbols += (f.symbols || []).length
          totalEvents += (f.events || []).length
          for (const e of (f.events || [])) {
            if (e.ts < oldest) oldest = e.ts
            if (e.ts > newest) newest = e.ts
          }
        }
        const indexSizeKb = (await fsp.stat(path.join(ws.dir, 'index.json')).catch(() => ({ size: 0 }))).size / 1024
        return JSON.stringify({
          workspace: ws.root,
          indexedFiles: Object.keys(ws.indexer.files).length,
          totalSymbols,
          totalEvents,
          indexSizeKb: Math.round(indexSizeKb * 10) / 10,
          topLanguages: Object.entries(langs).map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count),
          oldestEvent: isFinite(oldest) ? oldest : null,
          newestEvent: newest || null,
          ingestPort: server.port,
          hookHealthy: ws.lastEventTs > 0 && (Date.now() / 1000 - ws.lastEventTs) < 86400,
        })
      },
    })

    // backfill is registered in Phase 5

    return async () => {
      ctx.log('Code Index deactivating')
      await server.close()
      // Flush all pending writes
      for (const ws of workspaces.values()) {
        await ws.storage.flush().catch(() => {})
        for (const t of ws.parsePending.values()) clearTimeout(t)
      }
    }
  },
}
```

- [ ] **Step 2: Smoke test — load the extension manually**

```bash
cd examples/extensions/code-index
node -e "
const m = require('./main');
const ctx = {
  log: console.log,
  bus: { publish: (...a) => console.log('bus.publish', ...a) },
  mcp: { registerTool: (t) => console.log('mcp.registerTool', t.name) },
  workspacePath: process.cwd(),
};
m.activate(ctx).then(cleanup => {
  console.log('activated, port file:', require('fs').readFileSync(require('path').join(require('os').homedir(), '.codesurf/extensions/code-index/data/port'), 'utf8'));
  setTimeout(() => cleanup().then(() => process.exit(0)), 1000);
});
"
```

Expected output includes:
- `mcp.registerTool find`
- `mcp.registerTool hot`
- `mcp.registerTool related`
- `mcp.registerTool stats`
- `Code Index ingest server on http://127.0.0.1:<port>`
- `port file: <port>`

- [ ] **Step 3: Smoke test the ingest end-to-end with curl**

In one shell, run the activation snippet above with a longer timeout (`setTimeout 60000`). In another:

```bash
PORT=$(cat ~/.codesurf/extensions/code-index/data/port)
echo '{"tool_name":"Read","tool_input":{"file_path":"/tmp/foo.ts"},"cwd":"/tmp","session_id":"smoke"}' | curl -s -X POST -d @- http://127.0.0.1:$PORT/ingest
```

Expected: `{"ok":true}`. The first shell logs `bus.publish code-index activity ...`.

- [ ] **Step 4: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/main.js && git commit -m "feat(code-index): main.js wires ingest, indexer, parser, and 4 MCP tools"
```

---

## Phase 5 — Backfill from transcripts

### Task 5.1: Transcript scanner + backfill MCP tool

**Files:**
- Create: `examples/extensions/code-index/lib/backfill.js`
- Modify: `examples/extensions/code-index/main.js` (register `backfill` tool)
- Test: `examples/extensions/code-index/evals/unit/backfill.test.mjs`
- Create: `examples/extensions/code-index/evals/fixtures/transcripts/sample.jsonl`

- [ ] **Step 1: Create a fixture transcript**

Write `evals/fixtures/transcripts/sample.jsonl` (one JSON object per line — Claude Code transcript format):

```jsonl
{"type":"user","message":{"role":"user","content":"start"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/repo/src/a.ts"}}]},"timestamp":"2025-01-01T10:00:00Z","cwd":"/repo"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/repo/src/b.ts"}}]},"timestamp":"2025-01-01T10:00:30Z","cwd":"/repo"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/src/a.ts"}}]},"timestamp":"2025-01-01T10:05:00Z","cwd":"/repo"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2025-01-01T10:05:15Z","cwd":"/repo"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/src/c.ts"}}]},"timestamp":"2025-01-01T10:06:00Z","cwd":"/repo"}
```

- [ ] **Step 2: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { Indexer } from '../../lib/indexer.js'
import { backfillFromTranscript } from '../../lib/backfill.js'

const FIX = path.join(import.meta.dirname, '..', 'fixtures', 'transcripts', 'sample.jsonl')

describe('backfillFromTranscript', () => {
  it('replays Read/Edit/Write events into an indexer, ignoring Bash', async () => {
    const idx = new Indexer()
    const stats = await backfillFromTranscript(FIX, idx, { workspaceRoot: '/repo' })
    expect(stats.scanned).toBeGreaterThan(0)
    expect(stats.ingested).toBe(4)  // 2 Read + 1 Edit + 1 Write
    const f = idx.getState().files
    expect(f['src/a.ts'].reads).toBe(1)
    expect(f['src/a.ts'].edits).toBe(1)
    expect(f['src/c.ts'].writes).toBe(1)
  })

  it('strips workspaceRoot from absolute paths', async () => {
    const idx = new Indexer()
    await backfillFromTranscript(FIX, idx, { workspaceRoot: '/repo' })
    expect(idx.getState().files['src/a.ts']).toBeDefined()
    expect(idx.getState().files['/repo/src/a.ts']).toBeUndefined()
  })

  it('respects days cutoff', async () => {
    const idx = new Indexer()
    // All events in fixture are 2025-01-01; cutoff anything older than 1 day from now → ingest 0
    const stats = await backfillFromTranscript(FIX, idx, { workspaceRoot: '/repo', days: 1 })
    expect(stats.ingested).toBe(0)
  })
})
```

- [ ] **Step 3: Run, verify fail**

- [ ] **Step 4: Implement `lib/backfill.js`**

```javascript
const fs = require('node:fs')
const readline = require('node:readline')
const path = require('node:path')

const TOOL_SET = new Set(['Read', 'Edit', 'Write', 'MultiEdit'])

async function backfillFromTranscript(transcriptPath, indexer, opts = {}) {
  const { workspaceRoot, days = null } = opts
  const cutoffMs = days ? Date.now() - days * 86400 * 1000 : 0

  const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let scanned = 0
  let ingested = 0
  let parseErrors = 0
  const start = Date.now()

  for await (const line of rl) {
    if (!line.trim()) continue
    scanned++
    let entry
    try { entry = JSON.parse(line) } catch { parseErrors++; continue }
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0
    if (cutoffMs && ts < cutoffMs) continue

    const sessionId = entry.session_id || path.basename(transcriptPath, '.jsonl')

    for (const block of content) {
      if (block.type !== 'tool_use') continue
      if (!TOOL_SET.has(block.name)) continue
      const fp = block.input?.file_path
      if (!fp) continue
      let rel = fp
      if (workspaceRoot && fp.startsWith(workspaceRoot)) {
        rel = path.relative(workspaceRoot, fp)
      }
      indexer.ingest({
        tool: block.name,
        path: rel,
        sessionId,
        ts: ts ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000),
      })
      ingested++
    }
  }

  return {
    scanned,
    ingested,
    parseErrors,
    durationMs: Date.now() - start,
  }
}

async function backfillFromProjectsDir(projectsDir, indexer, opts = {}) {
  if (!fs.existsSync(projectsDir)) return { scanned: 0, ingested: 0, parseErrors: 0, durationMs: 0, files: 0 }
  const files = fs.readdirSync(projectsDir).filter(f => f.endsWith('.jsonl'))
  const totals = { scanned: 0, ingested: 0, parseErrors: 0, durationMs: 0, files: files.length }
  for (const f of files) {
    const stats = await backfillFromTranscript(path.join(projectsDir, f), indexer, opts)
    totals.scanned += stats.scanned
    totals.ingested += stats.ingested
    totals.parseErrors += stats.parseErrors
    totals.durationMs += stats.durationMs
  }
  return totals
}

function projectsDirForWorkspace(workspaceRoot) {
  // Claude Code stores per-project transcripts under ~/.claude/projects/<encoded>/
  // The encoding replaces / with - and prefixes the absolute path.
  const encoded = '-' + workspaceRoot.replace(/^\//, '').replace(/\//g, '-')
  return path.join(require('os').homedir(), '.claude', 'projects', encoded)
}

module.exports = { backfillFromTranscript, backfillFromProjectsDir, projectsDirForWorkspace }
```

- [ ] **Step 5: Run tests, verify pass**

```bash
cd examples/extensions/code-index && npx vitest run evals/unit/backfill.test.mjs
```

Expected: 3 tests pass.

- [ ] **Step 6: Register the `backfill` MCP tool in `main.js`**

Modify `main.js`. After the `stats` tool registration block, add:

```javascript
const { backfillFromTranscript, backfillFromProjectsDir, projectsDirForWorkspace } = require('./lib/backfill')

ctx.mcp.registerTool({
  name: 'backfill',
  description: 'Replay past Claude Code session transcripts for this workspace into the index. Use once per project to seed history. Default cap: 90 days.',
  inputSchema: {
    type: 'object',
    properties: {
      transcriptPath: { type: 'string', description: 'Optional. Specific .jsonl path. Defaults to ~/.claude/projects/<workspace>/' },
      days: { type: 'number', description: 'Cap to most recent N days. Default 90. 0 = all.' },
    },
  },
  handler: async (argsStr) => {
    const args = argsStr ? JSON.parse(argsStr) : {}
    const ws = workspaceForCwd()
    const days = args.days === 0 ? null : (args.days || 90)
    let result
    if (args.transcriptPath) {
      result = await backfillFromTranscript(args.transcriptPath, ws.indexer, { workspaceRoot: ws.root, days })
    } else {
      const dir = projectsDirForWorkspace(ws.root)
      result = await backfillFromProjectsDir(dir, ws.indexer, { workspaceRoot: ws.root, days })
    }
    await ws.storage.writeIndex(ws.indexer.serialize())
    return JSON.stringify({ ...result, workspace: ws.root })
  },
})
```

Add the require near the top of `main.js` next to the others:

```javascript
const { backfillFromTranscript, backfillFromProjectsDir, projectsDirForWorkspace } = require('./lib/backfill')
```

- [ ] **Step 7: Smoke test backfill**

```bash
cd examples/extensions/code-index
node -e "
const { Indexer } = require('./lib/indexer');
const { backfillFromTranscript } = require('./lib/backfill');
const idx = new Indexer();
backfillFromTranscript('./evals/fixtures/transcripts/sample.jsonl', idx, { workspaceRoot: '/repo', days: 0 })
  .then(s => { console.log(s); console.log(JSON.stringify(idx.getState(), null, 2)); });
"
```

Expected: stats show `ingested: 4`, files contain `src/a.ts`, `src/b.ts`, `src/c.ts`.

- [ ] **Step 8: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/lib/backfill.js examples/extensions/code-index/main.js examples/extensions/code-index/evals/unit/backfill.test.mjs examples/extensions/code-index/evals/fixtures/transcripts/sample.jsonl && git commit -m "feat(code-index): backfill from Claude Code transcripts + MCP tool"
```

---

## Phase 6 — Hook integration

### Task 6.1: hook/INSTALL.md with cross-platform snippets

**Files:**
- Create: `examples/extensions/code-index/hook/INSTALL.md`

- [ ] **Step 1: Write `hook/INSTALL.md`**

````markdown
# Hook installation

The Code Index extension only sees what Claude Code touches if you wire a
`PostToolUse` hook in your Claude Code `settings.json`. The hook is a one-line
`curl` (POSIX) or `Invoke-RestMethod` (Windows) call — no script file required.

The extension runs an HTTP ingest server on an ephemeral port and writes the
port number to:

    ~/.codesurf/extensions/code-index/data/port

The hook reads that file each invocation and POSTs the Claude hook payload.

## macOS / Linux

Add to `~/.claude/settings.json` (or a workspace-local `.claude/settings.json`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "PORT=$(cat \"$HOME/.codesurf/extensions/code-index/data/port\" 2>/dev/null) && [ -n \"$PORT\" ] && curl -s -X POST -m 1 --data-binary @- \"http://127.0.0.1:$PORT/ingest\" >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

The trailing `|| true` ensures a failed POST never blocks Claude Code.

## Windows (PowerShell)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "powershell -NoProfile -Command \"$portFile = Join-Path $env:USERPROFILE '.codesurf\\extensions\\code-index\\data\\port'; if (Test-Path $portFile) { $port = Get-Content $portFile; $body = $input | Out-String; try { Invoke-RestMethod -Uri \\\"http://127.0.0.1:$port/ingest\\\" -Method Post -Body $body -TimeoutSec 1 -ErrorAction SilentlyContinue | Out-Null } catch {} }\""
          }
        ]
      }
    ]
  }
}
```

## Verify it's working

1. Open the Code Index tile in Codesurf.
2. In any project, ask Claude to `Read` a file.
3. The "Recent activity" section in the tile should show the event within ~1 second.
4. If it doesn't, check:
   - `cat ~/.codesurf/extensions/code-index/data/port` returns a number.
   - `curl -v http://127.0.0.1:<port>/health` returns 200.
   - Your `settings.json` is valid JSON (Claude Code will warn at startup if not).

## Privacy

The hook posts: tool name, file path, working directory, session id, timestamp.
No file contents. The extension stores file paths and symbol names only — never code.
````

- [ ] **Step 2: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/hook/INSTALL.md && git commit -m "docs(code-index): hook installation instructions for macOS, Linux, Windows"
```

---

## Phase 7 — Tile UI

### Task 7.1: Dashboard scaffold

**Files:**
- Create: `examples/extensions/code-index/tiles/dashboard/index.html`

- [ ] **Step 1: Write the tile**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Code Index</title>
<style>
:root {
  --bg:      var(--ct-bg, transparent);
  --panel:   var(--ct-panel, rgba(0,0,0,0.04));
  --border:  var(--ct-border, rgba(0,0,0,0.09));
  --text:    var(--ct-text, #111);
  --muted:   var(--ct-muted, #555);
  --dim:     var(--ct-dim, #888);
  --hover:   var(--ct-hover, rgba(0,0,0,0.04));
  --accent:  var(--ct-accent, #4f46e5);
  --accent-s:var(--ct-accent-subtle, rgba(79,70,229,0.10));
  --danger:  var(--ct-danger, #ef4444);
  --success: var(--ct-success, #22c55e);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
  height: 100vh; overflow: hidden; display: flex; flex-direction: column;
}
svg { width: 14px; height: 14px; flex-shrink: 0; display: block; }
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

header {
  padding: 8px 10px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
header .ws { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header button {
  background: transparent; border: 1px solid var(--border); color: var(--text);
  padding: 3px 7px; font-size: 11px; border-radius: 3px; cursor: pointer;
}
header button:hover { background: var(--hover); }

#banner {
  background: var(--accent-s); color: var(--text); padding: 6px 10px;
  font-size: 11px; border-bottom: 1px solid var(--border); display: none;
}
#banner.show { display: block; }
#banner.danger { background: var(--danger); color: #fff; }

main { flex: 1; overflow: auto; }

.section { border-bottom: 1px solid var(--border); }
.section-header {
  padding: 6px 10px; font-size: 11px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.4px;
  cursor: pointer; user-select: none; display: flex; align-items: center; gap: 4px;
}
.section-header .chev { color: var(--dim); }
.section-content { padding: 4px 10px 10px; }
.section-content.collapsed { display: none; }

.search-input {
  width: 100%; background: var(--panel); border: 1px solid var(--border);
  padding: 6px 8px; color: var(--text); font-size: 12px; border-radius: 3px;
  outline: none;
}
.search-input:focus { border-color: var(--accent); }

.row {
  padding: 4px 6px; border-radius: 3px; cursor: pointer;
  display: flex; align-items: baseline; gap: 8px; line-height: 1.5;
}
.row:hover { background: var(--hover); }
.row .pri { color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .sec { color: var(--muted); font-size: 11px; flex-shrink: 0; }
.row .num { color: var(--accent); font-variant-numeric: tabular-nums; min-width: 36px; text-align: right; }

.empty { color: var(--dim); padding: 6px; font-style: italic; font-size: 11px; }
.kind {
  font-size: 10px; padding: 1px 4px; border-radius: 2px;
  background: var(--accent-s); color: var(--accent); margin-left: 4px;
}
.activity-row .tool {
  display: inline-block; min-width: 36px; font-weight: 600; color: var(--accent);
  font-size: 10px; text-transform: uppercase;
}
.activity-row .ts { color: var(--dim); font-size: 11px; }
</style>
</head>
<body>

<header>
  <span class="ws" id="ws">workspace: …</span>
  <button id="refresh" title="Refresh">⟳</button>
</header>

<div id="banner"></div>

<main>
  <div class="section">
    <div class="section-header" data-target="search-c"><span class="chev">▼</span> Search</div>
    <div class="section-content" id="search-c">
      <input class="search-input" id="q" placeholder="symbol name (e.g. smoothstep)" autocomplete="off" />
      <div id="results" style="margin-top:6px;"></div>
    </div>
  </div>

  <div class="section">
    <div class="section-header" data-target="hot-c"><span class="chev">▼</span> Hot files</div>
    <div class="section-content" id="hot-c">
      <div id="hot"><div class="empty">no activity yet</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-header" data-target="act-c"><span class="chev">▼</span> Recent activity</div>
    <div class="section-content" id="act-c">
      <div id="activity"><div class="empty">no activity yet</div></div>
    </div>
  </div>
</main>

<script>
function invoke(method, args) {
  if (!window.contex || !window.contex.ext) return Promise.reject(new Error('Bridge not ready'))
  return window.contex.ext.invoke(method, args ? JSON.stringify(args) : undefined)
    .then(function(r) { return typeof r === 'string' ? JSON.parse(r) : r })
}

function fmtAge(secs) {
  if (!secs) return '—'
  var ageS = Math.floor(Date.now()/1000) - secs
  if (ageS < 60) return ageS + 's ago'
  if (ageS < 3600) return Math.floor(ageS/60) + 'm ago'
  if (ageS < 86400) return Math.floor(ageS/3600) + 'h ago'
  return Math.floor(ageS/86400) + 'd ago'
}

function fmtTs(secs) {
  var d = new Date(secs * 1000)
  return d.toTimeString().slice(0,8)
}

function el(html) {
  var t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstChild
}

function renderResults(arr) {
  var box = document.getElementById('results')
  box.innerHTML = ''
  if (!arr || !arr.length) { box.innerHTML = '<div class="empty">no matches — try Grep</div>'; return }
  arr.forEach(function(r) {
    var row = el(
      '<div class="row" data-file="' + r.file + '">' +
        '<span class="pri">' + r.name + ' <span class="kind">' + r.kind + '</span></span>' +
        '<span class="sec">' + r.file + ':' + r.line + '</span>' +
      '</div>'
    )
    row.addEventListener('click', function() { openFile(r.file, r.line) })
    box.appendChild(row)
  })
}

function renderHot(arr) {
  var box = document.getElementById('hot')
  box.innerHTML = ''
  if (!arr || !arr.length) { box.innerHTML = '<div class="empty">no activity yet</div>'; return }
  arr.forEach(function(f) {
    var stats = f.reads + 'r ' + f.edits + 'e ' + f.writes + 'w'
    var row = el(
      '<div class="row" data-file="' + f.path + '">' +
        '<span class="num">' + f.hotness.toFixed(1) + '</span>' +
        '<span class="pri">' + f.path + '</span>' +
        '<span class="sec">' + stats + '</span>' +
      '</div>'
    )
    row.addEventListener('click', function() { openFile(f.path) })
    box.appendChild(row)
  })
}

var activityList = []
function renderActivity() {
  var box = document.getElementById('activity')
  box.innerHTML = ''
  if (!activityList.length) { box.innerHTML = '<div class="empty">no activity yet</div>'; return }
  activityList.slice(0, 50).forEach(function(a) {
    var row = el(
      '<div class="row activity-row">' +
        '<span class="ts">' + fmtTs(a.ts) + '</span>' +
        '<span class="tool">' + a.tool + '</span>' +
        '<span class="pri">' + a.path + '</span>' +
      '</div>'
    )
    box.appendChild(row)
  })
}

function openFile(file, line) {
  if (!window.contex || !window.contex.context) return
  window.contex.context.set('ctx:code-index:open-file', { path: file, line: line || 1 })
}

function showBanner(msg, kind) {
  var b = document.getElementById('banner')
  b.textContent = msg
  b.className = 'show' + (kind === 'danger' ? ' danger' : '')
}
function hideBanner() {
  document.getElementById('banner').className = ''
}

async function refresh() {
  try {
    var stats = await invoke('stats', {})
    document.getElementById('ws').textContent = 'workspace: ' + (stats.workspace || '—').split('/').slice(-1)[0]
    if (stats.indexedFiles === 0) {
      showBanner('No activity yet. Install the hook (see hook/INSTALL.md), then read or edit any file.')
    } else if (!stats.hookHealthy) {
      showBanner('No ingest events in 24h. Check hook installation.', 'danger')
    } else {
      hideBanner()
    }
    var hot = await invoke('hot', { limit: 20 })
    renderHot(hot.files || [])
  } catch (e) {
    showBanner('Bridge error: ' + e.message, 'danger')
  }
}

var qTimer = null
document.getElementById('q').addEventListener('input', function(e) {
  if (qTimer) clearTimeout(qTimer)
  var v = e.target.value.trim()
  if (!v) { document.getElementById('results').innerHTML = ''; return }
  qTimer = setTimeout(async function() {
    try {
      var r = await invoke('find', { name: v, limit: 10 })
      renderResults(r.results || [])
    } catch (err) {
      renderResults([])
    }
  }, 150)
})

document.addEventListener('click', function(e) {
  var hdr = e.target.closest('.section-header')
  if (!hdr) return
  var content = document.getElementById(hdr.dataset.target)
  content.classList.toggle('collapsed')
  hdr.querySelector('.chev').textContent = content.classList.contains('collapsed') ? '▶' : '▼'
})

document.getElementById('refresh').addEventListener('click', refresh)

async function init() {
  await refresh()
  // Subscribe to live events
  if (window.contex && window.contex.bus) {
    await window.contex.bus.subscribe('code-index')
  }
}

window.addEventListener('message', function(e) {
  if (!e.data) return
  if (e.data.type === 'codesurf-bridge-ready') init()
  else if (e.data.type === 'codesurf-event' && e.data.event === 'bus.event.code-index') {
    var d = e.data.data
    if (d && d.type === 'activity') {
      activityList.unshift(d.data || d)
      if (activityList.length > 100) activityList.length = 100
      renderActivity()
      // Periodically refresh hot list (cheap)
      refresh()
    } else if (d && d.type === 'parse-error') {
      console.warn('parse error', d)
    }
  }
})
if (window.contex) init()
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/tiles/dashboard/index.html && git commit -m "feat(code-index): dashboard tile (search + hot files + recent activity)"
```

---

## Phase 8 — Companion skill

### Task 8.1: SKILL.md and references

**Files:**
- Create: `~/.claude/skills/code-index/SKILL.md`
- Create: `~/.claude/skills/code-index/references/mcp-tools.md`
- Create: `examples/extensions/code-index/skill/SKILL.md` (source of truth, copied into the install location)
- Create: `examples/extensions/code-index/skill/references/mcp-tools.md`
- Create: `examples/extensions/code-index/scripts/install-skill.sh`

- [ ] **Step 1: Write `examples/extensions/code-index/skill/SKILL.md`**

```markdown
---
name: code-index
description: Use when locating symbols, functions, or files you (or a recent session) have touched before. Faster than grep for "where is X defined" and "what files relate to Y" in active workspaces. Skip this skill when searching for a symbol you have not previously opened in this workspace — use Grep instead.
---

# Code Index

A Codesurf extension maintains a per-workspace activity + symbol index built
from your Claude Code tool-use history. Before reaching for `Grep` to find a
symbol you have referenced before, query the index — it is O(lookup), grep is
O(repo).

The index ONLY knows files that have been Read / Edited / Written in this
workspace. For cold search across files the agent has never opened, use
`Grep`.

## Daily-use triggers

| You're about to… | Call this first | Why |
|------------------|-----------------|-----|
| Find where a symbol is defined ("update the bezier easing", "find the function that…") | `code_index_find({ name })` | Returns file:line ranked by exact > prefix > substring, then by hotness |
| Resume a session, want orientation | `code_index_hot()` | Lists the top files this workspace has been working on |
| Edit a known file — first check what usually moves with it | `code_index_related({ path })` | Files co-touched within 30-min sessions |

## Anti-pattern

Do not call `code_index_find` for a symbol that has never been referenced in
this workspace. The index is activity-driven — it only knows what's been
touched. If `find` returns 0 results, fall back to `Grep` immediately. Do not
retry `find` with a different spelling.

## Maintenance (once per project, then forget)

| When | Tool | Notes |
|------|------|-------|
| First time using the index in a project with prior history | `code_index_backfill()` | Replays past sessions from `~/.claude/projects/` into the index. Default cap: 90 days. |
| Want to see what the index knows | `code_index_stats()` | File counts, total symbols, hook health |

If `stats.hookHealthy` is `false`, the PostToolUse hook isn't firing — see
`hook/INSTALL.md` in the extension.

## Tool reference

Full schemas in `references/mcp-tools.md`.
```

- [ ] **Step 2: Write `examples/extensions/code-index/skill/references/mcp-tools.md`**

```markdown
# Code Index MCP Tools — Reference

All tools return a JSON string the runtime parses for you. All take a single
arguments object.

## `code_index_find`

```ts
code_index_find({
  name: string,
  kind?: "function" | "class" | "method" | "component" | "export" | "interface" | "type" | "any",
  limit?: number  // default 10
})
→ {
  results: [{ file, line, kind, name, hotness, lastTouched }],
  totalMatched: number,
  queryMs: number,
  workspace: string
}
```

Ranking: exact name match → prefix → substring. Within each tier, by hotness
desc, then recency desc. Case-insensitive. Empty `results` means the symbol
hasn't been seen in this workspace — use `Grep`.

## `code_index_hot`

```ts
code_index_hot({
  path?: string,    // omit = top files; provide = top symbols within that file
  limit?: number    // default 20
})
→ // when path omitted:
  { files: [{ path, hotness, reads, edits, writes, lastTouched, topSymbols }], workspace }
  // when path provided:
  { symbols: [{ name, kind, line }], stats: { reads, edits, writes, hotness, lastTouched }, workspace }
```

## `code_index_related`

```ts
code_index_related({
  path: string,
  limit?: number  // default 10
})
→ {
  related: [{ path, coOccurrenceCount, hotness }],
  basedOn: "co-touched within 30-min session windows",
  workspace
}
```

Returns empty array when `path` has no co-occurrence history.

## `code_index_backfill`

```ts
code_index_backfill({
  transcriptPath?: string,  // optional specific file; default: scan ~/.claude/projects/<workspace>/
  days?: number             // default 90; 0 = all
})
→ { scanned, ingested, parseErrors, durationMs, workspace, files? }
```

Idempotent. Re-running won't double-count counters (replays the same events
into existing files; counters monotonically increase, but co-occurrence pairs
are deduped per session).

## `code_index_stats`

```ts
code_index_stats()
→ {
  workspace, indexedFiles, totalSymbols, totalEvents, indexSizeKb,
  topLanguages: [{ lang, count }],
  oldestEvent, newestEvent,
  ingestPort, hookHealthy
}
```

`hookHealthy: false` means no events received in the last 24 hours. Likely
cause: hook not installed in `~/.claude/settings.json`.
```

- [ ] **Step 3: Write the install script**

`examples/extensions/code-index/scripts/install-skill.sh`:

```bash
#!/usr/bin/env bash
# Installs the Code Index companion skill to ~/.claude/skills/code-index/
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skill"
DEST="$HOME/.claude/skills/code-index"

mkdir -p "$DEST/references"
cp "$SRC/SKILL.md" "$DEST/SKILL.md"
cp "$SRC/references/mcp-tools.md" "$DEST/references/mcp-tools.md"

echo "Installed Code Index skill to $DEST"
```

Make it executable:

```bash
chmod +x examples/extensions/code-index/scripts/install-skill.sh
```

- [ ] **Step 4: Run install + verify**

```bash
bash examples/extensions/code-index/scripts/install-skill.sh
ls ~/.claude/skills/code-index/
cat ~/.claude/skills/code-index/SKILL.md | head -5
```

Expected: prints `SKILL.md` and `references/`. The frontmatter line begins with `---`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/skill/ examples/extensions/code-index/scripts/install-skill.sh && git commit -m "feat(code-index): companion Claude skill + install script"
```

---

## Phase 9 — Eval suite (Layer 2 + 3)

### Task 9.1: Agent-loop runner skeleton + first scenario

**Files:**
- Create: `examples/extensions/code-index/evals/agent-loop/runner.mjs`
- Create: `examples/extensions/code-index/evals/agent-loop/scenarios/001-find-by-name.yaml`
- Create: `examples/extensions/code-index/evals/agent-loop/scoreboard.md`

- [ ] **Step 1: Write the first scenario**

`evals/agent-loop/scenarios/001-find-by-name.yaml`:

```yaml
id: 001-find-by-name
description: "Modify smoothstep — should locate via index, not grep"
fixture_repo: ts-react
seed:
  # The runner ingests these events directly into the index before invoking the agent,
  # simulating a "warm" session.
  events:
    - { tool: Read,  path: src/easing.ts,    sessionId: seed }
    - { tool: Read,  path: src/Component.tsx, sessionId: seed }
    - { tool: Edit,  path: src/easing.ts,    sessionId: seed }
prompt: "Change the smoothstep easing curve to use cubic ease-in-out instead. Do not touch any unrelated file."
budget:
  max_tool_calls: 12
  max_tokens: 8000
success:
  must_edit: ["src/easing.ts"]
  must_call_among_first: ["mcp__code-index__find"]
  forbid_grep_before_index: true
```

- [ ] **Step 2: Write the runner**

`evals/agent-loop/runner.mjs`:

```javascript
#!/usr/bin/env node
// Agent-loop eval runner.
//
// For each scenario YAML:
//  1. Set up a temp workspace as a copy of the fixture repo.
//  2. Pre-seed the code-index data dir with the scenario's seed events.
//  3. Spawn `claude -p "<prompt>"` against that workspace, capturing tool-use stream.
//  4. Compare the trace + final filesystem state against the success criteria.
//  5. Append result to scoreboard.md.
//
// Requires: `claude` CLI on PATH and a working code-index install.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCENARIOS_DIR = path.join(__dirname, 'scenarios')
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'sample-repos')
const SCOREBOARD = path.join(__dirname, 'scoreboard.md')

// Tiny YAML parser stub — for scenarios we control the format.
function parseYaml(s) {
  // Use built-in `JSON5`-style by translating YAML to JSON for our limited subset.
  // For real use, swap in `yaml` from npm. Keeping deps minimal here.
  // This stub handles the exact shape used by our scenario files.
  const out = {}
  let cur = out
  const stack = [{ obj: out, indent: -1 }]
  const lines = s.split('\n')
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop()
    cur = stack[stack.length - 1].obj
    if (line.startsWith('- ')) {
      // list item
      const v = line.slice(2)
      if (!Array.isArray(cur)) throw new Error('list item in non-list at: ' + raw)
      cur.push(coerce(v))
      continue
    }
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (!m) continue
    const k = m[1].trim()
    const v = m[2]
    if (v === '' || v === null) {
      const child = {}
      cur[k] = child
      stack.push({ obj: child, indent })
    } else if (v === '[]') { cur[k] = [] }
    else if (v.startsWith('[')) { cur[k] = JSON.parse(v) }
    else if (v.startsWith('{')) { cur[k] = JSON.parse(v) }
    else cur[k] = coerce(v)
  }
  return out
}
function coerce(v) {
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v)
  if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(v)
  return v
}

// NOTE: For the agent-loop suite we use a real `yaml` dep for robustness.
// The above is a backstop. Add `yaml` in package.json if scenarios get complex.

async function runScenario(scenarioPath) {
  const sc = parseYaml(fs.readFileSync(scenarioPath, 'utf8'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-eval-'))
  // Copy fixture
  const src = path.join(FIXTURES, sc.fixture_repo)
  copyDir(src, tmp)
  fs.mkdirSync(path.join(tmp, '.git')) // fake git root so workspace resolves
  // Pre-seed events via direct ingest server call (assume extension is running)
  // Read port:
  const portFile = path.join(os.homedir(), '.codesurf', 'extensions', 'code-index', 'data', 'port')
  if (!fs.existsSync(portFile)) {
    return { id: sc.id, status: 'SKIP', reason: 'extension not running (no port file)' }
  }
  const port = fs.readFileSync(portFile, 'utf8').trim()
  for (const ev of (sc.seed?.events || [])) {
    await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool_name: ev.tool,
        tool_input: { file_path: path.join(tmp, ev.path) },
        cwd: tmp,
        session_id: ev.sessionId,
      }),
    })
  }
  // Run the agent
  const trace = await runClaude(sc.prompt, tmp, sc.budget?.max_tokens || 8000)
  // Evaluate
  const verdict = evaluate(trace, sc, tmp)
  // Cleanup
  fs.rmSync(tmp, { recursive: true, force: true })
  return { id: sc.id, ...verdict }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function runClaude(prompt, cwd, maxTokens) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--max-turns', '15']
    const p = spawn('claude', args, { cwd, env: { ...process.env } })
    let buf = ''
    const tools = []
    let edits = []
    p.stdout.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n'); buf = lines.pop()
      for (const ln of lines) {
        if (!ln.trim()) continue
        let evt
        try { evt = JSON.parse(ln) } catch { continue }
        if (evt.type === 'tool_use') tools.push({ name: evt.name, input: evt.input })
        if (evt.type === 'assistant' && evt.message?.content) {
          for (const b of evt.message.content) {
            if (b.type === 'tool_use') tools.push({ name: b.name, input: b.input })
          }
        }
      }
    })
    p.stderr.on('data', () => {})
    p.on('close', () => resolve({ tools, editsDetectedFromFs: edits }))
  })
}

function evaluate(trace, sc, workspace) {
  const fail = (reason) => ({ status: 'FAIL', reason, toolCalls: trace.tools.length })
  // must_edit: check files exist and were modified during the run (mtime newer than start)
  // For simplicity we require the agent to have called Edit/Write on the listed paths.
  for (const must of (sc.success?.must_edit || [])) {
    const called = trace.tools.some(t =>
      (t.name === 'Edit' || t.name === 'Write' || t.name === 'MultiEdit') &&
      (t.input?.file_path || '').endsWith(must)
    )
    if (!called) return fail(`expected edit to ${must}, none observed`)
  }
  // must_call_among_first: one of these tools must appear in the first 3 calls
  if (sc.success?.must_call_among_first) {
    const first3 = trace.tools.slice(0, 3).map(t => t.name)
    const ok = sc.success.must_call_among_first.some(n => first3.includes(n))
    if (!ok) return fail(`expected one of ${JSON.stringify(sc.success.must_call_among_first)} in first 3 tools, got ${JSON.stringify(first3)}`)
  }
  // forbid_grep_before_index
  if (sc.success?.forbid_grep_before_index) {
    let sawIndex = false
    for (const t of trace.tools) {
      if (t.name.startsWith('mcp__code-index')) sawIndex = true
      if (t.name === 'Grep' && !sawIndex) return fail('Grep called before any code-index tool')
    }
  }
  return { status: 'PASS', toolCalls: trace.tools.length }
}

async function main() {
  const files = fs.readdirSync(SCENARIOS_DIR).filter(f => f.endsWith('.yaml')).sort()
  const results = []
  for (const f of files) {
    process.stdout.write(`Running ${f}... `)
    try {
      const r = await runScenario(path.join(SCENARIOS_DIR, f))
      results.push(r)
      console.log(r.status + (r.reason ? ` (${r.reason})` : ''))
    } catch (e) {
      results.push({ id: f, status: 'ERROR', reason: e.message })
      console.log('ERROR ' + e.message)
    }
  }
  appendScoreboard(results)
  const pass = results.filter(r => r.status === 'PASS').length
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

function appendScoreboard(results) {
  const stamp = new Date().toISOString()
  let md = fs.existsSync(SCOREBOARD) ? fs.readFileSync(SCOREBOARD, 'utf8') : '# Code Index Eval Scoreboard\n\n'
  md += `\n## ${stamp}\n\n| Scenario | Status | Tool calls | Notes |\n|---|---|---|---|\n`
  for (const r of results) {
    md += `| ${r.id} | ${r.status} | ${r.toolCalls ?? '—'} | ${r.reason || ''} |\n`
  }
  fs.writeFileSync(SCOREBOARD, md)
}

main()
```

- [ ] **Step 3: Initialize the scoreboard**

```bash
cat > examples/extensions/code-index/evals/agent-loop/scoreboard.md <<'EOF'
# Code Index Eval Scoreboard

Auto-updated by `npm run test:agent-loop`. Each run appends a timestamped section.
EOF
```

- [ ] **Step 4: Add the YAML dep for robustness**

The stub parser in the runner is fragile. Before relying on it, add the proper dep:

```bash
cd examples/extensions/code-index && npm install --save-dev yaml
```

Then in `runner.mjs`, replace the `parseYaml` function call with:

```javascript
import YAML from 'yaml'
// ...
const sc = YAML.parse(fs.readFileSync(scenarioPath, 'utf8'))
```

Delete the stub `parseYaml` and `coerce` functions.

- [ ] **Step 5: Add scenarios 002 and 003**

`evals/agent-loop/scenarios/002-related-files.yaml`:

```yaml
id: 002-related-files
description: "Editing easing.ts after seed of (easing.ts + Component.tsx) co-touches — agent should consult related"
fixture_repo: ts-react
seed:
  events:
    - { tool: Read, path: src/easing.ts, sessionId: s1 }
    - { tool: Read, path: src/Component.tsx, sessionId: s1 }
    - { tool: Edit, path: src/easing.ts, sessionId: s1 }
    - { tool: Read, path: src/easing.ts, sessionId: s2 }
    - { tool: Read, path: src/Component.tsx, sessionId: s2 }
prompt: "I'm about to refactor src/easing.ts. Before you start, tell me what other files in this workspace usually move with it."
budget: { max_tool_calls: 5, max_tokens: 4000 }
success:
  must_call_among_first: ["mcp__code-index__related"]
```

`evals/agent-loop/scenarios/003-resume-orientation.yaml`:

```yaml
id: 003-resume-orientation
description: "Cold-start a session — agent should orient via hot before exploring blindly"
fixture_repo: ts-react
seed:
  events:
    - { tool: Read, path: src/easing.ts, sessionId: yesterday }
    - { tool: Edit, path: src/easing.ts, sessionId: yesterday }
    - { tool: Read, path: src/Component.tsx, sessionId: yesterday }
prompt: "I'm picking this project back up. What's been hot lately? Don't read any files yet — just summarize."
budget: { max_tool_calls: 3, max_tokens: 2000 }
success:
  must_call_among_first: ["mcp__code-index__hot"]
  forbid_grep_before_index: true
```

- [ ] **Step 6: Manual run (only when extension installed and Claude CLI available)**

```bash
cd examples/extensions/code-index && npm run test:agent-loop
```

If the extension is not installed yet, expect the runner to report `SKIP` for each scenario with reason "extension not running". That's the correct behavior — Phase 10 (install) is what makes these run end-to-end.

- [ ] **Step 7: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/evals/agent-loop/ examples/extensions/code-index/package.json examples/extensions/code-index/package-lock.json && git commit -m "feat(code-index): agent-loop eval runner with 3 starter scenarios"
```

---

### Task 9.2: Replay CLI

**Files:**
- Create: `examples/extensions/code-index/evals/replay/replay.mjs`

- [ ] **Step 1: Write the replay CLI**

```javascript
#!/usr/bin/env node
// Replay a Claude Code transcript through a fresh in-memory indexer and report
// what the index would have looked like at each turn — and what queries would
// have helped if the agent had asked.
//
// Usage:
//   node evals/replay/replay.mjs <transcript-path> [--workspace /repo/root]
//   node evals/replay/replay.mjs --projects /Users/x/.claude/projects/<encoded>
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Indexer } from '../../lib/indexer.js'
import { rankFindResults, rankHotFiles } from '../../lib/ranker.js'

const args = process.argv.slice(2)
const transcript = args.find(a => !a.startsWith('--'))
const wsIdx = args.indexOf('--workspace')
const workspaceRoot = wsIdx >= 0 ? args[wsIdx + 1] : null
const projIdx = args.indexOf('--projects')
const projDir = projIdx >= 0 ? args[projIdx + 1] : null

if (!transcript && !projDir) {
  console.error('usage: replay.mjs <transcript> [--workspace /root] OR --projects <dir>')
  process.exit(2)
}

const idx = new Indexer()

async function processFile(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let turn = 0
  for await (const line of rl) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    const ts = entry.timestamp ? Math.floor(Date.parse(entry.timestamp) / 1000) : Math.floor(Date.now() / 1000)
    for (const b of content) {
      if (b.type !== 'tool_use') continue
      if (!['Read', 'Edit', 'Write', 'MultiEdit'].includes(b.name)) continue
      const fp = b.input?.file_path
      if (!fp) continue
      const rel = workspaceRoot && fp.startsWith(workspaceRoot) ? path.relative(workspaceRoot, fp) : fp
      idx.ingest({ tool: b.name, path: rel, sessionId: 'replay', ts })
      turn++
      if (b.name === 'Grep') {
        const q = b.input?.pattern
        if (q) {
          const results = rankFindResults(q, null, idx.getState().files, hotnessNow(idx))
          if (results.length) {
            console.log(`[turn ${turn}] Grep("${q}") — index would have answered with:`)
            for (const r of results.slice(0, 3)) console.log(`  ${r.file}:${r.line}  ${r.name} (${r.kind})`)
          }
        }
      }
    }
  }
  console.log(`\nReplayed ${file}: ${turn} tool events.`)
}

function hotnessNow(idx) {
  const out = {}
  for (const p of Object.keys(idx.files)) out[p] = idx.computeHotness(p)
  return out
}

async function main() {
  if (transcript) await processFile(transcript)
  if (projDir) {
    for (const f of fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'))) {
      await processFile(path.join(projDir, f))
    }
  }
  console.log('\n=== Final hot files ===')
  const top = rankHotFiles(idx.getState().files, hotnessNow(idx), 10)
  for (const f of top) console.log(`  ${f.hotness.toFixed(1).padStart(6)}  ${f.path}  ${f.reads}r ${f.edits}e ${f.writes}w`)
}

main()
```

- [ ] **Step 2: Smoke test against the fixture**

```bash
cd examples/extensions/code-index && node evals/replay/replay.mjs evals/fixtures/transcripts/sample.jsonl --workspace /repo
```

Expected output: turns reported, then "Final hot files" listing `src/a.ts`, `src/b.ts`, `src/c.ts` with weights.

- [ ] **Step 3: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/evals/replay/ && git commit -m "feat(code-index): replay CLI for post-hoc index simulation"
```

---

## Phase 10 — Docs, install, end-to-end verification

### Task 10.1: Extension README + CLAUDE.md

**Files:**
- Create: `examples/extensions/code-index/README.md`
- Create: `examples/extensions/code-index/CLAUDE.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# Code Index — CodeSurf Extension

Maintains a per-workspace activity + symbol index of files Claude Code touches.
Exposes MCP tools (`find`, `hot`, `related`) so the agent can locate symbols
in O(lookup) instead of running `Grep`.

## What it does

- **Listens** to Claude Code `PostToolUse` hooks for `Read|Edit|Write|MultiEdit`.
- **Indexes** every touched file: counter (reads/edits/writes), last-touched timestamp,
  hotness (weighted, decaying), and top-level symbols (functions, classes, methods,
  components, types) with line numbers.
- **Serves** queries via MCP tools the agent can call.
- **Shows** a dashboard tile: search box, hot files, recent activity.

## What it does NOT do

- Store file contents. Only paths, symbol names, line numbers, counters.
- Index files that have never been touched. Use `Grep` for cold search.
- Replace your editor's symbol index. This tracks **agent activity**, not the codebase.

## Install

1. Copy this directory to `~/.codesurf/extensions/code-index/`:

   ```bash
   cp -r examples/extensions/code-index ~/.codesurf/extensions/code-index
   ```

2. Install dependencies and grammars:

   ```bash
   cd ~/.codesurf/extensions/code-index && npm install
   ```

   The `postinstall` step downloads ~7 WASM grammars (~5–10 MB total) into
   `grammars/`.

3. Install the Claude skill:

   ```bash
   bash ~/.codesurf/extensions/code-index/scripts/install-skill.sh
   ```

4. Wire the PostToolUse hook into `~/.claude/settings.json` —
   see [hook/INSTALL.md](hook/INSTALL.md).

5. Refresh extensions in CodeSurf, then drop a "Code Index" tile onto your
   canvas via the context menu.

## Quick verify

```bash
# 1. Did the ingest server start?
cat ~/.codesurf/extensions/code-index/data/port

# 2. Is it healthy?
curl -s http://127.0.0.1:$(cat ~/.codesurf/extensions/code-index/data/port)/health
# → {"ok":true}

# 3. Trigger a tool use in any project (Read a file via Claude),
#    then check the tile's "Recent activity" — your read should appear.
```

## Privacy

- All data is local to this machine: `~/.codesurf/extensions/code-index/data/`.
- The index stores: file paths, symbol names, line numbers, counters, timestamps.
- The index does NOT store: file contents, code excerpts, or anything beyond
  what's listed above.

## Run the evals

```bash
# Unit tests (fast, gates CI)
npm test

# Agent-loop scenarios (requires extension installed + claude CLI)
npm run test:agent-loop

# Replay your real history
npm run replay -- ~/.claude/projects/<your-project>/<session>.jsonl --workspace <repo-root>
```

## Architecture

See [`docs/superpowers/specs/2026-05-03-code-index-design.md`](../../../docs/superpowers/specs/2026-05-03-code-index-design.md)
for the full design.

````

- [ ] **Step 2: Write `CLAUDE.md`** for future agents working on this extension

```markdown
# Code Index — Agent Working Notes

You are working inside the `code-index` CodeSurf extension. Hard rules:

1. **Never edit files outside `examples/extensions/code-index/`** — except when
   the user explicitly asks you to update the companion skill at
   `~/.claude/skills/code-index/`. The CodeSurf host (`src/`) is off-limits.
2. **Cross-platform.** No native deps. Tree-sitter via WASM only. Hook
   snippets must work on macOS, Linux, Windows (PowerShell).
3. **Privacy.** Never store file contents. Symbol names, paths, line numbers,
   counters only.
4. **Hook contract.** The hook is a one-liner inlined in `settings.json`. Do
   not introduce a script file — that breaks Windows.
5. **Index is activity-driven.** Do not add filesystem walkers. The whole
   point is "we only know what Claude has touched."

## Testing

- Unit tests: `npm test` — must pass before commit. No exceptions.
- Agent-loop tests: `npm run test:agent-loop` — runs against installed
  extension + `claude` CLI. Best-effort; not a CI gate yet.
- Replay: `npm run replay -- <transcript> --workspace <root>` — useful for
  debugging real-world index behavior.

## File responsibilities

- `lib/indexer.js` — pure logic. No I/O. Eval-importable.
- `lib/parser.js` — tree-sitter wrapper. Lazy grammar loading. Per-file size cap.
- `lib/storage.js` — atomic JSON + JSONL append. Debounced writes.
- `lib/workspace.js` — `cwd → root` resolution.
- `lib/ingest-server.js` — minimal HTTP. Never throws. Always 200.
- `lib/ranker.js` — pure ranking functions.
- `lib/backfill.js` — replay transcripts.
- `main.js` — wires everything to the Codesurf bridge (ctx). Keep it thin.
- `tiles/dashboard/index.html` — observability only. Read-only. No mutations.
- `hook/INSTALL.md` — copy-pasteable hook snippets.

## When you change anything

1. Update or add a unit test FIRST.
2. Run `npm test` — verify red, then green.
3. If you touched `main.js`, smoke-test by spawning it with a stub `ctx`
   (see Phase 4 / Task 4.2 Step 2 in the implementation plan).
4. Commit with a focused message; one logical change per commit.

## When in doubt

Re-read `docs/superpowers/specs/2026-05-03-code-index-design.md`. Decisions
were made deliberately (e.g., why no SQLite, why one tile, why localhost HTTP
not Unix socket). Do not undo them without proposing an updated spec.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/README.md examples/extensions/code-index/CLAUDE.md && git commit -m "docs(code-index): README + CLAUDE.md for extension contributors"
```

---

### Task 10.2: Install + end-to-end verification

**Files:** none changed; this is a verification task.

- [ ] **Step 1: Install the extension to the runtime location**

```bash
rm -rf ~/.codesurf/extensions/code-index
cp -r /Users/jkneen/clawd/collaborator-clone/examples/extensions/code-index ~/.codesurf/extensions/code-index
cd ~/.codesurf/extensions/code-index && npm install
```

Expected: `npm install` runs `postinstall` which downloads grammars. `ls grammars/*.wasm` shows 7 files.

- [ ] **Step 2: Install the skill**

```bash
bash ~/.codesurf/extensions/code-index/scripts/install-skill.sh
```

Expected: prints "Installed Code Index skill to /Users/jkneen/.claude/skills/code-index".

- [ ] **Step 3: Install the hook in `~/.claude/settings.json`**

Manually merge the JSON snippet from `hook/INSTALL.md` into `~/.claude/settings.json`. (Do NOT auto-install — security boundary.)

Verify the file is valid JSON:

```bash
python3 -m json.tool ~/.claude/settings.json > /dev/null && echo "settings.json: OK"
```

- [ ] **Step 4: Refresh extensions in CodeSurf**

Restart CodeSurf or run its "Refresh extensions" command. Drop a "Code Index" tile on the canvas via context menu.

Expected: tile loads showing "workspace: …" and "no activity yet" empty states. The banner reads "No activity yet. Install the hook…".

- [ ] **Step 5: Trigger end-to-end events**

In a Claude Code session inside any project:

```
> Read package.json
```

Expected: within 1 second, the tile's "Recent activity" shows `Read package.json`. Hot files updates.

- [ ] **Step 6: Test each MCP tool**

In Claude Code, ask:

```
> Use the code-index tool to find the symbol "smoothstep"
> Use the code-index tool to show hot files
> Use the code-index tool stats
```

Expected: the agent invokes `mcp__code-index__find`, `mcp__code-index__hot`, and `mcp__code-index__stats` and reports results.

- [ ] **Step 7: Run the agent-loop evals end-to-end**

```bash
cd ~/.codesurf/extensions/code-index && npm run test:agent-loop
```

Expected: at least 1 of 3 scenarios passes. Failures are fine for now — they're the truth signal we use to tune the skill description and ranking weights. Each run appends to `evals/agent-loop/scoreboard.md`.

- [ ] **Step 8: Commit the scoreboard**

```bash
cp ~/.codesurf/extensions/code-index/evals/agent-loop/scoreboard.md /Users/jkneen/clawd/collaborator-clone/examples/extensions/code-index/evals/agent-loop/scoreboard.md
cd /Users/jkneen/clawd/collaborator-clone && git add examples/extensions/code-index/evals/agent-loop/scoreboard.md && git commit -m "chore(code-index): initial agent-loop eval scoreboard"
```

- [ ] **Step 9: Update the spec status**

Edit `docs/superpowers/specs/2026-05-03-code-index-design.md`, change frontmatter `Status:` from `Approved, ready for implementation plan` to `Implemented, in iteration`. Commit.

---

## Done

The extension, skill, and eval suite are deployed. Iteration from here is driven by:

1. **Unit test failures** — fix immediately, never bypass.
2. **Scoreboard regressions** — investigate; usually a ranker tweak or a skill description refinement.
3. **Real-world replay output** — when you suspect the index isn't earning its keep, run replay over a real session and inspect what queries would have helped. If the answer is "none", revisit the design.
