import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { restoreSkippedHumanPrompt } from '../src/inbox-recovery.ts'

/** A pending message shaped like the ones the loop actually carries. */
function message(id: string, source: UserMessage['source']): UserMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: id }],
    source,
  } as unknown as UserMessage
}

const human = (id: string): UserMessage => message(id, { kind: 'user' } as UserMessage['source'])
const approvalNotice = (id: string): UserMessage => message(id, {
  kind: 'plugin',
  plugin: 'user-approval',
} as UserMessage['source'])
const systemSnapshot = (id: string): UserMessage => message(id, {
  kind: 'plugin',
  plugin: '@deepseek-ai/dsh-system-prompt',
  form: 'snapshot',
} as UserMessage['source'])

/** An agent whose inbox holds `pending` and records the removals it sees. */
function createAgent(pending: readonly UserMessage[]) {
  const remaining = [...pending]
  const remove = vi.fn((messageId: string) => {
    const index = remaining.findIndex(candidate => candidate.id === messageId)
    if (index < 0) return false
    remaining.splice(index, 1)
    return true
  })
  const agent = {
    id: 'agent-1',
    inbox: {
      get nextTurn() { return remaining },
      get nextStep() { return [] },
      remove,
    },
  } as unknown as Agent
  return { agent, remove, remaining }
}

describe('restoreSkippedHumanPrompt', () => {
  it('leaves an ordinary batch alone and never touches the inbox', () => {
    const { agent, remove } = createAgent([human('h1')])
    const claimed = [human('h1'), systemSnapshot('s1')]

    const result = restoreSkippedHumanPrompt(agent, claimed)

    expect(result).toBe(claimed)
    expect(remove).not.toHaveBeenCalled()
  })

  it('restores the skipped human prompt ahead of the plugin notices', () => {
    // The exact shape the loop produced: the approval notice took the turn's
    // slot, so the step was admitted with plugin messages only.
    const { agent, remaining } = createAgent([human('h1')])
    const claimed = [approvalNotice('a1'), systemSnapshot('s1')]

    const result = restoreSkippedHumanPrompt(agent, claimed)

    expect(result.map(item => item.id)).toEqual(['h1', 'a1', 's1'])
    expect(remaining).toEqual([])
  })

  it('removes the human prompt by identity, not by position', () => {
    // A notice queued ahead of the human message: taking `nextTurn[0]` would
    // grab the notice, which is the bug this hedge exists to route around.
    const { agent, remove, remaining } = createAgent([approvalNotice('a0'), human('h1')])

    const result = restoreSkippedHumanPrompt(agent, [systemSnapshot('s1')])

    expect(remove).toHaveBeenCalledWith('h1')
    expect(result.map(item => item.id)).toEqual(['h1', 's1'])
    expect(remaining.map(item => item.id)).toEqual(['a0'])
  })

  it('takes the oldest pending human prompt when several are queued', () => {
    const { agent } = createAgent([human('h1'), human('h2')])

    const result = restoreSkippedHumanPrompt(agent, [systemSnapshot('s1')])

    expect(result.map(item => item.id)).toEqual(['h1', 's1'])
  })

  it('leaves a genuinely human-free step untouched so the real error surfaces', () => {
    // No human input anywhere is not this bug: fabricating a prompt would hand
    // Claude an instruction nobody gave, so the adapter must still fail.
    const { agent, remove } = createAgent([approvalNotice('a1')])
    const claimed = [systemSnapshot('s1')]

    const result = restoreSkippedHumanPrompt(agent, claimed)

    expect(result).toBe(claimed)
    expect(remove).not.toHaveBeenCalled()
  })

  it('keeps the batch unchanged when the pending prompt vanished mid-flight', () => {
    const { agent } = createAgent([human('h1')])
    // Another consumer drained the same message before this listener ran, so the
    // identity-removal reports that it was no longer pending.
    const inbox = agent.inbox as unknown as { remove: (id: string) => boolean }
    inbox.remove = () => false
    const claimed = [systemSnapshot('s1')]

    const result = restoreSkippedHumanPrompt(agent, claimed)

    expect(result).toBe(claimed)
  })

  it('does not treat a plugin-sourced user message as human input', () => {
    const { agent } = createAgent([human('h1')])
    const claimed = [approvalNotice('a1')]

    const result = restoreSkippedHumanPrompt(agent, claimed)

    expect(result.map(item => item.id)).toEqual(['h1', 'a1'])
  })
})
