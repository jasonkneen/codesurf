// P1b-1: a Persona's SOFT model/provider default seeds the composer; the user's
// pick always overrides it. Proves precedence ladder layers 2 (soft default) and
// 3 (user pick wins), and that model is fully DISSOCIATED from persona identity —
// it never flows through the authoritative tools/permission resolver, and the
// dispatch path never reads `defaultBinding`.
import { test } from 'node:test'
import { daemonUrl, daemonFile, daemonSource } from '../helpers/daemon-path.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Pure renderer resolver (type-only imports → loads under node's type-stripping).
import { resolvePersonaModelSeed, resolveSkillModelLock } from '../../src/renderer/src/hooks/personaModelBinding.ts'
// Daemon-side mirror (consumed by the CLI; must NOT import renderer code).
const { resolvePersonaModelSeed: daemonResolvePersonaModelSeed } = await import(daemonUrl('dist/persona-model-binding.js'))
// Overlay/inheritance: confirm `defaultBinding` survives overlay + extends merge.
import { overlayPersonas } from '../../src/shared/agentModes.ts'
// Authoritative tools/permission resolver — must stay model-free (altitude guard).
import { resolveAuthoritativeAgentMode } from '../../src/main/chat/agent-mode-resolver.ts'
import { mkdtemp as mkdtempP, mkdir as mkdirP, rm as rmP, writeFile as writeFileP } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

// ─── layer 2: a soft default seeds provider + model ───────────────────────────

test('soft default: a persona with defaultBinding seeds BOTH provider and model', () => {
  const persona = {
    id: 'polly', name: 'Polly', description: '', systemPrompt: 'S', tools: null,
    icon: 'star', color: '#b368c9', isBuiltin: true,
    defaultBinding: { provider: 'claude', model: 'claude-opus-4-8' },
  }
  assert.deepEqual(resolvePersonaModelSeed(persona), { provider: 'claude', model: 'claude-opus-4-8' })
})

test('soft default: a provider-only or model-only binding seeds just that field', () => {
  assert.deepEqual(
    resolvePersonaModelSeed({ id: 'a', defaultBinding: { provider: 'codex' } }),
    { provider: 'codex' },
  )
  assert.deepEqual(
    resolvePersonaModelSeed({ id: 'b', defaultBinding: { model: 'gpt-5' } }),
    { model: 'gpt-5' },
  )
})

test('soft default: blank/whitespace binding fields are ignored (treated as unset)', () => {
  assert.equal(resolvePersonaModelSeed({ id: 'a', defaultBinding: { provider: '   ', model: '' } }), null)
  assert.deepEqual(
    resolvePersonaModelSeed({ id: 'b', defaultBinding: { provider: '  claude  ', model: '' } }),
    { provider: 'claude' },
  )
})

// ─── (c) no default → composer unchanged ──────────────────────────────────────

test('no default: a persona without defaultBinding yields null (composer left unchanged)', () => {
  const plain = { id: 'agent', name: 'Agent', description: '', systemPrompt: '', tools: null, icon: 'robot', color: '#3568ff', isBuiltin: true }
  assert.equal(resolvePersonaModelSeed(plain), null)
  assert.equal(resolvePersonaModelSeed({ id: 'x', defaultBinding: {} }), null)
  assert.equal(resolvePersonaModelSeed(null), null, 'no persona (None state) → no seed')
  assert.equal(resolvePersonaModelSeed(undefined), null)
})

test('no default: all BUILT-IN personas leave the composer unchanged (binding unset)', () => {
  // Built-ins intentionally carry NO defaultBinding (keeps DEFAULT_PERSONAS
  // byte-identical across the shared/daemon drift guard).
  for (const p of overlayPersonas(null)) {
    assert.equal(resolvePersonaModelSeed(p), null, `${p.id} must carry no soft default`)
  }
})

// ─── (b) layer 3: user/composer pick overrides the soft default ───────────────

