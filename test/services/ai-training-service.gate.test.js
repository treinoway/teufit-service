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

vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
}))
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn(),
  recordAiAction: vi.fn(),
}))
vi.mock('../../src/services/student-dashboard-service.js', () => ({
  buildAiPerformanceSnapshot: vi.fn(),
}))
vi.mock('../../src/services/ai-interaction-log-service.js', () => ({
  writeInteractionLog: vi.fn(),
}))

import { prisma } from '../../src/db.js'
import { AppError } from '../../src/errors/app-error.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { importFromTemplate } from '../../src/services/training-protocol-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js'
import { AI_TOOLS, AI_MESSAGE_CODES } from '../../src/constants/ai.js'
import { PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js'
import {
  USER_ID,
  TRAINER_ID,
  STUDENT_ID,
  CONVERSATION_ID,
  textResponse,
  toolResponse,
  streamOf,
  drain,
  stubTrainerContext,
  stubNewConversation,
  stubExistingConversation,
} from '../helpers/ai-engine-fixtures.js'

const CONFIRMATION = 'Sim, pode criar'
const IMPORT_INPUT = { templateId: 'tmpl-1', assigneeId: STUDENT_ID, startDate: '2026-11-01', expirationDate: '2026-12-27' }

// Builds the AppError assertCanUseAi throws for a plan definition.
function planError(definition, details) {
  return new AppError({
    httpStatus: definition.status,
    error: definition.code,
    messageCode: definition.messageCode,
    message: definition.code,
    details,
  })
}

beforeEach(() => {
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  writeInteractionLog.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: TRAINER_ID, studentId: STUDENT_ID })
  prisma.trainerStudent.findFirst.mockResolvedValue({ trainerId: TRAINER_ID, studentId: STUDENT_ID })
  prisma.anamnesisResponse.findMany.mockResolvedValue([])
  buildAiPerformanceSnapshot.mockResolvedValue({
    studentId: STUDENT_ID,
    studentName: 'Ana Lima',
    sessionCounts: { completed: 2, in_progress: 0, abandoned: 0 },
    totalSessions: 2,
    topExercises: [],
  })
  stubTrainerContext(prisma)
  stubNewConversation(prisma)
  mockChat.mockResolvedValue(textResponse('Ok'))
  mockChatStream.mockImplementation(streamOf(textResponse('Ok')))
})

describe('AI plan gate runs before any write (AC 1)', () => {
  beforeEach(() => {
    assertCanUseAi.mockRejectedValue(planError(PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE))
  })

  describe('processAiChat', () => {
    it('should reject with platformPlan.aiNotAvailable', async () => {
      await expect(processAiChat(USER_ID, { message: 'Oi' })).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE.messageCode,
      })
    })

    it('should not create a conversation when the plan forbids AI', async () => {
      await processAiChat(USER_ID, { message: 'Oi' }).catch(() => {})

      expect(prisma.aiConversation.create).not.toHaveBeenCalled()
    })

    it('should not save the user message when the plan forbids AI', async () => {
      await processAiChat(USER_ID, { message: 'Oi' }).catch(() => {})

      expect(prisma.aiMessage.create).not.toHaveBeenCalled()
    })

    it('should not save the user message into an existing conversation when the plan forbids AI', async () => {
      stubExistingConversation(prisma)

      await processAiChat(USER_ID, { message: 'Oi', conversationId: CONVERSATION_ID }).catch(() => {})

      expect(prisma.aiMessage.create).not.toHaveBeenCalled()
    })

    it('should not call the model when the plan forbids AI', async () => {
      await processAiChat(USER_ID, { message: 'Oi' }).catch(() => {})

      expect(mockChat).not.toHaveBeenCalled()
    })
  })

  describe('processAiChatStream', () => {
    it('should reject before yielding the first event', async () => {
      const events = []
      const consume = async () => {
        for await (const event of processAiChatStream(USER_ID, { message: 'Oi' })) events.push(event)
      }

      await expect(consume()).rejects.toMatchObject({ httpStatus: 403 })
      expect(events).toEqual([])
    })

    it('should not create a conversation or message when the plan forbids AI', async () => {
      await drain(processAiChatStream(USER_ID, { message: 'Oi' })).catch(() => {})

      expect(prisma.aiConversation.create).not.toHaveBeenCalled()
      expect(prisma.aiMessage.create).not.toHaveBeenCalled()
    })
  })
})

