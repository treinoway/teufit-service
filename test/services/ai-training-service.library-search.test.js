import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    anamnesisResponse: { findMany: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
    trainingProtocol: { findMany: vi.fn() },
    exerciseTemplate: { findMany: vi.fn() },
    aiConversation: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    aiMessage: { create: vi.fn() },
    aiTokenUsage: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}))

const mockChat = vi.fn()
const mockChatStream = vi.fn()

vi.mock('../../src/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getLlmProvider: vi.fn(() => ({
    chat: mockChat,
    chatStream: mockChatStream,
    buildToolResultMessages: vi.fn((raw, results) => [
      { role: 'assistant', content: raw },
      { role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content })) },
    ]),
  })),
}))

vi.mock('../../src/services/training-protocol-service.js', () => ({ importFromTemplate: vi.fn() }))
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn(),
  recordAiAction: vi.fn(),
}))
vi.mock('../../src/services/student-dashboard-service.js', () => ({ buildAiPerformanceSnapshot: vi.fn() }))
vi.mock('../../src/services/ai-interaction-log-service.js', () => ({ writeInteractionLog: vi.fn() }))

import { prisma } from '../../src/db.js'
import { executeTool, processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { recordAiAction } from '../../src/services/platform-plan-service.js'
import { TOOLS } from '../../src/services/ai-tool-definitions.js'
import { AI_TOOLS, AI_LIMITS } from '../../src/constants/ai.js'
import ptBR from '../../src/i18n/locales/pt-BR.js'
import {
  USER_ID,
  TRAINER_ID,
  textResponse,
  toolResponse,
  streamOf,
  drain,
  stubTrainerContext,
  stubNewConversation,
} from '../helpers/ai-engine-fixtures.js'

const CANDIDATE = { name: 'Rosca martelo', type: 'strength', hasMedia: true, own: false, dbScore: 2 }

beforeEach(() => {
  vi.clearAllMocks()
  prisma.trainerStudent.findUnique.mockResolvedValue(null)
  prisma.trainerStudent.findFirst.mockResolvedValue(null)
  prisma.anamnesisResponse.findMany.mockResolvedValue([])
  stubTrainerContext(prisma)
  stubNewConversation(prisma)
  prisma.$queryRaw.mockResolvedValue([CANDIDATE])
})

describe('search_exercise_library tool definition', () => {
  const definition = TOOLS.find((t) => t.name === AI_TOOLS.SEARCH_EXERCISE_LIBRARY)

  it('is offered to the model with bounded queries', () => {
    const { queries } = definition.input_schema.properties
    expect(definition.input_schema.required).toEqual(['queries'])
    expect(queries.maxItems).toBe(AI_LIMITS.LIBRARY_SEARCH_MAX_QUERIES)
    expect(queries.minItems).toBe(1)
    expect(queries.items.maxLength).toBe(AI_LIMITS.LIBRARY_SEARCH_MAX_QUERY_CHARS)
  })

  it('has a pt-BR status label', () => {
    expect(ptBR.ai.toolStatus.search_exercise_library).toBe('Consultando biblioteca de exercícios')
  })
})

describe('executeTool search_exercise_library', () => {
  beforeEach(() => {
    prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID })
  })

  it('returns candidates per query without ids or media urls', async () => {
    const result = await executeTool(USER_ID, AI_TOOLS.SEARCH_EXERCISE_LIBRARY, { queries: ['Rosca martelo com halter'] })

    expect(result).toEqual({
      success: true,
      data: { results: [{ query: 'Rosca martelo com halter', matches: [{ name: 'Rosca martelo', type: 'strength', hasMedia: true }] }] },
    })
  })

  it('scopes the search to the resolved trainer', async () => {
    await executeTool(USER_ID, AI_TOOLS.SEARCH_EXERCISE_LIBRARY, { queries: ['rosca'] })

    expect(prisma.$queryRaw.mock.calls[0][0].values).toContain(TRAINER_ID)
  })

  it.each([[undefined], ['rosca'], [[]], [[1, null, '   ']]])('rejects invalid queries %j', async (queries) => {
    const result = await executeTool(USER_ID, AI_TOOLS.SEARCH_EXERCISE_LIBRARY, { queries })

    expect(result).toMatchObject({ success: false, error: 'INVALID_TOOL_INPUT' })
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('caps the number and the length of the queries', async () => {
    const queries = Array.from({ length: AI_LIMITS.LIBRARY_SEARCH_MAX_QUERIES + 5 }, () => 'a'.repeat(500))

    const result = await executeTool(USER_ID, AI_TOOLS.SEARCH_EXERCISE_LIBRARY, { queries })

    expect(result.data.results).toHaveLength(AI_LIMITS.LIBRARY_SEARCH_MAX_QUERIES)
    expect(result.data.results[0].query).toHaveLength(AI_LIMITS.LIBRARY_SEARCH_MAX_QUERY_CHARS)
  })

  it('fails cleanly when the user has no trainer profile', async () => {
    prisma.trainer.findUnique.mockResolvedValue(null)

    const result = await executeTool(USER_ID, AI_TOOLS.SEARCH_EXERCISE_LIBRARY, { queries: ['rosca'] })

    expect(result.success).toBe(false)
  })
})

describe('search_exercise_library in the chat engine', () => {
  const searchCall = () => toolResponse({ name: AI_TOOLS.SEARCH_EXERCISE_LIBRARY, input: { queries: ['Rosca martelo com halter'] } })

  it('runs on the first turn without confirmation and feeds the names back to the model', async () => {
    mockChat.mockResolvedValueOnce(searchCall()).mockResolvedValueOnce(textResponse('Proposta com Rosca martelo. Confirma?'))

    const result = await processAiChat(USER_ID, { message: 'Monte um treino de biceps' })

    expect(result.message).toBe('Proposta com Rosca martelo. Confirma?')
    expect(result.actionsExecuted[0]).toMatchObject({ tool: AI_TOOLS.SEARCH_EXERCISE_LIBRARY, success: true })
    const followUp = JSON.stringify(mockChat.mock.calls[1][0].messages)
    expect(followUp).toContain('Rosca martelo')
    expect(followUp).toContain('hasMedia')
    expect(recordAiAction).not.toHaveBeenCalled()
  })

  it('streams the same flow with the library status label', async () => {
    mockChatStream
      .mockImplementationOnce(streamOf(searchCall()))
      .mockImplementationOnce(streamOf(textResponse('Proposta. Confirma?')))

    const events = await drain(processAiChatStream(USER_ID, { message: 'Monte um treino de biceps' }))

    expect(events.find((e) => e.event === 'status' && e.data.message.includes('biblioteca'))).toBeTruthy()
    expect(events.at(-1).event).toBe('done')
    expect(recordAiAction).not.toHaveBeenCalled()
  })

  it('falls back to a deterministic message when the follow-up is empty', async () => {
    mockChat.mockResolvedValueOnce(searchCall()).mockResolvedValue(textResponse(''))

    const result = await processAiChat(USER_ID, { message: 'Monte um treino de biceps' })

    expect(result.message).toContain('1 exercício(s) encontrado(s)')
  })
})
