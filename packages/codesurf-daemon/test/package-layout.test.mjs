import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getDaemonCompiledExports,
  getDaemonPublicSpecifiers,
  getDaemonRuntimeEntries,
} from '@codesurf/daemon/package-layout'

test('runtime entries come only from the package files contract', () => {
  assert.deepEqual(
    getDaemonRuntimeEntries({ files: ['bin/', 'dist/', 'vendor/', 'README.md'] }),
    ['bin', 'dist', 'vendor', 'README.md', 'package.json'],
  )
  assert.throws(
    () => getDaemonRuntimeEntries({ files: ['dist/', 'src/'] }),
    /must not publish src/,
  )
  for (const unsafe of ['../outside', '..\\outside', 'C:/outside', '/outside']) {
    assert.throws(
      () => getDaemonRuntimeEntries({ files: [unsafe] }),
      /unsafe daemon package files entry/,
    )
  }
})

test('compiled export discovery rejects private or non-dist targets', () => {
  assert.deepEqual(
    getDaemonCompiledExports({
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          default: './dist/index.js',
        },
        './package.json': './package.json',
      },
    }),
    [{
      subpath: '.',
      types: './dist/index.d.ts',
      import: './dist/index.js',
    }],
  )
  assert.throws(
    () => getDaemonCompiledExports({
      exports: { './bin/private': './bin/private.mjs' },
    }),
    /must be a compiled conditional export/,
  )
  assert.throws(
    () => getDaemonCompiledExports({
      exports: {
        './unsafe': {
          types: './dist/unsafe.d.ts',
          import: './dist/../../../outside.js',
          default: './dist/../../../outside.js',
        },
      },
    }),
    /must resolve to compiled dist/,
  )
  assert.throws(
    () => getDaemonCompiledExports({
      exports: {
        './..\\unsafe': {
          types: './dist/unsafe.d.ts',
          import: './dist/unsafe.js',
          default: './dist/unsafe.js',
        },
      },
    }),
    /unsafe subpath/,
  )
})

test('public specifiers are derived from compiled export subpaths', () => {
  const manifest = {
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './client': {
        types: './dist/client.d.ts',
        import: './dist/client.js',
        default: './dist/client.js',
      },
    },
  }
  assert.deepEqual(
    getDaemonPublicSpecifiers(manifest),
    ['@codesurf/daemon', '@codesurf/daemon/client'],
  )
})
