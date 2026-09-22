import assert from 'node:assert/strict'

type Matcher = {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toBeNull(): void
  toBeUndefined(): void
  toContain(expected: unknown): void
  toContainEqual(expected: unknown): void
  toMatchObject(expected: Record<string, unknown>): void
  toBeGreaterThan(expected: number): void
  not: {
    toContain(expected: unknown): void
  }
}

export function expect(actual: unknown): Matcher {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected)
    },
    toEqual(expected: unknown) {
      assert.deepEqual(actual, expected)
    },
    toBeNull() {
      assert.equal(actual, null)
    },
    toBeUndefined() {
      assert.equal(actual, undefined)
    },
    toContain(expected: unknown) {
      if (typeof actual === 'string') {
        assert.ok(actual.includes(String(expected)))
        return
      }
      assert.ok(Array.isArray(actual))
      assert.ok(actual.some(item => Object.is(item, expected)))
    },
    toContainEqual(expected: unknown) {
      assert.ok(Array.isArray(actual))
      assert.ok(actual.some(item => {
        try {
          assert.deepEqual(item, expected)
          return true
        } catch {
          return false
        }
      }))
    },
    toMatchObject(expected: Record<string, unknown>) {
      assert.ok(actual && typeof actual === 'object')
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual((actual as Record<string, unknown>)[key], value)
      }
    },
    toBeGreaterThan(expected: number) {
      assert.equal(typeof actual, 'number')
      assert.ok((actual as number) > expected)
    },
    not: {
      toContain(expected: unknown) {
        if (typeof actual === 'string') {
          assert.ok(!actual.includes(String(expected)))
          return
        }
        assert.ok(Array.isArray(actual))
        assert.ok(!actual.some(item => Object.is(item, expected)))
      },
    },
  }
}
