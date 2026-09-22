import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  isAllowedBinary,
  expandHome,
  ALLOWED_SHELLS,
  ALLOWED_AGENT_BINS,
} from '../src/main/ipc/terminal-helpers.ts'
import { CODESURF_HOME } from '../src/main/paths.ts'

// ---------------------------------------------------------------------------
// isAllowedBinary
// ---------------------------------------------------------------------------

describe('isAllowedBinary — known shells', () => {
  it('allows /bin/bash', () => {
    assert.equal(isAllowedBinary('/bin/bash'), true)
  })

  it('allows /bin/zsh', () => {
    assert.equal(isAllowedBinary('/bin/zsh'), true)
  })

  it('allows /bin/sh', () => {
    assert.equal(isAllowedBinary('/bin/sh'), true)
  })

  it('allows /usr/bin/bash', () => {
    assert.equal(isAllowedBinary('/usr/bin/bash'), true)
  })

  it('allows /usr/local/bin/fish', () => {
    assert.equal(isAllowedBinary('/usr/local/bin/fish'), true)
  })

  it('allows /opt/homebrew/bin/zsh', () => {
    assert.equal(isAllowedBinary('/opt/homebrew/bin/zsh'), true)
  })

  it('allows the current user SHELL', () => {
    const shell = process.env.SHELL
    if (!shell) return // skip when SHELL is unset
    assert.equal(ALLOWED_SHELLS.has(shell), true)
    assert.equal(isAllowedBinary(shell), true)
  })
})

describe('isAllowedBinary — known agent CLIs', () => {
  for (const bin of ALLOWED_AGENT_BINS) {
    it(`allows bare name "${bin}"`, () => {
      assert.equal(isAllowedBinary(bin), true)
    })
  }

  it('allows agent CLI with a path prefix (posix)', () => {
    assert.equal(isAllowedBinary('/usr/local/bin/claude'), true)
  })

  it('allows agent CLI with a Windows path prefix', () => {
    assert.equal(isAllowedBinary('C:\\Users\\me\\AppData\\Local\\npm\\codex.cmd'), true)
  })

  it('allows agent CLI with .exe extension', () => {
    assert.equal(isAllowedBinary('claude.exe'), true)
  })

  it('allows agent CLI with .cmd shim extension', () => {
    assert.equal(isAllowedBinary('codex.cmd'), true)
  })

  it('allows agent CLI with .bat shim extension', () => {
    assert.equal(isAllowedBinary('aider.bat'), true)
  })

  it('allows agent CLI with .ps1 shim extension', () => {
    assert.equal(isAllowedBinary('opencode.ps1'), true)
  })
})

describe('isAllowedBinary — rejects unknown binaries', () => {
  it('rejects an arbitrary binary name', () => {
    assert.equal(isAllowedBinary('rm'), false)
  })

  it('rejects a binary with path traversal in the name', () => {
    assert.equal(isAllowedBinary('../../../etc/passwd'), false)
  })

  it('rejects an empty string', () => {
    assert.equal(isAllowedBinary(''), false)
  })

  it('rejects a binary that partially matches an agent name', () => {
    assert.equal(isAllowedBinary('claudette'), false)
  })

  it('rejects curl', () => {
    assert.equal(isAllowedBinary('/usr/bin/curl'), false)
  })

  it('rejects a random absolute path', () => {
    assert.equal(isAllowedBinary('/tmp/evil-script.sh'), false)
  })

  it('rejects a binary whose basename contains an agent name as substring', () => {
    assert.equal(isAllowedBinary('my-codex-wrapper'), false)
  })

  it('rejects node even though it is commonly used', () => {
    assert.equal(isAllowedBinary('/usr/local/bin/node'), false)
  })
})

// ---------------------------------------------------------------------------
// expandHome
// ---------------------------------------------------------------------------

describe('expandHome — tilde expansion', () => {
  const home = homedir()

  it('returns bare ~ as the home directory', () => {
    assert.equal(expandHome('~'), home)
  })

  it('expands ~/foo to <home>/foo', () => {
    assert.equal(expandHome('~/foo'), join(home, 'foo'))
  })

  it('expands ~/a/b/c to a nested path under home', () => {
    assert.equal(expandHome('~/a/b/c'), join(home, 'a', 'b', 'c'))
  })

  it('leaves an absolute path unchanged', () => {
    assert.equal(expandHome('/usr/local/bin'), '/usr/local/bin')
  })

  it('leaves a relative path without tilde unchanged', () => {
    assert.equal(expandHome('foo/bar'), 'foo/bar')
  })

  it('leaves an empty string unchanged', () => {
    assert.equal(expandHome(''), '')
  })

  it('leaves a tilde-prefixed username (~other) unchanged', () => {
    // ~other does not start with ~/ or ~\ or ~. so it passes through
    assert.equal(expandHome('~other'), '~other')
  })
})

describe('expandHome — CODESURF_HOME resolution', () => {
  it('resolves legacy ~/.codesurf/ paths to CODESURF_HOME', () => {
    const result = expandHome('~/.codesurf/workspaces/abc')
    assert.equal(result, join(CODESURF_HOME, 'workspaces/abc'))
  })

  it('resolves legacy ~/.codesurf/ with a single segment', () => {
    const result = expandHome('~/.codesurf/settings.json')
    assert.equal(result, join(CODESURF_HOME, 'settings.json'))
  })

  it('resolves current ~/.codesurf/ paths to CODESURF_HOME', () => {
    const result = expandHome('~/.codesurf/workspaces/abc')
    assert.equal(result, join(CODESURF_HOME, 'workspaces/abc'))
  })

  it('resolves legacy Windows-style ~\\.contex\\ paths to CODESURF_HOME', () => {
    const result = expandHome('~\\.contex\\workspaces\\abc')
    assert.equal(result, join(CODESURF_HOME, 'workspaces\\abc'))
  })
})
