#!/usr/bin/env node
/**
 * Decode a DSH session log and report the facts this experiment cares about:
 * whether the child inherited a seed, how many events it inherited, and what the
 * first model request reported as cache-read tokens.
 *
 * Usage:
 *   node scripts/inspect-session.mjs <session.v4.jsonl.zstd> [more...]
 *
 * @module @commonworks/agent-team/scripts/inspect-session
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Split a concatenated zstd stream into frames.
 *
 * DSH appends one zstd frame per flush, and Node's `zstdDecompressSync` stops
 * after the first frame, so the raw file has to be split first. The split scans
 * for the zstd frame magic; a magic byte sequence inside compressed payload is
 * possible in principle, so this is an inspection tool, not a decoder.
 *
 * @param {Buffer} buffer - the whole file.
 * @returns {Buffer[]} candidate frames.
 */
function splitFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let cursor = 0
  for (;;) {
    const index = buffer.indexOf(magic, cursor)
    if (index < 0) break
    starts.push(index)
    cursor = index + magic.length
  }
  if (starts.length <= 1) return [buffer]
  return starts.map((start, position) => buffer.subarray(start, starts[position + 1] ?? buffer.length))
}

/**
 * Read one session file into events.
 * @param {string} path - `.jsonl.zstd` (or plain `.jsonl`) session file.
 * @returns {any[]} parsed events in seq order.
 */
function readEvents(path) {
  const raw = readFileSync(path)
  const text = path.endsWith('.zstd')
    ? splitFrames(raw)
      .map(frame => {
        try {
          return zstdDecompressSync(frame).toString('utf8')
        } catch {
          return ''
        }
      })
      .join('')
    : raw.toString('utf8')
  return text
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
}

/**
 * Summarize one session log.
 * @param {string} path - session file.
 * @returns {string} report text.
 */
export function summarize(path) {
  const events = readEvents(path)
  const counts = new Map()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  const seedIndex = events.findIndex(event => event.type === 'session/end-seed')
  const firstHeader = events.find(event => event.type === 'request/header')
  const usages = events
    .filter(event => event.type === 'assistant/message' && event.data?.usage !== undefined)
    .map(event => event.data.usage)

  const lines = []
  lines.push(`file        ${path}`)
  lines.push(`events      ${events.length}`)
  lines.push(`inherited   ${seedIndex >= 0 ? `${seedIndex} events, marker at seq ${seedIndex}` : 'no seed (fresh child)'}`)
  if (seedIndex >= 0) {
    const inherited = events.slice(0, seedIndex)
    const inheritedTurns = inherited.filter(event => event.type === 'turn/end').length
    const inheritedAnswers = inherited
      .filter(event => event.type === 'assistant/message')
      .map(event => {
        const blocks = event.data?.message?.content ?? []
        return blocks.filter(block => block.type === 'text').map(block => block.text).join(' ')
      })
      .filter(text => text.length > 0)
    lines.push(`  completed turns ${inheritedTurns}`)
    for (const answer of inheritedAnswers) lines.push(`  inherited answer: ${answer.slice(0, 160).replaceAll('\n', '\\n')}`)
  }
  if (firstHeader !== undefined) {
    const toolCount = firstHeader.data?.tools?.length ?? firstHeader.data?.header?.tools?.length
    lines.push(`first header tools ${toolCount ?? 'unknown'}`)
  }
  if (usages.length > 0) {
    lines.push(`usages      ${usages.map(usage => `in=${usage.inputTokens ?? '?'} cacheRead=${usage.cacheReadTokens ?? '?'} out=${usage.outputTokens ?? '?'}`).join(' | ')}`)
  }
  lines.push(`event types ${[...counts.entries()].map(([type, count]) => `${type}×${count}`).join(', ')}`)
  return lines.join('\n')
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('inspect-session.mjs')) {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    process.stderr.write('usage: node scripts/inspect-session.mjs <session.v4.jsonl.zstd> [...]\n')
    process.exitCode = 1
  } else {
    process.stdout.write(files.map(summarize).join('\n\n') + '\n')
  }
}
