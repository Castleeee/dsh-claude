import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconDatabaseOutline16, IconGaugeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import { claudeSessionStats, formatCacheHitPercent, formatExactTokens, formatSeconds, formatTokens, formatTokensPerSecond, type ClaudeSessionStats } from './claude-session-stats.ts'
import { useClaudeSessionMark } from './session-mark.ts'

export interface ClaudeStatsPillsInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

export interface ClaudeStatsPillsProps extends ClaudeStatsPillsInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

/** The Host's own statistics pills, and their dialogs, are built from the
 *  request DSH assembled. For this preset that request is a pointer: the turns,
 *  the model calls, and the tokens all happened inside Claude Code, and only the
 *  CLI's own record describes them. So a Claude session draws its statistics
 *  itself, in the seats the Host's two pills occupy (`host-chrome.ts` hides
 *  those), from the accounting the CLI reported.
 *
 *  Every class here is this plugin's own, but the metrics are the Host's own
 *  (`StatsPills.module.css` / `stat-dialog.module.css`), so the row reads as the
 *  same piece of chrome. */
const PILL_CSS = [
  '.dsh-claude-stats{max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;',
    'padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0;',
    'font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
    'justify-content:center;gap:12px;margin:0 auto;display:flex}',
  '.dsh-claude-stats-anchor{min-width:0;display:inline-flex;position:relative}',
  '.dsh-claude-stats-pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;',
    'font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;',
    'border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
  '.dsh-claude-stats-pill:hover,.dsh-claude-stats-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dsh-claude-stats-pill svg{flex:none;width:14px;height:14px}',
  '.dsh-claude-stats-label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
  '.dsh-claude-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
  '.dsh-claude-stats-panel{z-index:100;box-sizing:border-box;background:var(--dsw-specific-menu);',
    '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);',
    'max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);',
    'border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;position:absolute;bottom:calc(100% + 8px)}',
  '.dsh-claude-stats-panel-left{left:0}',
  '.dsh-claude-stats-panel-right{right:0}',
  '.dsh-claude-stats-title{color:var(--dsw-alias-label-primary);gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
  '.dsh-claude-stats-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}',
  '.dsh-claude-stats-title-label svg{flex:none;width:14px;height:14px}',
  '.dsh-claude-stats-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
  '.dsh-claude-stats-rows{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
  '.dsh-claude-stats-rows dt,.dsh-claude-stats-rows dd{min-width:0;margin:0}',
  '.dsh-claude-stats-rows dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
  '.dsh-claude-stats-foot{color:var(--dsw-alias-label-dimmed);margin-top:10px}',
].join('')

let cssInjected = false
function ensureCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const element = document.createElement('style')
  element.dataset.dshClaudeStats = ''
  element.textContent = PILL_CSS
  document.head.appendChild(element)
}

type StatsRow = readonly [ClaudeCodeSettingsKey, string]
type Translate = ClaudeStatsPillsInjected['t']

/** The time pill's rows: what the session did, and how fast it did it. */
function timeRows(stats: ClaudeSessionStats): readonly StatsRow[] {
  return [
    ['statsDialogTurns', formatExactTokens(stats.turns)],
    ['statsDialogSteps', formatExactTokens(stats.steps)],
    ['statsDialogApiTime', formatSeconds(stats.apiMs)],
    ['statsDialogWallTime', formatSeconds(stats.wallMs)],
    ...(stats.ttftTurns === 0 ? [] : [['statsDialogTtft', formatSeconds(stats.ttftMs / stats.ttftTurns)] as StatsRow]),
    ...(stats.tokensPerSecond === undefined ? [] : [['statsDialogSpeed', `${formatTokensPerSecond(stats.tokensPerSecond)} tok/s`] as StatsRow]),
  ]
}

/** The usage pill's rows: the prompt side the CLI billed, and what it produced.
 *
 *  The cache-hit share is read here at one decimal, the way the Host reads it in
 *  its own usage dialog; the pill above reads the same ratio as a whole number. */
function usageRows(stats: ClaudeSessionStats): readonly StatsRow[] {
  const cacheHit = formatCacheHitPercent(stats.cacheReadTokens, stats.promptTokens, 1)
  return [
    ...(cacheHit === null ? [] : [['statsDialogCacheHit', `${cacheHit}%`] as StatsRow]),
    ['statsDialogInput', `${formatExactTokens(stats.inputTokens)} tok`],
    ['statsDialogCacheRead', `${formatExactTokens(stats.cacheReadTokens)} tok`],
    ...(stats.cacheCreationTokens === 0 ? [] : [['statsDialogCacheWrite', `${formatExactTokens(stats.cacheCreationTokens)} tok`] as StatsRow]),
    ['statsDialogOutput', `${formatExactTokens(stats.outputTokens)} tok`],
    ['statsDialogTotal', `${formatExactTokens(stats.totalTokens)} tok`],
    ...(stats.costUsd === undefined ? [] : [['statsDialogCost', `$${stats.costUsd.toFixed(4)}`] as StatsRow]),
  ]
}

