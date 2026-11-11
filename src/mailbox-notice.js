/**
 * Mailbox notice appended to the orchestrator's own session.
 *
 * The orchestrator receives member output through two channels: its `member_inbox`
 * tool result, and the result message a settled member delivers. Only the second one
 * arrives on its own, so the plugin appends the mailbox occupancy to the parent's
 * session at settlement. The notice is a snapshot user message, which the session
 * log records and the model sees on its next step.
 *
 * @module @commonworks/agent-team/mailbox-notice
 */

import { randomUUID } from 'node:crypto'

/** Source kind recorded on the snapshot section. */
export const NOTICE_KIND = 'agent-team-mailbox'

/**
 * Compose the notice text.
 * @param {{ total: number, yours: number, others: number }} counts - server occupancy.
 * @returns {string}
 */
export function noticeText({ total, yours, others }) {
  return `[${NOTICE_KIND}] The mailbox server holds ${total} message(s): ${yours} for you, ${others} addressed to others. `
    + 'Call member_inbox for yours and member_dispatch for the rest; do not read mail addressed to others. '
    + 'While the server is not empty, keep working instead of giving the user a conclusion.'
}

/**
 * Build the snapshot user message appended to the parent session.
 * @param {{ total: number, yours: number, others: number }} counts - server occupancy.
 * @returns {any} a user message carrying the notice.
 */
export function buildMailboxNotice(counts) {
  const text = noticeText(counts)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_KIND, form: 'snapshot', sections: [{ name: NOTICE_KIND, text }] },
  }
}

/**
 * Append the notice to a live parent session.
 *
 * A parent whose session cannot take an append (a detached or fake agent in tests,
 * or a turn that already ended) simply does not get one: the notice is advisory and
 * must never fail the settlement it reports on.
 *
 * @param {any} parent - the orchestrating agent.
 * @param {{ total: number, yours: number, others: number }} counts - server occupancy.
 * @returns {boolean} whether the session accepted the notice.
 */
export function appendMailboxNotice(parent, counts) {
  if (counts.total <= 0) return false
  const append = parent?.session?.append
  if (typeof append !== 'function') return false
  try {
    append.call(parent.session, 'user/message', buildMailboxNotice(counts))
    return true
  } catch {
    return false
  }
}
