import { Roles } from '../../src/constants/roles.js'
import { AppError } from '../../src/errors/app-error.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { processAiChat, processAiChatStream, listConversations, getConversation, deleteConversation } from '../../src/services/ai-training-service.js'
import { aiChatSchema, aiChatStreamSchema, listConversationsSchema, getConversationSchema, deleteConversationSchema } from '../schemas/ai-route.schema.js'
import { AI_LIMITS, AI_ERRORS, AI_MESSAGE_CODES } from '../../src/constants/ai.js'
import { translate } from '../../src/i18n/index.js'

// Aborts the returned signal when the client connection closes before the response finished.
function abortOnClientDisconnect(reply) {
  const controller = new AbortController()
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort()
  })
  return controller
}

// Ends a request whose client already left: no error log, nothing written to the closed socket.
function abandonReply(request, reply) {
  request.log.info({ userId: request.user.id }, '[AI] client disconnected before the reply')
  return reply.hijack()
}

// Builds the SSE `error` payload for a failed stream, translated for the request language.
function buildStreamErrorPayload(err, language) {
  const known = err instanceof AppError
  const messageCode = known ? err.messageCode : AI_MESSAGE_CODES.MODEL_ERROR
  const fallbackValue = known ? err.message : 'AI service error'
  const conversationId = err?.conversationId ?? err?.details?.conversationId
  return {
    error: known ? err.error : AI_ERRORS.MODEL_ERROR,
    messageCode,
    message: translate('errors', messageCode, language, { fallbackValue }),
    ...(conversationId && { conversationId }),
  }
}

// Writes one server-sent event.
function writeSseEvent(reply, event, data) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// Pipes a turn generator to the client as SSE, stopping the model call if the client leaves.
async function pipeTurnToSse(request, reply, turn, firstStep) {
  let clientDisconnected = false
  let heartbeatCount = 0
  const heartbeat = setInterval(() => {
    if (clientDisconnected) return
    heartbeatCount++
    try {
      writeSseEvent(reply, 'heartbeat', { tick: heartbeatCount })
    } catch {
      // why: the socket is already closed; the 'close' listener clears this interval.
    }
  }, 3000)

  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) clientDisconnected = true
    clearInterval(heartbeat)
  })

  try {
    if (!firstStep.done) writeSseEvent(reply, firstStep.value.event, firstStep.value.data)
    for await (const event of turn) {
      if (clientDisconnected) break
      writeSseEvent(reply, event.event, event.data)
    }
  } catch (err) {
    if (!(err instanceof AppError) && !clientDisconnected) {
      request.log.error({ err, userId: request.user.id, stack: err?.stack }, '[AI][stream] unexpected non-AppError')
    }
    if (!clientDisconnected) writeSseEvent(reply, 'error', buildStreamErrorPayload(err, request.language))
  }

  clearInterval(heartbeat)
  if (!clientDisconnected) reply.raw.end()
}

export async function aiRoutes(fastify) {
  const chatRateLimit = {
    max: AI_LIMITS.RATE_LIMIT_MAX,
    timeWindow: AI_LIMITS.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => `ai:${request.user.id}`,
  }

  fastify.post(
    '/trainer/ai/chat',
    {
      config: { rateLimit: chatRateLimit },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: aiChatSchema,
    },
    async (request, reply) => {
      const controller = abortOnClientDisconnect(reply)
      try {
        const result = await processAiChat(request.user.id, request.body, { signal: controller.signal, language: request.language, tracer: fastify.aiTracer, requestId: request.id })
        if (controller.signal.aborted) return abandonReply(request, reply)
        return reply.send(result)
      } catch (err) {
        if (controller.signal.aborted) return abandonReply(request, reply)
        throw err
      }
    },
  )

  fastify.post(
    '/trainer/ai/chat/stream',
    {
      config: { rateLimit: chatRateLimit },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: aiChatStreamSchema,
    },
    async (request, reply) => {
      const controller = abortOnClientDisconnect(reply)
      const turn = processAiChatStream(request.user.id, request.body, { signal: controller.signal, language: request.language, tracer: fastify.aiTracer, requestId: request.id })

      // why: the first event is only yielded after availability, ownership and plan checks
      // passed, so a refusal here is still a regular JSON error (403/404/503), not an SSE one.
      const firstStep = await turn.next()

      reply.hijack()
      reply.raw.writeHead(200, {
        ...reply.getHeaders(),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      await pipeTurnToSse(request, reply, turn, firstStep)
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
