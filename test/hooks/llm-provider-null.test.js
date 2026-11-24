import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: { $disconnect: vi.fn() },
}))

vi.mock('../../api/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  authenticate: async (request) => {
    request.user = { id: 'user-1', roles: ['trainer'] }
  },
  requireRole: () => async () => {},
}))

import { buildServer } from '../../api/server.js'

let app = null

afterEach(async () => {
  await app?.close().catch(() => {})
  app = null
  vi.unstubAllEnvs()
})

describe('server llmProvider with an unsupported LLM_PROVIDER', () => {
  it('should decorate llmProvider as null instead of failing to boot', async () => {
    vi.stubEnv('LLM_PROVIDER', 'gemini')

    app = await buildServer({ logger: false, adminDb: { $disconnect: vi.fn() } })

    expect(app.llmProvider).toBeNull()
  })

  it('should answer the chat route with 503 and the standard error shape', async () => {
    vi.stubEnv('LLM_PROVIDER', 'gemini')
    app = await buildServer({ logger: false, adminDb: { $disconnect: vi.fn() } })

    const token = app.jwt.sign({ id: 'user-1', roles: ['trainer'] })
    const response = await app.inject({ method: 'POST', url: '/trainer/ai/chat', headers: { authorization: `Bearer ${token}` }, payload: { message: 'Oi' } })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'AI_UNAVAILABLE', messageCode: 'ai.unavailable' })
  })

  it('should log the misconfiguration only once', async () => {
    vi.stubEnv('LLM_PROVIDER', 'gemini')
    const lines = []
    const stream = { write: (line) => lines.push(line) }

    app = await buildServer({ logger: { level: 'error', stream }, adminDb: { $disconnect: vi.fn() } })

    expect(lines.filter((line) => line.includes('gemini'))).toHaveLength(1)
  })
})
