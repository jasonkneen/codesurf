import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expandElectrobunFileReferences } from '../electrobun/bun/file-reference-context.ts'
import type { ChatRequest } from '../src/main/chat/types.ts'

function request(content: string): ChatRequest {
  return {
    workspaceId: 'workspace-1',
    workspaceDir: '/trusted/workspace',
    cardId: 'chat-1',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content }],
  }
}

describe('Electrobun host file-reference context', () => {
  test('rehydrates bounded text and supported image attachments from the daemon', async () => {
    const calls: unknown[] = []
    const expanded = await expandElectrobunFileReferences(
      request('Review @src/app.ts and Attached file capabilities:\nopaque-token\tscreenshot.png'),
      async payload => {
        calls.push(payload)
        return {
          changed: true,
          bodyText: 'Review src/app.ts and screenshot.png',
          contextText: 'HOST-EXPANDED-FILE-CONTEXT',
          references: [
            {
              binary: true,
              capability: 'opaque-token',
              mediaType: 'image/png',
              resolvedPath: '/trusted/workspace/screenshot.png',
              displayPath: 'screenshot.png',
              byteCount: 128,
              device: '10',
              inode: '20',
              mtimeMs: 30,
              ctimeMs: 40,
            },
          ],
        }
      },
    )

    assert.deepEqual(calls, [{
      message: 'Review @src/app.ts and Attached file capabilities:\nopaque-token\tscreenshot.png',
      workspaceId: 'workspace-1',
      cardId: 'chat-1',
      supportedImageMediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    }])
    assert.equal(expanded.expandedMessages?.[0]?.content, 'Review src/app.ts and screenshot.png')
    assert.equal(expanded.fileReferencePrompt, 'HOST-EXPANDED-FILE-CONTEXT')
    assert.deepEqual(expanded.imageAttachments, [{
      path: '/trusted/workspace/screenshot.png',
      mediaType: 'image/png',
      displayPath: 'screenshot.png',
      byteCount: 128,
      device: '10',
      inode: '20',
      mtimeMs: 30,
      ctimeMs: 40,
    }])
    assert.deepEqual(expanded.consumedAttachmentCapabilities, ['opaque-token'])
  })

  test('does not call the daemon for ordinary messages', async () => {
    let called = false
    const expanded = await expandElectrobunFileReferences(
      request('Review the current change'),
      async () => {
        called = true
        return { changed: false, bodyText: '', references: [] }
      },
    )
    assert.equal(called, false)
    assert.deepEqual(expanded, {})
  })

  test('forwards structured attachment selections without embedding receipts in text', async () => {
    const calls: unknown[] = []
    const structuredRequest = {
      ...request('Review the attached image'),
      attachmentSelections: [{ selectionReceipt: 'selection-receipt' }],
    } as ChatRequest
    const expanded = await expandElectrobunFileReferences(
      structuredRequest,
      async payload => {
        calls.push(payload)
        return { changed: true, bodyText: 'Review the attached image', references: [] }
      },
    )

    assert.deepEqual(calls, [{
      message: 'Review the attached image',
      workspaceId: 'workspace-1',
      cardId: 'chat-1',
      supportedImageMediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      attachmentSelections: [{ selectionReceipt: 'selection-receipt' }],
    }])
    assert.equal(expanded.expandedMessages?.[0]?.content, 'Review the attached image')
  })

  test('rejects renderer-controlled raw attachment paths', async () => {
    await assert.rejects(
      expandElectrobunFileReferences(
        request('Attached file paths:\n/etc/passwd'),
        async () => ({ changed: false, bodyText: '', references: [] }),
      ),
      /Raw attachment paths are not accepted/,
    )
  })
})
