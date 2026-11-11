/**
 * Durable lineage journal: which child session id will be seeded from which
 * predecessor, and how far each member's reincarnation chain has progressed.
 *
 * The journal answers exactly one question the harness does not answer for a
 * third-party provider: `prepareContinuable(request)` receives the reserved
 * child session id and nothing else, so the plugin keys seed sources by that id.
 *
 * Durability has two tiers:
 *
 * 1. **Session record** (preferred). When the caller injects `appendRecord`
 *    (upstream's `appendPluginRecord` from `@deepseek-ai/dsh-session`), every
 *    record is also committed to the orchestrator's session log as an
 *    `ignorable` plugin record. That copy survives restart, travels into fork
 *    seeds, and never enters the model-visible surface.
 * 2. **Workspace file** (always available). An atomic JSON file under
 *    `<dir>/<sessionId>.json` mirrors the same records so recovery works even
 *    when no session is reachable, and so an operator can inspect the chain.
 *
 * The two stores are written from the same record list; the file is the
 * recovery source and the session copy is the auditable one.
 *
 * @module @commonworks/agent-team/journal
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Bumped when the on-disk record shape changes incompatibly. */
export const JOURNAL_VERSION = 1

/**
 * One journal per (directory, session) in this process.
 *
 * Two views of the same file would each hold their own record list and rewrite
 * the mirror from it, so a restart simulation, a second plugin instance, or an
 * orchestrator that opens the journal twice must observe the same object.
 * @type {Map<string, any>}
 */
const OPEN_JOURNALS = new Map()

/** Record kinds the ledger understands. */
const RECORD_KINDS = new Set(['reserve', 'prepare', 'start', 'settle', 'fail', 'abandon', 'auto-wake'])

/**
 * Replace characters that are unsafe in a file name.
 * @param {string} sessionId - durable session id.
 * @returns {string} a filesystem-safe stem.
 */
function fileStem(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 120)
}

/**
 * Fold records into the derived ledger.
 * @param {readonly any[]} records - journal records in commit order.
 */
function foldRecords(records) {
  /** @type {Map<string, any>} */
  const entries = new Map()
  /** @type {Map<string, string[]>} */
  const chains = new Map()
  /** @type {Map<string, number>} automatic reincarnations per member, so a
   *  message ping-pong cannot spin forever. */
  const wakes = new Map()

  const entryOf = (childId) => {
    let entry = entries.get(childId)
    if (entry === undefined) {
      entry = { childId, memberId: undefined, generation: 0, seedFrom: undefined, phase: 'reserved', stopReason: undefined, error: undefined }
      entries.set(childId, entry)
    }
    return entry
  }

  for (const record of records) {
    if (record === null || typeof record !== 'object' || !RECORD_KINDS.has(record.kind)) continue
    const entry = entryOf(record.childId)
    if (record.memberId !== undefined) entry.memberId = record.memberId
    if (record.kind === 'reserve') {
      entry.generation = record.generation ?? entry.generation
      entry.seedFrom = record.seedFrom
      entry.phase = 'reserved'
      if (record.peers !== undefined) entry.peers = record.peers
      if (record.reportWhen !== undefined) entry.reportWhen = record.reportWhen
      if (record.memberId !== undefined) {
        const chain = chains.get(record.memberId) ?? []
        if (!chain.includes(record.childId)) chain.push(record.childId)
        chains.set(record.memberId, chain)
      }
      continue
    }
    if (record.kind === 'prepare') {
      entry.prepared = record.prepared
      continue
    }
    if (record.kind === 'start') {
      entry.phase = 'started'
      continue
    }
    if (record.kind === 'settle') {
      entry.phase = 'settled'
      entry.stopReason = record.stopReason
      continue
    }
    if (record.kind === 'fail') {
      // A generation that failed after its activation started still owns usable
      // history; one that never started owns nothing to inherit.
      entry.failedAfterStart = entry.phase === 'started'
      entry.phase = 'failed'
      entry.error = record.error
      continue
    }
    if (record.kind === 'abandon') {
      entry.phase = 'abandoned'
      continue
    }
    if (record.kind === 'auto-wake') {
      const member = record.memberId ?? entry.memberId
      if (member !== undefined) wakes.set(member, (wakes.get(member) ?? 0) + 1)
    }
  }

  return { entries, chains, wakes }
}

/**
 * Durable lineage journal owned by one orchestrator session.
 */
export class LineageJournal {
  /** @type {any[]} */
  #records = []

  /** @type {boolean} */
  #loaded = false

  /** @type {Promise<void>} */
  #writeChain = Promise.resolve()

  /** @type {Promise<unknown>} */
  #queue = Promise.resolve()

