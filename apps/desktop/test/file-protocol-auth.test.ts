import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolve } from 'node:path'
import {
  authorizeRequestPath,
  isSensitiveHomePath,
  inferMimeType,
  SENSITIVE_HOME_DIRS,
} from '../src/main/file-protocol-auth.ts'

const HOME = '/Users/test'

describe('inferMimeType', () => {
  test('maps known media/doc extensions, octet-stream otherwise', () => {
    assert.equal(inferMimeType('/x/a.png'), 'image/png')
    assert.equal(inferMimeType('/x/a.MP4'), 'video/mp4')
    assert.equal(inferMimeType('/x/a.pdf'), 'application/pdf')
    assert.equal(inferMimeType('/x/a.txt'), 'application/octet-stream')
    assert.equal(inferMimeType('/x/noext'), 'application/octet-stream')
  })
})

describe('isSensitiveHomePath', () => {
  test('flags media files inside denylisted home dirs', () => {
    assert.equal(isSensitiveHomePath(`${HOME}/.ssh/key.png`, HOME), true)
    assert.equal(isSensitiveHomePath(`${HOME}/.config/app/icon.png`, HOME), true)
    assert.equal(isSensitiveHomePath(`${HOME}/.docker/x.png`, HOME), true)
    assert.equal(isSensitiveHomePath(`${HOME}/.kube/x.png`, HOME), true)
  })

  test('does not flag ordinary media dirs', () => {
    assert.equal(isSensitiveHomePath(`${HOME}/Pictures/photo.png`, HOME), false)
    assert.equal(isSensitiveHomePath(`${HOME}/Desktop/shot.png`, HOME), false)
  })

  test('home itself is not sensitive', () => {
    assert.equal(isSensitiveHomePath(HOME, HOME), false)
  })

  test('prefix-slip: a sibling dir sharing the home prefix is not treated as home-relative', () => {
    // `${HOME}-evil/.ssh/...` must NOT be read as being under `${HOME}` — the
    // check uses `home + sep`, so the leading-prefix match cannot slip.
    assert.equal(isSensitiveHomePath(`${HOME}-evil/.ssh/key.png`, HOME), false)
  })

  test('`..` traversal is normalized before the check', () => {
    // resolve() collapses the traversal back into ~/.ssh, so it is still caught.
    assert.equal(isSensitiveHomePath(`${HOME}/Pictures/../.ssh/key.png`, HOME), true)
  })

  test('the denylist covers the expanded credential/config trees', () => {
    for (const dir of ['.ssh', '.gnupg', '.aws', '.config', '.kube', '.docker', '.npmrc', '.cache', '.local']) {
      assert.ok(SENSITIVE_HOME_DIRS.has(dir), `${dir} should be denylisted`)
    }
  })
})

describe('authorizeRequestPath', () => {
  test('returns the canonical resolved path for allowed media', () => {
    assert.equal(authorizeRequestPath(`${HOME}/Pictures/a.png`, HOME), resolve(`${HOME}/Pictures/a.png`))
  })

  test('rejects unsupported (non-media) extensions', () => {
    assert.throws(() => authorizeRequestPath('/tmp/secret.txt', HOME), /Unsupported codesurf-file type/)
    assert.throws(() => authorizeRequestPath(`${HOME}/.netrc`, HOME), /Unsupported codesurf-file type/)
  })

  test('rejects media files inside sensitive home dirs', () => {
    assert.throws(() => authorizeRequestPath(`${HOME}/.ssh/key.png`, HOME), /sensitive home directory/)
    assert.throws(() => authorizeRequestPath(`${HOME}/.config/x.png`, HOME), /sensitive home directory/)
  })

  test('rejects traversal that resolves back into a sensitive dir', () => {
    assert.throws(() => authorizeRequestPath(`${HOME}/Pictures/../.aws/creds.png`, HOME), /sensitive home directory/)
  })
})
