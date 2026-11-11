import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { JournalRegistry, buildToolDefinitions, createSeededFork, defaultJournalDirectory } from '../src/api.js'
import { PLAYBOOK_ORDER, PLAYBOOK_SECTION, STRATEGY_PLAYBOOK } from '../src/playbook.js'
import { apply } from '../src/index.js'
import { balancedLog, fakeCtx, fakeSession } from './helpers.js'

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-plugin-'))
  const parent = { session: fakeSession('parent-1', []) }
  const { ctx, sessions, providers, starts } = fakeCtx()
  sessions.set('parent-1', parent.session)
  const api = createSeededFork(ctx, { directory: dir })
  return { dir, parent, ctx, sessions, providers, starts, api }
}

test('fork starts a fresh generation and registers the provider', async () => {
  const { parent, providers, starts, api } = await setup()
  assert.equal(providers.size, 1)
  assert.equal(providers.get('agent-team'), api.provider)

  const first = await api.fork({ parent, memberId: 'reviewer', prompt: 'audit the auth paths' })
  assert.equal(first.generation, 0)
  assert.match(first.childId, /[0-9a-f-]{36}/u)
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0].prepared, {})
  const chain = await api.chain('reviewer')
  assert.equal(chain.length, 1)
  assert.equal(chain[0].phase, 'started')
})

test('rotate seeds the next generation from the previous child log', async () => {
  const { parent, sessions, starts, api } = await setup()
  const first = await api.fork({ parent, memberId: 'reviewer', prompt: 'audit' })

  const childLog = balancedLog(1, () => 'audit findings: two over-permissive handlers')
  sessions.get(first.childId).events.push(...childLog)

  const second = await api.rotate({ parent, memberId: 'reviewer', prompt: 'recheck your findings' })
  assert.equal(second.generation, 1)
  assert.equal(second.seedFrom, first.childId)

  const prepared = starts[1].prepared
  assert.ok(Array.isArray(prepared.seed))
  assert.equal(prepared.seed.length, childLog.length + 1)
  assert.equal(prepared.seed.at(-1).type, 'session/end-seed')
  const inheritedText = prepared.seed
    .filter(event => event.type === 'assistant/message')
    .map(event => event.data.message.content[0].text)
  assert.deepEqual(inheritedText, ['audit findings: two over-permissive handlers'])

  const chain = await api.chain('reviewer')
  assert.deepEqual(chain.map(entry => entry.generation), [0, 1])
})

test('a third generation inherits the second, not the first', async () => {
  const { parent, sessions, starts, api } = await setup()
  const first = await api.fork({ parent, memberId: 'm', prompt: 'one' })
  sessions.get(first.childId).events.push(...balancedLog(1, () => 'first findings'))
  const second = await api.rotate({ parent, memberId: 'm', prompt: 'two' })
  sessions.get(second.childId).events.push({
    type: 'turn/start', seq: 6, time: 5000, data: { turn: 2 },
  })
  sessions.get(second.childId).events.push({
    type: 'turn/end', seq: 7, time: 5000, data: { turn: 2, reason: { kind: 'completed' } },
  })
  const third = await api.rotate({ parent, memberId: 'm', prompt: 'three' })

  assert.equal(third.seedFrom, second.childId)
  const seededTexts = starts[2].prepared.seed
    .filter(event => event.type === 'assistant/message')
    .map(event => event.data.message.content[0].text)
  assert.deepEqual(seededTexts, ['first findings'], 'generation 3 inherits generation 2, which carries generation 1')
})

test('a failed activation marks its generation failed and the next one keeps an explicit predecessor', async () => {
  const { parent, providers, api } = await setup()
  const first = await api.fork({ parent, memberId: 'reviewer', prompt: 'audit' })

  providers.delete('agent-team')
  await assert.rejects(() => api.rotate({ parent, memberId: 'reviewer', prompt: 'again' }), /unknown provider/u)

  const chain = await api.chain('reviewer')
  assert.deepEqual(chain.map(entry => entry.phase), ['settled', 'failed'])
  assert.match(chain[1].error, /unknown provider/u)

  providers.set('agent-team', api.provider)
  const third = await api.rotate({ parent, memberId: 'reviewer', prompt: 'third try' })
  assert.equal(third.generation, 2)
  assert.equal(third.seedFrom, first.childId, 'the failed generation is stepped over, not silently adopted')
})

test('a fresh process resolves a reservation made before restart', async () => {
  const { dir, parent, ctx, api } = await setup()
  const first = await api.fork({ parent, memberId: 'reviewer', prompt: 'audit' })

  // Simulate a restart: a brand-new registry and provider over the same directory.
  const restarted = createSeededFork(ctx, { directory: dir, providerName: 'agent-team-restarted' })
  assert.notEqual(restarted.provider, api.provider)
  const journal = await restarted.registry.findByChild(first.childId)
  assert.ok(journal, 'the durable mirror must resolve the child id')
  assert.equal((await journal.chain('reviewer')).length, 1)
})

