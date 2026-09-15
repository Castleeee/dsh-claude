import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import { CLAUDE_CODE_PROVIDER } from './constants.ts'
import { CLAUDE_COMMANDS_SERVICE } from './command-bridge.ts'
import { claudePresenterDefinitions } from './presenters.ts'
import { latestClaudeModels } from './model-catalog.ts'

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
    if (config.model !== undefined && config.model.length > 0) {
      return { ...upstream, provider: CLAUDE_CODE_PROVIDER, model: config.model }
    }
    // Otherwise the upstream model is kept only when this provider can serve it.
    // The provider above is forced unconditionally, so leaving a foreign model
    // in place would hand the adapter a pair it cannot resolve — `claude` with
    // a DeepSeek id, which is exactly what a session that switched into this
    // preset still carrying the previous world's model produced. A model this
    // provider does not know is the leftover of a switch, not an instruction,
    // and falls back to the CLI's own default.
    const candidate = upstream.model
    const keep = typeof candidate === 'string' && candidate.length > 0 && accepts(candidate)
    return { ...upstream, provider: CLAUDE_CODE_PROVIDER, model: keep ? candidate : 'default' }
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
}
