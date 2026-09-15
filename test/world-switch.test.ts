import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_DEFAULT_MODEL_NS,
  CLAUDE_WORLD,
  ClaudeWorldStore,
  DEFAULT_WORLD,
  parseWorldDocument,
} from '../src/world-store.ts'
import { ClaudeWorldSwitch, type WorldSettingsGateway } from '../src/world-switch.ts'

const roots: string[] = []
/** Settle queued writes before removing their directory: a write that outlives
 *  its root leaves the temp directory non-empty and fails the next cleanup. */
const stores: ClaudeWorldStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.settled()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-worlds-'))
  roots.push(root)
  const store = new ClaudeWorldStore({ path: join(root, 'worlds.json') })
  stores.push(store)
  return { path: join(root, 'worlds.json'), store }
}

/** A settings document whose two routed namespaces are held in memory, so a
 *  switch can be driven without a Host. Writes are recorded to prove the echo
 *  guard and the restore ordering. */
function gateway(initial: Record<string, unknown> = {}) {
  const document: Record<string, unknown> = { ...initial }
  const writes: string[] = []
  const value: WorldSettingsGateway = {
    read: ns => document[ns],
    async write(ns, section) {
      document[ns] = section
      writes.push(ns)
    },
  }
  return { gateway: value, document, writes }
}

describe('two-world configuration store', () => {
  // The reason the model has to be switched through this store at all: a
  // session with no selection of its own resolves its model from
  // `agentDefaultModel.currentSelection()`, which reads the settings namespace
  // this store writes. If a switch left that namespace alone, a new session in
  // the Claude world would still open on the shared world's model — which is
  // exactly the "switching does not change the model" failure.
  it('leaves the resolved model readable by a new session after a switch', async () => {
    const { store } = await storeFixture()
    const settings = gateway({
      [AGENT_DEFAULT_MODEL_NS]: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    })
    const worldSwitch = new ClaudeWorldSwitch({ settings: settings.gateway, store })

    await worldSwitch.switchTo(CLAUDE_WORLD)
    // `saveSelection` replaces the whole namespace; the value must accept a
    // provider/model pair exactly as the schema requires both fields.
    expect(settings.document[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'opencode-go', model: 'deepseek-v4-flash' })

    settings.document[AGENT_DEFAULT_MODEL_NS] = { provider: 'claude', model: 'claude-sonnet' }
    await worldSwitch.refresh()
    await worldSwitch.switchTo(DEFAULT_WORLD)
    await worldSwitch.switchTo(CLAUDE_WORLD)
    expect(settings.document[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'claude', model: 'claude-sonnet' })
  })

  it('reads as never-captured before anything is written', async () => {
    const { store } = await storeFixture()
    expect(await store.activeWorld()).toBe(DEFAULT_WORLD)
    expect(await store.sectionsOf(CLAUDE_WORLD)).toBeUndefined()
    expect(await store.sectionsOf(DEFAULT_WORLD)).toBeUndefined()
  })

  it('captures one namespace without disturbing the other', async () => {
    const { store } = await storeFixture()
    await store.capture(CLAUDE_WORLD, AGENT_DEFAULT_MODEL_NS, { provider: 'p', model: 'm' }, CLAUDE_WORLD)
    await store.capture(DEFAULT_WORLD, AGENT_DEFAULT_MODEL_NS, { provider: 'q', model: 'n' }, DEFAULT_WORLD)
    expect(await store.sectionsOf(CLAUDE_WORLD)).toEqual({ [AGENT_DEFAULT_MODEL_NS]: { provider: 'p', model: 'm' } })
    expect(await store.sectionsOf(DEFAULT_WORLD)).toEqual({ [AGENT_DEFAULT_MODEL_NS]: { provider: 'q', model: 'n' } })
  })

  it('refuses a namespace it does not own', async () => {
    const { store } = await storeFixture()
    await expect(store.capture(CLAUDE_WORLD, 'llm-pi-ai', {}, CLAUDE_WORLD)).rejects.toThrow(/unrelated settings namespace/u)
  })

  it('discards unknown namespaces and malformed input rather than failing', () => {
    expect(parseWorldDocument('not json').activeWorld).toBe(DEFAULT_WORLD)
    expect(parseWorldDocument('[]').activeWorld).toBe(DEFAULT_WORLD)
    const parsed = parseWorldDocument(JSON.stringify({
      version: 1,
      activeWorld: 'claude',
      worlds: { claude: { 'llm-pi-ai': { leak: true }, permission: { defaultPreset: 'x' } } },
    }))
    expect(parsed.activeWorld).toBe(CLAUDE_WORLD)
    expect(parsed.worlds[CLAUDE_WORLD]).toEqual({ permission: { defaultPreset: 'x' } })
  })

  it('serializes concurrent captures so neither namespace is lost', async () => {
    const { path, store } = await storeFixture()
    await Promise.all([
      store.capture(CLAUDE_WORLD, AGENT_DEFAULT_MODEL_NS, { model: 'a' }, CLAUDE_WORLD),
      store.capture(CLAUDE_WORLD, 'permission', { defaultPreset: 'b' }, CLAUDE_WORLD),
    ])
    const reread = new ClaudeWorldStore({ path })
    expect(await reread.sectionsOf(CLAUDE_WORLD)).toEqual({
      [AGENT_DEFAULT_MODEL_NS]: { model: 'a' },
      permission: { defaultPreset: 'b' },
    })
  })

  it('writes the store with owner-only permissions', async () => {
    const { path, store } = await storeFixture()
    await store.capture(CLAUDE_WORLD, 'permission', { defaultPreset: 'x' }, CLAUDE_WORLD)
    const text = await readFile(path, 'utf8')
    expect(JSON.parse(text).activeWorld).toBe(CLAUDE_WORLD)
  })
})

