import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

// webviewManager.ts pulls in an extensionless shared import that node's
// strip-types loader cannot resolve; mirror the predicate and assert below that
// the mirror still matches its source.
function isAllowedBrowserUrl(value: string): boolean {
  if (value === 'about:blank') return true
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const explorer = readFileSync(new URL('../src/renderer/src/components/FileExplorerTile.tsx', import.meta.url), 'utf8')
const customisation = readFileSync(new URL('../src/renderer/src/components/CustomisationTile.tsx', import.meta.url), 'utf8')
const swp = readFileSync(new URL('../src/main/secure-web-preferences.ts', import.meta.url), 'utf8')
const lifecycle = readFileSync(new URL('../src/renderer/src/components/browser/useBrowserWebviewLifecycle.ts', import.meta.url), 'utf8')

describe('M32 — folder delete must be confirmed', () => {
  it('confirms before calling the irreversible delete', () => {
    const fn = explorer.slice(explorer.indexOf('const handleDelete = useCallback'))
    const body = fn.slice(0, fn.indexOf('}, ['))
    const confirmAt = body.indexOf('window.confirm')
    const deleteAt = body.indexOf('fs.deleteFile')
    assert.ok(confirmAt > -1, 'a confirmation is required')
    assert.ok(confirmAt < deleteAt, 'confirmation must precede the delete')
    assert.ok(body.includes('if (!confirmed) return'), 'declining must abort')
  })

  it('names the exact path and says it is not recoverable', () => {
    const fn = explorer.slice(explorer.indexOf('const handleDelete = useCallback'))
    const body = fn.slice(0, fn.indexOf('}, ['))
    assert.ok(body.includes('${entry.path}'), 'the path must be shown')
    assert.ok(body.includes('cannot be undone'), 'the user must know there is no undo')
    assert.ok(body.includes('everything inside it'), 'a directory delete is recursive')
  })

  it('surfaces a failure instead of only console.error', () => {
    const fn = explorer.slice(explorer.indexOf('const handleDelete = useCallback'))
    const body = fn.slice(0, fn.indexOf('}, ['))
    assert.ok(body.includes('window.alert'), 'a failed delete must be visible')
  })
})

describe('M30 — skill delete must be confirmed and must not tombstone a failure', () => {
  it('confirms, naming the file it will unlink', () => {
    const fn = customisation.slice(customisation.indexOf('const handleDelete = useCallback'))
    const body = fn.slice(0, fn.indexOf('}, ['))
    assert.ok(body.includes('window.confirm'))
    assert.ok(body.includes('${sourcePath}'), 'the resolved path must be shown')
    assert.ok(body.includes('if (!confirmed) return'))
  })

  it('does not hide a path it failed to delete', () => {
    const fn = customisation.slice(customisation.indexOf('const handleDelete = useCallback'))
    const body = fn.slice(0, fn.indexOf('}, ['))
    const catchAt = body.indexOf('catch (err)')
    const tombstoneAt = body.indexOf('saveHidden([...hiddenPaths')
    assert.ok(catchAt > -1 && tombstoneAt > -1)
    assert.ok(catchAt < tombstoneAt, 'the failure path returns before tombstoning')
    assert.equal(/deleteFile\(sourcePath\)\.catch\(\(\) => \{\}\)/.test(body), false,
      'the swallowed error must be gone')
  })
})

describe('M36 — a page-controlled popup URL must not reach the file opener', () => {
  it('main forwards only http(s)', () => {
    const fn = swp.slice(swp.indexOf('setWindowOpenHandler'))
    const body = fn.slice(0, fn.indexOf('return { action:'))
    assert.ok(body.includes('isForwardableGuestUrl'), 'the URL must be checked before forwarding')
  })

  it('the renderer re-checks with the same allowlist as the address bar', () => {
    // The `(event: { url: string })` annotation contains a '})', so slice by
    // a generous window rather than by the first brace pair.
    const body = lifecycle.slice(lifecycle.indexOf('onNewWindow'), lifecycle.indexOf('onNewWindow') + 600)
    assert.ok(body.includes('isAllowedBrowserUrl(event.url)'), 'belt and braces')
    assert.equal(/if \(event\.url\) void dispatchOpenLink/.test(lifecycle), false,
      'the unguarded dispatch must be gone')
  })

  it('behaviour: the documented payloads are refused', () => {
    for (const hostile of [
      'file:///Users/victim/proj/.env',
      'file:///Users/victim/.ssh/id_rsa',
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'vbscript:msgbox',
      'chrome://settings',
    ]) {
      assert.equal(isAllowedBrowserUrl(hostile), false, `${hostile} must not be openable`)
    }
  })

  it('behaviour: ordinary links still open', () => {
    for (const ok of ['https://example.com/docs', 'http://localhost:3000/app', 'about:blank']) {
      assert.equal(isAllowedBrowserUrl(ok), true, `${ok} must still work`)
    }
  })
})

describe('the mirrored predicate matches its source', () => {
  it('isAllowedBrowserUrl in webviewManager.ts is unchanged', () => {
    const wm = readFileSync(
      new URL('../src/renderer/src/components/browser/webviewManager.ts', import.meta.url), 'utf8')
    const fn = wm.slice(wm.indexOf('export function isAllowedBrowserUrl'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.includes("value === 'about:blank'"), 'about:blank still allowed')
    assert.ok(body.includes("url.protocol === 'http:' || url.protocol === 'https:'"), 'http(s) only')
  })
})
