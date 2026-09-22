import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildSafeSpawnEnv,
  resolveManagedLocalProxySpawnEnvironment,
  SPAWN_ENV_ALLOWLIST,
  SPAWN_ENV_DENYLIST_RE,
  shouldForwardTmuxEnvironment,
} from '../src/main/ipc/terminal-helpers.ts'

describe('managed local-proxy terminal environment', () => {
  it('starts the runtime and injects only the scoped endpoint and bearer', async () => {
    const calls: Array<number | undefined> = []
    const resolved = await resolveManagedLocalProxySpawnEnvironment(
      { localProxyEnabled: true, localProxyPort: 1777 },
      {
        ensureRunning: async port => {
          calls.push(port)
          return { ok: true, port }
        },
        getStatus: () => ({ running: true, port: 1777, token: 'runtime-token' }),
      },
    )
    assert.deepEqual(calls, [1777])
    assert.deepEqual(resolved, {
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1777/v1',
        ANTHROPIC_AUTH_TOKEN: 'runtime-token',
      },
      token: 'runtime-token',
    })
    assert.equal(shouldForwardTmuxEnvironment('ANTHROPIC_BASE_URL'), true)
    assert.equal(shouldForwardTmuxEnvironment('ANTHROPIC_AUTH_TOKEN'), true)
    assert.equal(shouldForwardTmuxEnvironment('ANTHROPIC_API_KEY'), false)
    assert.equal(shouldForwardTmuxEnvironment('GITHUB_TOKEN'), false)
  })

  it('fails closed when startup or runtime bearer proof is absent', async () => {
    await assert.rejects(resolveManagedLocalProxySpawnEnvironment(
      { localProxyEnabled: true },
      {
        ensureRunning: async () => ({ ok: false, message: 'listen failed' }),
        getStatus: () => ({ running: false, port: 1337, token: null }),
      },
    ), /listen failed/)

    await assert.rejects(resolveManagedLocalProxySpawnEnvironment(
      { localProxyEnabled: true },
      {
        ensureRunning: async () => ({ ok: true, port: 1337 }),
        getStatus: () => ({ running: true, port: 1337, token: null }),
      },
    ), /not running/)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a controlled source env so tests are deterministic. */
function makeSourceEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/testuser',
    SHELL: '/bin/zsh',
    USER: 'testuser',
    LOGNAME: 'testuser',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    EDITOR: 'vim',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    NVM_DIR: '/home/testuser/.nvm',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    // Secrets that MUST be stripped
    ANTHROPIC_API_KEY: 'sk-ant-secret-123',
    OPENAI_SECRET: 'sk-openai-secret',
    GITHUB_TOKEN: 'ghp_secrettoken',
    AWS_PASSWORD: 'aws-pass-123',
    STRIPE_PRIVATE_KEY: 'sk_live_secret',
    MY_SERVICE_CREDENTIALS: 'cred-xyz',
    // Non-allowlisted benign vars
    NODE_ENV: 'development',
    DEBUG: 'true',
    CUSTOM_APP_SETTING: 'foobar',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Allowlist: keeps essential environment variables
// ---------------------------------------------------------------------------

describe('buildSafeSpawnEnv — keeps allowlisted vars', () => {
  it('keeps PATH', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin')
  })

  it('keeps HOME', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.HOME, '/home/testuser')
  })

  it('keeps SHELL', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.SHELL, '/bin/zsh')
  })

  it('keeps USER', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.USER, 'testuser')
  })

  it('keeps LANG', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.LANG, 'en_US.UTF-8')
  })

  it('keeps LC_ALL', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.LC_ALL, 'en_US.UTF-8')
  })

  it('keeps TERM', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.TERM, 'xterm-256color')
  })

  it('keeps TMPDIR', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.TMPDIR, '/tmp')
  })

  it('keeps EDITOR', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.EDITOR, 'vim')
  })

  it('keeps SSH_AUTH_SOCK', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.SSH_AUTH_SOCK, '/tmp/ssh-agent.sock')
  })

  it('keeps NVM_DIR', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.NVM_DIR, '/home/testuser/.nvm')
  })

  it('keeps GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.GIT_AUTHOR_NAME, 'Test User')
    assert.equal(env.GIT_AUTHOR_EMAIL, 'test@example.com')
  })
})

