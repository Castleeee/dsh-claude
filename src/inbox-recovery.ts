import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** One prompt a step will be admitted with. */
type StepMessages = UserMessage[]

/** Whether a pending message is the user's own words rather than one this
 *  plugin layer formed for them.
 *
 *  A Claude turn is driven by exactly one direct human prompt: the CLI owns the
 *  conversation's history, so `resolveDirectUserPrompt` in `adapter.ts` refuses
 *  to guess which text to send when no human-sourced message is present. That
 *  refusal is correct — replaying an older human message or an approval notice
 *  as if it were the request would hand Claude an instruction nobody gave. */
function isDirectHumanMessage(message: UserMessage): boolean {
  return message.role === 'user' && message.source.kind === 'user'
}

/** The oldest pending prompt the user themselves queued, if any. */
function oldestPendingHuman(inbox: Inbox): UserMessage | undefined {
  return inbox.nextTurn.find(isDirectHumanMessage)
}

/**
 * Recover a step whose claimed batch lost the human prompt that opened its turn.
 *
 * `ReactLoopInbox.claim()` takes `next-turn[0]` *by position*, assuming the head
 * of that queue is the message that woke the turn. A plugin notice the approval
 * service injects while the turn is starting can occupy that slot instead — it
 * is spliced into `next-step`, canceled, and re-spliced into `next-turn` ahead
 * of the arriving human message — so the step is admitted with only
 * plugin-sourced messages. Claude's adapter then fails the whole turn with
 * `no direct human input was present in this model step`, and the human's
 * message stays pending in the inbox, never delivered.
 *
 * This is a hedge, not a repair: the mis-claiming lives in `dsh-agent-loop`,
 * which this package does not own. It is also deliberately conservative —
 *
 *   - it runs only for the Claude preset, on that agent's own scope;
 *   - it does nothing at all unless the batch is genuinely missing a human
 *     message, so the ordinary path pays one predicate;
 *   - it takes the human message *by identity* through `Inbox.remove`, the same
 *     interface the loop's own `replace`/`remove` use, so the durable log stays
 *     consistent;
 *   - it returns the batch untouched when no human message is pending. A turn
 *     with no human input at all is a real error, and a clearer failure beats a
 *     fabricated prompt.
 *
 * @param agent - the live Claude agent whose step is being admitted.
 * @param messages - the batch the loop already claimed.
 * @returns the batch to admit, with the pending human prompt restored ahead of
 *  it when one had been skipped.
 */
export function restoreSkippedHumanPrompt(agent: Agent, messages: StepMessages): StepMessages {
  if (messages.some(isDirectHumanMessage)) return messages
  const skipped = oldestPendingHuman(agent.inbox)
  if (skipped === undefined) return messages
  // Identity, not position: `remove` deletes exactly this message wherever the
  // two pending lists happen to hold it, and reports whether it was still there.
  if (!agent.inbox.remove(skipped.id)) return messages
  // The recovered prompt leads: Claude reads the request before the plugin
  // notices that accompanied it.
  return [skipped, ...messages]
}
