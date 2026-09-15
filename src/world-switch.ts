/**
 * The world switch: route the global settings document between the Claude
 * preset's world and every other preset's.
 *
 * Two directions, both driven by `agent-preset/selected`:
 *
 * - into Claude: install `claude`'s captured sections into the document.
 * - out of Claude: install `default`'s.
 *
 * A world that was never captured is seeded once from the document as it
 * stands, so a first-ever switch is a no-op that still records both, and
 * subsequent divergence is what the two worlds then preserve.
 *
 * The document is a projection of the active world, not the world's storage.
 * A world changes only through {@link ClaudeWorldSwitch.captureModel} and
 * {@link ClaudeWorldSwitch.capturePermission}, which a session-scoped choice
 * drives; the wiring attributes each choice to the world of the session that
 * made it. Reading the document back into a world is deliberately impossible:
 * the document is shared by every session, so a value written by a session of
 * another world (a new session composed under the default preset, for one) says
 * nothing about the world that owns the document, and capturing it is how one
 * world's model silently replaced the other's.
 *
 * @module dsh-claude/world-switch
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
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
  /** Positive evidence of what a switch installed, for the Host log. */
  log?: (message: string) => void
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

/** The namespaces a world carries. */
const ROUTED_NAMESPACES = [AGENT_DEFAULT_MODEL_NS, PERMISSION_NS] as const

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** The session-event payload a model choice carries, normalized to the
 *  selection type a world stores. Both fields are required: a half-specified
 *  selection must never be written into a world. */
export function modelSelectionOf(payload: unknown): ModelSelection | undefined {
  const section = plainObject(payload)
  if (section === undefined) return undefined
  const { provider, model, reasoningEffort } = section
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  if (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0) return { provider, model }
  return { provider, model, reasoningEffort } as ModelSelection
}

/**
 * Owns the global document's world membership.
 *
 * Every operation is serialized through one chain: two writes racing would
 * interleave a read, a modify, and a write against the same document.
 */
export class ClaudeWorldSwitch {
  readonly #settings: WorldSettingsGateway
  readonly #store: ClaudeWorldStore
  readonly #warn: (message: string) => void
  readonly #log: (message: string) => void
  #pending: Promise<unknown> = Promise.resolve()

  constructor(deps: WorldSwitchDependencies) {
    this.#settings = deps.settings
    this.#store = deps.store
    this.#warn = deps.warn ?? (() => undefined)
    this.#log = deps.log ?? (() => undefined)
  }

  /** Where the worlds are stored; surfaced so a boot line names the real path. */
  get storePath(): string {
    return this.#store.path
  }

  /** One world's captured sections, or `undefined` before it was ever captured. */
  sectionsOf(world: WorldId): Promise<Record<string, unknown> | undefined> {
    return this.#store.sectionsOf(world)
  }

  /** The world the document currently belongs to. */
  activeWorld(): Promise<WorldId> {
    return this.#store.activeWorld()
  }

  /** The document's current value for every namespace a world carries. */
  #liveSections(): Record<string, unknown> {
    const live: Record<string, unknown> = {}
    for (const ns of ROUTED_NAMESPACES) {
      const value = this.#settings.read(ns)
      if (value !== undefined) live[ns] = value
    }
    return live
  }

  /** Serialize work so two captures cannot lose each other's namespace. */
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#pending.catch(() => undefined).then(work)
    this.#pending = operation
    return operation
  }

  /**
   * Record the model the user chose inside one world.
   *
   * `world` is the world of the session the choice was made in, not the world
   * that happens to own the document: a session's choice belongs to its own
   * preset's world even while another world owns the document.
   */
  captureModel(world: WorldId, selection: ModelSelection | undefined): Promise<void> {
    if (selection === undefined) return Promise.resolve()
    return this.#serialize(async () => {
      await this.#store.captureIntoSelf(world, AGENT_DEFAULT_MODEL_NS, { ...selection })
      this.#log(`captured ${selection.provider}/${selection.model} into the ${world} world`)
    })
  }

  /** Record the permission preset the user chose inside one world. */
  capturePermission(world: WorldId, preset: string | undefined): Promise<void> {
    if (preset === undefined || preset.length === 0) return Promise.resolve()
    return this.#serialize(async () => {
      await this.#store.captureIntoSelf(world, PERMISSION_NS, { defaultPreset: preset })
      this.#log(`captured permission ${preset} into the ${world} world`)
    })
  }

  /**
   * Move the global document to `to`.
   *
   * The destination's captured sections are written every time, including when
   * the document already belongs to that world: the document can drift (any
   * session may write it), so a preset selection is also the moment it is
   * brought back in line with the world it claims to show.
   *
   * A destination never captured before is seeded from the document as it
   * stands, so the first switch to Claude does not blank the model or
   * permissions — Claude's world starts from where the user already was, and
   * subsequent divergence is what the two worlds then preserve. The world being
   * left is seeded the same way on its first departure, which is the only
   * moment the document still describes it.
   */
  switchTo(to: WorldId): Promise<SwitchOutcome> {
    return this.#serialize(async () => {
      const from = await this.#store.activeWorld()
      // Read the document once, before anything is installed: it is the only
      // source a world that was never captured can be seeded from, and after
      // the install below it no longer describes the outgoing world.
      const live = this.#liveSections()
      let target = await this.#store.sectionsOf(to)
      // A world that has never switched away from was never captured either —
      // an app that boots inside one only writes a world when it leaves it. Its
      // current value is the document as it stands, so seeding it here is what
      // keeps the first switch from recording Claude's values as the shared
      // world's the first time the user goes back.
      if (from !== to && await this.#store.sectionsOf(from) === undefined) {
        for (const [ns, value] of Object.entries(live)) await this.#store.capture(from, ns, value, to)
      }
      // A destination never captured before starts from the same place, so the
      // first switch to Claude does not blank the model or permissions:
      // Claude's world starts from where the user already was, and subsequent
      // divergence is what the two worlds then preserve.
      if (target === undefined) {
        for (const [ns, value] of Object.entries(live)) await this.#store.capture(to, ns, value, to)
        target = live
      }
      const installed: string[] = []
      for (const ns of ROUTED_NAMESPACES) {
        const section = plainObject(target[ns])
        if (section === undefined) continue
        await this.#settings.write(ns, section)
        installed.push(ns)
      }
      // Ownership is recorded even when no routed namespace is registered: the
      // next switch has to know which document it is leaving.
      await this.#store.setActiveWorld(to)
      return { from, to, installed, sections: target }
    })
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
    for (const ns of ROUTED_NAMESPACES) {
      const section = plainObject(sections[ns])
      if (section === undefined) continue
      try {
        await this.#settings.write(ns, section)
      } catch (error) {
        this.#warn(`dsh-claude: could not restore the ${world} world's ${ns}: ${String(error)}`)
      }
    }
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
