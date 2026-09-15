/**
 * Bind the preset switch to the two-world store.
 *
 * Three jobs, all reversible through the Fiber:
 *
 * 1. `agent-preset/selected` is emitted for EVERY preset change, in both
 *    directions. The persisted selection is the authority, so a change into
 *    `claude` installs the Claude world and any change out of it restores the
 *    shared one. The event is not in the typed Host event map, so it is
 *    subscribed through a typed escape hatch (the existing precedent in
 *    `index.ts` for the same event).
 * 2. `settings/updated` refreshes the owning world, so a model or permission
 *    change made while Claude owns the document is written through immediately
 *    and the world never lags the live value.
 * 3. Boot recovery re-installs the recorded world, collapsing a switch that a
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
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-settings'
import { CLAUDE_CODE_PRESET_ID } from './constants.ts'
import { AGENT_DEFAULT_MODEL_NS, CLAUDE_WORLD, DEFAULT_WORLD, type WorldId } from './world-store.ts'
import { ClaudeWorldSwitch, routedNamespace, worldSettingsGateway } from './world-switch.ts'

/** The event name dsh-agent-presets emits for a committed preset selection. */
const PRESET_SELECTED_EVENT = 'agent-preset/selected'

export interface WorldWiringOptions {
  switch: ClaudeWorldSwitch
  /** Restore the destination world's permission preset onto a session that is
   *  still blank, so switching into Claude changes the permission the user
   *  sees rather than leaving the outgoing world's. */
  applyPermission?: (agent: Agent, preset: string) => void
  /** Install the destination world's model onto the session itself. A session
   *  answers from its own logged selection, so writing the settings document
   *  alone leaves the running model unchanged. */
  applyModel?: (agent: Agent, selection: ModelSelection) => void
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

/** One world's captured model selection, normalized to the provider/model pair
 *  a session event carries. Both fields are required: the settings schema
 *  demands them, and a half-specified selection must not be installed. */
function modelSelectionOf(section: unknown): ModelSelection | undefined {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return undefined
  const { provider, model, reasoningEffort } = section as {
    provider?: unknown
    model?: unknown
    reasoningEffort?: unknown
  }
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * A session is still switchable exactly while it has started no turn, which is
 * the same condition `agentPresets.select` enforces. Seeding a permission onto
 * a session past that boundary would append to a started session, so the check
 * is repeated here rather than assumed.
 */
function isStillBlank(ctx: Context, agent: Agent): boolean {
  try {
    const projections = ctx.get('sessionProjections') as {
      stateOf(session: unknown, key: string): unknown
    } | undefined
    const boundary = projections?.stateOf(agent.session, 'turnBoundary') as {
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
 * @param options - the switch plus the permission seam.
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

  const worldFor = (preset: string): WorldId => preset === CLAUDE_CODE_PRESET_ID ? CLAUDE_WORLD : DEFAULT_WORLD

  /** Sessions whose permission the wiring is currently moving to the
   *  destination world. Their `sandbox/mode` append is the move itself and must
   *  not be recorded as the user's new default. */
  const seeding = new Set<string>()

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
      if (agent === undefined) {
        options.log?.(`preset-selected session=${sessionId}: no composed agent to re-model yet`)
        return
      }
      // A session's model and permission are both session-local state, and both
      // outrank the global document a switch rewrites. Writing the world alone
      // therefore moves nothing the user sees: the session keeps answering from
      // its own `model/selection` and `sandbox/mode`. Each is applied to the
      // session directly, from the snapshot this switch installed rather than a
      // fresh store read — a re-read races the next switch and is what paired
      // one world's provider with another's model.
      //
      // The model is applied even when the world did not change, because "the
      // document already belongs to this world" says nothing about whether this
      // session does.
      const sections = outcome.sections
      const selection = modelSelectionOf(sections[AGENT_DEFAULT_MODEL_NS])
      if (selection !== undefined) {
        try {
          options.applyModel?.(agent, selection)
          options.log?.(`session ${sessionId} model -> ${selection.provider}/${selection.model} (${world} world)`)
        } catch (error) {
          warn(`dsh-claude: could not apply the ${world} world's model to the session: ${String(error)}`)
        }
      }
      // Permission is seedable only while the session has started no turn, the
      // same boundary `agentPresets.select` enforces.
      if (!isStillBlank(ctx, agent)) return
      const presetName = permissionPresetOf(sections.permission)
      if (presetName === undefined) return
      seeding.add(sessionId)
      try {
        options.applyPermission?.(agent, presetName)
      } finally {
        seeding.delete(sessionId)
      }
    })
  })

  const stopUpdated = ctx.on('settings/updated', (ns: string) => {
    if (!routedNamespace(ns)) return
    enqueue(() => options.switch.refresh())
  })

  // "The next session inherits the permission I chose" needs one write that
  // nothing currently makes: `permissionPresets.set` appends to the session log
  // only, while a new session's initial permission is read from the settings
  // `permission.defaultPreset`. Recording each permission change as that
  // default is what makes the choice outlive the session it was made in —
  // routed by `settings/updated`, which then captures it into the world that
  // owned the document at the time, so the two worlds keep separate defaults.
  // The session event that records a permission change is `sandbox/mode`, whose
  // type augmentation comes from the sandbox-policy package; this plugin
  // consumes the payload structurally rather than depending on that module.
  const stopSandbox = ctx.on('session/event', (session, event) => {
    const record = event as { type?: unknown; data?: { mode?: unknown } }
    if (record.type !== 'sandbox/mode') return
    const mode = record.data?.mode
    if (typeof mode !== 'string') return
    // Decide here, while the guard is still raised: the append is synchronous
    // but the work below is queued, and the guard is lowered by the time it
    // runs. A mode appended by our own seeding is that move, not a user choice,
    // and recording it would let a preset switch overwrite the default the user
    // actually picked.
    if (seeding.size > 0) return
    void session
    enqueue(async () => {
      const name = options.permissionNameFor?.(mode)
      if (name === undefined) return
      await options.writePermissionDefault?.(name)
    })
  })

  return () => {
    stopSelected()
    stopUpdated()
    stopSandbox()
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
