/**
 * Agent-team plugin: a durable `childId -> predecessor` journal plus a subagent
 * backend that seeds each reserved child session from its predecessor's log.
 *
 * Typical use from an orchestrator plugin:
 *
 * ```js
 * import { createSeededFork } from '@commonworks/agent-team'
 *
 * const fork = createSeededFork(ctx, { directory: '/abs/state/dir' })
 * const first = await fork.fork({ parent: agent, memberId: 'reviewer', prompt: 'audit X' })
 * const second = await fork.rotate({ parent: agent, memberId: 'reviewer', prompt: 'recheck your findings' })
 * ```
 *
 * `rotate` seeds the new child from the member's previous generation, which is
 * the closest pure-plugin equivalent of continuing the same member.
 *
 * @module @commonworks/agent-team/api
 */

import { homedir } from 'node:os'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { JOURNAL_VERSION, LineageJournal } from './journal.js'
import { SeededForkProvider } from './provider.js'
import { strategyPlaybook, strategyPlaybookSection } from './playbook.js'
import { registerStrategyPreset } from './preset.js'
import { MailServer } from './mailserver.js'
import { appendMailboxNotice } from './mailbox-notice.js'

/** Address of the orchestrating agent's own mailbox. */
export const ORCHESTRATOR_MEMBER_ID = 'orchestrator'

export { LineageJournal, JOURNAL_VERSION } from './journal.js'
export { SeededForkProvider, readSessionEvents } from './provider.js'
export { buildForkSeed, completedTurnBoundary, openTurnClosers } from './seed.js'

/**
 * Module specifier of this plugin's entry point, used when a registered preset
 * mounts the plugin again for its playbook. Derived from this module's URL so a
 * ile: mount and a packaged install both resolve.
 * @returns {string} the entry module specifier.
 */
export function entrySpecifier() {
  return import.meta.url.replace(/\/api\.js$/u, '/index.js')
}

/**
 * Module specifier of the playbook-only entry mounted inside a registered preset.
 * @returns {string} the preset entry module specifier.
 */
export function presetEntrySpecifier() {
  return import.meta.url.replace(/\/api\.js$/u, '/preset-entry.js')
}

/**
 * Module specifier of the first-turn strategy nudge mounted inside a preset.
 * @returns {string} the nudge entry module specifier.
 */
export function presetSessionSpecifier() {
  return import.meta.url.replace(/\/api\.js$/u, '/preset-session.js')
}

/** Default journal directory: inside the harness home, never inside a user repository. */
export function defaultJournalDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'agent-team', 'lineage')
}

/**
 * Journals keyed by owning orchestrator session, with a durable child-id index
 * so a provider can resolve a reservation made before the process restarted.
 */
export class JournalRegistry {
  /** @type {Map<string, LineageJournal>} */
  #bySession = new Map()

  /** @type {Map<string, LineageJournal>} */
  #byChild = new Map()

  /**
   * @param {object} options
   * @param {string} options.directory - absolute directory holding journal files.
   * @param {number} [options.maxGenerations] - reincarnation cap per member.
   * @param {(sessionId: string) => ((record: any) => void | Promise<void>) | undefined} [options.appendRecordFor]
   *   optional session-record sink factory, e.g. `id => data => appendPluginRecord(sessions.get(id), 'plugin:x/lineage', data)`.
   */
  constructor({ directory, maxGenerations = 16, appendRecordFor }) {
    this.directory = directory
    this.maxGenerations = maxGenerations
    this.appendRecordFor = appendRecordFor
  }

  /**
   * Journal of one orchestrator session (created on first use).
   * @param {string} sessionId - orchestrator session id.
   * @returns {LineageJournal}
   */
  journalForSession(sessionId) {
    let journal = this.#bySession.get(sessionId)
    if (journal === undefined) {
      journal = new LineageJournal({
        sessionId,
        dir: this.directory,
        maxGenerations: this.maxGenerations,
        appendRecord: this.appendRecordFor?.(sessionId),
      })
      this.#bySession.set(sessionId, journal)
    }
    return journal
  }

  /**
   * Remember that a child id belongs to a journal, so the provider can resolve
   * it without scanning storage.
   * @param {string} childId - reserved child session id.
   * @param {LineageJournal} journal - owning journal.
   */
  register(childId, journal) {
    this.#byChild.set(childId, journal)
  }

  /**
   * Journals this process opened so far.
   * @returns {LineageJournal[]}
   */
  openedJournals() {
    return [...this.#bySession.values()]
  }

  /**
   * Resolve the journal that reserved one child id, scanning durable files when
   * this process never reserved it (restart recovery).
   * @param {string} childId - child session id from the continuation request.
   * @returns {Promise<LineageJournal | undefined>}
   */
  async findByChild(childId) {
    if (typeof childId !== 'string') return undefined
    const cached = this.#byChild.get(childId)
    if (cached !== undefined) return cached
    let names
    try {
      names = await readdir(this.directory)
    } catch {
      return undefined
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.directory, name)
      let parsed
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        continue
      }
      if (parsed?.version !== JOURNAL_VERSION || !Array.isArray(parsed.records)) continue
      if (!parsed.records.some(record => record?.childId === childId)) continue
      const journal = this.journalForSession(String(parsed.sessionId))
      this.#byChild.set(childId, journal)
      return journal
    }
    return undefined
  }
}

/**
 * Await a promise but stop waiting when the caller's signal aborts.
 * @template T
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {Promise<T>} promise - work to await.
 * @returns {Promise<T>}
 */
function abortable(signal, promise) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * Prepend the member preamble that tells a child to poll its inbox.
 *
 * Subagent turns have no plugin hook we own, so the polling rule has to ride the
 * initial prompt. It names the member and its generation so a message can be
 * addressed back, and it states the carry-over rule that makes an unread note to
 * the previous generation still visible.
 *
 * @param {any[]} blocks - the caller's prompt blocks.
 * @param {{ memberId: string, generation: number, peers?: readonly any[], reportWhen?: string }} identity - the child's identity.
 * @returns {any[]} prompt blocks with the preamble first.
 */
