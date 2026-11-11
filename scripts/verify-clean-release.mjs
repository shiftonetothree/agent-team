/**
 * Refuse to publish from an unclean tree.
 *
 * A published version cannot be taken back, so the package directory must match a
 * commit before `npm publish` runs. `prepublishOnly` calls this after the tests.
 *
 * @module @commonworks/agent-team/scripts/verify-clean-release
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run one git command in the package directory.
 * @param {string[]} args - git arguments.
 * @returns {string} trimmed stdout.
 */
function git(args) {
  return execFileSync('git', args, { cwd: packageDir, encoding: 'utf8' }).trim()
}

const status = git(['status', '--porcelain', '--', '.'])
if (status.length > 0) {
  console.error('agent-team: refusing to publish from an unclean tree; commit these first:\n' + status)
  process.exit(1)
}

const version = JSON.parse(git(['show', 'HEAD:package.json'])).version
console.log(`agent-team: clean tree at ${git(['rev-parse', '--short', 'HEAD'])}, published version ${version}`)
