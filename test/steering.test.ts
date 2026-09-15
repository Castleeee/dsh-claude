import { describe, expect, it, vi } from 'vitest'
import { applyClaudeSteering } from '../src/steering.ts'

/** The smallest stand-ins for the two surfaces this plugin touches: an agent's
 *  inbox and the `claudeSteering` service. Everything the plugin is allowed to
 *  see is public DSH API, so a fake is enough to pin the contract it relies on. */

function harness({ preset = 'claude', outcome = 'delivered', service = true } = {}) {
  const listeners = new Map()
  const lists = { 'next-turn': [], 'next-step': [] }
  const calls = { delivered: [], appended: [], spliced: [], warned: [], info: [] }

  const inbox = {
    get nextTurn() { return lists['next-turn'] },
    get nextStep() { return lists['next-step'] },
    append(target, message) { lists[target].push(message) },
    prepend(target, message) { lists[target].unshift(message) },
    replace() { return false },
    remove() { return false },
    clear() { lists['next-turn'] = []; lists['next-step'] = [] },
    splice(target, start, deleteCount, inserted) {
      const removed = lists[target].splice(start, deleteCount, ...inserted)
      calls.spliced.push({ target, removed })
      return removed
    },
  }

  const agent = {
    id: 'session-1',
    ctx: {},
    inbox,
    session: {
      append: (type, data, intent) => {
        calls.appended.push({ type, data, intent })
        return { type }
      },
    },
  }

  const steering = {
    deliver: async (sessionId, content) => {
      calls.delivered.push({ sessionId, content })
      return outcome
    },
  }

  const ctx = {
    agentPresets: { composedPreset: () => preset },
    get: serviceName => (service && serviceName === 'claudeSteering' ? steering : undefined),
    on: (event, handler) => { listeners.set(event, handler) },
    logger: { warn: message => calls.warned.push(message), info: message => calls.info.push(message) },
  }

  applyClaudeSteering(ctx)

  return {
    agent,
    calls,
    lists,
    steering,
    insert: (message, target = 'next-step') => {
      lists[target].push(message)
      listeners.get('agent/inbox/inserted')?.({ agent, message })
    },
  }
}

const text = (id, body) => ({ id, role: 'user', content: [{ type: 'text', text: body }] })

describe('Claude steering', () => {
  it('claims the steered message and hands it to the running turn', async () => {
    const runtime = harness()
    const message = text('message-1', 'change of plan')
    runtime.insert(message)

    await vi.waitFor(() => expect(runtime.calls.delivered).toHaveLength(1))
    expect(runtime.calls.delivered[0]).toEqual({ sessionId: 'session-1', content: 'change of plan' })
    // Claimed, not left for the loop, and not re-queued either.
    expect(runtime.lists['next-step']).toEqual([])
    expect(runtime.lists['next-turn']).toEqual([])
    expect(runtime.calls.spliced).toHaveLength(1)
    // The loop never logs a message it did not claim, so the plugin does.
    expect(runtime.calls.appended).toEqual([
      { type: 'user/message', data: message, intent: { surfaceOp: 'append' } },
    ])
    // The Host log is where a steer that reached the running turn is visible.
    expect(runtime.calls.info).toEqual(['dsh-claude-steer: steered session-1 mid-turn'])
  })

  it('keeps the message as an ordinary next turn when nothing is running to steer', async () => {
    const runtime = harness({ outcome: 'unavailable' })
    const message = text('message-2', 'never mind')
    runtime.insert(message)

    await vi.waitFor(() => expect(runtime.lists['next-turn']).toHaveLength(1))
    expect(runtime.lists['next-step']).toEqual([])
    expect(runtime.lists['next-turn'][0]).toBe(message)
    // A message nobody delivered must not be recorded as if it had been.
    expect(runtime.calls.appended).toEqual([])
  })

  it('re-queues the message when delivery throws', async () => {
    const runtime = harness()
    runtime.steering.deliver = () => { throw new Error('supervisor is gone') }
    runtime.insert(text('message-3', 'still there?'))

    await vi.waitFor(() => expect(runtime.lists['next-turn']).toHaveLength(1))
    expect(runtime.calls.warned.some(line => line.includes('steering delivery failed'))).toBe(true)
  })

  it('steers a message carrying attachments, block for block', async () => {
    const runtime = harness()
    const message = {
      id: 'message-4',
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'file', attachment: { id: 'f1', name: 'log.txt' } },
        { type: 'image', attachment: { id: 'img-1', name: 'shot.png' } },
      ],
    }
    runtime.insert(message)

    await vi.waitFor(() => expect(runtime.calls.delivered).toHaveLength(1))
    expect(runtime.calls.delivered[0]).toEqual({
      sessionId: 'session-1',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'file', attachment: { id: 'f1', name: 'log.txt' } },
        { type: 'image', attachment: { id: 'img-1', name: 'shot.png' } },
      ],
    })
    expect(runtime.lists['next-step']).toEqual([])
    expect(runtime.calls.appended).toEqual([
      { type: 'user/message', data: message, intent: { surfaceOp: 'append' } },
    ])
  })

  it('leaves a message with a block kind it does not know for the loop', async () => {
    const runtime = harness()
    runtime.insert({
      id: 'message-4b',
      role: 'user',
      content: [{ type: 'text', text: 'look at this' }, { type: 'mystery', value: 1 }],
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runtime.calls.delivered).toEqual([])
    expect(runtime.lists['next-step']).toHaveLength(1)
  })

  it('keeps an attachment message when the running turn cannot take it', async () => {
    // The service refuses what it cannot resolve; the message must come back
    // whole, not as the text half of itself.
    const runtime = harness({ outcome: 'unavailable' })
    const message = {
      id: 'message-4c',
      role: 'user',
      content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { id: 'img-1' } }],
    }
    runtime.insert(message)

    await vi.waitFor(() => expect(runtime.lists['next-turn']).toHaveLength(1))
    expect(runtime.lists['next-turn'][0]).toBe(message)
    expect(runtime.calls.appended).toEqual([])
  })

  it('ignores agents whose session is not a Claude preset', async () => {
    const runtime = harness({ preset: 'standard' })
    runtime.insert(text('message-5', 'hello'))

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runtime.calls.delivered).toEqual([])
    expect(runtime.lists['next-step']).toHaveLength(1)
  })

  it('does nothing when dsh-claude published no steering service', async () => {
    const runtime = harness({ service: false })
    runtime.insert(text('message-6', 'anyone home'))

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runtime.calls.delivered).toEqual([])
    expect(runtime.lists['next-step']).toHaveLength(1)
    expect(runtime.calls.warned).toEqual([
      'dsh-claude-steer: dsh-claude published no claudeSteering service; steered messages keep waiting for the turn to end',
    ])
  })
})
