import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname
const runtimeDbModuleUrl = pathToFileURL(join(repoRoot, 'electrobun/bun/runtime-db.ts')).href

function runBunRuntimeDb(scriptBody, baseDir) {
  const script = `
    import { createElectrobunDbRuntime } from ${JSON.stringify(runtimeDbModuleUrl)};
    const baseDir = ${JSON.stringify(baseDir)};
    ${scriptBody}
  `
  const result = spawnSync('bun', ['--eval', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  assert.ok(lines.length > 0, 'Bun smoke did not print JSON output')
  return JSON.parse(lines.at(-1))
}

describe('Electrobun Bun SQLite runtime', () => {
  test('creates the migrated CodeSurf DB without loading better-sqlite3', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-db-'))
    try {
      const out = runBunRuntimeDb(`
        const runtime = createElectrobunDbRuntime(baseDir);
        const status = runtime.getStatus();
        runtime.close();
        console.log(JSON.stringify({ status }));
      `, baseDir)

      assert.equal(out.status.path, join(baseDir, 'db', 'codesurf.db'))
      assert.equal(out.status.schemaVersion, 4)
      assert.match(out.status.deviceId, /^[0-9a-f-]{36}$/i)
      assert.deepEqual(
        ['app_meta', 'job_index', 'job_search', 'projects', 'schema_migrations', 'thread_index', 'timeline_event_index', 'timeline_search', 'workspaces']
          .every(table => out.status.tables.includes(table)),
        true,
      )
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test('returns recent jobs from job_index in renderer IPC shape', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-jobs-'))
    try {
      const out = runBunRuntimeDb(`
        const runtime = createElectrobunDbRuntime(baseDir);
        const db = runtime.getDb();
        db.query(
          'INSERT INTO job_index (id, device_id, job_id, file_path, task_label, initial_prompt, status, provider, model, run_mode, workspace_id, workspace_dir, card_id, requested_at_ms, completed_at_ms, duration_ms, last_activity_at_ms, last_event_type, event_count, error_count, is_starred, is_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run('row-1', runtime.getDeviceId(), 'job-1', '/tmp/job-1.json', 'Implement Electrobun', 'prompt', 'completed', 'codex', 'gpt-5.5', 'full-access', 'workspace-a', '/tmp/workspace-a', 'card-1', 10, 20, 10, 30, 'done', 3, 0, 1, 0);
        db.query(
          'INSERT INTO job_index (id, device_id, job_id, file_path, task_label, status, workspace_id, last_activity_at_ms, event_count, error_count, is_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run('row-2', runtime.getDeviceId(), 'job-2', '/tmp/job-2.json', 'Archived', 'completed', 'workspace-a', 40, 1, 0, 1);
        const recent = runtime.listRecentJobs({ workspaceId: 'workspace-a', limit: 10 });
        runtime.close();
        console.log(JSON.stringify({ recent }));
      `, baseDir)

      assert.equal(out.recent.total, 1)
      assert.equal(out.recent.limit, 10)
      assert.equal(out.recent.offset, 0)
      assert.equal(out.recent.jobs.length, 1)
      assert.deepEqual(out.recent.jobs[0], {
        jobId: 'job-1',
        taskLabel: 'Implement Electrobun',
        initialPrompt: 'prompt',
        status: 'completed',
        provider: 'codex',
        model: 'gpt-5.5',
        runMode: 'full-access',
        workspaceId: 'workspace-a',
        workspaceDir: '/tmp/workspace-a',
        cardId: 'card-1',
        requestedAtMs: 10,
        completedAtMs: 20,
        durationMs: 10,
        lastActivityAtMs: 30,
        lastEventType: 'done',
        eventCount: 3,
        errorCount: 0,
        isStarred: true,
        isArchived: false,
      })
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test('reset moves the live DB aside and recreates a migrated DB', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-reset-'))
    try {
      const out = runBunRuntimeDb(`
        const runtime = createElectrobunDbRuntime(baseDir);
        const before = runtime.getStatus();
        const reset = runtime.reset();
        const after = runtime.getStatus();
        runtime.close();
        console.log(JSON.stringify({ before, reset, after }));
      `, baseDir)

      assert.equal(out.before.path, join(baseDir, 'db', 'codesurf.db'))
      assert.match(out.reset.backupPath, /codesurf\.db\.reset-/)
      assert.equal(out.after.path, out.before.path)
      assert.equal(out.after.schemaVersion, 4)
      assert.notEqual(out.after.deviceId, out.before.deviceId)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})