export function withMemberPreamble(blocks, identity) {
  const links = (identity.peers ?? []).filter(link => link?.member !== identity.memberId)
  const peerLines = links.length === 0
    ? ['- "orchestrator" — the member that started you; it owns scope and decisions.', '']
    : [
        'Teammates in this orchestration:',
        ...links.map(link => `- "${link.member}" — ${link.relationship.replace(/\.$/u, '')}. Message it directly with member_post ${link.when}.`),
        '',
      ]
  const reportWhen = identity.reportWhen
    ?? 'report to "orchestrator" with member_post when scope changes, when two members disagree, or when you are done; '
      + 'ordinary coordination with a teammate does not go through it'
  const text = `[member "${identity.memberId}"]\n`
    + `${peerLines.join('\n')}`
    + `Talk to a teammate directly when it owns the fact or the step you need; ${reportWhen}.\n`
    + (identity.push === false
      ? 'Mail for you is not pushed here: call member_inbox before each step and after every member result; '
        + 'reading delivers a message exactly once. '
      : 'Mail for you is delivered by itself at the start of the step that needs it, so do not poll for it: '
        + 'do not call member_inbox unless something tells you a delivery was missed. ')
    + 'If a peer is waiting on you, answer it before you finish: ending your turn while a peer still needs you '
    + 'forces the orchestrator to start you again.\n'
  const rest = Array.isArray(blocks) ? blocks : []
  const first = rest[0]
  if (first?.type === 'text' && typeof first.text === 'string' && first.text.startsWith('[member "')) {
    const body = first.text.slice(first.text.indexOf('\n') + 1)
    return [{ type: 'text', text: `${text}${body}` }, ...rest.slice(1)]
  }
  return [{ type: 'text', text }, ...rest]
}

/**
 * Turn a prompt into model content blocks.
 * @param {string | readonly any[]} prompt - text or content blocks.
 * @returns {any[]} content blocks.
 */
function toContent(prompt) {
  if (typeof prompt === 'string') return [{ type: 'text', text: prompt }]
  if (Array.isArray(prompt)) return prompt
  throw new Error('prompt must be a string or an array of content blocks')
}

/**
 * Create the agent-team API bound to one cordis context.
 *
 * @param {any} ctx - cordis context providing `subagents`.
 * @param {object} [config]
 * @param {string} [config.directory] - journal directory (default `defaultJournalDirectory()`).
 * @param {string} [config.providerName] - provider registry name (default `agent-team`).
 * @param {number} [config.maxGenerations] - per-member reincarnation cap (default 16).
 * @param {number} [config.maxDepth] - delegation depth for children (default 1).
 * @param {'caller' | 'parent'} [config.delivery] - result delivery policy (default `caller`).
 * @param {any} [config.capabilities] - provider capability override.
 * @param {(sessionId: string) => ((record: any) => void | Promise<void>) | undefined} [config.appendRecordFor]
 *   optional session-record sink factory.
 * @returns {{
 *   provider: SeededForkProvider,
 *   registry: JournalRegistry,
 *   providerName: string,
 *   fork: (options: any) => Promise<any>,
 *   rotate: (options: any) => Promise<any>,
 *   chain: (memberId: string, sessionId?: string) => Promise<any[]>,
 *   sourceOf: (childId: string) => Promise<string | undefined>,
 *   journalForSession: (sessionId: string) => LineageJournal,
 *   dispose: () => void,
 * }}
 */
