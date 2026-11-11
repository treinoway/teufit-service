import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: { $disconnect: vi.fn() },
}))

import { buildServer } from '../../api/server.js'

let app = null

afterEach(async () => {
  await app?.close().catch(() => {})
  app = null
})

describe('server aiTracer wiring (AC 12)', () => {
  it('should decorate the instance with the injected aiTracer', async () => {
    const aiTracer = { startTurn: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) }
    app = await buildServer({ logger: false, aiTracer, adminDb: { $disconnect: vi.fn() } })

    expect(app.aiTracer).toBe(aiTracer)
  })

  it('should flush and shut the tracer down when the server closes', async () => {
    const aiTracer = { startTurn: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) }
    app = await buildServer({ logger: false, aiTracer, adminDb: { $disconnect: vi.fn() } })

    await app.close()

    expect(aiTracer.shutdown).toHaveBeenCalledTimes(1)
  })

  it('should create a real no-op tracer in the test environment when none is injected', async () => {
    app = await buildServer({ logger: false, adminDb: { $disconnect: vi.fn() } })

    expect(typeof app.aiTracer.startTurn).toBe('function')
  })
})
