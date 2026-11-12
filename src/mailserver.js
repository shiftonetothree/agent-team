/**
 * Mail server: the durable mailbox store shared by the members of one
 * orchestration.
 *
 * DSH's subagent service only authorizes parent <-> direct-child messaging, so
 * peer-to-peer delivery has to ride a shared medium. This is that medium: one
 * JSON file per orchestrator session, written atomically, addressed by member
 * identity rather than by transport adjacency.
 *
 * Every participant is a mailbox, including the orchestrator (address
 * `orchestrator`). Nobody can read the whole store: delivery is point-to-point.
 *
 * Addressing rules (deliberately literal so senders can aim):
 * - A message names its target member, and optionally one generation.
 * - A message without a generation is visible to whichever generation of that
 *   member reads it next, so an unread note to generation N is still delivered
 *   to N+1 — that is the "check my previous incarnation's unread mail" case.
 * - A message with a generation is visible only to that generation.
 * - Visibility is consumed per reader: once a child id acknowledges a message it
 *   no longer sees it, and later generations do not inherit it.
 *
 * @module @commonworks/agent-team/mailserver
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** On-disk layout version; bump only for an incompatible record change. */
export const MAIL_VERSION = 1

/** Upper bound on retained messages per session, oldest dropped first. */
export const MAIL_LIMIT = 2000

/**
 * Replace characters that are unsafe in a file name.
 * @param {string} value - session id.
 * @returns {string} a filesystem-safe stem.
 */
function fileStem(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 120)
}

/** One mail server per (directory, session) in this process. @type {Map<string, MailServer>} */
const OPEN = new Map()

/**
 * Durable mail server shared by the members of one orchestration.
 */
export class MailServer {
  /** @type {any[]} */
  #messages = []

  /** @type {boolean} */
  #loaded = false

  /** @type {Promise<void>} */
  #writeChain = Promise.resolve()

  /** @type {Promise<unknown>} */
  #queue = Promise.resolve()

  /** @type {boolean} */
  #quarantine = false

  /**
   * @param {object} options
   * @param {string} options.sessionId - orchestrator session id.
   * @param {string} options.dir - directory holding the journal and this file.
   */
  constructor({ sessionId, dir }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('MailServer requires a sessionId')
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('MailServer requires a dir')
    this.sessionId = sessionId
    this.dir = dir
    this.file = join(dir, `${fileStem(sessionId)}.mail.json`)
    const key = `${dir}\0${fileStem(sessionId)}`
    const existing = OPEN.get(key)
    if (existing !== undefined) return existing
    OPEN.set(key, this)
  }

  /** @returns {string} absolute mail-store file path. */
  get filePath() {
    return this.file
  }