describe('per-student AI quota (AC 2)', () => {
  beforeEach(() => {
    assertCanUseAi.mockImplementation(async (_prisma, _trainerId, studentId) => {
      if (studentId === STUDENT_ID) throw planError(PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED, { scope: 'student' })
    })
  })

  it('should check the quota for the studentId sent in the body', async () => {
    assertCanUseAi.mockResolvedValue(undefined)
    mockChat.mockResolvedValue(textResponse('Claro'))

    await processAiChat(USER_ID, { message: 'Como vai a Ana?', studentId: STUDENT_ID })

    expect(assertCanUseAi).toHaveBeenCalledWith(expect.anything(), TRAINER_ID, STUDENT_ID)
  })

  it('should reject a turn that targets a student over quota with platformPlan.aiActionsExceeded', async () => {
    await expect(processAiChat(USER_ID, { message: 'Como vai a Ana?', studentId: STUDENT_ID })).rejects.toMatchObject({
      httpStatus: 403,
      messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode,
    })
  })

  it('should reject a streamed turn that targets a student over quota before yielding events', async () => {
    const events = []
    const consume = async () => {
      for await (const event of processAiChatStream(USER_ID, { message: 'Como vai a Ana?', studentId: STUDENT_ID })) events.push(event)
    }

    await expect(consume()).rejects.toMatchObject({ messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode })
    expect(events).toEqual([])
  })

  it('should block a write tool that targets a student over quota and not execute it', async () => {
    stubExistingConversation(prisma)
    mockChat.mockResolvedValue(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }))

    const turn = processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    await expect(turn).rejects.toMatchObject({ messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode })
    expect(importFromTemplate).not.toHaveBeenCalled()
  })

  it('should block a streamed write tool that targets a student over quota and not execute it', async () => {
    stubExistingConversation(prisma)
    mockChatStream.mockImplementationOnce(streamOf(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT })))

    await drain(processAiChatStream(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })).catch(() => {})

    expect(importFromTemplate).not.toHaveBeenCalled()
  })

  it('should not consume an action on a turn without tools', async () => {
    assertCanUseAi.mockResolvedValue(undefined)
    mockChat.mockResolvedValue(textResponse('Oi!'))

    await processAiChat(USER_ID, { message: 'Oi' })

    expect(recordAiAction).not.toHaveBeenCalled()
  })

  it('should not consume an action when the read-only performance tool runs', async () => {
    assertCanUseAi.mockResolvedValue(undefined)
    mockChat
      .mockResolvedValueOnce(toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: STUDENT_ID } }))
      .mockResolvedValueOnce(textResponse('A Ana treinou 2 vezes.'))

    await processAiChat(USER_ID, { message: 'Como vai a Ana?' })

    expect(recordAiAction).not.toHaveBeenCalled()
  })
})

describe('truncated and refused model responses (AC 6)', () => {
  beforeEach(() => {
    stubExistingConversation(prisma)
  })

  it('should not execute a tool call cut off by max_tokens and should raise ai.responseTooLong', async () => {
    mockChat.mockResolvedValue({
      ...toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }),
      stopReason: 'max_tokens',
    })

    const turn = processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    await expect(turn).rejects.toMatchObject({ messageCode: AI_MESSAGE_CODES.RESPONSE_TOO_LONG })
    expect(importFromTemplate).not.toHaveBeenCalled()
  })

  it('should not execute a streamed tool call cut off by max_tokens and should raise ai.responseTooLong', async () => {
    mockChatStream.mockImplementationOnce(streamOf({
      ...toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }),
      stopReason: 'max_tokens',
    }))

    const turn = drain(processAiChatStream(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID }))

    await expect(turn).rejects.toMatchObject({ messageCode: AI_MESSAGE_CODES.RESPONSE_TOO_LONG })
    expect(importFromTemplate).not.toHaveBeenCalled()
  })

  it('should not persist an assistant message for a truncated turn', async () => {
    mockChat.mockResolvedValue({ ...textResponse('Resposta cort'), stopReason: 'max_tokens' })

    await processAiChat(USER_ID, { message: 'Monte o plano', conversationId: CONVERSATION_ID }).catch(() => {})

    const savedRoles = prisma.aiMessage.create.mock.calls.map(([arg]) => arg.data.role)
    expect(savedRoles).not.toContain('assistant')
  })
})