export function createSeededFork(ctx, config = {}) {
  // A registered preset is a full composition cloned from standard, registered
  // asynchronously and best-effort (see ./preset.js). It must never fail the
  // plugin: a missing preset is reported by the diagnose tool, not by refusing to
  // mount the provider and tools.
  const presetConfig = config.preset === true ? {} : config.preset
  /** @type {Promise<any> | undefined} */
  let presetStatus
  const directory = config.directory ?? defaultJournalDirectory()
  const providerName = config.providerName ?? 'agent-team'
  const maxDepth = config.maxDepth ?? 1
  const defaultDelivery = config.delivery ?? 'caller'
  /** Self-healing retry for mail a settled generation never read. */
  const mailRetry = config.mailRetry === false
    ? { enabled: false }
    : { enabled: true, maxPerMember: config.mailRetry?.maxPerMember ?? 2 }
  const registry = new JournalRegistry({
    directory,
    maxGenerations: config.maxGenerations ?? 16,
    appendRecordFor: config.appendRecordFor,
  })
  const provider = new SeededForkProvider({
    name: providerName,
    registry,
    ctx,
    capabilities: config.capabilities,
  })
  /** @type {Map<string, Promise<any>>} in-process activations, so rotate can wait instead of seeding from an empty log. */
  const pendingResults = new Map()
  /** @type {Set<string>} members with an automatic wake in flight. */
  const wakeInFlight = new Set()
  const disposers = []

  if (config.provider !== false && ctx?.subagents?.registerProvider !== undefined) {
    disposers.push(ctx.subagents.registerProvider(provider))
  }
  const tools = ctx?.get?.('tools')
  if (config.registerTools !== false && typeof tools?.register === 'function') {
    for (const definition of buildToolDefinitions(() => api)) {
      disposers.push(tools.register(definition))
    }
  }
  if (config.playbook === true) {
    const systemPrompt = ctx?.get?.('systemPrompt')
    if (typeof systemPrompt?.section === 'function') {
      const playbookText = config.playbookText ?? strategyPlaybook({ push: config.pushMailbox !== false })
      const section = strategyPlaybookSection({ text: playbookText })
      disposers.push(systemPrompt.section(section))
    }
  }
  if (presetConfig !== undefined && presetConfig !== false) {
    const agentPresets = ctx?.get?.('agentPresets')
    const presetId = presetConfig.id ?? 'agent-team'
    if (typeof agentPresets?.register !== 'function') {
      presetStatus = Promise.resolve({
        registered: [],
        errors: ['this composition has no agentPresets service'],
        standardAvailable: false,
      })
    } else {
      // Best-effort and asynchronous: `standard` may register after this plugin.
      presetStatus = registerStrategyPreset(agentPresets, {
        id: presetId,
        name: presetConfig.name,
        description: presetConfig.description,
        order: presetConfig.order,
        entrySpecifier: presetConfig.entrySpecifier ?? presetEntrySpecifier(),
        sessionSpecifier: presetConfig.sessionSpecifier ?? presetSessionSpecifier(),
        personaPrefix: presetConfig.personaPrefix,
        playbookText: presetConfig.playbookText ?? config.playbookText,
        timeoutMs: presetConfig.timeoutMs,
      })
      if (process.env.DSH_AGENT_TEAM_DEBUG === '1') {
        void presetStatus.then(status => {
          console.error(`agent-team: presets registered=[${status.registered.join(', ')}] errors=${JSON.stringify(status.errors)}`)
        })
      }
    }
  }
  /** @type {Map<string, MailServer>} one shared board per orchestrator session. */
  const mailServers = new Map()

  /**
   * Board shared by the members of one orchestration.
   * @param {string} sessionId - orchestrator session id.
   * @returns {MailServer}
   */
  function mailServerForSession(sessionId) {
    let box = mailServers.get(sessionId)
    if (box === undefined) {
      box = new MailServer({ sessionId, dir: directory })
      mailServers.set(sessionId, box)
    }
    return box
  }

  /**
   * Resolve the calling agent to its member identity. An orchestrator (never a
   * reserved child) resolves with no member id and reads the whole board.
   * @param {any} exec - tool execution context.
   * @returns {Promise<{ childId: string, journal?: any, memberId?: string, generation?: number, mailServer?: MailServer }>}
   */
  async function resolveCaller(exec) {
    const childId = exec?.agent?.session?.id
    if (typeof childId !== 'string' || childId.length === 0) {
      throw new Error('member tools require a live calling agent')
    }
    const journal = await registry.findByChild(childId)
    if (journal === undefined) {
      // The orchestrator is a mailbox like any other, not a privileged reader: it
      // gets a stable address so members can post to it, and it reads only what is
      // addressed to that address.
      if (exec?.agent?.session?.header?.origin === 'subagent') return { childId }
      return { childId, memberId: ORCHESTRATOR_MEMBER_ID, generation: 0, mailServer: mailServerForSession(childId) }
    }
    const entry = await journal.entryOf(childId)
    return {
      childId,
      journal,
      memberId: entry?.memberId,
      generation: entry?.generation,
      mailServer: mailServerForSession(journal.sessionId),
    }
  }

  /**
   * Members an orchestration has reserved so far, newest generation per member.
   *
   * Posting validates against this list so a typo cannot queue a message nobody
   * will ever read.
   *
   * @param {any} journal - the orchestration journal.
   * @returns {Promise<Array<{ member_id: string, generation: number, phase: string, child_id: string, seed_from: string }>>}
   */
  async function memberRoster(journal) {
    const records = await journal.records()
    /** @type {Map<string, any>} */
    const byMember = new Map()
    for (const record of records) {
      if (record?.kind !== 'reserve' || typeof record.memberId !== 'string') continue
      byMember.set(record.memberId, {
        member_id: record.memberId,
        generation: record.generation ?? 0,
        phase: 'reserved',
        child_id: record.childId,
        seed_from: record.seedFrom ?? '',
      })
    }
    for (const record of records) {
      const entry = record?.memberId === undefined ? undefined : byMember.get(record.memberId)
      if (entry === undefined || record.kind === 'reserve') continue
      if (record.kind === 'start' || record.kind === 'settle' || record.kind === 'fail') {
        byMember.set(record.memberId, {
          ...entry,
          phase: record.kind === 'start' ? 'started' : record.kind === 'settle' ? 'settled' : 'failed',
        })
      }
    }
    // Generations are an internal detail: the collaboration surface only needs
    // who exists and whether it is free to receive mail right now.
    const stateOf = phase => (phase === 'started' ? 'busy' : phase === 'reserved' ? 'busy' : 'idle')
    return [
      { member_id: ORCHESTRATOR_MEMBER_ID, state: 'orchestrator' },
      ...[...byMember.values()].map(entry => ({ member_id: entry.member_id, state: stateOf(entry.phase) })),
    ]
  }

  /**
   * Occupancy of the server the given agent reads, resolved against the
   * orchestration the journal belongs to.
   * @param {string} sessionId - orchestrating session that owns the store.
   * @param {string} readerId - the agent whose mailbox is read.
   * @returns {Promise<{ total: number, yours: number, others: number, role: string }>}
   */
  async function mailboxCountsFor(sessionId, readerId) {
    const mailServer = mailServerForSession(sessionId)
    const role = readerId === sessionId ? ORCHESTRATOR_MEMBER_ID : 'member'
    const result = await mailServer.inbox({
      reader: { childId: readerId, memberId: role },
      ack: false,
    })
    return {
      total: result.unread,
      yours: result.unreadYours,
      others: result.unreadOthers,
      role,
    }
  }

  /**
   * Reserve one generation for a member and start its child session.
   * @param {object} options - fork options.
   * @returns {Promise<any>} `{ childId, generation, activation, result }`.
   */
  async function fork(options) {
    const { parent, memberId } = options
    if (parent?.session?.id === undefined) throw new Error('fork requires a live parent agent')
    if (typeof memberId !== 'string' || memberId.length === 0) throw new Error('fork requires memberId')
    const journal = registry.journalForSession(parent.session.id)
    const reservation = await journal.reserve({
      memberId,
      seedFrom: options.seedFrom,
      peers: options.peers,
      reportWhen: options.reportWhen,
    })
    registry.register(reservation.childId, journal)
    let activation
    try {
      activation = await ctx.subagents.startActivation({
        provider: providerName,
        label: options.label ?? memberId,
        childId: reservation.childId,
        request: {
          parent,
          prompt: config.memberPreamble === false
            ? toContent(options.prompt)
            : withMemberPreamble(toContent(options.prompt), {
                memberId,
                generation: reservation.generation,
                push: config.pushMailbox !== false,
                peers: options.peers ?? (await memberRoster(journal))
                  .filter(member => member.member_id !== memberId)
                  .map(member => ({
                    member: member.member_id,
                    relationship: 'a member of this orchestration',
                    when: 'when you need a fact or a check that it owns',
                  })),
                reportWhen: options.reportWhen,
              }),
          maxDepth: options.maxDepth ?? maxDepth,
          ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
          ...(options.persona === undefined ? {} : { persona: options.persona }),
          ...(options.toolFilter === undefined ? {} : { toolFilter: options.toolFilter }),
          ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
          ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        },
        signal: options.signal ?? new AbortController().signal,
        delivery: options.delivery ?? defaultDelivery,
      })
    } catch (error) {
      await journal.markFailed(reservation.childId, error)
      throw error
    }
    await journal.markStarted(reservation.childId)
    const result = Promise.resolve(activation.result)
    // Track settlement *including* the journal commit, so a rotate that waits on
    // a predecessor observes the settled phase instead of racing the record.
    const journaled = result.then(
      settled => journal.markSettled(reservation.childId, { stopReason: settled?.stopReason }).catch(() => {}),
      failure => journal.markFailed(reservation.childId, failure).catch(() => {}),
    )
    pendingResults.set(reservation.childId, journaled.finally(() => pendingResults.delete(reservation.childId)))
    if (config.mailboxNotice !== false) {
      // Second channel: the settled member's result reaches the parent on its own,
      // so the occupancy notice rides right behind it.
      void journaled.then(async () => {
        try {
          const counts = await mailboxCountsFor(journal.sessionId, parent.session.id)
          appendMailboxNotice(parent, counts)
        } catch {
          // Occupancy is advisory; a failed read must not surface as a fork failure.
        }
      })
    }
    if (mailRetry.enabled) {
      // A generation that finishes cleanly with unread mail addressed to it left
      // work behind, so the mail goes to the next generation without waiting for
      // the orchestrator. A generation that *fails* is different: crash and
      // cancellation handling belongs to the orchestrator and to DSH, so the
      // plugin starts nothing on that path.
      void result.then(settled => {
        if (settled?.stopReason !== undefined && settled.stopReason !== 'completed') return
        return retryUnreadMail({ parent, memberId, childId: reservation.childId, journal })
      }, () => {})
    }
    return {
      childId: reservation.childId,
      generation: reservation.generation,
      activation,
      result,
    }
  }

  /**
   * Start the next generation for mail its predecessor never read.
   *
   * A settled generation that leaves unread mail behind has not done its job, and
   * waiting for the orchestrator to notice costs a full round trip. This runs at
   * settlement, takes the same per-member lock as dispatch and auto-wake, and is
   * bounded so a member that keeps ignoring its inbox cannot spin.
   *
   * @param {object} request
   * @param {any} request.parent - the orchestrating agent, which owns the session.
   * @param {string} request.memberId - member that just settled.
   * @param {string} request.childId - the generation that settled.
   * @param {any} request.journal - the orchestration journal.
   * @returns {Promise<void>}
   */
  async function retryUnreadMail({ parent, memberId, childId, journal }) {
    try {
      const mailServer = mailServerForSession(parent.session.id)
      const own = (await mailServer.pending({ excluding: ORCHESTRATOR_MEMBER_ID }))
        .filter(message => message.toMember === memberId)
      if (own.length === 0) return
      const used = await journal.autoWakeCount(memberId, 'unread-mail-retry')
      if (used >= mailRetry.maxPerMember) return
      if (!claimMember(memberId)) return
      try {
        const lines = own
          .map(message => `[${message.from.memberId ?? 'orchestrator'}#${message.from.generation ?? 0}${message.topic === undefined ? '' : ` ${message.topic}`}] ${message.body}`)
          .join('\n')
        const started = await rotate({
          parent,
          memberId,
          prompt: `You ended last time without reading ${own.length} message(s) addressed to you:\n${lines}\n\n`
            + 'Read them with member_inbox and handle them before you finish. This supersedes any inherited instruction that your work was done.',
        })
        await mailServer.markDispatched(own.map(message => message.id), started.childId)
        await journal.markAutoWake(started.childId, { memberId, reason: 'unread-mail-retry' })
      } finally {
        releaseMember(memberId)
      }
    } catch {
      // A retry that cannot start (generation cap, detached parent) leaves the
      // mail unread, where the next dispatch or notice still sees it.
    }
  }

  /**
   * Start the next generation of a member, seeded from its previous generation.
   * A member with no previous generation starts fresh, exactly like `fork`.
   *
   * Rotating before the predecessor completes would seed from an empty log, so a
   * running predecessor is awaited and an unknown-to-this-process one rejects.
   *
   * @param {object} options - rotate options.
   * @returns {Promise<any>} `{ childId, generation, seedFrom, activation, result }`.
   */
  async function rotate(options) {
    const { parent, memberId } = options
    if (parent?.session?.id === undefined) throw new Error('rotate requires a live parent agent')
    const journal = registry.journalForSession(parent.session.id)
    let head = await journal.head(memberId)
    if (head !== undefined && head.phase !== 'settled') {
      const running = pendingResults.get(head.childId)
      if (running === undefined) {
        throw new Error(
          `member "${memberId}" generation ${head.generation} has not completed in this process; `
          + 'wait for its completion notice before rotating, or rotate from an earlier settled generation with seedFrom',
        )
      }
      await abortable(options.signal, running)
      head = await journal.head(memberId)
    }
    const seedFrom = options.seedFrom ?? head?.childId
    // A rotation keeps the collaboration links the orchestrator declared for this
    // member unless the new call overrides them.
    const predecessor = head === undefined ? undefined : await journal.entryOf(head.childId)
    const started = await fork({
      ...options,
      seedFrom,
      peers: options.peers ?? predecessor?.peers,
      reportWhen: options.reportWhen ?? predecessor?.reportWhen,
    })
    return head === undefined ? started : { ...started, seedFrom }
  }

  /** Automatic reincarnation policy, resolved once per instance. */
  const autoWake = config.autoWake === false
    ? { enabled: false }
    : {
        enabled: true,
        maxPerMember: config.autoWake?.maxPerMember ?? 2,
        task: config.autoWake?.task
          ?? 'Other members left you mail after you finished. It is in this turn; act on it. '
            + 'This message supersedes your inherited instruction that the work was done: the mail is newer than your previous turn, '
            + 'even when that turn told you to stop or to answer something else. Then finish and report what changed. '
            + 'Do not post back unless you genuinely need something from them.',
      }

  /**
   * Classify a member's newest generation for delivery.
   *
   * Mail and members are addressed by member id; only the plugin cares which
   * incarnation is current. Every delivery path asks this one question, so they
   * cannot disagree about whether a member is busy, booting, or finished.
   *
   * @param {string} memberId - member identity.
   * @param {any} journal - the orchestration journal.
   * @returns {Promise<{ state: 'none' | 'reserved' | 'running' | 'terminal', head?: any }>}
   */
  async function memberDeliveryState(memberId, journal) {
    const head = await journal.head(memberId)
    if (head === undefined) return { state: 'none' }
    if (head.phase === 'reserved') return { state: 'reserved', head }
    if (head.phase === 'started') return { state: 'running', head }
    return { state: 'terminal', head }
  }

  /**
   * Reincarnate a member whose newest generation already terminated, because a
   * message just landed in its inbox.
   *
   * DSH has no transport for a peer to wake a finished child, and a settled
   * child's runtime is already released, so the only way for the message to be
   * read is a new generation seeded from the finished one. Guarded three ways:
   * only a terminal head wakes, each member has a bounded wake budget, and one
   * wake per member is in flight at a time.
   *
   * @param {string} memberId - member named by the inbound message.
   * @param {string} sessionId - orchestrator session id.
   * @param {string} [reason] - short cause recorded in the journal.
   * @returns {Promise<{ woken: boolean, childId?: string, reason: string }>}
   */
  /**
   * Deliver a message to the orchestrator through DSH's steer channel.
   *
   * The pre-step push only reaches an agent that takes another step. An idle
   * orchestrator takes none, so a member writing to it would wait for the user to
   * type something. A resident child may send to its direct parent, and that path
   * starts a turn on an idle parent, which is what makes the delivery immediate.
   *
   * @param {any} sender - the member agent that authored the message.
   * @param {string} orchestratorSessionId - the parent session to deliver to.
   * @param {string} text - message text.
   * @returns {Promise<boolean>} whether DSH accepted the message.
   */
  async function deliverToOrchestrator(sender, orchestratorSessionId, text) {
    const subagents = ctx?.get?.('subagents')
    if (typeof subagents?.sendMessage !== 'function') return false
    try {
      await subagents.sendMessage(sender, orchestratorSessionId, [{ type: 'text', text }], {
        signal: new AbortController().signal,
      })
      return true
    } catch {
      // Adjacency, residency, or a closing parent: fall back to the mailbox.
      return false
    }
  }

  /**
   * Take the per-member generation lock shared by auto-wake and dispatch.
   *
   * Both paths start a generation for mail, so one lock keeps them from handing
   * the same message to two generations.
   *
   * @param {string} memberId - member identity.
   * @returns {boolean} false when another path is already starting a generation.
   */
  function claimMember(memberId) {
    if (wakeInFlight.has(memberId)) return false
    wakeInFlight.add(memberId)
    return true
  }

  /**
   * Release the per-member generation lock.
   * @param {string} memberId - member identity.
   */
  function releaseMember(memberId) {
    wakeInFlight.delete(memberId)
  }

  async function wakeIfTerminal(memberId, sessionId, reason) {
    if (!autoWake.enabled) return { woken: false, reason: 'disabled' }
    if (memberId === ORCHESTRATOR_MEMBER_ID) return { woken: false, reason: 'orchestrator' }
    if (!claimMember(memberId)) return { woken: false, reason: 'already-waking' }
    try {
      const journal = registry.journalForSession(sessionId)
      const { state } = await memberDeliveryState(memberId, journal)
      if (state === 'none') return { woken: false, reason: 'no-generation' }
      if (state === 'running') return { woken: false, reason: 'running' }
      if (state === 'reserved') return { woken: false, reason: 'not-started' }
      const used = await journal.autoWakeCount(memberId)
      if (used >= autoWake.maxPerMember) return { woken: false, reason: 'budget-exhausted' }
      const agents = ctx?.get?.('agents')
      const parent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
      if (parent === undefined) return { woken: false, reason: 'orchestrator-not-live' }
      const started = await rotate({ parent, memberId, prompt: autoWake.task })
      await journal.markAutoWake(started.childId, { memberId, reason: reason ?? 'inbound-mail' })
      return { woken: true, childId: started.childId, reason: 'woken' }
    } catch (error) {
      return { woken: false, reason: String(error?.message ?? error) }
    } finally {
      releaseMember(memberId)
    }
  }

  /**
   * Ordered generations of one member.
   * @param {string} memberId - member identity.
   * @param {string} [sessionId] - owning session id (omit to search every journal this process opened).
   * @returns {Promise<any[]>}
   */
  async function chain(memberId, sessionId) {
    const candidates = sessionId === undefined
      ? registry.openedJournals()
      : [registry.journalForSession(sessionId)]
    for (const candidate of candidates) {
      const entries = await candidate.chain(memberId)
      if (entries.length > 0) return entries
    }
    return []
  }

  /**
   * Predecessor of one child id.
   * @param {string} childId - child session id.
   * @returns {Promise<string | undefined>}
   */
  async function sourceOf(childId) {
    const journal = await registry.findByChild(childId)
    return journal?.sourceOf(childId)
  }

  /**
   * Await and report the preset registration outcome.
   * @returns {Promise<any>} `{ registered, errors, standardAvailable }`.
   */
  async function presetDiagnose() {
    if (presetStatus === undefined) {
      return { registered: [], errors: [], standardAvailable: false, configured: false }
    }
    const status = await presetStatus
    return { ...status, dispose: undefined, configured: true }
  }

  const api = {
    provider,
    registry,
    providerName,
    directory,
    fork,
    rotate,
    chain,
    sourceOf,
    presetDiagnose,
    resolveCaller,
    wakeIfTerminal,
    orchestratorId: ORCHESTRATOR_MEMBER_ID,
    deliverToOrchestrator,
    memberDeliveryState,
    claimMember,
    releaseMember,
    memberRoster,
    mailServerForSession,
    journalForSession: sessionId => registry.journalForSession(sessionId),
    dispose: () => {
      if (presetStatus !== undefined) {
        void presetStatus
          .then(status => status?.dispose?.())
          .catch(() => {})
        presetStatus = undefined
      }
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // Registration removal is best-effort: a reloaded composition may
          // already have dropped this provider.
        }
      }
    },
  }
  return api
}

