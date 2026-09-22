#!/usr/bin/env node
// Score a model's Insight output against a fixture's gold.
//
// Usage:
//   node scripts/calibrate-insights/score.mjs <fixture-path> < model-output.md
//   node scripts/calibrate-insights/score.mjs fixtures/chat-bubble-radius.md < pasted.md
//   cat pasted.md | node scripts/calibrate-insights/score.mjs fixtures/chat-bubble-radius.md
//
// The fixture file identifies the task; the matching gold/<same-name>.md is the
// Claude reference. The --compare flag prints side-by-side with gold.

import { readFileSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRubric, extractInsightBlock } from './rubric.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function usage() {
  console.error('usage: node score.mjs <fixture-path> [--compare] < model-output.md')
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.length < 1 || args.includes('--help')) usage()

const fixturePath = resolve(__dirname, '..', '..', args[0])
const compareMode = args.includes('--compare')

let fixtureText
try {
  fixtureText = readFileSync(fixturePath, 'utf8')
} catch (err) {
  console.error(`Could not read fixture: ${fixturePath}`)
  console.error(err.message)
  process.exit(1)
}

const goldPath = resolve(__dirname, 'gold', basename(fixturePath))
let goldText = null
try {
  goldText = readFileSync(goldPath, 'utf8')
} catch {
  // Gold is optional for the pure score — only needed for --compare.
}

const outputText = readFileSync(0, 'utf8')
if (!outputText.trim()) {
  console.error('no model output on stdin')
  process.exit(1)
}

const result = runRubric({ output: outputText, fixture: fixtureText })

console.log(JSON.stringify({
  fixture: basename(fixturePath),
  verdict: result.verdict,
  score: result.score,
  structural: result.structural,
  qualitative: result.qualitative,
}, null, 2))

if (compareMode) {
  const modelBlock = extractInsightBlock(outputText)
  const goldBlock = goldText ? extractInsightBlock(goldText) : null
  console.log('\n--- MODEL ---')
  console.log(modelBlock ?? outputText)
  if (goldBlock) {
    console.log('\n--- GOLD (Claude reference) ---')
    console.log(goldBlock)
  } else {
    console.log('\n(no gold file found at ' + goldPath + ')')
  }
}

if (result.verdict === 'FAIL') process.exit(1)
