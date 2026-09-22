import { copyFileSync, unlinkSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { profilePath } from './profiles'
import { CODESURF_HOME } from '../paths'

const TEMP_DIR = join(CODESURF_HOME, 'chrome-sync-temp')

export interface HistoryEntry {
  url: string
  title: string
  visitCount: number
  lastVisitTime: number // Unix ms
}

// Chrome epoch: microseconds since 1601-01-01
const CHROME_EPOCH_OFFSET = 11644473600n

function chromeTimeToUnixMs(chromeTime: number): number {
  if (!chromeTime) return 0
  const ms = BigInt(chromeTime) / 1000n - CHROME_EPOCH_OFFSET * 1000n
  return Number(ms)
}

export async function searchHistory(
  profileDir: string,
  query: string,
  limit = 20,
): Promise<HistoryEntry[]> {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })

  const srcDb = join(profilePath(profileDir), 'History')
  if (!existsSync(srcDb)) return []

  const tempDb = join(TEMP_DIR, `history-${Date.now()}.sqlite`)

  try {
    // Copy to avoid Chrome's file lock; restrict to owner-read-only (0o600)
    copyFileSync(srcDb, tempDb)
    chmodSync(tempDb, 0o600)

    const Database = (await import('better-sqlite3')).default
    const db = new Database(tempDb, { readonly: true })

    let rows: any[]
    if (query) {
      const pattern = `%${query}%`
      rows = db.prepare(
        'SELECT url, title, visit_count, last_visit_time FROM urls WHERE url LIKE ? OR title LIKE ? ORDER BY visit_count DESC, last_visit_time DESC LIMIT ?',
      ).all(pattern, pattern, limit)
    } else {
      rows = db.prepare(
        'SELECT url, title, visit_count, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT ?',
      ).all(limit)
    }

    db.close()

    return rows.map((r: any) => ({
      url: r.url,
      title: r.title || '',
      visitCount: r.visit_count,
      lastVisitTime: chromeTimeToUnixMs(r.last_visit_time),
    }))
  } catch {
    return []
  } finally {
    try { unlinkSync(tempDb) } catch {}
  }
}