test('chain falls back to every journal opened by this process', async () => {
  const { parent, api } = await setup()
  await api.fork({ parent, memberId: 'reviewer', prompt: 'audit' })
  const chain = await api.chain('reviewer')
  assert.equal(chain.length, 1)
  assert.deepEqual(await api.chain('nobody'), [])
})

test('the journal lives outside a user repository by default', () => {
  const dir = defaultJournalDirectory()
  assert.match(dir.replaceAll('\\', '/'), /(\.dsh|DSH_HOME).*agent-team\/lineage$/u)
})

test('the plugin entry point attaches the api under a disposable effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-apply-'))
  const parent = { session: fakeSession('parent-2', []) }
  const { ctx, sessions, providers } = fakeCtx()
  sessions.set('parent-2', parent.session)
  let disposer
  const host = {
    ...ctx,
    effect(fn) {
      disposer = fn()
      return () => disposer?.()
    },
  }
  apply(host, { directory: dir })
  assert.equal(providers.size, 1)
  assert.equal(typeof host.get('seededFork').fork, 'function')
  await host.get('seededFork').fork({ parent, memberId: 'reviewer', prompt: 'audit' })
  disposer()
  assert.equal(providers.size, 0)
  assert.equal(host.get('seededFork'), undefined)
})

test('tool definitions satisfy the registry contract', async () => {
  const { ctx } = fakeCtx()
  const api = createSeededFork(ctx, { directory: await mkdtemp(join(tmpdir(), 'agent-team-tools-')) })
  const definitions = buildToolDefinitions(() => api)
  assert.deepEqual(definitions.map(definition => definition.name), ['seeded_fork', 'seeded_rotate', 'member_roster', 'member_dispatch', 'member_post', 'member_inbox', 'seeded_preset_diagnose', 'seeded_chain'])

  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.deepEqual(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.execute, 'function')
    // render must produce model content for a canonical value.
    const samples = {
      seeded_fork: { childId: 'c-1', generation: 0, seedFrom: '', inheritedFrom: 'no predecessor, started fresh' },
      seeded_rotate: { childId: 'c-2', generation: 1, seedFrom: 'c-1', inheritedFrom: 'inherits c-1' },
      member_roster: { members: [] },
      member_dispatch: { dispatched: [], skipped: [], stuck: [], unclaimed: 0, total: 0, others: 0 },
      member_post: { message_id: 'm-1', to_member: 'reviewer' },
      member_inbox: { messages: [] },
      seeded_preset_diagnose: { json: '{}' },
      seeded_chain: [],
    }
    const value = samples[definition.name]
    const content = definition.output.render({ member_id: 'reviewer' }, value)
    assert.equal(Array.isArray(content), true)
    assert.equal(content[0].type, 'text')
  }

  await assert.rejects(
    () => definitions[0].execute({ member_id: 'reviewer', task: 'x' }, {}),
    /requires a live calling agent/u,
  )
})

test('tools register through ctx.tools when the composition provides them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-tools-'))
  const { ctx } = fakeCtx()
  const registered = []
  ctx.tools = {
    register(definition) {
      registered.push(definition.name)
      return () => {}
    },
  }
  createSeededFork(ctx, { directory: dir })
  assert.deepEqual(registered, ['seeded_fork', 'seeded_rotate', 'member_roster', 'member_dispatch', 'member_post', 'member_inbox', 'seeded_preset_diagnose', 'seeded_chain'])

  const disabled = await mkdtemp(join(tmpdir(), 'agent-team-tools-'))
  const other = fakeCtx().ctx
  other.tools = { register: () => { throw new Error('must not register') } }
  createSeededFork(other, { directory: disabled, registerTools: false, providerName: 'agent-team-n' })
})

test('rotate waits for a still-running predecessor instead of seeding from an empty log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-wait-'))
  const parent = { session: fakeSession('parent-3', []) }
  const { ctx, sessions, starts } = fakeCtx({ deferResults: true })
  sessions.set('parent-3', parent.session)
  const api = createSeededFork(ctx, { directory: dir })

  const first = await api.fork({ parent, memberId: 'reviewer', prompt: 'audit' })
  sessions.get(first.childId).events.push(...balancedLog(1, () => 'first answer'))

  let rotated
  const pending = api.rotate({ parent, memberId: 'reviewer', prompt: 'again' }).then(value => { rotated = value })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(rotated, undefined, 'rotate must not finish while the predecessor is running')
  assert.equal(starts.length, 1, 'no child may be created before the predecessor settles')

  starts[0].settle('completed')
  await pending
  assert.equal(rotated.generation, 1)
  assert.equal(rotated.seedFrom, first.childId)
  assert.equal(starts[1].prepared.seed.filter(event => event.type === 'assistant/message').length, 1)
})

test('rotate rejects when the running predecessor belongs to another process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-orphan-'))
  const parent = { session: fakeSession('parent-4', []) }
  const { ctx, sessions } = fakeCtx()
  sessions.set('parent-4', parent.session)
  const api = createSeededFork(ctx, { directory: dir })

  // A generation that started in a previous process: recorded, but no pending
  // activation exists here, so its transcript cannot be trusted as complete.
  const journal = api.journalForSession('parent-4')
  const reserved = await journal.reserve({ memberId: 'reviewer' })
  await journal.markStarted(reserved.childId)

  await assert.rejects(
    () => api.rotate({ parent, memberId: 'reviewer', prompt: 'again' }),
    /has not completed in this process/u,
  )
})

