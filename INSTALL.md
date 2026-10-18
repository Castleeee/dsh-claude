# Installation and removal runbook

Current guidance: 2026-10-18, fork plugin `0.1.65-fork.1`, Host `0.2.1-rc.2` line.
Repo: `Castleeee/dsh-claude` (fork of `Norman-else/dsh-claude`). `master` is the
stable line and the default branch — every push or merge there builds and
re-cuts the release, and that release is what gets installed. `feature/latest`
is the unstable line and is never released. This plugin is installed from a
**built tarball**; there is no supported `link:` install — see §3.

## 1. Identify the running installation

Use the DSH CLI supplied by the installation you intend to modify. Determine
its active profile before installing: the local Desktop setup uses `desktop`;
a standalone Web setup may use `web`. Do not create another profile or server
to compensate for a command aimed at the wrong one. No port is assumed here.

Examples below use `desktop`; substitute the actual profile throughout.
If `dsh` is not on PATH, use that installation's CLI entry point instead.

## 2. Install the built tarball

Fetch it from the release (stable, rebuilt by every push to `master`):

```sh
dsh plugin --profile desktop add https://github.com/Castleeee/dsh-claude/releases/download/v0.1.65-fork.1/norman-else-dsh-claude-0.1.65-fork.1.tgz
```

Or install a file you were handed:

```sh
dsh plugin --profile desktop add /absolute/path/to/norman-else-dsh-claude-0.1.65-fork.1.tgz
```

Wait for the profile operation to finish, then quit Desktop completely and
reopen it. Select **Claude** in a new session. The package's bundle patch
declares the preset; its route uses the active profile package source.

The tarball must be a real file path, not `link:`. Confirm afterwards that the
install did not drag the fork's devDependencies into the profile — this must
print `0`:

```sh
ls ~/.dsh/profiles/desktop/node_modules | grep -c deepseek
```

Then confirm the installed version:

```sh
node -p "require(require('os').homedir()+'/.dsh/profiles/desktop/node_modules/@norman-else/dsh-claude/package.json').version"
```

## 3. Build the tarball from a source checkout

Requires Node.js 20 or later and pnpm. From the checkout:

```sh
git clone https://github.com/Castleeee/dsh-claude.git   # master is the default branch
cd dsh-claude
pnpm install --frozen-lockfile
pnpm check
pnpm pack --pack-destination .
```

On macOS, prepend `/opt/homebrew/bin` to PATH if that is where pnpm is installed.
PowerShell does not use the POSIX `PATH=... command` syntax.

`pnpm check` runs typecheck, tests and the build, so `lib/` exists before
packing; `prepack` rebuilds it inside `pnpm pack` regardless. The result is
`norman-else-dsh-claude-<version>.tgz` in the checkout — install it with §2.

**Install the packed tarball, not a `link:`.** The development graph follows the
Host line, so a link resolves the same `@deepseek-ai/*` versions the Host has —
until the App moves ahead. Then the checkout's older devDependencies are what
Node resolves, the Host judges every public plugin incompatible, and Desktop
starts with no window and no log. `pnpm pack` is what keeps `devDependencies`
out of the install, so the tarball route cannot drift this way. Details:
`MAINTENANCE.md` §5.1.

If a build is deliberately run beside a live profile, finish active turns first:
a build can trigger a live client reload and interrupt projection subscriptions.
During active work, validate in a separate source copy with its own dependencies;
do not copy its build into the live checkout. After a deliberate live rebuild,
fully restart Desktop to verify activation.

## 4. Check the local Claude CLI

Claude Code owns authentication. Use its existing login or supported settings
configuration; never request, copy, print, or store credentials in this plugin.

```sh
node lib/bin.mjs doctor
```

If discovery fails, use `doctor --executable` with the absolute native Claude
executable path. The standalone CLI's path search is simpler than the Host
resolver; on Windows prefer the native executable over an npm `.cmd` shim.

Read each report field. A zero exit code from the standalone Doctor establishes
version detection, not authenticated query success; its handshake is `not-run`.
An `unknown` authentication report is inconclusive. Use Settings/Doctor inside
DSH and a minimal real turn to verify the installed environment.

Main turns, session titles, and branch summaries load `user`, `project`, and
`local` settings. Summary calls also inherit behavior settings and use their
own working directory (`process.cwd()`), not a borrowed session process.

## 5. Smoke test after a full Desktop restart

1. Confirm **Claude** appears in the new-session preset picker.
2. Verify an existing native preset still works.
3. Send a minimal read-only Claude prompt; confirm streaming, final output, and title.
4. Under an access mode that requires approval, exercise deny and allow-once
   with a harmless temporary edit. Full access intentionally bypasses ordinary approvals.
5. Test a user question and plan review; both must remain available under Full access.
6. Stop a running turn, then send another prompt; confirm cleanup and continuity.
7. Restart Desktop and continue the same conversation to verify resume.
8. Open diff, plan, tasks, and overview tabs in the right sidebar; exercise
   fullscreen and close. Check command completion, prompt controls, and queue UI.
9. In a disposable repository, verify worktree creation and naming. Preserve
   needed changes before deleting its workspace: managed-worktree reconciliation
   can remove dirty files. Merged-branch cleanup is a separate guarded action.
10. Read the new Host log for `dsh-claude client [boot-check]`,
    `[slot-entry-crashed]`, and plugin refresh failures.

On the current Windows Desktop, Host logs are under
`%APPDATA%/DSH Desktop/logs/host/`; shell startup logs are one directory above.
Record what was actually exercised. A source audit or green unit tests do not
establish successful real authentication, approval, streaming, or resume.

## 6. Remove the plugin

The bundle patch declares the preset, so removing the package removes it:

```sh
dsh plugin --profile desktop remove @norman-else/dsh-claude
```

Restart Desktop after uninstalling. Removing the plugin does not mean all Claude
transcripts, sidecars, settings, or worktrees have been deleted.

## 7. Local development: pick the install mode

Three modes exist, and `scripts/profile-mode.mjs` switches one profile between
them (`DSH_PROFILE`, default `desktop`; `DSH_HOME`, default `~/.dsh`):

```sh
node scripts/profile-mode.mjs link      # link the checkout        (development)
node scripts/profile-mode.mjs dist      # pack it, install the tarball
node scripts/profile-mode.mjs release   # install the release asset
```

| | `link` | `dist` / `release` |
|---|---|---|
| Rebuild needed | no repack: the profile resolves the checkout | repack + reinstall |
| Development | the only mode where an edit is live | a full round trip per change |
| Risk | the checkout's `@deepseek-ai/dsh-*` devDependencies enter the Host's resolution path | `devDependencies` never enter the tarball |

`link` is safe **only while the checkout's development graph is on the Host's
line**. After a Desktop upgrade, run §2 of `MAINTENANCE.md` (re-point the 78
devDependencies, the workspace override and the contract test at the new Host
version) **before** switching back to `link`; otherwise the Host loads the
checkout's older `@deepseek-ai/*` packages, reads every public plugin as
incompatible, and starts with no window and no log at all.

Every mode ends with quitting and reopening Desktop; the client bundle is loaded
at boot. The script prints the installed version and the count of
`@deepseek-ai` packages inside the profile — that count must be `0`.

