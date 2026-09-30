import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import { CLAUDE_CODE_PROVIDER } from './constants.ts'
import { CLAUDE_COMMANDS_SERVICE } from './command-bridge.ts'
import { claudePresenterDefinitions } from './presenters.ts'
import { canonicalClaudeModelId, latestClaudeModels } from './model-catalog.ts'

export const name = 'claude-code-preset-route'
export const inject = ['tools', 'commands']

export interface Config {
  model?: string
  /** Whether a model id belongs to Claude Code. Defaults to the lineup the CLI
   *  reported; a test overrides it to pin the behavior without a CLI. */
  accepts?(model: string): boolean
}

/** Whether the CLI's advertised lineup contains a model id.
 *
 *  Both the alias and the CLI's own spelling are accepted, because a session
 *  may hold either: the selector hands out aliases, while an id persisted
 *  before this plugin aliased anything is the CLI's own. */
function lineupAccepts(model: string): boolean {
  return latestClaudeModels().some(row => row.id === model || row.value === model)
}

export function apply(ctx: Context, config: Config = {}): void {
  const accepts = config.accepts ?? lineupAccepts
  ctx.on('agent/request', async (_payload, next) => {
    const upstream = await next()
    // An explicitly configured model is the deployment's instruction and wins.
    // The returned model is what the Host writes into this request's header,
    // and that header is the session's persisted selection from then on: write
    // the selector's own id for it, never a spelling no catalog row carries.
    if (config.model !== undefined && config.model.length > 0) {
      return { ...upstream, provider: CLAUDE_CODE_PROVIDER, model: canonicalClaudeModelId(config.model) }
    }
    // Otherwise the upstream model is kept only when this provider can serve it.
    // The provider above is forced unconditionally, so leaving a foreign model
    // in place would hand the adapter a pair it cannot resolve — `claude` with
    // a DeepSeek id, which is exactly what a session that switched into this
    // preset still carrying the previous world's model produced. A model this
    // provider does not know is the leftover of a switch, not an instruction,
    // and falls back to the CLI's own default.
    // Canonicalise first: the CLI's own spelling and the selector's alias are
    // the same row, and only the catalog knows that. A spelling no row carries
    // is left exactly as it arrived -- it may be a model the CLI accepts but
    // this release does not list yet, and rewriting it would break a working
    // session. Only a model this provider positively cannot serve (a foreign
    // one left behind by a preset switch) falls back to the CLI's default.
    const candidate = upstream.model
    if (candidate === undefined || candidate.length === 0) {
      return { ...upstream, provider: CLAUDE_CODE_PROVIDER, model: 'default' }
    }
    const canonical = canonicalClaudeModelId(candidate)
    // A model this provider cannot serve must not be carried beside it: the
    // provider is forced unconditionally, so `claude` paired with a foreign id
    // is a request no adapter can resolve -- exactly what a session leaving
    // another preset's world for this one used to produce. The served set is
    // the learned lineup, or the deployment's own predicate when it supplies
    // one; the CLI's spelling and the selector alias are the same row.
    const keep = accepts(canonical) || lineupAccepts(canonical)
    return {
      ...upstream,
      provider: CLAUDE_CODE_PROVIDER,
      model: keep ? canonical : 'default',
    }
  })
  // Expose the effective Host command names for collision-safe projection.
  // Claude Skills are not registered as Host commands: the Client slash source
  // submits them as ordinary messages, so no command lifecycle row is created.
  ctx.provide(CLAUDE_COMMANDS_SERVICE, {
    list: agent => ctx.commands.list(agent as never),
  })
  // Presentation-only tool mirrors, scoped to this preset's agents: they let
  // the host compute native render intents for the mirrored Claude tool
  // events. Claude Code owns execution; the stub `execute` never runs.
  for (const definition of claudePresenterDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-claude: ${definition.name} presentation`)
  }
  // `ctx.jobs.start` refuses an owner no attached controller serves. The
  // shipped presets get theirs from dsh-tool-jobs, which this preset does not
  // load (Claude Code owns job collection); attach one for this preset's
  // agents so mirrored tasks (host-jobs.ts) can register. Optional: a Host
  // without a job registry runs as before.
  ctx.inject(['jobs'], jobsCtx => {
    jobsCtx.effect(() => jobsCtx.jobs.attachController('dsh-claude'), 'dsh-claude: job controller')
  })
}
