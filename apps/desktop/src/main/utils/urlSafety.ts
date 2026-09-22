import { isIPv4, isIPv6 } from 'node:net'

const ALLOWED_STREAM_SCHEMES = new Set(['http:', 'https:'])

const LOCALHOST_HOSTNAMES = new Set(['localhost', 'localhost.localdomain'])

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  const [a, b] = parts

  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true

  return false
}

function isBlockedIPv6(ip: string): boolean {
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true

  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4Mapped && isIPv4(v4Mapped[1])) {
    return isBlockedIPv4(v4Mapped[1])
  }

  const firstHextet = ip.toLowerCase().split(':')[0]
  if (firstHextet) {
    const value = parseInt(firstHextet, 16)
    if ((value & 0xffc0) === 0xfe80) return true
  }

  return false
}

export function assertSafeStreamUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid stream URL')
  }

  if (!ALLOWED_STREAM_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Blocked stream URL scheme: ${parsed.protocol}`)
  }

  const hostname = parsed.hostname.toLowerCase()

  if (LOCALHOST_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('Blocked stream URL: localhost hostname')
  }

  if (isIPv4(hostname)) {
    if (isBlockedIPv4(hostname)) {
      throw new Error(`Blocked stream URL: private or reserved IP ${hostname}`)
    }
    return
  }

  if (isIPv6(hostname)) {
    if (isBlockedIPv6(hostname)) {
      throw new Error(`Blocked stream URL: private or reserved IP ${hostname}`)
    }
  }
}