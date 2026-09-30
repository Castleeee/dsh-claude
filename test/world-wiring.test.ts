import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CLAUDE_CODE_PROVIDER_IDS } from '../src/constants.ts'
import { AGENT_DEFAULT_MODEL_NS, ClaudeWorldStore, CLAUDE_WORLD, DEFAULT_WORLD, PERMISSION_NS } from '../src/world-store.ts'
import { ClaudeWorldSwitch, routedNamespace } from '../src/world-switch.ts'
import { mountWorldWiring, recoverWorldAtBoot, type WorldWiringOptions } from '../src/world-wiring.ts'

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

/** The turn boundary a session has before it runs anything. */
const BLANK = { openTurnStartSeq: null, lastTurn: 0 }

interface SessionOptions {
  preset?: string
  depth?: number
  turnBoundary?: { openTurnStartSeq: number | null; lastTurn: number }
  /** The `modelSelection` projection's pending selection, as the Host folds it. */
  pending?: unknown
  /** The session's persisted request header, which outranks a world's model. */
  requestHeader?: unknown
}

/**
 * A context stub exposing only what the wiring touches. `emit` invokes the
 * registered handlers synchronously, which is how the real Host delivers a
 * session append, and the projection map is keyed by the session object the
 * same way the Host's own projection store is.
 */
function context() {
  const handlers = new Map<string, ((...args: never[]) => void)[]>()
  const agents = new Map<string, { session: FakeSession }>()
  const sessions = new Map<string, FakeSession>()
  const states = new WeakMap<object, Record<string, unknown>>()

  interface FakeSession {
    id: string
    header: { delegationDepth: number }
    appended: { type: string; data: unknown }[]
    append(type: string, data: unknown): void
    requestHeader(): unknown
  }

  const session = (id: string, options: SessionOptions = {}): FakeSession => {
    const value: FakeSession = {
      id,
      header: { delegationDepth: options.depth ?? 0 },
      appended: [],
      append(type, data) { value.appended.push({ type, data }) },
      requestHeader: () => options.requestHeader,
    }
    states.set(value, {
      agentPreset: options.preset,
      turnBoundary: options.turnBoundary ?? BLANK,
      modelSelection: { pending: options.pending ?? null },
    })
    sessions.set(id, value)
    return value
  }

  const ctx = {
    logger: { warn: () => undefined },
    agents: { get: (id: string) => agents.get(id) },
    sessions: { get: (id: string) => sessions.get(id), list: () => [...sessions.values()] },
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
      return { stateOf: (session: object, key: string) => states.get(session)?.[key] }
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args)
    },
  }
  return { ctx: ctx as never, agents, session, emit: ctx.emit.bind(ctx) }
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

/** The routes this package serves, as the adapter registry would answer. The
 *  wiring asks for capability rather than a provider name, so the tests supply
 *  the one route the Claude adapter registers; a test that needs a different
 *  answer passes its own `ownsRoute`. */
const ownsClaudeRoute = (provider: string): boolean => CLAUDE_CODE_PROVIDER_IDS.includes(provider as never)

/** Mount the wiring with the route predicate every test but the guard's own
 *  takes for granted. */
