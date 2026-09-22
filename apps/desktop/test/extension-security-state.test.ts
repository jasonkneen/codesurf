import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import {
  createExtensionSecurityState,
  EXTENSION_SECURITY_JOURNAL_FILENAME,
  EXTENSION_SECURITY_STATE_FILENAME,
  loadExtensionSecurityState,
  persistExtensionSecurityState,
} from '../src/main/extensions/security-state.ts'

const BASE_STATE = createExtensionSecurityState({
  disabledExtensionIds: ['blocked-extension'],
  enabledCatalogExtensionIds: ['stateful-extension'],
  grants: {
    'stateful-extension': ['chat'],
    'explicit-denial': [],
  },
})

const GRANTED_STATE = createExtensionSecurityState({
  disabledExtensionIds: ['blocked-extension'],
  enabledCatalogExtensionIds: ['stateful-extension'],
  grants: {
    'stateful-extension': ['chat', 'relay'],
    'explicit-denial': [],
  },
})

async function freshStateHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  await persistExtensionSecurityState(home, BASE_STATE, BASE_STATE)
  return home
}

test('migrates all legacy extension security fields once and ignores stale legacy files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codesurf-security-migration-'))
  await fs.writeFile(
    join(home, 'disabled-extensions.json'),
    JSON.stringify(['blocked-extension', 'conflicted-extension']),
  )
  await fs.writeFile(
    join(home, 'enabled-catalog-extensions.json'),
    JSON.stringify(['enabled-extension', 'conflicted-extension']),
  )
  await fs.writeFile(
    join(home, 'plugin-capability-grants.json'),
    JSON.stringify({
      'enabled-extension': ['relay', 'chat'],
      'explicit-denial': [],
      'historical-inert': ['ipc', 'future-capability'],
    }),
  )

  const migrated = await loadExtensionSecurityState(home)
  assert.deepEqual(migrated, {
    version: 1,
    disabledExtensionIds: ['blocked-extension', 'conflicted-extension'],
    enabledCatalogExtensionIds: ['enabled-extension'],
    grants: {
      'enabled-extension': ['chat', 'relay'],
      'explicit-denial': [],
      'historical-inert': [],
    },
  })
  const statePath = join(home, EXTENSION_SECURITY_STATE_FILENAME)
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600)
  await assert.rejects(
    fs.stat(join(home, EXTENSION_SECURITY_JOURNAL_FILENAME)),
    { code: 'ENOENT' },
  )

  await fs.writeFile(
    join(home, 'plugin-capability-grants.json'),
    JSON.stringify({ 'enabled-extension': ['shell'] }),
  )
  assert.deepEqual(await loadExtensionSecurityState(home), migrated)
})

test('an empty first load creates an authoritative snapshot and ignores later legacy files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codesurf-security-empty-first-'))

  const initial = await loadExtensionSecurityState(home)
  assert.deepEqual(initial, {
    version: 1,
    disabledExtensionIds: [],
    enabledCatalogExtensionIds: [],
    grants: {},
  })
  assert.equal(
    (await fs.stat(join(home, EXTENSION_SECURITY_STATE_FILENAME))).mode & 0o777,
    0o600,
  )

  await fs.writeFile(
    join(home, 'plugin-capability-grants.json'),
    JSON.stringify({ 'late-legacy-extension': ['shell'] }),
  )
  assert.deepEqual(await loadExtensionSecurityState(home), initial)
})

