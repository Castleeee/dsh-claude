/**
 * Bind the preset switch to the two-world store.
 *
 * Four jobs, all reversible through the Fiber:
 *
 * 1. `agent-preset/selected` is emitted for EVERY preset change, in both
 *    directions. The persisted selection is the authority, so a change into
 *    `claude` installs the Claude world and any change out of it restores the
 *    shared one. The event is not in the typed Host event map, so it is
 *    subscribed through a typed escape hatch (the existing precedent in
 *    `index.ts` for the same event).
 * 2. A session-scoped model or permission choice is captured into the world of
 *    the session that made it, read from that session's preset projection. The
 *    world that owns the document is explicitly NOT the criterion: the document
 *    is shared by every session, so a session belonging to another world can
 *    write it, and attributing such a write to the owning world is what once
 *    let the shared model replace Claude's.
 * 3. `session/created` moves the document to the new session's own world. A
 *    brand-new session composes its model and permission from the document
 *    (`agentDefaultModel.currentSelection()` and
 *    `permissionPresets.pinInitialPermission`), so a session created while the
 *    other world owned it would otherwise open with that world's model and
 *    permission despite belonging to its own.
 * 4. Boot recovery re-installs the recorded world, collapsing a switch that a
 *    crash interrupted.
 *
 * The emitted callback is synchronous while the work is asynchronous, so each
 * change is queued and failures are contained: a world switch must never fail
 * the user's preset change.
 *
 * @module dsh-claude/world-wiring
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-settings'
import { CLAUDE_CODE_PRESET_ID, CLAUDE_CODE_PROVIDER_IDS } from './constants.ts'
import { AGENT_DEFAULT_MODEL_NS, CLAUDE_WORLD, DEFAULT_WORLD, PERMISSION_NS, type WorldId } from './world-store.ts'
import { ClaudeWorldSwitch, modelSelectionOf, worldSettingsGateway, type SwitchOutcome } from './world-switch.ts'

/** The event name dsh-agent-presets emits for a committed preset selection. */
const PRESET_SELECTED_EVENT = 'agent-preset/selected'

export interface WorldWiringOptions {
  switch: ClaudeWorldSwitch
  /** Whether a provider route is one this package serves.
   *
   *  The two worlds are separated by *capability*, not by model: what a world
   *  cannot run is whatever route this package's adapter does not answer. That
   *  set is what the adapter was registered with, so the caller answers from
   *  the same list it registered — a route added there is covered the day it
   *  appears, and nothing here has to guess from the shared registry, which
   *  lists every other plugin's providers too and cannot say which are ours. */
  ownsRoute: (provider: string) => boolean
  /** Restore the destination world's permission preset onto a session that is
   *  still blank, so switching into Claude changes the permission the user
   *  sees rather than leaving the outgoing world's. */
  applyPermission?: (session: Session, preset: string) => void
  /** Install the destination world's model onto the session itself. A session
   *  answers from its own logged selection, so writing the settings document
   *  alone leaves the running model unchanged. */
  applyModel?: (agent: Agent, selection: ModelSelection) => void
  /** Pin a model onto a session that has no live Agent to install it on yet, by
   *  appending the same session event the Host's own picker appends. Without
   *  it a session composed after the correction would still resolve from the
   *  document, which is the value being corrected. */
  recordModelSelection?: (session: Session, selection: ModelSelection) => void
  /** Resolve a sandbox mode to the permission-preset name that bundles it, or
   *  `undefined` when no configured preset matches. */
  permissionNameFor?: (sandboxMode: string) => string | undefined
  /** Record the chosen preset as the default for sessions created later. */
  writePermissionDefault?: (preset: string) => Promise<void>
  /** Positive evidence that a switch ran; the log is the only place a live
   *  process shows whether the wiring is doing anything at all. */
  log?: (message: string) => void
  warn?: (message: string) => void
}

/** One namespace's default permission preset inside a world's captured
 *  `permission` section, or `undefined` when the world never captured one. */
