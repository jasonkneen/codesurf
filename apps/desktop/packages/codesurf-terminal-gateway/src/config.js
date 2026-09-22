import { createHash, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'

const DEFAULT_LIMITS = Object.freeze({
  bodyBytes: 64 * 1024,
  messageBytes: 64 * 1024,
  inputBytes: 16 * 1024,
  outputBacklogBytes: 512 * 1024,
  outboundHighWaterBytes: 256 * 1024,
  sessionTtlMs: 30 * 60_000,
  attachTtlMs: 30_000,
  closeGraceMs: 1_000,
  maxSessions: 100,
  maxSessionsPerTenant: 10,
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 300,
})

const TOKEN_HASH_BYTES = 32

export class GatewayConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GatewayConfigError'
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayConfigError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function parsePositiveInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const source = typeof value === 'number' ? value : String(value).trim()
  const parsed = typeof source === 'number'
    ? source
    : /^\d+$/.test(source)
      ? Number(source)
      : Number.NaN
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new GatewayConfigError(`${name} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function parseDuration(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return parsePositiveInteger(value, name, { min: 1, max: 24 * 60 * 60 * 1000 })
}

function parseByteLimit(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return parsePositiveInteger(value, name, { min: 1024, max: 16 * 1024 * 1024 })
}

function parseBoolean(value, name) {
  if (value === true || value === '1' || value === 'true') return true
  if (value === false || value === undefined || value === null || value === '' || value === '0' || value === 'false') return false
  throw new GatewayConfigError(`${name} must be true/false or 1/0`)
}

function parseJson(value, name) {
  try {
    return JSON.parse(value)
  } catch {
    throw new GatewayConfigError(`${name} must contain valid JSON`)
  }
}

export function normalizeOrigin(value) {
  const input = requireString(value, 'origin')
  if (input === '*' || input === 'null') throw new GatewayConfigError('wildcard and null origins are not allowed')

  let parsed
  try {
    parsed = new URL(input)
  } catch {
    throw new GatewayConfigError(`origin is not a valid URL: ${input}`)
  }

  if (!parsed.protocol || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new GatewayConfigError(`origin must be scheme, host, and optional port only: ${input}`)
  }
  return `${parsed.protocol}//${parsed.host}`
}

function parseOrigins(value, name) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
      : []
  if (entries.length === 0) throw new GatewayConfigError(`${name} must include at least one origin`)
  return [...new Set(entries.map(normalizeOrigin))]
}

function normalizeRoots(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GatewayConfigError(`${name} must include at least one absolute filesystem root`)
  }
  return value.map((root) => {
    const path = requireString(root, `${name} entry`)
    if (!isAbsolute(path)) throw new GatewayConfigError(`${name} entries must be absolute paths`)
    return path
  })
}

function normalizeWorkspaces(value, name) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayConfigError(`${name} must be an object mapping workspace ids to absolute paths`)
  }

  return Object.fromEntries(Object.entries(value).map(([id, root]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new GatewayConfigError(`${name} workspace ids may only contain letters, numbers, dot, underscore, and hyphen`)
    }
    const path = requireString(root, `${name}.${id}`)
    if (!isAbsolute(path)) throw new GatewayConfigError(`${name}.${id} must be an absolute path`)
    return [id, path]
  }))
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest()
}