test('user pick OVERRIDES the soft default — the changed value is what dispatches', () => {
  // Model the composer: select a persona → its soft default seeds state; the user
  // then changes the model; the dispatch reads the LIVE state (activeModel), which
  // is the user's choice. This mirrors the real flow: seed at selection time, then
  // live composer state is the single source of truth for req.model/provider.
  const persona = { id: 'polly', defaultBinding: { provider: 'claude', model: 'claude-opus-4-8' } }
  const composer = { provider: 'codex', model: 'gpt-5' }

  // Selection seeds the composer (layer 2).
  const seed = resolvePersonaModelSeed(persona)
  if (seed?.provider) composer.provider = seed.provider
  if (seed?.model) composer.model = seed.model
  assert.deepEqual(composer, { provider: 'claude', model: 'claude-opus-4-8' }, 'soft default seeded')

  // User then freely picks a different model (layer 3).
  composer.model = 'claude-haiku-4-5'

  // The dispatch builds req.model from the LIVE composer state (activeModel) — NOT
  // from persona.defaultBinding. So the user's pick is what flows to the request.
  const reqModel = composer.model // === activeModel in useChatTileMessaging
  assert.equal(reqModel, 'claude-haiku-4-5', 'user pick wins over the soft default')
  assert.notEqual(reqModel, persona.defaultBinding.model, 'the soft default must NOT win once the user changed it')
})

// ─── dispatch decoupling: defaultBinding is read ONLY at seed time ─────────────

test('dispatch path builds req.model/provider from LIVE state, never from defaultBinding (layer 3 is structural)', () => {
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileMessaging.ts'), 'utf8')
  // req.model / req.provider come from activeModel / activeProvider...
  assert.match(src, /model:\s*activeModel/, 'req.model must be the live activeModel')
  assert.match(src, /provider:\s*activeProvider/, 'req.provider must be the live activeProvider')
  assert.match(src, /const activeModel\s*=\s*model\s*\|\|\s*state\?\.model/, 'activeModel prefers the live composer model state')
  assert.match(src, /const activeProvider\s*=\s*provider\s*\|\|\s*state\?\.provider/, 'activeProvider prefers the live composer provider state')
  // ...and the binding is NEVER consulted at dispatch (that would re-couple model
  // to identity and silently break user override).
  assert.doesNotMatch(src, /defaultBinding/, 'the dispatch path must NOT read persona.defaultBinding')
  assert.doesNotMatch(src, /resolvePersonaModelSeed/, 'the dispatch path must NOT seed at send time')
})

// ─── wiring: ChatTile seeds in the onSelectAgent click handler (not an effect) ─