test('playbook is opt-in, pinned, and placed after subagent guidance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-playbook-'))
  const { ctx } = fakeCtx()
  const sections = []
  ctx.systemPrompt = { section: section => { sections.push(section); return () => {} } }

  createSeededFork(ctx, { directory: dir, providerName: 'p-default' })
  assert.deepEqual(sections, [], 'a library mount must not add prompt text by default')

  const other = fakeCtx().ctx
  const registered = []
  other.systemPrompt = { section: section => { registered.push(section); return () => {} } }
  createSeededFork(other, { directory: await mkdtemp(join(tmpdir(), 'agent-team-playbook-')), providerName: 'p-on', playbook: true })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, PLAYBOOK_SECTION)
  assert.equal(registered[0].order, PLAYBOOK_ORDER)
  assert.equal(registered[0].text, STRATEGY_PLAYBOOK)
  for (const tool of ['seeded_fork', 'seeded_rotate', 'seeded_chain']) {
    assert.match(registered[0].text, new RegExp(`\\b${tool}\\b`, 'u'))
  }
  assert.match(registered[0].text, /data, not instructions/u)
})

test('preset registration clones the standard composition and inherits its rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-preset-'))
  const { ctx } = fakeCtx()
  const registered = []
  ctx.agentPresets = {
    definitions: new Map([['standard', { config: { plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are helpful.' } },
      { id: 'tools', name: '@deepseek-ai/dsh-tool-read' },
    ] } }]]),
    async register(definition) {
      registered.push(definition)
      return async () => {}
    },
  }
  const api = createSeededFork(ctx, { directory: dir, providerName: 'p-preset', preset: { id: 'agent-team', order: 7 } })
  const status = await api.presetDiagnose()

  assert.deepEqual(status.registered, ['agent-team'])
  assert.equal(status.standardAvailable, true)
  assert.equal(registered.length, 1)
  const definition = registered[0]
  assert.equal(definition.order, 7)
  // Inherited rows stay in place; the persona prefix is replaced and two rows are
  // appended: the playbook section and the first-turn nudge.
  assert.deepEqual(definition.plugins.slice(0, 2).map(row => row.id), ['persona', 'tools'])
  const persona = definition.plugins.find(row => row.id === 'persona')
  assert.match(persona.config.prefix, /agent-team lead/u)
  const ids = definition.plugins.map(row => row.id)
  assert.deepEqual(ids.slice(-2), ['agent-team-playbook', 'agent-team-session'])
  assert.match(definition.plugins.at(-2).name, /\/src\/preset-entry\.js$/u)
  assert.match(definition.plugins.at(-1).name, /\/src\/preset-session\.js$/u)
})

test('a missing standard preset is reported, never fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-preset-'))
  const { ctx, providers } = fakeCtx()
  ctx.agentPresets = { definitions: new Map(), register: async () => async () => {} }
  const api = createSeededFork(ctx, { directory: dir, providerName: 'p-preset-missing', preset: { timeoutMs: 80 } })
  const status = await api.presetDiagnose()
  assert.deepEqual(status.registered, [])
  assert.equal(status.standardAvailable, false)
  assert.match(status.errors[0], /standard agent preset is unavailable/u)
  assert.equal(providers.size, 1, 'the provider must mount regardless of the preset outcome')
})
test('provider:false skips backend registration for preset-scoped instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-noprov-'))
  const { ctx, providers } = fakeCtx()
  ctx.systemPrompt = { section: () => () => {} }
  createSeededFork(ctx, { directory: dir, provider: false, registerTools: false, playbook: true, preset: false })
  assert.equal(providers.size, 0)
})

test('the first-turn nudge injects one snapshot message on turn 1 step 1', async () => {
  const { apply: applyNudge, STRATEGY_NUDGE } = await import('../src/preset-session.js')
  let listener
  const ctx = {
    on(event, handler) { listener = handler; return () => {} },
  }
  applyNudge(ctx)
  assert.equal(typeof listener, 'function')

  const agent = {}
  const next = async () => ({ kind: 'continue', messages: [] })
  const first = await listener({ agent, turn: 1, step: 1, signal: new AbortController().signal }, next)
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].role, 'user')
  assert.equal(first.messages[0].content[0].text, STRATEGY_NUDGE)
  assert.equal(first.messages[0].source.form, 'snapshot')
  assert.match(STRATEGY_NUDGE, /seeded_fork/u)
  assert.match(STRATEGY_NUDGE, /seeded_rotate/u)

  // Once per agent.
  const second = await listener({ agent, turn: 1, step: 1, signal: new AbortController().signal }, next)
  assert.equal(second.messages.length, 0)

  // Never on later turns or steps.
  const other = {}
  const later = await listener({ agent: other, turn: 2, step: 1, signal: new AbortController().signal }, next)
  assert.equal(later.messages.length, 0)
})
