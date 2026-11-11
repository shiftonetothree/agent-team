import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { JOURNAL_VERSION, LineageJournal } from '../src/journal.js'

async function makeDir() {
  return mkdtemp(join(tmpdir(), 'agent-team-journal-'))
}

test('reserve records an explicit predecessor and reports the chain', async () => {
  const dir = await makeDir()
  const journal = new LineageJournal({ sessionId: 's-1', dir })

  const first = await journal.reserve({ memberId: 'reviewer' })
  assert.equal(first.generation, 0)
  assert.equal(first.seedFrom, undefined)

  const second = await journal.reserve({ memberId: 'reviewer', seedFrom: first.childId })
  assert.equal(second.generation, 1)
  assert.equal(second.seedFrom, first.childId)
  assert.equal(await journal.sourceOf(second.childId), first.childId)
  assert.equal(await journal.sourceOf(first.childId), undefined)

  const chain = await journal.chain('reviewer')
  assert.deepEqual(chain.map(entry => entry.childId), [first.childId, second.childId])
  assert.deepEqual(chain.map(entry => entry.generation), [0, 1])

  // A reservation that never started owns no history, so it is not the
  // inheritable head: rotation would start fresh instead of adopting it.
  assert.equal(await journal.head('reviewer'), undefined)
  await journal.markStarted(first.childId)
  assert.equal((await journal.head('reviewer')).childId, first.childId)
  await journal.markStarted(second.childId)
  assert.equal((await journal.head('reviewer')).childId, second.childId)
})

test('a fresh journal instance recovers the chain from the mirror file', async () => {
  const dir = await makeDir()
  const first = new LineageJournal({ sessionId: 's-1', dir })
  const a = await first.reserve({ memberId: 'reviewer' })
  await first.markStarted(a.childId)
  const b = await first.reserve({ memberId: 'reviewer', seedFrom: a.childId })

  const restarted = new LineageJournal({ sessionId: 's-1', dir })
  assert.equal(await restarted.sourceOf(b.childId), a.childId)
  const chain = await restarted.chain('reviewer')
  assert.deepEqual(chain.map(entry => entry.childId), [a.childId, b.childId])
  assert.equal(chain[0].phase, 'started')

  const onDisk = JSON.parse(await readFile(join(dir, 's-1.json'), 'utf8'))
  assert.equal(onDisk.version, JOURNAL_VERSION)
  assert.equal(onDisk.records.filter(record => record.kind === 'reserve').length, 2)
})

test('concurrent reservations receive ordered generations and unique ids', async () => {
  const dir = await makeDir()
  const journal = new LineageJournal({ sessionId: 's-2', dir })
  const results = await Promise.all(
    Array.from({ length: 5 }, () => journal.reserve({ memberId: 'reviewer' })),
  )
  assert.deepEqual(results.map(result => result.generation), [0, 1, 2, 3, 4])
  assert.equal(new Set(results.map(result => result.childId)).size, 5)
  assert.equal((await journal.chain('reviewer')).length, 5)
})

test('the reincarnation cap refuses further rotations', async () => {
  const dir = await makeDir()
  const journal = new LineageJournal({ sessionId: 's-3', dir, maxGenerations: 2 })
  await journal.reserve({ memberId: 'reviewer' })
  await journal.reserve({ memberId: 'reviewer' })
  await assert.rejects(() => journal.reserve({ memberId: 'reviewer' }), /reincarnation cap/u)
})

test('phase transitions are recorded per generation', async () => {
  const dir = await makeDir()
  const journal = new LineageJournal({ sessionId: 's-4', dir })
  const { childId } = await journal.reserve({ memberId: 'reviewer' })
  assert.equal((await journal.entryOf(childId)).phase, 'reserved')
  await journal.markStarted(childId)
  assert.equal((await journal.entryOf(childId)).phase, 'started')
  await journal.markSettled(childId, { stopReason: 'max-tokens' })
  const settled = await journal.entryOf(childId)
  assert.equal(settled.phase, 'settled')
  assert.equal(settled.stopReason, 'max-tokens')
})

test('a failure marks the generation failed without reusing its id', async () => {
  const dir = await makeDir()
  const journal = new LineageJournal({ sessionId: 's-5', dir })
  const failed = await journal.reserve({ memberId: 'reviewer' })
  await journal.markFailed(failed.childId, new Error('provider exploded'))
  assert.equal((await journal.entryOf(failed.childId)).phase, 'failed')
  assert.match((await journal.entryOf(failed.childId)).error, /provider exploded/u)

  const next = await journal.reserve({ memberId: 'reviewer', seedFrom: failed.childId })
  assert.notEqual(next.childId, failed.childId)
  assert.equal(next.generation, 1)
})

test('unknown children cannot be marked', async () => {
  const dir = await makeDir()
  const journal = new LineageJournal({ sessionId: 's-6', dir })
  await assert.rejects(() => journal.markStarted('nope'), /reserve it first/u)
  await assert.rejects(() => journal.markSettled('nope'), /unknown child/u)
})

test('a corrupt mirror starts an empty journal instead of failing', async () => {
  const dir = await makeDir()
  await writeFile(join(dir, 's-7.json'), '{not json', 'utf8')
  const journal = new LineageJournal({ sessionId: 's-7', dir })
  const reserved = await journal.reserve({ memberId: 'reviewer' })
  assert.equal(reserved.generation, 0)
  assert.match(await readFile(join(dir, 's-7.json'), 'utf8'), /"version": 1/u)
})

test('the optional session record sink receives every record and cannot break the journal', async () => {
  const dir = await makeDir()
  const seen = []
  const journal = new LineageJournal({
    sessionId: 's-8',
    dir,
    appendRecord: async record => seen.push(record.kind),
  })
  const first = await journal.reserve({ memberId: 'reviewer' })
  await journal.markStarted(first.childId)
  await journal.markSettled(first.childId, { stopReason: 'completed' })
  assert.deepEqual(seen, ['reserve', 'start', 'settle'])

  const throwing = new LineageJournal({
    sessionId: 's-9',
    dir,
    appendRecord: () => {
      throw new Error('session log rejected the record')
    },
  })
  const reserved = await throwing.reserve({ memberId: 'reviewer' })
  assert.equal(reserved.generation, 0)
  assert.equal((await throwing.chain('reviewer')).length, 1)
})

test('two journal instances over one file share their records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-journal-'))
  const first = new LineageJournal({ sessionId: 's-10', dir })
  const reserved = await first.reserve({ memberId: 'reviewer' })
  const second = new LineageJournal({ sessionId: 's-10', dir })

  // One object per (directory, session): concurrent views would each rewrite the
  // mirror from their own record list and could drop the other's reservation.
  assert.equal(second, first)
  assert.equal((await second.chain('reviewer')).length, 1)
  assert.equal((await second.sourceOf(reserved.childId)), undefined)
})
