/**
 * A subagent backend that seeds a child session from *another session's* log.
 *
 * Upstream `fork` seeds from the delegating parent. This provider seeds from
 * whatever session the journal recorded for the reserved child id, which lets an
 * orchestrator rotate a member through successive child sessions
 * (`child1 -> child2 -> child3`) while each new session starts with the previous
 * one's completed transcript.
 *
 * @module @commonworks/agent-team/provider
 */

import { buildForkSeed, completedTurnBoundary } from './seed.js'

/** Capability declaration with parity with the in-process fork backend. */
const DEFAULT_CAPABILITIES = Object.freeze({
  agentOptions: true,
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
})

/**
 * Read a session's committed events, live first, persistence second.
 *
 * @param {any} ctx - cordis context carrying `sessions` and/or `sessionPersistence`.
 * @param {string} sessionId - durable session id to read.
 * @returns {Promise<any[]>} committed events in seq order.
 */
export async function readSessionEvents(ctx, sessionId) {
  const sessions = ctx?.get?.('sessions')
  const live = sessions?.get?.(sessionId)
  if (live !== undefined && typeof live.snapshotEvents === 'function') {
    return [...live.snapshotEvents()]
  }
  const persistence = ctx?.get?.('sessionPersistence')
  if (persistence === undefined) {
    throw new Error(`cannot read session "${sessionId}": no live session and no sessionPersistence service`)
  }
  const handle = await persistence.open(sessionId, 'read')
  const events = []
  const pageSize = 256
  for (;;) {
    const page = await handle.read(events.length, pageSize)
    if (page.events.length === 0) break
    events.push(...page.events)
    if (page.events.length < pageSize) break
  }
  return events
}

/**
 * Subagent backend that seeds each reserved child from a recorded predecessor.
 */
export class SeededForkProvider {
  /**
   * @param {object} options
   * @param {string} [options.name] - registry name (must be unique per composition).
   * @param {{ findByChild: (childId: string) => Promise<any | undefined> }} options.registry
   *   durable lookup from child id to the journal that reserved it.
   * @param {(ctx: any, sessionId: string) => Promise<any[]>} [options.readEvents]
   *   event reader override, mainly for tests.
   * @param {any} [options.capabilities] - capability declaration override.
   * @param {any} [options.ctx] - cordis context used by the default event reader.
   */
  constructor({ name = 'agent-team', registry, readEvents, capabilities, ctx } = {}) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('SeededForkProvider requires a name')
    if (registry === undefined || typeof registry.findByChild !== 'function') {
      throw new Error('SeededForkProvider requires a registry with findByChild()')
    }
    this.name = name
    this.inheritsParentContext = true
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...(capabilities ?? {}) }
    this.registry = registry
    this.ctx = ctx
    this.readEvents = readEvents ?? ((context, sessionId) => readSessionEvents(context, sessionId))
    /** @type {any[]} preparation trace, newest last; bounded by the caller's inspection needs. */
    this.trace = []
  }

  /**
   * Contribute the detached creation inputs for one reserved child.
   *
   * Returns `{}` (a fresh child) when the child id was never reserved, when the
   * predecessor log is empty, or when the predecessor cannot be read. A missing
   * seed never fails the delegation: rotation degrades to a fresh child and the
   * trace records why.
   *
   * @param {{ sessionId: string, parent: any }} request - upstream continuation request.
   * @returns {Promise<{ seed?: readonly any[] }>} seed events, or an empty spec.
   */
  async prepareContinuable(request) {
    const childId = request?.sessionId
    const journal = await this.registry.findByChild(childId)
    if (journal === undefined) {
      await this.#record({ childId, seeded: false, reason: 'no-journal-entry' })
      return {}
    }
    const source = await journal.sourceOf(childId)
    if (source === undefined || source === null) {
      await this.#record({ childId, journal, seeded: false, reason: 'no-predecessor' })
      return {}
    }
    let events
    try {
      events = await this.readEvents(this.ctx, source)
    } catch (error) {
      await this.#record({ childId, journal, seeded: false, reason: 'read-failed', source, error: String(error?.message ?? error) })
      return {}
    }
    const boundary = completedTurnBoundary(events)
    if (boundary === undefined) {
      await this.#record({ childId, journal, seeded: false, reason: 'empty-predecessor', source })
      return {}
    }
    const seed = buildForkSeed(events, boundary)
    await this.#record({
      childId,
      journal,
      seeded: true,
      source,
      boundary,
      inheritedEvents: boundary + 1,
      seedEvents: seed.length,
      syntheticClosers: seed.length - (boundary + 2),
    })
    return { seed }
  }

  /**
   * Append one preparation record to the bounded trace.
   * @param {any} record - trace entry.
   */
  async #record(record) {
    const entry = { ...record, at: Date.now() }
    this.trace.push(entry)
    if (this.trace.length > 100) this.trace.shift()
    if (record.journal !== undefined && record.childId !== undefined) {
      const { journal, ...persisted } = record
      try {
        await journal.markPrepared(record.childId, persisted)
      } catch {
        // Durable provenance is diagnostic: losing the record must not fail the
        // delegation that is being prepared.
      }
    }
  }
}
