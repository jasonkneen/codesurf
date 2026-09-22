import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMemoryPrompt } from '../bin/memory-loader.mjs'
import { buildContextBucketBundle, describeContextBucketsForTool } from '../bin/context-buckets.mjs'

test('context buckets build explicit local-only and remote-safe bundle summaries for inspectable local runs', () => {
  const context = {
    includedBuckets: ['local-only', 'remote-safe'],
    sections: [
      {
        scope: 'user',
        bucket: 'local-only',
        displayPath: '~/.codesurf/AGENTS.md',
        content: 'User instruction layer',
      },
      {
        scope: 'workspace',
        bucket: 'remote-safe',
        displayPath: 'AGENTS.md',
        content: 'Workspace instruction layer',
      },
      {
        scope: 'workspace-local',
        bucket: 'local-only',
        displayPath: '.codesurf/AGENTS.md',
        importedFrom: 'AGENTS.md',
        content: 'Workspace local instruction layer',
      },
      {
        scope: 'workspace',
        bucket: 'remote-safe',
        displayPath: 'rules/shared.md',
        importedFrom: 'AGENTS.md',
        content: 'Imported workspace rule',
      },
    ],
  }

  const prompt = buildMemoryPrompt({
    sections: context.sections.filter(section => context.includedBuckets.includes(section.bucket)),
  })
  const bundle = buildContextBucketBundle(context)
  const details = describeContextBucketsForTool(bundle, prompt)

  assert.deepEqual(bundle, {
    version: 1,
    includedBuckets: ['local-only', 'remote-safe'],
    buckets: [
      {
        bucket: 'local-only',
        included: true,
        sectionCount: 2,
        sections: [
          {
            scope: 'user',
            displayPath: '~/.codesurf/AGENTS.md',
            importedFrom: null,
          },
          {
            scope: 'workspace-local',
            displayPath: '.codesurf/AGENTS.md',
            importedFrom: 'AGENTS.md',
          },
        ],
      },
      {
        bucket: 'remote-safe',
        included: true,
        sectionCount: 2,
        sections: [
          {
            scope: 'workspace',
            displayPath: 'AGENTS.md',
            importedFrom: null,
          },
          {
            scope: 'workspace',
            displayPath: 'rules/shared.md',
            importedFrom: 'AGENTS.md',
          },
        ],
      },
    ],
  })
  assert.equal(details.summary, 'Loaded 4 instruction sections [local-only: 2, remote-safe: 2]: ~/.codesurf/AGENTS.md, .codesurf/AGENTS.md, AGENTS.md +1 more')
  assert.match(details.input, /## Outbound Context Buckets/)
  assert.match(details.input, /Included buckets: local-only, remote-safe/)
  assert.match(details.input, /### local-only/)
  assert.match(details.input, /- ~\/\.codesurf\/AGENTS\.md/)
  assert.match(details.input, /- \.codesurf\/AGENTS\.md \(imported from AGENTS\.md\)/)
  assert.match(details.input, /### remote-safe/)
  assert.match(details.input, /- AGENTS\.md/)
  assert.match(details.input, /- rules\/shared\.md \(imported from AGENTS\.md\)/)
  assert.match(details.input, /## Injected Prompt/)
  assert.match(details.input, /### User Instructions \[local-only\] \(~\/\.codesurf\/AGENTS\.md\)/)
  assert.match(details.input, /Imported workspace rule/)
})

test('context buckets keep cloud bundles explicitly remote-safe without leaking local-only file details', () => {
  const context = {
    includedBuckets: ['remote-safe'],
    sections: [
      {
        scope: 'user',
        bucket: 'local-only',
        displayPath: '~/.codesurf/AGENTS.md',
        content: 'Keep this local-only layer off remote runs',
      },
      {
        scope: 'workspace',
        bucket: 'remote-safe',
        displayPath: 'AGENTS.md',
        content: 'Workspace instruction layer',
      },
    ],
  }

  const prompt = buildMemoryPrompt({
    sections: context.sections.filter(section => context.includedBuckets.includes(section.bucket)),
  })
  const bundle = buildContextBucketBundle(context)
  const details = describeContextBucketsForTool(bundle, prompt)

  assert.deepEqual(bundle, {
    version: 1,
    includedBuckets: ['remote-safe'],
    buckets: [
      {
        bucket: 'local-only',
        included: false,
        sectionCount: 0,
        sections: [],
      },
      {
        bucket: 'remote-safe',
        included: true,
        sectionCount: 1,
        sections: [
          {
            scope: 'workspace',
            displayPath: 'AGENTS.md',
            importedFrom: null,
          },
        ],
      },
    ],
  })
  assert.equal(details.summary, 'Loaded 1 instruction section [remote-safe: 1]: AGENTS.md')
  assert.match(details.input, /Included buckets: remote-safe/)
  assert.match(details.input, /### local-only \(omitted from outbound bundle\)/)
  assert.doesNotMatch(details.input, /~\/\.codesurf\/AGENTS\.md/)
  assert.doesNotMatch(details.input, /Keep this local-only layer off remote runs/)
  assert.match(details.input, /### remote-safe/)
  assert.match(details.input, /### Workspace Instructions \[remote-safe\] \(AGENTS\.md\)/)
})