function mount(ctx: Context, options: Omit<WorldWiringOptions, 'ownsRoute'> & { ownsRoute?: WorldWiringOptions['ownsRoute'] }): () => void {
  return mountWorldWiring(ctx, { ownsRoute: ownsClaudeRoute, ...options })
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
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, { switch: worldSwitch })
    const s1 = session('s1', { preset: 'claude' })
    agents.set('s1', { session: s1 })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(await world.activeWorld()).toBe(CLAUDE_WORLD)

    // The user picks a Claude model in that session; the choice belongs to the
    // session's own world. The provider is the route this package actually
    // registers — a name the registry does not serve would be refused by the
    // guard below rather than recorded.
    emit('session/event', s1, { type: 'model/selection', data: { provider: 'claude', model: 'sonnet' } })
    await settle()
    expect((await world.sectionsOf(CLAUDE_WORLD))?.[AGENT_DEFAULT_MODEL_NS])
      .toEqual({ provider: 'claude', model: 'sonnet' })

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
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, { switch: worldSwitch })
    const s1 = session('s1', { preset: 'cordis' })
    agents.set('s1', { session: s1 })

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

  it('records a session choice in the world that session belongs to', async () => {
    // The regression: the settings document is shared, so a session of the
    // shared world writes it even while Claude's world owns it. Reading that
    // document back into Claude's world is what replaced Claude's model with
    // the shared one, and what made switching back stop restoring it.
    const settings = gateway({ 'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, { switch: worldSwitch })
    const claude = session('claude-session', { preset: 'claude' })
    const shared = session('shared-session', { preset: 'cordis' })
    agents.set('claude-session', { session: claude })
    agents.set('shared-session', { session: shared })

    emit('agent-preset/selected', 'claude-session', 'claude')
    await settle()
    emit('session/event', claude, { type: 'model/selection', data: { provider: 'claude', model: 'opus' } })
    await settle()

    // A session of the shared world picks its own model, and the Host writes
    // the document as part of that choice.
    settings.document['agent-default-model'] = { provider: 'opencode-go', model: 'deepseek-v4-pro' }
    emit('session/event', shared, { type: 'model/selection', data: { provider: 'opencode-go', model: 'deepseek-v4-pro' } })
    await settle()

    expect((await world.sectionsOf(CLAUDE_WORLD))?.[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'claude', model: 'opus' })
    expect((await world.sectionsOf(DEFAULT_WORLD))?.[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'opencode-go', model: 'deepseek-v4-pro' })

    // Switching back to Claude restores the Claude model, not the shared one.
    emit('agent-preset/selected', 'claude-session', 'claude')
    await settle()
    expect(settings.document['agent-default-model']).toEqual({ provider: 'claude', model: 'opus' })
    stop()
  })

  it('installs the destination world model on the session itself', async () => {
    const settings = gateway({
      'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const installed: unknown[] = []
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    const s1 = session('s1', { preset: 'claude' })
    agents.set('s1', { session: s1 })

    // Claude's world is seeded from the outgoing value on the first switch.
    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(installed).toEqual([{ provider: 'opencode-go', model: 'deepseek-v4-flash' }])

    // The user picks a Claude model; it belongs to the Claude world.
    emit('session/event', s1, { type: 'model/selection', data: { provider: 'claude', model: 'opus' } })
    await settle()
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

  it('moves a session that already carries a model of its own onto the destination world', async () => {
    // A session that has ever chosen a model has one of its own, and the switch
    // must replace it: the world is the user's own reason for switching, and
    // skipping a session that has a selection left the composer showing the
    // outgoing world's model — the "switching does nothing" report.
    const settings = gateway({ 'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const installed: unknown[] = []
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    const s1 = session('s1', { preset: 'claude', pending: { provider: 'opencode-go', model: 'deepseek-v4-pro' } })
    agents.set('s1', { session: s1 })
    await worldSwitch.captureModel(CLAUDE_WORLD, { provider: 'claude', model: 'opus' })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(installed[installed.length - 1]).toEqual({ provider: 'claude', model: 'opus' })
    stop()
  })

  it('puts a session back on its own model when it is handed a route its world cannot run', async () => {
    // A Claude route outside the Claude preset is refused by the adapter, so a
    // shared-world session holding one fails its next turn. The value can only
    // have come from the other world, and it must not be recorded as this
    // world's own model.
    const settings = gateway({ 'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const installed: unknown[] = []
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    const shared = session('shared', { preset: 'cordis' })
    agents.set('shared', { session: shared })
    await worldSwitch.switchTo(DEFAULT_WORLD)
    await worldSwitch.captureModel(DEFAULT_WORLD, { provider: 'opencode-go', model: 'deepseek-v4-flash' })

    emit('session/event', shared, { type: 'model/selection', data: { provider: 'claude', model: 'opus' } })
    await settle()

    expect((await world.sectionsOf(DEFAULT_WORLD))?.[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'opencode-go', model: 'deepseek-v4-flash' })
    expect(installed[installed.length - 1]).toEqual({ provider: 'opencode-go', model: 'deepseek-v4-flash' })
    stop()
  })

  it('keeps a foreign route out of the Claude world the same way', async () => {
    // The refusal read in the other direction. Claude Code owns its inner loop
    // and bridges only its own registered models, so a Claude-preset session
    // handed a foreign route cannot run it either. The value arrives from the
    // other world (a picker still showing it), and recording it would leave the
    // composer advertising a model the session silently replaces at request
    // time. It must be put back on the Claude world's own model instead.
    const settings = gateway({ 'agent-default-model': { provider: 'claude', model: 'opus' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const installed: unknown[] = []
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    const claude = session('claude-session', { preset: 'claude' })
    agents.set('claude-session', { session: claude })
    emit('agent-preset/selected', 'claude-session', 'claude')
    await settle()
    await worldSwitch.captureModel(CLAUDE_WORLD, { provider: 'claude', model: 'opus' })

    emit('session/event', claude, { type: 'model/selection', data: { provider: 'opencode-go', model: 'deepseek-v4-flash' } })
    await settle()

    expect((await world.sectionsOf(CLAUDE_WORLD))?.[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'claude', model: 'opus' })
    expect(installed[installed.length - 1]).toEqual({ provider: 'claude', model: 'opus' })
    stop()
  })

  it('records a Claude model chosen inside the Claude world', async () => {
    // The mirror of the test above must not swallow the legitimate case: a
    // Claude route chosen while the Claude world owns the session is exactly
    // this world's own choice and is recorded as such.
    const settings = gateway({ 'agent-default-model': { provider: 'claude', model: 'opus' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, { switch: worldSwitch })
    const claude = session('claude-session', { preset: 'claude' })
    agents.set('claude-session', { session: claude })
    emit('agent-preset/selected', 'claude-session', 'claude')
    await settle()

    emit('session/event', claude, { type: 'model/selection', data: { provider: 'claude', model: 'sonnet' } })
    await settle()

    expect((await world.sectionsOf(CLAUDE_WORLD))?.[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'claude', model: 'sonnet' })
    stop()
  })

  it('does not capture the permission a new session is pinned with from the other world', async () => {
    // The Host pins a new session's permission from the settings document as
    // part of creating it, before this wiring even hears about the session. That
    // preset belongs to the world that owns the document, not to the session's
    // own world, and capturing it moved read-only into the shared world — where
    // it then became every later session's default.
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const applied: string[] = []
    const { ctx, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyPermission: (_target, preset) => { applied.push(preset) },
    })
    const claude = session('claude-session', { preset: 'claude' })

    // Claude's world ends up read-only, and the document follows it.
    emit('agent-preset/selected', 'claude-session', 'claude')
    await settle()
    emit('session/event', claude, { type: 'permission/preset', data: { preset: 'read-only' } })
    await settle()
    emit('agent-preset/selected', 'claude-session', 'claude')
    await settle()
    expect(settings.document.permission).toEqual({ defaultPreset: 'read-only' })

    // A shared-world session is created; the Host pins it from that document.
    const created = session('cordis-session', { preset: 'cordis' })
    emit('session/event', created, { type: 'permission/preset', data: { preset: 'read-only' } })
    emit('session/created', created)
    await settle()

    expect((await world.sectionsOf(DEFAULT_WORLD))?.[PERMISSION_NS]).toEqual({ defaultPreset: 'workspace-write' })
    expect((await world.sectionsOf(CLAUDE_WORLD))?.[PERMISSION_NS]).toEqual({ defaultPreset: 'read-only' })
    expect(applied[applied.length - 1]).toBe('workspace-write')
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
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    const s1 = session('s1', { preset: 'claude', turnBoundary: { openTurnStartSeq: null, lastTurn: 4 } })
    agents.set('s1', { session: s1 })

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
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    const s1 = session('s1', { preset: 'claude' })
    agents.set('s1', { session: s1 })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(installed).toEqual([])
    stop()
  })

  it('moves the document to the world of a session created outside it', async () => {
    // A new session composes its model and permission from the document, so a
    // session created while the other world owned it would open on that world's
    // values despite belonging to its own.
    const settings = gateway({
      'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' },
      permission: { defaultPreset: 'workspace-write' },
    })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const recorded: unknown[] = []
    const applied: string[] = []
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      recordModelSelection: (target, selection) => { recorded.push({ id: target.id, selection }) },
      applyPermission: (_target, preset) => { applied.push(preset) },
    })
    const claude = session('claude-session', { preset: 'claude' })
    agents.set('claude-session', { session: claude })

    emit('agent-preset/selected', 'claude-session', 'claude')
    await settle()
    emit('session/event', claude, { type: 'model/selection', data: { provider: 'claude', model: 'opus' } })
    await settle()
    expect((await world.sectionsOf(CLAUDE_WORLD))?.[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'claude', model: 'opus' })

    // The user opens a new conversation, which is a shared-world session.
    const created = session('cordis-session', { preset: 'cordis' })
    emit('session/created', created)
    await settle()

    expect(await world.activeWorld()).toBe(DEFAULT_WORLD)
    expect(settings.document['agent-default-model']).toEqual({ provider: 'opencode-go', model: 'deepseek-v4-flash' })
    expect(recorded).toEqual([{ id: 'cordis-session', selection: { provider: 'opencode-go', model: 'deepseek-v4-flash' } }])
    // The preset selection seeds the Claude session from the world it just
    // entered; the new session then gets the shared world's preset.
    expect(applied).toEqual(['workspace-write', 'workspace-write'])
    stop()
  })

  it('leaves a session that already has a model of its own alone', async () => {
    const settings = gateway({ 'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const installed: unknown[] = []
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyModel: (_agent, selection) => { installed.push(selection) },
    })
    // A resumed session carries the model the user chose inside it, which
    // outranks the world's default.
    const resumed = session('resumed', { preset: 'cordis', requestHeader: { config: { provider: 'p', model: 'm' } } })
    agents.set('resumed', { session: resumed })

    emit('session/created', resumed)
    await settle()
    expect(installed).toEqual([])
    stop()
  })

  it('leaves a session that has already run a turn alone when it is re-attached', async () => {
    // Every session is announced again when the Host attaches it, so the
    // creation path must not rewrite the document once per session at boot.
    const settings = gateway({ 'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const applied: string[] = []
    const { ctx, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyPermission: (_target, preset) => { applied.push(preset) },
    })
    emit('agent-preset/selected', 's1', 'claude')
    await settle()

    const old = session('old-cordis', { preset: 'cordis', turnBoundary: { openTurnStartSeq: null, lastTurn: 7 } })
    emit('session/created', old)
    await settle()
    expect(await world.activeWorld()).toBe(CLAUDE_WORLD)
    expect(applied).toEqual([])
    stop()
  })

  it('leaves the document alone for a delegated session', async () => {
    const settings = gateway({ 'agent-default-model': { provider: 'opencode-go', model: 'deepseek-v4-flash' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const { ctx, session, emit } = context()
    const stop = mount(ctx, { switch: worldSwitch })
    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    const child = session('subagent', { preset: 'cordis', depth: 1 })
    emit('session/created', child)
    await settle()
    // A delegated session inherits its parent's world; it must not drag the
    // document out from under the conversation the user is looking at.
    expect(await world.activeWorld()).toBe(CLAUDE_WORLD)
    stop()
  })

  it('applies the destination world permission only to a still-blank session', async () => {
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const applied: string[] = []
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyPermission: (_target, preset) => applied.push(preset),
    })
    const s1 = session('s1', { preset: 'claude' })
    agents.set('s1', { session: s1 })

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
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      applyPermission: (_target, preset) => applied.push(preset),
    })
    const s1 = session('s1', { preset: 'claude', turnBoundary: { openTurnStartSeq: null, lastTurn: 3 } })
    agents.set('s1', { session: s1 })

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
    const stop = mount(ctx, {
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

  it('records a permission change inside the world of the session that made it', async () => {
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, {
      switch: worldSwitch,
      permissionNameFor: mode => mode,
      writePermissionDefault: async () => undefined,
    })
    const claude = session('claude-session', { preset: 'claude' })
    const shared = session('shared-session', { preset: 'cordis' })
    agents.set('claude-session', { session: claude })
    agents.set('shared-session', { session: shared })

    emit('agent-preset/selected', 'claude-session', 'claude')
    await settle()
    emit('session/event', shared, { type: 'permission/preset', data: { preset: 'danger-full-access' } })
    await settle()

    expect((await world.sectionsOf(DEFAULT_WORLD))?.[PERMISSION_NS]).toEqual({ defaultPreset: 'danger-full-access' })
    expect((await world.sectionsOf(CLAUDE_WORLD))?.[PERMISSION_NS]).not.toEqual({ defaultPreset: 'danger-full-access' })
    stop()
  })

  it('does not record its own seeded permission as the user choice', async () => {
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const written: string[] = []
    const { ctx, agents, session, emit } = context()
    const s1 = session('s1', { preset: 'claude' })
    const stop = mount(ctx, {
      switch: worldSwitch,
      // Applying a permission appends the session event a real Host would,
      // which is exactly the echo that must not be recorded as a choice.
      applyPermission: (target, preset) => {
        emit('session/event', target, { type: 'sandbox/mode', data: { mode: preset } })
      },
      permissionNameFor: mode => mode,
      writePermissionDefault: async preset => { written.push(preset) },
    })
    agents.set('s1', { session: s1 })

    emit('agent-preset/selected', 's1', 'claude')
    await settle()
    expect(written).toEqual([])
    stop()
  })

  it('removes every subscription on dispose', async () => {
    const settings = gateway({ permission: { defaultPreset: 'ask' } })
    const world = await store()
    const worldSwitch = new ClaudeWorldSwitch({ settings, store: world })
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, { switch: worldSwitch })
    const s1 = session('s1', { preset: 'claude' })
    agents.set('s1', { session: s1 })
    stop()

    emit('agent-preset/selected', 's1', 'claude')
    emit('session/created', s1)
    emit('session/event', s1, { type: 'model/selection', data: { provider: 'claude', model: 'opus' } })
    await settle()
    expect(await world.activeWorld()).toBe(DEFAULT_WORLD)
    expect(await world.sectionsOf(CLAUDE_WORLD)).toBeUndefined()
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
    const { ctx, agents, session, emit } = context()
    const stop = mount(ctx, { switch: worldSwitch, warn: m => warned.push(m) })
    const s1 = session('s1', { preset: 'claude' })
    agents.set('s1', { session: s1 })

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
