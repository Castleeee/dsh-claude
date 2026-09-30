/**
 * File-rewind route: a thin pass-through to Claude Code's own checkpointing.
 *
 * Claude Code keeps a copy of every file immediately before it modifies it, and
 * the SDK exposes that store as `rewindFiles(userMessageId, { dryRun })`. This
 * route forwards to it and returns what the CLI answered, adding no
 * interpretation of its own.
 *
 * ## Why this is a pass-through and not a reconstruction
 *
 * DSH observes a turn through the event feed, and a tool call's arguments reach
 * the browser truncated at 4,000 characters and with secret-shaped text
 * redacted. Rebuilding a file from those arguments would therefore restore the
 * wrong content in exactly the large edits where a rewind matters most. Claude
 * Code's own store holds the real bytes, so the only correct thing this side
 * can do is ask it.
 *
 * ## What the caller may rely on
 *
 * The response is the SDK's `RewindFilesResult`, reported as-is: `canRewind`,
 * an optional `error`, and — on a real rewind — `filesChanged`, `insertions`,
 * `deletions`, and `skippedLinks`. A `dryRun` reports the same shape without
 * writing anything, which is what lets a caller show a preview before
 * committing.
 *
 * The one thing this route adds is a guard the SDK cannot make for itself: a
 * turn that is still editing the tree must not be rewound underneath, so a
 * session with a running turn is refused with `busy` rather than racing.
 *
 * @module dsh-claude/file-rewind-routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_FILE_REWIND_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import type { ClaudeRewindOutcome } from './supervisor.ts'

const MAX_BODY_BYTES = 4 * 1024
const MAX_SESSION_ID_CHARS = 1_024

export interface ClaudeFileRewindAccess {
  /** Whether this session is one this plugin owns. */
  owns: (sessionId: string) => boolean
  /** Ask Claude Code to rewind the files of one turn, or to report what a
   *  rewind would do. The turn is the caller's unit; resolving it to the user
   *  message uuid Claude addresses by is this side's job. */
  rewind: (
    sessionId: string,
    turn: number,
    options: { dryRun?: boolean },
  ) => Promise<ClaudeRewindOutcome>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** An oversized body fails the same field checks as a missing one; only
 *  malformed JSON is worth reporting separately. */
async function readJson(io: PluginRouteIo): Promise<Record<string, unknown> | undefined> {
  try {
    return record(await io.body<unknown>(MAX_BODY_BYTES))
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    return undefined
  }
}

/**
 * `POST <path>` with `{ sessionId, turn, dryRun? }`.
 *
 * Answers `200` with the SDK result whenever the CLI produced one — including
 * `canRewind: false`, which is an answer about the target rather than a failure
 * of the request. `409` is reserved for the cases where no answer exists:
 * a session that is not ours, one whose turn is still running, or a turn that
 * names no rewind target.
 */
export function registerClaudeFileRewindRoute(
  ctx: Context,
  access: ClaudeFileRewindAccess,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_FILE_REWIND_PATH,
    methods: ['POST'],
    // The CLI does the work; this route only waits for it.
    budget: 'git',
    handler: async io => {
      try {
        const input = await readJson(io)
        const sessionId = input?.sessionId
        const turn = input?.turn
        const dryRun = input?.dryRun

        if (typeof sessionId !== 'string' || sessionId.length === 0
          || sessionId.length > MAX_SESSION_ID_CHARS
          || !Number.isSafeInteger(turn) || (turn as number) < 1
          || (dryRun !== undefined && typeof dryRun !== 'boolean')) {
          return { status: 400, value: { error: 'invalid-request' } }
        }
        if (!access.owns(sessionId)) {
          return { status: 409, value: { error: 'session-unavailable' } }
        }

        const outcome = await access.rewind(sessionId, turn as number, dryRun === true ? { dryRun: true } : {})
        switch (outcome.status) {
          case 'ok':
            return { status: 200, value: { ...outcome.result } }
          case 'busy':
            return { status: 409, value: { error: 'session-busy' } }
          case 'unavailable':
            return { status: 409, value: { error: 'session-unavailable' } }
          // A turn with no recorded prompt uuid is a definite answer: there is
          // no target to rewind, so the caller should say so rather than retry.
          case 'no-target':
            return { status: 409, value: { error: 'no-rewind-target' } }
          default:
            return { status: 500, value: { error: 'rewind-failed', message: outcome.message } }
        }
      } catch (error) {
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'rewind-unavailable' } }
      }
    },
  })
}
