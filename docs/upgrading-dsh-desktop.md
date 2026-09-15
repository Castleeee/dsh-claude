# Following a DSH Desktop upgrade

Current procedure reviewed 2026-09-14. Historical appendices explain earlier
failures; use the procedure below for current installations.

## Current baseline: Desktop 2.0.10 / Host 0.1.5-rc.2

On the audited Windows installation, the Host packages are unpacked at
`E:\DSH Desktop\resources\app\node_modules\@deepseek-ai\`.
Check `resources/app/` first, then `resources/app.asar.unpacked/`; extract
`resources/app.asar` only when neither contains the Host packages. The paths
in the historical sections below describe those releases, not a fixed layout.

The development graph now targets `0.1.5-rc.2`. Keep `dsh-client-runtime` and
`dsh-host-apiproxy` on their legacy `0.1.1-rc.2` development versions. The
plugin's runtime peer floor remains `0.1.5-rc.1`: this upgrade adds no required
Host API. Do not raise that floor merely to match the development graph.

The rc.2 audit found no incompatible changes in the plugin's imported APIs,
conversation definitions, or nine registered Slot kinds. After normalizing
CSS module hashes, the visible changes were file-icon artwork and a 4px
turn-tail action margin. Preset discovery now supports the Desktop resolver;
the settings package adds legacy compatibility exports.

The npm rc.2 packages are not byte-identical to this Desktop build: after
normalizing CSS hashes and build paths, 141 of 143 compared runtime JS files
match. Desktop additionally patches `dsh-agent-presets` discovery and
`dsh-settings` compatibility exports. Continue auditing the installed Host;
matching version numbers alone are not sufficient.

The Host's Windows runner now sets `ELECTRON_RUN_AS_NODE` in its own bootstrap
environment. Keep `src/windows-job-runner.ts` while supporting rc.1: the wrapper
is redundant on this rc.2 Host but still protects older Desktop installations.
The Host sets its flag inside the runner environment builder, so the wrapper
does not necessarily become a no-op merely because the Host contains the fix.

For a linked, running profile, validate dependency changes and run `pnpm check`
in a separate source copy first. Do not rebuild the live checkout during a
turn. Source comparison and clean diagnostics do not replace the manual smoke
scenarios below; record those separately when actually exercised.

## 1. Identify the installation and active profile

Locate the running Desktop executable and its `resources` directory. Check
package manifests inside the installation rather than inferring the core
version from the Desktop version. Confirm the active profile and whether the
plugin is registry-installed or linked before changing dependencies or builds.
The local audited profile is `desktop`, linked to `K:/PersonalWorkspace/dsh-claude`.
These are observations, not paths to assume on another machine.

Look for Host packages in this order:

1. `resources/app/node_modules/@deepseek-ai/`.
2. `resources/app.asar.unpacked/node_modules/@deepseek-ai/`.
3. If packages are inside `resources/app.asar`, extract that archive into a
   temporary directory, never over the installation:

```sh
npx --yes @electron/asar extract "<resources>/app.asar" "<scratch>/asar"
```

The installed Host ships no usable development declarations for this audit.
A green typecheck against the repository's dependency graph is not proof that
its runtime exports match the Desktop installation.

## 2. Read diagnostics before changing anything

On the audited Windows Desktop, Host logs are under
`%APPDATA%/DSH Desktop/logs/host/`; Electron-shell logs are in `logs/`.
Check the current run's timestamps, not only today's whole file.

Look for `dsh-claude client [boot-check]`, `[slot-entry-crashed]`, and
`dsh-claude:` refresh or initialization failures. Also check preset preservation
and duplicate Loader messages. Attribute errors to the package in the stack:
a failure in another plugin does not establish a Claude-plugin failure.

Boot checks cover declared services, selected methods, and the scoped composer
CSS property. A healthy renderer or an empty error log cannot prove that every
button has valid owner props or that every feature has mounted.

If startup fails, first identify whether this plugin is named in the failure.
Preserve local edits and the existing profile. Restore a known-good package or
build only through a reviewed rollback; do not blindly switch branches in a
working checkout. If temporarily unmounting the bundle, account for its managed
preset route too. See [INSTALL.md](../INSTALL.md) for guarded preset removal.

## 3. Compare the old graph, new Host, and new npm graph

Before installing new dependencies, retain the old manifests/lockfile or an
isolated copy. Enumerate every runtime import from `src/`, client provider in
`package.json`, and relevant transitive controller/runner package.

Compare JS implementations and exports. Exclude source maps and declaration
metadata from the behavioral diff. Normalize CSS hash prefixes and build paths,
but preserve local class names and actual CSS declarations.

For published packages, update the development versions, workspace overrides,
release-age exclusions, lockfile, and package-contract expectations together.
Keep legacy exceptions explicit. Raise runtime peer minima only when a newly
required API actually excludes older compatible Hosts.

Install and validate in an isolated source copy first. Compare the new npm
implementations to the installed Host again: even identical version strings can
hide Desktop-only patches. Do not copy Host packages into this repository or
patch the installed Host to satisfy compilation.

## 4. Audit every integration boundary

- Runtime imports: verify exported values, not just matching type names.
- Host services: agent routing, session snapshots, attachments, approval,
  questions, managed subprocesses, command metadata, and preset discovery.
- Client services: session/workspace controllers, conversation definitions,
  input state/actions, input triggers, sidebar tab registration and opening.
- Slots: audit both `slots.inject` and `slots.register`, including their owner
  props and standard hooks. Current keys are `conversation.chat.node`,
  `conversation.chat.turnTail`, `conversation.session.header.actions`,
  `conversation.session.header.utilities`, `conversation.input.left`,
  `conversation.input.dock`, `shell.overlay`, `settings.section`, and
  `sidebar.right.pane.tab`.
- DOM bridges: `hero-dom-bridge.ts`, `rewind-dom.ts`, `host-chrome.ts`,
  `preset-seat-mark.ts`, and `composer-style-probe.ts`. Verify their `data-*`
  attributes, local class names, and `--dsh-composer-card-max-width` scope.
- Auxiliary queries: titles, branch summaries, model/usage probes, snippets,
  refinement, and selection questions; they do not all use supervisor options.
- Compatibility shims: verify whether upstream fixed their original cause and
  whether retaining support for older Hosts still requires them.

Compare each Slot with a Host-owned contributor to the same Slot. A Slot name
surviving is insufficient when its caller has stopped passing a property.

## 5. Repair and verify

For an actual behavior change, reproduce it with the new Host contract before
editing production code. Keep tests' fakes consistent with the current contract;
a test asserting a removed field can preserve the bug.

Run `pnpm check` with Node/pnpm available on PATH. On macOS add
`/opt/homebrew/bin` if needed; on Windows use PowerShell-compatible commands.
Report failures individually. An old platform fixture failure is not evidence
that a new dependency broke the plugin, but the full check is still not green.

Do not rebuild a checkout linked to Desktop while a turn is active. Once turns
finish, build deliberately and fully quit/reopen Desktop. Hot reload alone is
not sufficient validation. Then exercise the smoke list in
[INSTALL.md](../INSTALL.md), including native coexistence, streaming, approval,
questions, plan review, Stop/next turn, resume, sidebar tabs, queue, commands,
worktree preparation, and naming. Record which checks were actually performed.

For UI inspection, Desktop may be launched with `--remote-debugging-port=9222`
after a full quit when debugging is needed. Verify the port is listening;
`DevToolsActivePort` may be stale. Allow session projection to settle, and keep
the page visible when measuring animation-frame-driven DOM updates.

## 6. Leave current evidence

Record exact Desktop/core/SDK versions, installed package path, changed
contracts, automated results, and live checks not performed. Add new service or
CSS assumptions to the existing boot checks when they can be checked reliably.
Keep current guidance at the top and past incidents under dated appendices.

## Appendix: the Desktop 2.0.7 breakages (Host 0.1.5-rc.1)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every spawn failed: `subprocess-local: Windows Job runner exited with exit code 0 before proving its managed range empty` (catalog refresh, turns, git status, everything) | The Host runs in `utilityProcess.fork` with no `ELECTRON_RUN_AS_NODE`; on Windows `subprocess-local` now launches each ordinary target through a helper spawned as `[process.execPath, runner.js]`, which in Electron is `DSH Desktop.exe` -- it started as a second GUI instance, deferred to the running one, and exited 0 with no IPC result. Reproduced outside the plugin with a 20-line script | `src/windows-job-runner.ts` wraps `ctx.subprocess`: sets the flag in `process.env` for exactly the synchronous `spawn()` call and tells the Host to drop it from the target's own environment. All plugin subprocess users go through the one wrapped runtime |
| `SubprocessHandle.pid` gone | Handles are runner-owned; the pid is not exposed | Dropped from the supervisor snapshot |
| Hero draft transfer would not compile | `InputState.imageIds` / `addImages` / `removeImage` became `attachmentIds` / `addAttachments` / `removeAttachment` (attachments now include files) | Renamed |
| A stray ellipsis button in the Claude session header | `dsh-session-log-export` replaced its `sessionLogButton` capsule with a `moreButton` menu | Hide both local names |
| Diff, plan, tasks, and overview panels never appeared; the header toggles did nothing | The `details` column slot is gone. Its replacement is a tabbed right sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`): a panel is a tab *type* declared in `ctx.sidebarRightTabs`, its body registered into `sidebar.right.pane.tab` under the type id, opened per session through `ctx.sidebarRight.openTabIn`. Missed by the slot audit because these four registrations used `slots.register({ name: 'details' })` directly rather than `slots.inject` -- audit both spellings | `src/client/sidebar-tabs.tsx`; the plugin's maximize overlays and details-column resize are gone, the Host's own fullscreen and close take over |