  /**
   * Run one mutation with exclusive access, so generation numbering and record
   * order stay exact under concurrent rotations.
   * @template T
   * @param {() => Promise<T>} run - mutation body.
   * @returns {Promise<T>}
   */
  async #serial(run) {
    const result = this.#queue.then(run, run)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * @param {object} options
   * @param {string} options.sessionId - orchestrator session id that owns this journal.
   * @param {string} options.dir - absolute directory holding journal files.
   * @param {number} [options.maxGenerations] - reincarnation cap per member (default 16).
   * @param {(record: any) => void | Promise<void>} [options.appendRecord] - optional
   *   session-record sink; upstream `appendPluginRecord` bound to this session.
   */
  constructor({ sessionId, dir, maxGenerations = 16, appendRecord }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('LineageJournal requires a sessionId')
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('LineageJournal requires a dir')
    this.sessionId = sessionId
    this.dir = dir
    this.maxGenerations = maxGenerations
    this.appendRecord = appendRecord
    this.file = join(dir, `${fileStem(sessionId)}.json`)
    const cacheKey = `${dir}\0${fileStem(sessionId)}`
    const existing = OPEN_JOURNALS.get(cacheKey)
    if (existing !== undefined) return existing
    OPEN_JOURNALS.set(cacheKey, this)
  }

  /** @returns {string} absolute journal file path. */
  get filePath() {
    return this.file
  }

