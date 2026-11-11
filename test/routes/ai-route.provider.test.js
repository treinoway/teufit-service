import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../../api/middleware/auth.js', () => ({
  authenticate: async (request) => {
    request.user = { id: 'user-1', roles: ['trainer'] }
  },
  requireRole: () => async () => {},
}))

vi.mock('../../src/services/ai-training-service.js', () => ({
  processAiChat: vi.fn(),
  processAiChatStream: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  deleteConversation: vi.fn(),
}))

import { aiRoutes } from '../../api/routes/ai-route.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'

const CHAT_URL = '/trainer/ai/chat'
const STREAM_URL = '/trainer/ai/chat/stream'
const CHAT_RESULT = { conversationId: 'conv-1', message: 'Ola', actionsExecuted: [] }

let app = null

// Builds a bare Fastify app with the AI routes and injected tracer and provider doubles.
async function buildApp(llmProvider) {
  const instance = Fastify()
  instance.decorate('aiTracer', { startTurn: vi.fn(), shutdown: vi.fn() })
  instance.decorate('llmProvider', llmProvider)
  await instance.register(aiRoutes)
  await instance.ready()
  return instance
}

beforeEach(() => {
  processAiChat.mockResolvedValue(CHAT_RESULT)
  processAiChatStream.mockImplementation(async function* () {
    yield { event: 'done', data: CHAT_RESULT }
  })
})

afterEach(async () => {
  await app?.close()
  app = null
})

describe('AI routes pass the shared provider to the service (AC 5)', () => {
  it('should pass fastify.llmProvider to processAiChat', async () => {
    const llmProvider = { chat: vi.fn() }
    app = await buildApp(llmProvider)

    await app.inject({ method: 'POST', url: CHAT_URL, payload: { message: 'Oi' } })

    expect(processAiChat).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ message: 'Oi' }),
      expect.objectContaining({ provider: llmProvider }),
    )
  })

  it('should pass fastify.llmProvider to processAiChatStream', async () => {
    const llmProvider = { chat: vi.fn() }
    app = await buildApp(llmProvider)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address()

    await fetch(`http://127.0.0.1:${port}${STREAM_URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Oi' }),
    }).then((response) => response.text())

    expect(processAiChatStream).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ message: 'Oi' }),
      expect.objectContaining({ provider: llmProvider }),
    )
  })

  it('should keep passing the tracer alongside the provider', async () => {
    app = await buildApp({ chat: vi.fn() })

    await app.inject({ method: 'POST', url: CHAT_URL, payload: { message: 'Oi' } })

    expect(processAiChat.mock.calls[0][2].tracer).toBe(app.aiTracer)
  })
})
