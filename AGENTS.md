# Repository Instructions

- This fork has exactly two jobs: follow `upstream/master`, and keep the fork's own features working. The merge procedure and the must-keep list live in `UPSTREAM-MERGE-NOTES.md`.
- Keep this package out-of-tree: use only public DSH exports and do not patch the installed DSH checkout.
- After a DSH Desktop upgrade, re-check the Host's own API by hand: it ships no type declarations, so `pnpm typecheck` cannot see drift. Locate the installed Host under `resources/app/node_modules/@deepseek-ai/` (or an extracted `app.asar`) and check the log for `dsh-claude client [boot-check]` / `[slot-entry-crashed]`.
- Claude Code owns its internal loop and tools; DSH owns presentation, approval audit, and managed process lifetime.
- Never log, persist, render, or test with real credentials. Redact before durable event append.
- Run `pnpm check` before claiming completion; on macOS prepend `/opt/homebrew/bin` to PATH if needed. Install the plugin as a packed tarball, never `link:` (see `README.md` §2), and build in a separate source copy while Desktop is running turns — a build can trigger a live client reload. Report any failing checks explicitly.
