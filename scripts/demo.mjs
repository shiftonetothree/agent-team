#!/usr/bin/env node
/**
 * End-to-end demo against a fake host: fork a member, let it answer, rotate it,
 * and print what the next generation actually inherits.
 *
 * The fake host mirrors upstream's `startLocal` order (prepare, then create the
 * child from the returned seed) so the printed trace is the same handshake the
 * real harness performs. Run it with:
 *
 *     node scripts/demo.mjs
 *
 * @module @commonworks/agent-team/scripts/demo
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSeededFork } from '../src/api.js'

const directory = await mkdtemp(join(tmpdir(), 'agent-team-demo-'))

/** Minimal session with the surface the provider reads. */
function session(id, events = []) {
  return { id, events, snapshotEvents: () => events }
}

const parentSession = session('parent-demo')
const sessions = new Map([[parentSession.id, parentSession]])
const providers = new Map()
const starts = []

const ctx = {
  sessions: { get: id => sessions.get(id) },
  get: name => (name === 'sessions' ? ctx.sessions : undefined),
  subagents: {
    registerProvider(provider) {
      providers.set(provider.name, provider)
      return () => providers.delete(provider.name)
    },
    async startActivation(spec) {
      const provider = providers.get(spec.provider)
      const prepared = await provider.prepareContinuable({ sessionId: spec.childId, parent: spec.request.parent, signal: spec.signal, cwd: '/demo' })
      const child = session(spec.childId, prepared.seed === undefined ? [] : [...prepared.seed])
      sessions.set(spec.childId, child)
      starts.push({ spec, prepared, child })
      return {
        childId: spec.childId,
        messageId: `msg-${starts.length}`,
        result: Promise.resolve({ stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  },
  effect(fn) {
    return fn()
  },
}

const seeded = createSeededFork(ctx, { directory, maxGenerations: 4 })
const parent = { session: parentSession }

/** Build one completed turn so the next generation has something to inherit. */
function completeTurn(events, turn, answer) {
  let seq = events.length
  events.push({ type: 'turn/start', seq: seq++, time: 1000 + turn, data: { turn } })
  events.push({
    type: 'user/message',
    seq: seq++,
    time: 1000 + turn,
    data: { id: `u-${turn}`, role: 'user', content: [{ type: 'text', text: `task ${turn}` }], source: { kind: 'user' } },
  })
  events.push({ type: 'step/start', seq: seq++, time: 1000 + turn, data: { turn, step: 1 } })
  events.push({
    type: 'assistant/message',
    seq: seq++,
    time: 1000 + turn,
    data: { turn, step: 1, message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: answer }] } },
  })
  events.push({ type: 'step/end', seq: seq++, time: 1000 + turn, data: { turn, step: 1 } })
  events.push({ type: 'turn/end', seq: seq++, time: 1000 + turn, data: { turn, reason: { kind: 'completed' } } })
}

const first = await seeded.fork({ parent, memberId: 'reviewer', prompt: 'inspect the auth paths' })
completeTurn(sessions.get(first.childId).events, 1, 'found two over-permissive handlers: a.ts:31, b.ts:88')
await first.result

const second = await seeded.rotate({ parent, memberId: 'reviewer', prompt: 'recheck your own findings' })
completeTurn(sessions.get(second.childId).events, 2, 'both still over-permissive; added regression note')
await second.result

const third = await seeded.rotate({ parent, memberId: 'reviewer', prompt: 'summarise the audit' })

const describe = prepared => (prepared.seed === undefined
  ? 'fresh child (no predecessor)'
  : `${prepared.seed.length} seeded events, marker=${prepared.seed.at(-1).type}`)
  + '\n    inherited answers: '
  + (prepared.seed ?? [])
    .filter(event => event.type === 'assistant/message')
    .map(event => JSON.stringify(event.data.message.content[0].text))
    .join(', ')

process.stdout.write(`journal: ${join(directory, 'parent-demo.json')}\n\n`)
starts.forEach((entry, index) => {
  process.stdout.write(`generation ${index} -> ${entry.spec.childId}\n    ${describe(entry.prepared)}\n`)
})

process.stdout.write('\nchain:\n')
for (const entry of await seeded.chain('reviewer', 'parent-demo')) {
  process.stdout.write(`  gen ${entry.generation}  ${entry.childId}  phase=${entry.phase}  seedFrom=${entry.seedFrom ?? '-'}\n`)
}

process.stdout.write(`\nthird generation inherits generation 2: ${third.seedFrom === second.childId}\n`)
process.stdout.write(`second generation inherits generation 1: ${second.seedFrom === first.childId}\n`)