// ---------------------------------------------------------------------------
// Denylist: strips secrets
// ---------------------------------------------------------------------------

describe('buildSafeSpawnEnv — strips secret vars', () => {
  it('strips ANTHROPIC_API_KEY', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
  })

  it('strips OPENAI_SECRET', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.OPENAI_SECRET, undefined)
  })

  it('strips GITHUB_TOKEN', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.GITHUB_TOKEN, undefined)
  })

  it('strips AWS_PASSWORD', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.AWS_PASSWORD, undefined)
  })

  it('strips STRIPE_PRIVATE_KEY', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.STRIPE_PRIVATE_KEY, undefined)
  })

  it('strips MY_SERVICE_CREDENTIALS', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.MY_SERVICE_CREDENTIALS, undefined)
  })

  it('strips a custom var ending in _API_KEY', () => {
    const source = makeSourceEnv({ CUSTOM_PROVIDER_API_KEY: 'secret' })
    const env = buildSafeSpawnEnv({}, source)
    assert.equal(env.CUSTOM_PROVIDER_API_KEY, undefined)
  })

  it('strips a custom var ending in _SECRET', () => {
    const source = makeSourceEnv({ MY_APP_SECRET: 'hidden' })
    const env = buildSafeSpawnEnv({}, source)
    assert.equal(env.MY_APP_SECRET, undefined)
  })

  it('strips a custom var ending in _TOKEN', () => {
    const source = makeSourceEnv({ DEPLOY_TOKEN: 'tok-123' })
    const env = buildSafeSpawnEnv({}, source)
    assert.equal(env.DEPLOY_TOKEN, undefined)
  })

  it('strips a custom var ending in _PASSWORD', () => {
    const source = makeSourceEnv({ DB_PASSWORD: 'p@ss' })
    const env = buildSafeSpawnEnv({}, source)
    assert.equal(env.DB_PASSWORD, undefined)
  })

  it('strips a custom var ending in _PRIVATE_KEY', () => {
    const source = makeSourceEnv({ JWT_PRIVATE_KEY: 'key-data' })
    const env = buildSafeSpawnEnv({}, source)
    assert.equal(env.JWT_PRIVATE_KEY, undefined)
  })

  it('denylist matching is case-insensitive', () => {
    assert.equal(SPAWN_ENV_DENYLIST_RE.test('MY_api_key'), true)
    assert.equal(SPAWN_ENV_DENYLIST_RE.test('MY_Api_Key'), true)
    assert.equal(SPAWN_ENV_DENYLIST_RE.test('MY_API_KEY'), true)
  })
})

// ---------------------------------------------------------------------------
// Non-allowlisted benign vars are dropped (allowlist is the primary gate)
// ---------------------------------------------------------------------------

describe('buildSafeSpawnEnv — drops non-allowlisted vars', () => {
  it('drops NODE_ENV even though it is not a secret', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.NODE_ENV, undefined)
  })

  it('drops DEBUG', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.DEBUG, undefined)
  })

  it('drops CUSTOM_APP_SETTING', () => {
    const env = buildSafeSpawnEnv({}, makeSourceEnv())
    assert.equal(env.CUSTOM_APP_SETTING, undefined)
  })
})

// ---------------------------------------------------------------------------
// Extra params are merged
// ---------------------------------------------------------------------------

