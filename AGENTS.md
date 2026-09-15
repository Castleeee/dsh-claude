# Repository Instructions

- Read `docs/aegis/spec/2026-08-15-dsh-claude-spec.md` before changing runtime behavior. Dated implementation plans are historical; consult a task-specific plan only when one is active. See `docs/aegis/INDEX.md` for document status.
- Keep this package out-of-tree: use only public DSH exports and do not patch the installed DSH checkout.
- After a DSH Desktop upgrade, follow `docs/upgrading-dsh-desktop.md`. The Host ships no type declarations, so `pnpm typecheck` cannot see its API drift: locate the installed Host under `resources/app/node_modules/@deepseek-ai/`, the older unpacked directory, or an extracted `app.asar` as described in the runbook and check the log for `dsh-claude client [boot-check]` / `[slot-entry-crashed]`.
- Claude Code owns its internal loop and tools; DSH owns presentation, approval audit, and managed process lifetime.
- Never log, persist, render, or test with real credentials. Redact before durable event append.
- Run `pnpm check` before claiming completion; on macOS prepend `/opt/homebrew/bin` to PATH if needed. For a linked checkout with active Desktop turns, run the build in a separate source copy to avoid hot reload, and report any failing checks explicitly.
