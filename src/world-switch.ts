/**
 * The world switch: route the global settings document between the Claude
 * preset's world and every other preset's.
 *
 * Two directions, both driven by `agent-preset/selected`:
 *
 * - into Claude: capture what the global document holds into `default`, then
 *   install `claude`. A world never captured before is seeded with the value
 *   it is replacing, so a first-ever switch is a no-op that still records both.
 * - out of Claude: capture into `claude`, then restore `default`.
 *
 * While a world owns the document, every later change to a routed namespace is
 * written through to that world (`refresh`), so the owning world always tracks
 * the live value rather than a stale snapshot.
 *
 * The one hazard is echo: installing a world writes settings, which emits
 * `settings/updated`, which would write straight back into that world. Every
 * such write is therefore held behind {@link ClaudeWorldSwitch.installing},
 * which keeps an installed value from being re-captured as if the user had
 * chosen it.
 *
 * @module dsh-claude/world-switch
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  AGENT_DEFAULT_MODEL_NS,
  CLAUDE_WORLD,
  ClaudeWorldStore,
  DEFAULT_WORLD,
  PERMISSION_NS,
  routableNamespace,
  type WorldId,
} from './world-store.ts'

/** The seam the switch needs from the runtime. Narrowed to what it uses so a
 *  test can drive the switch without a full Host. */
export interface WorldSettingsGateway {
  /** One registered namespace's resolved value, or `undefined` if unregistered. */
  read(ns: string): unknown
  /** Replace one namespace's stored section wholesale. */
  write(ns: string, section: object): Promise<void>
}

export interface WorldSwitchDependencies {
  settings: WorldSettingsGateway
  store: ClaudeWorldStore
  /** Diagnosed but non-fatal failures: a world switch must never fail a turn. */
  warn?: (message: string) => void
}

/** What one switch did, for logging and tests. */
export interface SwitchOutcome {
  from: WorldId
  to: WorldId
  /** Namespaces actually installed into the document. */
  installed: readonly string[]
  /** The destination world's captured sections, as installed. The caller
   *  applies per-session state from this snapshot rather than re-reading the
   *  store, so a later switch cannot make it read the wrong world. */
  sections: Record<string, unknown>
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Owns the global document's world membership.
 *
 * `install` is serialized: two switches racing would both read the same `from`
 * world and the second would capture the first's freshly installed value as if
 * it were the outgoing world, corrupting both.
 */
export class ClaudeWorldSwitch {
  readonly #settings: WorldSettingsGateway
  readonly #store: ClaudeWorldStore
  readonly #warn: (message: string) => void
  /** Set while a world is being installed, so the resulting `settings/updated`
   *  fan-out is not mistaken for a user edit and written back to the world it
   *  was just read from. */
  #installing = 0
  #pending: Promise<unknown> = Promise.resolve()

  constructor(deps: WorldSwitchDependencies) {
    this.#settings = deps.settings
    this.#store = deps.store
    this.#warn = deps.warn ?? (() => undefined)
  }

  /** Whether a settings change is ours rather than the user's. */
  get installing(): boolean {
    return this.#installing > 0
  }

  /** Where the worlds are stored; surfaced so a boot line names the real path. */
  get storePath(): string {
    return this.#store.path
  }

  /** One world's captured sections, or `undefined` before it was ever captured. */
  sectionsOf(world: WorldId): Promise<Record<string, unknown> | undefined> {
    return this.#store.sectionsOf(world)
  }

  /** Run `body` with the echo guard raised. */
  async #guarded<T>(body: () => Promise<T>): Promise<T> {
    this.#installing += 1
    try {
      return await body()
    } finally {
      this.#installing -= 1
    }
  }

  /**
   * Record one namespace's current value into the world that owns it.
   *
   * Called on every `settings/updated` for a routed namespace. A change raised
   * by our own install is ignored; otherwise the live value is exactly the
   * owning world's new value.
   */
  async refresh(): Promise<void> {
    if (this.installing) return
    const world = await this.#store.activeWorld()
    const sections: Record<string, unknown> = {}
    for (const ns of [AGENT_DEFAULT_MODEL_NS, PERMISSION_NS]) {
      const value = this.#settings.read(ns)
      if (value === undefined) continue
      sections[ns] = value
    }
    for (const [ns, value] of Object.entries(sections)) {
      await this.#store.capture(world, ns, value, world)
    }
  }

