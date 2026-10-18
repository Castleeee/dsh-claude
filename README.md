# dsh-claude

## Attention Please
*Recently, Anthropic unexpectedly suspended my account, so maintenance of this plugin may be paused for a while until I get a new account. I apologize for any inconvenience this may cause and appreciate your understanding. If you need to use this plugin, please do not upgrade the Deepseek Harness version for now.*

## 1. Overview

`dsh-claude` runs the locally installed Claude Code CLI as a first-class conversation provider inside DeepSeek Harness (DSH). It uses Claude Code's official Agent SDK protocol instead of recreating the agent with a separate API client.

Claude Code remains responsible for its agent loop, tools, `CLAUDE.md`, Skills, Hooks, Plugins, MCP servers, settings, and authentication. DSH provides the conversation UI, approval and question surfaces, repository workflow, activity presentation, and managed process lifetime.

## 2. Installation and removal

This is a fork. `origin` is `Castleeee/dsh-claude`, and it carries two lines:

- **`master`** — the stable line, and the fork's default branch. Every push or
  merge here runs the checks, packs the plugin and re-cuts the release below, so
  that URL is always the newest stable build.
- **`feature/latest`** — the unstable line. Work in progress lands here and is
  never released.

The package installs from a **built tarball**. There is no other supported route
(see the warning at the end of this section).

### Requirements

- DSH Desktop whose Host is on the **0.2.1-rc.2** package line. This fork's
  development graph follows the Host it actually runs on: every
  `@deepseek-ai/dsh-*` devDependency and its `pnpm-workspace.yaml` override is
  pinned to the version the installed App ships, so `pnpm typecheck` sees the
  API the plugin is loaded against rather than a superseded one. A Host on an
  older line may fail to activate the plugin.
- A local Claude Code installation that is already authenticated.
- Node.js 20 or later, plus pnpm, when building the tarball yourself.

The plugin never asks for or stores Claude credentials. Authenticate through the
local Claude Code CLI before using the plugin.

### Install from the release

Stable builds are published from `master`. This URL is stable across pushes —
the release is re-cut in place, so it always points at the newest stable build:

```sh
dsh plugin --profile desktop add https://github.com/Castleeee/dsh-claude/releases/download/v0.1.65-fork.1/norman-else-dsh-claude-0.1.65-fork.1.tgz
```

### Install a tarball file you were given

```sh
dsh plugin --profile desktop add /absolute/path/to/norman-else-dsh-claude-0.1.65-fork.1.tgz
```

Quit Desktop completely, reopen it, then create a conversation and select
**Claude** from the Agent Preset picker. Substitute your actual profile
(`desktop`, or `web` for a standalone Web installation).

### Install by building the stable line yourself

```sh
git clone https://github.com/Castleeee/dsh-claude.git   # master is the default branch
cd dsh-claude
pnpm install --frozen-lockfile
pnpm check                                   # typecheck + test + build, writes lib/
pnpm pack --pack-destination .
dsh plugin --profile desktop add "$PWD/norman-else-dsh-claude-0.1.65-fork.1.tgz"
```

Then quit Desktop completely, reopen it, and select **Claude** in a new
conversation.

For work on this fork itself, one script switches a profile between the three
install modes — link the checkout while developing, pack it locally, or take the
release asset:

```sh
node scripts/profile-mode.mjs link      # development: edits are live
node scripts/profile-mode.mjs dist
node scripts/profile-mode.mjs release
```

Details, including when a linked checkout is unsafe, are in `INSTALL.md` §7 and
`MAINTENANCE.md`.

> **Install the packed tarball, not a `link:`.** The development graph follows
> the Host line, so a link would resolve the same `@deepseek-ai/*` versions the
> Host already has — today. It stops being true as soon as the App moves ahead:
> the checkout keeps the older devDependencies, Node resolves those ahead of the
> Host's own, the Host judges every public plugin incompatible, and Desktop
> starts with no window and no log at all. Packing is what keeps
> `devDependencies` out of the install, so the tarball route cannot drift this
> way. Background: `MAINTENANCE.md` §5.1.

### Remove the plugin

The Claude preset is declared by the package's bundle patch, so removing the package removes it:

```sh
dsh plugin --profile desktop remove @norman-else/dsh-claude
```

## 3. Features

### 3.1 Conversation