describe('abort signal forwarding (AC 7)', () => {
  it('should pass the abort signal to the provider chat call', async () => {
    const controller = new AbortController()
    mockChat.mockResolvedValue(textResponse('Oi'))

    await processAiChat(USER_ID, { message: 'Oi' }, { signal: controller.signal })

    expect(mockChat.mock.calls[0][0].signal).toBe(controller.signal)
  })

  it('should pass the abort signal to the provider chatStream call', async () => {
    const controller = new AbortController()
    mockChatStream.mockImplementationOnce(streamOf(textResponse('Oi')))

    await drain(processAiChatStream(USER_ID, { message: 'Oi' }, { signal: controller.signal }))

    expect(mockChatStream.mock.calls[0][0].signal).toBe(controller.signal)
  })

  it('should pass the abort signal to the follow-up call after a read-only tool', async () => {
    const controller = new AbortController()
    mockChat
      .mockResolvedValueOnce(toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: STUDENT_ID } }))
      .mockResolvedValueOnce(textResponse('Resumo'))

    await processAiChat(USER_ID, { message: 'Como vai a Ana?' }, { signal: controller.signal })

    expect(mockChat.mock.calls[1][0].signal).toBe(controller.signal)
  })
})

describe('client disconnect mid-turn (AC 15)', () => {
  async function disconnectAtFirstTextDelta(generator) {
    for (;;) {
      const { value, done } = await generator.next()
      if (done) return
      if (value.event === 'text_delta') {
        await generator.return(undefined)
        return
      }
    }
  }

  beforeEach(() => {
    stubExistingConversation(prisma)
    importFromTemplate.mockResolvedValue({ id: 'protocol-9', name: 'Protocolo A' })
    mockChatStream.mockImplementationOnce(streamOf(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT })))
  })

  it('should still persist the final assistant message after the tool ran', async () => {
    await disconnectAtFirstTextDelta(processAiChatStream(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID }))

    const assistantSaves = prisma.aiMessage.create.mock.calls.filter(([arg]) => arg.data.role === 'assistant')
    const finalSave = assistantSaves.at(-1)[0].data
    expect(finalSave.content).toContain('Protocolo "Protocolo A" criado com sucesso')
  })

  it('should still write the interaction log after the tool ran', async () => {
    await disconnectAtFirstTextDelta(processAiChatStream(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID }))

    expect(writeInteractionLog).toHaveBeenCalledTimes(1)
  })
})

describe('conversation updatedAt bump (AC 17)', () => {
  it('should bump updatedAt on a text-only turn in an existing conversation', async () => {
    stubExistingConversation(prisma)
    mockChat.mockResolvedValue(textResponse('Claro'))

    await processAiChat(USER_ID, { message: 'Continuar', conversationId: CONVERSATION_ID })

    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONVERSATION_ID },
        data: expect.objectContaining({ updatedAt: expect.any(Date) }),
      }),
    )
  })

  it('should bump updatedAt on a tool turn in an existing conversation', async () => {
    stubExistingConversation(prisma)
    importFromTemplate.mockResolvedValue({ id: 'protocol-9', name: 'Protocolo A' })
    mockChat.mockResolvedValue(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }))

    await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ updatedAt: expect.any(Date) }) }),
    )
  })

  it('should bump updatedAt on a streamed turn in an existing conversation', async () => {
    stubExistingConversation(prisma)
    mockChatStream.mockImplementationOnce(streamOf(textResponse('Claro')))

    await drain(processAiChatStream(USER_ID, { message: 'Continuar', conversationId: CONVERSATION_ID }))

    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ updatedAt: expect.any(Date) }) }),
    )
  })
})
