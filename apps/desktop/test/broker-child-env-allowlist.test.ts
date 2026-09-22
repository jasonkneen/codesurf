import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildBrokerChildEnv, BROKER_CHILD_ENV_ALLOWLIST } from '../src/main/extensions/broker/policy.ts'

const realisticParentEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/dev',
  SHELL: '/bin/zsh',
  CODESURF_HOME: '/Users/dev/.codesurf',
  CI: 'false',
  LANG: 'en_GB.UTF-8',
  // Credentials that must never reach a third-party extension
  AI_GATEWAY_API_KEY: 'vck_live_should_not_leak',
  ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
  OPENAI_API_KEY: 'sk-should-not-leak',
  GITHUB_TOKEN: 'ghp_should_not_leak',
  AWS_SECRET_ACCESS_KEY: 'aws-should-not-leak',
  DATABASE_PASSWORD: 'hunter2',
  SOME_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
  npm_config_registry: 'https://registry.npmjs.org',
}

describe('buildBrokerChildEnv', () => {
  const env = buildBrokerChildEnv(realisticParentEnv, { CODESURF_BROKER_CHILD: '1' })

  it('leaks no credential value whatsoever', () => {
    const serialized = JSON.stringify(env)
    for (const secret of [
      'vck_live_should_not_leak', 'sk-ant-should-not-leak', 'sk-should-not-leak',
      'ghp_should_not_leak', 'aws-should-not-leak', 'hunter2', 'BEGIN PRIVATE KEY',
    ]) {
      assert.equal(serialized.includes(secret), false, `${secret} reached the extension child`)
    }
  })

  it('drops the credential variable names entirely', () => {
    for (const name of [
      'AI_GATEWAY_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
      'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_PASSWORD', 'SOME_PRIVATE_KEY',
    ]) {
      assert.equal(name in env, false, `${name} must not be forwarded`)
    }
  })

  it('forwards what bundled extensions actually read', () => {
    // livekit-rooms reads PATH and SHELL, code-index reads CODESURF_HOME,
    // test-loop reads CI.
    assert.equal(env.PATH, '/usr/bin:/bin')
    assert.equal(env.SHELL, '/bin/zsh')
    assert.equal(env.CODESURF_HOME, '/Users/dev/.codesurf')
    assert.equal(env.CI, 'false')
    assert.equal(env.HOME, '/Users/dev')
  })

  it('applies the extra vars the broker sets', () => {
    assert.equal(env.CODESURF_BROKER_CHILD, '1')
  })

  it('drops unlisted variables', () => {
    assert.equal('npm_config_registry' in env, false)
  })

  it('omits allow-listed names that are absent from the parent', () => {
    assert.equal('WINDIR' in env, false)
  })

  it('defends in depth: a secret-shaped name on the allow-list is still dropped', () => {
    const withSecretName = buildBrokerChildEnv(
      { ...realisticParentEnv, CODESURF_HOME: '/ok' },
      {},
    )
    // Every forwarded name must fail the credential pattern.
    for (const name of Object.keys(withSecretName)) {
      assert.equal(
        /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i.test(name),
        false,
        `${name} looks like a credential and must not be forwarded`,
      )
    }
  })

  it('the allow-list itself contains no credential-shaped entry', () => {
    for (const name of BROKER_CHILD_ENV_ALLOWLIST) {
      assert.equal(
        /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name),
        false,
        `allow-list entry ${name} is credential-shaped`,
      )
    }
  })
})
