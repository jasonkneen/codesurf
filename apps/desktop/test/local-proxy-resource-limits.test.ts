import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertForwardableLocalProxyRole,
  BoundedProxyBody,
  BoundedProxyLineDecoder,
  BoundedProxyLineQueue,
  classifyLocalProxyParserDone,
  findFirstLiveLocalProxyBackend,
  GenerationOwnedProxyResource,
  isVerifiedLocalProxyBackendProbe,
  localProxyClientCanContinue,
  localProxyRequestCloseNeedsFailure,
  LocalProxyLimitError,
  LocalProxyProtocolTerminalTracker,
  monitorLocalProxyProtocolChunk,
  OneShotProxyLifecycle,
  ProxyBackpressureGate,
  ProxyLifecycleEpoch,
  reportManagedProxyStreamFailure,
  revokeManagedProxyResource,
  SerializedProxyOperationLane,
} from '../src/main/chat/local-proxy-resource-limits.ts'

test('managed proxy bodies fail closed at the byte boundary', () => {
  const body = new BoundedProxyBody(5, 'request-body')
  body.append('ab')
  body.append(Buffer.from('cde'))

  assert.equal(body.byteLength, 5)
  assert.equal(body.toString(), 'abcde')
  assert.throws(
    () => body.append('f'),
    (error: unknown) => (
      error instanceof LocalProxyLimitError
      && error.kind === 'request-body'
      && error.maxBytes === 5
    ),
  )

  const unicode = new BoundedProxyBody(2, 'backend-body')
  assert.throws(
    () => unicode.append('界'),
    (error: unknown) => (
      error instanceof LocalProxyLimitError
      && error.kind === 'backend-body'
    ),
  )
})

test('managed proxy line decoder preserves split UTF-8 and rejects an oversized line', () => {
  const decoder = new BoundedProxyLineDecoder(8, 64)
  const encoded = Buffer.from('界\n', 'utf8')

  assert.deepEqual(decoder.push(encoded.subarray(0, 2)), [])
  assert.deepEqual(decoder.push(encoded.subarray(2)), ['界'])

  const oversized = new BoundedProxyLineDecoder(5, 64)
  assert.throws(
    () => oversized.push('123456\n'),
    (error: unknown) => (
      error instanceof LocalProxyLimitError
      && error.kind === 'stream-line'
      && error.maxBytes === 5
    ),
  )
})

test('managed proxy line decoder rejects aggregate stream growth across small lines', () => {
  const decoder = new BoundedProxyLineDecoder(8, 8)
  assert.deepEqual(decoder.push('a\nb\n'), ['a', 'b'])
  assert.deepEqual(decoder.push('c\nd\n'), ['c', 'd'])
  assert.equal(decoder.byteLength, 8)
  assert.throws(
    () => decoder.push('e\n'),
    (error: unknown) => (
      error instanceof LocalProxyLimitError
      && error.kind === 'stream-aggregate'
      && error.maxBytes === 8
    ),
  )
})

test('managed proxy backpressure queue has its own byte ceiling', () => {
  const queue = new BoundedProxyLineQueue(6)
  queue.append('ab')
  queue.append('cd')
  assert.equal(queue.byteLength, 6)
  assert.throws(
    () => queue.append('e'),
    (error: unknown) => (
      error instanceof LocalProxyLimitError
      && error.kind === 'stream-backpressure'
      && error.maxBytes === 6
    ),
  )
  assert.deepEqual(queue.drain(), ['ab', 'cd'])
  assert.equal(queue.byteLength, 0)
})

test('managed proxy lifecycle completes once and blocks post-terminal output', () => {
  const lifecycle = new OneShotProxyLifecycle()
  const output: string[] = []

  assert.equal(lifecycle.runIfActive(() => output.push('before')), true)
  assert.equal(lifecycle.finish(), true)
  assert.equal(lifecycle.active, false)
  assert.equal(lifecycle.runIfActive(() => output.push('after')), false)
  assert.equal(lifecycle.finish(), false)
  assert.deepEqual(output, ['before'])
})