test('rejects malformed, future, conflicting, unknown, and oversized state fail closed', async t => {
  const cases: Array<{ name: string; value: string; pattern: RegExp }> = [
    {
      name: 'future version',
      value: JSON.stringify({
        version: 2,
        disabledExtensionIds: [],
        enabledCatalogExtensionIds: [],
        grants: {},
      }),
      pattern: /Unsupported or malformed/,
    },
    {
      name: 'conflicting activation',
      value: JSON.stringify({
        version: 1,
        disabledExtensionIds: ['conflict'],
        enabledCatalogExtensionIds: ['conflict'],
        grants: {},
      }),
      pattern: /enables a disabled extension/,
    },
    {
      name: 'unknown capability',
      value: JSON.stringify({
        version: 1,
        disabledExtensionIds: [],
        enabledCatalogExtensionIds: [],
        grants: { extension: ['root-access'] },
      }),
      pattern: /Invalid extension capability grant state/,
    },
    {
      name: 'duplicate id',
      value: JSON.stringify({
        version: 1,
        disabledExtensionIds: ['duplicate', 'duplicate'],
        enabledCatalogExtensionIds: [],
        grants: {},
      }),
      pattern: /Invalid disabled extension state/,
    },
    {
      name: 'entry bound',
      value: JSON.stringify({
        version: 1,
        disabledExtensionIds: Array.from(
          { length: 1025 },
          (_, index) => `extension-${index}`,
        ),
        enabledCatalogExtensionIds: [],
        grants: {},
      }),
      pattern: /Invalid disabled extension state/,
    },
    {
      name: 'byte bound',
      value: ' '.repeat(4 * 1024 * 1024 + 1),
      pattern: /Invalid security-state file/,
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const home = await mkdtemp(join(tmpdir(), 'codesurf-security-invalid-'))
      await fs.writeFile(
        join(home, EXTENSION_SECURITY_STATE_FILENAME),
        fixture.value,
      )
      await assert.rejects(loadExtensionSecurityState(home), fixture.pattern)
    })
  }
})

test('a malformed journal blocks activation even when the main snapshot is valid', async () => {
  const home = await freshStateHome('codesurf-security-journal-invalid-')
  await fs.writeFile(
    join(home, EXTENSION_SECURITY_JOURNAL_FILENAME),
    JSON.stringify({ version: 99 }),
  )
  await assert.rejects(
    loadExtensionSecurityState(home),
    /Unsupported or malformed extension security journal/,
  )
})

test('state reads reject symlinked and identity-swapped home directories', {
  concurrency: false,
}, async t => {
  await t.test('symlinked home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codesurf-security-read-link-'))
    const realHome = join(root, 'real-home')
    const linkedHome = join(root, 'linked-home')
    await fs.mkdir(realHome)
    await persistExtensionSecurityState(realHome, BASE_STATE, BASE_STATE)
    await fs.symlink(realHome, linkedHome)
    await assert.rejects(
      loadExtensionSecurityState(linkedHome),
      /unsafe ancestor|not canonical/,
    )
  })

  await t.test('home identity swap during read', async () => {
    const home = await freshStateHome('codesurf-security-read-swap-')
    const displacedHome = `${home}-displaced`
    const originalOpen = fs.open
    let swapped = false
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (
        !swapped
        && basename(String(args[0])) === EXTENSION_SECURITY_STATE_FILENAME
      ) {
        swapped = true
        await fs.rename(home, displacedHome)
        await fs.mkdir(home)
        const replacement = await originalOpen(
          join(home, EXTENSION_SECURITY_STATE_FILENAME),
          'w',
          0o600,
        )
        try {
          await replacement.writeFile(`${JSON.stringify(GRANTED_STATE)}\n`)
        } finally {
          await replacement.close()
        }
      }
      return handle
    }) as typeof fs.open
    try {
      await assert.rejects(
        loadExtensionSecurityState(home),
        /read parent changed|file changed while reading/,
      )
    } finally {
      fs.open = originalOpen
    }
    assert.equal(swapped, true)
  })
})

test('crash before the pending journal commit leaves the prior state authoritative', {
  concurrency: false,
}, async () => {
  const home = await freshStateHome('codesurf-security-crash-pending-')
  const originalRename = fs.rename
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    if (basename(String(args[1])) === EXTENSION_SECURITY_JOURNAL_FILENAME) {
      throw new Error('pending journal crash')
    }
    return originalRename(...args)
  }) as typeof fs.rename
  try {
    await assert.rejects(
      persistExtensionSecurityState(home, BASE_STATE, GRANTED_STATE),
      /pending journal crash/,
    )
  } finally {
    fs.rename = originalRename
  }
  assert.deepEqual(await loadExtensionSecurityState(home), BASE_STATE)
})

