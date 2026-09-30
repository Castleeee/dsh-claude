import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeLiveProgress, ClaudeTaskInfo } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeTurnMarker } from './conversation-sidecar.ts'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { summarizeTurnTasks, tasksForTurn } from './ClaudeTasksPanel.tsx'
import { ClaudeTurnUsage, formatTurnDuration } from './ClaudeActivityNode.tsx'
import { ClaudeTurnChanges } from './ClaudeTurnChanges.tsx'
import { latestTurnUsage, selectClaudeTurn } from './conversation-sidecar.ts'
import * as styles from './styles.ts'

const MAX_HOVER_TASKS = 6
const EMPTY_TASKS: readonly ClaudeTaskInfo[] = []

/** What the Host's `turnTail` slot injects.
 *
 *  Host 0.1.7 renders that slot as a plain list and hands only the owner props,
 *  so this is the whole of what a registration can add. The session and the
 *  tasks opener arrive through {@link ClaudeActivityTailBridge} instead. */
export interface ClaudeActivityTailInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

/** What the footer itself needs: the injected copy plus the two things the
 *  bridge supplies for the turn being drawn. */
export interface ClaudeTurnFooterInjected extends ClaudeActivityTailInjected {
  /**
   * The session whose turn this footer closes. Optional because the footer is
   * also drawn where no rewind route is at hand; the changed-files card is the
   * only part that needs it, and it is skipped when it is absent.
   */
  sessionId?: string
  openTasks: (turn: number) => void
}

/** How the tail reaches the session it belongs to.
 *
 *  Host 0.1.7 renders `conversation.chat.turnTail` as a plain list slot: it
 *  hands the owner props (`turn`) and nothing else, and no longer supports a
 *  `select` that would have matched the turn for us. The session id and the
 *  "open the tasks panel" action are registered once by `index.tsx`, so the
 *  tail can still draw the changed-files card and the task launcher. */
export interface ClaudeActivityTailBridge {
  sessionIdFor(turn: number): string | undefined
  openTasks(turn: number): void
}

let bridge: ClaudeActivityTailBridge | undefined

/** Install the bridge `index.tsx` builds around its own slot context. */
export function setClaudeActivityTailBridge(next: ClaudeActivityTailBridge | undefined): void {
  bridge = next
}

export interface ClaudeActivityTailProps extends ClaudeActivityTailInjected, Pick<TurnTailOwnerProps, 'turn'> {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

export interface ClaudeTaskLauncherProps extends ClaudeTurnFooterInjected {
  turn: number
  tasks: readonly ClaudeTaskInfo[]
}

export interface ClaudeTurnFooterProps extends ClaudeTurnFooterInjected {
  turn: number
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

function taskGlyph(status: ClaudeTaskInfo['status']): { glyph: string; style: CSSProperties } {
  if (status === 'failed') return { glyph: '×', style: styles.tasksHoverGlyphError }
  if (status === 'completed') return { glyph: '✓', style: styles.tasksHoverGlyphDone }
  return { glyph: '●', style: styles.tasksHoverGlyphRunning }
}

export function ClaudeTaskLauncher({ turn, tasks, t, openTasks }: ClaudeTaskLauncherProps) {
  const [hovered, setHovered] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const turnTasks = useMemo(() => tasksForTurn(tasks, turn), [tasks, turn])
  const summary = useMemo(() => summarizeTurnTasks(turnTasks), [turnTasks])
  const open = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = undefined
    setHovered(true)
  }
  const scheduleClose = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setHovered(false)
    }, 350)
  }
  useEffect(() => () => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
  }, [])
  if (summary === undefined) return null
  const label = summary.state === 'running'
    ? t('tasksTurnRunning', { count: summary.running })
    : summary.state === 'failed'
      ? t('tasksTurnFailed', { failed: summary.failed, completed: summary.completed })
      : t('tasksTurnCompleted', { count: summary.completed })
  const stateStyle = summary.state === 'completed' ? styles.tasksBadgeDone : {}
  const dotStyle = summary.state === 'failed'
    ? styles.tasksBadgeDotError
    : summary.state === 'completed' ? styles.tasksBadgeDotDone : {}
  return (
    <div data-claude-task-launcher={turn} style={styles.tasksBadgeWrap}>
      <span
        style={styles.tasksBadgeSeat}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        onFocus={open}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose()
        }}
      >
        {hovered ? (
          <span role="tooltip" style={styles.tasksHoverCard} onMouseEnter={open} onMouseLeave={scheduleClose}>
            <span style={styles.tasksHoverHeader}>{label}</span>
            {turnTasks.slice(0, MAX_HOVER_TASKS).map(task => {
              const { glyph, style } = taskGlyph(task.status)
              return (
                <span key={task.taskId} style={styles.tasksHoverRow}>
                  <span className={task.status === 'running' ? 'dsh-claude-act-running' : undefined} style={{ ...styles.tasksHoverGlyph, ...style }} aria-hidden="true">{glyph}</span>
                  <span style={styles.tasksHoverDesc} title={task.description}>{task.description}</span>
                  {task.subagentType === undefined ? null : <span style={styles.tasksHoverType}>{task.subagentType}</span>}
                </span>
              )
            })}
            {turnTasks.length > MAX_HOVER_TASKS ? <span style={styles.tasksHoverMore}>+{turnTasks.length - MAX_HOVER_TASKS}</span> : null}
            <span style={styles.tasksHoverHint}>{t('tasksOpen')}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="dsh-claude-task-launcher"
          style={{ ...styles.tasksTurnBadge, ...stateStyle, ...(hovered ? styles.tasksBadgeHovered : {}) }}
          aria-label={`${label} — ${t('tasksOpen')}`}
          onClick={() => openTasks(turn)}
        >
          <span
            className={summary.state === 'running' ? 'dsh-claude-act-running' : undefined}
            style={{ ...styles.tasksBadgeDot, ...dotStyle }}
            aria-hidden="true"
          />
          <span style={styles.tasksBadgeLabel}>{label}</span>
        </button>
      </span>
    </div>
  )
}