  /**
   * Load records from the mirror file once, then keep them in memory.
   * A missing, unreadable, or foreign-version file starts an empty journal: the
   * chain is recoverable only when its evidence exists, never invented.
   * @returns {Promise<void>}
   */
  async #load() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed?.version === JOURNAL_VERSION && Array.isArray(parsed.records)) {
        this.#records = parsed.records.filter(record => record !== null && typeof record === 'object')
      }
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') {
        // A corrupt mirror must not take the orchestration down; it is a cache of
        // records that the session copy (when present) can supersede.
        this.#records = []
      }
    }
  }

  /**
   * Persist the current record list atomically (temp file + rename).
   * @returns {Promise<void>}
   */
  async #persist() {
    const payload = JSON.stringify({ version: JOURNAL_VERSION, sessionId: this.sessionId, records: this.#records }, null, 2)
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    const write = async () => {
      await mkdir(this.dir, { recursive: true })
      await writeFile(tmp, payload, 'utf8')
      // Windows can hold the destination handle briefly after another writer or
      // an indexer touched it; retry the replace instead of losing the record.
      let attempt = 0
      for (;;) {
        try {
          await rename(tmp, this.file)
          return
        } catch (error) {
          const code = /** @type {any} */ (error)?.code
          if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt >= 5) throw error
          attempt += 1
          await new Promise(resolve => setTimeout(resolve, 10 * attempt))
        }
      }
    }
    this.#writeChain = this.#writeChain.then(write, write)
    await this.#writeChain
  }

  /**
   * Append one record to memory, the mirror, and the optional session copy.
   * @param {any} record - journal record.
   * @returns {Promise<any>} the committed record.
   */
  async #commit(record) {
    await this.#load()
    this.#records.push(record)
    await this.#persist()
    if (this.appendRecord !== undefined) {
      try {
        await this.appendRecord({
          kind: record.kind,
          childId: record.childId,
          memberId: record.memberId,
          generation: record.generation,
          seedFrom: record.seedFrom,
          stopReason: record.stopReason,
          error: record.error,
          at: record.at,
        })
      } catch {
        // The session copy is the auditable tier, never the recovery gate: a log
        // that rejects the record must not fail the orchestration that owns it.
      }
    }
    return record
  }

  /**
   * Reserve the next reincarnation id for one member.
   *
   * The predecessor is explicit, never positional: a failed or concurrent
   * attempt therefore cannot silently re-target the next generation.
   *
   * @param {object} request
   * @param {string} request.memberId - stable member identity inside the orchestration.
   * @param {string} [request.seedFrom] - predecessor child session id, if any.
   * @param {string} [request.childId] - pre-allocated id (defaults to a fresh uuid).
   * @param {any[]} [request.peers] - collaboration links declared for this generation.
   * @param {string} [request.reportWhen] - escalation rule declared for this generation.
   * @returns {Promise<{ childId: string, generation: number, seedFrom?: string }>}
   */
  async reserve({ memberId, seedFrom, childId, peers, reportWhen }) {
    if (typeof memberId !== 'string' || memberId.length === 0) throw new Error('reserve requires memberId')
    return this.#serial(async () => {
    await this.#load()
    const { chains } = foldRecords(this.#records)
    const chain = chains.get(memberId) ?? []
    const generation = chain.length
    if (generation >= this.maxGenerations) {
      throw new Error(`member "${memberId}" reached the reincarnation cap (${this.maxGenerations}); archive the oldest generation instead of rotating further`)
    }
    const resolved = childId ?? randomUUID()
    await this.#commit({
      kind: 'reserve', childId: resolved, memberId, generation, seedFrom, at: Date.now(),
      ...(peers === undefined ? {} : { peers }),
      ...(reportWhen === undefined ? {} : { reportWhen }),
    })
    return seedFrom === undefined
      ? { childId: resolved, generation }
      : { childId: resolved, generation, seedFrom }
    })
  }

  /**
   * Record what the provider actually did for one child: whether it seeded the
   * child and, when it did not, why. Without this the failure to inherit is
   * invisible: a fresh child looks identical to a successful one.
   * @param {string} childId - reserved child session id.
   * @param {any} prepared - preparation trace entry.
   * @returns {Promise<void>}
   */
  async markPrepared(childId, prepared) {
    await this.#load()
    const { entries } = foldRecords(this.#records)
    const entry = entries.get(childId)
    if (entry === undefined) return
    await this.#commit({ kind: 'prepare', childId, memberId: entry.memberId, prepared, at: Date.now() })
  }

  /**
   * Mark a reserved child as started (its activation was accepted).
   * @param {string} childId - reserved child session id.
   * @returns {Promise<void>}
   */
  async markStarted(childId) {
    await this.#load()
    const { entries } = foldRecords(this.#records)
    const entry = entries.get(childId)
    if (entry === undefined) throw new Error(`cannot start unknown child "${childId}"; reserve it first`)
    await this.#commit({ kind: 'start', childId, memberId: entry.memberId, at: Date.now() })
  }

  /**
   * Record the terminal outcome of one generation.
   * @param {string} childId - child session id.
   * @param {{ stopReason?: string }} [outcome] - observed stop reason.
   * @returns {Promise<void>}
   */
  async markSettled(childId, outcome = {}) {
    await this.#load()
    const { entries } = foldRecords(this.#records)
    const entry = entries.get(childId)
    if (entry === undefined) throw new Error(`cannot settle unknown child "${childId}"`)
    await this.#commit({ kind: 'settle', childId, memberId: entry.memberId, stopReason: outcome.stopReason, at: Date.now() })
  }

  /**
   * Record a failed attempt. The id stays consumed; the next generation declares
   * its predecessor explicitly, so a gap never re-targets the chain.
   * @param {string} childId - child session id.
   * @param {unknown} error - failure text or error.
   * @returns {Promise<void>}
   */
  async markFailed(childId, error) {
    await this.#load()
    const { entries } = foldRecords(this.#records)
    const entry = entries.get(childId)
    if (entry === undefined) throw new Error(`cannot fail unknown child "${childId}"`)
    const text = error instanceof Error ? error.message : String(error ?? 'unknown failure')
    await this.#commit({ kind: 'fail', childId, memberId: entry.memberId, error: text.slice(0, 400), at: Date.now() })
  }

  /**
   * Record one automatic reincarnation triggered by inbound mail.
   * @param {string} childId - the generation that was started for the wake.
   * @param {{ memberId: string, reason?: string }} info - why it woke.
   * @returns {Promise<void>}
   */
  async markAutoWake(childId, info) {
    await this.#load()
    await this.#commit({ kind: 'auto-wake', childId, memberId: info.memberId, reason: info.reason, at: Date.now() })
  }

  /**
   * How many automatic reincarnations a member already consumed.
   * @param {string} memberId - member identity.
   * @returns {Promise<number>}
   */
  async autoWakeCount(memberId) {
    await this.#load()
    return foldRecords(this.#records).wakes.get(memberId) ?? 0
  }

  /**
   * Seed source for one child id, read by the provider during preparation.
   * @param {string} childId - reserved child session id.
   * @returns {Promise<string | undefined>} predecessor session id.
   */
  async sourceOf(childId) {
    await this.#load()
    return foldRecords(this.#records).entries.get(childId)?.seedFrom
  }

  /**
   * Per-child snapshot for orchestration and UI.
   * @param {string} childId - child session id.
   * @returns {Promise<any | undefined>}
   */
  async entryOf(childId) {
    await this.#load()
    const entry = foldRecords(this.#records).entries.get(childId)
    return entry === undefined ? undefined : { ...entry }
  }

  /**
   * Ordered generations of one member.
   * @param {string} memberId - member identity.
   * @returns {Promise<any[]>}
   */
  async chain(memberId) {
    await this.#load()
    const { chains, entries } = foldRecords(this.#records)
    return (chains.get(memberId) ?? []).map(childId => ({ ...entries.get(childId) }))
  }

  /**
   * The generation a rotation should inherit from: the newest generation that
   * actually started (settled, running, or failed after start). Reserved and
   * start-rejected generations own no history, so they are stepped over.
   * @param {string} memberId - member identity.
   * @returns {Promise<{ childId: string, generation: number, phase: string } | undefined>}
   */
  async head(memberId) {
    await this.#load()
    const { chains, entries } = foldRecords(this.#records)
    const chain = chains.get(memberId) ?? []
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const entry = entries.get(chain[i])
      if (entry === undefined) continue
      if (entry.phase === 'started' || entry.phase === 'settled') return { ...entry }
      // A failed generation is inheritable only when its activation actually
      // started, so a rejected start is stepped over instead of being adopted.
      if (entry.phase === 'failed' && entry.failedAfterStart === true) return { ...entry }
    }
    return undefined
  }

  /**
   * Full record list for audit.
   * @returns {Promise<readonly any[]>}
   */
  async records() {
    await this.#load()
    return [...this.#records]
  }
}
