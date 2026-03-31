import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js'

export const aiChatSchema = {
  tags: ['AI Assistant'],
  summary: 'Enviar mensagem ao assistente de treinos',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['message'],
    additionalProperties: false,
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
      },
      conversationId: {
        type: 'string',
        format: 'uuid',
        description: 'ID of an existing conversation to continue. If omitted, a new conversation is created.',
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', format: 'uuid' },
        message: { type: 'string' },
        actionsExecuted: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              success: { type: 'boolean' },
              data: {},
            },
          },
        },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
    502: errorResponseSchema,
  },
}

export const aiChatStreamSchema = {
  tags: ['AI Assistant'],
  summary: 'Enviar mensagem ao assistente (streaming via SSE)',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['message'],
    additionalProperties: false,
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
      },
      conversationId: {
        type: 'string',
        format: 'uuid',
        description: 'ID of an existing conversation to continue. If omitted, a new conversation is created.',
      },
    },
  },
  // No response schema — SSE is a raw stream that bypasses Fastify serialization
}

export const listConversationsSchema = {
  tags: ['AI Assistant'],
  summary: 'Listar conversas do assistente',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: ['string', 'null'] },
          createdAt: { type: 'string' },
          updatedAt: { type: ['string', 'null'] },
        },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
}

export const getConversationSchema = {
  tags: ['AI Assistant'],
  summary: 'Buscar conversa com mensagens',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['conversationId'],
    properties: {
      conversationId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        userId: { type: 'string', format: 'uuid' },
        title: { type: ['string', 'null'] },
        createdAt: { type: 'string' },
        updatedAt: { type: ['string', 'null'] },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              conversationId: { type: 'string', format: 'uuid' },
              role: { type: 'string', enum: ['user', 'assistant'] },
              content: { type: 'string' },
              toolCalls: {},
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
}

export const deleteConversationSchema = {
  tags: ['AI Assistant'],
  summary: 'Deletar uma conversa',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['conversationId'],
    properties: {
      conversationId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    204: { type: 'null' },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
}