/** What the running turn is doing, right now.
 *
 *  A turn that is thinking hard or sitting in a long tool call produces no rows
 *  at all — the transcript only moves when something finishes. This is the one
 *  thing that moves: the same state the CLI's own status line shows, fed by the
 *  telemetry frames the activity log deliberately keeps out. It is not
 *  persisted, and the turn it belongs to is the only one that draws it. */
export function ClaudeLivePill({ live, t }: { live: ClaudeLiveProgress; t: ClaudeActivityTailInjected['t'] }) {
  const label = live.state === 'tool'
    ? t('liveTool', { tool: live.label ?? t('liveToolUnknown') })
    : live.state === 'waiting'
      ? t('liveWaiting')
      : live.state === 'compacting' ? t('liveCompacting') : t('liveThinking')
  return (
    <div style={styles.tasksBadgeWrap} data-claude-live={live.state}>
      <span style={styles.livePill}>
        <span className="dsh-claude-act-running" style={styles.livePillDot} aria-hidden="true" />
        <span>{label}</span>
        {live.elapsedMs === undefined || live.elapsedMs < 1_000
          ? null
          : <span style={styles.livePillElapsed}>{formatTurnDuration(live.elapsedMs)}</span>}
      </span>
    </div>
  )
}

/** Everything that closes a turn, in the order it reads: what the turn is
 *  still doing, then what it cost, then the files it changed.
 *
 *  The changed-files card belongs to this tail rather than to the profile's
 *  generic one: Claude's tool arguments reach the browser truncated, so the
 *  only trustworthy account of what the turn touched comes from Claude Code's
 *  own checkpointing — a route this plugin owns. */
export function ClaudeTurnFooter({ turn, sessionId, useClaudeProjection, t, openTasks }: ClaudeTurnFooterProps) {
  const tasks = useClaudeProjection(value => value.tasks?.tasks ?? EMPTY_TASKS)
  const usage = useClaudeProjection(value => latestTurnUsage(value.activities, turn))
  // Only the turn the state names draws it: one live value serves the session,
  // and every settled turn's footer is still mounted.
  const live = useClaudeProjection(value => value.live?.turn === turn ? value.live : undefined)
  return (
    <>
      {live === undefined ? null : <ClaudeLivePill live={live} t={t} />}
      <ClaudeTaskLauncher turn={turn} tasks={tasks} t={t} openTasks={openTasks} />
      {usage === undefined ? null : <ClaudeTurnUsage usage={usage} t={t} />}
      {sessionId === undefined ? null : <ClaudeTurnChanges sessionId={sessionId} turn={turn} settled={live === undefined} />}
    </>
  )
}

/** What this tail draws for one turn, or null when the turn is not Claude's.
 *
 *  The slot no longer selects for us, so the marker is resolved here from the
 *  turn the Host handed down — the same `selectClaudeTurn` the old `select`
 *  option called. */
export function ClaudeActivityTail({ turn, useClaudeProjection, t }: ClaudeActivityTailProps) {
  const matched = selectClaudeTurn({ turn })
  if (matched === null) return null
  const sessionId = bridge?.sessionIdFor(matched.turn)
  return (
    <ClaudeTurnFooter
      turn={matched.turn}
      useClaudeProjection={useClaudeProjection}
      t={t}
      openTasks={turnToOpen => bridge?.openTasks(turnToOpen)}
      {...(sessionId === undefined ? {} : { sessionId })}
    />
  )
}