test('managed proxy backpressure pauses once, releases on drain, and stays closed', () => {
  const backpressure = new ProxyBackpressureGate()
  let pauses = 0

  assert.equal(backpressure.block(() => { pauses += 1 }), true)
  assert.equal(backpressure.isBlocked, true)
  assert.equal(backpressure.block(() => { pauses += 1 }), false)
  assert.equal(pauses, 1)
  assert.equal(backpressure.release(), true)
  assert.equal(backpressure.isBlocked, false)

  assert.equal(backpressure.block(() => { pauses += 1 }), true)
  backpressure.finish()
  assert.equal(backpressure.isBlocked, false)
  assert.equal(backpressure.release(), false)
  assert.equal(backpressure.block(() => { pauses += 1 }), false)
  assert.equal(pauses, 2)
})

test('managed proxy only forwards Anthropic user and assistant roles', () => {
  assert.equal(assertForwardableLocalProxyRole('user'), 'user')
  assert.equal(assertForwardableLocalProxyRole('assistant'), 'assistant')
  assert.throws(() => assertForwardableLocalProxyRole('system'), /user or assistant/)
  assert.throws(() => assertForwardableLocalProxyRole('tool'), /user or assistant/)
  assert.throws(() => assertForwardableLocalProxyRole(undefined), /user or assistant/)
})

test('local proxy acceptance requires parsed output or an explicit protocol terminal', () => {
  const malformedOnly = new LocalProxyProtocolTerminalTracker(64, 128)
  malformedOnly.push('data: definitely-not-json\n')
  // The generic parser emits done at EOF. EOF itself must not prove that the
  // provider accepted room context.
  assert.equal(malformedOnly.hasProvenTerminal, false)

  malformedOnly.push('data: [DONE]\n\n')
  assert.equal(malformedOnly.hasProvenTerminal, false)

  const explicitDone = new LocalProxyProtocolTerminalTracker(64, 128)
  explicitDone.push('data: [DONE]\n\n')
  assert.equal(explicitDone.hasProvenTerminal, true)

  const leadingWhitespace = new LocalProxyProtocolTerminalTracker(64, 128)
  leadingWhitespace.push(' data: [DONE]\n\n')
  assert.equal(leadingWhitespace.hasProvenTerminal, false)

  const missingSpace = new LocalProxyProtocolTerminalTracker(64, 128)
  missingSpace.push('data:[DONE]\n\n')
  assert.equal(missingSpace.hasProvenTerminal, false)

  const messageStop = new LocalProxyProtocolTerminalTracker(64, 128)
  messageStop.push('data: {"type":"message_')
  messageStop.push('stop"}\n\n')
  assert.equal(messageStop.hasProvenTerminal, true)
})

test('parser-synthesized EOF fails closed without protocol terminal proof', () => {
  assert.equal(classifyLocalProxyParserDone(false, false), 'missing-terminal')
  assert.equal(classifyLocalProxyParserDone(false, true), 'reported-error')
  assert.equal(classifyLocalProxyParserDone(true, false), 'complete')
  assert.equal(classifyLocalProxyParserDone(true, true), 'complete')
})

test('protocol tracker violations synchronously report so the caller can abort', () => {
  for (const [tracker, chunk, kind] of [
    [new LocalProxyProtocolTerminalTracker(4, 64), '12345\n', 'stream-line'],
    [new LocalProxyProtocolTerminalTracker(64, 4), '12345', 'stream-aggregate'],
  ] as const) {
    const reports: LocalProxyLimitError[] = []
    let aborts = 0

    assert.equal(monitorLocalProxyProtocolChunk(tracker, chunk, error => {
      reports.push(error)
      aborts += 1
    }), false)
    assert.equal(aborts, 1)
    assert.equal(reports[0]?.kind, kind)
    assert.equal(tracker.hasViolation, true)
    assert.throws(() => tracker.push('ignored'), LocalProxyLimitError)
  }
})

test('serialized proxy operations cannot overlap', async () => {
  const lane = new SerializedProxyOperationLane()
  const order: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve })

  const first = lane.run(async () => {
    order.push('first:start')
    await firstBarrier
    order.push('first:end')
    return 1
  })
  const second = lane.run(async () => {
    order.push('second:start')
    order.push('second:end')
    return 2
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['first:start'])
  releaseFirst?.()
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end'])
})

test('proxy stop epochs invalidate starts captured before stop without blocking future starts', () => {
  const epoch = new ProxyLifecycleEpoch()
  const beforeStop = epoch.capture()
  assert.equal(epoch.isCurrent(beforeStop), true)

  const afterStop = epoch.invalidate()
  assert.equal(epoch.isCurrent(beforeStop), false)
  assert.equal(epoch.isCurrent(afterStop), true)

  const futureStart = epoch.capture()
  assert.equal(futureStart, afterStop)
  assert.equal(epoch.isCurrent(futureStart), true)
})

