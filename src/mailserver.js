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
   * @param {number} [request.toGeneration] - target generation, or omitted for any.
   * @param {string} request.body - the message text.
   * @param {string} [request.topic] - short label shown in the inbox list.
   * @returns {Promise<any>} the committed message.
   */
  async post({ from, toMember, toGeneration, body, topic }) {
    if (typeof toMember !== 'string' || toMember.length === 0) throw new Error('post requires toMember')
    if (typeof body !== 'string' || body.trim().length === 0) throw new Error('post requires a non-empty body')
    return this.#serial(async () => {
      await this.#load()
      const message = {
        id: randomUUID(),
        at: Date.now(),
        from: { ...from },
        toMember,
        ...(toGeneration === undefined ? {} : { toGeneration }),
        ...(topic === undefined ? {} : { topic }),
        body,
        readers: [],
      }
      this.#messages.push(message)
      if (this.#messages.length > MAIL_LIMIT) this.#messages.splice(0, this.#messages.length - MAIL_LIMIT)
      await this.#persist()
      return { ...message }
    })
  }

  /**
   * Messages visible to one reader. Point-to-point: a reader only ever sees mail
   * addressed to its own identity.
   *
   * @param {object} request
   * @param {{ childId: string, memberId?: string, generation?: number }} request.reader - reader identity.
   * @param {number} [request.limit] - maximum messages returned, newest last.
   * @param {boolean} [request.ack] - mark the returned messages consumed by this reader.
   * @param {boolean} [request.includeRead] - include messages this reader already acknowledged.
   * @returns {Promise<{ messages: any[], unacked: number }>}
   */
  async inbox({ reader, limit = 20, ack = true, includeRead = false }) {
    return this.#serial(async () => {
      await this.#load()
      const addressedToReader = message => reader.memberId !== undefined && message.toMember === reader.memberId
      const visible = this.#messages.filter(message => {
        if (reader.memberId !== undefined && message.toMember !== reader.memberId) return false
        if (reader.memberId === undefined && message.toMember !== undefined) return false
        if (message.toGeneration !== undefined && message.toGeneration !== reader.generation) return false
        return includeRead || !message.readers.includes(reader.childId)
      })
      const selected = visible.slice(-limit)
      if (ack) {
        let changed = false
        for (const message of selected) {
          if (!message.readers.includes(reader.childId)) {
            message.readers.push(reader.childId)
            changed = true
          }
        }
        if (changed) await this.#persist()
      }
      const yours = this.#messages.filter(addressedToReader).length
      return {
        messages: selected.map(message => ({
          ...message,
          readers: [...message.readers],
          handled: message.readers.length > 0,
        })),
        unacked: visible.filter(message => !message.readers.includes(reader.childId)).length,
        // Board occupancy, not content: a reader may know that the server still
        // holds mail without learning who wrote to whom.
        total: this.#messages.length,
        others: this.#messages.length - yours,
      }
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
      .filter(message => message.readers.length === 0 && message.toMember !== excluding)
      .slice(0, limit)
      .map(message => ({ ...message, readers: [...message.readers] }))
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

  /**
   * Drop a reader mark so a message becomes unread again (self-service undo).
   * @param {string} id - message id.
   * @param {string} childId - reader to unmark.
   * @returns {Promise<boolean>} whether the message changed.
   */
  async unread(id, childId) {
    return this.#serial(async () => {
      await this.#load()
      const message = this.#messages.find(candidate => candidate.id === id)
      if (message === undefined) return false
      const index = message.readers.indexOf(childId)
      if (index === -1) return false
      message.readers.splice(index, 1)
      await this.#persist()
      return true
    })
  }
}
