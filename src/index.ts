import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-permission-presets'
// Brings the `model/selection` SessionEventMap entry into scope: that event is
// declared by the session controller, which the Host mounts alongside this
// plugin, and appending it is how a session's own model is set.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { restoreSkippedHumanPrompt } from './inbox-recovery.ts'
import { CLAUDE_CODE_PRESET_ID, CLAUDE_CODE_PROVIDER_IDS, CLAUDE_STEERING_SERVICE } from './constants.ts'
import { CLAUDE_COMMANDS_SERVICE, projectClaudeCommands, type ClaudeAgentCommandService, type ClaudeCommandView } from './command-bridge.ts'
import { ClaudeSidecarRepository } from './sidecar.ts'
import { resolveClaudeExecutable } from './executable.ts'
import { ClaudeSupervisor, type ClaudeSteeringOutcome, type ClaudeSteeringService } from './supervisor.ts'
import { createClaudeCodeAdapter } from './adapter.ts'
import { ensureManagedPreset, ManagedPresetConflictError } from './preset-installer.ts'
import { applyClaudeSteering } from './steering.ts'
import { claudeBridgeDiagnostics, registerClaudeDoctorRoutes, type ClaudeBridgeDiagnostic } from './doctor-routes.ts'
import { registerClaudeProjectionRoute } from './projection-routes.ts'
import { RepositoryStatusService, type RepositoryStatus } from './repository-status.ts'
import type { ClaudeActivityEvent } from './events.ts'
import { comparablePath, RepositorySetupService } from './repository-setup.ts'
import { summarizeBranchSlug } from './branch-name.ts'
import { summarizeSessionTitle } from './session-title.ts'
import { RepositoryActionService } from './repository-actions.ts'
import { registerRepositorySetupRoute } from './repository-setup-routes.ts'
import { registerRepositoryActionRoute } from './repository-action-routes.ts'
import { PromptAssistService, registerClaudePromptNameRoute, registerClaudePromptRefineRoute, registerClaudePromptsRoute } from './prompts.ts'
import { PullRequestFeedbackService } from './pr-feedback.ts'
import { registerPullRequestFeedbackRoute } from './pr-feedback-routes.ts'
import { registerRepositoryStatusRoute } from './repository-status-routes.ts'
import { registerRepositoryFileRoute } from './repository-file-routes.ts'
import { JiraService } from './jira.ts'
import { registerJiraRoute } from './jira-routes.ts'
import { AskService } from './ask.ts'
import { registerAskRoute } from './ask-routes.ts'
import { registerReviewCommentRoute } from './review-comment-routes.ts'
import { registerPlanFeedbackRoute } from './plan-feedback-routes.ts'
import { registerClaudeClientDiagnosticsRoute } from './client-diagnostics-routes.ts'
import { registerClaudeRewindRoute } from './rewind-routes.ts'
import { registerClaudeFileRewindRoute } from './file-rewind-routes.ts'
import { registerClaudeTaskRoute } from './task-routes.ts'
import { restoreWorktreeTree } from './worktree-snapshot.ts'
import { linkedRepositoryShown, touchedFilePaths, touchedPullRequests, touchedRepositoryRoots } from './touched-repositories.ts'
import { SessionRootLedger } from './session-root-ledger.ts'
import { ReviewCommentStore } from './review-comments.ts'
import { registerClaudeUpdateRoutes } from './update-routes.ts'
import { claudeModelValue, probeClaudeModels } from './model-catalog.ts'
import { withElectronNodeRunner } from './windows-job-runner.ts'
import { normalizePlanUsage, probePlanUsage, recordPlanUsage } from './plan-usage.ts'
import { registerPlanUsageRoute } from './plan-usage-routes.ts'
import { readRenderMode, readSupervisorLimitOverrides, readWorktreeBranchPrefix, registerClaudeGlobalSettingsRoute } from './global-settings.ts'
import { ClaudeWorldStore, PERMISSION_NS } from './world-store.ts'
import { ClaudeWorldSwitch, worldSettingsGateway } from './world-switch.ts'
import { mountWorldWiring, recoverWorldAtBoot } from './world-wiring.ts'

export const name = 'llm-claude'
export const inject = ['llm', 'agents', 'agentPresets', 'commands', 'subprocess', 'approval', 'userQuestions', 'attachments', 'settings', 'permissionPresets', 'sessionController']