function permissionPresetOf(section: unknown): string | undefined {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return undefined
  const value = (section as { defaultPreset?: unknown }).defaultPreset
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The world one preset belongs to. */
function worldFor(preset: string): WorldId {
  return preset === CLAUDE_CODE_PRESET_ID ? CLAUDE_WORLD : DEFAULT_WORLD
}

/**
 * A session is still switchable exactly while it has started no turn, which is
 * the same condition `agentPresets.select` enforces. Seeding a permission onto
 * a session past that boundary would append to a started session, so the check
 * is repeated here rather than assumed.
 */
function isStillBlank(ctx: Context, session: Session): boolean {
  try {
    const projections = ctx.get('sessionProjections') as {
      stateOf(session: unknown, key: string): unknown
    } | undefined
    const boundary = projections?.stateOf(session, 'turnBoundary') as {
      openTurnStartSeq?: number | null
      lastTurn?: number
    } | undefined
    if (boundary === undefined) return true
    return boundary.openTurnStartSeq === null && (boundary.lastTurn ?? 0) === 0
  } catch {
    return false
  }
}

/**
 * Install the world a preset change selects, and keep the worlds current.
 * @param ctx - the plugin's host context, used for events and its life cycle.
 * @param options - the switch plus the session-facing seams.
 * @returns a disposer removing every subscription.
 */
export function mountWorldWiring(ctx: Context, options: WorldWiringOptions): () => void {
  const warn = options.warn ?? (message => { ctx.logger.warn(message) })
  const queue: Promise<unknown> = Promise.resolve()
  let chain = queue

  /** Serialize switch work: two preset changes must not interleave their
   *  captures, and a failure must not poison the next change. */
  const enqueue = (work: () => Promise<void>): void => {
    chain = chain.then(work).catch(error => {
      warn(`dsh-claude: world switch failed: ${String(error)}`)
    })
  }

  const projections = (): { stateOf(session: unknown, key: string): unknown } | undefined =>
    ctx.get('sessionProjections') as { stateOf(session: unknown, key: string): unknown } | undefined

  /** The preset a session currently belongs to, or `undefined` when the
   *  projection cannot say. Read for every session-scoped choice: it is what
   *  decides which world the choice is recorded in. */
  const presetOf = (session: unknown): string | undefined => {
    try {
      const value = projections()?.stateOf(session, 'agentPreset')
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The world a session-scoped choice belongs to.
   *
   * A session whose preset cannot be read falls back to the world that owns the
   * document — the pre-existing behaviour, and correct for the common case
   * where the acting session is the one that made the document follow it. The
   * fallback is logged because a silent one would be indistinguishable from the
   * attribution this exists to make.
   */
  const worldOfSession = (session: unknown, active: WorldId): WorldId => {
    const preset = presetOf(session)
    if (preset === undefined) {
      options.log?.(`no agent-preset projection for a session choice; recording it in the ${active} world`)
      return active
    }
    return worldFor(preset)
  }

  /** Whether a session already carries a model selection of its own. Only a
   *  session without one may be re-pointed at its world's model: a resumed
   *  session's own choice outranks the world's default. */
  const hasOwnSelection = (session: unknown): boolean => {
    try {
      const state = projections()?.stateOf(session, 'modelSelection') as { pending?: unknown } | undefined
      if (state?.pending !== null && state?.pending !== undefined) return true
    } catch {
      return true
    }
    try {
      const header = (session as { requestHeader?(): unknown }).requestHeader?.()
      return header !== undefined
    } catch {
      return true
    }
  }

  /** Sessions whose permission the wiring is setting itself. Their events are
   *  the move, not the user's choice, and recording one would let a world
   *  switch overwrite the default the user actually picked.
   *
   *  Keyed by session and consulted when the queued work RUNS rather than when
   *  the event arrives, because the Host pins a new session's permission during
   *  creation — before this wiring hears about the session at all. Those appends
   *  are already queued by the time the session's own world is known, and they
   *  carry the OTHER world's preset: the document they were read from is the one
   *  this wiring is about to replace. A flag checked at arrival time could not
   *  see them. */
  const seeding = new Set<string>()

  /** Whether a session's own events are the wiring's work rather than a choice. */
  const isSeeding = (session: unknown): boolean => {
    const id = (session as { id?: unknown } | undefined)?.id
    return typeof id === 'string' && seeding.has(id)
  }

  /**
   * Apply one world's captured state to a session.
   *
   * `overwrite` decides what a session's own selection is worth. A preset
   * change is the user moving the session between worlds, so the destination's
   * model replaces whatever the session held — that is the whole point of the
   * switch, and skipping it when the session has a selection of its own is what
   * left the composer showing the outgoing world's model. A session being
   * created has no choice to respect, but a session the Host is re-attaching
   * does, and that one is left alone.
   */
  const applyWorldToSession = (session: Session, world: WorldId, sections: Record<string, unknown>, overwrite: boolean): void => {
    const selection = modelSelectionOf(sections[AGENT_DEFAULT_MODEL_NS])
    if (selection !== undefined && (overwrite || !hasOwnSelection(session))) {
      const agent = ctx.agents.get(session.id as never)
      try {
        if (agent === undefined) options.recordModelSelection?.(session, selection)
        else options.applyModel?.(agent, selection)
        options.log?.(`session ${session.id} model -> ${selection.provider}/${selection.model} (${world} world)`)
      } catch (error) {
        warn(`dsh-claude: could not apply the ${world} world's model to the session: ${String(error)}`)
      }
    }
    if (!isStillBlank(ctx, session)) return
    const presetName = permissionPresetOf(sections[PERMISSION_NS])
    if (presetName === undefined) return
    seeding.add(session.id)
    try {
      options.applyPermission?.(session, presetName)
    } finally {
      seeding.delete(session.id)
    }
  }

  const onPresetSelected = ctx.on as (
    event: typeof PRESET_SELECTED_EVENT,
    handler: (sessionId: string, preset: string) => void,
  ) => () => void

  const stopSelected = onPresetSelected(PRESET_SELECTED_EVENT, (sessionId, preset) => {
    const world = worldFor(preset)
    // One line per selection EVENT, before anything is decided: a switch back to
    // the world already installed writes no document and would otherwise leave
    // no trace, so a reader reconstructing "I switched back and forth a few
    // times" would see holes exactly where the interesting sequence is.
    options.log?.(`preset-selected session=${sessionId} preset="${preset}" world=${world}`)
    enqueue(async () => {
      const outcome = await options.switch.switchTo(world)
      // The only evidence a switch happened is this line and the store file:
      // a preset change that silently does nothing is otherwise invisible,
      // which is what makes "the model did not follow" so hard to place.
      if (outcome.from !== outcome.to) {
        options.log?.(`configuration world ${outcome.from} -> ${outcome.to} for preset "${preset}" (installed: ${outcome.installed.join(', ') || 'none'})`)
      }
      const agent = ctx.agents.get(sessionId as never)
      // A session the Host has not composed yet still has to be re-pointed: the
      // preset change is what the user just made, and its own logged selection
      // outranks the document this switch rewrote. Composing one just to reach
      // it would race the creation that is already in flight, so the session's
      // own event is appended instead.
      const session = (agent?.session ?? ctx.sessions.get(sessionId as never)) as Session | undefined
      if (session === undefined) {
        options.log?.(`preset-selected session=${sessionId}: no session to re-model yet`)
        return
      }
      // A session's model and permission are both session-local state, and both
      // outrank the global document a switch rewrites. Writing the world alone
      // therefore moves nothing the user sees: the session keeps answering from
      // its own `model/selection` and `sandbox/mode`. Each is applied to the
      // session directly, from the snapshot this switch installed rather than a
      // fresh store read — a re-read races the next switch and is what paired
      // one world's provider with another's model.
      applyWorldToSession(session, world, outcome.sections, true)
    })
  })

  // A session-scoped choice is the ONLY thing that moves a world. The document
  // is deliberately not consulted: it is shared by every session, so its value
  // says nothing about which world a change came from.
  const stopEvents = ctx.on('session/event', (session, event) => {
    const record = event as { type?: unknown; data?: unknown }
    // Whether this append is the wiring's own work, read twice on purpose. An
    // append raised by our own seeding arrives while the guard is up, but the
    // guard is lowered by the time the queued work runs; an append the Host
    // makes while creating a session arrives BEFORE the guard is raised, and is
    // only recognisable once it is. Either way the append is the move itself,
    // not the user's choice.
    const seedingAtArrival = isSeeding(session)
    if (record.type === 'model/selection') {
      const selection = modelSelectionOf(record.data)
      if (selection === undefined) return
      enqueue(async () => {
        if (seedingAtArrival || isSeeding(session)) return
        const active = await options.switch.activeWorld()
        const world = worldOfSession(session, active)
        // Whether this package can run the route. `ownsRoute` answers from the
        // routes this package's adapter was registered for, which is the only
        // set that separates the two worlds: a route this package does not
        // answer is one the Claude preset rewrites to its own provider anyway.
        const runnable = options.ownsRoute(selection.provider)
        // The two worlds are separated by capability, and a selection that
        // crosses the line is un-runnable wherever it lands. A Claude route
        // cannot run outside the Claude preset — this package's adapter is the
        // only thing that serves it — and the Claude preset cannot run a foreign
        // route either, because Claude Code owns its inner loop and bridges only
        // its own registered models. Either way the value can only have arrived
        // from the other world (a picker still showing it, a remembered model, a
        // session that has since left). It is not this world's choice: put the
        // session back on its own world's model instead of recording it.
        //
        // Correcting the foreign-to-Claude direction here is what keeps the
        // composer and the session agreeing; left to request time, the picker
        // went on advertising a model the next turn silently replaced.
        const foreign = world === CLAUDE_WORLD ? !runnable : runnable
        if (foreign) {
          const sections = await options.switch.sectionsOf(world)
          const own = modelSelectionOf(sections?.[AGENT_DEFAULT_MODEL_NS])
          options.log?.(`session ${session.id} was handed ${selection.provider}/${selection.model}, which the ${world} world cannot route; restoring ${own?.provider ?? 'its own'}/${own?.model ?? 'model'}`)
          // Only a value this world can actually run is worth reinstating; a
          // store that never captured one leaves the session where it is.
          if (own !== undefined && options.ownsRoute(own.provider) === (world === CLAUDE_WORLD)) {
            applyWorldToSession(session as Session, world, sections ?? {}, true)
          }
          return
        }
        await options.switch.captureModel(world, selection)
      })
      return
    }
    if (record.type === 'permission/preset') {
      const preset = (record.data as { preset?: unknown } | undefined)?.preset
      if (typeof preset !== 'string' || preset.length === 0) return
      enqueue(async () => {
        if (seedingAtArrival || isSeeding(session)) return
        const active = await options.switch.activeWorld()
        const world = worldOfSession(session, active)
        await options.switch.capturePermission(world, preset)
        // The document's default is what a new session is pinned with, so it
        // follows the world that owns the document rather than a session that
        // merely happens to be open.
        if (world === active) await options.writePermissionDefault?.(preset)
      })
      return
    }
    if (record.type !== 'sandbox/mode') return
    const mode = (record.data as { mode?: unknown } | undefined)?.mode
    if (typeof mode !== 'string') return
    enqueue(async () => {
      if (seedingAtArrival || isSeeding(session)) return
      const preset = options.permissionNameFor?.(mode)
      if (preset === undefined) return
      const active = await options.switch.activeWorld()
      const world = worldOfSession(session, active)
      await options.switch.capturePermission(world, preset)
      if (world === active) await options.writePermissionDefault?.(preset)
    })
  })

  // A session's model and permission are both composed from the document, so a
  // session created while another world owned it would open with that world's
  // values. Moving the document to the new session's own world first makes the
  // composition correct rather than correcting it afterwards; the explicit
  // apply below then covers a session the Host already composed.
  //
  // Only a session with nothing of its own is touched. A session the Host is
  // re-attaching — every resumed session at boot — already answers from its own
  // logged selection and permission, and moving the document for those would
  // rewrite the settings document once per session for a value none of them
  // reads.
  const stopCreated = ctx.on('session/created', (session) => {
    if (delegationDepthOf(session) > 0) return
    const preset = presetOf(session)
    if (preset === undefined) return
    if (hasOwnSelection(session) || !isStillBlank(ctx, session)) return
    const world = worldFor(preset)
    // Raised synchronously, before the queued work: the Host pins this session's
    // permission from the document as part of the same creation, and those
    // appends are already queued when this listener runs. They carry the
    // outgoing world's preset and must not be captured anywhere until the
    // session's own world has been installed below.
    seeding.add(session.id)
    enqueue(async () => {
      try {
        let outcome: SwitchOutcome | undefined
        if (await options.switch.activeWorld() !== world) {
          outcome = await options.switch.switchTo(world)
          options.log?.(`configuration world ${outcome.from} -> ${outcome.to} for new session ${session.id} (${preset})`)
        }
        const sections = outcome?.sections ?? await options.switch.sectionsOf(world)
        if (sections === undefined) return
        applyWorldToSession(session, world, sections, false)
      } finally {
        seeding.delete(session.id)
      }
    })
  })

  return () => {
    stopSelected()
    stopEvents()
    stopCreated()
  }
}

/** How deep a session sits below the user's own conversation. Read
 *  structurally: a delegated session inherits its parent's world and must not
 *  move the document out from under the user's. */
function delegationDepthOf(session: unknown): number {
  try {
    const depth = (session as { header?: { delegationDepth?: unknown } }).header?.delegationDepth
    return typeof depth === 'number' ? depth : 0
  } catch {
    return 0
  }
}

/** Whether the recorded world needs re-installing at boot. */
export async function recoverWorldAtBoot(
  worldSwitch: ClaudeWorldSwitch,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await worldSwitch.recover()
  } catch (error) {
    warn(`dsh-claude: could not restore the recorded configuration world: ${String(error)}`)
  }
}

export { worldSettingsGateway }
