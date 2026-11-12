/**
 * Mailbox push: deliver a member's unread mail inside its own step.
 *
 * Polling through `member_inbox` depends on the model deciding to look, and in
 * real sessions members look rarely. DSH lets a plugin contribute messages to a
 * step (`agent/pre-step` waterfall), so the mail can arrive as model-visible
 * input instead: the text is in the request before the model plans anything, and
 * the session log records it because it is a `user/message` with a snapshot
 * source.
 *
 * Delivery here has the same meaning as `member_inbox`: the message is removed
 * from the store once it has been handed to the generation that reads it.
 *
 * @module @commonworks/agent-team/mailbox-push
 */

import { randomUUID } from 'node:crypto'

/** Source kind recorded on the pushed message. */
export const MAIL_KIND = 'agent-team-mail'

/**
 * Render the pushed message body.
 * @param {{ from_member: string, topic?: string, body: string }[]} messages - unread mail.
 * @param {{ memberId: string }} identity - the receiving member.
 * @returns {string} the instruction-and-mail text.
 */
export function pushedMailText(messages, identity) {
  const lines = messages
    .map(message => `- [${message.from_member}${message.topic === undefined || message.topic === '' ? '' : ` · ${message.topic}`}] ${message.body}`)
    .join('\n')
  return `[${MAIL_KIND}] You have ${messages.length} message(s) from other members, delivered now:\n${lines}\n\n`
    + `Answer the one that is waiting on you with member_post("${messages[0].from_member}", …) if a reply is needed, `
    + 'then continue your own work. These messages are no longer in your mailbox: they are part of this turn.'
}

/**
 * Build the snapshot user message injected into the step.
 * @param {{ from_member: string, topic?: string, body: string }[]} messages - unread mail.
 * @param {{ memberId: string }} identity - the receiving member.
 * @returns {any} a user message carrying the mail.
 */
export function buildPushedMail(messages, identity) {
  const text = pushedMailText(messages, identity)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: MAIL_KIND, form: 'snapshot', sections: [{ name: MAIL_KIND, text }] },
  }
}

/**
 * Mount the push listener.
 *
 * Runs on every step of every agent in the composition, and does nothing for an
 * agent that is not a member with unread mail.
 *
 * @param {any} ctx - cordis context.
 * @param {{ api: any }} options - the agent-team API whose store is used.
 * @returns {() => void} disposer that removes the listener.
 */
export function mountMailboxPush(ctx, { api }) {
  return ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    const agent = payload?.agent
    const childId = agent?.session?.id
    if (typeof childId !== 'string' || childId.length === 0) return decision
    const caller = await api.resolveCaller({ agent })
    if (caller.memberId === undefined || caller.mailServer === undefined) return decision
    const store = caller.mailServer
    const inbox = await store.inbox({ reader: { childId, memberId: caller.memberId }, ack: false })
    if (inbox.messages.length === 0) return decision
    // Deliver: the payload is now part of the request, so drop it from the store.
    const delivered = await store.inbox({ reader: { childId, memberId: caller.memberId } })
    const messages = delivered.messages.map(message => ({
      from_member: message.from.memberId ?? 'orchestrator',
      topic: message.topic,
      body: message.body,
    }))
    return { ...decision, messages: [...decision.messages, buildPushedMail(messages, { memberId: caller.memberId })] }
  }, { prepend: true })
}