Historical follow-up: Desktop 2.0.10 sets the flag in the runner bootstrap environment. The plugin wrapper remains for old Hosts; see the current baseline above for why upstream repair does not necessarily make the wrapper a no-op.

## Appendix: the Desktop 2.0 breakages, as worked examples

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing rendered at all | `dsh.client.inject` missed the packages owning `slots` and the chat Slots | Added `dsh-client-ui-renderer` + `dsh-client-ui-chat` |
| "Rewind to here" gone | One Session snapshot split in two: `binding.session` kept `running`, chat nodes moved to `uiConversation.binding(id).target('chat')` | Compose both sources |
| Output vanished mid-render | `MarkdownText` replaced optional `codeLabels` with mandatory `labels`, no default; the code-block branch reads `labels.code.copyLabel` | Pass localized labels |
| Status bar ignored the resize divider | `--dsh-conversation-composer-max-width` removed; styles froze on the fallback | Read `--dsh-composer-card-max-width` |
| Overview panel crashed | `sessions` / `workspaces` became class instances; detached `getSnapshot` lost `this` | Bind through closures |

## Appendix: the Desktop 2.0.5 breakages (Host 0.1.2-rc.1)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every Claude session failed before the CLI started: `command catalog refresh failed … Cannot read properties of undefined (reading 'filter')` | `Session.events` getter removed; the log is now read through `snapshotEvents(from?, to?)`, `ownEvents()`, `eventAt(seq)`. Six host-side reads got `undefined`, the first one in `importLegacy` on the spawn path | `agent.session.snapshotEvents()` everywhere; test fakes expose the method, not the property |
| Installer logged `preserving user-modified preset` on every start and the client-module registry rejected the package for resolving from two Loader sources | An older installer had written the route as an absolute Windows path; the legacy check looked for `lib/preset-route.mjs` with forward slashes and never matched the backslashes | Normalize separators before the suffix check |
| "Save prompt" and "Refine prompt" icons stayed disabled with a draft on screen | The composer now renders `conversation.input.left` with empty owner props (`renderSlot(key, {})` instead of `zone`), so `input.draft` was always undefined | Read the draft through the standard `useInput` hook the runner hands every session-scoped entry |

Also in that Host: `SessionHeader.seedLength` is gone (`isSeeded` plus `Session.inheritedEventCount`, and a header still carrying `seedLength` is rejected), `seq` values are branded `SessionSeq` numbers validated as non-negative safe integers, `dsh-user-approval` no longer exports `effectiveApprovalPolicy`, and `MessageSourceMap` lost `coordinator` / `subagent-report` for `agent-message`. The devDependencies now pin `0.1.2-rc.1`, which is published, so `tsc` sees the new `Session` signature; `dsh-client-runtime` stays on `0.1.1-rc.2` because rc.1 was never published for it.