// The steering contract is published for the plugin that consumes it: the
// service name to look up, and the shape it can rely on.
export { CLAUDE_STEERING_SERVICE } from './constants.ts'
export type { ClaudeSteeringOutcome, ClaudeSteeringService } from './supervisor.ts'
import { ClaudeProcessLimitError, ClaudeTurnBusyError } from './supervisor.ts'

export interface Config {
  executablePath?: string
  model?: string
  idleTimeoutMs?: number
  maxProcesses?: number
  /** Override for the two-world store; a test points it at a temporary path. */
  worldsFile?: string
}

export const Config: z<Config> = z.object({
  executablePath: z.string().default(''),
  model: z.string().default('default'),
  idleTimeoutMs: z.number().min(1_000).max(2_147_483_647).default(30 * 60 * 1_000),
  maxProcesses: z.number().step(1).min(1).default(4),
  worldsFile: z.string(),
})

const CLAUDE_SCOPE_UNAVAILABLE_MESSAGE = 'agent command scope unavailable (preset route not mounted?)'
const CATALOG_RETRY_MS = 5_000
const SCOPE_RETRY_MS = 500
const MAX_CATALOG_RETRIES = 3
/** Bounded: each extra checkout costs a git chain and a `gh pr view` per sweep.
 *  A fan-out over every backend service is the largest real case. */
const MAX_EXTRA_REPOSITORIES = 12
const MAX_SCOPE_RETRIES = 24

