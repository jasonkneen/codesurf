import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * H3: openExternalIfSafe used validateFsPath() with no options, which is inert
 * (assertPathAllowedForFs returns immediately without restrictToWorkspaceRoots,
 * and CODESURF_HOME short-circuits earlier still). shell.openPath then handed
 * the file to LaunchServices, executing it.
 *
 * index.ts pulls in electron at module load, so the predicate is re-declared
 * here against the same list; the companion assertion below pins that the
 * source really does refuse these before calling shell.openPath.
 */
const EXECUTABLE_OPEN_EXTENSIONS = new Set([
  '.command', '.app', '.sh', '.bash', '.zsh', '.fish', '.tool', '.workflow',
  '.scpt', '.scptd', '.applescript', '.osascript', '.action', '.terminal',
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.psm1', '.vbs',
  '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.pkg', '.dmg',
  '.desktop', '.run', '.bin', '.appimage',
])

function hasExecutableExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/[/\\]+$/, '')
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return EXECUTABLE_OPEN_EXTENSIONS.has(lower.slice(dot))
}

describe('hasExecutableExtension', () => {
  it('blocks the documented attack payload', () => {
    assert.equal(hasExecutableExtension('/tmp/update.command'), true)
  })

  it('blocks executables regardless of case or trailing slash', () => {
    assert.equal(hasExecutableExtension('/tmp/Evil.COMMAND'), true)
    assert.equal(hasExecutableExtension('/Applications/Calculator.app/'), true)
  })

  it('blocks the common script and installer families', () => {
    for (const p of [
      '/tmp/x.sh', '/tmp/x.zsh', '/tmp/x.scpt', '/tmp/x.exe', '/tmp/x.bat',
      '/tmp/x.ps1', '/tmp/x.vbs', '/tmp/x.jar', '/tmp/x.pkg', '/tmp/x.dmg',
      '/tmp/x.desktop', '/tmp/x.appimage',
    ]) {
      assert.equal(hasExecutableExtension(p), true, `${p} must be refused`)
    }
  })

  it('allows ordinary documents', () => {
    for (const p of ['/ws/report.pdf', '/ws/notes.md', '/ws/shot.png', '/ws/data.csv', '/ws/README']) {
      assert.equal(hasExecutableExtension(p), false, `${p} must stay openable`)
    }
  })
})

describe('openExternalIfSafe source contract', () => {
  it('scopes file:// to workspace roots and refuses executables', async () => {
    const src = await import('node:fs').then(fs =>
      fs.promises.readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'))
    const fn = src.slice(src.indexOf('async function openExternalIfSafe'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))

    assert.ok(body.includes('hasExecutableExtension'), 'must reject executables before opening')
    assert.ok(body.includes('restrictToWorkspaceRoots: true'), 'must actually enable workspace scoping')
    assert.ok(body.includes('getAllWorkspaceProjectPaths'), 'must pass real workspace roots')
    assert.ok(
      !/validateFsPath\(filePath\)\s*$/m.test(body),
      'must not fall back to the inert no-options validateFsPath',
    )
  })
})
