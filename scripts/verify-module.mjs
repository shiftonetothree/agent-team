#!/usr/bin/env node
/**
 * Verify the plugin's loading contract without booting a harness.
 *
 * Checks the shape upstream's Loader and `SubagentRuntime` depend on:
 *   - a function plugin exports `name` / `inject` / `apply` and no default
 *   - the provider duck-types `SubagentProvider` (name, capabilities,
 *     inheritsParentContext, prepareContinuable)
 *   - capability keys match the required set
 *   - `prepareContinuable` answers `{}` (a fresh child) for an unknown id
 *
 * @module @commonworks/agent-team/scripts/verify-module
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const plugin = await import(pathToFileURL(resolve(root, 'src/index.js')).href)
const api = await import(pathToFileURL(resolve(root, 'src/api.js')).href)

const problems = []
const check = (label, run) => {
  try {
    run()
    process.stdout.write(`ok   ${label}\n`)
  } catch (error) {
    problems.push(`${label}: ${error.message}`)
    process.stdout.write(`FAIL ${label}\n`)
  }
}

check('plugin exports name', () => assert.equal(typeof plugin.name, 'string'))
check('plugin exports inject including subagents', () => assert.deepEqual(plugin.inject, ['subagents']))
check('plugin exports apply', () => assert.equal(typeof plugin.apply, 'function'))
check('plugin has no default export', () => assert.equal('default' in plugin, false))
check('api exports createSeededFork', () => assert.equal(typeof api.createSeededFork, 'function'))
check('api exports LineageJournal', () => assert.equal(typeof api.LineageJournal, 'function'))

const playbook = await import(pathToFileURL(resolve(root, 'src/playbook.js')).href)
check('playbook names its own tools', () => {
  for (const tool of ['member_start', 'member_dispatch', 'member_post', 'member_inbox']) {
    assert.match(playbook.STRATEGY_PLAYBOOK, new RegExp(`\\b${tool}\\b`, 'u'), `playbook must name ${tool}`)
  }
})
check('playbook section is placed after subagent guidance', () => {
  const section = playbook.strategyPlaybookSection()
  assert.equal(section.name, 'agent-team:strategy')
  assert.ok(section.order > 2800 && section.order < 2900, 'expected placement between subagent tool guidance and reporting')
})
check('preset mounts the entry with providers disabled', () => {
  const preset = playbook.strategyMirrorPreset({ specifier: 'file:///plugin/index.js' })
  assert.equal(preset.id, 'agent-team')
  assert.equal(preset.plugins.length, 1)
  assert.equal(preset.plugins[0].config.provider, false)
  assert.equal(preset.plugins[0].config.registerTools, false)
  assert.equal(preset.plugins[0].config.playbook, true)
})

const provider = new api.SeededForkProvider({ registry: { findByChild: async () => undefined } })
check('provider name', () => assert.equal(provider.name, 'agent-team'))
check('provider declares inherited context', () => assert.equal(provider.inheritsParentContext, true))
check('provider exposes prepareContinuable', () => assert.equal(typeof provider.prepareContinuable, 'function'))
check('provider capabilities cover the required keys', () => {
  for (const key of ['agentOptions', 'outputSchema', 'depthLimit', 'toolFilter', 'persona']) {
    assert.equal(typeof provider.capabilities[key], 'boolean', `missing capability ${key}`)
  }
})

const prepared = await provider.prepareContinuable({ sessionId: 'unreserved-child' })
check('unknown child prepares as fresh', () => assert.deepEqual(prepared, {}))

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} contract problem(s):\n${problems.map(problem => `- ${problem}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\nplugin contract verified\n')
}
