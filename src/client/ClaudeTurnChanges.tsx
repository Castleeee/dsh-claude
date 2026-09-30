import { useEffect, useState, type ReactNode } from 'react'
import { pluginWrite, PluginRequestError } from './plugin-transport.ts'

/**
 * The changed-files card for one Claude turn.
 *
 * ## Why the numbers come from Claude Code and not from the event feed
 *
 * DSH observes a turn through its event feed, and a tool call's arguments reach
 * the browser truncated at 4,000 characters and with secret-shaped text
 * redacted. A diff rebuilt from those arguments would therefore be wrong in
 * exactly the large edits where it matters. Claude Code keeps a real copy of
 * every file it is about to modify, and its own `rewindFiles` dry run reports
 * what a rewind would restore — so this card asks it instead of reconstructing
 * anything. That is the whole reason this half lives in the Claude plugin: the
 * route is its own, and no other plugin can call it.
 *
 * ## When it renders nothing
 *
 * A turn whose dry run fails, or reports no files, draws NOTHING — not a card
 * holding an explanation. The earlier version rendered a one-line "no snapshot
 * for this turn" card for every non-200 answer, which meant every Claude turn
 * that could not be rewound grew a permanent row of noise in the transcript.
 * A reader who wants the reason can press 撤销 when the turn does have files;
 * an empty turn stays empty.
 *
 * ## After a rewind
 *
 * The card keeps the file list and stop offering the action, because it
 * describes what happened rather than pretending the turn never did.
 */

const REWIND_PATH = '/plugins/dsh-claude/rewind/files'

/** One dry run's answer, or the refusal that replaced it. */
interface RewindPreview {
  status: number
  payload: Record<string, unknown> | null
}

const CSS = `
.dshClaudeTurnChanges{display:flex;flex-direction:column;gap:0;margin-top:12px;
  border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1,transparent)}
.dshClaudeTurnChangesHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:11px 14px}
.dshClaudeTurnChangesHeadMain{display:flex;align-items:center;gap:8px;min-width:0}
.dshClaudeTurnChangesIcon{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.dshClaudeTurnChangesTitle{display:flex;align-items:baseline;gap:10px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshClaudeTurnChangesTotals{display:flex;gap:6px;font-size:12px;font-variant-numeric:tabular-nums}
.dshClaudeTurnChangesAdd{color:var(--dsw-alias-state-success-primary)}
.dshClaudeTurnChangesDel{color:var(--dsw-alias-state-error-primary)}
.dshClaudeTurnChangesActions{display:flex;align-items:center;gap:8px}
.dshClaudeTurnChangesAction{font:inherit;font-size:12px;padding:3px 10px;border-radius:8px;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary)}
.dshClaudeTurnChangesAction:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);
  border-color:var(--dsw-alias-state-error-primary)}
.dshClaudeTurnChangesAction:disabled{cursor:default;color:var(--dsw-alias-label-dimmed)}
.dshClaudeTurnChangesMark{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.dshClaudeTurnChangesList{margin:0;padding:0;list-style:none;border-top:1px solid var(--dsw-alias-border-l1)}
.dshClaudeTurnChangesList>li+li{border-top:1px solid var(--dsw-alias-border-l1)}
.dshClaudeTurnChangesRow{display:flex;align-items:center;padding:9px 14px}
.dshClaudeTurnChangesPath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;
  color:var(--dsw-alias-label-primary)}
.dshClaudeTurnChangesNote{padding:9px 14px;font-size:12px;color:var(--dsw-alias-label-secondary)}
`

/**
 * Ask Claude Code what a rewind of this turn would do, or do it.
 *
 * Through the shared transport, like every other call this client makes: a
 * rewind runs Git work inside Claude Code, so the route declares the `git`
 * budget and the transport enforces it. A refusal arrives as a typed failure
 * whose `code` is the route's own `error` field, which is what the caller turns
 * into a sentence.
 */
