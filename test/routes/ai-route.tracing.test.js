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
const REQUEST_ID_HEADER = 'x-test-request-id'

let app = null

// Builds a bare Fastify app with the AI routes and an injected tracer double.
async function buildApp(aiTracer) {
  const instance = Fastify({ genReqId: (req) => req.headers[REQUEST_ID_HEADER] ?? 'generated-id' })
  instance.decorate('aiTracer', aiTracer)
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

describe('AI routes pass tracing context to the service (AC 4)', () => {
  it('should pass the decorated tracer and the request id to processAiChat', async () => {
    const aiTracer = { startTurn: vi.fn(), shutdown: vi.fn() }
    app = await buildApp(aiTracer)

    await app.inject({ method: 'POST', url: CHAT_URL, headers: { [REQUEST_ID_HEADER]: 'req-42' }, payload: { message: 'Oi' } })

    expect(processAiChat).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ message: 'Oi' }),
      expect.objectContaining({ tracer: aiTracer, requestId: 'req-42' }),
    )
  })

  it('should still pass the abort signal to processAiChat', async () => {
    app = await buildApp({ startTurn: vi.fn(), shutdown: vi.fn() })

    await app.inject({ method: 'POST', url: CHAT_URL, payload: { message: 'Oi' } })

    expect(processAiChat.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal)
  })

  it('should pass the decorated tracer and the request id to processAiChatStream', async () => {
    const aiTracer = { startTurn: vi.fn(), shutdown: vi.fn() }
    app = await buildApp(aiTracer)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address()

    await fetch(`http://127.0.0.1:${port}${STREAM_URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [REQUEST_ID_HEADER]: 'req-43' },
      body: JSON.stringify({ message: 'Oi' }),
    }).then((response) => response.text())

    expect(processAiChatStream).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ message: 'Oi' }),
      expect.objectContaining({ tracer: aiTracer, requestId: 'req-43' }),
    )
  })
})
