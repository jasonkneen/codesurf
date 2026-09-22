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