function normalizeTenants(rawTenants, { globalToken, globalOrigins }) {
  const source = Array.isArray(rawTenants)
    ? rawTenants.map((tenant) => [tenant?.id, tenant])
    : rawTenants && typeof rawTenants === 'object'
      ? Object.entries(rawTenants)
      : null

  if (!source || source.length === 0) {
    throw new GatewayConfigError('CODESURF_TERMINAL_TENANTS_JSON must map at least one tenant to roots and a bearer token')
  }

  const ids = new Set()
  const hashes = new Set()
  return source.map(([key, rawTenant]) => {
    if (!rawTenant || typeof rawTenant !== 'object' || Array.isArray(rawTenant)) {
      throw new GatewayConfigError('each tenant configuration must be an object')
    }
    const id = requireString(rawTenant.id ?? key, 'tenant id')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new GatewayConfigError(`tenant id ${id} is invalid`)
    }
    if (ids.has(id)) throw new GatewayConfigError(`tenant id ${id} is duplicated`)
    ids.add(id)

    if (globalToken && rawTenant.bearerToken && rawTenant.bearerToken !== globalToken) {
      throw new GatewayConfigError(`tenant ${id} bearerToken must match CODESURF_TERMINAL_TOKEN when a runtime token is configured`)
    }
    const bearerToken = requireString(rawTenant.bearerToken ?? globalToken, `tenant ${id} bearerToken`)
    if (bearerToken.length < 16) {
      throw new GatewayConfigError(`tenant ${id} bearerToken must be at least 16 characters`)
    }
    const hash = tokenHash(bearerToken)
    const hashKey = hash.toString('hex')
    if (hashes.has(hashKey)) throw new GatewayConfigError('tenant bearer tokens must be unique')
    hashes.add(hashKey)

    const tenantOrigins = rawTenant.origins === undefined
      ? globalOrigins
      : intersectOrigins(globalOrigins, parseOrigins(rawTenant.origins, `tenant ${id} origins`))
    if (tenantOrigins.length === 0) {
      throw new GatewayConfigError(`tenant ${id} has no origin permitted by CODESURF_TERMINAL_ALLOWED_ORIGINS`)
    }

    return {
      id,
      bearerToken,
      bearerTokenHash: hash,
      roots: normalizeRoots(rawTenant.roots, `tenant ${id} roots`),
      workspaces: normalizeWorkspaces(rawTenant.workspaces, `tenant ${id} workspaces`),
      allowedOrigins: new Set(tenantOrigins),
    }
  })
}

function intersectOrigins(left, right) {
  const allowed = new Set(right)
  return left.filter((origin) => allowed.has(origin))
}

function normalizePublicUrl(value) {
  if (value === undefined || value === null || value === '') return null
  const raw = requireString(value, 'CODESURF_TERMINAL_PUBLIC_URL')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new GatewayConfigError('CODESURF_TERMINAL_PUBLIC_URL must be a valid http(s) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new GatewayConfigError('CODESURF_TERMINAL_PUBLIC_URL must be an http(s) origin or path prefix without credentials/query/hash')
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}

function parseShellArgs(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  const args = typeof value === 'string' ? parseJson(value, name) : value
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new GatewayConfigError(`${name} must be a JSON array of strings`)
  }
  return args
}

function normalizeAdapter(raw = {}, env = process.env) {
  const type = raw.type ?? env.CODESURF_TERMINAL_ADAPTER ?? 'local'
  if (type !== 'local' && type !== 'docker') {
    throw new GatewayConfigError('CODESURF_TERMINAL_ADAPTER must be local or docker')
  }

  const localSource = raw.local ?? raw
  const dockerSource = raw.docker ?? {}
  const local = {
    shell: localSource.shell ?? env.CODESURF_TERMINAL_SHELL,
    shellArgs: parseShellArgs(localSource.shellArgs ?? env.CODESURF_TERMINAL_SHELL_ARGS, 'CODESURF_TERMINAL_SHELL_ARGS'),
    home: localSource.home ?? env.CODESURF_TERMINAL_HOME,
  }

  const dockerEnabled = parseBoolean(raw.dockerEnabled ?? dockerSource.enabled ?? env.CODESURF_TERMINAL_ENABLE_DOCKER, 'CODESURF_TERMINAL_ENABLE_DOCKER')
  const docker = {
    enabled: dockerEnabled,
    binary: dockerSource.binary ?? env.CODESURF_TERMINAL_DOCKER_BIN ?? 'docker',
    image: dockerSource.image ?? env.CODESURF_TERMINAL_DOCKER_IMAGE,
    shell: dockerSource.shell ?? env.CODESURF_TERMINAL_DOCKER_SHELL ?? '/bin/sh',
    shellArgs: parseShellArgs(dockerSource.shellArgs ?? env.CODESURF_TERMINAL_DOCKER_SHELL_ARGS, 'CODESURF_TERMINAL_DOCKER_SHELL_ARGS') ?? ['-l'],
    memory: dockerSource.memory ?? env.CODESURF_TERMINAL_DOCKER_MEMORY ?? '1g',
    cpus: dockerSource.cpus ?? env.CODESURF_TERMINAL_DOCKER_CPUS ?? '1',
    pidsLimit: parsePositiveInteger(dockerSource.pidsLimit ?? env.CODESURF_TERMINAL_DOCKER_PIDS_LIMIT ?? 256, 'CODESURF_TERMINAL_DOCKER_PIDS_LIMIT', { min: 16, max: 4_096 }),
    user: dockerSource.user ?? env.CODESURF_TERMINAL_DOCKER_USER,
  }

  if (type === 'docker') {
    if (!docker.enabled) {
      throw new GatewayConfigError('Docker adapter is disabled. Set CODESURF_TERMINAL_ENABLE_DOCKER=1 explicitly to enable it.')
    }
    requireString(docker.image, 'CODESURF_TERMINAL_DOCKER_IMAGE')
  }

  return { type, local, docker }
}