async function postRewind(sessionId: string, turn: number, dryRun: boolean): Promise<RewindPreview> {
  try {
    const payload = await pluginWrite<Record<string, unknown>>(REWIND_PATH, 'git', undefined, {
      json: { sessionId, turn, ...(dryRun ? { dryRun: true } : {}) },
    })
    return { status: 200, payload }
  } catch (error) {
    if (error instanceof PluginRequestError) {
      const status = error.status ?? 0
      return {
        status,
        payload: {
          ...(error.code === undefined ? {} : { error: error.code }),
          message: error.message,
        },
      }
    }
    throw error
  }
}

/** Turn a refused rewind into a sentence the reader can act on. */
function explain(status: number, payload: Record<string, unknown> | null): string {
  const error = payload?.error
  if (error === 'session-busy') return '会话正在运行，等这一轮结束后再试'
  if (error === 'session-unavailable') return '该会话当前不可用'
  if (error === 'no-rewind-target') return '这一轮没有记录可回退的消息（可能是回退后重放，或 Claude 未处理该消息）'
  if (error === 'rewind-failed') {
    const message = typeof payload?.message === 'string' ? payload.message : '未知原因'
    return `Claude 回退失败：${message}`
  }
  if (status === 404) return 'dsh-claude 未提供文件回退接口'
  return typeof error === 'string' ? error : `回退失败（${String(status)}）`
}

