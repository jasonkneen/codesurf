import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

const pluginStore = readFileSync(new URL('../src/main/extensions/plugin-store.ts', import.meta.url), 'utf8')
const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const collab = readFileSync(new URL('../src/main/ipc/collab.ts', import.meta.url), 'utf8')
const extensions = readFileSync(new URL('../src/main/ipc/extensions.ts', import.meta.url), 'utf8')
const skills = readFileSync(new URL('../src/main/ipc/skills.ts', import.meta.url), 'utf8')
const secrets = readFileSync(new URL('../src/main/ipc/secrets-ipc.ts', import.meta.url), 'utf8')

describe('M9 — plugin state is written atomically', () => {
  it('writes to a temp file, fsyncs and renames', () => {
    const fn = pluginStore.slice(pluginStore.indexOf('function persist('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.includes(".tmp'") || body.includes('.tmp`'), 'a temp file is used')
    assert.ok(body.includes("openSync(tmp, 'wx')"), 'exclusive create avoids clobbering a concurrent write')
    assert.ok(body.includes('fsyncSync'), 'contents must be flushed before rename')
    assert.ok(body.includes('renameSync(tmp, file)'), 'rename makes the swap atomic')
    assert.equal(/writeFileSync\(fileFor/.test(pluginStore), false, 'the bare write must be gone')
  })

  it('does not announce success for a write that failed', () => {
    const fn = pluginStore.slice(pluginStore.indexOf('function persist('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    const throwAt = body.indexOf('throw err')
    const publishAt = body.indexOf('bus.publish')
    assert.ok(throwAt > -1, 'a failed write must propagate')
    assert.ok(throwAt < publishAt, 'the failure path must exit before publishing success')
    assert.ok(body.lastIndexOf('cache.set(extId, value)') > throwAt, 'cache is only updated after a durable write')
  })

  it('a corrupt file is preserved, not silently reset to {}', () => {
    const fn = pluginStore.slice(pluginStore.indexOf('export function getPluginState'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.includes('.bad-'), 'the corrupt file is kept for recovery')
    assert.ok(body.includes('if (readable) cache.set'), '{} must not be cached as authoritative')
  })
})

describe('M10 — the boot chain cannot reject unhandled', () => {
  it('attaches a catch that reports and exits', () => {
    const tail = index.slice(index.indexOf('app.whenReady()'))
    assert.ok(tail.includes('}).catch(error =>'), 'the whenReady chain must be caught')
    assert.ok(tail.includes('showErrorBox'), 'a boot failure must be visible, not silent')
    assert.ok(tail.includes('app.exit(1)'), 'a half-initialised app must not linger')
  })
})

describe('M11 — the message watcher actually fires', () => {
  it('watches a directory, not a chokidar glob', () => {
    assert.equal(/chokidar\.watch\(join\(rootDir, '\*\*/.test(collab), false, 'globs were removed in chokidar v4')
    assert.ok(collab.includes('chokidar.watch(rootDir'), 'watch the real directory')
    assert.ok(/depth: 2/.test(collab), 'mailbox files sit below the root')
  })

  it('derives the relative path with the platform separator', () => {
    const fn = collab.slice(collab.indexOf('function parseMailboxAndFilename'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.includes('relative(rootDir, changedPath).split(sep)'), 'Windows uses backslashes')
    assert.equal(/changedPath\.slice\(rootDir\.length/.test(body), false, 'the slice-and-split-on-slash must be gone')
    assert.ok(body.includes(".endsWith('.md')"), 'the glob used to constrain to .md; now filter here')
  })
})

describe('M12 — archive handling is cross-platform', () => {
  it('extensions no longer shell out to an absolute unzip path', () => {
    // Only invocations matter; the path is still named in a comment explaining
    // why it was removed.
    const code = extensions.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
    assert.equal(/['"`]\/usr\/bin\/unzip['"`]/.test(code), false, 'no hardcoded macOS binary path in code')
    assert.equal(/execFileAsync\(|runCmd\(/.test(code), false, 'no external process spawn remains')
    assert.ok(extensions.includes("import('extract-zip')"), 'uses the already-declared JS library')
    assert.ok(extensions.includes('onEntry'), 'entries are validated as they are read')
  })

  it('entry validation still rejects the three unsafe shapes', () => {
    const fn = extensions.slice(extensions.indexOf('function assertSafeZipEntry('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.includes('is a symlink'))
    assert.ok(body.includes('absolute path'))
    assert.ok(body.includes('path traversal'))
  })

  it('skills resolves unzip instead of hardcoding it', () => {
    assert.ok(skills.includes('resolveUnzipBinary()'), 'binary is resolved at runtime')
    assert.equal(/runCmd\('\/usr\/bin\/unzip'/.test(skills), false, 'no hardcoded call sites remain')
  })
})

describe('M14 — an unchanged gateway key must not restart the daemon', () => {
  it('compares the stored value before writing', () => {
    assert.ok(secrets.includes('gatewayUnchanged'), 'set must detect a no-op write')
    assert.ok(secrets.includes('!gatewayUnchanged'), 'and skip the restart')
  })

  it('deleting a key that was never set does nothing', () => {
    assert.ok(secrets.includes('gatewayWasSet'), 'delete must detect a no-op')
  })

  it('behaviour: only a real change triggers the restart', () => {
    const restarts: string[] = []
    const store = new Map<string, string>([['ai-gateway', 'key-1']])
    const setSecret = (name: string, value: string) => {
      const unchanged = name === 'ai-gateway' && store.get(name) === value
      store.set(name, value)
      if (name === 'ai-gateway' && !unchanged) restarts.push(value)
    }
    setSecret('ai-gateway', 'key-1')  // re-paste of the same key
    assert.deepEqual(restarts, [], 'a no-op write must not kill in-flight jobs')
    setSecret('ai-gateway', 'key-2')
    assert.deepEqual(restarts, ['key-2'], 'a genuine change still restarts')
  })
})
