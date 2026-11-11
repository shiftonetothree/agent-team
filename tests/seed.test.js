import assert from 'node:assert/strict'
import test from 'node:test'

import { balancedLog, appendOpenTurnWithPendingTool } from './helpers.js'
import {
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  buildForkSeed,
  completedTurnBoundary,
  openTurnClosers,
} from '../src/seed.js'

test('completedTurnBoundary prefers the last completed turn', () => {
  const events = balancedLog(2)
  assert.equal(completedTurnBoundary(events), events.at(-1).seq)
  assert.equal(events.at(-1).type, 'turn/end')
})

test('completedTurnBoundary stops at the last completed turn, excluding an open tail', () => {
  const events = appendOpenTurnWithPendingTool(balancedLog(1))
  const boundary = completedTurnBoundary(events)
  assert.equal(events[boundary].type, 'turn/end')
  assert.ok(boundary < events.at(-1).seq, 'the open tail must stay outside the inherited prefix')
})

test('completedTurnBoundary falls back to the last event when no turn ever completed', () => {
  const events = balancedLog(1).filter(event => event.type !== 'turn/end')
  assert.equal(events.at(-1).type, 'step/end')
  assert.equal(completedTurnBoundary(events), events.at(-1).seq)
})

test('completedTurnBoundary is undefined for an empty log', () => {
  assert.equal(completedTurnBoundary([]), undefined)
})

test('a balanced seed copies the prefix and appends only the inherited marker', () => {
  const events = balancedLog(2)
  const boundary = 5 // through the first turn/end
  const seed = buildForkSeed(events, boundary)

  assert.equal(seed.length, boundary + 2)
  assert.deepEqual(seed.at(-1), { type: 'session/end-seed', seq: boundary + 1, time: events[boundary].time, data: { inherited: true } })
  assert.deepEqual(seed.slice(0, boundary + 1), events.slice(0, boundary + 1))
  // Seq continuity: every event index equals its seq.
  seed.forEach((event, index) => assert.equal(event.seq, index))
  // No synthetic closers: the copied prefix ends on a balanced turn.
  assert.equal(seed.filter(event => event.type === 'turn/end').length, 1)
})

test('an open tail receives synthetic step and turn closers with the forked cause', () => {
  const events = appendOpenTurnWithPendingTool(balancedLog(1))
  const boundary = events.length - 1
  const seed = buildForkSeed(events, boundary)

  const closers = seed.slice(boundary + 2)
  assert.deepEqual(closers.map(event => event.type), ['tool/result', 'step/end', 'turn/end'])
  assert.equal(closers.at(-1).data.reason.kind, 'forked')
  const syntheticResult = closers[0]
  assert.equal(syntheticResult.surfaceOp, 'append')
  assert.deepEqual(syntheticResult.sourceEventSeqs, [events.at(-1).seq])
  assert.deepEqual(syntheticResult.data.error.code, TOOL_OUTCOME_UNKNOWN)
  assert.match(syntheticResult.data.message.content[0].text, /history inherited by this branch/u)
  seed.forEach((event, index) => assert.equal(event.seq, index))
})

test('a tool call recorded only in the assistant message reports not-started wording', () => {
  const events = balancedLog(1)
  let seq = events.length
  const turn = 42
  events.push({ type: 'turn/start', seq: seq++, time: 3000, data: { turn } })
  events.push({ type: 'step/start', seq: seq++, time: 3000, data: { turn, step: 1 } })
  events.push({
    type: 'assistant/message',
    seq: seq++,
    time: 3000,
    data: { turn, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'tool-call', id: 'call-9', name: 'write', arguments: '{}' }] } },
  })

  const closers = openTurnClosers(events, { kind: 'forked' })
  const result = closers.find(event => event.type === 'tool/result')
  assert.equal(result.data.error.code, TOOL_NOT_STARTED)
  assert.equal(result.sourceEventSeqs, undefined)
  assert.match(result.data.message.content[0].text, /no record of this tool call starting/u)
})

test('an answered tool call is not re-closed', () => {
  const events = balancedLog(1)
  let seq = events.length
  const turn = 7
  events.push({ type: 'turn/start', seq: seq++, time: 4000, data: { turn } })
  events.push({ type: 'step/start', seq: seq++, time: 4000, data: { turn, step: 1 } })
  events.push({
    type: 'assistant/message',
    seq: seq++,
    time: 4000,
    data: { turn, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'tool-call', id: 'call-2', name: 'read', arguments: '{}' }] } },
  })
  events.push({ type: 'tool/call', seq: seq++, time: 4000, data: { turn, step: 1, callId: 'call-2', name: 'read' } })
  events.push({
    type: 'tool/result',
    seq: seq++,
    time: 4000,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: { id: 'r-2', role: 'tool', toolCallId: 'call-2', isError: false, source: { kind: 'tool', callId: 'call-2' }, content: [{ type: 'text', text: 'ok' }] },
    },
  })

  const closers = openTurnClosers(events, { kind: 'forked' })
  assert.deepEqual(closers.map(event => event.type), ['step/end', 'turn/end'])
})

test('an already balanced log yields no closers', () => {
  assert.deepEqual(openTurnClosers(balancedLog(2), { kind: 'forked' }), [])
})

test('buildForkSeed rejects an out-of-range or non-integer boundary', () => {
  const events = balancedLog(1)
  assert.throws(() => buildForkSeed(events, events.length), /does not exist/u)
  assert.throws(() => buildForkSeed(events, -1), /non-negative safe integer/u)
  assert.throws(() => buildForkSeed(events, 1.5), /non-negative safe integer/u)
})