function normalizeLimits(raw = {}, env = process.env) {
  const messageBytes = parseByteLimit(raw.messageBytes ?? env.CODESURF_TERMINAL_MESSAGE_BYTES, 'CODESURF_TERMINAL_MESSAGE_BYTES', DEFAULT_LIMITS.messageBytes)
  const outputBacklogBytes = parseByteLimit(raw.outputBacklogBytes ?? env.CODESURF_TERMINAL_OUTPUT_BACKLOG_BYTES, 'CODESURF_TERMINAL_OUTPUT_BACKLOG_BYTES', DEFAULT_LIMITS.outputBacklogBytes)
  const limits = {
    bodyBytes: parseByteLimit(raw.bodyBytes ?? env.CODESURF_TERMINAL_BODY_BYTES, 'CODESURF_TERMINAL_BODY_BYTES', DEFAULT_LIMITS.bodyBytes),
    messageBytes,
    inputBytes: parseByteLimit(raw.inputBytes ?? env.CODESURF_TERMINAL_INPUT_BYTES, 'CODESURF_TERMINAL_INPUT_BYTES', Math.min(DEFAULT_LIMITS.inputBytes, messageBytes)),
    outputBacklogBytes,
    outboundHighWaterBytes: parseByteLimit(raw.outboundHighWaterBytes ?? env.CODESURF_TERMINAL_OUTBOUND_HIGH_WATER_BYTES, 'CODESURF_TERMINAL_OUTBOUND_HIGH_WATER_BYTES', Math.min(DEFAULT_LIMITS.outboundHighWaterBytes, outputBacklogBytes)),
    sessionTtlMs: parseDuration(raw.sessionTtlMs ?? env.CODESURF_TERMINAL_SESSION_TTL_MS, 'CODESURF_TERMINAL_SESSION_TTL_MS', DEFAULT_LIMITS.sessionTtlMs),
    attachTtlMs: parseDuration(raw.attachTtlMs ?? env.CODESURF_TERMINAL_ATTACH_TTL_MS, 'CODESURF_TERMINAL_ATTACH_TTL_MS', DEFAULT_LIMITS.attachTtlMs),
    closeGraceMs: parseDuration(raw.closeGraceMs ?? env.CODESURF_TERMINAL_CLOSE_GRACE_MS, 'CODESURF_TERMINAL_CLOSE_GRACE_MS', DEFAULT_LIMITS.closeGraceMs),
    maxSessions: parsePositiveInteger(raw.maxSessions ?? env.CODESURF_TERMINAL_MAX_SESSIONS ?? DEFAULT_LIMITS.maxSessions, 'CODESURF_TERMINAL_MAX_SESSIONS', { min: 1, max: 10_000 }),
    maxSessionsPerTenant: parsePositiveInteger(raw.maxSessionsPerTenant ?? env.CODESURF_TERMINAL_MAX_SESSIONS_PER_TENANT ?? DEFAULT_LIMITS.maxSessionsPerTenant, 'CODESURF_TERMINAL_MAX_SESSIONS_PER_TENANT', { min: 1, max: 1_000 }),
    minCols: DEFAULT_LIMITS.minCols,
    maxCols: DEFAULT_LIMITS.maxCols,
    minRows: DEFAULT_LIMITS.minRows,
    maxRows: DEFAULT_LIMITS.maxRows,
  }
  if (limits.inputBytes > limits.messageBytes) {
    throw new GatewayConfigError('inputBytes cannot exceed messageBytes')
  }
  if (limits.outboundHighWaterBytes > limits.outputBacklogBytes) {
    throw new GatewayConfigError('outboundHighWaterBytes cannot exceed outputBacklogBytes')
  }
  return limits
}

function normalizeRuntimeConfigPath(value) {
  if (value === undefined || value === null || value === '') return null
  const path = requireString(value, 'CODESURF_TERMINAL_RUNTIME_CONFIG_PATH')
  if (!isAbsolute(path)) throw new GatewayConfigError('CODESURF_TERMINAL_RUNTIME_CONFIG_PATH must be an absolute path')
  return path
}

