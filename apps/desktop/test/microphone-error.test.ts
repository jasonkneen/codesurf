import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { describeMicrophoneError } from '../src/renderer/src/lib/microphoneError.ts'

describe('describeMicrophoneError', () => {
  test('maps permission failures to a retryable composer message', () => {
    expect(describeMicrophoneError(new DOMException('Permission denied', 'NotAllowedError')))
      .toBe('Microphone blocked. Click the mic to retry, or allow it in System Settings.')
    expect(describeMicrophoneError(new Error('Permission denied')))
      .toBe('Microphone blocked. Click the mic to retry, or allow it in System Settings.')
  })

  test('maps missing and busy devices', () => {
    expect(describeMicrophoneError(new DOMException('Requested device not found', 'NotFoundError')))
      .toBe('No microphone found')
    expect(describeMicrophoneError(new DOMException('Could not start audio source', 'NotReadableError')))
      .toBe('Microphone is already in use')
  })

  test('keeps unknown messages', () => {
    expect(describeMicrophoneError(new Error('onnx wasm failed to load'))).toBe('onnx wasm failed to load')
  })
})