export function ClaudeStatsPills({ useClaudeProjection, t }: ClaudeStatsPillsProps) {
  const owned = useClaudeProjection(value => value.owned)
  const activities = useClaudeProjection(value => value.activities)
  // Folded from the activity list rather than inside the selector: a selector
  // that builds a new object every notification would re-render this row on
  // every frame of a running turn, and the list only changes when it changes.
  const stats = useMemo(() => claudeSessionStats(activities), [activities])
  const [open, setOpen] = useState<'time' | 'usage' | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  // Every Claude Session marks the document, whether or not it has figures yet:
  // the Host's own statistics describe nothing here, and standing them down must
  // not depend on the CLI having reported usage already.
  useClaudeSessionMark(owned)

  useEffect(() => {
    if (open === undefined) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(undefined) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!owned || (stats.turns === 0 && stats.totalTokens === 0)) return null
  ensureCss()

  const counts = stats.steps === 0
    ? t('statsTurns', { turns: stats.turns })
    : t('statsCounts', { turns: stats.turns, steps: stats.steps })
  const speed = stats.tokensPerSecond === undefined
    ? undefined
    : t('statsPerSecond', { tps: formatTokensPerSecond(stats.tokensPerSecond) })
  const tokens = t('statsTokens', { count: formatTokens(stats.totalTokens) })
  const cacheHitPercent = formatCacheHitPercent(stats.cacheReadTokens, stats.promptTokens)
  const cacheHit = cacheHitPercent === null
    ? undefined
    : t('statsCacheHit', { percent: cacheHitPercent })

  return (
    <div className="dsh-claude-stats" ref={rootRef} data-claude-session-stats="">
      <span className="dsh-claude-stats-anchor">
        <Pill
          icon={<IconGaugeOutline16 />}
          label={counts}
          detail={speed}
          open={open === 'time'}
          onToggle={() => { setOpen(open === 'time' ? undefined : 'time') }}
        />
        {open === 'time' ? (
          <StatsPanel title={t('statsTimeTitle')} icon={<IconGaugeOutline16 />} rows={timeRows(stats)} side="left" t={t} />
        ) : null}
      </span>
      <span className="dsh-claude-stats-anchor">
        <Pill
          icon={<IconDatabaseOutline16 />}
          label={tokens}
          detail={cacheHit}
          open={open === 'usage'}
          onToggle={() => { setOpen(open === 'usage' ? undefined : 'usage') }}
        />
        {open === 'usage' ? (
          <StatsPanel title={t('statsUsageTitle')} icon={<IconDatabaseOutline16 />} rows={usageRows(stats)} side="right" t={t} />
        ) : null}
      </span>
    </div>
  )
}

/** One statistic pill: the Host's metrics, its icon, and its separator. */
function Pill({ icon, label, detail, open, onToggle }: {
  icon: ReactNode
  label: string
  detail: string | undefined
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="dsh-claude-stats-pill"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={detail === undefined ? label : `${label} · ${detail}`}
      onClick={onToggle}
    >
      {icon}
      <span className="dsh-claude-stats-label">
        {label}
        {detail === undefined ? null : <><span className="dsh-claude-stats-sep" aria-hidden="true">·</span>{detail}</>}
      </span>
    </button>
  )
}

/** One opened panel: what the CLI measured, in the Host's dialog frame.
 *
 *  The footnote is not decoration: every figure here comes from Claude Code's
 *  own report, and a reader comparing these pills with another preset's should
 *  know why they read the same way but are sourced differently. */
function StatsPanel({ title, icon, rows: entries, side, t }: {
  title: string
  icon: ReactNode
  rows: readonly StatsRow[]
  side: 'left' | 'right'
  t: Translate
}) {
  return (
    <div
      className={`dsh-claude-stats-panel dsh-claude-stats-panel-${side}`}
      role="dialog"
      aria-label={title}
      data-claude-session-stats-panel=""
    >
      <div className="dsh-claude-stats-title">
        <span className="dsh-claude-stats-title-label">{icon}{title}</span>
      </div>
      <div className="dsh-claude-stats-rule" aria-hidden="true" />
      <dl className="dsh-claude-stats-rows">
        {entries.map(([key, value]) => (
          <Fragment key={key}>
            <dt>{t(key)}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="dsh-claude-stats-foot">{t('statsSource')}</div>
    </div>
  )
}
