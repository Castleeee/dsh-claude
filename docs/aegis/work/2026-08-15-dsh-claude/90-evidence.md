# Implement dsh-claude - Evidence

> Historical record. Retained as evidence of the work at its recorded date;
> package versions, file references, pending work, and verification results below
> are not current status or instructions. For current behavior use the
> [maintained architecture reference](../../spec/2026-08-15-dsh-claude-spec.md) and the repository installation/upgrade guides.
> Status clarified on 2026-09-14; the historical body is unchanged.


## 2026-08-15 Final

- `pnpm typecheck`: passed for Host and Client TypeScript projects.
- `pnpm test`: 10 files, 62 tests passed.
- `pnpm build`: Host, preset route, CLI, and browser artifacts emitted under `lib/` without errors.
- `pnpm pack --pack-destination ./dist-pack`: produced `dist-pack/dsh-claude-0.1.0.tgz`.
- Independent security and runtime reviews integrated; all release-blocking findings resolved.
- CLI Doctor resolved local Claude 2.1.233 and reported only coarse auth category.
- Live Agent SDK handshake with explicit local executable succeeded (init + result + usage).
- Profile link succeeded; composed Web profile includes `llm-claude`.
- Managed preset installed at `$DSH_HOME/.agent-presets/claude/`.
- Existing Host at `http://127.0.0.1:56454` predates profile link; Doctor route 404 until Host restart.

## Remaining live checks

After restarting the existing DSH Host:

1. Doctor endpoint and Settings page load.
2. Claude Code CLI preset appears alongside native presets.
3. One DSH-owned Claude turn streams and records activity.
4. Permission reject/allow-once, cancel, reload/resume, and process cleanup are exercised through the real UI.
