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
import { existsSync, readFileSync } from 'node:fs'
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
// run by hand: the installed version, and that no `@deepseek-ai` package came
// along (a linked or packed install must never shadow the Host's own line).
const installedDir = join(profileDir, 'node_modules', ...manifest.name.split('/'))
const installed = existsSync(join(installedDir, 'package.json'))
  ? JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version
  : '(missing)'
const leaked = spawnSync('sh', ['-c', `ls ${JSON.stringify(join(profileDir, 'node_modules'))} | grep -c deepseek`], { encoding: 'utf8' })
process.stdout.write(`dsh-claude: installed ${installed}; @deepseek-ai packages in the profile: ${(leaked.stdout ?? '0').trim()}\n`)
if ((leaked.stdout ?? '0').trim() !== '0') process.stderr.write('dsh-claude: warning: the profile now carries @deepseek-ai packages of its own\n')
process.stdout.write('dsh-claude: quit and reopen Desktop to load it\n')
