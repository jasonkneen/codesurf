import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const ROOT_DIR = resolve(import.meta.dirname, '..')

async function browserLaunchOptions() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)
  for (const executablePath of candidates) {
    try {
      await access(executablePath)
      return { executablePath }
    } catch {
      // Try the next system browser, then Playwright's managed Chromium.
    }
  }
  return {}
}

test('browser starts real TypeScript and JSON Monaco workers without worker errors', async t => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'codesurf-monaco-workers-'))
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }) })

  await writeFile(
    join(fixtureRoot, 'index.html'),
    '<link rel="icon" href="data:,"><main id="status">starting</main>'
    + '<script type="module" src="/main.js"></script>\n',
    'utf8',
  )
  const monacoConfigUrl = `/@fs/${resolve(ROOT_DIR, 'src/renderer/src/monaco.ts')}`
  await writeFile(
    join(fixtureRoot, 'main.js'),
    `
      import * as monaco from 'monaco-editor'
      import { ensureMonacoConfigured } from ${JSON.stringify(monacoConfigUrl)}

      ensureMonacoConfigured()
      const tsModel = monaco.editor.createModel(
        'const answer: string = 42',
        'typescript',
        monaco.Uri.parse('file:///worker-proof.ts'),
      )
      const jsonModel = monaco.editor.createModel(
        '{"valid": true, "broken": }',
        'json',
        monaco.Uri.parse('file:///worker-proof.json'),
      )

      // Model creation requests rich language features, but Monaco finishes
      // their dynamic registration asynchronously. Wait for that observable
      // readiness condition rather than assuming a fixed delay is enough
      // under concurrent core-suite load. Any non-registration error still
      // fails immediately, and a missing registration remains bounded.
      async function waitForWorkerFactory(label, getWorkerFactory) {
        const deadline = performance.now() + 15_000
        while (true) {
          try {
            return await getWorkerFactory()
          } catch (error) {
            if (!String(error).endsWith('not registered!')) throw error
            if (performance.now() >= deadline) {
              throw new Error(label + ' worker registration timed out: ' + String(error))
            }
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        }
      }

      Promise.all([
        waitForWorkerFactory(
          'TypeScript',
          () => monaco.typescript.getTypeScriptWorker(),
        ).then(factory => factory(tsModel.uri)),
        waitForWorkerFactory(
          'JSON',
          () => monaco.json.getWorker(),
        ).then(factory => factory(jsonModel.uri)),
      ]).then(async ([tsWorker, jsonWorker]) => {
        const [tsDiagnostics, jsonDiagnostics] = await Promise.all([
          tsWorker.getSemanticDiagnostics(tsModel.uri.toString()),
          jsonWorker.doValidation(jsonModel.uri.toString()),
        ])
        window.__MONACO_WORKER_PROOF__ = {
          tsDiagnostics: tsDiagnostics.map(item => ({
            code: item.code,
            messageText: String(item.messageText),
          })),
          jsonDiagnostics: jsonDiagnostics.map(item => ({
            code: item.code,
            message: item.message,
          })),
        }
        document.querySelector('#status').textContent = 'ready'
      }).catch(error => {
        window.__MONACO_WORKER_FAILURE__ = error?.stack || String(error)
        document.querySelector('#status').textContent = 'failed'
      })
    `,
    'utf8',
  )

  const server = await createServer({
    root: fixtureRoot,
    resolve: {
      alias: [{
        find: /^monaco-editor$/,
        replacement: resolve(ROOT_DIR, 'node_modules/monaco-editor/esm/vs/index.js'),
      }],
    },
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      fs: { allow: [ROOT_DIR, fixtureRoot] },
    },
  })
  await server.listen()
  t.after(async () => { await server.close() })

  const browser = await chromium.launch({ headless: true, ...await browserLaunchOptions() })
  t.after(async () => { await browser.close() })
  const page = await browser.newPage()
  const workerUrls = []
  const runtimeErrors = []
  const failedRequests = []
  page.on('worker', worker => workerUrls.push(worker.url()))
  page.on('pageerror', error => runtimeErrors.push(error.stack || error.message))
  page.on('console', message => {
    if (message.type() === 'error') runtimeErrors.push(message.text())
  })
  page.on('requestfailed', request => {
    failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`)
  })

  const address = server.httpServer?.address()
  assert.ok(address && typeof address === 'object')
  await page.goto(`http://127.0.0.1:${address.port}/`)
  try {
    await page.waitForFunction(
      () => window.__MONACO_WORKER_PROOF__ || window.__MONACO_WORKER_FAILURE__,
      undefined,
      { timeout: 30_000 },
    )
  } catch (error) {
    const status = await page.locator('#status').textContent().catch(() => null)
    assert.fail(
      `${error.message}\nstatus=${status}\nworkers=${JSON.stringify(workerUrls)}`
      + `\nruntimeErrors=${JSON.stringify(runtimeErrors)}`
      + `\nfailedRequests=${JSON.stringify(failedRequests)}`,
    )
  }

  const result = await page.evaluate(() => ({
    proof: window.__MONACO_WORKER_PROOF__,
    failure: window.__MONACO_WORKER_FAILURE__,
  }))
  assert.equal(result.failure, undefined)
  assert.ok(
    result.proof.tsDiagnostics.some(diagnostic => diagnostic.code === 2322),
    `expected TypeScript assignment diagnostics, received ${JSON.stringify(result.proof.tsDiagnostics)}`,
  )
  assert.ok(
    result.proof.jsonDiagnostics.length > 0,
    'expected invalid JSON to produce worker diagnostics',
  )
  assert.ok(
    workerUrls.some(url => /typescript|ts\.worker/i.test(url)),
    `TypeScript worker did not start: ${JSON.stringify(workerUrls)}`,
  )
  assert.ok(
    workerUrls.some(url => /json\.worker/i.test(url)),
    `JSON worker did not start: ${JSON.stringify(workerUrls)}`,
  )
  assert.deepEqual(runtimeErrors, [])
})