/**
 * Reads the deployable gateway configuration. The raw bearer token is kept only
 * long enough for the launch/runtime-config contract; authentication compares
 * SHA-256 digests using timingSafeEqual.
 */
export function createGatewayConfig(env = process.env) {
  const rawTenants = parseJson(requireString(env.CODESURF_TERMINAL_TENANTS_JSON, 'CODESURF_TERMINAL_TENANTS_JSON'), 'CODESURF_TERMINAL_TENANTS_JSON')
  const globalToken = env.CODESURF_TERMINAL_TOKEN === undefined ? undefined : requireString(env.CODESURF_TERMINAL_TOKEN, 'CODESURF_TERMINAL_TOKEN')
  const globalOrigins = parseOrigins(requireString(env.CODESURF_TERMINAL_ALLOWED_ORIGINS, 'CODESURF_TERMINAL_ALLOWED_ORIGINS'), 'CODESURF_TERMINAL_ALLOWED_ORIGINS')
  const tenants = normalizeTenants(rawTenants, { globalToken, globalOrigins })
  const runtimeToken = globalToken || (tenants.length === 1 ? tenants[0].bearerToken : null)

  return {
    bindHost: env.CODESURF_TERMINAL_GATEWAY_BIND ?? env.CODESURF_TERMINAL_BIND_HOST ?? '127.0.0.1',
    port: parsePositiveInteger(env.CODESURF_TERMINAL_GATEWAY_PORT ?? env.CODESURF_TERMINAL_PORT ?? 0, 'CODESURF_TERMINAL_GATEWAY_PORT', { min: 0, max: 65_535 }),
    publicUrl: normalizePublicUrl(env.CODESURF_TERMINAL_PUBLIC_URL),
    runtimeConfigPath: normalizeRuntimeConfigPath(env.CODESURF_TERMINAL_RUNTIME_CONFIG_PATH),
    runtimeToken,
    allowedOrigins: globalOrigins,
    tenants,
    adapter: normalizeAdapter({}, env),
    limits: normalizeLimits({}, env),
  }
}

/** Supports explicit configuration in integration tests and embedding hosts. */
export function normalizeGatewayConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new GatewayConfigError('gateway config must be an object')
  }
  const globalOrigins = parseOrigins(rawConfig.allowedOrigins, 'allowedOrigins')
  const configuredToken = rawConfig.runtimeToken ?? rawConfig.token
  const globalToken = configuredToken === undefined || configuredToken === null
    ? undefined
    : requireString(configuredToken, 'runtimeToken')
  const tenants = normalizeTenants(rawConfig.tenants, { globalToken, globalOrigins })
  const runtimeToken = globalToken ?? (tenants.length === 1 ? tenants[0].bearerToken : null)
  return {
    bindHost: requireString(rawConfig.bindHost ?? '127.0.0.1', 'bindHost'),
    port: parsePositiveInteger(rawConfig.port ?? 0, 'port', { min: 0, max: 65_535 }),
    publicUrl: normalizePublicUrl(rawConfig.publicUrl),
    runtimeConfigPath: normalizeRuntimeConfigPath(rawConfig.runtimeConfigPath),
    runtimeToken,
    allowedOrigins: globalOrigins,
    tenants,
    adapter: normalizeAdapter(rawConfig.adapter, {}),
    limits: normalizeLimits(rawConfig.limits, {}),
  }
}

export function bearerMatchesTenant(tenant, bearerToken) {
  if (typeof bearerToken !== 'string' || bearerToken.length === 0) return false
  const candidate = tokenHash(bearerToken)
  return candidate.length === TOKEN_HASH_BYTES && timingSafeEqual(tenant.bearerTokenHash, candidate)
}

export function redactConfig(config) {
  return {
    bindHost: config.bindHost,
    port: config.port,
    publicUrl: config.publicUrl,
    runtimeConfigPath: config.runtimeConfigPath,
    allowedOrigins: config.allowedOrigins,
    tenants: config.tenants.map((tenant) => ({
      id: tenant.id,
      roots: tenant.roots,
      workspaces: tenant.workspaces,
      allowedOrigins: [...tenant.allowedOrigins],
    })),
    adapter: { type: config.adapter.type },
    limits: config.limits,
  }
}
