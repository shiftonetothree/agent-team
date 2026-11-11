/**
 * First-turn strategy nudge.
 *
 * A system-prompt section alone loses to tool descriptions and the persona: in a
 * real session the model saw the strategy playbook and all four strategy tools and
 * still answered a multi-part task in one pass. `dsh-starter` solves the same
 * problem by injecting one snapshot user message right before the task, so the
 * operating rule sits next to the request instead of a thousand tokens earlier.
 *
 * The listener runs on `agent/pre-step`, turn 1 step 1, once per Agent.
 *
 * @module @commonworks/agent-team/preset-session
 */

import { randomUUID } from 'node:crypto'

/** Plugin name used by the Loader. */
export const name = 'agent-team-session'

/** Agents already nudged in this process; a reload starts a new set. */
const nudged = new WeakSet()

/** Default first-turn instruction. */
export const STRATEGY_NUDGE = `[agent-team] This session runs an author strategy, not a single pass. Before you answer the user's first message:

1. Write the stage plan in your reply: stages in order, the member name for each stage, and one falsifiable acceptance check per stage.
2. Dispatch before you investigate anything yourself. Unless the message is small talk or a single fact you already know, start at least two \`seeded_fork\` members in the same stage (for example \`ground\` and \`risk\`) so the evidence is gathered in parallel. Do not read the repository yourself first: that is the members' job. Design how they work together in the same breath: each \`task\` names the peers that member should message, what it sends them, and what it decides alone. Members talk to each other with \`member_post\`; do not become the switchboard for ordinary coordination.
3. Verify with the same member. After the first stage settles, use \`seeded_rotate\` on that member so it re-examines its own finding instead of handing the work to a fresh context.
4. Answer only from member output. If a claim was not produced or re-checked by a member, mark it as unverified instead of asserting it.
5. Watch the mailbox. After every member result, and before each step, check the mailbox server total. While it is above zero, do not conclude: call \`member_inbox\` for your own mail and \`member_dispatch\` so members pick up the mail addressed to them. Never read mail addressed to another member.
6. Stop on failure. If a member fails, report what was verified, what was not, and stop dispatching new stages.

Reporting rule: separate "verified by which generation" from "unverified". Never present an unverified claim as confirmed.`

/**
 * Build the snapshot user message injected on the first step.
 * @param {string} text - instruction text.
 * @returns {any} a user message carrying the strategy nudge.
 */
export function buildNudgeMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'agent-team-session',
      form: 'snapshot',
      sections: [{ name: 'agent-team-session', text }],
    },
  }
}

/**
 * Mount the first-turn nudge inside a preset scope.
 * @param {any} ctx - cordis context of the preset scope.
 * @param {{ text?: string }} [config] - optional text override.
 */
export function apply(ctx, config = {}) {
  const text = typeof config.text === 'string' && config.text.length > 0 ? config.text : STRATEGY_NUDGE
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    if (payload?.turn !== 1 || payload?.step !== 1) return decision
    const agent = payload?.agent
    if (agent === undefined || nudged.has(agent)) return decision
    nudged.add(agent)
    return { ...decision, messages: [...decision.messages, buildNudgeMessage(text)] }
  }, { prepend: true })
}