/**
 * Model-facing tools, built without importing `@deepseek-ai/dsh-tools`.
 *
 * The registry validates `{ name, description, parameters, output: { schema, render } }`
 * at registration, which is the same shape `defineTool` produces, so an external
 * plugin can declare them directly.
 *
 * @param {() => any} getApi - accessor for the API instance (tools resolve late).
 * @returns {any[]} tool definitions.
 */
export function buildToolDefinitions(getApi) {
  const memberParameters = {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'Stable member identity inside this orchestration, for example "reviewer".' },
      task: { type: 'string', description: 'The instruction this member receives. Its inherited history is data, not instructions.' },
      peers: {
        type: 'array',
        description: 'The teammates this member works with, and how. Each entry names a member, states the relationship, and says when to talk to it directly. Omit to keep the predecessor\'s links.',
        items: {
          type: 'object',
          properties: {
            member: { type: 'string', description: 'Teammate member id, or "orchestrator".' },
            relationship: { type: 'string', description: 'What this teammate gives or needs, in one sentence, from this member\'s point of view.' },
            when: { type: 'string', description: 'The moment this member should message that teammate directly.' },
          },
          required: ['member', 'relationship', 'when'],
          additionalProperties: false,
        },
      },
      report_when: {
        type: 'string',
        description: 'When this member should stop coordinating peer-to-peer and report to the orchestrator instead; defaults to decisions, scope, and conflicting evidence.',
      },
    },
    required: ['member_id', 'task'],
    additionalProperties: false,
  }
  const resultSchema = {
    type: 'object',
    properties: {
      member_id: { type: 'string' },
      state: { type: 'string', description: 'Always "started": the member is working on the task now.' },
      inherited: { type: 'string', description: 'What this member brought with it from its earlier work, or that it starts fresh.' },
    },
    required: ['member_id', 'state', 'inherited'],
    additionalProperties: false,
  }
  const render = value => [{
    type: 'text',
    text: `${value.member_id} is working (${value.inherited}). `
      + 'Wait for its completion notice before relying on its result.',
  }]

  return [
    {
      name: 'member_start',
      description: 'Start a member of this orchestration on a task. A new member_id starts a new member; calling it again with the same member_id continues that member, which keeps the work it already did and can re-examine it. '
        + 'Do not use it for independent parallel work, which is what the plain subagent tool is for. '
        + 'Write the peer links into task: which members this one should message with member_post, about what, and what it decides alone. '
        + 'Members may talk to each other directly, so route through the orchestrator only for decisions and scope.',
      parameters: memberParameters,
      output: { schema: resultSchema, render },
      async execute(args, exec) {
        const api = getApi()
        const parent = exec?.agent
        if (parent === undefined) throw new Error('member_start requires a live calling agent')
        const journal = api.journalForSession(parent.session.id)
        const { state } = await api.memberDeliveryState(args.member_id, journal)
        const started = state === 'none'
          ? await api.fork({
              parent,
              memberId: args.member_id,
              prompt: args.task,
              label: args.member_id,
              delivery: 'parent',
              signal: exec.signal,
            })
          : await api.rotate({
              parent,
              memberId: args.member_id,
              prompt: args.task,
              label: args.member_id,
              delivery: 'parent',
              signal: exec.signal,
            })
        return {
          member_id: args.member_id,
          state: 'started',
          inherited: started.seedFrom === undefined
            ? 'it starts fresh'
            : 'it brought its earlier work with it',
        }
      },
    },
    {
      name: 'member_roster',
      description: 'List the members of this orchestration and whether each is free to receive mail. Call it before member_post so a message is addressed to a member that exists.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            members: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  member_id: { type: 'string' },
                  state: { type: 'string' },
                },
                required: ['member_id', 'state'],
                additionalProperties: false,
              },
            },
          },
          required: ['members'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.members.length === 0
            ? '(no members yet; start one with member_start)'
            : value.members.map(member => `- ${member.member_id} (${member.state})`).join('\n'),
        }],
      },
      async execute(_args, exec) {
        const api = getApi()
        const caller = await api.resolveCaller(exec)
        const journal = caller.journal ?? api.journalForSession(exec.agent.session.id)
        return { members: await api.memberRoster(journal) }
      },
    },
    {
      name: 'member_dispatch',
      description: 'Start the members that the mailbox asks for. Call it instead of answering the user while the server is not empty: it reads every unread message addressed to a member, groups them by addressee, and starts that member again with the mail as its task. Members already running are skipped because they read their own inbox. Messages addressed to the orchestrator are left to member_inbox.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum messages to consider. Defaults to 20.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            dispatched: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  member_id: { type: 'string' },
                  state: { type: 'string' },
                  messages: { type: 'number' },
                },
                required: ['member_id', 'state', 'messages'],
                additionalProperties: false,
              },
            },
            skipped: {
              type: 'array',
              items: {
                type: 'object',
                properties: { member_id: { type: 'string' }, reason: { type: 'string' } },
                required: ['member_id', 'reason'],
                additionalProperties: false,
              },
            },
            stuck: {
              type: 'array',
              description: 'Mail no member could be started for; it stays unread.',
              items: {
                type: 'object',
                properties: {
                  member_id: { type: 'string' },
                  reason: { type: 'string' },
                  messages: { type: 'number' },
                },
                required: ['member_id', 'reason', 'messages'],
                additionalProperties: false,
              },
            },
            unclaimed: { type: 'number', description: 'Unread mail addressed to the orchestrator itself.' },
            unread: { type: 'number' },
            unread_others: { type: 'number' },
          },
          required: ['dispatched', 'skipped', 'stuck', 'unclaimed', 'unread', 'unread_others'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const started = value.dispatched.length === 0
            ? '(no generation was needed)'
            : value.dispatched
              .map(row => `- ${row.member_id} is working on ${row.messages} message(s)`)
              .join('\n')
          const skipped = value.skipped.length === 0
            ? ''
            : `\nskipped: ${value.skipped.map(row => `${row.member_id} (${row.reason})`).join(', ')}`
          const stuck = value.stuck.length === 0
            ? ''
            : `\nstuck: ${value.stuck.map(row => `${row.member_id} (${row.reason}; ${row.messages} message(s) still unread)`).join(', ')}`
          const occupancy = value.unread === 0
            ? 'mailbox: nothing unread'
            : `mailbox: ${value.unread} unread, ${value.unread_others} addressed to others`
          const pendingForYou = value.unclaimed === 0 ? '' : ` — ${value.unclaimed} unread message(s) are yours: read them with member_inbox`
          return [{ type: 'text', text: `${started}${skipped}${stuck}\n\n${occupancy}${pendingForYou}` }]
        },
      },
      async execute(args, exec) {
        const api = getApi()
        const caller = await api.resolveCaller(exec)
        if (caller.memberId !== api.orchestratorId) throw new Error('member_dispatch is reserved for the orchestrator')
        const sessionId = exec.agent.session.id
        const journal = api.journalForSession(sessionId)
        const mailServer = caller.mailServer ?? api.mailServerForSession(sessionId)
        const pending = await mailServer.pending({ limit: args.limit ?? 20, excluding: api.orchestratorId })
        /** @type {Map<string, any[]>} */
        const byMember = new Map()
        for (const message of pending) {
          const list = byMember.get(message.toMember) ?? []
          list.push(message)
          byMember.set(message.toMember, list)
        }
        const dispatched = []
        const skipped = []
        const stuck = []
        for (const [memberId, messages] of byMember) {
          const { state } = await api.memberDeliveryState(memberId, journal)
          if (state === 'running') {
            skipped.push({ member_id: memberId, reason: 'already running; it reads its own inbox' })
            continue
          }
          if (state === 'reserved') {
            skipped.push({ member_id: memberId, reason: 'a generation is being prepared' })
            continue
          }
          // Two dispatch calls can overlap; a member gets one new generation at a
          // time so the same mail is not handed out twice.
          if (!api.claimMember(memberId)) {
            skipped.push({ member_id: memberId, reason: 'a dispatch is already starting a generation' })
            continue
          }
          // A lease held by a generation that already ended is expired: that
          // generation finished without reading, so the mail needs a new one.
          const lines = messages
            .map(message => `[${message.from.memberId ?? 'orchestrator'}#${message.from.generation ?? 0}${message.topic === undefined ? '' : ` ${message.topic}`}] ${message.body}`)
            .join('\n')
          const task = `Mail from other members, newer than your last turn:\n${lines}\n\nRead it with member_inbox, handle it, and finish. This supersedes any inherited instruction that your work was done.`
          try {
            const started = await api.rotate({ parent: exec.agent, memberId, prompt: task })
            await mailServer.markDispatched(messages.map(message => message.id), started.childId)
            await journal.markAutoWake(started.childId, { memberId, reason: 'mailbox-dispatch' })
            dispatched.push({ member_id: memberId, state: 'started', messages: messages.length })
          } catch (error) {
            // No generation exists for this mail, so report it instead of
            // pretending it was handled; the message stays unread for a retry.
            stuck.push({ member_id: memberId, reason: String(error?.message ?? error), messages: messages.length })
          } finally {
            api.releaseMember(memberId)
          }
        }
        const occupancy = await mailServer.inbox({
          reader: { childId: caller.childId, memberId: caller.memberId },
          ack: false,
        })
        return {
          dispatched,
          skipped,
          stuck,
          unclaimed: occupancy.unreadYours,
          unread: occupancy.unread,
          unread_others: occupancy.unreadOthers,
        }
      },
    },
    {
      name: 'member_post',
      description: 'Leave a message for another member. The recipient reads it with member_inbox; mail belongs to the member, so the member reads it the next time it runs. If the target already finished, the plugin starts that member again automatically so the message is actually read. The target must already exist: start the member with seeded_fork before writing to it.',
      parameters: {
        type: 'object',
        properties: {
          to_member: { type: 'string', description: 'Target member id from member_roster.' },
          body: { type: 'string', description: 'The message. State the ask and what you already verified.' },
          topic: { type: 'string', description: 'Optional short label shown in the inbox list.' },
        },
        required: ['to_member', 'body'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            message_id: { type: 'string' },
            to_member: { type: 'string' },
            wake: { type: 'string' },
          },
          required: ['message_id', 'to_member', 'wake'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `message ${value.message_id} queued for ${value.to_member}; ${value.wake}`,
        }],
      },
      async execute(args, exec) {
        const api = getApi()
        const caller = await api.resolveCaller(exec)
        const mailServer = caller.mailServer ?? api.mailServerForSession(exec.agent.session.id)
        const journal = caller.journal ?? api.journalForSession(exec.agent.session.id)
        const roster = await api.memberRoster(journal)
        if (!roster.some(member => member.member_id === args.to_member)) {
          const known = roster.map(member => member.member_id).join(', ') || 'none'
          throw new Error(`unknown member "${args.to_member}" (known: ${known}); start it with seeded_fork, or post to "orchestrator"`)
        }
        const message = await mailServer.post({
          from: { childId: caller.childId, memberId: caller.memberId, generation: caller.generation },
          toMember: args.to_member,
          body: args.body,
          topic: args.topic,
        })
        // A member writing to the orchestrator can deliver it right now: the steer
        // channel starts a turn on an idle parent, where the pre-step push alone
        // would wait for the user. Delivery removes the stored copy.
        if (args.to_member === api.orchestratorId && caller.memberId !== api.orchestratorId) {
          const text = `[mail from ${caller.memberId}]${args.topic === undefined ? '' : ` ${args.topic}`}: ${args.body}`
          if (await api.deliverToOrchestrator(exec.agent, journal.sessionId, text)) {
            await mailServer.discard([message.id])
            return {
              message_id: message.id,
              to_member: message.toMember,
              wake: 'delivered to the orchestrator now',
            }
          }
        }
        // A finished member has no live runtime, so a message for it would sit
        // unread forever. Wake it now, before returning, so the caller learns
        // whether the message will actually be handled.
        const wake = await api.wakeIfTerminal(args.to_member, journal.sessionId, 'member_post')
        return {
          message_id: message.id,
          to_member: message.toMember,
          wake: wake.woken
            ? `started the next generation (${wake.childId}) to read it`
            : (wake.reason === 'running' ? 'member is still running; it will read the message in this turn'
              : `no automatic wake: ${wake.reason}`),
        }
      },
    },
    {
      name: 'member_inbox',
      description: 'Read messages left for you by other members. Mail is normally delivered automatically at the start of the step that needs it, so use this only when you suspect a delivery was missed. Reading delivers a message: it leaves the mailbox and is recorded in your own context, so it is never returned twice. Reading consumes the message for you only. The result also reports how many messages the server holds in total, including mail addressed to others; while that total is above zero, keep working instead of finishing.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum messages to return, newest last. Defaults to 20.' },
          ack: { type: 'boolean', description: 'Mark the returned messages consumed. Defaults to true.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  from_member: { type: 'string' },
                  topic: { type: 'string' },
                  body: { type: 'string' },
                  at: { type: 'number' },
                },
                required: ['id', 'from_member', 'topic', 'body', 'at'],
                additionalProperties: false,
              },
            },
            stored: { type: 'number' },
            unread: { type: 'number' },
            unread_yours: { type: 'number' },
            unread_others: { type: 'number' },
            role: { type: 'string' },
          },
          required: ['messages', 'stored', 'unread', 'unread_yours', 'unread_others', 'role'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const line = message => `[${message.from_member}${message.topic === '' ? '' : ` · ${message.topic}`}] ${message.body}`
          const body = value.messages.length === 0
            ? '(no messages)'
            : value.messages.map(line).join('\n\n')
          const occupancy = value.unread === 0
            ? 'mailbox: empty'
            : `mailbox: ${value.unread} unread (${value.unread_yours} yours, ${value.unread_others} addressed to others)`
          // Only the orchestrator can dispatch, so only it is told to. Telling a
          // member would make it try a call that is reserved and rejected.
          const rule = value.role !== 'orchestrator' || value.unread_others === 0
            ? ''
            : ' — while mail for other members is unread, call member_dispatch instead of concluding; you cannot read it'
          return [{ type: 'text', text: `${body}\n\n${occupancy}${rule}` }]
        },
      },
      async execute(args, exec) {
        const api = getApi()
        const caller = await api.resolveCaller(exec)
        const mailServer = caller.mailServer ?? api.mailServerForSession(exec.agent.session.id)
        // Only a known mailbox reads: a member generation, or the orchestrator's
        // own address. A child this plugin never reserved gets nothing 鈥?the inbox
        // is point-to-point, never a broadcast channel.
        if (caller.memberId === undefined) return { messages: [], stored: 0, unread: 0, unread_yours: 0, unread_others: 0, role: 'member' }
        const result = await mailServer.inbox({
          reader: { childId: caller.childId, memberId: caller.memberId, generation: caller.generation },
          limit: args.limit,
          ack: args.ack !== false,
        })
        return {
          messages: result.messages.map(message => ({
            id: message.id,
            from_member: message.from.memberId ?? 'orchestrator',
            topic: message.topic ?? '',
            body: message.body,
            at: message.at,
          })),
          stored: result.stored,
          unread: result.unread,
          unread_yours: result.unreadYours,
          unread_others: result.unreadOthers,
          role: caller.memberId === ORCHESTRATOR_MEMBER_ID ? 'orchestrator' : 'member',
        }
      },
    },
    {
      name: 'seeded_preset_diagnose',
      description: 'Report whether the strategy preset registered, which preset ids the roster currently declares, and the exact error when it did not.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { json: { type: 'string', description: 'Registration diagnostics as JSON.' } },
          required: ['json'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.json }],
      },
      async execute() {
        return { json: JSON.stringify(await getApi().presetDiagnose(), null, 2) }
      },
    },
    {
      name: 'seeded_chain',
      description: 'Internal diagnostic: list one member of recorded incarnations, oldest first, with phase and predecessor.',
      parameters: {
        type: 'object',
        properties: { member_id: { type: 'string', description: 'Member identity.' } },
        required: ['member_id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'array', items: { type: 'string' } },
        render: (args, chain) => [{
          type: 'text',
          text: chain.length === 0
            ? `(member "${args.member_id}" has no generations)`
            : chain.join('\n'),
        }],
      },
      async execute(args, exec) {
        const api = getApi()
        const sessionId = exec?.agent?.session?.id
        const chain = await api.chain(args.member_id, sessionId)
        return chain.map(entry => `gen ${entry.generation} ${entry.childId} ${entry.phase} from=${entry.seedFrom ?? '-'}`)
      },
    },
  ]
}