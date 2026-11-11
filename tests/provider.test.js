import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SeededForkProvider, readSessionEvents } from '../src/provider.js'
import { LineageJournal } from '../src/journal.js'
import { balancedLog, fakeCtx, fakeSession } from './helpers.js'

async function journalWithPredecessor(predecessorId = 'child-1') {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-provider-'))
  const journal = new LineageJournal({ sessionId: 'orchestrator', dir })
  const reserved = await journal.reserve({ memberId: 'reviewer', seedFrom: predecessorId })
  return { journal, childId: reserved.childId, predecessorId }
}

test('a reserved child is seeded from its predecessor log', async () => {
  const { journal, childId, predecessorId } = await journalWithPredecessor()
  const events = balancedLog(2)
  const provider = new SeededForkProvider({
    registry: { findByChild: async id => (id === childId ? journal : undefined) },
    readEvents: async (ctx, sessionId) => {
      assert.equal(sessionId, predecessorId)
      return events
    },
  })

  const prepared = await provider.prepareContinuable({ sessionId: childId, parent: {} })
  assert.ok(Array.isArray(prepared.seed))
  // Two completed turns -> boundary is the final turn/end, marker appended after it.
  assert.equal(prepared.seed.length, events.length + 1)
  assert.equal(prepared.seed.at(-1).type, 'session/end-seed')
  prepared.seed.forEach((event, index) => assert.equal(event.seq, index))

  const trace = provider.trace.at(-1)
  assert.equal(trace.seeded, true)
  assert.equal(trace.source, predecessorId)
  assert.equal(trace.inheritedEvents, events.length)
  assert.equal(trace.syntheticClosers, 0)
})

test('an unrecorded child id becomes a fresh child, not an error', async () => {
  const provider = new SeededForkProvider({ registry: { findByChild: async () => undefined } })
  assert.deepEqual(await provider.prepareContinuable({ sessionId: 'unknown' }), {})
  assert.equal(provider.trace.at(-1).reason, 'no-journal-entry')
})

test('a member without a predecessor becomes a fresh child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-provider-'))
  const journal = new LineageJournal({ sessionId: 'orchestrator', dir })
  const { childId } = await journal.reserve({ memberId: 'reviewer' })
  const provider = new SeededForkProvider({
    registry: { findByChild: async () => journal },
    readEvents: async () => {
      throw new Error('must not read a predecessor for a first generation')
    },
  })
  assert.deepEqual(await provider.prepareContinuable({ sessionId: childId }), {})
  assert.equal(provider.trace.at(-1).reason, 'no-predecessor')
})

test('an unreadable predecessor degrades to a fresh child and is traced', async () => {
  const { journal, childId } = await journalWithPredecessor()
  const provider = new SeededForkProvider({
    registry: { findByChild: async () => journal },
    readEvents: async () => {
      throw new Error('session log is gone')
    },
  })
  assert.deepEqual(await provider.prepareContinuable({ sessionId: childId }), {})
  const trace = provider.trace.at(-1)
  assert.equal(trace.seeded, false)
  assert.equal(trace.reason, 'read-failed')
  assert.match(trace.error, /session log is gone/u)
})

test('an empty predecessor log becomes a fresh child', async () => {
  const { journal, childId } = await journalWithPredecessor()
  const provider = new SeededForkProvider({
    registry: { findByChild: async () => journal },
    readEvents: async () => [],
  })
  assert.deepEqual(await provider.prepareContinuable({ sessionId: childId }), {})
  assert.equal(provider.trace.at(-1).reason, 'empty-predecessor')
})

test('the seed inherits only completed turns and drops an open tail', async () => {
  const { journal, childId } = await journalWithPredecessor()
  const events = balancedLog(1)
  const completedLength = events.length
  let seq = events.length
  events.push({ type: 'turn/start', seq: seq++, time: 9000, data: { turn: 9 } })
  events.push({ type: 'step/start', seq: seq++, time: 9000, data: { turn: 9, step: 1 } })
  const provider = new SeededForkProvider({
    registry: { findByChild: async () => journal },
    readEvents: async () => events,
  })
  const prepared = await provider.prepareContinuable({ sessionId: childId })
  // boundary = the completed turn/end, so the open turn 9 is not inherited at all.
  assert.equal(prepared.seed.length, completedLength + 1)
  assert.equal(prepared.seed.at(-1).type, 'session/end-seed')
  assert.ok(!prepared.seed.some(event => event.type === 'turn/start' && event.data.turn === 9))
})

test('a predecessor with no completed turn is closed with forked closers', async () => {
  const { journal, childId } = await journalWithPredecessor()
  const events = [
    { type: 'turn/start', seq: 0, time: 8000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 8000, data: { turn: 1, step: 1 } },
  ]
  const provider = new SeededForkProvider({
    registry: { findByChild: async () => journal },
    readEvents: async () => events,
  })
  const prepared = await provider.prepareContinuable({ sessionId: childId })
  const closerTypes = prepared.seed.slice(events.length).map(event => event.type)
  assert.deepEqual(closerTypes, ['session/end-seed', 'step/end', 'turn/end'])
  assert.equal(prepared.seed.at(-1).data.reason.kind, 'forked')
})

test('readSessionEvents prefers the live session, then persistence paging', async () => {
  const live = fakeSession('live-1', balancedLog(1))
  const { ctx } = fakeCtx({ sessions: new Map([['live-1', live]]) })
  assert.equal((await readSessionEvents(ctx, 'live-1')).length, live.events.length)

  const stored = balancedLog(3)
  const persistence = {
    async open(id, access) {
      assert.equal(id, 'stored-1')
      assert.equal(access, 'read')
      return {
        async read(offset = 0, length = 256) {
          return { eventState: { kind: 'shared' }, events: stored.slice(offset, offset + length) }
        },
      }
    },
  }
  const reader = { get: name => (name === 'sessionPersistence' ? persistence : undefined) }
  assert.deepEqual(await readSessionEvents(reader, 'stored-1'), stored)
})

test('readSessionEvents reports a missing session instead of inventing one', async () => {
  await assert.rejects(() => readSessionEvents({ get: () => undefined }, 'nope'), /no live session and no sessionPersistence/u)
})