  /**
   * Move the global document to `to`, capturing the outgoing world first.
   *
   * A destination never captured before is seeded with the outgoing value, so
   * the first switch to Claude does not blank the model or permissions — it
   * starts Claude's world from where the user already was, and subsequent
   * divergence is what the two worlds then preserve.
   */
  switchTo(to: WorldId): Promise<SwitchOutcome> {
    const operation = this.#pending.catch(() => undefined).then(async () => {
      const from = await this.#store.activeWorld()
      // A repeat switch to the world already installed writes no document, but
      // it still reports that world's sections. The caller has to apply them to
      // its session, and that session may still be carrying the other world's
      // model; returning early with no sections left it stale, which is how a
      // preset could read "claude" while the session still held the shared
      // model. `installed: []` is what tells the caller nothing was written.
      if (from === to) {
        return { from, to, installed: [], sections: await this.#store.sectionsOf(to) ?? {} } as SwitchOutcome
      }
      const outgoing: Record<string, unknown> = {}
      for (const ns of [AGENT_DEFAULT_MODEL_NS, PERMISSION_NS]) {
        const value = this.#settings.read(ns)
        if (value !== undefined) outgoing[ns] = value
      }
      // Capture the outgoing world before installing anything, and record the
      // destination as active in the same write so a crash between the two
      // cannot leave ownership ambiguous.
      for (const [ns, value] of Object.entries(outgoing)) {
        await this.#store.capture(from, ns, value, to)
      }
      if (Object.keys(outgoing).length === 0) await this.#store.setActiveWorld(to)
      // A destination that was never captured starts as a copy of the outgoing
      // world, persisted so the two are independent from then on: later edits
      // made under either world must not move the other.
      const captured = await this.#store.sectionsOf(to)
      const target = captured ?? outgoing
      if (captured === undefined) {
        for (const [ns, value] of Object.entries(outgoing)) await this.#store.capture(to, ns, value, to)
      }
      const installed: string[] = []
      await this.#guarded(async () => {
        for (const ns of [AGENT_DEFAULT_MODEL_NS, PERMISSION_NS]) {
          const section = plainObject(target[ns])
          if (section === undefined) continue
          await this.#settings.write(ns, section)
          installed.push(ns)
        }
      })
      // The sections travel back with the outcome so the caller applies the
      // session's own model and permission from the exact snapshot this switch
      // installed. Re-reading them afterwards races the next switch, and that
      // race is what paired one world's provider with another's model.
      return { from, to, installed, sections: target } as SwitchOutcome
    })
    this.#pending = operation
    return operation
  }

  /**
   * Re-assert ownership at boot.
   *
   * A process that exited mid-switch leaves `activeWorld` pointing at a world
   * whose sections may never have been installed. Re-installing is idempotent
   * and is what makes a crash land on one coherent world instead of a blend.
   */
  async recover(): Promise<void> {
    const world = await this.#store.activeWorld()
    const sections = await this.#store.sectionsOf(world)
    if (sections === undefined) return
    await this.#guarded(async () => {
      for (const ns of [AGENT_DEFAULT_MODEL_NS, PERMISSION_NS]) {
        const section = plainObject(sections[ns])
        if (section === undefined) continue
        try {
          await this.#settings.write(ns, section)
        } catch (error) {
          this.#warn(`dsh-claude: could not restore the ${world} world's ${ns}: ${String(error)}`)
        }
      }
    })
  }
}

/** The preset id whose world the switch owns. */
export { CLAUDE_WORLD, DEFAULT_WORLD }

/** Bind the switch's settings seam to a live Cordis context. */
export function worldSettingsGateway(ctx: Context): WorldSettingsGateway {
  const settings = ctx.get('settings')
  return {
    read(ns) {
      return settings?.get(ns as never)
    },
    async write(ns, section) {
      if (settings === undefined) return
      await settings.replace(ns as never, section)
    },
  }
}

/** Whether a `settings/updated` namespace is one the switch routes. */
export function routedNamespace(ns: string): boolean {
  return routableNamespace(ns)
}
