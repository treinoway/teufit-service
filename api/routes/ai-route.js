import { Roles } from '../../src/constants/roles.js'
import { AppError } from '../../src/errors/app-error.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { processAiChat, processAiChatStream, listConversations, getConversation, deleteConversation } from '../../src/services/ai-training-service.js'
import { aiChatSchema, aiChatStreamSchema, listConversationsSchema, getConversationSchema, deleteConversationSchema } from '../schemas/ai-route.schema.js'
import { AI_LIMITS } from '../../src/constants/ai.js'

export async function aiRoutes(fastify) {
  fastify.post(
    '/trainer/ai/chat',
    {
      config: {
        rateLimit: {
          max: AI_LIMITS.RATE_LIMIT_MAX,
          timeWindow: AI_LIMITS.RATE_LIMIT_WINDOW,
          keyGenerator: (request) => `ai:${request.user.id}`,
        },
      },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: aiChatSchema,
    },
    async (request, reply) => {
      const result = await processAiChat(request.user.id, request.body)
      return reply.send(result)
    },
  )

  fastify.post(
    '/trainer/ai/chat/stream',
    {
      config: {
        rateLimit: {
          max: AI_LIMITS.RATE_LIMIT_MAX,
          timeWindow: AI_LIMITS.RATE_LIMIT_WINDOW,
          keyGenerator: (request) => `ai:${request.user.id}`,
        },
      },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: aiChatStreamSchema,
    },
    async (request, reply) => {
      reply.hijack()
      const origin = request.headers.origin
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...(origin && {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
        }),
      })

      let clientDisconnected = false

      // Heartbeat: send SSE comments every 3s to keep the connection alive
      // and signal to the frontend that the server is still working.
      // SSE comments (lines starting with ':') are ignored by EventSource
      // but keep proxies/browsers from timing out the connection.
      let heartbeatCount = 0
      const heartbeat = setInterval(() => {
        if (clientDisconnected) return
        heartbeatCount++
        try {
          reply.raw.write(`event: heartbeat\ndata: {"tick":${heartbeatCount}}\n\n`)
        } catch {
          // Socket already closed — the 'close' listener will clear this interval
        }
      }, 3000)

      request.raw.on('close', () => {
        clientDisconnected = true
        clearInterval(heartbeat)
      })

      try {
        for await (const event of processAiChatStream(request.user.id, request.body)) {
          if (clientDisconnected) break
          reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
        }
      } catch (err) {
        if (!clientDisconnected) {
          const errorData = err instanceof AppError
            ? { error: err.error, messageCode: err.messageCode, message: err.message }
            : { error: 'AI_MODEL_ERROR', messageCode: 'ai.modelError', message: 'AI service error' }
          reply.raw.write(`event: error\ndata: ${JSON.stringify(errorData)}\n\n`)
        }
      }

      clearInterval(heartbeat)
      if (!clientDisconnected) {
        reply.raw.end()
      }
    },
  )

  fastify.get(
    '/trainer/ai/conversations',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listConversationsSchema,
    },
    async (request, reply) => {
      const conversations = await listConversations(request.user.id)
      return reply.send(conversations)
    },
  )

  fastify.get(
    '/trainer/ai/conversations/:conversationId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getConversationSchema,
    },
    async (request, reply) => {
      const conversation = await getConversation(request.user.id, request.params.conversationId)
      return reply.send(conversation)
    },
  )

  fastify.delete(
    '/trainer/ai/conversations/:conversationId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: deleteConversationSchema,
    },
    async (request, reply) => {
      await deleteConversation(request.user.id, request.params.conversationId)
      return reply.status(204).send()
    },
  )
}
