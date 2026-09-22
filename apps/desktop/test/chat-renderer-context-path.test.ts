import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const messagingSource = await readFile(
  new URL('../src/renderer/src/hooks/useChatTileMessaging.ts', import.meta.url),
  'utf8',
)

test('renderer sends recent edits and block notes as separate untrusted context inputs', () => {
  assert.match(messagingSource, /messages:\s*requestMessages/)
  assert.match(messagingSource, /recentEditContext:\s*recentEditContext \|\| undefined/)
  assert.match(messagingSource, /blockNotesContext:\s*blockNotesContext \|\| undefined/)
  assert.doesNotMatch(messagingSource, /Recent edit context:\\n\$\{recentEditContext\}/)
  assert.doesNotMatch(messagingSource, /providerTransport:\s*activeProviderEntry\?\.transport/)
  assert.doesNotMatch(messagingSource, /negotiatedTools:\s*activeMcpEnabled/)
})
