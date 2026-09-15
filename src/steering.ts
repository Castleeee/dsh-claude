import type { Context } from '@deepseek-ai/cordis'

/**
 * Claude steering, inside the plugin that owns the session.
 *
 * DSH delivers a steered message at the next *step* boundary of the running
 * turn. For the Claude preset a whole DSH turn is a single adapter call —
 * Claude Code runs its own tool loop inside it — so that boundary only arrives
 * once the turn is over, and "steer" behaves exactly like "queue": the message
 * waits.
 *
 * Claude Code itself accepts a user message on its live input stream and reads
 * it at the next model step, which is the boundary the user expected. This
 * closes that gap using only public surfaces:
 *
 *   1. `agent/inbox/inserted` says a message arrived; `agent.inbox.nextStep`
 *      says whether it was a steering submission or an ordinary follow-up.
 *   2. The message is claimed out of `next-step` before the loop can claim it —
 *      both consumers delivering it would reach Claude twice.
 *   3. `claudeSteering` — this plugin's own service — hands it to the running
 *      turn, attachments and all, through the same code path an ordinary send
 *      uses. `unavailable` means nothing was running to take it, so the message
 *      goes back as an ordinary next-turn item instead of being dropped.
 *   4. The loop never logs a message it did not claim, so the message is
 *      recorded here; without it the steered message would be invisible in the
 *      transcript even though Claude saw it.
 *
 * It used to be a plugin of its own (`dsh-claude-steer`), which meant a second
 * package whose only reason to exist was this plugin's steering gap. The
 * Host's `agents` and `agentPresets` are already injected here, so nothing was
 * gained by the split.
 *
 * @module dsh-claude/steering
 */


const STEERING_SERVICE = 'claudeSteering'
const CLAUDE_PRESET = 'claude'

export function applyClaudeSteering(ctx: Context): void {
  
/** The slice of an agent this needs: an inbox, a session and a context. */
interface ClaudeSteerAgent {
  id: string
  ctx: Context
  inbox: {
    readonly nextStep: readonly ClaudeSteerMessage[]
    splice(target: 'next-step', start: number, deleteCount: number, inserted: readonly ClaudeSteerMessage[]): unknown
    append(target: 'next-turn', message: ClaudeSteerMessage): void
  }
  session: { append(type: 'user/message', message: ClaudeSteerMessage, options: { surfaceOp: 'append' }): Promise<void> }
}

interface ClaudeSteerBlock { type: string; text?: string; attachment?: unknown }
interface ClaudeSteerMessage { id?: string; content?: string | readonly ClaudeSteerBlock[] }

/** What this needs from the plugin's own steering service. */
interface ClaudeSteeringService { deliver(agentId: string, content: string | readonly ClaudeSteerBlock[]): Promise<string> }

/** Whether this agent's session is one dsh-claude drives. Every other preset
   *  has no running Claude turn to hand a message to. */
  const ownsClaudeSession = (agent: ClaudeSteerAgent): boolean => {
    try {
      return ctx.agentPresets.composedPreset(agent.ctx) === CLAUDE_PRESET
    } catch {
      // A half-composed preset is not one this plugin can reason about.
      return false
    }
  }

  /** The message as `claudeSteering` takes it: plain text when that is all it
   *  is, otherwise the blocks it arrived as — files and images included, since
   *  dsh-claude resolves them through the same code path an ordinary send uses.
   *  A block kind this plugin does not know is left to the loop, which reads the
   *  message in full rather than in part. */
  const steerable = (message: ClaudeSteerMessage): string | ClaudeSteerBlock[] | undefined => {
    const content = message?.content
    if (typeof content === 'string') return content.length === 0 ? undefined : content
    if (!Array.isArray(content) || content.length === 0) return undefined
    const blocks = []
    const texts = []
    let attachments = 0
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
        blocks.push({ type: 'text', text: block.text })
        continue
      }
      if ((block?.type === 'file' || block?.type === 'image') && block.attachment !== undefined) {
        attachments += 1
        blocks.push({ type: block.type, attachment: block.attachment })
        continue
      }
      return undefined
    }
    if (attachments === 0) {
      const text = texts.join('\n')
      return text.length === 0 ? undefined : text
    }
    return blocks.length === 0 ? undefined : blocks
  }

  /** One line naming the reason nothing will be steered, so a silent no-op is
   *  still diagnosable from the Host log. */
  let reportedMissingService = false

  const drain = async (agent: ClaudeSteerAgent): Promise<void> => {
    if (!ownsClaudeSession(agent)) return
    const service = ctx.get(STEERING_SERVICE) as ClaudeSteeringService | undefined
    if (service === undefined) {
      if (!reportedMissingService) {
        reportedMissingService = true
        ctx.logger?.warn?.('dsh-claude-steer: dsh-claude published no claudeSteering service; steered messages keep waiting for the turn to end')
      }
      return
    }
    const pending = agent.inbox.nextStep
    if (pending.length === 0) return
    for (const message of pending as readonly ClaudeSteerMessage[]) {
      const content = steerable(message)
      const index = agent.inbox.nextStep.findIndex(item => item.id === message.id)
      // Another consumer got there first, or the message is not steerable.
      if (index < 0 || content === undefined) continue
      // Claim before delivering, synchronously: a message both this plugin and
      // the loop claim would reach Claude twice. Delivery itself is awaited —
      // an attachment is read from disk before Claude can be handed it — so a
      // second drain cannot run past this one.
      agent.inbox.splice('next-step', index, 1, [])
      let outcome
      try {
        outcome = await service.deliver(agent.id, content)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-claude-steer: steering delivery failed: ${error instanceof Error ? error.message : String(error)}`)
        outcome = 'unavailable'
      }
      if (outcome !== 'delivered') {
        // Nothing running took it, so it has to stay a message: the next turn
        // will carry it, exactly as an unsteered queue item would have.
        agent.inbox.append('next-turn', message)
        continue
      }
      // One line per steer: this is the evidence that a message reached the
      // running turn instead of waiting for it.
      ctx.logger?.info?.(`dsh-claude-steer: steered ${agent.id} mid-turn`)
      try {
        await agent.session.append('user/message', message, { surfaceOp: 'append' })
      } catch (error) {
        // The delivery already happened; a transcript we could not extend must
        // not turn into a lost steering message.
        ctx.logger?.warn?.(`dsh-claude-steer: steered message not recorded: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // The event carries no target, so `nextStep` membership is what distinguishes a
  // steering submission from an ordinary queued follow-up.
  ctx.on('agent/inbox/inserted', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    // The public payload's Agent type is the full surface; `drain` needs only
    // the inbox, the session and the context it declares.
    void drain(agent as unknown as ClaudeSteerAgent)
  })
}
