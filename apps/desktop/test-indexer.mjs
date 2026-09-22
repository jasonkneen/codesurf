import Database from 'better-sqlite3'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

const JOBS_DIR = join(homedir(), '.codesurf/jobs')
const TIMELINES_DIR = join(homedir(), '.codesurf/timelines')
const db = new Database('/tmp/codesurf-test.db')
db.pragma('foreign_keys = ON')

// Inline a minimal version of extractJobRow - just proves the pipeline works
function extractJobRow(j) {
  return {
    jobId: j.id, taskLabel: j.taskLabel ?? null, status: j.status ?? null,
    provider: j.provider ?? null, model: j.model ?? null, runMode: j.runMode ?? null,
    workspaceId: j.workspaceId ?? null, workspaceDir: j.workspaceDir ?? null,
    cardId: j.cardId ?? null, sessionId: j.sessionId ?? null,
    requestedAtMs: j.requestedAt ? Date.parse(j.requestedAt) : null,
    completedAtMs: j.completedAt ? Date.parse(j.completedAt) : null,
    errorText: j.error ?? null,
  }
}

const files = readdirSync(JOBS_DIR).filter(n => n.endsWith('.json'))
console.log(`Found ${files.length} job files`)

const insert = db.prepare(`
  INSERT INTO job_index (id, device_id, job_id, file_path, task_label, status,
    provider, model, run_mode, workspace_id, workspace_dir, card_id, session_id,
    requested_at_ms, completed_at_ms, duration_ms, error_text,
    event_count, error_count, last_event_type, last_event_at_ms, last_sequence,
    source_mtime_ms, source_size_bytes, timeline_mtime_ms, timeline_size_bytes)
  VALUES (?, 'test-device', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, 0, ?, ?, 0, 0)
`)
const insertEvent = db.prepare(`
  INSERT INTO timeline_event_index (id, device_id, job_id, sequence, timestamp_ms, event_type, error_text, payload_json)
  VALUES (?, 'test-device', ?, ?, ?, ?, ?, ?)
`)

let jobsInserted = 0, eventsInserted = 0
const txn = db.transaction(() => {
  for (const f of files) {
    try {
      const path = join(JOBS_DIR, f)
      const st = statSync(path)
      const j = JSON.parse(readFileSync(path, 'utf8'))
      const e = extractJobRow(j)
      const duration = e.requestedAtMs && e.completedAtMs ? e.completedAtMs - e.requestedAtMs : null
      insert.run(randomUUID(), e.jobId, path, e.taskLabel, e.status, e.provider, e.model,
        e.runMode, e.workspaceId, e.workspaceDir, e.cardId, e.sessionId,
        e.requestedAtMs, e.completedAtMs, duration, e.errorText,
        Math.floor(st.mtimeMs), st.size)
      jobsInserted++
      // Ingest timeline
      try {
        const tpath = join(TIMELINES_DIR, `${e.jobId}.jsonl`)
        const tjsonl = readFileSync(tpath, 'utf8')
        for (const line of tjsonl.split('\n')) {
          const t = line.trim(); if (!t) continue
          const ev = JSON.parse(t)
          if (typeof ev.sequence !== 'number') continue
          insertEvent.run(randomUUID(), e.jobId, ev.sequence, ev.timestamp ?? 0,
            ev.type ?? 'unknown', ev.error ?? null, t)
          eventsInserted++
        }
      } catch { /* timeline missing - fine */ }
    } catch (err) { console.warn('skip', f, err.message) }
  }
})
txn()

console.log(`Inserted ${jobsInserted} jobs, ${eventsInserted} timeline events`)
console.log('\n--- Sample queries ---')
console.log('Failed jobs:', db.prepare(`SELECT COUNT(*) c FROM job_index WHERE status='failed'`).get())
console.log('By provider:', db.prepare(`SELECT provider, COUNT(*) c FROM job_index GROUP BY provider`).all())
console.log('Longest job:', db.prepare(`SELECT job_id, duration_ms FROM job_index WHERE duration_ms IS NOT NULL ORDER BY duration_ms DESC LIMIT 1`).get())

console.log('\n--- FTS5 search for "id_token" ---')
const hits = db.prepare(`
  SELECT j.job_id, j.task_label, j.error_text
    FROM job_search s JOIN job_index j ON j.rowid = s.rowid
   WHERE job_search MATCH ? LIMIT 5
`).all('id_token')
console.log(hits)

console.log('\n--- FTS5 search timeline for "missing field" ---')
const thits = db.prepare(`
  SELECT t.job_id, t.sequence, t.event_type, t.error_text
    FROM timeline_search s JOIN timeline_event_index t ON t.rowid = s.rowid
   WHERE timeline_search MATCH ? LIMIT 3
`).all('"missing field"')
console.log(thits)
