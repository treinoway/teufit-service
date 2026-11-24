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

describe('server llmProvider wiring (AC 5)', () => {
  it('should decorate the instance with the injected llmProvider', async () => {
    const llmProvider = { chat: vi.fn(), chatStream: vi.fn(), buildToolResultMessages: vi.fn() }
    app = await buildServer({ logger: false, llmProvider, adminDb: { $disconnect: vi.fn() } })

    expect(app.llmProvider).toBe(llmProvider)
  })

  it('should create a real provider when none is injected', async () => {
    app = await buildServer({ logger: false, adminDb: { $disconnect: vi.fn() } })

    expect(typeof app.llmProvider.chat).toBe('function')
  })
})
