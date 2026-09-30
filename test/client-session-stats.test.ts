import { describe, expect, it } from 'vitest'

import type { ClaudeActivityEvent, ClaudeUsage } from '../src/events.ts'
import { claudeSessionStats, formatCacheHitPercent, formatExactTokens, formatSeconds, formatTokens, formatTokensPerSecond } from '../src/client/claude-session-stats.ts'

function activity(turn: number, kind: ClaudeActivityEvent['kind'], usage?: ClaudeUsage): ClaudeActivityEvent {
  return { turn, step: 1, ordinal: 0, kind, ...(usage === undefined ? {} : { usage }) }
}

/** One turn's row as the sidecar records it: what the turn billed, how many
 *  model calls made it, and how long those calls took in the API. */
function usageRow(turn: number, usage: ClaudeUsage): ClaudeActivityEvent {
  return activity(turn, 'usage', usage)
}

describe('Claude session statistics', () => {
  it('sums the CLI\'s own per-turn records into one reading', () => {
    const stats = claudeSessionStats([
      activity(1, 'text'),
      usageRow(1, { inputTokens: 100, cacheReadTokens: 1_900, outputTokens: 50, apiMs: 2_000, modelCalls: 2, durationMs: 5_000, ttftMs: 1_500, cumulativeCostUsd: 0.5 }),
      activity(2, 'tool-call'),
      usageRow(2, { inputTokens: 200, cacheReadTokens: 9_800, outputTokens: 150, apiMs: 3_000, modelCalls: 3, durationMs: 7_000, ttftMs: 2_000 }),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(5)
    expect(stats.inputTokens).toBe(300)
    expect(stats.cacheReadTokens).toBe(11_700)
    expect(stats.outputTokens).toBe(200)
    expect(stats.totalTokens).toBe(12_200)
    expect(stats.apiMs).toBe(5_000)
    expect(stats.wallMs).toBe(12_000)
    expect(stats.ttftMs).toBe(3_500)
    expect(stats.ttftTurns).toBe(2)
    // Output over API time, not over wall time: tool execution is the turn's,
    // not the model's.
    expect(stats.tokensPerSecond).toBe(40)
    expect(stats.cumulativeCostUsd).toBeUndefined()
    expect(stats.costUsd).toBe(0.5)
    expect(stats.promptTokens).toBe(12_000)
    expect(formatCacheHitPercent(stats.cacheReadTokens, stats.promptTokens)).toBe('98')
    expect(formatCacheHitPercent(stats.cacheReadTokens, stats.promptTokens, 1)).toBe('97.5')
  })

  it('counts a turn that failed, and reports no rate until a turn measured one', () => {
    const stats = claudeSessionStats([
      activity(1, 'error'),
      usageRow(1, { inputTokens: 10, outputTokens: 0 }),
    ])
    expect(stats.turns).toBe(1)
    expect(stats.steps).toBe(0)
    expect(stats.tokensPerSecond).toBeUndefined()
    expect(formatCacheHitPercent(stats.cacheReadTokens, stats.promptTokens)).toBe('0')
  })

  it('is empty for a session that recorded nothing', () => {
    const stats = claudeSessionStats([])
    expect(stats).toMatchObject({ turns: 0, steps: 0, totalTokens: 0, apiMs: 0 })
    expect(stats.tokensPerSecond).toBeUndefined()
    expect(formatCacheHitPercent(stats.cacheReadTokens, stats.promptTokens)).toBeNull()
  })
})

describe('the Host\'s own number formats', () => {
  it('scales token counts the way the Host does', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(166_000)).toBe('166K')
    expect(formatTokens(412_000_000)).toBe('412M')
  })

  it('groups exact counts', () => {
    expect(formatExactTokens(1_234_567)).toBe('1,234,567')
  })

  it('rounds rates and durations the way a reader expects', () => {
    expect(formatTokensPerSecond(219.4)).toBe('219')
    expect(formatTokensPerSecond(2.35)).toBe('2.4')
    expect(formatSeconds(39_219)).toBe('39s')
    expect(formatSeconds(95_000)).toBe('1m35s')
  })

  it('never rounds a partial cache hit up to 100', () => {
    expect(formatCacheHitPercent(11_700, 12_000)).toBe('98')
    expect(formatCacheHitPercent(9_999, 10_000)).toBe('99.99')
    expect(formatCacheHitPercent(1_000, 1_000)).toBe('100')
    expect(formatCacheHitPercent(0, 0)).toBeNull()
  })
})