function ChangesIcon(): ReactNode {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 1.5h6.5L13 5v3.2M3 1.5A1.5 1.5 0 0 0 1.5 3v10A1.5 1.5 0 0 0 3 14.5h4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 1.7V5h3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export interface ClaudeTurnChangesProps {
  sessionId: string
  turn: number
  /**
   * Whether this turn has finished. A running turn's card would sit under a
   * message that is still being written, and its dry run would answer about a
   * tree Claude is still editing — so an unfinished turn draws nothing and asks
   * nothing.
   */
  settled: boolean
}


/** What the card is allowed to show, given one dry run's answer. */
export interface RewindCardModel {
  /** Whether the card draws at all. */
  visible: boolean
  files: string[]
  add: number
  remove: number
  canRewind: boolean
}

/**
 * Decide what a dry run's answer means for the card.
 *
 * Separated from the component so the rule can be tested without a DOM: a
 * refused or empty answer must draw NOTHING. The version this replaces drew a
 * one-line card for every non-200 reply, which put a permanent row of
 * "no snapshot for this turn" under every Claude turn that could not be
 * rewound.
 */
export function rewindCardModel(preview: RewindPreview | undefined): RewindCardModel {
  if (preview === undefined || preview.status !== 200) {
    return { visible: false, files: [], add: 0, remove: 0, canRewind: false }
  }
  const result = preview.payload
  const files = Array.isArray(result?.filesChanged)
    ? result.filesChanged.filter((file): file is string => typeof file === 'string')
    : []
  const add = typeof result?.insertions === 'number' && Number.isSafeInteger(result.insertions) ? result.insertions : 0
  const remove = typeof result?.deletions === 'number' && Number.isSafeInteger(result.deletions) ? result.deletions : 0
  return {
    visible: files.length > 0,
    files,
    add,
    remove,
    canRewind: result?.canRewind === true && files.length > 0,
  }
}

export function ClaudeTurnChanges({ sessionId, turn, settled }: ClaudeTurnChangesProps) {
  const [preview, setPreview] = useState<RewindPreview | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  /**
   * The files a successful rewind actually restored. Kept apart from the
   * preview because the two disagree afterwards: the preview describes the
   * state the files were in, this describes the state they are in now.
   */
  const [reverted, setReverted] = useState<{ files: string[]; skipped: number } | undefined>(undefined)

  // A settled turn's rewind target does not move, so the dry run is asked once.
  useEffect(() => {
    let live = true
    if (!settled || !Number.isSafeInteger(turn)) return () => { live = false }
    void postRewind(sessionId, turn, true).then((answer) => {
      if (live) setPreview(answer)
    })
    return () => { live = false }
  }, [sessionId, turn, settled])

  const model = settled ? rewindCardModel(preview) : { visible: false, files: [], add: 0, remove: 0, canRewind: false }
  const { files, add, remove, canRewind } = model

  async function doRewind(): Promise<void> {
    const lines = files.map((file) => `  ${file}`).join('\n')
    if (!window.confirm(`让 Claude Code 把这些文件回退到该消息之前的状态？\n\n${lines}\n\n这会丢弃该消息之后的所有文件改动。`)) return

    setBusy(true)
    setMessage('')
    try {
      const answer = await postRewind(sessionId, turn, false)
      if (answer.status === 200 && answer.payload?.canRewind === true) {
        const restored = Array.isArray(answer.payload.filesChanged)
          ? answer.payload.filesChanged.filter((file): file is string => typeof file === 'string')
          : []
        const skipped = typeof answer.payload.skippedLinks === 'number' && Number.isSafeInteger(answer.payload.skippedLinks)
          ? answer.payload.skippedLinks
          : 0
        setReverted({ files: restored.length > 0 ? restored : files, skipped })
        // A skipped link is the one outcome worth naming: the rewind landed, but
        // not every tracked path was safe to restore, and silence would let the
        // reader believe the tree matched the message.
        setMessage(skipped > 0 ? `${String(skipped)} 个文件因链接安全未回退` : '')
      } else {
        setMessage(explain(answer.status, answer.payload))
      }
    } catch (error) {
      setMessage(`回退请求失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  // Nothing to draw until the dry run lands; nothing to draw when it found no
  // files, or when the turn has no rewind target at all. An empty row inside the
  // transcript is noise, not information.
  if (!model.visible && reverted === undefined) return null

  const isReverted = reverted !== undefined

  return (
    <div className="dshClaudeTurnChanges">
      <style data-dsh-claude-turn-changes>{CSS}</style>
      <div className="dshClaudeTurnChangesHead">
        <div className="dshClaudeTurnChangesHeadMain">
          <span className="dshClaudeTurnChangesIcon"><ChangesIcon /></span>
          <span className="dshClaudeTurnChangesTitle">
            <span>{isReverted ? `已回退 ${String(files.length)} 个文件` : `已编辑 ${String(files.length)} 个文件`}</span>
            <span className="dshClaudeTurnChangesTotals">
              <span className="dshClaudeTurnChangesAdd">{`+${String(add)}`}</span>
              <span className="dshClaudeTurnChangesDel">{`-${String(remove)}`}</span>
            </span>
          </span>
        </div>
        <div className="dshClaudeTurnChangesActions">
          {isReverted
            ? <span className="dshClaudeTurnChangesMark">✓ 已回退</span>
            : (
              <button
                type="button"
                className="dshClaudeTurnChangesAction"
                disabled={busy || !canRewind}
                title={canRewind ? '让 Claude Code 回退这些文件' : 'Claude 没有为该消息保留可回退的快照'}
                onClick={() => { void doRewind() }}
              >
                撤销
              </button>
            )}
        </div>
      </div>
      <ul className="dshClaudeTurnChangesList">
        {files.map(file => (
          <li className="dshClaudeTurnChangesRow" key={file}>
            <span className="dshClaudeTurnChangesPath" title={file}>{file}</span>
          </li>
        ))}
      </ul>
      {message === ''
        ? null
        : <div className="dshClaudeTurnChangesNote">{message}</div>}
      {!canRewind && !isReverted && message === ''
        ? (
          <div className="dshClaudeTurnChangesNote">
            Claude Code 没有为这一轮保留文件快照（可能是回退后重放，或该轮没有修改文件），因此无法回退。
          </div>
        )
        : null}
    </div>
  )
}
