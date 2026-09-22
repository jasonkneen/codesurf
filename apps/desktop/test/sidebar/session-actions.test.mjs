import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SESSION_ACTION_BUTTON_SIZE,
  SESSION_ACTION_ICON_SIZE,
  getSessionRowExtraWidth,
  getSessionArchiveActionLabel,
} from '../../src/renderer/src/components/sidebar/session-actions.ts'

const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('conversation archive action uses human labels instead of delete wording', () => {
  assert.equal(getSessionArchiveActionLabel(false), 'Archive conversation')
  assert.equal(getSessionArchiveActionLabel(true), 'Unarchive conversation')
})

test('conversation archive action is not tiny', () => {
  assert.ok(SESSION_ACTION_BUTTON_SIZE >= 24)
  assert.ok(SESSION_ACTION_ICON_SIZE >= 14)
  assert.equal(getSessionRowExtraWidth(0), SESSION_ACTION_BUTTON_SIZE)
  assert.equal(getSessionRowExtraWidth(0, true), SESSION_ACTION_BUTTON_SIZE * 2 + 6)
  assert.ok(getSessionRowExtraWidth(1) >= 64)
  assert.ok(getSessionRowExtraWidth(1, true) > getSessionRowExtraWidth(1))
})

test('Sidebar controller declares archive mutation callback before menu actions that capture it', async () => {
  // Session model lives in useSidebarController after the Sidebar split.
  const controllerPath = join(ROOT_DIR, 'src/renderer/src/components/sidebar/useSidebarController.tsx')
  const source = await readFile(controllerPath, 'utf8')
  const archiveCallbackIndex = source.indexOf('const setSessionArchived = useCallback(')
  const menuCallbackIndex = source.indexOf('const sessionContextMenuItems = useCallback(')

  assert.ok(archiveCallbackIndex >= 0)
  assert.ok(menuCallbackIndex >= 0)
  assert.ok(archiveCallbackIndex < menuCallbackIndex)
})
