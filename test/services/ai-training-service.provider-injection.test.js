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
    $transaction: vi.fn(),
  },
}))

vi.mock('../../src/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getLlmProvider: vi.fn(),
}))

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
import { getLlmProvider } from '../../src/llm/index.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js'
import { AI_TOOLS } from '../../src/constants/ai.js'
import {
  USER_ID,
  TRAINER_ID,
  STUDENT_ID,
  CONVERSATION_ID,
  textResponse,
  toolResponse,
  streamOf,
  drain,
  buildToolResultMessages,
  stubTrainerContext,
  stubNewConversation,
  stubExistingConversation,
} from '../helpers/ai-engine-fixtures.js'

const FINAL_TEXT = 'Resposta final'
const PERFORMANCE_INPUT = { studentId: STUDENT_ID }
const READ_MESSAGE = 'Como esta a Ana?'

// Builds a provider double whose two model calls are a read-tool request then a final text.
function buildProvider() {
  const readTool = toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT })
  const final = textResponse(FINAL_TEXT)
  return {
    chat: vi.fn().mockResolvedValueOnce(readTool).mockResolvedValueOnce(final),
    chatStream: vi.fn().mockImplementationOnce(streamOf(readTool)).mockImplementationOnce(streamOf(final)),
    buildToolResultMessages: vi.fn(buildToolResultMessages),
  }
}

beforeEach(() => {
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  writeInteractionLog.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: TRAINER_ID, studentId: STUDENT_ID })
  prisma.trainerStudent.findFirst.mockResolvedValue({ trainerId: TRAINER_ID, studentId: STUDENT_ID })
  prisma.anamnesisResponse.findMany.mockResolvedValue([])
  buildAiPerformanceSnapshot.mockResolvedValue({ studentId: STUDENT_ID, studentName: 'Ana Lima', sessionCounts: { completed: 2 }, topExercises: [] })
  stubTrainerContext(prisma)
  stubNewConversation(prisma)
})

describe('processAiChat with an injected provider (AC 5)', () => {
  it('should use the injected provider for the model call and the read-tool follow-up', async () => {
    const provider = buildProvider()

    await processAiChat(USER_ID, { message: READ_MESSAGE }, { provider })

    expect(provider.chat).toHaveBeenCalledTimes(2)
  })

  it('should build the tool result messages with the injected provider', async () => {
    const provider = buildProvider()

    await processAiChat(USER_ID, { message: READ_MESSAGE }, { provider })

    expect(provider.buildToolResultMessages).toHaveBeenCalledTimes(1)
  })

  it('should return the final text produced by the injected provider', async () => {
    const result = await processAiChat(USER_ID, { message: READ_MESSAGE }, { provider: buildProvider() })

    expect(result.message).toBe(FINAL_TEXT)
  })

  it('should never call getLlmProvider on a new conversation', async () => {
    await processAiChat(USER_ID, { message: READ_MESSAGE }, { provider: buildProvider() })

    expect(getLlmProvider).not.toHaveBeenCalled()
  })

  it('should never call getLlmProvider when loading the history of an existing conversation', async () => {
    stubExistingConversation(prisma)

    await processAiChat(USER_ID, { message: READ_MESSAGE, conversationId: CONVERSATION_ID }, { provider: buildProvider() })

    expect(getLlmProvider).not.toHaveBeenCalled()
  })
})

describe('processAiChat without an injected provider (AC 5)', () => {
  it('should call getLlmProvider exactly once for a new conversation turn', async () => {
    const provider = buildProvider()
    getLlmProvider.mockReturnValue(provider)

    await processAiChat(USER_ID, { message: READ_MESSAGE })

    expect(getLlmProvider).toHaveBeenCalledTimes(1)
  })

  it('should call getLlmProvider exactly once for an existing conversation turn', async () => {
    getLlmProvider.mockReturnValue(buildProvider())
    stubExistingConversation(prisma)

    await processAiChat(USER_ID, { message: READ_MESSAGE, conversationId: CONVERSATION_ID })

    expect(getLlmProvider).toHaveBeenCalledTimes(1)
  })

  it('should run every model call of the turn on that single provider', async () => {
    const provider = buildProvider()
    getLlmProvider.mockReturnValue(provider)

    await processAiChat(USER_ID, { message: READ_MESSAGE })

    expect(provider.chat).toHaveBeenCalledTimes(2)
  })
})

describe('processAiChatStream with an injected provider (AC 5)', () => {
  it('should use the injected provider for the model call and the read-tool follow-up', async () => {
    const provider = buildProvider()

    await drain(processAiChatStream(USER_ID, { message: READ_MESSAGE }, { provider }))

    expect(provider.chatStream).toHaveBeenCalledTimes(2)
  })

  it('should never call getLlmProvider', async () => {
    await drain(processAiChatStream(USER_ID, { message: READ_MESSAGE }, { provider: buildProvider() }))

    expect(getLlmProvider).not.toHaveBeenCalled()
  })

  it('should never call getLlmProvider for an existing conversation', async () => {
    stubExistingConversation(prisma)

    await drain(processAiChatStream(USER_ID, { message: READ_MESSAGE, conversationId: CONVERSATION_ID }, { provider: buildProvider() }))

    expect(getLlmProvider).not.toHaveBeenCalled()
  })
})

describe('processAiChatStream without an injected provider (AC 5)', () => {
  it('should call getLlmProvider exactly once per turn', async () => {
    getLlmProvider.mockReturnValue(buildProvider())

    await drain(processAiChatStream(USER_ID, { message: READ_MESSAGE }))

    expect(getLlmProvider).toHaveBeenCalledTimes(1)
  })

  it('should call getLlmProvider exactly once per turn for an existing conversation', async () => {
    getLlmProvider.mockReturnValue(buildProvider())
    stubExistingConversation(prisma)

    await drain(processAiChatStream(USER_ID, { message: READ_MESSAGE, conversationId: CONVERSATION_ID }))

    expect(getLlmProvider).toHaveBeenCalledTimes(1)
  })
})
