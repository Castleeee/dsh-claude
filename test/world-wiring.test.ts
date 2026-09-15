import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeWorldStore, CLAUDE_WORLD, DEFAULT_WORLD } from '../src/world-store.ts'
import { ClaudeWorldSwitch, routedNamespace } from '../src/world-switch.ts'
import { mountWorldWiring, recoverWorldAtBoot } from '../src/world-wiring.ts'

const roots: string[] = []
/** Settles every store this file opened, so a queued write cannot outlive its
 *  temporary directory and fail the next test's cleanup. */
const stores: ClaudeWorldStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.settled()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-wiring-'))
  roots.push(root)
  const created = new ClaudeWorldStore({ path: join(root, 'worlds.json') })
  stores.push(created)
  return created
}

/**
 * A context stub exposing only what the wiring touches. `emit` invokes the
 * registered handlers synchronously, which is how the real Host delivers a
 * session append.
 */
function context(projectionState: unknown = { openTurnStartSeq: null, lastTurn: 0 }) {
  const handlers = new Map<string, ((...args: never[]) => void)[]>()
  const agents = new Map<string, unknown>()
  const ctx = {
    logger: { warn: () => undefined },
    agents: { get: (id: string) => agents.get(id) },
    on(event: string, handler: (...args: never[]) => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter(entry => entry !== handler))
      }
    },
    get(name: string) {
      if (name !== 'sessionProjections') return undefined
      return { stateOf: () => projectionState }
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args)
    },
  }
  return { ctx: ctx as never, agents, emit: ctx.emit.bind(ctx) }
}

/** Let the wiring's serialized chain drain: it spans several awaits, so a
 *  single macrotask turn is not enough to observe its effect. */
/** Drain the wiring's serialized chain.
 *
 *  The chain spans several awaits and the store's write queue, so a fixed delay
 *  is a race under load. Waiting on the store's own quiescence is exact, and
 *  the extra turns let a queued callback that has not yet reached the store
 *  enqueue its work first. */
const settle = async () => {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await Promise.all(stores.map(entry => entry.settled()))
  }
}

function gateway(initial: Record<string, unknown> = {}) {
  const document: Record<string, unknown> = { ...initial }
  return {
    document,
    read: (ns: string) => document[ns],
    write: async (ns: string, section: object) => { document[ns] = section },
  }
}

