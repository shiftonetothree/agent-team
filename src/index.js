/**
 * Function-plugin entry point.
 *
 * Kept intentionally thin: upstream's Loader discards a function plugin's
 * namespace when the module also default-exports an object, so this module
 * exports only `name` / `inject` / `apply`. The programmatic API lives in
 * `./api.js`; this entry publishes the same instance as the `seededFork`
 * service so other plugins can reach it through `ctx.get('seededFork')`.
 *
 * @module @commonworks/agent-team/plugin
 */

import { createSeededFork } from './api.js'

/** Plugin name used by the Loader. */
export const name = 'agent-team'

/** Required services: the subagent registry is the whole point. */
export const inject = ['subagents']

/**
 * Mount the agent-team provider, its tools, and the `seededFork` service.
 * @param {any} ctx - cordis context.
 * @param {any} [config] - plugin config, passed through to `createSeededFork`.
 */
export function apply(ctx, config = {}) {
  const api = createSeededFork(ctx, config)
  ctx.effect(() => {
    // `provide` returns the exact disposer; cordis refuses plain property
    // assignment on a context.
    const removeService = ctx.provide('seededFork', api)
    return () => {
      removeService()
      api.dispose()
    }
  })
}
