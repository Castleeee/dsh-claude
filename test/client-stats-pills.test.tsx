// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { ClaudeStatsPills } from '../src/client/ClaudeStatsPills.tsx'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { CLAUDE_SESSION_ATTRIBUTE } from '../src/client/session-mark.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

let mounted: Root | undefined

afterEach(() => {
  const root = mounted
  mounted = undefined
  if (root !== undefined) act(() => { root.unmount() })
  document.body.replaceChildren()
  delete document.body.dataset.dshClaudeSession
})

function usageRow(turn: number, usage: ClaudeActivityEvent['usage']): ClaudeActivityEvent {
  return { turn, step: 1, ordinal: 0, kind: 'usage', usage }
}

function mount({ owned = true, activities = [] as readonly ClaudeActivityEvent[] } = {}): void {
  const snapshot: ClaudeClientProjection = { ...EMPTY_CLAUDE_PROJECTION, owned, activities }
  const container = document.createElement('div')
  document.body.append(container)
  mounted = createRoot(container)
  act(() => {
    mounted?.render(<ClaudeStatsPills
      t={t}
      useClaudeProjection={<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)}
    />)
  })
}

function pills(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.dsh-claude-stats-pill')]
}

const twoTurns = [
  usageRow(1, { inputTokens: 100, cacheReadTokens: 1_900, outputTokens: 50, apiMs: 2_000, modelCalls: 2, durationMs: 5_000, ttftMs: 1_500, cumulativeCostUsd: 0.5 }),
  usageRow(2, { inputTokens: 200, cacheReadTokens: 9_800, outputTokens: 150, apiMs: 3_000, modelCalls: 3, durationMs: 7_000, ttftMs: 2_000, cumulativeCostUsd: 0.75 }),
]

describe('the Claude session statistics pills', () => {
  it('reads the CLI\'s own turns, calls, rate and tokens', () => {
    mount({ activities: twoTurns })
    const [time, usage] = pills()
    expect(time?.textContent).toBe('2 turns 5 steps·40 tok/s')
    expect(usage?.textContent).toBe('12.2K tok·Cache hit 98%')
    // Both are dialog triggers, like the Host's own pills.
    expect(time?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(usage?.getAttribute('aria-label')).toBe('12.2K tok · Cache hit 98%')
  })

  it('opens the Host-style panel the pill describes, and closes it again', () => {
    mount({ activities: twoTurns })
    act(() => { pills()[0]?.click() })
    const panel = document.querySelector('[data-claude-session-stats-panel]')
    expect(panel?.getAttribute('aria-label')).toBe(en.statsTimeTitle)
    expect(panel?.textContent).toContain(en.statsDialogSteps)
    expect(panel?.textContent).toContain('5')
    expect(panel?.textContent).toContain('40 tok/s')
    act(() => { pills()[0]?.click() })
    expect(document.querySelector('[data-claude-session-stats-panel]')).toBeNull()

    act(() => { pills()[1]?.click() })
    const usagePanel = document.querySelector('[data-claude-session-stats-panel]')
    expect(usagePanel?.getAttribute('aria-label')).toBe(en.statsUsageTitle)
    // One decimal here, the way the Host's own usage dialog reads the ratio.
    expect(usagePanel?.textContent).toContain('97.5%')
    expect(usagePanel?.textContent).toContain('11,700 tok')
    expect(usagePanel?.textContent).toContain('$0.7500')
  })

  it('marks the document so the Host\'s own statistics stand down', () => {
    mount({ activities: twoTurns })
    expect(document.body.hasAttribute(CLAUDE_SESSION_ATTRIBUTE)).toBe(true)
    const root = mounted
    mounted = undefined
    act(() => { root?.unmount() })
    expect(document.body.hasAttribute(CLAUDE_SESSION_ATTRIBUTE)).toBe(false)
  })

  it('renders nothing for another preset, and marks nothing', () => {
    mount({ owned: false, activities: twoTurns })
    expect(pills()).toHaveLength(0)
    expect(document.body.hasAttribute(CLAUDE_SESSION_ATTRIBUTE)).toBe(false)
  })

  it('renders nothing before the CLI has reported anything', () => {
    mount({ activities: [] })
    expect(pills()).toHaveLength(0)
    // The mark still lands: the Host's statistics describe nothing here either
    // way, and they must not reappear while the session is still quiet.
    expect(document.body.hasAttribute(CLAUDE_SESSION_ATTRIBUTE)).toBe(true)
  })

  it('shows the turn count alone while no turn reported its model calls', () => {
    mount({ activities: [usageRow(3, { inputTokens: 10, outputTokens: 5 })] })
    expect(pills()[0]?.textContent).toBe('3 turns')
    expect(pills()[1]?.textContent).toBe('15 tok·Cache hit 0%')
  })
})