export function mountClaudeMetadata(
  ctx: Context,
  supervisor: ClaudeSupervisor,
  agent: Agent,
  model: string,
  sidecar: ClaudeSidecarRepository,
  publishCommands: (commands: readonly ClaudeCommandView[]) => void = () => {},
  // IMPORTANT: call through the injected agentPresets SERVICE, never an
  // imported serviceForAgent() — a linked plugin resolves peer packages from
  // its own node_modules, which creates a second module instance with empty
  // module-level mount state. The service method runs on the app's instance.
  resolveCommands: () => ClaudeAgentCommandService | undefined =
    () => ctx.agentPresets.serviceFor(agent, CLAUDE_COMMANDS_SERVICE),
): (() => Promise<void>) | undefined {
  if (ctx.agentPresets.composedPreset(agent.ctx) !== CLAUDE_CODE_PRESET_ID) return undefined

  let stopped = false
  let pending = Promise.resolve()
  let commandScope: ClaudeAgentCommandService | undefined

  // The commands service is unreachable from this host view of agent.ctx;
  // the preset route plugin provides it as an isolated per-session service.
  const scopedCommands = () => {
    const scoped = commandScope ?? resolveCommands()
    if (scoped === undefined) throw new Error(CLAUDE_SCOPE_UNAVAILABLE_MESSAGE)
    commandScope = scoped
    return scoped
  }

  const commandTarget = {
    list: () => scopedCommands().list(agent),
  }

  const warn = (area: string, error: unknown) => {
    ctx.logger.warn(`dsh-claude: ${area} refresh failed for ${String(agent.id)}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /** A session that is mid-turn (or a process pool with no free slot) is not a
   *  failed refresh — it is a refresh that has to wait. The metadata lane
   *  deliberately refuses to disturb a running turn, and the idle transition
   *  that follows it runs this again, so warning and retrying here would fill
   *  the log for the whole length of every long turn. */
  const deferrable = (error: unknown): boolean =>
    error instanceof ClaudeTurnBusyError || error instanceof ClaudeProcessLimitError

  const isScopeUnavailable = (error: unknown): boolean => {
    if (error instanceof Error) return error.message === CLAUDE_SCOPE_UNAVAILABLE_MESSAGE
    return String(error) === CLAUDE_SCOPE_UNAVAILABLE_MESSAGE
  }

  const diagnostic: ClaudeBridgeDiagnostic = claudeBridgeDiagnostics.get(agent) ?? { attempts: 0 }
  claudeBridgeDiagnostics.set(agent, diagnostic)

  // A fresh session's first catalog fetch races CLI startup (skills/plugins
  // can make init slow); retry with backoff so the command palette still
  // populates without waiting for the first completed turn.
  let catalogRetries = 0
  let scopeRetries = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleRetry = (area: 'command catalog' | 'command scope', attempt: number) => {
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    const delay = area === 'command catalog' ? CATALOG_RETRY_MS * attempt : Math.min(SCOPE_RETRY_MS * 2 ** attempt, 5_000)
    retryTimer = setTimeout(() => {
      if (!stopped) refresh()
    }, delay)
    retryTimer.unref?.()
  }

  const refresh = () => {
    pending = pending.then(async () => {
      if (stopped) return
      diagnostic.attempts += 1

      let catalog: Awaited<ReturnType<ClaudeSupervisor['supportedCommands']>> | undefined

      try {
        const result = await supervisor.supportedCommands(agent, model)
        catalog = result
        catalogRetries = 0
        scopeRetries = 0
        diagnostic.lastCatalog = catalog.length
        delete diagnostic.lastError
      } catch (error) {
        diagnostic.lastError = error instanceof Error ? error.message : String(error)
        if (deferrable(error)) return
        warn('command catalog', error)
        if (!stopped && catalogRetries < MAX_CATALOG_RETRIES) {
          catalogRetries += 1
          scheduleRetry('command catalog', catalogRetries)
        }
      }

      if (stopped || catalog === undefined) return

      try {
        const commands = projectClaudeCommands(catalog, commandTarget)
        publishCommands(commands)
        diagnostic.registered = commands.map(view => view.publicName)
        if (!stopped) scopeRetries = 0
      } catch (error) {
        diagnostic.lastError = error instanceof Error ? error.message : String(error)
        warn('command catalog', error)
        if (!stopped && isScopeUnavailable(error) && scopeRetries < MAX_SCOPE_RETRIES) {
          scopeRetries += 1
          scheduleRetry('command scope', scopeRetries)
        }
      }

      if (stopped) return
      try {
        const usage = await supervisor.contextUsage(agent, model)
        if (!stopped) await sidecar.writeContextUsage(agent.id as string, usage)
      } catch (error) {
        if (!deferrable(error)) warn('context usage', error)
      }

      if (stopped) return
      // Plan limits belong to the account, not the session, so any idle Claude
      // agent can refresh the cache the (session-less) settings page reads.
      try {
        const plan = await supervisor.planUsage(agent, model)
        if (!stopped) recordPlanUsage(normalizePlanUsage(plan, Date.now()))
      } catch (error) {
        if (!deferrable(error)) warn('plan usage', error)
      }
    })
  }

  return agent.ctx.effect(() => {
    const stopStatus = agent.ctx.on('agent/status', ({ status }) => {
      if (status === 'idle') refresh()
    })

    // The loop claims a turn's opening prompt by position, so a plugin notice
    // that lands ahead of the arriving human message can take its slot and
    // leave the step with nothing human in it. That is fatal for this provider
    // alone: Claude's adapter sends exactly one direct human prompt and refuses
    // to invent one, while other providers simply receive the batch as prose.
    // Restoring the skipped prompt here keeps the mis-claim out of Claude's way
    // without changing what any other preset sees.
    const stopPreStep = agent.ctx.on('agent/pre-step', async ({ agent: subject, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const restored = restoreSkippedHumanPrompt(subject, decision.messages)
      return restored === decision.messages ? decision : { ...decision, messages: restored }
    }, { prepend: true })

    refresh()

    return async () => {
      stopped = true
      publishCommands([])
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      stopStatus()
      stopPreStep()
      await pending
    }
  }, 'dsh-claude: agent metadata bridge')
}

export async function installManagedPresetCompatibility(
  logger: Pick<Context['logger'], 'warn'>,
  install: typeof ensureManagedPreset = ensureManagedPreset,
): Promise<'installed' | 'unchanged' | 'conflict'> {
  try {
    return await install()
  } catch (error) {
    if (!(error instanceof ManagedPresetConflictError)) throw error
    logger.warn(`dsh-claude: preserving user-modified preset at ${error.path}`)
    return 'conflict'
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // Every subprocess this plugin starts goes through one runtime so the
  // Desktop 2.0.7 Windows Job runner workaround applies to all of them.
  const subprocess = withElectronNodeRunner(ctx.subprocess)
  // DSH Desktop 2.0.4 does not retain third-party preset roots from bundle
  // patches, so keep a guarded user-root copy. Its bare route specifier resolves
  // through the profile package factory and does not create a second Loader source.
  await installManagedPresetCompatibility(ctx.logger)
  const defaultLimits = {
    idleTimeoutMs: config.idleTimeoutMs ?? 30 * 60 * 1_000,
    maxProcesses: config.maxProcesses ?? 4,
  }
  const supervisorConfig = {
    executablePath: '',
    defaultModel: config.model ?? 'default',
    ...defaultLimits,
  }
  // Settings overrides win over the plugin config; the supervisor reads the
  // shared config object on every admission and idle schedule, so updates take
  // effect without a restart. The renderer is not kept here: the adapter reads
  // its file at the start of each turn and pins the answer to that turn, so
  // both halves of a turn -- the records the supervisor stamps and the blocks
  // the adapter streams -- agree about who is drawing it, and a settings file
  // edited outside the Settings dialog lands on the next turn all the same.
  const applySettingsOverrides = async (): Promise<void> => {
    const overrides = await readSupervisorLimitOverrides()
    supervisorConfig.idleTimeoutMs = overrides.idleTimeoutMs ?? defaultLimits.idleTimeoutMs
    supervisorConfig.maxProcesses = overrides.maxProcesses ?? defaultLimits.maxProcesses
  }
  await applySettingsOverrides()
  const sidecar = new ClaudeSidecarRepository()
  const repositoryStatus = new RepositoryStatusService(subprocess)
  const repositorySetup = new RepositorySetupService(subprocess, {
    branchPrefix: () => readWorktreeBranchPrefix(),
    // Read at call time: the executable is resolved after this service exists.
    summarizeBranch: intent => summarizeBranchSlug(supervisorConfig.executablePath, intent),
  })
  const reviewComments = new ReviewCommentStore()
  const commandCatalogs = new Map<string, readonly ClaudeCommandView[]>()
  const supervisor = new ClaudeSupervisor({
    runtime: subprocess,
    approval: ctx.approval,
    userQuestions: ctx.userQuestions,
    config: supervisorConfig,
    runDetached: operation => ctx.agents.withoutInitiator(operation),
    sidecar,
    // A CLI that dies mid-turn is diagnosed from the log, not from the
    // conversation it was in the middle of.
    logger: { warn: message => { ctx.logger.warn(message) } },
    // A steered message resolves its attachments through the same code path a
    // turn's own prompt does, so its image limits and file wording cannot drift.
    attachments: ctx.attachments,
  })
  let resolutionError: unknown
  try {
    const resolution = await resolveClaudeExecutable(
      subprocess,
      config.executablePath === undefined || config.executablePath.length === 0
        ? undefined
        : config.executablePath,
    )
    supervisorConfig.executablePath = resolution.path
    ctx.llm.registerAdapter(
      [...CLAUDE_CODE_PROVIDER_IDS],
      createClaudeCodeAdapter(supervisor, ctx.agents, ctx.attachments, agent => ctx.agentPresets.composedPreset(agent.ctx), sessionId => reviewComments.drain(sessionId), () => readRenderMode(), request => summarizeSessionTitle(supervisorConfig.executablePath, request), () => probeClaudeModels(supervisorConfig.executablePath)),
    )
    // Steering entry point. A message steered into a running Claude turn has to
    // pass through the supervisor that owns that turn's process; whoever takes it
    // out of the agent inbox calls this first, and `unavailable` tells them to
    // keep the message for a later turn instead of losing it.
    ctx.provide(CLAUDE_STEERING_SERVICE, {
      deliver: (sessionId, content) => supervisor.deliverSteering(sessionId, content),
    } satisfies ClaudeSteeringService)
    // The Claude preset owns a whole configuration world: while it is selected,
    // the global model and permission defaults are its own, and switching away
    // restores every other preset's untouched. Boot recovery runs before the
    // first turn so a crash mid-switch lands on one coherent world.
    const worldSwitch = new ClaudeWorldSwitch({
      settings: worldSettingsGateway(ctx),
      store: new ClaudeWorldStore(config.worldsFile === undefined ? {} : { path: config.worldsFile }),
      warn: message => { ctx.logger.warn(message) },
    })
    await recoverWorldAtBoot(worldSwitch, message => { ctx.logger.warn(message) })
    ctx.effect(() => mountWorldWiring(ctx, {
      switch: worldSwitch,
      // Permissions live in the session log rather than the settings document,
      // so installing a world does not move them. A still-blank session gets the
      // destination world's preset applied directly, which is what makes the
      // permission the user sees follow the preset switch.
      applyPermission: (agent, preset) => {
        try {
          ctx.permissionPresets.set(agent.session, preset)
        } catch (error) {
          ctx.logger.warn(`dsh-claude: could not apply the ${preset} permission preset: ${String(error)}`)
        }
      },
      // The model must be installed on the session itself, not only in the
      // settings document. A session answers from its own logged selection, and
      // the picker beside the composer reads that, so a switch that only
      // rewrote the document left the running model on the outgoing world's
      // value.
      //
      // It goes through the session controller rather than a bare
      // `agent.session.append`: recording the event alone moves what the
      // session SHOWS while the running agent keeps the model it was composed
      // with. The controller's own method is the one that also installs the
      // selection into the agent's next request assembly — which is the
      // difference between "the picker says v4-pro" and the turn actually
      // routing there. Without it, a session switched away from Claude still
      // reached the `claude` provider and died on this plugin's own preset
      // guard.
      applyModel: (agent, selection) => {
        // The same call the Host's own model picker makes, and the reason this
        // is a call rather than a bare `agent.session.append`:
        //
        //   append('model/selection', …)  records the choice,
        //   selectionFor(agent).current = …  INSTALLS it for the next request.
        //
        // Only the first half leaves the agent's request assembly reading the
        // session's last logged header. That is exactly what the Host log
        // showed: the switch wrote `opencode-go/…` on the session and the next
        // request still asked for `claude/…`, so the adapter refused with
        // "provider claude is available only to the claude preset" while the
        // picker displayed the new model. The controller's own path does both.
        const controller = ctx.sessionController as unknown as {
          selectModel(request: Record<string, unknown>): Promise<unknown>
        }
        void controller.selectModel({
          sessionId: agent.id,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }).then(
          () => {
            // Positive evidence of the one write a switch makes to the session.
            // The MISMATCH line in the adapter is its other half: this records
            // what was installed, that records what the agent then asked for.
            ctx.logger.info(`dsh-claude: applied model to session ${String(agent.id)} -> ${selection.provider}/${selection.model}`)
          },
          (error: unknown) => {
            ctx.logger.warn(`dsh-claude: could not install ${selection.provider}/${selection.model} on session ${String(agent.id)}: ${error instanceof Error ? error.message : String(error)}`)
          },
        )
      },
      // A sandbox-mode event names the mode, while the settings default stores
      // the preset that bundles it; resolve through the service's own table so
      // a deployment that renames or re-bundles presets stays consistent.
      permissionNameFor: sandboxMode => ctx.permissionPresets.names.find(name => {
        try {
          return ctx.permissionPresets.resolve(name).sandbox === sandboxMode
        } catch {
          return false
        }
      }),
      writePermissionDefault: async preset => {
        const settings = ctx.get('settings')
        if (settings === undefined) return
        await settings.update(PERMISSION_NS, { defaultPreset: preset })
      },
      log: message => { ctx.logger.info(`dsh-claude: ${message}`) },
      warn: message => { ctx.logger.warn(message) },
    }), 'dsh-claude: configuration worlds')
    ctx.logger.info(`dsh-claude: configuration worlds ready (store: ${worldSwitch.storePath})`)
    ctx.effect(() => {
      const mounted = new Map<Agent, () => Promise<void>>()
      const pending = new Set<Agent>()
      const MOUNT_RETRY_MS = 200
      const MOUNT_RETRY_LIMIT = 50
      const mount = (agent: Agent) => {
        if (mounted.has(agent)) return
        const sessionId = agent.id as string
        const dispose = mountClaudeMetadata(
          ctx,
          supervisor,
          agent,
          supervisorConfig.defaultModel,
          sidecar,
          commands => {
            if (commands.length === 0) commandCatalogs.delete(sessionId)
            else commandCatalogs.set(sessionId, commands)
          },
        )
        if (dispose !== undefined) mounted.set(agent, dispose)
        pending.delete(agent)
      }
      // The standing preset mount lands AFTER agent/created (the PresetTree is
      // applied asynchronously), so composedPreset is still undefined at that
      // point. Poll briefly until the join settles, then decide.
      const mountWhenPresetSettles = (agent: Agent) => {
        if (mounted.has(agent) || pending.has(agent)) return
        if (ctx.agentPresets.composedPreset(agent.ctx) !== undefined) {
          mount(agent)
          return
        }
        pending.add(agent)
        let attempts = 0
        const retry = () => {
          if (mounted.has(agent) || !pending.has(agent)) return
          if (ctx.agentPresets.composedPreset(agent.ctx) !== undefined) {
            mount(agent)
            return
          }
          attempts += 1
          if (attempts >= MOUNT_RETRY_LIMIT) {
            pending.delete(agent)
            return
          }
          const timer = setTimeout(retry, MOUNT_RETRY_MS)
          timer.unref?.()
        }
        const timer = setTimeout(retry, MOUNT_RETRY_MS)
        timer.unref?.()
      }
      const stopCreated = ctx.on('agent/created', ({ agent }) => { mountWhenPresetSettles(agent) })
      // Belt and suspenders: the session records its preset selection as a
      // durable event, which agent-presets republishes as agent-preset/selected.
      // agent-preset/selected is emitted by dsh-agent-presets but is not part
      // of the typed host event map yet; subscribe through a typed escape hatch.
      const onPresetSelected = ctx.on as (event: 'agent-preset/selected', handler: (sessionId: string, preset: string) => void) => () => void
      const stopSelected = onPresetSelected('agent-preset/selected', (sessionId, preset) => {
        if (preset !== CLAUDE_CODE_PRESET_ID) return
        const agent = ctx.agents.get(sessionId as never)
        if (agent !== undefined) mountWhenPresetSettles(agent)
      })
      for (const agent of ctx.agents.list()) mountWhenPresetSettles(agent)
      return async () => {
        stopCreated()
        stopSelected()
        pending.clear()
        await Promise.allSettled([...mounted.values()].map(dispose => dispose()))
        mounted.clear()
      }
    }, 'dsh-claude: metadata bridges')
  } catch (error) {
    resolutionError = error
  }
  ctx.on('agent/disposed', async ({ agent }) => {
    reviewComments.disposeSession(agent.id as string)
    await supervisor.disposeSession(agent.id as string)
  })
  // Set once the reconciliation below is wired; the Client's sweep route kicks
  // it so a deleted workspace does not wait out the interval.
  let sweepWorktrees: (() => void) | undefined
  // Deleting a workspace from the sidebar is a durable-registry mutation with
  // no agent lifecycle edge, so worktree cleanup reconciles leases against
  // the workspace registry instead: unreferenced clean worktrees are removed
  // on boot, on the Client's deletion kick, and on a slow interval.
  // workspaceRegistry is not part of this plugin's typed host surface yet;
  // inject through an untyped escape hatch so older Hosts without the service
  // simply never start the sweep.
  const injectWorkspaceRegistry = ctx.inject as unknown as (
    deps: readonly string[],
    callback: (sweepCtx: Context & {
      workspaceRegistry: {
        list(): readonly { readonly path: string }[]
        archiveSession(sessionId: string): Promise<void>
      }
    }) => void,
  ) => void
  injectWorkspaceRegistry(['workspaceRegistry'], sweepCtx => {
    // Deleting a workspace only drops its registration: the Host keeps every
    // session log, and rebuilds the workspace from those headers on the next
    // boot. Archiving the sessions that lived in the worktree is what makes
    // the deletion stick. Resolved per sweep rather than injected so a Host
    // without the service still gets worktree cleanup.
    const archiveSessions = async (worktreePath: string): Promise<void> => {
      const persistence = sweepCtx.get('sessionPersistence') as {
        list(): Promise<readonly { readonly id?: unknown; readonly cwd?: unknown }[]>
      } | undefined
      if (persistence === undefined) return
      const target = comparablePath(worktreePath)
      for (const header of await persistence.list()) {
        if (typeof header.id !== 'string' || typeof header.cwd !== 'string') continue
        if (comparablePath(header.cwd) !== target) continue
        await sweepCtx.workspaceRegistry.archiveSession(header.id).catch(() => undefined)
      }
    }
    const sweep = (): void => {
      try {
        const paths = sweepCtx.workspaceRegistry.list().map(workspace => workspace.path)
        void repositorySetup.cleanupOrphans(paths, archiveSessions).catch(() => undefined)
      } catch {
        // The registry can be mid-teardown; skip this pass.
      }
    }
    sweepCtx.effect(() => {
      sweep()
      sweepWorktrees = sweep
      // The kick covers the deletion the user is watching; this poll is the
      // backstop for a Client that never sent one. A pass with nothing to
      // reconcile is one small file read.
      const timer = setInterval(sweep, 60_000)
      timer.unref?.()
      return () => {
        sweepWorktrees = undefined
        clearInterval(timer)
      }
    }, 'dsh-claude: worktree reconciliation')
  })
  ctx.effect(() => () => reviewComments.dispose(), 'dsh-claude: review comments store')
  ctx.effect(() => () => supervisor.dispose(), 'dsh-claude: process supervisor')
  // Steering lives here rather than in a package of its own: it exists only to
  // close this plugin's own gap (a DSH turn is one adapter call, so the next
  // step boundary arrives only when the turn is over), and it needs the
  // `agents` and `agentPresets` this plugin already injects.
  applyClaudeSteering(ctx)
  ctx.effect(() => () => repositoryStatus.dispose(), 'dsh-claude: repository status cache')
  ctx.inject(['webServer'], webCtx => {
    registerClaudeClientDiagnosticsRoute(webCtx)
    registerClaudeDoctorRoutes(webCtx, subprocess, supervisor, supervisorConfig, resolutionError)
    const desktopActions = webCtx.get('desktopActions') as { requestRestart?: () => void } | undefined
    registerClaudeUpdateRoutes(webCtx, subprocess, {
      ...(typeof desktopActions?.requestRestart === 'function'
        ? { requestRestart: desktopActions.requestRestart.bind(desktopActions) }
        : {}),
    })
    registerClaudeGlobalSettingsRoute(webCtx, {
      defaultLimits,
      onUpdated: async () => {
        await applySettingsOverrides()
        supervisor.limitsChanged()
      },
    })
    /** Linked pull requests cleaned up, as `clone root + branch`: the log
     *  still names them, so the sweep has to be told to stop listing them. */
    const cleanedLinked = new Set<string>()
    registerRepositorySetupRoute(webCtx, repositorySetup, () => sweepWorktrees?.(), (path, branch) => {
      repositoryStatus.invalidate(path)
      if (branch !== undefined) cleanedLinked.add(`${path}\0${branch}`)
    })
    registerRepositoryStatusRoute(webCtx, repositoryStatus)
    registerRepositoryFileRoute(webCtx, repositoryStatus)
    registerJiraRoute(webCtx, new JiraService())
    const repositoryActions = new RepositoryActionService(subprocess, supervisorConfig.executablePath, cwd => repositoryStatus.invalidate(cwd))
    /** Checkouts besides its own a session's routes may act on: every root a
     *  projection sweep has ever vouched for, so a transient probe failure in
     *  one sweep does not un-authorise a linked bar the client still shows. */
    const extraRoots = new SessionRootLedger(MAX_EXTRA_REPOSITORIES * 4)
    const cwdForClaudeSession = (sessionId: string, root?: string): string | undefined => {
      const agent = webCtx.agents.get(sessionId as never)
      if (agent === undefined || webCtx.agentPresets.composedPreset(agent.ctx) !== CLAUDE_CODE_PRESET_ID) return undefined
      if (root === undefined) return agent.session.header.cwd
      return extraRoots.allows(sessionId, root) ? root : undefined
    }
    const extraRepositoriesForClaudeSession = async (sessionId: string, activities: readonly ClaudeActivityEvent[]): Promise<readonly RepositoryStatus[]> => {
      const cwd = cwdForClaudeSession(sessionId)
      if (cwd === undefined) return []
      const [own, ownStatus] = await Promise.all([repositoryStatus.rootOf(cwd), repositoryStatus.inspect(cwd)])
      const roots = await touchedRepositoryRoots(touchedFilePaths(activities), own ?? cwd, directory => repositoryStatus.rootOf(directory), MAX_EXTRA_REPOSITORIES)
      const probed = await Promise.all(roots.map(root => repositoryStatus.inspect(root)))
      const checkouts = probed.filter(linkedRepositoryShown)
      // Pull requests the log names that no linked checkout is sitting on any
      // more: the checkout moved on, the pull request did not. A clone of the
      // same repository the session went through, even one back on its base
      // branch, is still where gh can merge it or read its checks from.
      const covered = new Set(checkouts.map(status => `${status.remote?.toLowerCase()}#${status.pullRequest?.number}`))
      const pullRequests = touchedPullRequests(activities, ownStatus.remote)
        .filter(item => !covered.has(`${item.repository}#${item.number}`))
        .slice(0, Math.max(0, MAX_EXTRA_REPOSITORIES - checkouts.length))
      // Clones stand side by side: the session's own next to the user's other
      // checkouts, a fan-out's under one scratch directory. A pull request the
      // log named but whose clone no command named by its full path is looked
      // for under those parents by its repository name.
      const parents = [...new Set([own ?? cwd, ...probed.flatMap(status => (status.root === undefined ? [] : [status.root]))].map(root => dirname(root)))]
      const cloneFor = async (item: { repository: string }): Promise<string | undefined> => {
        const named = probed.find(status => status.status === 'ready' && status.remote?.toLowerCase() === item.repository && status.root !== undefined)
        if (named?.root !== undefined) return named.root
        const name = item.repository.split('/').at(-1) ?? ''
        for (const parent of parents) {
          const root = await repositoryStatus.rootOf(join(parent, name))
          if (root === undefined) continue
          const status = await repositoryStatus.inspect(root)
          if (status.status === 'ready' && status.remote?.toLowerCase() === item.repository) return root
        }
        return undefined
      }
      const detached = (await Promise.all(pullRequests.map(async item => {
        const cloneRoot = await cloneFor(item)
        const status = await repositoryStatus.inspectPullRequest(cloneRoot ?? cwd, item.repository, item.number)
        if (cloneRoot === undefined || status.status !== 'ready') return status
        if (status.branch !== undefined && cleanedLinked.has(`${cloneRoot}\0${status.branch}`)) return { status: 'unavailable' as const, cwd }
        return { ...status, root: cloneRoot }
      }))).filter(linkedRepositoryShown)
      const linked = [...checkouts, ...detached]
      extraRoots.vouch(sessionId, linked.flatMap(status => (status.root === undefined ? [] : [status.root])))
      return linked
    }
    registerRepositoryActionRoute(webCtx, repositoryActions, cwdForClaudeSession)
    registerClaudePromptsRoute(webCtx)
    const promptAssist = new PromptAssistService(subprocess, () => supervisorConfig.executablePath)
    registerClaudePromptNameRoute(webCtx, promptAssist)
    registerClaudePromptRefineRoute(webCtx, promptAssist)
    registerPullRequestFeedbackRoute(webCtx, new PullRequestFeedbackService(subprocess), cwdForClaudeSession)
    registerAskRoute(webCtx, new AskService(subprocess, supervisorConfig.executablePath), cwdForClaudeSession, sessionId => {
      const snapshot = supervisor.snapshots().find(item => item.sessionId === sessionId)
      return snapshot === undefined ? undefined : { model: claudeModelValue(snapshot.model), ...(snapshot.thinkingMode === undefined ? {} : { thinkingMode: snapshot.thinkingMode }) }
    })
    const ownsClaudeSession = (sessionId: string): boolean => {
      const agent = webCtx.agents.get(sessionId as never)
      return agent !== undefined && webCtx.agentPresets.composedPreset(agent.ctx) === CLAUDE_CODE_PRESET_ID
    }
    registerReviewCommentRoute(webCtx, reviewComments, ownsClaudeSession)
    registerPlanFeedbackRoute(webCtx, supervisor.planFeedback, ownsClaudeSession)
    registerClaudeRewindRoute(webCtx, sidecar, {
      eventsFor: sessionId => {
        const agent = webCtx.agents.get(sessionId as never)
        return agent === undefined || webCtx.agentPresets.composedPreset(agent.ctx) !== CLAUDE_CODE_PRESET_ID
          ? undefined
          : agent.session.snapshotEvents()
      },
      busy: sessionId => supervisor.snapshots().some(item => (
        item.sessionId === sessionId && (item.state === 'running' || item.state === 'interrupting')
      )),
      reset: sessionId => supervisor.disposeSession(sessionId),
      restoreFiles: async (sessionId, tree) => {
        const agent = webCtx.agents.get(sessionId as never)
        const cwd = agent?.session.header.cwd
        return cwd === undefined ? false : restoreWorktreeTree(subprocess, cwd, tree)
      },
    })
    // File rewind is served straight from Claude Code's own checkpoint store
    // rather than from anything DSH reconstructs, so it is registered as its
    // own pass-through route beside the conversation rewind above.
    registerClaudeFileRewindRoute(webCtx, {
      owns: ownsClaudeSession,
      rewind: (sessionId, userMessageId, options) => supervisor.rewindFiles(sessionId, userMessageId, options),
    })
    registerPlanUsageRoute(webCtx, fetchedAt => probePlanUsage(supervisorConfig.executablePath, fetchedAt))
    registerClaudeTaskRoute(webCtx, {
      tasksFor: sessionId => supervisor.tasks(sessionId),
      stopTask: (sessionId, taskId) => supervisor.stopTask(sessionId, taskId),
    })
    registerClaudeProjectionRoute(webCtx, sidecar, ownsClaudeSession, sessionId => commandCatalogs.get(sessionId) ?? [], async sessionId => {
      const agent = webCtx.agents.get(sessionId as never)
      if (agent === undefined || webCtx.agentPresets.composedPreset(agent.ctx) !== CLAUDE_CODE_PRESET_ID) return undefined
      const cwd = agent.session.header.cwd
      return cwd === undefined ? undefined : repositoryStatus.inspect(cwd)
    }, sessionId => reviewComments.list(sessionId), extraRepositoriesForClaudeSession)
  })
}