test('stale proxy generations cannot revoke or close the current server', () => {
  const owner = new GenerationOwnedProxyResource<{ name: string }>()
  const first = owner.claim({ name: 'first' })
  const second = owner.claim({ name: 'second' })
  const closed: string[] = []

  assert.equal(revokeManagedProxyResource(owner, first, value => closed.push(value.name)), false)
  assert.equal(owner.current?.name, 'second')
  assert.deepEqual(closed, [])

  assert.equal(revokeManagedProxyResource(owner, second, value => {
    assert.equal(owner.current, null)
    closed.push(value.name)
  }), true)
  assert.equal(owner.current, null)
  assert.deepEqual(closed, ['second'])
})

test('backend selection stops when its client is aborted', async () => {
  const controller = new AbortController()
  const probes: string[] = []
  const selected = findFirstLiveLocalProxyBackend(
    ['first', 'second'],
    (candidate, signal) => new Promise(resolve => {
      probes.push(candidate)
      signal?.addEventListener('abort', () => resolve(false), { once: true })
    }),
    controller.signal,
  )

  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal(await selected, null)
  assert.deepEqual(probes, ['first'])
  assert.equal(localProxyClientCanContinue(controller.signal, false, false), false)
  assert.equal(localProxyClientCanContinue(undefined, true, false), false)
  assert.equal(localProxyClientCanContinue(undefined, false, true), false)
  assert.equal(localProxyClientCanContinue(undefined, false, false), true)
})

test('backend probes require a successful backend-specific JSON identity', () => {
  assert.equal(isVerifiedLocalProxyBackendProbe(
    'ollama-tags', 200, 'application/json', '{"models":[]}',
  ), true)
  assert.equal(isVerifiedLocalProxyBackendProbe(
    'lmstudio-v1-models', 200, 'application/json; charset=utf-8', '{"models":[]}',
  ), true)
  assert.equal(isVerifiedLocalProxyBackendProbe(
    'lmstudio-v0-models', 200, 'application/json', '{"object":"list","data":[]}',
  ), true)
  assert.equal(isVerifiedLocalProxyBackendProbe(
    'llamacpp-health', 200, 'application/json', '{"status":"ok"}',
  ), true)

  // A random HTTP service on a known port must not be trusted merely because
  // it returned a non-5xx status or a plausible-looking body.
  assert.equal(isVerifiedLocalProxyBackendProbe(
    'ollama-tags', 404, 'application/json', '{"models":[]}',
  ), false)
  assert.equal(isVerifiedLocalProxyBackendProbe(
    'lmstudio-v1-models', 401, 'application/json', '{"models":[]}',
  ), false)
  assert.equal(isVerifiedLocalProxyBackendProbe(
    'llamacpp-health', 200, 'text/html', '{"status":"ok"}',
  ), false)
  assert.equal(isVerifiedLocalProxyBackendProbe(
    'ollama-tags', 200, 'application/json', '{"status":"ok"}',
  ), false)
})

test('request close fallback only fires when no response was observed', () => {
  assert.equal(localProxyRequestCloseNeedsFailure(false), true)
  assert.equal(localProxyRequestCloseNeedsFailure(true), false)
})

test('slow-reader stream failures destroy transport instead of looking like EOF', () => {
  const calls: string[] = []
  assert.equal(reportManagedProxyStreamFailure('queue overflow', {
    backpressureBlocked: true,
    writeError: () => {
      calls.push('write')
      return true
    },
    finishGracefully: () => calls.push('finish'),
    destroyTransport: () => calls.push('destroy'),
  }), 'destroyed')
  assert.deepEqual(calls, ['destroy'])

  calls.length = 0
  assert.equal(reportManagedProxyStreamFailure('write saturated', {
    backpressureBlocked: false,
    writeError: () => {
      calls.push('write')
      return false
    },
    finishGracefully: () => calls.push('finish'),
    destroyTransport: () => calls.push('destroy'),
  }), 'destroyed')
  assert.deepEqual(calls, ['write', 'destroy'])

  calls.length = 0
  assert.equal(reportManagedProxyStreamFailure('visible error', {
    backpressureBlocked: false,
    writeError: () => {
      calls.push('write')
      return true
    },
    finishGracefully: () => calls.push('finish'),
    destroyTransport: () => calls.push('destroy'),
  }), 'reported')
  assert.deepEqual(calls, ['write', 'finish'])
})