describe('world wiring', () => {
  it('routes only the two namespaces it owns', () => {
    expect(routedNamespace('agent-default-model')).toBe(true)
    expect(routedNamespace('permission')).toBe(true)
    expect(routedNamespace('llm-pi-ai')).toBe(false)
    expect(routedNamespace('ui-theme')).toBe(false)
  })

  it('installs the Claude world when the preset is selected, and restores on the way back', async () => {
    const settings = gateway({
      'agent-default-model': { provider: 'p', model: 'deepseek' },
      permission: { defaultPreset: 'workspace-write' },
    })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const { ctx, agents, emit } = context()
    const stop = mountWorldWiring(ctx, { switch: worldSwitch })
    agents.set('s1', { session: {} })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(await world.activeWorld()).toBe(CLAUDE_WORLD)

    settings.document['agent-default-model'] = { provider: 'claude-code', model: 'sonnet' }
    await worldSwitch.refresh()

    emit('agent-preset/selected', 's1', 'cordis')
    await settle()
    expect(await world.activeWorld()).toBe(DEFAULT_WORLD)
    expect(settings.document['agent-default-model']).toEqual({ provider: 'p', model: 'deepseek' })
    stop()
  })

  it('treats every non-Claude preset as the same shared world', async () => {
    const settings = gateway({ permission: { defaultPreset: 'ask' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const { ctx, agents, emit } = context()
    const stop = mountWorldWiring(ctx, { switch: worldSwitch })
    agents.set('s1', { session: {} })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(await world.activeWorld()).toBe(CLAUDE_WORLD)

    // Switching between two non-Claude presets must not leave the Claude world,
    // and must not capture a Claude value into the shared world.
    emit('agent-preset/selected', 's1', 'cordis')
    await settle()
    emit('agent-preset/selected', 's1', 'write')
    await settle()
    expect(await world.activeWorld()).toBe(DEFAULT_WORLD)
    expect(settings.document.permission).toEqual({ defaultPreset: 'ask' })
    stop()
  })

  it('installs the destination world model on the session itself', async () => {
    const settings = gateway({
      'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const installed: unknown[] = []
    const { ctx, agents, emit } = context()
    const stop = mountWorldWiring(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    agents.set('s1', { session: {} })

    // Claude's world is seeded from the outgoing value on the first switch.
    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(installed).toEqual([{ provider: 'opencode-go', model: 'deepseek-v4-flash' }])

    // The user picks a Claude model; it belongs to the Claude world.
    settings.document['agent-default-model'] = { provider: 'claude', model: 'opus' }
    await worldSwitch.refresh()
    emit('agent-preset/selected', 's1', 'standard')
    await settle()
    // Switching out must put the session back on the shared world's model, not
    // leave it answering as the Claude model.
    expect(installed[installed.length - 1]).toEqual({ provider: 'opencode-go', model: 'deepseek-v4-flash' })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(installed[installed.length - 1]).toEqual({ provider: 'claude', model: 'opus' })
    stop()
  })

  it('applies a model to a session that has already started', async () => {
    // Unlike a permission, the model is not gated on the blank-session rule:
    // the user's own model change applies to a started session, and so must a
    // world switch, or the composer would keep showing the old world's model.
    const settings = gateway({
      'agent-default-model': { provider: 'claude', model: 'opus' },
    })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const installed: unknown[] = []
    const { ctx, agents, emit } = context({ openTurnStartSeq: null, lastTurn: 4 })
    const stop = mountWorldWiring(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    agents.set('s1', { session: {} })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(installed).toEqual([{ provider: 'claude', model: 'opus' }])
    stop()
  })

  it('skips a captured selection that is not a usable provider/model pair', async () => {
    const settings = gateway({ 'agent-default-model': { provider: 'opencode-go' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const installed: unknown[] = []
    const { ctx, agents, emit } = context()
    const stop = mountWorldWiring(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    agents.set('s1', { session: {} })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(installed).toEqual([])
    stop()
  })

  it('applies the destination world permission only to a still-blank session', async () => {
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const applied: string[] = []
    const { ctx, agents, emit } = context()
    const stop = mountWorldWiring(ctx, {
      switch: worldSwitch,
      applyPermission: (_agent, preset) => applied.push(preset),
    })
    agents.set('s1', { session: {} })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(applied).toEqual(['workspace-write'])
    stop()
  })

  it('leaves a session that already started its permission alone', async () => {
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const applied: string[] = []
    const { ctx, agents, emit } = context({ openTurnStartSeq: null, lastTurn: 3 })
    const stop = mountWorldWiring(ctx, {
      switch: worldSwitch,
      applyPermission: (_agent, preset) => applied.push(preset),
    })
    agents.set('s1', { session: {} })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(applied).toEqual([])
    stop()
  })

  it('records a permission change as the default for later sessions', async () => {
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const written: string[] = []
    const { ctx, emit } = context()
    const stop = mountWorldWiring(ctx, {
      switch: worldSwitch,
      permissionNameFor: mode => mode === 'danger-full-access' ? 'danger-full-access' : undefined,
      writePermissionDefault: async preset => { written.push(preset) },
    })

    emit('session/event', {}, { type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
    await settle()
    expect(written).toEqual(['danger-full-access'])

    // A mode no preset bundles records nothing rather than guessing a name.
    emit('session/event', {}, { type: 'sandbox/mode', data: { mode: 'read-only' } })
    await settle()
    expect(written).toEqual(['danger-full-access'])
    stop()
  })

  it('does not record its own seeded permission as the user choice', async () => {
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const written: string[] = []
    const { ctx, agents, emit } = context()
    const stop = mountWorldWiring(ctx, {
      switch: worldSwitch,
      // Applying a permission appends the session event a real Host would,
      // which is exactly the echo that must not be recorded as a choice.
      applyPermission: (_agent, preset) => { emit('session/event', {}, { type: 'sandbox/mode', data: { mode: preset } }) },
      permissionNameFor: mode => mode,
      writePermissionDefault: async preset => { written.push(preset) },
    })
    agents.set('s1', { session: {} })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(written).toEqual([])
    stop()
  })

  it('removes every subscription on dispose', async () => {
    const settings = gateway({ permission: { defaultPreset: 'ask' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const { ctx, agents, emit } = context()
    const stop = mountWorldWiring(ctx, { switch: worldSwitch })
    agents.set('s1', { session: {} })
    stop()

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(await world.activeWorld()).toBe(DEFAULT_WORLD)
  })

  it('contains a failed switch and keeps serving later changes', async () => {
    const world = await store()
    const warned: string[] = []
    let fail = true
    const settings = {
      read: () => ({ defaultPreset: 'ask' }),
      write: async () => {
        if (fail) throw new Error('settings unavailable')
        fail = false
      },
    }
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world, warn: m => warned.push(m) })
    const { ctx, agents, emit } = context()
    const stop = mountWorldWiring(ctx, { switch: worldSwitch, warn: m => warned.push(m) })
    agents.set('s1', { session: {} })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    emit('agent-preset/selected', 's1', 'cordis')
    await settle()
    expect(warned.join(' ')).toContain('settings unavailable')

    // The chain must not be poisoned: a later switch still runs.
    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(await world.activeWorld()).toBe(CLAUDE_WORLD)
    stop()
  })

  it('reports a boot recovery failure without rejecting', async () => {
    const warnings: string[] = []
    const worldSwitch = { recover: vi.fn(async () => { throw new Error('corrupt store') }) } as unknown as ClaudeWorldSwitch
    await expect(recoverWorldAtBoot(worldSwitch, m => warnings.push(m))).resolves.toBeUndefined()
    expect(warnings.join(' ')).toContain('corrupt store')
  })
})
