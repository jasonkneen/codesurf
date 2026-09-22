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
    // Track which pairs we've already counted in the current session window.
    // Key: "pathA::pathB" with paths sorted lexically. Value: lastTs we counted that pair.
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
    // Ensure every file has events / symbols arrays (legacy data may lack them)
    for (const f of Object.values(this.files)) {
      if (!Array.isArray(f.events)) f.events = []
      if (!Array.isArray(f.symbols)) f.symbols = []
    }
  }
}

module.exports = { Indexer, TOOL_WEIGHT }
