'use strict'
const path = require('path')
const fs = require('fs')

const THEMES_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.codesurf', 'themes'
)

function ensureDir() {
  fs.mkdirSync(THEMES_DIR, { recursive: true })
}

function listThemes() {
  ensureDir()
  const files = fs.readdirSync(THEMES_DIR).filter(f => f.endsWith('.json'))
  return files.flatMap(f => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(THEMES_DIR, f), 'utf8'))]
    } catch { return [] }
  })
}

function saveTheme(theme) {
  ensureDir()
  if (!theme || !theme.id) throw new Error('Theme must have an id')
  // Sanitise id — alphanumeric + hyphens only
  theme.id = theme.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  fs.writeFileSync(path.join(THEMES_DIR, `${theme.id}.json`), JSON.stringify(theme, null, 2))
  return theme
}

function deleteTheme(id) {
  ensureDir()
  const file = path.join(THEMES_DIR, `${id}.json`)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  return true
}

module.exports = {
  activate(ctx) {
    ctx.log('[theme-builder] activated')

    // Expose methods callable via ext.invoke from the tile
    ctx.ipc.handle('listThemes', () => listThemes())
    ctx.ipc.handle('saveTheme', (theme) => {
      const saved = saveTheme(theme)
      // Broadcast so the renderer can pick up the new theme immediately
      ctx.bus.publish('themes', 'data', { action: 'register', theme: saved })
      return saved
    })
    ctx.ipc.handle('deleteTheme', (id) => {
      deleteTheme(id)
      ctx.bus.publish('themes', 'data', { action: 'delete', id })
      return true
    })

    // On activation, broadcast all saved themes so the app registers them
    for (const theme of listThemes()) {
      ctx.bus.publish('themes', 'data', { action: 'register', theme })
    }
  }
}