describe('buildSafeSpawnEnv — merges extra params', () => {
  it('adds CARD_ID from extra', () => {
    const env = buildSafeSpawnEnv({ CARD_ID: 'tile-42' }, makeSourceEnv())
    assert.equal(env.CARD_ID, 'tile-42')
  })

  it('adds CODESURF_DIR from extra', () => {
    const env = buildSafeSpawnEnv(
      { CODESURF_DIR: '/workspaces/project/.codesurf/tile-1' },
      makeSourceEnv(),
    )
    assert.equal(env.CODESURF_DIR, '/workspaces/project/.codesurf/tile-1')
  })

  it('adds multiple extra vars at once', () => {
    const env = buildSafeSpawnEnv(
      { CARD_ID: 'tile-7', CODESURF_DIR: '/tmp/.contex', COLLAB_DIR: '/tmp/.contex' },
      makeSourceEnv(),
    )
    assert.equal(env.CARD_ID, 'tile-7')
    assert.equal(env.CODESURF_DIR, '/tmp/.contex')
    assert.equal(env.COLLAB_DIR, '/tmp/.contex')
  })

  it('extra vars override allowlisted source vars of the same name', () => {
    const env = buildSafeSpawnEnv(
      { HOME: '/override/home' },
      makeSourceEnv(),
    )
    assert.equal(env.HOME, '/override/home')
  })

  it('still keeps allowlisted vars alongside extras', () => {
    const env = buildSafeSpawnEnv({ CARD_ID: 'tile-1' }, makeSourceEnv())
    assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin')
    assert.equal(env.SHELL, '/bin/zsh')
    assert.equal(env.CARD_ID, 'tile-1')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('buildSafeSpawnEnv — edge cases', () => {
  it('returns only extras when source env is empty', () => {
    const env = buildSafeSpawnEnv({ CARD_ID: 'x' }, {})
    assert.deepEqual(env, { CARD_ID: 'x' })
  })

  it('returns an empty object when both source and extras are empty', () => {
    const env = buildSafeSpawnEnv({}, {})
    assert.deepEqual(env, {})
  })

  it('handles undefined values in source env gracefully', () => {
    const source: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      UNDEFINED_VAR: undefined,
    }
    const env = buildSafeSpawnEnv({}, source as Record<string, string>)
    assert.equal(env.PATH, '/usr/bin')
    assert.equal(env.UNDEFINED_VAR, undefined)
  })

  it('does not mutate the source env', () => {
    const source = makeSourceEnv()
    const before = { ...source }
    buildSafeSpawnEnv({ CARD_ID: 'tile-1' }, source)
    assert.deepEqual(source, before)
  })

  it('does not mutate the extra object', () => {
    const extra = { CARD_ID: 'tile-1' }
    const before = { ...extra }
    buildSafeSpawnEnv(extra, makeSourceEnv())
    assert.deepEqual(extra, before)
  })
})

// ---------------------------------------------------------------------------
// Denylist regex unit tests
// ---------------------------------------------------------------------------

describe('SPAWN_ENV_DENYLIST_RE — pattern coverage', () => {
  const shouldMatch = [
    'ANTHROPIC_API_KEY',
    'OPENAI_SECRET',
    'GITHUB_TOKEN',
    'AWS_PASSWORD',
    'STRIPE_PRIVATE_KEY',
    'SOME_CREDENTIALS',
    'MY_api_key',
    'x_Token',
    'a_secret',
    'b_password',
    'c_private_key',
    'd_credentials',
  ]

  for (const name of shouldMatch) {
    it(`matches "${name}"`, () => {
      assert.equal(SPAWN_ENV_DENYLIST_RE.test(name), true)
    })
  }

  const shouldNotMatch = [
    'PATH',
    'HOME',
    'SHELL',
    'API_KEYRING',      // _API_KEY is not at end
    'SECRET_MANAGER',   // _SECRET is not at end
    'TOKEN_BUCKET',     // _TOKEN is not at end
    'PASSWORD_HASH_FN', // _PASSWORD is not at end
    'MY_TOKENIZER',     // ends in _IZER not _TOKEN
  ]

  for (const name of shouldNotMatch) {
    it(`does not match "${name}"`, () => {
      assert.equal(SPAWN_ENV_DENYLIST_RE.test(name), false)
    })
  }
})

// ---------------------------------------------------------------------------
// Allowlist sanity checks
// ---------------------------------------------------------------------------

describe('SPAWN_ENV_ALLOWLIST — contains expected vars', () => {
  const expected = [
    'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
    'TMPDIR', 'TEMP', 'TMP',
    'EDITOR', 'VISUAL',
    'NVM_DIR', 'NVM_BIN', 'FNM_DIR', 'VOLTA_HOME',
    'SSH_AUTH_SOCK',
  ]

  for (const key of expected) {
    it(`includes "${key}"`, () => {
      assert.equal(SPAWN_ENV_ALLOWLIST.has(key), true)
    })
  }

  it('does not include ANTHROPIC_API_KEY', () => {
    assert.equal(SPAWN_ENV_ALLOWLIST.has('ANTHROPIC_API_KEY'), false)
  })

  it('does not include NODE_ENV', () => {
    assert.equal(SPAWN_ENV_ALLOWLIST.has('NODE_ENV'), false)
  })
})