test('pending journal rolls back a main-snapshot rename or sync uncertainty', {
  concurrency: false,
}, async t => {
  await t.test('main rename', async () => {
    const home = await freshStateHome('codesurf-security-crash-main-rename-')
    const originalRename = fs.rename
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      if (basename(String(args[1])) === EXTENSION_SECURITY_STATE_FILENAME) {
        throw new Error('main snapshot crash')
      }
      return originalRename(...args)
    }) as typeof fs.rename
    try {
      await assert.rejects(
        persistExtensionSecurityState(home, BASE_STATE, GRANTED_STATE),
        /main snapshot crash/,
      )
    } finally {
      fs.rename = originalRename
    }
    assert.equal(
      JSON.parse(
        await fs.readFile(join(home, EXTENSION_SECURITY_JOURNAL_FILENAME), 'utf8'),
      ).phase,
      'pending',
    )
    assert.deepEqual(await loadExtensionSecurityState(home), BASE_STATE)
  })

  await t.test('main directory sync', async () => {
    const home = await freshStateHome('codesurf-security-crash-main-sync-')
    const canonicalHome = await fs.realpath(home)
    const originalOpen = fs.open
    const originalRename = fs.rename
    let lastRename = ''
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      const result = await originalRename(...args)
      lastRename = basename(String(args[1]))
      return result
    }) as typeof fs.rename
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (
        String(args[0]) === canonicalHome
        && lastRename === EXTENSION_SECURITY_STATE_FILENAME
      ) {
        handle.sync = async () => {
          throw new Error('main directory sync crash')
        }
      }
      return handle
    }) as typeof fs.open
    try {
      await assert.rejects(
        persistExtensionSecurityState(home, BASE_STATE, GRANTED_STATE),
        /main directory sync crash/,
      )
    } finally {
      fs.open = originalOpen
      fs.rename = originalRename
    }
    assert.deepEqual(await loadExtensionSecurityState(home), BASE_STATE)
  })
})

test('pending and committed journal phases recover conservatively at later crash points', {
  concurrency: false,
}, async t => {
  await t.test('committed-marker write fails', async () => {
    const home = await freshStateHome('codesurf-security-crash-commit-')
    const originalRename = fs.rename
    let journalRenames = 0
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      if (basename(String(args[1])) === EXTENSION_SECURITY_JOURNAL_FILENAME) {
        journalRenames += 1
        if (journalRenames === 2) throw new Error('committed marker crash')
      }
      return originalRename(...args)
    }) as typeof fs.rename
    try {
      await assert.rejects(
        persistExtensionSecurityState(home, BASE_STATE, GRANTED_STATE),
        /committed marker crash/,
      )
    } finally {
      fs.rename = originalRename
    }
    assert.deepEqual(await loadExtensionSecurityState(home), BASE_STATE)
  })

  await t.test('journal cleanup fails after commit', async () => {
    const home = await freshStateHome('codesurf-security-crash-cleanup-')
    const originalUnlink = fs.unlink
    fs.unlink = (async (...args: Parameters<typeof fs.unlink>) => {
      if (basename(String(args[0])) === EXTENSION_SECURITY_JOURNAL_FILENAME) {
        throw new Error('journal cleanup crash')
      }
      return originalUnlink(...args)
    }) as typeof fs.unlink
    try {
      await assert.rejects(
        persistExtensionSecurityState(home, BASE_STATE, GRANTED_STATE),
        /journal cleanup crash/,
      )
    } finally {
      fs.unlink = originalUnlink
    }
    assert.equal(
      JSON.parse(
        await fs.readFile(join(home, EXTENSION_SECURITY_JOURNAL_FILENAME), 'utf8'),
      ).phase,
      'committed',
    )
    assert.deepEqual(await loadExtensionSecurityState(home), GRANTED_STATE)
  })
})
