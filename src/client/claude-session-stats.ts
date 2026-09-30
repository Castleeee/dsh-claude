/** The session's own statistics, folded from the accounting the CLI reported.
 *
 *  Every figure here is what Claude Code measured, not what DSH assembled: the
 *  conversation and the tools live in the CLI, so its per-turn record is the
 *  only honest source. DSH's own statistics are stood down for this preset (see
 *  `host-chrome`), which is why this module exists at all rather than reading
 *  the Host's projections.
 *
 *  The three formatters mirror the Host's own (`formatTokens`,
 *  `formatTokensPerSecond`, `formatCacheHitPercent` in `dsh-client-ui-chat`) so
 *  a Claude session's numbers read exactly like every other session's: same
 *  rounding, same K/M scale, and a partial cache hit never rounds up to 100%.
 */
import type { ClaudeActivityEvent, ClaudeUsage } from '../events.ts'

export interface ClaudeSessionStats {
  /** Turns the session has recorded, which is the newest turn's number. */
  turns: number
  /** Model calls Claude made: one DSH step here is a whole Claude turn. */
  steps: number
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  /** Everything billed: uncached input, cache traffic, and output. */
  totalTokens: number
  /** API milliseconds across the session's model calls. */
  apiMs: number
  /** Wall milliseconds the turns took, tool execution included. */
  wallMs: number
  /** Summed first-token waits and how many turns reported one, so the average
   *  can be drawn without averaging a subset against the whole. */
  ttftMs: number
  ttftTurns: number
  /** Output tokens per API second, absent until a turn reported both. */
  tokensPerSecond?: number
  /** The CLI's own cumulative cost counter, as the newest turn reported it. */
  costUsd?: number
  /** Everything the prompt side billed: uncached input plus cache traffic.
   *  Kept as a count rather than a percentage because the Host reads its
   *  cache-hit share at two precisions — whole numbers in the pill, one decimal
   *  in the panel — and both come from this same ratio. */
  promptTokens: number
}

const EMPTY: ClaudeSessionStats = {
  turns: 0,
  promptTokens: 0,
  steps: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  apiMs: 0,
  wallMs: 0,
  ttftMs: 0,
  ttftTurns: 0,
}

function usageOf(activity: ClaudeActivityEvent): ClaudeUsage | undefined {
  return activity.kind === 'usage' ? activity.usage : undefined
}

/** Fold one session's activities into its statistics.
 *
 *  Turns come from every activity, because a turn that failed still happened;
 *  the rest come from the usage rows, because those are the only records that
 *  measured them. */
export function claudeSessionStats(activities: readonly ClaudeActivityEvent[]): ClaudeSessionStats {
  const stats: ClaudeSessionStats = { ...EMPTY }
  let promptTokens = 0
  for (const activity of activities) {
    if (activity.turn > stats.turns) stats.turns = activity.turn
    const usage = usageOf(activity)
    if (usage === undefined) continue
    const input = usage.inputTokens ?? 0
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheCreation = usage.cacheCreationTokens ?? 0
    const output = usage.outputTokens ?? 0
    stats.inputTokens += input
    stats.cacheReadTokens += cacheRead
    stats.cacheCreationTokens += cacheCreation
    stats.outputTokens += output
    promptTokens += input + cacheRead + cacheCreation
    stats.apiMs += usage.apiMs ?? 0
    stats.wallMs += usage.durationMs ?? 0
    if (usage.ttftMs !== undefined) {
      stats.ttftMs += usage.ttftMs
      stats.ttftTurns += 1
    }
    stats.steps += usage.modelCalls ?? 0
    if (usage.cumulativeCostUsd !== undefined) stats.costUsd = usage.cumulativeCostUsd
  }
  stats.totalTokens = promptTokens + stats.outputTokens
  if (stats.apiMs > 0 && stats.outputTokens > 0) {
    stats.tokensPerSecond = stats.outputTokens / (stats.apiMs / 1_000)
  }
  stats.promptTokens = promptTokens
  return stats
}

/** A count with no more precision than it deserves, on the Host's K/M scale. */
export function formatTokens(value: number): string {
  const scaled = (candidate: number): string => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1e3) return String(value)
  if (value < 1e6) return `${scaled(value / 1e3)}K`
  return `${scaled(value / 1e6)}M`
}

/** An unrounded integer count with digit grouping. */
export function formatExactTokens(value: number): string {
  const digits = String(Math.max(0, Math.round(value)))
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
  return groups.join(',')
}

/** Tokens per second, at the precision a rate is worth. */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** Seconds as the panels read them: minutes once past a minute. */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`
}

/** Round a cache-read ratio to exact percentage units, ties rounded up. */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: number): number {
  const scale = (decimalPlaces === 0 ? 1 : 10) * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

function displayPercentUnits(units: number, decimalPlaces: number): string {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`
}

/** Display-ready cache-hit share that never rounds a partial hit to 100%.
 *  @returns the percentage text, or null when nothing reported a prompt. */
export function formatCacheHitPercent(cacheReadTokens: number, promptTokens: number, decimalPlaces = 0): string | null {
  if (promptTokens === 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces)
  // The whole-number reading would say 100 for a partial hit: widen the
  // precision until the miss is visible.
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
}
