import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerShutdownHandlers } from '../../api/shutdown.js'

const TIMEOUT_MS = 50

// Builds a fake process that records handlers and exit codes.
function createFakeProcess() {
  const handlers = {}
  return {
    handlers,
    once: vi.fn((signal, handler) => {
      handlers[signal] = handler
    }),
    exit: vi.fn(),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('registerShutdownHandlers', () => {
  it('should register SIGTERM and SIGINT handlers once each', () => {
    const proc = createFakeProcess()

    registerShutdownHandlers({ close: vi.fn() }, { proc, timeoutMs: TIMEOUT_MS })

    expect(Object.keys(proc.handlers).sort()).toEqual(['SIGINT', 'SIGTERM'])
  })

  it('should close the server and exit 0 on SIGTERM', async () => {
    const proc = createFakeProcess()
    const fastify = { close: vi.fn().mockResolvedValue(undefined) }
    registerShutdownHandlers(fastify, { proc, timeoutMs: TIMEOUT_MS })

    await proc.handlers.SIGTERM()

    expect(fastify.close).toHaveBeenCalledTimes(1)
    expect(proc.exit).toHaveBeenCalledWith(0)
  })

  it('should exit 1 when close fails', async () => {
    const proc = createFakeProcess()
    const fastify = { close: vi.fn().mockRejectedValue(new Error('boom')), log: { error: vi.fn() } }
    registerShutdownHandlers(fastify, { proc, timeoutMs: TIMEOUT_MS })

    await proc.handlers.SIGINT()

    expect(proc.exit).toHaveBeenCalledWith(1)
  })

  it('should hard-exit 1 when close hangs past the timeout', async () => {
    vi.useFakeTimers()
    const proc = createFakeProcess()
    const fastify = { close: vi.fn(() => new Promise(() => {})) }
    registerShutdownHandlers(fastify, { proc, timeoutMs: TIMEOUT_MS })

    proc.handlers.SIGTERM()
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1)

    expect(proc.exit).toHaveBeenCalledWith(1)
  })

  it('should ignore a second signal while closing', async () => {
    const proc = createFakeProcess()
    const fastify = { close: vi.fn().mockResolvedValue(undefined) }
    registerShutdownHandlers(fastify, { proc, timeoutMs: TIMEOUT_MS })

    await Promise.all([proc.handlers.SIGTERM(), proc.handlers.SIGINT()])

    expect(fastify.close).toHaveBeenCalledTimes(1)
  })
})

describe('registerShutdownHandlers early tracer flush', () => {
  it('should start the tracer flush before closing the server', async () => {
    const proc = createFakeProcess()
    const order = []
    const fastify = {
      aiTracer: { forceFlush: vi.fn(() => { order.push('flush'); return new Promise(() => {}) }) },
      close: vi.fn(async () => { order.push('close') }),
    }
    registerShutdownHandlers(fastify, { proc, timeoutMs: TIMEOUT_MS })

    await proc.handlers.SIGTERM()

    expect(order).toEqual(['flush', 'close'])
  })

  it('should still close when forceFlush throws', async () => {
    const proc = createFakeProcess()
    const fastify = { aiTracer: { forceFlush: () => { throw new Error('x') } }, close: vi.fn().mockResolvedValue(undefined) }
    registerShutdownHandlers(fastify, { proc, timeoutMs: TIMEOUT_MS })

    await proc.handlers.SIGTERM()

    expect(proc.exit).toHaveBeenCalledWith(0)
  })
})
