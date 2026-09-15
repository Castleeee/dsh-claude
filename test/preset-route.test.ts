import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/preset-route.ts'
import { CLAUDE_CODE_PROVIDER } from '../src/constants.ts'
import { recordClaudeModels, resetClaudeModels } from '../src/model-catalog.ts'

type RequestListener = (payload: unknown, next: () => Promise<{ provider?: string; model?: string }>) => Promise<{ provider?: string; model?: string }>

function capture(): { ctx: Context; listener: () => RequestListener; registered: () => readonly string[]; provided: () => { name: string; value: unknown } | undefined } {
  let listener: RequestListener = () => { throw new Error('unregistered') }
  const names: string[] = []
  let service: { name: string; value: unknown } | undefined
  const ctx = {
    on: (event: string, handler: RequestListener) => {
      expect(event).toBe('agent/request')
      listener = handler
    },
    effect: (setup: () => unknown) => { setup() },
    provide: (name: string, value: unknown) => { service = { name, value } },
    tools: {
      register: (definition: { name: string }) => {
        names.push(definition.name)
        return () => undefined
      },
    },
  } as unknown as Context
  return { ctx, listener: () => listener, registered: () => names, provided: () => service }
}

describe('Claude preset route', () => {
  it('preserves the upstream selected model alias', async () => {
    const captured = capture()
    apply(captured.ctx, { accepts: model => model === 'opus' })
    const result = await captured.listener()({} as never, async () => ({ provider: 'upstream-provider', model: 'opus' }))
    expect(result).toEqual({ provider: CLAUDE_CODE_PROVIDER, model: 'opus' })
  })

  // The provider is forced unconditionally, so a model this provider cannot
  // serve must not be carried through beside it: `claude` paired with a
  // DeepSeek id is a request no adapter can resolve, and is exactly what a
  // session leaving the shared world for this preset used to produce.
  it('drops a foreign model instead of pairing it with the Claude provider', async () => {
    const captured = capture()
    apply(captured.ctx, { accepts: model => model === 'opus' })
    const result = await captured.listener()({} as never, async () => ({
      provider: 'upstream-provider',
      model: 'deepseek-v4-flash-vision-exp',
    }))
    expect(result).toEqual({ provider: CLAUDE_CODE_PROVIDER, model: 'default' })
  })

  it('keeps a model the CLI lineup advertises under either spelling', async () => {
    recordClaudeModels([{ value: 'claude-opus-4-1', displayName: 'Opus' }] as never)
    try {
      const captured = capture()
      apply(captured.ctx)
      // The CLI's own spelling is what a session persisted before aliasing holds.
      const own = await captured.listener()({} as never, async () => ({ provider: 'x', model: 'claude-opus-4-1' }))
      expect(own.model).toBe('claude-opus-4-1')
      const foreign = await captured.listener()({} as never, async () => ({ provider: 'x', model: 'gpt-5' }))
      expect(foreign.model).toBe('default')
    } finally {
      resetClaudeModels()
    }
  })

  it('defaults to default when upstream carries no model', async () => {
    const captured = capture()
    apply(captured.ctx)
    const result = await captured.listener()({} as never, async () => ({ provider: 'upstream-provider' }))
    expect(result).toEqual({ provider: CLAUDE_CODE_PROVIDER, model: 'default' })
  })

  it('lets explicit route config override the upstream selection', async () => {
    const captured = capture()
    apply(captured.ctx, { model: 'sonnet' })
    const result = await captured.listener()({} as never, async () => ({ provider: 'upstream-provider', model: 'opus' }))
    expect(result).toEqual({ provider: CLAUDE_CODE_PROVIDER, model: 'sonnet' })
  })

  it('registers presentation-only tool mirrors into the preset scope', () => {
    const captured = capture()
    apply(captured.ctx)
    expect(captured.registered()).toEqual([
      'Bash', 'PowerShell', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
      'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task', 'ExitPlanMode', 'TodoWrite',
    ])
  })

  it('provides only the agent-scope command directory for collision checks', () => {
    const captured = capture()
    apply(captured.ctx)
    const service = captured.provided()
    expect(service?.name).toBe('claudeCommands')
    expect(typeof (service?.value as { list?: unknown }).list).toBe('function')
    expect((service?.value as { register?: unknown }).register).toBeUndefined()
  })
})