- **Native Claude Code conversations** — Runs Claude Code as the main agent in a normal DSH conversation instead of wrapping it as a tool or secondary chat.
- **Claude preset and model selection** — Adds a `Claude` Agent Preset and exposes Claude Code's `default`, `opus[1m]`, `fable`, `sonnet`, and `haiku` model choices.
- **Thinking effort** — Maps DSH's per-model reasoning effort onto Claude Code's thinking modes — `off`, `low`, `medium`, `high` (Claude Code's own default), `xhigh`, `max`, and `ultracode` — so the conversation's effort control drives extended thinking directly. Models that do not support a mode downgrade silently inside Claude Code; `ultracode` additionally turns on standing dynamic-workflow orchestration and needs an `xhigh`-capable model. Moving between modes that a running process accepts goes through one control request instead of a respawn, so the process and the context it already holds survive the change; the modes that are start-time shapes — thinking off, `ultracode`, and the CLI's own default — still rebuild, and a CLI that refuses the request falls back to the old path.
- **Local Claude environment compatibility** — Preserves the user's existing Claude Code authentication, settings, `CLAUDE.md`, Skills, Hooks, Plugins, tools, and MCP configuration.
- **Real-time streaming and conversation continuity** — Streams Claude responses and tool activity into DSH while retaining multi-turn context and persisted Claude session resume.
- **Live turn state** — While a turn runs, the footer under it says what Claude is doing right now — thinking, working through a tool result, or running a named tool with its clock. It is fed by the CLI's own progress telemetry, travels as a state rather than a transcript row, is never written to disk, and disappears with the turn it describes. Changing reasoning effort mid-turn does not disturb it.
- **Session titles** — Answers DSH's session-title request with a throwaway Haiku turn that runs against the user's own Claude Code settings, so the title is a real summary of the first message. A CLI failure reply is refused rather than accepted: an answer like `Not logged in · Please run /login` is not a title, and rejecting it leaves the session to be titled properly instead of carrying the error text.
- **DSH permissions and questions** — Routes Claude tool permission requests through DSH approvals and Claude clarification prompts through DSH's native question forms.
- **Claude Code permission modes** — Behind a **Permission selector** setting (Plugin, or DSH native to keep the Host's three-mode control and the plain sandbox mapping), replaces DSH's three-mode access selector, for Claude sessions only, with Claude Code's own modes in the same seat of the composer's tool row: Plan, Default, Accept edits, Don't ask, Auto, and Bypass permissions, each with its own glyph, bilingual name, and description; Auto is greyed out while the catalog says the session's model cannot run it, and an ask its classifier escalates reaches the DSH approval dialog with the classifier's reason under the title. The choice is the plugin's own per-session record and is what the next turn runs under; the DSH sandbox mode and approval policy are moved onto the preset that mode is carried on, so approvals and the sandbox follow without the Host learning any new modes. Bypass asks for an acknowledged confirmation first, the control locks while a turn is running, and a sandbox switched natively afterwards (the `/permission` command) wins over the recorded choice, so DSH's own knobs are never contradicted. The Host's selector is hidden with a scoped CSS rule rather than replaced, since it is not a slot; a Host that renames it simply shows both. A new Claude session starts in the **Default permission mode** from this plugin's Settings, Auto unless changed: the DSH access preset is moved onto the sandbox that mode needs as the session is created, so a Host whose own default preset is full access does not turn it into Bypass.
- **Plan review** — Under read-only access Claude works in plan mode, and the plan it hands back is read in a plugin-owned panel in a right-sidebar tab, rendered as Markdown under the prose palette chosen in this plugin's settings. The approval itself stays with DSH: its dialog names the decision and points at the panel instead of pasting the plan into a plain-text modal, and it is asked even under Full access — that setting waives actions, not the decision the plan was written to put in front of the user. Full access silences approvals outright (`approval/policy: never`, answered before any surface is shown), so the ask is un-silenced for as long as the plan is open and the session's own policy is put back afterwards. Approving and rejecting are the only answers the dialog has, and neither is "change this", so the panel adds the third: select a passage, write what should change, and send the plan back — the notes reach Claude as the reason it was refused, and the dialog closes itself. A session that proposes more than once keeps every plan: the panel heading becomes a picker listing each with its own decision, and a fresh proposal awaiting approval takes the panel back. The Session header carries a plan toggle, dotted while a plan is still waiting on its decision, and the turn's tool card carries the same plan.
- **Claude command bridge** — Publishes Claude Code's own command catalog into the DSH command palette, retrying with backoff while a fresh CLI finishes loading Skills and Plugins.
- **Prompt suggestions** — After each turn Claude Code guesses the next prompt; the composer shows it as grey text after whatever has been typed, and Tab (or → at the end of the draft) accepts it. It disappears as soon as the draft stops matching, and when the next turn starts.
- **Prompt snippets** — Keeps the half-written messages a user retypes every day as ordinary Markdown files in `~/.claude/prompts`, one per file, and offers them as a second `/` group beside the Claude command catalog. Picking one drops its text into the composer instead of sending it, so the draft stays editable — a snippet is a message the user finishes, not a command that runs. A control in the composer's own tool row, beside the attach and access controls, saves the current draft as a new snippet: it offers the draft's opening line as the file name and names the file it wrote. With an empty draft the same control lists the saved snippets instead, each deletable after a confirm. It costs the layout nothing — a docked row would move the composer on every keystroke — and an existing name is never overwritten. The derived name is only the starting point: a Claude Haiku call names the snippet properly and replaces it when it lands, unless the user has already started typing, and a failed or slow suggestion is a non-event because a working name was there from the first frame. That call runs with extended thinking off, which is what keeps it around three seconds rather than ten.
- **Rewrite a draft with AI** — A second control in the same tool row hands the current draft to Claude Haiku and replaces it with a version an agent can act on without asking follow-up questions, keeping every concrete detail the original carried. `SessionInput.setDraft` merges into the editor's undo history rather than adding a step to it, so Ctrl/Cmd+Z would not bring the original back: the button holds it instead, and offers it back for as long as the rewrite is still on screen unedited. The rewrite is told to leave every reference to a person as written — asked to rewrite "assign it to me", the model otherwise reaches into Claude Code's ambient context and substitutes the operator's real email address. Editing, renaming, and deleting happen in the user's own editor, and a file added there shows up in the menu without a reload.
- **Message queue and steering** — Accepts further messages while a turn is running, and lets a queued message be edited, removed, or steered into the turn already in flight. Steering reaches the turn the way Claude Code's own does: the message is pushed into the CLI's input stream and read at its next model step, so the turn keeps running with everything it already holds instead of waiting for the end and arriving as a follow-up. The transcript draws it where it arrived, between the work before it and the work after it — DSH's own surface takes one node per turn for this preset, so a message recorded there would sit above everything the turn did and read as the question the whole answer was for. A message with attachments travels the same path an ordinary send takes, and one that arrives with no turn left to steer stays queued for the next one. Plain Enter while a turn runs queues a follow-up unless the Host's busy-Enter setting is set to steer; the queue strip's own steer action always steers. Another plugin can reach the same entry point through the `claudeSteering` service.
- **Rewind** — Drops a message and everything after it: Claude resumes from the kept turn's transcript anchor and genuinely forgets the discarded turns, the discarded rows are hidden from the append-only DSH log, and the original text returns to the composer for editing and resending. Every turn is admitted against a captured working tree, so the same rewind optionally puts the checkout back to where the discarded turns found it — files created since are removed, changed files are restored, and files `.gitignore` covers are left alone.
- **Ask about a selection** — Answers a question about any selected text through a read-only side query limited to `Read`, `Grep`, and `Glob`, reusing the session's model and thinking mode, with the answer copyable or sendable into the main conversation.
- **Redacted activity timeline** — Displays thinking summaries (bounded at 4,000 characters, with the cut marked), tool calls and results, permission events, questions, status changes, usage, errors, and subagent activity without persisting credentials. A configured hook is drawn as one row per invocation, folded from its start to its response so a hook that holds or bends the turn is distinguishable from a slow model; a hook that fails keeps its exit code and its output.
- **Todo lists** — A `TodoWrite` call is drawn as the checklist it is — completed entries struck through, the entry in progress marked — with the collapsed row saying how far through the list the turn is, instead of printing the list as a line of JSON.
- **Selectable AI output renderer** — Draws Claude's output either with this plugin's own transcript (interleaved prose, grouped tool cards, activity rows) or with DSH's native conversation renderer, where prose arrives as ordinary assistant text blocks, thinking as reasoning blocks, and root Claude tools as native tool cards (terminal, diff, search, read). Chosen in Settings and applied from the next turn; the plugin transcript remains the default, and turns already recorded keep the renderer that drew them.
- **Automatic session titles and branch names** — Uses separate one-turn Haiku queries to summarize the first message or worktree intent. Both load `user`, `project`, and `local` settings like the main conversation, including settings-based authentication and behavior configuration. An error result keeps DSH's fallback title or the generated timestamped branch name. These queries do not borrow the main conversation process.
- **Background task tracking** — Claude subagents and background commands appear in DSH's own session-header job list with live output, progress, and a stop button.
- **Agent Team** — Claude Code's implicit team (named agents, the shared task list, and mail between members) gets a session-header roster and a per-teammate conversation tab, mirroring DSH's own Agent Team UI.
- **Context usage** — Collects aggregate context-window usage from Claude Code and shows it on the session board. It does not register a separate context-meter slot beside the model selector.
- **Turn accounting** — Closes each turn the plugin transcript drew with the footer DSH gives only its own messages: tokens, cache hit rate, wall time, time to first token, and cumulative cost. The timings are measured as the turn runs, because activity records carry no clock of their own.
- **Managed process lifecycle** — Keeps one live Claude process per active session, serializes turns, evicts idle processes, queues user turns FIFO when every process slot is busy, converges safely after the limit is lowered, and handles Stop, cancellation, restart, and process-tree cleanup. A cancelled turn keeps its process whenever Claude Code confirms it stopped, so the next prompt continues in that same process instead of respawning and resuming from disk.
- **Bilingual interface** — Ships every user-facing string in both English and Chinese.

### 3.2 Repository, worktrees, and pull requests

- **Repository and worktree preparation** — Lets a user choose a branch before submitting, switch an eligible local branch, or create a dedicated Git worktree and DSH workspace while transferring the current draft and attachments, and reconciles plugin-managed worktrees after their workspace is deleted. That deletion can remove a dirty worktree with `--force`; commit or preserve needed files before deleting the workspace. The separate merged-branch cleanup action requires a clean tree and checks for unpushed commits. New worktrees live under the repository's `.claude/worktrees` (kept out of `git status` through the local `.git/info/exclude`), so with the sidebar set to **Workspace tree** each worktree session shows nested under its repository.
- **Branch picker** — Lists the repository's local and remote-tracking branches, filters them as the user types, and refreshes from the remote on demand so a branch created elsewhere becomes selectable without leaving DSH.
- **Jira-driven sessions** — Connects to Jira Cloud and starts work from a ticket: the branch is named after the ticket key, the composer is seeded with the ticket brief, the ticket is assigned to the user once the worktree exists, and several tickets can be kicked off at once, each in its own worktree session.
- **Repository and pull request status** — Shows the current repository, branch, worktree state, changed-line counts, unpushed commits, GitHub pull request, checks, review state, merge state, and blocking Claude rate limits near the composer.
- **Session board** — Summarizes every Claude session in one place with its run state, branch, pull request, context usage, auto-fix state, and whether it is waiting on an approval or an answer.
- **Session alerts** — Raises a desktop notification when a session the user is not looking at starts waiting on an approval or an answer, or finishes its turn; clicking it brings that session up. The session on screen never raises one, a prompt is announced once, and the whole thing is switched off from Settings.
- **Branch diff viewer** — Provides an expandable or maximized branch diff with file statistics, expand-all and collapse-all, on-demand unmodified context, and comment-to-comment navigation.
- **Line-level review comments** — Records the user's own line or range comments against the diff and attaches them to the next Claude message.
- **GitHub review threads** — Reads, replies to, resolves, and unresolves pull request review threads inline, with `@` completion for repository members, bot authors marked as such, and a link back to the thread on GitHub.
- **Commit, push, merge, and pull request actions** — Supports Commit, Commit & Push, Push, draft pull request creation, and merging a pull request as a merge commit, squash, or rebase, with repository snapshot validation and optional Claude-generated commit messages.
- **Branch updates** — Updates the current branch from its base by rebase (pushed with `--force-with-lease`) or merge, and hands any resulting conflicts to Claude to resolve.
- **Pull request feedback handoff** — Expands failing check details and GitHub pull request comments and hands either of them to Claude as a fix request.
- **Auto fix** — Watches an open pull request for new review comments and failing checks, hands each new batch to Claude to fix, commit, and push, and keeps going until everything passes or the watcher is switched off.
- **Merged branch cleanup** — Removes the worktree and local branch, archives the workspace's sessions, and deletes the workspace; a plain checkout instead returns to the base branch and deletes the merged branch.

### 3.3 Diagnostics, settings, and updates

- **Claude Code settings and Doctor** — Adds a Settings panel for runtime diagnostics, supported Claude settings, output style, AI output renderer, session alerts, worktree branch prefix, process limits, and authentication and handshake status.
- **Plan usage** — Reports the signed-in subscription's utilization windows — five-hour, weekly across all models, and weekly per model — with reset countdowns, degrading to unavailable rather than failing on API-key, Bedrock, and Vertex sessions.
- **Bounded requests and a rationed connection pool** — Caps the plugin's share of the browser's per-origin connections so its own panels can never starve each other or the Host, and gives every route a declared time budget — answers from memory, local Git work, and calls that reach the network each get their own — with the client waiting one round trip longer than the server, so a slow operation reports which budget elapsed instead of hanging in the browser's queue.
- **Plugin updates** — Checks npm for new releases and updates in place, only when the installation is uniquely identified; local development links are never replaced.
- **Declared Claude preset** — The bundle patch declares the Claude preset as an `@deepseek-ai/dsh-agent-preset` row; its route reuses the active profile package source, so no second client-module Loader appears.

## 4. Contributing

### 4.1 The two contribution types

Every contribution to this repository is exactly one of two types. There is no third type.

| Type | Means | Examples |
| --- | --- | --- |
| `feature` | Behavior that does not exist yet | A new composer action, a new Settings field, support for a new Claude Code capability, a documented behavior that was never written down |
| `fix` | Behavior that already exists but is wrong | A crashing slot entry, a wrong token count, a preset that stops being discovered after a Desktop upgrade, a README statement that no longer matches the code |

Refactors, dependency bumps, test-only changes, and documentation edits are not separate types. File them as the type that matches their purpose: something that is wrong today is a `fix`, something that does not exist today is a `feature`. If you cannot decide which one applies, that is a signal the issue is not scoped yet — open it as a question first and let the maintainer classify it.

### 4.2 Required flow

An issue always comes first. Pull requests that arrive without one are closed unreviewed, regardless of the quality of the code.

1. **Search existing issues.** If your problem or idea is already filed, comment there instead of opening a duplicate.
2. **Open an issue** at https://github.com/Norman-else/dsh-claude/issues/new/choose and pick the **Feature** or **Fix** form. Choosing the form is how you declare the type: it sets the `[feature]` / `[fix]` title prefix and the matching label for you. Every field listed in §4.3 is required by the form, so an issue that does not explain why it is needed or in what environment it happens cannot be submitted. Blank issues are disabled — if you genuinely cannot tell which type applies, use the "Not sure whether it is a feature or a fix" link on that page and let the maintainer classify it rather than guessing a type to get past the form.
3. **Wait for the issue to be accepted.** The maintainer confirms the type, the scope, and whether the change belongs in this plugin at all — several things that look like plugin bugs are DSH Host or Claude Code CLI behavior. Do not start implementation before this. Work done on a rejected issue cannot be merged.
4. **Branch from `master`** using `feature/<issue-number>-<short-slug>` or `fix/<issue-number>-<short-slug>`.
5. **Implement and verify** against the rules in §4.4.
6. **Open a pull request** that declares its type and links its issue (§4.5).
7. **Address review.** The maintainer reviews and approves; the maintainer merges. Contributors do not merge their own pull requests.

`master` is protected: direct pushes, force pushes, and branch deletion are blocked, and a pull request needs one approving review before it can merge. Pushing new commits to a pull request dismisses any existing approval, so expect to request review again after changes.

### 4.3 What the issue must contain

Both types require enough detail for someone else to reproduce your situation without asking you follow-up questions.

**A `feature` issue must state:**

- **Motivation** — what a DSH user cannot do today, and why the current workaround is not good enough.
- **Proposed behavior** — what should happen, described from the user's side, naming the surface it belongs to (composer, hero repository controls, diff panel, activity timeline, Settings panel, Agent Preset picker, …).
- **Scope and non-goals** — what this explicitly does not cover, so the pull request can be reviewed against a fixed boundary.
- **Affected layer** — plugin server (`src/`), client (`src/client/`), bundle patch and preset declaration (`cordis.patch.yml`), or a combination.
- **Compatibility** — the DSH Desktop and DSH package line it targets, and the Claude Code CLI version it relies on. Say so if it depends on a Claude Code capability that older CLI versions do not have.
- **Alternatives considered** — including "do nothing", and why they were rejected.
- **Whether you intend to implement it** — so the maintainer knows whether to assign it to you or to schedule it.

**A `fix` issue must state:**

- **Expected behavior vs. actual behavior** — two separate sentences, not one combined complaint.
- **Reproduction steps** — numbered, minimal, and starting from a clean state. Say whether it reproduces every time or intermittently.
- **Environment** — plugin version (the `version` field in `package.json`, or the version DSH shows), DSH Desktop version, Claude Code CLI version, operating system, and Node.js version if you installed from source.
- **Evidence** — the relevant redacted log lines, activity-timeline excerpt, or screenshot. Boot and slot failures surface in the DSH log as `dsh-claude client [boot-check]` and `[slot-entry-crashed]`; include those lines when the plugin fails to load.
- **Regression range** — the last plugin or DSH Desktop version where it worked, if you know it.

**Redact before you post.** Never paste Claude credentials, API keys, session tokens, private repository contents, or customer data into an issue, a pull request, a test fixture, or a log excerpt. This applies to attachments and screenshots as well. The plugin never asks for or stores Claude credentials, and neither should its issue tracker.

### 4.4 Rules for the change itself

- **Stay out-of-tree.** Use only public DSH exports. Never patch the installed DSH checkout, and never depend on DSH internals that are not exported.
- **Respect the ownership split.** Claude Code owns its agent loop and tools; this plugin owns presentation, approval and question surfaces, and managed process lifetime. Changes that re-implement Claude Code behavior inside the plugin will be rejected.
- **After a DSH Desktop upgrade**, re-check the Host's own API by hand: it ships no type declarations, so `pnpm typecheck` cannot see drift. Compare against the installed `resources/app/node_modules/@deepseek-ai/` packages and watch the log for `dsh-claude client [boot-check]` and `[slot-entry-crashed]`.
- **Never log, persist, render, or test with real credentials.** Redact before any durable event append.
- **Run `pnpm check`** — typecheck for both tsconfigs, the Vitest suite, and the build — and make sure it passes before you open the pull request. Do not claim a change works without it.
- **Cover behavior with tests** where the change is testable. A `fix` should come with a test that fails before the change and passes after it.
- **Keep one type per branch.** Do not mix a feature and a fix in the same pull request, even if you found them together — open two issues and two pull requests.
- **Leave releases alone.** Do not bump `version` in `package.json`, edit `scripts/publish.mjs`, or publish. Releases are maintainer-only via `pnpm release`.
- **Write commit subjects in the repository's existing style**: imperative mood, describing the intent rather than the mechanics, no `feat:` / `fix:` prefixes. See `git log` for the established pattern — for example, `Report the whole turn's output tokens, not the last call's`.

### 4.5 Pull request requirements

Open the pull request against `master` and include all of the following:

- **A `Type:` line as the first line of the description** — either `Type: feature` or `Type: fix`. This is how the contribution type is declared; a pull request without it is not reviewed.
- **A closing reference to its issue** — `Closes #<issue-number>`. A pull request that closes no issue does not get merged.
- **The matching label** — `feature` or `fix`, the same one carried by the issue.
- **What changed and how you verified it** — including the `pnpm check` result, and the manual verification you performed in DSH Desktop for anything that touches the UI or the process lifecycle.
- **A README update** when the change adds or alters user-visible behavior. New features belong in the Features list in §3.

The type is declared through the label and the `Type:` line rather than a title prefix so that squashed commit subjects stay in the repository's plain imperative style.

### 4.6 What gets rejected

- A pull request with no accepted issue behind it, or with no declared type.
- A feature and a fix bundled into one pull request.
- Changes that patch DSH, reach into non-public DSH APIs, or re-implement Claude Code's agent loop.
- A failing or unrun `pnpm check`.
- Anything that logs, persists, or renders credentials, including in tests and fixtures.
- Version bumps, release script edits, or publish attempts from a contribution branch.
