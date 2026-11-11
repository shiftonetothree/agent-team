/**
 * Preset-scope entry: contributes only the strategy playbook.
 *
 * A registered preset is a complete composition, so this module is mounted as one
 * extra row inside a clone of the `standard` preset. It must not own the subagent
 * provider or the strategy tools — those stay global, registered by the
 * profile-level instance.
 *
 * @module @commonworks/agent-team/preset-entry
 */

import { strategyPlaybookSection } from './playbook.js'

/** Plugin name used by the Loader. */
export const name = 'agent-team-playbook'

/** Required service: the section is the whole contribution. */
export const inject = ['systemPrompt']

/**
 * Register the playbook section inside the preset's scope.
 * @param {any} ctx - cordis context of the preset scope.
 * @param {{ text?: string }} [config] - optional text override.
 */
export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.systemPrompt.section(strategyPlaybookSection(
    config.text === undefined ? {} : { text: config.text },
  )))
}
