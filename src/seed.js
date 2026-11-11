/**
 * Fork-seed construction, ported from `@deepseek-ai/dsh-session`
 * (`src/fork.ts` + `src/repair.ts`).
 *
 * The port exists because an external plugin cannot import the host's copy of
 * `@deepseek-ai/dsh-session` when the harness runs from a packaged asar. Keep
 * this file byte-faithful to upstream semantics: a seed must be contiguous from
 * seq 0, balanced (no open step/turn), and must close an open tail with
 * `forked`-cause synthetic tool results.
 *
 * @module @commonworks/agent-team/seed
 */

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** Model-visible wording of the synthetic error tool results, keyed by cause. */
const CLOSER_TEXT = {
  interrupted: {
    started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
  },
  forked: {
    started: 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  },
}

/**
 * Track unanswered assistant tool requests from one session's committed events.
 * Mirrors `ToolCallRecovery` in upstream `repair.ts`.
 */
export class ToolCallRecovery {
  /** @type {Map<string, { turn: number, step: number, callSeq?: number }>} */
  #pendingCalls = new Map()

  /** @type {{ seq: number, time: number } | undefined} */
  #last

  /** @param {{ kind: 'interrupted' | 'forked' }} cause */
  constructor(cause = { kind: 'interrupted' }) {
    this.cause = cause
  }

  /**
   * Consume the next committed event.
   * @param {any} event - session event in sequence order.
   */
  observe(event) {
    this.#last = { seq: event.seq, time: event.time }
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        this.#pendingCalls.clear()
        break
      case 'assistant/message':
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            this.#pendingCalls.set(block.id, { turn: event.data.turn, step: event.data.step })
          }
        }
        break
      case 'tool/call': {
        const entry = this.#pendingCalls.get(event.data.callId)
        if (entry) entry.callSeq = event.seq
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const entry = this.#pendingCalls.get(callId)
        if (event.surfaceOp === 'append' && entry !== undefined
          && entry.turn === event.data.turn && entry.step === event.data.step) {
          this.#pendingCalls.delete(callId)
        }
        break
      }
      default:
        break
    }
  }

  /**
   * Build conservative error results in assistant order without changing tracked state.
   * @returns {any[]} pending tool-result events.
   */
  results() {
    if (this.#last === undefined) return []
    let seq = this.#last.seq + 1
    const time = this.#last.time
    const results = []
    const text = CLOSER_TEXT[this.cause.kind]
    for (const [callId, { turn, step, callSeq }] of this.#pendingCalls) {
      const started = callSeq !== undefined
      /** @type {any} */
      const message = {
        id: `${this.cause.kind}-tool-result-${callId}-${seq}`,
        role: 'tool',
        toolCallId: callId,
        isError: true,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: started ? text.started : text.notStarted }],
      }
      results.push({
        type: 'tool/result',
        seq: seq++,
        time,
        data: {
          turn,
          step,
          message,
          error: started
            ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
            : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
        },
        surfaceOp: 'append',
        ...(started ? { sourceEventSeqs: [callSeq] } : {}),
      })
    }
    return results
  }
}

/**
 * Return deterministic synthetic events that close an open tail turn.
 * @param {readonly any[]} events - the committed log prefix to scan.
 * @param {{ kind: 'interrupted' | 'forked' }} cause - selects wording and the turn-end reason.
 * @returns {any[]} synthetic closer events; empty when the log is already balanced.
 */
export function openTurnClosers(events, cause) {
  /** @type {number | null} */
  let openTurn = null
  /** @type {number | null} */
  let openStep = null
  const recovery = new ToolCallRecovery(cause)
  for (const event of events) {
    recovery.observe(event)
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      default:
        break
    }
  }

  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  const closers = recovery.results()
  let seq = last.seq + closers.length + 1
  const time = last.time

  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: cause.kind } } })
  return closers
}

/**
 * Copy an inclusive event prefix, mark its inherited cut, and close its open tail.
 *
 * @param {readonly any[]} events - source log with contiguous seqs from zero.
 * @param {number} boundary - inclusive source event seq the child inherits through.
 * @returns {any[]} the seed: the copied prefix, the `session/end-seed` marker, then synthetic closers.
 */
export function buildForkSeed(events, boundary) {
  if (!Number.isSafeInteger(boundary) || boundary < 0) {
    throw new Error(`fork boundary must be a non-negative safe integer, got ${String(boundary)}`)
  }
  if (boundary >= events.length) {
    throw new Error(`fork boundary ${boundary} does not exist in a log of ${events.length} events`)
  }
  const prefix = events.slice(0, boundary + 1)
  prefix.push({
    type: 'session/end-seed',
    seq: boundary + 1,
    time: events[boundary].time,
    data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }))
}

/**
 * The inclusive seq of the last completed turn, or the last event when the log
 * never completed one. Upstream's fork provider inherits only completed turns;
 * an open tail is closed by `buildForkSeed` anyway, so the fallback stays safe.
 *
 * @param {readonly any[]} events - source log.
 * @returns {number | undefined} boundary seq; undefined for an empty log.
 */
export function completedTurnBoundary(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/end') return events[i].seq
  }
  const last = events.at(-1)
  return last === undefined ? undefined : last.seq
}
