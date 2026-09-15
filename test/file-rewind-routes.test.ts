import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_FILE_REWIND_PATH } from '../src/constants.ts'
import { registerClaudeFileRewindRoute, type ClaudeFileRewindAccess } from '../src/file-rewind-routes.ts'
import type { ClaudeRewindOutcome } from '../src/supervisor.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function context(): Context & { handler: Handler } {
  const target = { handler: async () => {} } as { handler: Handler }
  return Object.assign(target, {
    effect: (register: () => unknown) => {
      const route = register() as { handler: Handler }
      target.handler = route.handler
    },
    webServer: {
      register: (route: { kind: string; path: string; handler: Handler }) => {
        expect(route).toMatchObject({ kind: 'exact', path: CLAUDE_FILE_REWIND_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(body: unknown): IncomingMessage {
  const text = JSON.stringify(body)
  // io.body() consumes the request with `for await`, so the body has to be a
  // real stream; the declared content-length is what the wrapper's byte cap
  // reads before it starts reading.
  const stream = Readable.from([Buffer.from(text)])
  return {
    method: 'POST',
    url: CLAUDE_FILE_REWIND_PATH,
    headers: {
      host: 'localhost:56454',
      origin: 'http://localhost:56454',
      'content-length': String(Buffer.byteLength(text)),
    },
    socket: { remoteAddress: '::1' },
    // registerPluginRoute wires disconnect teardown before its first await.
    // These cases model a caller that stays connected for the whole exchange,
    // so the fake accepts listeners and never fires one.
    on() { return this },
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { statusCode: number; body: string } {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    on() { return this },
    flushHeaders() {},
    write(chunk: string) { this.body += chunk; return true },
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this },
    end(body?: string) { this.writableEnded = true; if (body !== undefined) this.body += body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

function access(rewind: ClaudeFileRewindAccess['rewind'], owns = () => true): ClaudeFileRewindAccess {
  return { owns, rewind }
}

describe('file rewind route', () => {
  it('forwards the SDK result verbatim on success', async () => {
    const ctx = context()
    const rewind = vi.fn(async (): Promise<ClaudeRewindOutcome> => ({
      status: 'ok',
      result: { canRewind: true, filesChanged: ['/repo/a.ts'], insertions: 12, deletions: 3 },
    }))
    registerClaudeFileRewindRoute(ctx, access(rewind))

    const res = response()
    await ctx.handler(request({ sessionId: 's1', turn: 1 }), res)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      canRewind: true,
      filesChanged: ['/repo/a.ts'],
      insertions: 12,
      deletions: 3,
    })
    // No dryRun in the request means no dryRun in the call.
    expect(rewind).toHaveBeenCalledWith('s1', 1, {})
  })

  it('passes dryRun through so a preview writes nothing', async () => {
    const ctx = context()
    const rewind = vi.fn(async (): Promise<ClaudeRewindOutcome> => ({
      status: 'ok',
      result: { canRewind: true, filesChanged: ['/repo/a.ts'], insertions: 1, deletions: 0 },
    }))
    registerClaudeFileRewindRoute(ctx, access(rewind))

    const res = response()
    await ctx.handler(request({ sessionId: 's1', turn: 1, dryRun: true }), res)

    expect(res.statusCode).toBe(200)
    expect(rewind).toHaveBeenCalledWith('s1', 1, { dryRun: true })
  })

  it('reports canRewind:false as an answer rather than an error', async () => {
    const ctx = context()
    // A target the CLI does not hold is a fact about the target, not a failure
    // of the request, so it must not be dressed up as a 5xx.
    registerClaudeFileRewindRoute(ctx, access(async () => ({
      status: 'ok',
      result: { canRewind: false, error: 'no checkpoint for that message' },
    })))

    const res = response()
    await ctx.handler(request({ sessionId: 's1', turn: 1 }), res)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ canRewind: false })
  })

  it('refuses a session this plugin does not own', async () => {
    const ctx = context()
    const rewind = vi.fn()
    registerClaudeFileRewindRoute(ctx, access(rewind, () => false))

    const res = response()
    await ctx.handler(request({ sessionId: 'other', turn: 1 }), res)

    expect(res.statusCode).toBe(409)
    expect(rewind).not.toHaveBeenCalled()
  })

  it('refuses a turn that is still running', async () => {
    const ctx = context()
    registerClaudeFileRewindRoute(ctx, access(async () => ({ status: 'busy' })))

    const res = response()
    await ctx.handler(request({ sessionId: 's1', turn: 1 }), res)

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'session-busy' })
  })

  it('answers no-target for a turn with no recorded prompt uuid', async () => {
    const ctx = context()
    // A definite answer, not a failure: there is nothing to rewind, and the
    // caller must say so rather than resolve to a neighbouring turn.
    registerClaudeFileRewindRoute(ctx, access(async () => ({ status: 'no-target' })))

    const res = response()
    await ctx.handler(request({ sessionId: 's1', turn: 7 }), res)

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'no-rewind-target' })
  })

  it('rejects a malformed request before reaching the supervisisor', async () => {
    const ctx = context()
    const rewind = vi.fn()
    registerClaudeFileRewindRoute(ctx, access(rewind))

    for (const body of [
      { turn: 1 },
      { sessionId: 's1' },
      { sessionId: '', turn: 1 },
      { sessionId: 's1', turn: 0 },
      { sessionId: 's1', turn: 1, dryRun: 'yes' },
    ]) {
      const res = response()
      await ctx.handler(request(body), res)
      expect(res.statusCode).toBe(400)
    }
    expect(rewind).not.toHaveBeenCalled()
  })

  it('surfaces a supervisor failure as a 500 with its message', async () => {
    const ctx = context()
    registerClaudeFileRewindRoute(ctx, access(async () => ({ status: 'error', message: 'CLI gone' })))

    const res = response()
    await ctx.handler(request({ sessionId: 's1', turn: 1 }), res)

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'rewind-failed', message: 'CLI gone' })
  })
})