  /**
   * Run one mutation with exclusive access so ids, ordering, and reader marks
   * stay consistent under concurrent members.
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
   * Load the store once. A missing file starts empty; an unreadable one is set
   * aside rather than treated as empty, because rewriting it would erase the
   * mailbox of members whose generations already ended.
   * @returns {Promise<void>}
   */
  async #load() {
    if (this.#loaded) return
    this.#loaded = true
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return
      this.#quarantine = true
      return
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed?.version === MAIL_VERSION && Array.isArray(parsed.messages)) {
        this.#messages = parsed.messages.filter(message => message !== null && typeof message === 'object')
        return
      }
    } catch {
      // Fall through: an unparseable store keeps its bytes for recovery.
    }
    this.#quarantine = true
  }

  /**
   * Persist the store atomically (temp file + retried rename).
   * @returns {Promise<void>}
   */
  async #persist() {
    const payload = JSON.stringify({ version: MAIL_VERSION, sessionId: this.sessionId, messages: this.#messages }, null, 2)
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    const write = async () => {
      await mkdir(this.dir, { recursive: true })
      if (this.#quarantine) {
        // Keep the unreadable bytes instead of overwriting them with an empty store.
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
        this.#quarantine = false
      }
      await writeFile(tmp, payload, 'utf8')
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
   * Post one message.
   *
   * @param {object} request
   * @param {{ childId: string, memberId?: string, generation?: number }} request.from - sender identity.
   * @param {string} request.toMember - target member id.
   * @param {string} request.body - the message text.
   * @param {string} [request.topic] - short label shown in the inbox list.
   * @returns {Promise<any>} the committed message.
   */
  async post({ from, toMember, body, topic }) {
    if (typeof toMember !== 'string' || toMember.length === 0) throw new Error('post requires toMember')
    if (typeof body !== 'string' || body.trim().length === 0) throw new Error('post requires a non-empty body')
    return this.#serial(async () => {
      await this.#load()
      const message = {
        id: randomUUID(),
        at: Date.now(),
        from: { ...from },
        toMember,
        ...(topic === undefined ? {} : { topic }),
        body,
      }
      this.#messages.push(message)
      if (this.#messages.length > MAIL_LIMIT) this.#messages.splice(0, this.#messages.length - MAIL_LIMIT)
      await this.#persist()
      return { ...message }
    })
  }

  /**
   * Deliver messages to one reader and remove what it read.
   *
   * A mailbox holds only undelivered mail: reading is delivery, so the messages
   * are deleted from the store instead of being marked read. Point-to-point
   * delivery means each message belongs to exactly one mailbox, so deleting it
   * on read cannot take mail away from anyone else.
   *
   * @param {object} request
   * @param {{ childId: string, memberId?: string, generation?: number }} request.reader - reader identity.
   * @param {number} [request.limit] - maximum messages returned, newest last.
   * @param {boolean} [request.ack] - deliver (delete) the returned messages. Defaults to true.
   * @returns {Promise<{ messages: any[], unread: number, unreadYours: number, unreadOthers: number, stored: number }>}
   */
  async inbox({ reader, limit = 20, ack = true }) {
    return this.#serial(async () => {
      await this.#load()
      const addressedToReader = message => reader.memberId !== undefined && message.toMember === reader.memberId
      const visible = this.#messages.filter(message => {
        if (reader.memberId === undefined) return message.toMember === undefined
        return message.toMember === reader.memberId
      })
      const selected = visible.slice(-limit)
      if (ack && selected.length > 0) {
        const delivered = new Set(selected.map(message => message.id))
        this.#messages = this.#messages.filter(message => !delivered.has(message.id))
        await this.#persist()
      }
      const unreadOthers = this.#messages.length - this.#messages.filter(addressedToReader).length
      return {
        messages: selected,
        unread: this.#messages.length,
        unreadYours: this.#messages.filter(addressedToReader).length,
        unreadOthers,
        stored: this.#messages.length,
      }
    })
  }
  /**
   * Remove messages that were delivered outside the mailbox (for example by a
   * steer that wakes the addressee), so they are not delivered twice.
   * @param {string[]} ids - message ids.
   * @returns {Promise<number>} how many were removed.
   */
  async discard(ids) {
    return this.#serial(async () => {
      await this.#load()
      const drop = new Set(ids)
      const before = this.#messages.length
      this.#messages = this.#messages.filter(message => !drop.has(message.id))
      const removed = before - this.#messages.length
      if (removed > 0) await this.#persist()
      return removed
    })
  }

  /**
   * Unread mail addressed to a member, with its dispatch lease.
   *
   * A lease is not a tombstone: a message stays in this list until some
   * generation actually reads it, so mail whose generation finished without
   * reading it can be handed to the next one instead of becoming dead.
   *
   * @param {{ limit?: number, excluding?: string }} [options] - window and one
   *   mailbox to skip (the orchestrator reads its own mail directly).
   * @returns {Promise<any[]>}
   */
  async pending({ limit = 50, excluding } = {}) {
    await this.#load()
    return this.#messages
      .filter(message => message.toMember !== excluding)
      .slice(0, limit)
      .map(message => ({ ...message }))
  }

  /**
   * Lease these messages to the generation that will read them.
   * @param {string[]} ids - message ids.
   * @param {string} childId - the generation that was started for them.
   * @returns {Promise<number>} how many messages changed.
   */
  async markDispatched(ids, childId) {
    return this.#serial(async () => {
      await this.#load()
      let changed = 0
      for (const id of ids) {
        const message = this.#messages.find(candidate => candidate.id === id)
        if (message === undefined) continue
        message.dispatchedAt = Date.now()
        message.dispatchedTo = childId
        changed += 1
      }
      if (changed > 0) await this.#persist()
      return changed
    })
  }
}
