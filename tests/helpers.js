/**
 * Test fixtures: minimal session logs, a fake cordis context, and a fake
 * subagent manager that exercises the provider the way upstream's `startLocal`
 * does (preparation first, then child materialization).
 *
 * @module @commonworks/agent-team/tests/helpers
 */

/**
 * Build a balanced log of `turns` completed turns with one assistant message each.
 * @param {number} [turns] - number of completed turns.
 * @param {(index: number) => string} [text] - assistant text per turn.
 * @returns {any[]} session events with contiguous seqs from zero.
 */
export function balancedLog(turns = 1, text = index => `answer ${index + 1}`) {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, time: 1000 + turn, data: { turn } })
    events.push({
      type: 'user/message',
      seq: seq++,
      time: 1000 + turn,
      data: { id: `u-${turn}`, role: 'user', content: [{ type: 'text', text: `question ${turn}` }], source: { kind: 'user' } },
    })
    events.push({ type: 'step/start', seq: seq++, time: 1000 + turn, data: { turn, step: 1 } })
    events.push({
      type: 'assistant/message',
      seq: seq++,
      time: 1000 + turn,
      data: {
        turn,
        step: 1,
        message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: text(turn - 1) }] },
      },
    })
    events.push({ type: 'step/end', seq: seq++, time: 1000 + turn, data: { turn, step: 1 } })
    events.push({ type: 'turn/end', seq: seq++, time: 1000 + turn, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

/**
 * Append an open turn whose assistant message requested a tool that never returned.
 * @param {any[]} events - log to extend (mutated).
 * @returns {any[]} the same array.
 */
export function appendOpenTurnWithPendingTool(events) {
  const turn = 99
  let seq = events.length
  events.push({ type: 'turn/start', seq: seq++, time: 2000, data: { turn } })
  events.push({
    type: 'user/message',
    seq: seq++,
    time: 2000,
    data: { id: `u-${turn}`, role: 'user', content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } },
  })
  events.push({ type: 'step/start', seq: seq++, time: 2000, data: { turn, step: 1 } })
  events.push({
    type: 'assistant/message',
    seq: seq++,
    time: 2000,
    data: {
      turn,
      step: 1,
      message: {
        id: `a-${turn}`,
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
      },
    },
  })
  events.push({ type: 'tool/call', seq: seq++, time: 2000, data: { turn, step: 1, callId: 'call-1', name: 'read' } })
  return events
}

/**
 * A minimal session object with the surface the provider reads.
 * @param {string} id - session id.
 * @param {any[]} [events] - committed events.
 */
export function fakeSession(id, events = []) {
  return {
    id,
    events,
    snapshotEvents: () => events,
    append: (type, data) => {
      const event = { type, seq: events.length, time: Date.now(), data }
      events.push(event)
      return event
    },
  }
}

/**
 * Fake cordis context with a subagent service that mirrors upstream's
 * preparation-then-materialize order.
 * @param {object} [options]
 * @param {Map<string, any>} [options.sessions] - session id to session object.
 */
export function fakeCtx({ sessions = new Map(), deferResults = false } = {}) {
  /** @type {Map<string, any>} */
  const providers = new Map()
  /** @type {any[]} */
  const starts = []

  /** @type {Map<string, any[]>} */
  const listeners = new Map()
  /** @type {Map<string, any>} */
  const services = new Map()

  const ctx = {
    sessions: { get: id => sessions.get(id), list: () => [...sessions.values()] },
    get(name) {
      if (services.has(name)) return services.get(name)
      // Test doubles attach optional services directly (`ctx.tools`, `ctx.systemPrompt`);
      // a real cordis context resolves them from the service store.
      if (Object.hasOwn(ctx, name)) return ctx[name]
      return undefined
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    subagents: {
      registerProvider(provider) {
        if (providers.has(provider.name)) throw new Error(`duplicate provider ${provider.name}`)
        providers.set(provider.name, provider)
        return () => providers.delete(provider.name)
      },
      async startActivation(spec) {
        const provider = providers.get(spec.provider)
        if (provider === undefined) throw new Error(`unknown provider ${spec.provider}`)
        if (spec.childId !== undefined && sessions.has(spec.childId)) {
          throw new Error(`subagent "${spec.childId}" already exists`)
        }
        const prepared = await provider.prepareContinuable({
          sessionId: spec.childId,
          cwd: spec.request.cwd ?? '/work',
          parent: spec.request.parent,
          signal: spec.signal,
        })
        const childId = spec.childId
        const child = fakeSession(childId, prepared.seed === undefined ? [] : [...prepared.seed])
        sessions.set(childId, child)
        const entry = { spec, prepared, settle: () => {} }
        starts.push(entry)
        let result
        if (deferResults) {
          result = new Promise((resolve, reject) => {
            entry.settle = (stopReason = 'completed') => resolve({ stopReason, childId })
            entry.fail = error => reject(error ?? new Error('child failed'))
          })
        } else {
          result = Promise.resolve({ stopReason: 'completed', childId })
        }
        return {
          childId,
          messageId: `msg-${childId}`,
          result,
          dispose: async () => {},
        }
      },
    },
    effect(fn) {
      const disposer = fn()
      return () => (typeof disposer === 'function' ? disposer() : undefined)
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter(candidate => candidate !== listener))
      }
    },
  }

  /**
   * Run the registered waterfall listeners for one event.
   * @param {string} event - event name.
   * @param {any} payload - event payload.
   * @param {any} [initial] - starting decision.
   * @returns {Promise<any>} the final decision.
   */
  async function emitWaterfall(event, payload, initial = { kind: 'continue', messages: [] }) {
    const list = listeners.get(event) ?? []
    let index = 0
    const next = async () => {
      if (index >= list.length) return initial
      const listener = list[index]
      index += 1
      return listener(payload, next)
    }
    return next()
  }

  return { ctx, sessions, providers, starts, services, listeners, emitWaterfall }
}