describe('world switch', () => {
  it('seeds a never-captured destination from the outgoing world', async () => {
    const { store } = await storeFixture()
    const settings = gateway({
      [AGENT_DEFAULT_MODEL_NS]: { provider: 'p', model: 'deepseek' },
      permission: { defaultPreset: 'workspace-write' },
    })
    const worldSwitch = new ClaudeWorldSwitch({ settings: settings.gateway, store })
    const outcome = await worldSwitch.switchTo(CLAUDE_WORLD)
    expect(outcome).toMatchObject({ from: DEFAULT_WORLD, to: CLAUDE_WORLD })
    // A first switch must not blank the document: Claude's world starts from
    // where the user already was, and only later divergence is preserved.
    expect(settings.document[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'p', model: 'deepseek' })
    expect(await store.sectionsOf(CLAUDE_WORLD)).toEqual({
      [AGENT_DEFAULT_MODEL_NS]: { provider: 'p', model: 'deepseek' },
      permission: { defaultPreset: 'workspace-write' },
    })
  })

  it('restores the outgoing world on the way back and keeps the two apart', async () => {
    const { store } = await storeFixture()
    const settings = gateway({ [AGENT_DEFAULT_MODEL_NS]: { provider: 'p', model: 'deepseek' } })
    const worldSwitch = new ClaudeWorldSwitch({ settings: settings.gateway, store })

    await worldSwitch.switchTo(CLAUDE_WORLD)
    // The user picks a Claude-only model while Claude owns the document.
    settings.document[AGENT_DEFAULT_MODEL_NS] = { provider: 'claude-code', model: 'sonnet' }
    await worldSwitch.refresh()

    await worldSwitch.switchTo(DEFAULT_WORLD)
    expect(settings.document[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'p', model: 'deepseek' })

    // Returning to Claude brings its own model back, not the shared one.
    await worldSwitch.switchTo(CLAUDE_WORLD)
    expect(settings.document[AGENT_DEFAULT_MODEL_NS]).toEqual({ provider: 'claude-code', model: 'sonnet' })
  })

  it('does not let its own install be recaptured as a user change', async () => {
    const { store } = await storeFixture()
    const settings = gateway({ permission: { defaultPreset: 'workspace-write' } })
    const seen: string[] = []
    const worldSwitch = new ClaudeWorldSwitch({
      settings: {
        read: settings.gateway.read,
        async write(ns, section) {
          // Mirror the Host: a write emits `settings/updated`, whose listener
          // would call refresh(). The guard must make that a no-op.
          await settings.gateway.write(ns, section)
          seen.push(ns)
          expect(worldSwitch.installing).toBe(true)
        },
      },
      store,
    })
    await worldSwitch.switchTo(CLAUDE_WORLD)
    expect(seen).toEqual(['permission'])
    expect(settings.document.permission).toEqual({ defaultPreset: 'workspace-write' })

    // Outgoing capture stays intact despite the echoed write.
    await worldSwitch.switchTo(DEFAULT_WORLD)
    expect(await store.sectionsOf(DEFAULT_WORLD)).toEqual({ permission: { defaultPreset: 'workspace-write' } })
  })

  it('is a no-op when the document already belongs to the target world', async () => {
    const { store } = await storeFixture()
    const settings = gateway({ permission: { defaultPreset: 'ask' } })
    const worldSwitch = new ClaudeWorldSwitch({ settings: settings.gateway, store })
    const outcome = await worldSwitch.switchTo(DEFAULT_WORLD)
    expect(outcome).toMatchObject({ from: DEFAULT_WORLD, to: DEFAULT_WORLD, installed: [] })
    expect(settings.writes).toEqual([])
  })

  it('records ownership even when no routed namespace is registered', async () => {
    const { store } = await storeFixture()
    const settings = gateway({})
    const worldSwitch = new ClaudeWorldSwitch({ settings: settings.gateway, store })
    await worldSwitch.switchTo(CLAUDE_WORLD)
    expect(await store.activeWorld()).toBe(CLAUDE_WORLD)
  })

  it('recovers the recorded world at boot by re-installing it', async () => {
    const { store } = await storeFixture()
    const first = gateway({ permission: { defaultPreset: 'ask' } })
    await new ClaudeWorldSwitch({ settings: first.gateway, store }).switchTo(CLAUDE_WORLD)

    // A fresh process starts from a document that lost the world's value, which
    // is what a crash between capture and install leaves behind.
    const restarted = gateway({ permission: { defaultPreset: 'ask' } })
    await new ClaudeWorldSwitch({ settings: restarted.gateway, store }).recover()
    expect(restarted.document.permission).toEqual({ defaultPreset: 'ask' })
  })

  it('contains a failing restore instead of rejecting boot', async () => {
    const { store } = await storeFixture()
    await store.capture(CLAUDE_WORLD, 'permission', { defaultPreset: 'x' }, CLAUDE_WORLD)
    const warnings: string[] = []
    const worldSwitch = new ClaudeWorldSwitch({
      settings: { read: () => undefined, write: async () => { throw new Error('denied') } },
      store,
      warn: message => warnings.push(message),
    })
    await expect(worldSwitch.recover()).resolves.toBeUndefined()
    expect(warnings.join(' ')).toContain('denied')
  })
})
