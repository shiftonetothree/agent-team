/**
 * Register a strategy preset by inheriting the shipped `standard` preset.
 *
 * Why inheritance instead of a single foreign row: an agent preset is a complete
 * composition (persona, tools, plan mode, compaction, delegation). Registering a
 * preset that only carries a prompt hook produces an agent missing everything the
 * user expects, and an activation failure inside `agentPresets.register()` leaves
 * the definition in the roster without a usable generation. Cloning the live
 * `standard` rows keeps the new preset a real composition; only the playbook row
 * is added.
 *
 * Registration is best-effort and asynchronous, following the pattern proven by
 * the `dsh-starter` sibling project: wait for `standard`, register row by row,
 * and record failures for diagnostics instead of failing the plugin.
 *
 * @module @commonworks/agent-team/preset
 */

/** Preset id the shipped bundle declares; the composition we inherit. */
export const STANDARD_PRESET_ID = 'standard'

/** Row id of the playbook contribution inside a cloned preset. */
export const PLAYBOOK_ROW_ID = 'agent-team-playbook'

/** Row id of the first-turn nudge inside a cloned preset. */
export const NUDGE_ROW_ID = 'agent-team-session'

/** Persona prefix that replaces the inherited coding-agent persona. */
export const DEFAULT_PERSONA_PREFIX = 'You are a strategy orchestrator powered by the {{model}} model. You plan in stages and delegate evidence gathering and verification to members before you answer.'

/**
 * Clone one preset's declared plugin rows so edits cannot mutate the source.
 * @param {readonly Record<string, any>[]} plugins - declared rows.
 * @returns {Array<Record<string, any>>} detached rows.
 */
export function cloneRows(plugins) {
  return plugins.map(row => {
    const copy = { ...row }
    if ('config' in copy) {
      try {
        copy.config = structuredClone(copy.config)
      } catch {
        // A non-cloneable config object is shared read-only.
      }
    }
    return copy
  })
}

/**
 * Build the strategy preset definition from the live `standard` rows.
 *
 * @param {readonly Record<string, any>[]} standardPlugins - the `standard` preset's declared rows.
 * @param {object} options
 * @param {string} options.id - preset id.
 * @param {string} [options.name] - display name.
 * @param {string} [options.description] - roster description.
 * @param {number} [options.order] - roster ordering.
 * @param {string} options.entrySpecifier - module specifier of the playbook-only entry.
 * @param {string} [options.sessionSpecifier] - module specifier of the first-turn nudge entry.
 * @param {string} [options.playbookText] - text override passed to the entry.
 * @param {string} [options.personaPrefix] - persona prefix replacing the inherited one; 
ull keeps it.
 * @returns {{ id: string, name: string, description: string, order?: number, plugins: Array<Record<string, any>> }}
 */
export function buildStrategyPreset(standardPlugins, options) {
  if (!Array.isArray(standardPlugins) || standardPlugins.length === 0) {
    throw new Error('agent-team: cannot inherit the standard preset; the profile does not declare one')
  }
  const rows = cloneRows(standardPlugins)

  // A clone of standard already carries the coding-agent persona. Replace its
  // prefix so the operating mode is stated before any tool guidance, the same way
  // dsh-starter templates replace it.
  if (options.personaPrefix !== null) {
    const prefix = options.personaPrefix ?? DEFAULT_PERSONA_PREFIX
    const persona = rows.find(candidate => candidate.id === 'persona' || candidate.name === '@deepseek-ai/dsh-persona')
    if (persona === undefined) rows.unshift({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix } })
    else persona.config = { ...(persona.config ?? {}), prefix }
  }

  const upsert = row => {
    const existing = rows.findIndex(candidate => candidate.id === row.id)
    if (existing === -1) rows.push(row)
    else rows[existing] = row
  }
  upsert({
    id: PLAYBOOK_ROW_ID,
    name: options.entrySpecifier,
    ...(options.playbookText === undefined ? {} : { config: { text: options.playbookText } }),
  })
  if (options.sessionSpecifier !== undefined) {
    upsert({ id: NUDGE_ROW_ID, name: options.sessionSpecifier })
  }
  return {
    id: options.id,
    name: options.name ?? options.id,
    description: options.description ?? 'Runs author strategies over seeded members.',
    ...(options.order === undefined ? {} : { order: options.order }),
    plugins: rows,
  }
}

/**
 * Wait for the `standard` preset's rows to appear in the registry.
 *
 * Preset declarations and this plugin activate independently, so on a cold boot
 * the rows may not exist yet. The registry exposes no public accessor for
 * declarations, so this reads its definition map read-only and polls briefly.
 *
 * @param {{ definitions?: Map<string, { config?: { plugins?: readonly Record<string, any>[] } }> }} registry - the preset registry.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<readonly Record<string, any>[]>} the standard rows.
 */
export async function waitForStandard(registry, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const plugins = registry?.definitions?.get(STANDARD_PRESET_ID)?.config?.plugins
    if (Array.isArray(plugins) && plugins.length > 0) return plugins
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const available = [...(registry?.definitions?.keys?.() ?? [])].join(', ') || '(none)'
  throw new Error(`agent-team: the standard agent preset is unavailable; cannot inherit its composition (available: ${available})`)
}

/**
 * Register the strategy preset once `standard` is available.
 *
 * @param {any} registry - the `agentPresets` service.
 * @param {object} options - build options accepted by {@link buildStrategyPreset} plus `timeoutMs`.
 * @returns {Promise<{ registered: string[], errors: string[], standardAvailable: boolean, dispose?: () => Promise<void> }>}
 *   diagnostics; never rejects, because a missing preset must not take the plugin down.
 */
export async function registerStrategyPreset(registry, options) {
  const diagnostics = { registered: [], errors: [], standardAvailable: false }
  try {
    const standardPlugins = await waitForStandard(registry, options.timeoutMs ?? 30000)
    diagnostics.standardAvailable = true
    const definition = buildStrategyPreset(standardPlugins, options)
    try {
      diagnostics.dispose = await registry.register(definition)
      diagnostics.registered.push(definition.id)
    } catch (error) {
      diagnostics.errors.push(error instanceof Error ? error.message : String(error))
    }
  } catch (error) {
    diagnostics.errors.push(error instanceof Error ? error.message : String(error))
  }
  return diagnostics
}
