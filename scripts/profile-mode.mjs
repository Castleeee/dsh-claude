#!/usr/bin/env node
/**
 * Switch one DSH profile between the three ways this plugin can be installed.
 *
 *   node scripts/profile-mode.mjs link      link this checkout  (development)
 *   node scripts/profile-mode.mjs dist      pack here, install the tarball
 *   node scripts/profile-mode.mjs release   install the GitHub release asset
 *
 * Profile and home come from `DSH_PROFILE` (default `desktop`) and `DSH_HOME`
 * (default `~/.dsh`). `release` derives its URL from this package's version and
 * repository, so it names exactly the asset `.github/workflows/release.yml`
 * publishes.
 *
 * `link` is the development mode: the profile resolves the plugin from this
 * checkout, so a rebuild needs no repacking. Its one discipline is
 * `MAINTENANCE.md` §2 — the checkout's `@deepseek-ai/dsh-*` devDependencies must
 * stay on the Host's line, or a linked install hands the Host the wrong ones.
 * `dist` and `release` are distribution modes: `devDependencies` never enter the
 * tarball, so they cannot drift that way.
 *
 * After any switch, quit and reopen Desktop: the client bundle is loaded at
 * boot, and the Host-side plugin activates with the profile.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const mode = process.argv[2]
const profile = process.env.DSH_PROFILE ?? 'desktop'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const artifacts = join(dshHome, 'artifacts')
/** pnpm packs a scoped name as `<scope>-<name>-<version>.tgz`. */
const asset = `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`

function usage(exitCode) {
  process.stderr.write('usage: node scripts/profile-mode.mjs <link|dist|release>\n')
  process.exit(exitCode)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function releaseUrl() {
  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/u.exec(manifest.repository?.url ?? '')
  if (match === null) throw new Error('package.json repository is not a GitHub URL')
  return `https://github.com/${match[1]}/${match[2]}/releases/download/v${manifest.version}/${asset}`
}

if (!['link', 'dist', 'release'].includes(mode ?? '')) usage(2)
if (!existsSync(profileDir)) {
  process.stderr.write(`dsh-claude: no profile directory at ${profileDir}\n`)
  process.exit(1)
}

let spec
if (mode === 'link') {
  spec = `link:${root}`
} else if (mode === 'dist') {
  run('pnpm', ['pack', '--pack-destination', artifacts], root)
  spec = `file:${join(artifacts, asset)}`
} else {
  spec = releaseUrl()
}

process.stdout.write(`dsh-claude: ${mode} -> ${spec}\n`)
run('pnpm', ['add', spec], profileDir)

// Verify what actually landed, the same two checks INSTALL.md asks a user to
// run by hand: the installed version, and whether this install dragged Host
// packages into the profile's resolution path. A profile may declare
// `@deepseek-ai` plugins of its own -- a computer-use plugin does -- so the
// question is not whether any are present, but whether any is there that the
// profile never asked for. Only those shadow the Host's own line.
const installedDir = join(profileDir, 'node_modules', ...manifest.name.split('/'))
const installed = existsSync(join(installedDir, 'package.json'))
  ? JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version
  : '(missing)'
// The invariant is about *this* install, not about the profile: a packed
// install's runtime dependencies must not include the Host's own line. A
// profile may legitimately carry `@deepseek-ai` plugins of its own (a
// computer-use plugin does, with its transitive tree), which is why counting
// the scope directory would only ever mislead.
const installedManifest = existsSync(join(installedDir, 'package.json'))
  ? JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
  : {}
const hostDeps = Object.keys({ ...installedManifest.dependencies, ...installedManifest.optionalDependencies })
  .filter(name => name.startsWith('@deepseek-ai/'))
process.stdout.write(`dsh-claude: installed ${installed}; Host packages this install pulls: ${hostDeps.length}\n`)
if (hostDeps.length > 0) process.stderr.write(`dsh-claude: warning: this install pulls ${hostDeps.join(', ')} -- a packed install must never shadow the Host's own line\n`)
process.stdout.write('dsh-claude: quit and reopen Desktop to load it\n')