test('ChatTile seeds the composer via resolvePersonaModelSeed inside onSelectAgent (layer 2 wiring)', () => {
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/ChatTile.tsx'), 'utf8')
  const start = src.indexOf('onSelectAgent={nextAgentId => {')
  assert.ok(start >= 0, 'onSelectAgent click handler must exist')
  const block = src.slice(start, src.indexOf('}}', start) + 2)
  assert.match(block, /setAgentId\(nextAgentId\)/, 'must set the selected agent id')
  assert.match(block, /resolvePersonaModelSeed\(/, 'must resolve the soft seed in the click handler')
  assert.match(block, /if \(modelSeed\?\.provider\) setProvider\(/, 'must seed provider only when present')
  assert.match(block, /if \(modelSeed\?\.model\) setModel\(/, 'must seed model only when present')
  // Must NOT be wired as an agentId-keyed effect (would re-clobber the user pick on
  // restore/re-render).
  assert.doesNotMatch(src, /useEffect\(\s*\([^)]*\)\s*=>\s*\{[\s\S]*?resolvePersonaModelSeed[\s\S]*?\}\s*,/s, 'seeding must not live in an effect')
})

// ─── overlay / extends: defaultBinding flows through unchanged ─────────────────

test('overlay: a persisted persona may add a defaultBinding; it survives the overlay', () => {
  const resolved = overlayPersonas([
    { id: 'custom', name: 'Custom', description: '', systemPrompt: 'S', tools: ['Read'], icon: 'robot', color: '#111', isBuiltin: false, defaultBinding: { provider: 'hermes', model: 'm-1' } },
  ])
  const custom = resolved.find(p => p.id === 'custom')
  assert.deepEqual(custom.defaultBinding, { provider: 'hermes', model: 'm-1' })
  assert.deepEqual(resolvePersonaModelSeed(custom), { provider: 'hermes', model: 'm-1' })
})

test('overlay extends: a child inherits the base soft default unless it defines its own', () => {
  const resolved = overlayPersonas([
    { id: 'base', name: 'Base', description: '', systemPrompt: 'S', tools: ['Read'], icon: 'map', color: '#111', isBuiltin: false, defaultBinding: { provider: 'claude', model: 'base-model' } },
    { id: 'inheritor', name: 'Inheritor', extends: 'base', isBuiltin: false },
    { id: 'overrider', name: 'Overrider', extends: 'base', isBuiltin: false, defaultBinding: { model: 'own-model' } },
  ])
  assert.deepEqual(
    resolvePersonaModelSeed(resolved.find(p => p.id === 'inheritor')),
    { provider: 'claude', model: 'base-model' },
    'omitted binding inherits the base soft default',
  )
  assert.deepEqual(
    resolvePersonaModelSeed(resolved.find(p => p.id === 'overrider')),
    { model: 'own-model' },
    'a child-defined binding overlays the base',
  )
})

// ─── drift guard: daemon mirror agrees with the renderer original ─────────────
// resolvePersonaModelSeed exists in TWO places: the renderer hook and the daemon
// package (packages/codesurf-daemon/src/persona-model-binding.ts), because the
// CLI must not import renderer code and the self-contained daemon package can't
// reach the desktop src/ tree. They MUST stay behaviourally identical.

test('drift guard: the daemon mirror of resolvePersonaModelSeed matches the renderer original', () => {
  const cases = [
    null,
    undefined,
    { id: 'a' },
    { id: 'a', defaultBinding: {} },
    { id: 'a', defaultBinding: { provider: 'claude', model: 'claude-opus-4-8' } },
    { id: 'a', defaultBinding: { provider: 'codex' } },
    { id: 'a', defaultBinding: { model: 'gpt-5' } },
    { id: 'a', defaultBinding: { provider: '   ', model: '' } },
    { id: 'a', defaultBinding: { provider: '  claude  ', model: '' } },
    { id: 'a', defaultBinding: { provider: ' hermes ', model: ' m-1 ' } },
  ]
  for (const persona of cases) {
    assert.deepEqual(
      daemonResolvePersonaModelSeed(persona),
      resolvePersonaModelSeed(persona),
      `daemon mirror must match renderer for ${JSON.stringify(persona)}`,
    )
  }
})

// ─── ALTITUDE: model never enters the authoritative tools/permission resolver ──

test('altitude: defaultBinding does NOT flow through resolveAuthoritativeAgentMode (model is not a permission boundary)', async () => {
  const root = await mkdtempP(join(tmpdir(), 'persona-binding-'))
  try {
    const dir = join(root, '.codesurf', 'customisation')
    await mkdirP(dir, { recursive: true })
    // A persisted persona carrying BOTH a tools restriction and a soft binding.
    await writeFileP(join(dir, 'agents.json'), JSON.stringify([
      { id: 'bound', name: 'Bound', description: '', systemPrompt: 'S', tools: ['Read'], icon: 'robot', color: '#111', isBuiltin: false, defaultBinding: { provider: 'claude', model: 'should-not-gate-anything' } },
    ]))
    const res = await resolveAuthoritativeAgentMode({ agentId: 'bound', resolveWorkspaceRoot: () => root })
    assert.equal(res.ok, true)
    // The resolver's job is tools/permissions — it must resolve them correctly...
    assert.deepEqual(res.agentMode.tools, ['Read'], 'tools resolution is unaffected by the binding')
    // ...and it carries the binding through inertly (it is plain persona data), but
    // it must NEVER consult the binding to make a permission decision. The resolver
    // source proves the decoupling: it reasons only about tools/agents.json, never model.
    const resolverSrc = readFileSync(join(ROOT_DIR, 'src/main/chat/agent-mode-resolver.ts'), 'utf8')
    assert.doesNotMatch(resolverSrc, /defaultBinding|\.model\b|preferredModel/, 'the authoritative resolver must not reference model/binding')
  } finally {
    await rmP(root, { recursive: true, force: true })
  }
})

// ═══ P1b-2: SKILL-DEFINED MODEL LOCK (precedence LAYER 1) ══════════════════════
// A Persona LINKS skills (`persona.skills`, matched against discovered workspace
// skills by id OR name). If the first linked skill declares a `requiredModel`,
// selecting the persona HARD-locks the composer's model/provider (layer 1 — runs
// ABOVE the soft default and the user pick) and the picker is disabled. Like the
// soft binding, the lock is renderer/composer-only and NEVER a permission boundary.

const SKILL_WITH_LOCK = { id: 'discovered-/x/review.md', name: 'review', description: '', content: '', requiredModel: 'claude-opus-4-8', requiredProvider: 'claude' }
const SKILL_MODEL_ONLY = { id: 'plain', name: 'plain', description: '', content: '', requiredModel: 'gpt-5' }
const SKILL_NO_LOCK = { id: 'free', name: 'free', description: '', content: '' }

// ─── layer 1 OVERRIDES the soft default ───────────────────────────────────────

test('lock OVERRIDES the soft default: a linked skill\'s requiredModel wins over defaultBinding', () => {
  // Persona carries BOTH a soft default (layer 2) AND a linked locking skill (layer 1).
  const persona = {
    id: 'reviewer', name: 'Reviewer', description: '', systemPrompt: 'S', tools: null,
    icon: 'star', color: '#b368c9', isBuiltin: false,
    defaultBinding: { provider: 'codex', model: 'gpt-5' },
    skills: ['review'],
  }
  const lock = resolveSkillModelLock(persona, [SKILL_WITH_LOCK])
  assert.deepEqual(lock, { model: 'claude-opus-4-8', locked: true, reason: 'Model locked by skill "review"', provider: 'claude' })
  // The lock model must differ from (and therefore override) the soft default.
  const soft = resolvePersonaModelSeed(persona)
  assert.deepEqual(soft, { provider: 'codex', model: 'gpt-5' }, 'the soft layer still resolves independently...')
  assert.notEqual(lock.model, soft.model, '...but the caller takes the lock first (layer 1 above layer 2)')
})

test('lock: matches a linked skill by id OR by name', () => {
  const byName = { id: 'p', skills: ['review'] }
  const byId = { id: 'p', skills: ['discovered-/x/review.md'] }
  assert.equal(resolveSkillModelLock(byName, [SKILL_WITH_LOCK])?.model, 'claude-opus-4-8')
  assert.equal(resolveSkillModelLock(byId, [SKILL_WITH_LOCK])?.model, 'claude-opus-4-8')
})

test('lock: model-only requiredModel pins the model with no provider', () => {
  assert.deepEqual(
    resolveSkillModelLock({ id: 'p', skills: ['plain'] }, [SKILL_MODEL_ONLY]),
    { model: 'gpt-5', locked: true, reason: 'Model locked by skill "plain"' },
  )
})

test('lock: FIRST linked skill that declares a requiredModel wins (order = persona.skills)', () => {
  const persona = { id: 'p', skills: ['free', 'plain', 'review'] }
  // `free` has no requiredModel (skipped); `plain` is the first that locks.
  assert.equal(resolveSkillModelLock(persona, [SKILL_NO_LOCK, SKILL_MODEL_ONLY, SKILL_WITH_LOCK])?.model, 'gpt-5')
})

// ─── no lock → null (fall through to layers 2/3) ──────────────────────────────

test('no linked skill => null (composer falls through to the soft default / user pick)', () => {
  assert.equal(resolveSkillModelLock({ id: 'p' }, [SKILL_WITH_LOCK]), null, 'persona without skills => no lock')
  assert.equal(resolveSkillModelLock({ id: 'p', skills: [] }, [SKILL_WITH_LOCK]), null, 'empty skills => no lock')
  assert.equal(resolveSkillModelLock({ id: 'p', skills: ['review'] }, []), null, 'no workspace skills => no lock')
  assert.equal(resolveSkillModelLock({ id: 'p', skills: ['review'] }, [SKILL_NO_LOCK]), null, 'linked skill carries no requiredModel => no lock')
  assert.equal(resolveSkillModelLock({ id: 'p', skills: ['ghost'] }, [SKILL_WITH_LOCK]), null, 'linked id not found => no lock')
  assert.equal(resolveSkillModelLock(null, [SKILL_WITH_LOCK]), null)
  assert.equal(resolveSkillModelLock(undefined, [SKILL_WITH_LOCK]), null)
  assert.equal(resolveSkillModelLock({ id: 'p', skills: ['review'] }, null), null)
})

test('no lock: all BUILT-IN personas carry no skills → never locked', () => {
  for (const p of overlayPersonas(null)) {
    assert.equal(resolveSkillModelLock(p, [SKILL_WITH_LOCK]), null, `${p.id} must carry no linked skills`)
  }
})

// ─── frontmatter parse: model:/provider: → requiredModel/requiredProvider ──────

test('discovery: registerDiscoveredSkill parses model:/provider: frontmatter into requiredModel/requiredProvider', () => {
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileWorkspaceSkills.ts'), 'utf8')
  assert.ok(src.includes('requiredModel'), 'must set requiredModel on the discovered skill')
  assert.ok(src.includes('requiredProvider'), 'must set requiredProvider on the discovered skill')
  // The keys must be parsed from a BOUNDED, leading `---`-fenced frontmatter block —
  // NOT an unbounded `[\s\S]*?model:` scan that would false-positive on body prose
  // like "pick the best model: fast".
  assert.match(src, /const frontmatter = content\.match\(\/\^---/, 'must extract the leading frontmatter block first')
  assert.match(src, /frontmatter\.match\(\/\^model:/m, 'requiredModel must be line-anchored within the frontmatter block')
  assert.match(src, /frontmatter\.match\(\/\^provider:/m, 'requiredProvider must be line-anchored within the frontmatter block')
  assert.doesNotMatch(src, /\[\\s\\S\]\*\?\\bmodel:/, 'must NOT use the unbounded body-spanning model: scan')
})

// Behavioural check of the SAME parsing logic the hook ships (registerDiscoveredSkill
// is a closure → not importable; this mirrors its bounded frontmatter parse exactly).
function parseSkillFrontmatterLock(content) {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  return {
    requiredModel: frontmatter.match(/^model:\s*(.+?)\s*$/m)?.[1]?.trim() || undefined,
    requiredProvider: frontmatter.match(/^provider:\s*(.+?)\s*$/m)?.[1]?.trim() || undefined,
  }
}

test('discovery (behaviour): frontmatter model:/provider: lock; body prose never trips a spurious lock', () => {
  // Real frontmatter declares a lock.
  assert.deepEqual(
    parseSkillFrontmatterLock('---\nname: review\nmodel: claude-opus-4-8\nprovider: claude\n---\n\nBody.'),
    { requiredModel: 'claude-opus-4-8', requiredProvider: 'claude' },
  )
  // Prose that merely mentions "model:" in the BODY must NOT become a requiredModel.
  assert.deepEqual(
    parseSkillFrontmatterLock('---\nname: helper\ndescription: a helper\n---\n\nPick the best model: fast, then go.'),
    { requiredModel: undefined, requiredProvider: undefined },
  )
  // A "model:" inside a frontmatter description value must not leak as the lock either.
  assert.deepEqual(
    parseSkillFrontmatterLock('---\nname: x\ndescription: choose a model: any\n---\nbody'),
    { requiredModel: undefined, requiredProvider: undefined },
  )
})

// ─── composer wiring: locked => model + provider pills disabled ────────────────

test('locked => the model + provider pills are disabled (ChatTileComposer wiring)', () => {
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/chat/ChatTileComposer.tsx'), 'utf8')
  // The model pill (always shown) disables on the lock and surfaces the reason.
  assert.match(src, /label=\{currentModelLabel\}[\s\S]*?disabled=\{modelLocked\}/, 'the model pill must disable when modelLocked')
  // The provider pill (shown pre-conversation) disables too.
  assert.match(src, /label=\{currentProviderEntry\?\.label \?\? 'Provider'\}[\s\S]*?disabled=\{modelLocked\}/, 'the provider pill must disable when modelLocked')
  assert.match(src, /title=\{modelLocked \? \(lockReason/, 'the disabled pill must surface the lock reason as its tooltip')
  // ToolbarPill already drops onClick + renders a Lock glyph when disabled.
  const controls = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/chat/ChatComposerControls.tsx'), 'utf8')
  assert.match(controls, /onClick=\{disabled \? undefined : onClick\}/, 'a disabled ToolbarPill must not invoke onClick')
})

test('ChatTile computes the lock from the active persona + workspace skills and threads it to the composer', () => {
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/ChatTile.tsx'), 'utf8')
  const agentModesSrc = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useChatTileAgentModes.ts'), 'utf8')
  assert.match(agentModesSrc, /resolveSkillModelLock\(resolvedAgentMode,\s*workspaceSkills\)/, 'must compute the lock from the active persona + workspace skills')
  assert.match(src, /modelLocked=\{Boolean\(modelLock\)\}/, 'must thread modelLocked to the composer')
  assert.match(src, /lockReason=\{modelLock\?\.reason\}/, 'must thread the lock reason to the composer')
})

// ─── layer-1 short-circuits layer-2 in the onSelectAgent click handler ─────────

test('onSelectAgent SHORT-CIRCUITS the soft seed when a skill lock applies (layer 1 above layer 2)', () => {
  const src = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/ChatTile.tsx'), 'utf8')
  const start = src.indexOf('onSelectAgent={nextAgentId => {')
  assert.ok(start >= 0, 'onSelectAgent click handler must exist')
  const block = src.slice(start, src.indexOf('}}', start) + 2)
  // layer 1 first: a lock pins provider/model...
  const lockIdx = block.indexOf('resolveSkillModelLock(')
  const seedIdx = block.indexOf('resolvePersonaModelSeed(')
  assert.ok(lockIdx >= 0, 'must resolve the skill lock in the handler')
  assert.ok(seedIdx > lockIdx, 'the lock must be resolved BEFORE the soft seed (layer 1 first)')
  // ...and the soft seed runs only in the else branch (skipped when locked).
  assert.match(block, /if \(skillLock\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?resolvePersonaModelSeed\(/, 'the soft seed must live in the else branch — short-circuited when locked')
})

// ─── overlay / extends: Persona.skills flows through unchanged ─────────────────

test('overlay: a persisted persona may add `skills`; it survives the overlay (and feeds the lock)', () => {
  const resolved = overlayPersonas([
    { id: 'custom', name: 'Custom', description: '', systemPrompt: 'S', tools: ['Read'], icon: 'robot', color: '#111', isBuiltin: false, skills: ['review'] },
  ])
  const custom = resolved.find(p => p.id === 'custom')
  assert.deepEqual(custom.skills, ['review'], 'the linked-skills list survives the overlay')
  assert.equal(resolveSkillModelLock(custom, [SKILL_WITH_LOCK])?.model, 'claude-opus-4-8')
})

test('overlay extends: a child inherits the base `skills` unless it defines its own', () => {
  const resolved = overlayPersonas([
    { id: 'base', name: 'Base', description: '', systemPrompt: 'S', tools: ['Read'], icon: 'map', color: '#111', isBuiltin: false, skills: ['review'] },
    { id: 'inheritor', name: 'Inheritor', extends: 'base', isBuiltin: false },
    { id: 'overrider', name: 'Overrider', extends: 'base', isBuiltin: false, skills: ['plain'] },
  ])
  assert.deepEqual(resolved.find(p => p.id === 'inheritor').skills, ['review'], 'omitted skills inherit the base list')
  assert.deepEqual(resolved.find(p => p.id === 'overrider').skills, ['plain'], 'a child-defined skills list overlays the base')
})

// ─── drift guard: built-ins carry NO skills (DEFAULT_PERSONAS stays byte-identical) ─

test('drift guard: no built-in persona declares `skills` (keeps shared<->daemon DEFAULT_PERSONAS identical)', () => {
  for (const p of overlayPersonas(null)) {
    assert.equal(p.skills, undefined, `${p.id} must NOT declare skills — built-ins stay byte-identical across the drift guard`)
  }
})

// ─── ALTITUDE: the skill lock never enters the authoritative tools/permission path ─

test('altitude: the authoritative resolver references NONE of the lock identifiers (model is not a permission boundary)', () => {
  const resolverSrc = readFileSync(join(ROOT_DIR, 'src/main/chat/agent-mode-resolver.ts'), 'utf8')
  assert.doesNotMatch(resolverSrc, /requiredModel|requiredProvider|resolveSkillModelLock|\.skills\b/, 'the trusted-disk resolver must not reference the skill-lock surface')
})
