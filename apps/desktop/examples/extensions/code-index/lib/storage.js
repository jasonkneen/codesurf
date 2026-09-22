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
