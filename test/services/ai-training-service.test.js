import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock Prisma before any service imports
vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingProtocol: { findUnique: vi.fn(), findMany: vi.fn() },
    trainerStudent: { findMany: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn(), create: vi.fn() },
    trainingTemplate: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    exerciseTemplate: { findMany: vi.fn(), create: vi.fn() },
    training: { create: vi.fn() },
    exercise: { create: vi.fn() },
    aiConversation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    aiMessage: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

// Mock Anthropic SDK to prevent any real API calls.
// anthropicCreate is a stable vi.fn() reference shared across all tests.
// The Anthropic constructor mock is re-applied in beforeEach because mockReset
// clears constructor mock implementations between tests.
const anthropicCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

// Mock the importFromTemplate service to isolate the AI service
vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
}))

// Mock the trainer onboarding service to prevent real DB calls in unit tests
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))

// Mock the student dashboard service to isolate AI service executeTool for GET_STUDENT_PERFORMANCE
vi.mock('../../src/services/student-dashboard-service.js', () => ({
  buildAiPerformanceSnapshot: vi.fn(),
}))

// Mock exercise-service to isolate executeTool for REORDER_EXERCISES_IN_TRAINING
vi.mock('../../src/services/exercise-service.js', () => ({
  reorderExercisesInTraining: vi.fn(),
  updateExercise: vi.fn(),
}))

// Mock platform-plan-service — gating is tested separately in platform-plan-service.test.js
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn().mockResolvedValue(undefined),
  recordAiAction: vi.fn().mockResolvedValue(undefined),
  assertStudentCap: vi.fn().mockResolvedValue(undefined),
  assertCanUseBranding: vi.fn().mockResolvedValue(undefined),
  assertCanCreateChallenge: vi.fn().mockResolvedValue(undefined),
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
  enforceStudentCapAfterDowngrade: vi.fn().mockResolvedValue(undefined),
  getTrainerPlan: vi.fn().mockResolvedValue({ tier: 'DIAMOND', limits: {}, subscription: null }),
}))

import { prisma } from '../../src/db.js'
import Anthropic from '@anthropic-ai/sdk'
import { importFromTemplate } from '../../src/services/training-protocol-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { reorderExercisesInTraining } from '../../src/services/exercise-service.js'
import {
  buildTrainerContext,
  executeTool,
  processAiChat,
  listConversations,
  getConversation,
  deleteConversation,
  didPreviousAssistantMessageListExercises,
  unwrapRefTag,
  sanitizeToolInputIds,
} from '../../src/services/ai-training-service.js'
import { AI_TOOLS, AI_ERRORS, AI_LIMITS, AI_RETRY } from '../../src/constants/ai.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'

describe('ai-training-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Re-apply Anthropic constructor mock after mockReset clears implementations.
    // Must use a regular function (not arrow) because `new` requires a constructor.
    Anthropic.mockImplementation(function () { this.messages = { create: anthropicCreate } })

    // Re-apply platform-plan-service mocks after mockReset (mockReset: true in vitest config).
    assertCanUseAi.mockResolvedValue(undefined)
    recordAiAction.mockResolvedValue(undefined)

    // Default $transaction: execute callback with prisma as tx (for interactive transactions)
    prisma.$transaction.mockImplementation(async (fn) => {
      if (typeof fn === 'function') return fn(prisma)
      // array-style transactions (used in deleteConversation)
      return Promise.all(fn.map(p => p))
    })
  })

  // ---------------------------------------------------------------------------
  // buildTrainerContext
  // ---------------------------------------------------------------------------

  describe('buildTrainerContext', () => {
    it('throws AppError 404 with AI_CONTEXT_BUILD_FAILED when trainer profile is not found', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null)

      await expect(buildTrainerContext('user-without-trainer')).rejects.toMatchObject({
        httpStatus: 404,
        error: AI_ERRORS.CONTEXT_BUILD_FAILED,
        messageCode: 'ai.trainerNotFound',
      })
    })

    it('queries all context entities with their respective take limits', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])

      await buildTrainerContext('user-1')

      expect(prisma.trainerStudent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: AI_LIMITS.MAX_CONTEXT_STUDENTS }),
      )
      expect(prisma.trainingProtocolTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: AI_LIMITS.MAX_CONTEXT_PROTOCOL_TEMPLATES }),
      )
      expect(prisma.trainingTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: AI_LIMITS.MAX_CONTEXT_TRAINING_TEMPLATES }),
      )
      expect(prisma.trainingProtocol.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: AI_LIMITS.MAX_CONTEXT_ACTIVE_PROTOCOLS }),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool
  // ---------------------------------------------------------------------------

  describe('executeTool', () => {
    it('returns { success: false, error: "UNKNOWN_TOOL" } for an unrecognised tool name', async () => {
      const result = await executeTool('user-1', 'completely_unknown_tool', {})

      expect(result).toMatchObject({
        success: false,
        error: 'UNKNOWN_TOOL',
      })
    })

    it('returns { success: false, error, messageCode, message } when service throws AppError', async () => {
      const { AppError } = await import('../../src/errors/app-error.js')
      importFromTemplate.mockImplementationOnce(() => {
        throw new AppError({
          httpStatus: 404,
          error: 'TEMPLATE_NOT_FOUND',
          messageCode: 'protocol.templateNotFound',
          message: 'Template not found',
        })
      })

      const result = await executeTool('user-1', AI_TOOLS.IMPORT_FROM_TEMPLATE, {
        templateId: 'tmpl-1',
        assigneeId: 'student-1',
        startDate: '2026-01-01',
        expirationDate: '2026-06-01',
      })

      expect(result).toMatchObject({
        success: false,
        error: 'TEMPLATE_NOT_FOUND',
        messageCode: 'protocol.templateNotFound',
        message: 'Template not found',
      })
    })

    it('re-throws generic (non-AppError) errors — does not swallow them', async () => {
      const networkError = new Error('Unexpected database timeout')

      importFromTemplate.mockRejectedValue(networkError)

      await expect(
        executeTool('user-1', AI_TOOLS.IMPORT_FROM_TEMPLATE, {
          templateId: 'tmpl-1',
          assigneeId: 'student-1',
          startDate: '2026-01-01',
          expirationDate: '2026-06-01',
        }),
      ).rejects.toThrow('Unexpected database timeout')
    })

    describe(`${AI_TOOLS.ADD_TRAINING_TO_PROTOCOL}`, () => {
      it('throws AppError 403 when the trainer does not own the protocol', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-A' })
        prisma.trainingProtocol.findUnique.mockResolvedValue({
          id: 'protocol-1',
          trainerId: 'trainer-B', // different owner
          deletedAt: null,
        })

        const result = await executeTool('user-1', AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, {
          protocolId: 'protocol-1',
          trainings: [{ name: 'Peito', category: 'strength' }],
        })

        expect(result).toMatchObject({
          success: false,
          error: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
          messageCode: 'legacy.FORBIDDEN_NOT_PROTOCOL_OWNER',
        })
        expect(prisma.$transaction).not.toHaveBeenCalled()
      })

      it('throws AppError 400 when trainings array is empty', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })

        const result = await executeTool('user-1', AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, {
          protocolId: 'protocol-1',
          trainings: [],
        })

        expect(result).toMatchObject({
          success: false,
          error: 'VALIDATION_ERROR',
          messageCode: 'validation.failed',
        })
        expect(prisma.trainingProtocol.findUnique).not.toHaveBeenCalled()
        expect(prisma.$transaction).not.toHaveBeenCalled()
      })

      it('throws AppError 404 when protocol is soft-deleted', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.trainingProtocol.findUnique.mockResolvedValue({
          id: 'protocol-1',
          trainerId: 'trainer-1',
          deletedAt: new Date(), // soft-deleted
        })

        const result = await executeTool('user-1', AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, {
          protocolId: 'protocol-1',
          trainings: [{ name: 'Costas', category: 'strength' }],
        })

        expect(result).toMatchObject({
          success: false,
          error: 'PROTOCOL_NOT_FOUND',
          messageCode: 'legacy.PROTOCOL_NOT_FOUND',
        })
        expect(prisma.$transaction).not.toHaveBeenCalled()
      })

      it('executes trainings inside prisma.$transaction for atomicity', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.trainingProtocol.findUnique.mockResolvedValue({
          id: 'protocol-1',
          trainerId: 'trainer-1',
          deletedAt: null,
        })
        prisma.training.create.mockResolvedValue({ id: 'training-new-1' })

        const result = await executeTool('user-1', AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, {
          protocolId: 'protocol-1',
          trainings: [{ name: 'Pernas', category: 'strength' }],
        })

        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({ success: true })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // processAiChat
  // ---------------------------------------------------------------------------

  describe('processAiChat', () => {
    function stubTrainerContext() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
    }

    function stubNewConversation(conversationId = 'conv-1') {
      prisma.aiConversation.create.mockResolvedValue({ id: conversationId, userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-1' })
      prisma.aiConversation.update.mockResolvedValue({})
    }

    function stubExistingConversation({ conversationId = 'conv-1', userId = 'user-1', messages = [] } = {}) {
      // loadConversationHistory now queries with orderBy: { createdAt: 'desc' } + take.
      // Messages passed here are in chronological (ASC) order — reverse them so the
      // service's internal .reverse() restores the original ASC order correctly.
      prisma.aiConversation.findUnique.mockResolvedValue({
        id: conversationId,
        userId,
        title: 'Test',
        messages: [...messages].reverse(),
      })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-2' })
      prisma.aiConversation.update.mockResolvedValue({})
    }

    it('creates a new conversation and returns conversationId when none provided', async () => {
      stubTrainerContext()
      stubNewConversation('new-conv-1')

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Como posso ajudar hoje?' }],
      })

      const result = await processAiChat('user-1', { message: 'Olá' })

      expect(prisma.aiConversation.create).toHaveBeenCalledWith({ data: { userId: 'user-1' } })
      expect(result.conversationId).toBe('new-conv-1')
      expect(result.actionsExecuted).toEqual([])
      expect(result.message).toBe('Como posso ajudar hoje?')
    })

    it('loads existing conversation history from DB when conversationId provided', async () => {
      stubTrainerContext()
      stubExistingConversation({
        conversationId: 'existing-conv',
        userId: 'user-1',
        messages: [
          { role: 'user', content: 'Mensagem anterior' },
          { role: 'assistant', content: 'Resposta anterior' },
        ],
      })

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Claro!' }],
      })

      const result = await processAiChat('user-1', { message: 'Continuar', conversationId: 'existing-conv' })

      expect(prisma.aiConversation.create).not.toHaveBeenCalled()
      expect(result.conversationId).toBe('existing-conv')
    })

    it('throws 404 when conversationId is not found or belongs to another user', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(null)

      await expect(
        processAiChat('user-1', { message: 'Olá', conversationId: 'ghost-conv' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: AI_ERRORS.CONVERSATION_NOT_FOUND,
        messageCode: 'ai.conversationNotFound',
      })
    })

    it('does NOT execute tool and returns message when history has fewer than 2 messages', async () => {
      stubTrainerContext()
      stubNewConversation()

      const toolUseBlock = {
        type: 'tool_use',
        id: 'tool-call-2',
        name: AI_TOOLS.IMPORT_FROM_TEMPLATE,
        input: { templateId: 'tmpl-1', assigneeId: 'student-1', startDate: '2026-01-01', expirationDate: '2026-06-30' },
      }

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Vou criar o protocolo. Confirma?' },
          toolUseBlock,
        ],
      })

      // Empty DB history — first turn
      const result = await processAiChat('user-1', { message: 'Sim, cria o protocolo A agora' })

      expect(importFromTemplate).not.toHaveBeenCalled()
      expect(result.actionsExecuted).toEqual([])
      expect(result.message).toBeTruthy()
    })

    it('executes the tool and returns actionsExecuted when history has >= 2 messages', async () => {
      stubTrainerContext()
      stubExistingConversation({
        messages: [
          { role: 'user', content: 'Crie um treino para João usando o template A' },
          { role: 'assistant', content: 'Vou criar o protocolo A para João. Confirma?' },
        ],
      })

      const toolUseBlock = {
        type: 'tool_use',
        id: 'tool-call-1',
        name: AI_TOOLS.IMPORT_FROM_TEMPLATE,
        input: {
          templateId: 'tmpl-1',
          assigneeId: 'student-1',
          startDate: '2026-01-01',
          expirationDate: '2026-06-01',
        },
      }

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'Criando...' }, toolUseBlock],
      })
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Protocolo criado com sucesso!' }],
      })

      importFromTemplate.mockResolvedValue({ id: 'new-protocol-1' })

      const result = await processAiChat('user-1', {
        message: 'Sim, pode criar',
        conversationId: 'conv-1',
      })

      expect(result.actionsExecuted).toHaveLength(1)
      expect(result.actionsExecuted[0]).toMatchObject({
        tool: AI_TOOLS.IMPORT_FROM_TEMPLATE,
        success: true,
      })
    })

    it('does NOT execute any tool when model returns multiple tool_use blocks', async () => {
      stubTrainerContext()
      stubExistingConversation({
        messages: [
          { role: 'user', content: 'Crie dois protocolos' },
          { role: 'assistant', content: 'Confirma criar dois protocolos?' },
        ],
      })

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Vou fazer duas coisas.' },
          { type: 'tool_use', id: 'tc-1', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: {} },
          { type: 'tool_use', id: 'tc-2', name: AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, input: {} },
        ],
      })

      const result = await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-1' })

      expect(importFromTemplate).not.toHaveBeenCalled()
      expect(result.actionsExecuted).toEqual([])
    })

    it('throws AppError 429 with AI_RATE_LIMITED when Anthropic API returns 429', async () => {
      stubTrainerContext()
      stubNewConversation()

      const rateLimitError = new Error('Rate limited')
      rateLimitError.status = 429
      anthropicCreate.mockRejectedValue(rateLimitError)

      await expect(
        processAiChat('user-1', { message: 'Olá' }),
      ).rejects.toMatchObject({
        httpStatus: 429,
        error: AI_ERRORS.RATE_LIMITED,
        messageCode: 'ai.rateLimited',
      })
    })

    it('throws AppError 502 with AI_MODEL_ERROR when Anthropic API returns 500', async () => {
      stubTrainerContext()
      stubNewConversation()

      const serverError = new Error('Internal server error from Anthropic')
      serverError.status = 500
      anthropicCreate.mockRejectedValue(serverError)

      await expect(
        processAiChat('user-1', { message: 'Olá' }),
      ).rejects.toMatchObject({
        httpStatus: 502,
        error: AI_ERRORS.MODEL_ERROR,
        messageCode: 'ai.modelError',
      })
    })

    it('sets the conversation title to the first 100 chars of the first user message', async () => {
      stubTrainerContext()
      stubNewConversation('new-conv-title-test')

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá!' }],
      })

      const longMessage = 'A'.repeat(150)
      await processAiChat('user-1', { message: longMessage })

      expect(prisma.aiConversation.update).toHaveBeenCalledWith({
        where: { id: 'new-conv-title-test' },
        data: { title: 'A'.repeat(100) },
      })
    })

    // -------------------------------------------------------------------------
    // Retry and backoff logic (tested via processAiChat)
    // -------------------------------------------------------------------------

    describe('retry and backoff', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('throws immediately without retry when the LLM returns a non-retryable status (400)', async () => {
        stubTrainerContext()
        stubNewConversation()

        const clientError = new Error('Bad request')
        clientError.status = 400
        anthropicCreate.mockRejectedValue(clientError)

        vi.useFakeTimers()

        // Register the rejection handler before advancing timers to avoid unhandled rejection warnings
        const assertion = expect(processAiChat('user-1', { message: 'Olá' })).rejects.toMatchObject({
          httpStatus: 502,
          error: AI_ERRORS.MODEL_ERROR,
          messageCode: 'ai.modelError',
        })
        await vi.runAllTimersAsync()
        await assertion

        // Non-retryable: exactly one attempt, no retries
        expect(anthropicCreate).toHaveBeenCalledTimes(1)
      })

      it('does not expose raw error message to client on 502 fallback', async () => {
        stubTrainerContext()
        stubNewConversation()

        const internalError = new Error('Internal details that must not leak to the client')
        internalError.status = 400
        anthropicCreate.mockRejectedValue(internalError)

        vi.useFakeTimers()

        let caughtError
        const promise = processAiChat('user-1', { message: 'Olá' }).catch((err) => {
          caughtError = err
        })
        await vi.runAllTimersAsync()
        await promise

        expect(caughtError.message).not.toContain('Internal details that must not leak to the client')
        expect(caughtError.message).toBe('AI service temporarily unavailable. Please try again later.')
      })

      it('succeeds on 2nd attempt after a retryable 529 failure on the 1st', async () => {
        stubTrainerContext()
        stubNewConversation()

        const overloadedError = new Error('Overloaded')
        overloadedError.status = 529

        anthropicCreate
          .mockRejectedValueOnce(overloadedError)
          .mockResolvedValueOnce({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Resposta bem-sucedida' }],
          })

        vi.useFakeTimers()

        const promise = processAiChat('user-1', { message: 'Olá' })
        await vi.runAllTimersAsync()
        const result = await promise

        expect(anthropicCreate).toHaveBeenCalledTimes(2)
        expect(result.message).toBe('Resposta bem-sucedida')
      })

      it('throws normalized AppError after exhausting all 3 attempts with retryable 529', async () => {
        stubTrainerContext()
        stubNewConversation()

        const overloadedError = new Error('Overloaded')
        overloadedError.status = 529
        anthropicCreate.mockRejectedValue(overloadedError)

        vi.useFakeTimers()

        // Register the rejection handler before advancing timers to avoid unhandled rejection warnings
        const assertion = expect(processAiChat('user-1', { message: 'Olá' })).rejects.toMatchObject({
          httpStatus: 529,
          error: AI_ERRORS.OVERLOADED,
          messageCode: 'ai.overloaded',
        })
        await vi.runAllTimersAsync()
        await assertion

        expect(anthropicCreate).toHaveBeenCalledTimes(AI_RETRY.MAX_ATTEMPTS)
      })

      it('applies exponential backoff delays between retries (1s then 2s)', async () => {
        stubTrainerContext()
        stubNewConversation()

        const overloadedError = new Error('Overloaded')
        overloadedError.status = 529
        anthropicCreate.mockRejectedValue(overloadedError)

        vi.useFakeTimers()
        const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

        let caughtError
        const promise = processAiChat('user-1', { message: 'Olá' }).catch((err) => {
          caughtError = err
        })
        await vi.runAllTimersAsync()
        await promise

        // Extract only the retry delays (filter out any internal Promise/timer calls
        // with delay 0 or undefined that Vitest/Node may emit)
        const retryDelays = setTimeoutSpy.mock.calls
          .map((args) => args[1])
          .filter((delay) => delay > 0)

        // Attempt 1 fails → delay 1000ms (BASE_DELAY_MS * 2^0)
        // Attempt 2 fails → delay 2000ms (BASE_DELAY_MS * 2^1)
        // Attempt 3 fails → no delay (last attempt)
        expect(retryDelays).toContain(AI_RETRY.BASE_DELAY_MS * 2 ** 0)
        expect(retryDelays).toContain(AI_RETRY.BASE_DELAY_MS * 2 ** 1)
        expect(caughtError).toBeDefined()
      })
    })
  })

  // ---------------------------------------------------------------------------
  // listConversations
  // ---------------------------------------------------------------------------

  describe('listConversations', () => {
    it('throws AppError 404 when trainer profile is not found', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null)

      await expect(listConversations('user-without-trainer')).rejects.toMatchObject({
        httpStatus: 404,
        error: AI_ERRORS.CONTEXT_BUILD_FAILED,
        messageCode: 'ai.trainerNotFound',
      })
    })

    it('returns conversations ordered by updatedAt desc', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      const mockConversations = [
        { id: 'conv-2', title: 'Second', createdAt: new Date(), updatedAt: new Date() },
        { id: 'conv-1', title: 'First', createdAt: new Date(), updatedAt: new Date() },
      ]
      prisma.aiConversation.findMany.mockResolvedValue(mockConversations)

      const result = await listConversations('user-1')

      expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' }, orderBy: { updatedAt: 'desc' } }),
      )
      expect(result).toEqual(mockConversations)
    })
  })

  // ---------------------------------------------------------------------------
  // getConversation
  // ---------------------------------------------------------------------------

  describe('getConversation', () => {
    it('throws AppError 404 when conversation does not exist', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(null)

      await expect(getConversation('user-1', 'non-existent')).rejects.toMatchObject({
        httpStatus: 404,
        error: AI_ERRORS.CONVERSATION_NOT_FOUND,
        messageCode: 'ai.conversationNotFound',
      })
    })

    it('throws AppError 404 when conversation belongs to a different user', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-2', // different user
        messages: [],
      })

      await expect(getConversation('user-1', 'conv-1')).rejects.toMatchObject({
        httpStatus: 404,
        error: AI_ERRORS.CONVERSATION_NOT_FOUND,
      })
    })

    it('returns conversation with messages when found and owned by user', async () => {
      const mockConversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [{ id: 'msg-1', role: 'user', content: 'Olá' }],
      }
      prisma.aiConversation.findUnique.mockResolvedValue(mockConversation)

      const result = await getConversation('user-1', 'conv-1')

      expect(result).toEqual(mockConversation)
    })
  })

  // ---------------------------------------------------------------------------
  // Multi-turn conversation history reconstruction
  // ---------------------------------------------------------------------------

  describe('multi-turn conversation history reconstruction', () => {
    function stubTrainerContext() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
    }

    it('saves rawContent on the assistant message after tool execution', async () => {
      stubTrainerContext()

      const rawContent = [
        { type: 'text', text: 'Vou criar...' },
        { type: 'tool_use', id: 'tc-1', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: {} },
      ]

      prisma.aiConversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [
          { role: 'user', content: 'Cria o protocolo' },
          { role: 'assistant', content: 'Confirma?' },
        ],
      })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-new' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: rawContent,
      })

      importFromTemplate.mockResolvedValue({ id: 'proto-1', name: 'Protocolo Teste' })

      await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-1' })

      // First aiMessage.create call is the user message, second is the assistant message
      const assistantCreateCall = prisma.aiMessage.create.mock.calls.find(
        (call) => call[0].data.role === 'assistant',
      )
      expect(assistantCreateCall).toBeDefined()
      expect(assistantCreateCall[0].data.rawContent).toEqual(rawContent)
    })

    it('saves a tool_result message after tool execution', async () => {
      stubTrainerContext()

      prisma.aiConversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [
          { role: 'user', content: 'Cria o protocolo' },
          { role: 'assistant', content: 'Confirma?' },
        ],
      })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-new' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tc-1', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: {} },
        ],
      })

      importFromTemplate.mockResolvedValue({ id: 'proto-1', name: 'Protocolo Teste' })

      await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-1' })

      const toolResultCreateCall = prisma.aiMessage.create.mock.calls.find(
        (call) => call[0].data.role === 'tool_result',
      )
      expect(toolResultCreateCall).toBeDefined()
      expect(toolResultCreateCall[0].data.rawContent).toBeDefined()
      expect(Array.isArray(toolResultCreateCall[0].data.rawContent)).toBe(true)
    })

    it('does not save rawContent for blocked tool calls (enforcement)', async () => {
      stubTrainerContext()

      // New conversation — enforcement will block the tool call
      prisma.aiConversation.create.mockResolvedValue({ id: 'new-conv', userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-1' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Vou criar o protocolo. Confirma?' },
          { type: 'tool_use', id: 'tc-1', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: {} },
        ],
      })

      await processAiChat('user-1', { message: 'Cria o protocolo agora' })

      // Tool was blocked — no tool_result message should be saved
      const toolResultCreateCall = prisma.aiMessage.create.mock.calls.find(
        (call) => call[0].data.role === 'tool_result',
      )
      expect(toolResultCreateCall).toBeUndefined()

      // Assistant message saved for the blocked response should have no rawContent
      const assistantCreateCall = prisma.aiMessage.create.mock.calls.find(
        (call) => call[0].data.role === 'assistant',
      )
      expect(assistantCreateCall).toBeDefined()
      expect(assistantCreateCall[0].data.rawContent).toBeUndefined()
    })

    it('reconstructs multi-turn history correctly when history contains tool_result records', async () => {
      stubTrainerContext()

      const rawAssistantContent = [
        { type: 'text', text: 'Criando...' },
        { type: 'tool_use', id: 'tc-1', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: { templateId: 'tmpl-1', assigneeId: 'student-1', startDate: '2026-01-01', expirationDate: '2026-06-01' } },
      ]
      const toolResultData = [{ toolCallId: 'tc-1', content: '{"success":true,"name":"Protocolo Teste"}' }]

      // Conversation history includes a prior tool_use/tool_result exchange.
      // loadConversationHistory now queries DESC; provide messages in DESC order
      // (newest first) so the service's .reverse() restores the correct ASC order.
      prisma.aiConversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [
          { role: 'assistant', content: 'Claro, confirma?', rawContent: null },
          { role: 'user', content: 'E agora, cria outro?', rawContent: null },
          { role: 'tool_result', content: '{"success":true}', rawContent: toolResultData },
          { role: 'assistant', content: 'Protocolo criado!', rawContent: rawAssistantContent },
          { role: 'user', content: 'Cria usando template A', rawContent: null },
        ],
      })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-new' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Pode confirmar a criação?' }],
      })

      const result = await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-1' })

      expect(result.message).toBe('Pode confirmar a criação?')

      // Verify the messages sent to Anthropic include the reconstructed tool pair
      const llmCallArgs = anthropicCreate.mock.calls[0][0]
      const messages = llmCallArgs.messages

      // The reconstructed pair should appear: assistant (with rawContent) + user (tool_result)
      const assistantToolUseMsg = messages.find(
        (m) => m.role === 'assistant' && Array.isArray(m.content),
      )
      expect(assistantToolUseMsg).toBeDefined()
      expect(assistantToolUseMsg.content).toEqual(rawAssistantContent)

      // A user message with tool_result content should follow
      const toolResultUserMsg = messages.find(
        (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
      )
      expect(toolResultUserMsg).toBeDefined()
    })

    it('falls back to plain text for assistant messages without rawContent in history', async () => {
      stubTrainerContext()

      // Legacy messages (before rawContent was added) — no rawContent field
      prisma.aiConversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [
          { role: 'user', content: 'Olá', rawContent: null },
          { role: 'assistant', content: 'Olá! Como posso ajudar?', rawContent: null },
        ],
      })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-new' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Claro!' }],
      })

      const result = await processAiChat('user-1', { message: 'Continue', conversationId: 'conv-1' })

      expect(result.message).toBe('Claro!')

      // History sent to LLM should use plain string content for legacy messages
      const llmCallArgs = anthropicCreate.mock.calls[0][0]
      const assistantMsg = llmCallArgs.messages.find((m) => m.role === 'assistant')
      expect(assistantMsg.content).toBe('Olá! Como posso ajudar?')
    })
  })

  // ---------------------------------------------------------------------------
  // exercise field persistence (regression)
  // Regression guard: iArnold was dropping restInterval, sets, repetitions,
  // hasLoad, suggestedLoad on CREATE_TRAINING_TEMPLATE and CREATE_PROTOCOL_TEMPLATE.
  // ---------------------------------------------------------------------------

  describe('exercise field persistence (regression)', () => {
    const EXERCISE_INPUT = {
      name: 'Supino reto',
      type: 'strength',
      sets: 4,
      repetitions: { min: 8, max: 12 },
      restInterval: 90,
      hasLoad: true,
      suggestedLoad: 60,
      notes: 'Foco na descida controlada',
    }

    describe(`${AI_TOOLS.CREATE_TRAINING_TEMPLATE}`, () => {
      it('writes only identity fields to exerciseTemplate.create (no prescription); prescription lands on the junction row', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-created-1', name: 'Supino reto', type: 'strength', videoUrl: null })
        prisma.trainingTemplate.create.mockResolvedValue({
          id: 'tt-1',
          name: 'Treino A',
          category: 'strength',
          trainingTemplateExerciseTemplates: [],
        })

        await executeTool('user-1', AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
          name: 'Treino A',
          category: 'strength',
          exercises: [EXERCISE_INPUT],
        })

        // exerciseTemplate.create must carry identity only — no prescription fields
        expect(prisma.exerciseTemplate.create).toHaveBeenCalledTimes(1)
        expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              name: 'Supino reto',
              type: 'strength',
              isPublic: false,
            }),
          }),
        )
        const exerciseCreateData = prisma.exerciseTemplate.create.mock.calls[0][0].data
        expect(exerciseCreateData).not.toHaveProperty('sets')
        expect(exerciseCreateData).not.toHaveProperty('repetitions')
        expect(exerciseCreateData).not.toHaveProperty('restInterval')
        expect(exerciseCreateData).not.toHaveProperty('hasLoad')
        expect(exerciseCreateData).not.toHaveProperty('suggestedLoad')

        // Junction row (created via trainingTemplate.create) carries the prescription from the inline spec
        const trainingCreateCall = prisma.trainingTemplate.create.mock.calls[0][0]
        const junctionRows = trainingCreateCall.data.trainingTemplateExerciseTemplates.create
        expect(junctionRows).toHaveLength(1)
        expect(junctionRows[0]).toMatchObject({
          sets: 4,
          repetitions: { min: 8, max: 12 },
          restInterval: 90,
          hasLoad: true,
          suggestedLoad: 60,
        })
      })

      it('copies gifUrl from the created exercise template snapshot onto the junction row', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({
          id: 'ex-created-1',
          name: 'Supino reto',
          type: 'strength',
          videoUrl: null,
          gifUrl: 'https://example.com/supino.gif',
        })
        prisma.trainingTemplate.create.mockResolvedValue({
          id: 'tt-1',
          name: 'Treino A',
          category: 'strength',
          trainingTemplateExerciseTemplates: [],
        })

        await executeTool('user-1', AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
          name: 'Treino A',
          category: 'strength',
          exercises: [EXERCISE_INPUT],
        })

        const junctionRows = prisma.trainingTemplate.create.mock.calls[0][0].data.trainingTemplateExerciseTemplates.create
        expect(junctionRows[0]).toMatchObject({ gifUrl: 'https://example.com/supino.gif' })
      })

      it('copies gifUrl from an existing library template onto the junction row when linked by id', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.findMany.mockResolvedValue([
          { id: 'ex-existing-1', name: 'Agachamento', type: 'strength', videoUrl: null, gifUrl: 'https://example.com/agacha.gif' },
        ])
        prisma.trainingTemplate.create.mockResolvedValue({
          id: 'tt-1',
          name: 'Treino A',
          category: 'strength',
          trainingTemplateExerciseTemplates: [],
        })

        await executeTool('user-1', AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
          name: 'Treino A',
          category: 'strength',
          exerciseTemplateIds: ['ex-existing-1'],
        })

        const junctionRows = prisma.trainingTemplate.create.mock.calls[0][0].data.trainingTemplateExerciseTemplates.create
        expect(junctionRows[0]).toMatchObject({ gifUrl: 'https://example.com/agacha.gif' })
      })

      it('the exerciseTemplate select in the follow-up read contains only { id, name, type } — no prescription fields', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-created-1', name: 'Supino reto', type: 'strength', videoUrl: null })
        prisma.trainingTemplate.create.mockResolvedValue({
          id: 'tt-1',
          name: 'Treino A',
          category: 'strength',
          trainingTemplateExerciseTemplates: [],
        })

        await executeTool('user-1', AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
          name: 'Treino A',
          category: 'strength',
          exercises: [EXERCISE_INPUT],
        })

        const createCall = prisma.trainingTemplate.create.mock.calls[0][0]
        const exerciseSelect =
          createCall.include.trainingTemplateExerciseTemplates.include.exerciseTemplate.select

        // Identity-only select — prescription fields must NOT be present
        expect(exerciseSelect).toEqual({ id: true, name: true, type: true })
        expect(exerciseSelect).not.toHaveProperty('hasLoad')
        expect(exerciseSelect).not.toHaveProperty('suggestedLoad')
        expect(exerciseSelect).not.toHaveProperty('sets')
        expect(exerciseSelect).not.toHaveProperty('repetitions')
        expect(exerciseSelect).not.toHaveProperty('restInterval')
      })

      it('summarizeToolResult surfaces hasLoad and suggestedLoad in the tool_result message rawContent', async () => {
        // Drive via processAiChat so summarizeToolResult is exercised end-to-end.
        // Stub the trainer context queries used by buildTrainerContext.
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.trainerStudent.findMany.mockResolvedValue([])
        prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
        prisma.trainingTemplate.findMany.mockResolvedValue([])
        prisma.trainingProtocol.findMany.mockResolvedValue([])
        prisma.exerciseTemplate.findMany.mockResolvedValue([])

        // Existing conversation with 2+ messages so tool enforcement passes.
        prisma.aiConversation.findUnique.mockResolvedValue({
          id: 'conv-tt',
          userId: 'user-1',
          title: 'Test',
          messages: [
            { role: 'user', content: 'Cria um treino' },
            { role: 'assistant', content: 'Confirma?' },
          ],
        })
        prisma.aiMessage.create.mockResolvedValue({ id: 'msg-1' })
        prisma.aiConversation.update.mockResolvedValue({})

        // LLM first call returns a CREATE_TRAINING_TEMPLATE tool_use.
        anthropicCreate.mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tc-tt-1',
              name: AI_TOOLS.CREATE_TRAINING_TEMPLATE,
              input: {
                name: 'Treino A',
                category: 'strength',
                exercises: [EXERCISE_INPUT],
              },
            },
          ],
        })

        // Mock exerciseTemplate.create (used inside the $transaction) — must include snapshot fields
        prisma.exerciseTemplate.create.mockResolvedValue({
          id: 'ex-created-1',
          name: 'Supino reto',
          type: 'strength',
          videoUrl: null,
          sets: 4,
          repetitions: { min: 8, max: 12 },
          duration: null,
          hasLoad: true,
          suggestedLoad: 60,
          restInterval: 90,
          notes: null,
        })

        // Mock trainingTemplate.create to return a realistic shape so summarizeToolResult
        // can pick up hasLoad and suggestedLoad (now read from junction row snapshot fields).
        prisma.trainingTemplate.create.mockResolvedValue({
          id: 'tt-1',
          name: 'Treino A',
          category: 'strength',
          trainingTemplateExerciseTemplates: [
            {
              id: 'jt-1',
              exerciseTemplateId: 'ex-created-1',
              order: 0,
              name: 'Supino reto',
              type: 'strength',
              videoUrl: null,
              sets: 4,
              repetitions: { min: 8, max: 12 },
              duration: null,
              hasLoad: true,
              suggestedLoad: 60,
              restInterval: 90,
              notes: null,
              exerciseTemplate: {
                id: 'ex-created-1',
                name: 'Supino reto',
                type: 'strength',
                sets: 4,
                repetitions: { min: 8, max: 12 },
                restInterval: 90,
                hasLoad: true,
                suggestedLoad: 60,
              },
            },
          ],
        })

        // LLM second call (after tool result is fed back) returns a plain text response.
        anthropicCreate.mockResolvedValueOnce({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Treino criado com sucesso!' }],
        })

        await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-tt' })

        // Find the tool_result message saved to the DB.
        const toolResultCall = prisma.aiMessage.create.mock.calls.find(
          (call) => call[0].data.role === 'tool_result',
        )
        expect(toolResultCall).toBeDefined()

        const rawContent = toolResultCall[0].data.rawContent
        expect(Array.isArray(rawContent)).toBe(true)

        // The rawContent for a tool_result is an array of { toolCallId, content } entries.
        // Parse the JSON content to assert on the summary shape.
        const resultEntry = rawContent[0]
        const summary = JSON.parse(resultEntry.content)

        expect(summary.exercises).toBeDefined()
        expect(summary.exercises[0]).toMatchObject({
          sets: 4,
          repetitions: { min: 8, max: 12 },
          restInterval: 90,
          hasLoad: true,
          suggestedLoad: 60,
        })
      })
    })

    describe(`${AI_TOOLS.CREATE_PROTOCOL_TEMPLATE}`, () => {
      it('writes only identity fields to exerciseTemplate.create for inline exercises; prescription lands on the junction row', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-created-2', name: 'Supino reto', type: 'strength', videoUrl: null })
        prisma.trainingTemplate.create.mockResolvedValue({ id: 'tt-2' })
        prisma.trainingProtocolTemplate.create.mockResolvedValue({
          id: 'pt-1',
          name: 'Rotina Full Body',
          type: 'strength',
          trainings: [],
        })

        await executeTool('user-1', AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, {
          name: 'Rotina Full Body',
          trainings: [
            {
              name: 'Treino A',
              category: 'strength',
              exercises: [EXERCISE_INPUT],
            },
          ],
        })

        // exerciseTemplate.create must carry identity only — no prescription
        expect(prisma.exerciseTemplate.create).toHaveBeenCalledTimes(1)
        expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              name: 'Supino reto',
              type: 'strength',
              isPublic: false,
            }),
          }),
        )
        const exerciseCreateData = prisma.exerciseTemplate.create.mock.calls[0][0].data
        expect(exerciseCreateData).not.toHaveProperty('sets')
        expect(exerciseCreateData).not.toHaveProperty('repetitions')
        expect(exerciseCreateData).not.toHaveProperty('restInterval')
        expect(exerciseCreateData).not.toHaveProperty('hasLoad')
        expect(exerciseCreateData).not.toHaveProperty('suggestedLoad')

        // Junction rows (created via trainingTemplate.create) carry the prescription from the inline spec
        const trainingCreateCall = prisma.trainingTemplate.create.mock.calls[0][0]
        const junctionRows = trainingCreateCall.data.trainingTemplateExerciseTemplates.create
        expect(junctionRows).toHaveLength(1)
        expect(junctionRows[0]).toMatchObject({
          sets: 4,
          repetitions: { min: 8, max: 12 },
          restInterval: 90,
          hasLoad: true,
          suggestedLoad: 60,
        })
      })

      it('the exerciseTemplate select in the protocol follow-up read contains only { id, name, type } — no prescription fields', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-created-2', name: 'Supino reto', type: 'strength', videoUrl: null })
        prisma.trainingTemplate.create.mockResolvedValue({ id: 'tt-2' })
        prisma.trainingProtocolTemplate.create.mockResolvedValue({
          id: 'pt-1',
          name: 'Rotina Full Body',
          type: 'strength',
          trainings: [],
        })

        await executeTool('user-1', AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, {
          name: 'Rotina Full Body',
          trainings: [
            {
              name: 'Treino A',
              category: 'strength',
              exercises: [EXERCISE_INPUT],
            },
          ],
        })

        const protocolCreateCall = prisma.trainingProtocolTemplate.create.mock.calls[0][0]
        const exerciseSelect =
          protocolCreateCall.include.trainings.include.trainingTemplate.select
            .trainingTemplateExerciseTemplates.select.exerciseTemplate.select

        // Identity-only select — prescription fields must NOT be present
        expect(exerciseSelect).toEqual({ id: true, name: true, type: true })
        expect(exerciseSelect).not.toHaveProperty('hasLoad')
        expect(exerciseSelect).not.toHaveProperty('suggestedLoad')
        expect(exerciseSelect).not.toHaveProperty('sets')
        expect(exerciseSelect).not.toHaveProperty('repetitions')
        expect(exerciseSelect).not.toHaveProperty('restInterval')
      })

      it('summarizeToolResult surfaces hasLoad and suggestedLoad in the tool_result message rawContent', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.trainerStudent.findMany.mockResolvedValue([])
        prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
        prisma.trainingTemplate.findMany.mockResolvedValue([])
        prisma.trainingProtocol.findMany.mockResolvedValue([])
        prisma.exerciseTemplate.findMany.mockResolvedValue([])

        prisma.aiConversation.findUnique.mockResolvedValue({
          id: 'conv-pt',
          userId: 'user-1',
          title: 'Test',
          messages: [
            { role: 'user', content: 'Cria uma rotina' },
            { role: 'assistant', content: 'Confirma?' },
          ],
        })
        prisma.aiMessage.create.mockResolvedValue({ id: 'msg-2' })
        prisma.aiConversation.update.mockResolvedValue({})

        anthropicCreate.mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tc-pt-1',
              name: AI_TOOLS.CREATE_PROTOCOL_TEMPLATE,
              input: {
                name: 'Rotina Full Body',
                trainings: [
                  {
                    name: 'Treino A',
                    category: 'strength',
                    exercises: [EXERCISE_INPUT],
                  },
                ],
              },
            },
          ],
        })

        // Mock exerciseTemplate.create — must include snapshot fields so junction row is populated
        prisma.exerciseTemplate.create.mockResolvedValue({
          id: 'ex-created-2',
          name: 'Supino reto',
          type: 'strength',
          videoUrl: null,
          sets: 4,
          repetitions: { min: 8, max: 12 },
          duration: null,
          hasLoad: true,
          suggestedLoad: 60,
          restInterval: 90,
          notes: null,
        })
        prisma.trainingTemplate.create.mockResolvedValue({ id: 'tt-2' })

        // trainingProtocolTemplate.create returns a shape with nested exercises
        // so summarizeToolResult can surface hasLoad/suggestedLoad (now from junction row snapshot).
        prisma.trainingProtocolTemplate.create.mockResolvedValue({
          id: 'pt-1',
          name: 'Rotina Full Body',
          type: 'strength',
          trainings: [
            {
              weekDay: 'monday',
              trainingTemplate: {
                name: 'Treino A',
                trainingTemplateExerciseTemplates: [
                  {
                    id: 'jt-2',
                    exerciseTemplateId: 'ex-created-2',
                    order: 0,
                    name: 'Supino reto',
                    type: 'strength',
                    videoUrl: null,
                    sets: 4,
                    repetitions: { min: 8, max: 12 },
                    duration: null,
                    hasLoad: true,
                    suggestedLoad: 60,
                    restInterval: 90,
                    notes: null,
                    exerciseTemplate: {
                      id: 'ex-created-2',
                      name: 'Supino reto',
                      type: 'strength',
                      sets: 4,
                      repetitions: { min: 8, max: 12 },
                      restInterval: 90,
                      hasLoad: true,
                      suggestedLoad: 60,
                    },
                  },
                ],
              },
            },
          ],
        })

        anthropicCreate.mockResolvedValueOnce({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Rotina criada com sucesso!' }],
        })

        await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-pt' })

        const toolResultCall = prisma.aiMessage.create.mock.calls.find(
          (call) => call[0].data.role === 'tool_result',
        )
        expect(toolResultCall).toBeDefined()

        const rawContent = toolResultCall[0].data.rawContent
        expect(Array.isArray(rawContent)).toBe(true)

        const resultEntry = rawContent[0]
        const summary = JSON.parse(resultEntry.content)

        expect(summary.trainings).toBeDefined()
        expect(summary.trainings[0].exercises[0]).toMatchObject({
          sets: 4,
          repetitions: { min: 8, max: 12 },
          restInterval: 90,
          hasLoad: true,
          suggestedLoad: 60,
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // deleteConversation
  // ---------------------------------------------------------------------------

  describe('deleteConversation', () => {
    it('throws AppError 404 when conversation does not exist', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(null)

      await expect(deleteConversation('user-1', 'non-existent')).rejects.toMatchObject({
        httpStatus: 404,
        error: AI_ERRORS.CONVERSATION_NOT_FOUND,
        messageCode: 'ai.conversationNotFound',
      })
    })

    it('throws AppError 404 when conversation belongs to a different user', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue({ userId: 'user-2' })

      await expect(deleteConversation('user-1', 'conv-1')).rejects.toMatchObject({
        httpStatus: 404,
        error: AI_ERRORS.CONVERSATION_NOT_FOUND,
      })
    })

    it('deletes messages and conversation in a transaction', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue({ userId: 'user-1' })
      prisma.aiMessage.deleteMany.mockResolvedValue({ count: 3 })
      prisma.aiConversation.delete.mockResolvedValue({})

      await deleteConversation('user-1', 'conv-1')

      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
      expect(prisma.aiMessage.deleteMany).toHaveBeenCalledWith({ where: { conversationId: 'conv-1' } })
      expect(prisma.aiConversation.delete).toHaveBeenCalledWith({ where: { id: 'conv-1' } })
    })

    describe('withDeadlockRetry wrapping', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('retries on deadlock error then resolves successfully', async () => {
        prisma.aiConversation.findUnique.mockResolvedValue({ userId: 'user-1' })

        const deadlockErr = Object.assign(new Error('deadlock detected'), { code: 'P2034' })
        prisma.$transaction
          .mockRejectedValueOnce(deadlockErr)
          .mockResolvedValueOnce(undefined)

        vi.useFakeTimers()

        const promise = deleteConversation('user-1', 'conv-1')
        await vi.runAllTimersAsync()
        await expect(promise).resolves.toBeUndefined()

        expect(prisma.$transaction).toHaveBeenCalledTimes(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // didPreviousAssistantMessageListExercises
  // ---------------------------------------------------------------------------

  describe('didPreviousAssistantMessageListExercises', () => {
    it('returns false for empty history', () => {
      expect(didPreviousAssistantMessageListExercises([])).toBe(false)
    })

    it('returns false when history has no assistant message', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie um treino vazio' },
      ])).toBe(false)
    })

    it('returns false when last assistant message has no exercise patterns', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie um treino vazio' },
        { role: 'assistant', content: 'Vou criar um treino vazio chamado Peito. Confirma?' },
      ])).toBe(false)
    })

    it('returns true when last assistant message has 2+ bullet points', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie treino de peito' },
        {
          role: 'assistant',
          content: 'Vou criar:\n- Supino reto\n- Crucifixo\n- Voador\nConfirma?',
        },
      ])).toBe(true)
    })

    it('returns true when last assistant message has set/rep notation (3x10)', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie treino' },
        { role: 'assistant', content: 'Vou adicionar Supino com 3x10 repetições. Confirma?' },
      ])).toBe(true)
    })

    it('returns true when last assistant message has "séries" notation', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie treino' },
        { role: 'assistant', content: 'Vou criar Supino com 3 séries de 10 reps. Confirma?' },
      ])).toBe(true)
    })

    it('returns true when last assistant message has "series" (without accent) notation', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie treino' },
        { role: 'assistant', content: 'Vou criar Supino com 3 series de 10 reps. Confirma?' },
      ])).toBe(true)
    })

    it('returns true when assistant message lists exercises after colon', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie treino' },
        { role: 'assistant', content: 'Vou criar treino com exercícios: supino, crucifixo, voador. Confirma?' },
      ])).toBe(true)
    })

    it('returns false when "exercícios:" is followed by only one item', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie treino' },
        { role: 'assistant', content: 'Vou criar treino com exercícios: supino. Confirma?' },
      ])).toBe(false)
    })

    it('uses only the last assistant message, ignoring earlier ones', () => {
      // Earlier assistant message has bullet points; last one does not
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie treino' },
        { role: 'assistant', content: '- Supino\n- Crucifixo\nConfirma?' },
        { role: 'user', content: 'Sim' },
        { role: 'assistant', content: 'Treino criado!' },
      ])).toBe(false)
    })

    it('handles provider-specific array content (extracts text blocks)', () => {
      expect(didPreviousAssistantMessageListExercises([
        { role: 'user', content: 'Crie treino' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Vou criar:\n- Supino reto\n- Crucifixo\nConfirma?' },
          ],
        },
      ])).toBe(true)
    })

    it('returns false for null/undefined input', () => {
      expect(didPreviousAssistantMessageListExercises(null)).toBe(false)
      expect(didPreviousAssistantMessageListExercises(undefined)).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // processAiChat — consistency warning when exercises were promised but missing
  // ---------------------------------------------------------------------------

  describe('processAiChat — exercise promise consistency check', () => {
    function stubTrainerContext() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
    }

    function stubExistingConversation({ conversationId = 'conv-1', userId = 'user-1', messages = [] } = {}) {
      // loadConversationHistory queries DESC + take; reverse here so the service's
      // internal .reverse() restores the original ASC order correctly.
      prisma.aiConversation.findUnique.mockResolvedValue({
        id: conversationId,
        userId,
        title: 'Test',
        messages: [...messages].reverse(),
      })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-2' })
      prisma.aiConversation.update.mockResolvedValue({})
    }

    it('appends warning when previous assistant message listed exercises but training was created with 0 exercises', async () => {
      stubTrainerContext()
      stubExistingConversation({
        messages: [
          { role: 'user', content: 'Crie treino de peito' },
          {
            role: 'assistant',
            content: 'Vou criar treino Peito com:\n- Supino reto\n- Crucifixo\n- Voador\nConfirma?',
          },
        ],
      })

      const toolUseBlock = {
        type: 'tool_use',
        id: 'tool-1',
        name: AI_TOOLS.CREATE_TRAINING_TEMPLATE,
        input: { name: 'Peito', category: 'strength', exercises: [] },
      }

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [toolUseBlock],
      })

      // Mock the DB training creation (empty exercises)
      prisma.$transaction.mockImplementationOnce(async (fn) => fn(prisma))
      prisma.trainingTemplate.create.mockResolvedValue({
        id: 'train-1',
        name: 'Peito',
        category: 'strength',
        trainingTemplateExerciseTemplates: [],
      })

      const result = await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-1' })

      expect(result.message).toContain('Atenção')
      expect(result.message).toContain('exercícios que mencionei não foram incluídos')
      expect(result.message).toContain('Me diga os exercícios novamente')
    })

    it('does NOT append warning when previous assistant message did not list exercises and training has 0 exercises', async () => {
      stubTrainerContext()
      stubExistingConversation({
        messages: [
          { role: 'user', content: 'Quero um treino vazio por enquanto' },
          {
            role: 'assistant',
            content: 'Vou criar um treino vazio chamado Pernas. Confirma?',
          },
        ],
      })

      const toolUseBlock = {
        type: 'tool_use',
        id: 'tool-2',
        name: AI_TOOLS.CREATE_TRAINING_TEMPLATE,
        input: { name: 'Pernas', category: 'strength', exercises: [] },
      }

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [toolUseBlock],
      })

      prisma.$transaction.mockImplementationOnce(async (fn) => fn(prisma))
      prisma.trainingTemplate.create.mockResolvedValue({
        id: 'train-2',
        name: 'Pernas',
        category: 'strength',
        trainingTemplateExerciseTemplates: [],
      })

      const result = await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-1' })

      expect(result.message).not.toContain('Atenção')
      expect(result.message).not.toContain('exercícios que mencionei não foram incluídos')
    })

    it('does NOT append warning when training was created with exercises (no broken promise)', async () => {
      stubTrainerContext()
      stubExistingConversation({
        messages: [
          { role: 'user', content: 'Crie treino de peito' },
          {
            role: 'assistant',
            content: 'Vou criar treino com:\n- Supino reto\n- Crucifixo\nConfirma?',
          },
        ],
      })

      const toolUseBlock = {
        type: 'tool_use',
        id: 'tool-3',
        name: AI_TOOLS.CREATE_TRAINING_TEMPLATE,
        input: {
          name: 'Peito',
          category: 'strength',
          exercises: [{ name: 'Supino reto', type: 'strength' }],
        },
      }

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [toolUseBlock],
      })

      prisma.$transaction.mockImplementationOnce(async (fn) => fn(prisma))
      prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-1', name: 'Supino reto' })
      prisma.trainingTemplate.create.mockResolvedValue({
        id: 'train-3',
        name: 'Peito',
        category: 'strength',
        trainingTemplateExerciseTemplates: [{ name: 'Supino reto', sets: 3, repetitions: { min: 10, max: 12 }, restInterval: 60 }],
      })

      const result = await processAiChat('user-1', { message: 'Sim', conversationId: 'conv-1' })

      expect(result.message).not.toContain('Atenção')
    })
  })

  // ---------------------------------------------------------------------------
  // buildSystemPrompt — prompt caching structure
  // ---------------------------------------------------------------------------

  describe('buildSystemPrompt — prompt caching', () => {
    function setupMinimalContext() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv-cache', userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-cache' })
      prisma.aiConversation.update.mockResolvedValue({})
      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Ok' }],
      })
    }

    it('system passed to Anthropic SDK is an array (not a string)', async () => {
      setupMinimalContext()
      await processAiChat('user-1', { message: 'Olá' })

      const system = anthropicCreate.mock.calls[0][0].system
      expect(Array.isArray(system)).toBe(true)
    })

    it('returns an array of exactly 2 blocks', async () => {
      setupMinimalContext()
      await processAiChat('user-1', { message: 'Olá' })

      const system = anthropicCreate.mock.calls[0][0].system
      expect(system).toHaveLength(2)
    })

    it('first block has cache_control: { type: "ephemeral" }', async () => {
      setupMinimalContext()
      await processAiChat('user-1', { message: 'Olá' })

      const [staticBlock] = anthropicCreate.mock.calls[0][0].system
      expect(staticBlock.cache_control).toEqual({ type: 'ephemeral' })
    })

    it('second block has no cache_control', async () => {
      setupMinimalContext()
      await processAiChat('user-1', { message: 'Olá' })

      const [, dynamicBlock] = anthropicCreate.mock.calls[0][0].system
      expect(dynamicBlock.cache_control).toBeUndefined()
    })

    it('first block contains static rules, second block contains DATA ATUAL', async () => {
      setupMinimalContext()
      await processAiChat('user-1', { message: 'Olá' })

      const [staticBlock, dynamicBlock] = anthropicCreate.mock.calls[0][0].system
      expect(staticBlock.text).toContain('SEGURANCA')
      expect(staticBlock.text).toContain('REGRAS DE EXECUCAO')
      expect(staticBlock.text).not.toContain('DATA ATUAL')
      expect(dynamicBlock.text).toContain('DATA ATUAL')
      expect(dynamicBlock.text).toContain('CONTEXTO DO TREINADOR')
    })
  })

  // ---------------------------------------------------------------------------
  // buildSystemPrompt — fidelity rule presence
  // ---------------------------------------------------------------------------

  describe('buildSystemPrompt — fidelity rule', () => {
    it('system prompt sent to LLM contains the fidelity rule (rule 5)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv-fidelity', userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-f' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Ok' }],
      })

      await processAiChat('user-1', { message: 'Olá' })

      const callArgs = anthropicCreate.mock.calls[0][0]
      // system is now an array of blocks — check the static block (index 0)
      const staticBlock = callArgs.system[0]
      expect(staticBlock.text).toContain('FIDELIDADE DESCRICAO')
      expect(staticBlock.text).toContain('TOOL CALL')
    })

    it('system prompt rules are uniquely numbered (no duplicate rule numbers)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv-nums', userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-n' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Ok' }],
      })

      await processAiChat('user-1', { message: 'Olá' })

      // system is an array of blocks — join all text for rule-number uniqueness check
      const systemBlocks = anthropicCreate.mock.calls[0][0].system
      const systemText = systemBlocks.map((b) => b.text).join('\n')
      // Extract all lines that start with a standalone rule number at the beginning
      const ruleNumberMatches = [...systemText.matchAll(/^(\d+)\./gm)].map((m) => Number(m[1]))
      const unique = new Set(ruleNumberMatches)
      expect(ruleNumberMatches.length).toBe(unique.size)
    })
  })

  // ---------------------------------------------------------------------------
  // TOOLS array — exercise field descriptions contain fidelity instruction
  // ---------------------------------------------------------------------------

  describe('TOOLS array — exercises field descriptions', () => {
    it('CREATE_TRAINING_TEMPLATE exercises description warns about promised exercises', async () => {
      // Access via the LLM call to verify the actual TOOLS array passed to Anthropic
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv-tools', userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-t' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Ok' }],
      })

      await processAiChat('user-1', { message: 'Olá' })

      const tools = anthropicCreate.mock.calls[0][0].tools
      const createTrainingTool = tools.find((t) => t.name === AI_TOOLS.CREATE_TRAINING_TEMPLATE)
      const exercisesDesc = createTrainingTool.input_schema.properties.exercises.description
      expect(exercisesDesc).toContain('OBRIGATORIAMENTE devem aparecer neste array')
      expect(exercisesDesc).toContain('Nunca chame esta tool com array vazio se voce prometeu exercicios')
    })

    it('CREATE_PROTOCOL_TEMPLATE trainings.exercises description warns about promised exercises', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv-tools2', userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-t2' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Ok' }],
      })

      await processAiChat('user-1', { message: 'Olá' })

      const tools = anthropicCreate.mock.calls[0][0].tools
      const createProtocolTool = tools.find((t) => t.name === AI_TOOLS.CREATE_PROTOCOL_TEMPLATE)
      const trainingsSchema = createProtocolTool.input_schema.properties.trainings
      const exercisesDesc = trainingsSchema.items.properties.exercises.description
      expect(exercisesDesc).toContain('OBRIGATORIAMENTE devem aparecer neste array')
    })

    it('ADD_TRAINING_TO_PROTOCOL trainings.exercises description warns about promised exercises', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv-tools3', userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-t3' })
      prisma.aiConversation.update.mockResolvedValue({})

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Ok' }],
      })

      await processAiChat('user-1', { message: 'Olá' })

      const tools = anthropicCreate.mock.calls[0][0].tools
      const addTrainingTool = tools.find((t) => t.name === AI_TOOLS.ADD_TRAINING_TO_PROTOCOL)
      const exercisesDesc = addTrainingTool.input_schema.properties.trainings.items.properties.exercises.description
      expect(exercisesDesc).toContain('OBRIGATORIAMENTE devem aparecer neste array')
    })
  })

  // ---------------------------------------------------------------------------
  // prescriptionMode propagation through CREATE_TRAINING_TEMPLATE
  // ---------------------------------------------------------------------------

  describe('prescriptionMode propagation in CREATE_TRAINING_TEMPLATE', () => {
    it('persists prescriptionMode="duration" and applies exclusivity on the junction row when LLM emits a duration exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      // exerciseTemplate.create receives identity only (no prescription)
      prisma.exerciseTemplate.create.mockResolvedValue({
        id: 'ex-duration-1',
        name: 'Prancha Isométrica',
        type: 'strength',
        videoUrl: null,
      })
      prisma.trainingTemplate.create.mockResolvedValue({
        id: 'tt-duration-1',
        name: 'Core Day',
        category: 'strength',
        trainingTemplateExerciseTemplates: [],
      })

      await executeTool('user-1', AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Core Day',
        category: 'strength',
        exercises: [
          {
            name: 'Prancha Isométrica',
            type: 'strength',
            sets: 3,
            prescriptionMode: 'duration',
            duration: 30,
            restInterval: 60,
          },
        ],
      })

      // Prescription (prescriptionMode, duration, repetitions) lands on the junction row,
      // not on exerciseTemplate.create
      const trainingCreateCall = prisma.trainingTemplate.create.mock.calls[0][0]
      const junctionRows = trainingCreateCall.data.trainingTemplateExerciseTemplates.create
      expect(junctionRows[0]).toMatchObject({
        prescriptionMode: 'duration',
        duration: 30,
        repetitions: null,
      })
    })

    it('persists prescriptionMode="reps" and nulls duration on the junction row when LLM emits a reps exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.exerciseTemplate.create.mockResolvedValue({
        id: 'ex-reps-1',
        name: 'Supino',
        type: 'strength',
        videoUrl: null,
      })
      prisma.trainingTemplate.create.mockResolvedValue({
        id: 'tt-reps-1',
        name: 'Chest Day',
        category: 'strength',
        trainingTemplateExerciseTemplates: [],
      })

      await executeTool('user-1', AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Chest Day',
        category: 'strength',
        exercises: [
          {
            name: 'Supino',
            type: 'strength',
            sets: 4,
            prescriptionMode: 'reps',
            repetitions: { min: 8, max: 12 },
            hasLoad: true,
            suggestedLoad: 60,
            restInterval: 90,
          },
        ],
      })

      // prescriptionMode, repetitions, and duration (nulled) are on the junction row
      const trainingCreateCall = prisma.trainingTemplate.create.mock.calls[0][0]
      const junctionRows = trainingCreateCall.data.trainingTemplateExerciseTemplates.create
      expect(junctionRows[0]).toMatchObject({
        prescriptionMode: 'reps',
        repetitions: { min: 8, max: 12 },
        duration: null,
      })
    })

    it('defaults to prescriptionMode="reps" on the junction row when LLM omits the field, and nulls duration', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.exerciseTemplate.create.mockResolvedValue({
        id: 'ex-default-1',
        name: 'Agachamento',
        type: 'strength',
        videoUrl: null,
      })
      prisma.trainingTemplate.create.mockResolvedValue({
        id: 'tt-default-1',
        name: 'Leg Day',
        category: 'strength',
        trainingTemplateExerciseTemplates: [],
      })

      await executeTool('user-1', AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
        name: 'Leg Day',
        category: 'strength',
        exercises: [
          {
            name: 'Agachamento',
            type: 'strength',
            sets: 4,
            repetitions: { min: 10, max: 12 },
            restInterval: 60,
            // prescriptionMode intentionally omitted — LLM may forget it
          },
        ],
      })

      // Missing prescriptionMode must default to 'reps', and duration must be null — on the junction row
      const trainingCreateCall = prisma.trainingTemplate.create.mock.calls[0][0]
      const junctionRows = trainingCreateCall.data.trainingTemplateExerciseTemplates.create
      expect(junctionRows[0]).toMatchObject({
        prescriptionMode: 'reps',
        duration: null,
      })
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool — GET_STUDENT_PERFORMANCE
  // ---------------------------------------------------------------------------

  describe(`executeTool — ${AI_TOOLS.GET_STUDENT_PERFORMANCE}`, () => {
    const STUDENT_ID = 'student-uuid-1'

    const makeSnapshot = (overrides = {}) => ({
      studentId: STUDENT_ID,
      studentName: 'João Silva',
      window: { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z', days: 90 },
      sessionCounts: { completed: 3, in_progress: 1, abandoned: 1 },
      totalSessions: 5,
      completionRate: 0.75,
      lastSessionAt: '2026-04-01T10:00:00.000Z',
      currentProtocol: { id: 'protocol-1', name: 'Hypertrophy Block' },
      topExercises: [],
      ...overrides,
    })

    it('calls buildAiPerformanceSnapshot and returns { success: true, data: snapshot }', async () => {
      const snapshot = makeSnapshot()
      buildAiPerformanceSnapshot.mockResolvedValue(snapshot)

      const result = await executeTool('trainer-user-1', AI_TOOLS.GET_STUDENT_PERFORMANCE, {
        studentId: STUDENT_ID,
      })

      expect(buildAiPerformanceSnapshot).toHaveBeenCalledWith(
        'trainer-user-1',
        STUDENT_ID,
        expect.objectContaining({ windowDays: 90, includeExerciseProgression: true }),
      )
      expect(result).toMatchObject({ success: true, data: snapshot })
    })

    it('passes provided windowDays to buildAiPerformanceSnapshot', async () => {
      buildAiPerformanceSnapshot.mockResolvedValue(makeSnapshot({ window: { days: 30 } }))

      await executeTool('trainer-user-1', AI_TOOLS.GET_STUDENT_PERFORMANCE, {
        studentId: STUDENT_ID,
        windowDays: 30,
      })

      expect(buildAiPerformanceSnapshot).toHaveBeenCalledWith(
        'trainer-user-1',
        STUDENT_ID,
        expect.objectContaining({ windowDays: 30 }),
      )
    })

    it('defaults windowDays = 90 and includeExerciseProgression = true when both are omitted', async () => {
      buildAiPerformanceSnapshot.mockResolvedValue(makeSnapshot())

      await executeTool('trainer-user-1', AI_TOOLS.GET_STUDENT_PERFORMANCE, {
        studentId: STUDENT_ID,
      })

      expect(buildAiPerformanceSnapshot).toHaveBeenCalledWith(
        'trainer-user-1',
        STUDENT_ID,
        { windowDays: 90, includeExerciseProgression: true },
      )
    })

    it('passes includeExerciseProgression: false when explicitly set to false in toolInput', async () => {
      buildAiPerformanceSnapshot.mockResolvedValue(makeSnapshot({ topExercises: [] }))

      await executeTool('trainer-user-1', AI_TOOLS.GET_STUDENT_PERFORMANCE, {
        studentId: STUDENT_ID,
        includeExerciseProgression: false,
      })

      expect(buildAiPerformanceSnapshot).toHaveBeenCalledWith(
        'trainer-user-1',
        STUDENT_ID,
        expect.objectContaining({ includeExerciseProgression: false }),
      )
    })

    it('returns { success: false, error, messageCode } when student is not linked to trainer', async () => {
      const { AppError } = await import('../../src/errors/app-error.js')
      buildAiPerformanceSnapshot.mockRejectedValue(
        new AppError({
          httpStatus: 404,
          error: 'STUDENT_NOT_FOUND',
          messageCode: 'legacy.STUDENT_NOT_FOUND',
          message: 'Student not found or not assigned to you',
        }),
      )

      const result = await executeTool('trainer-user-1', AI_TOOLS.GET_STUDENT_PERFORMANCE, {
        studentId: 'unlinked-student',
      })

      expect(result).toMatchObject({
        success: false,
        error: 'STUDENT_NOT_FOUND',
        messageCode: 'legacy.STUDENT_NOT_FOUND',
      })
    })

    it('re-throws non-AppError errors (does not swallow unexpected failures)', async () => {
      const dbError = new Error('Database connection failed')
      buildAiPerformanceSnapshot.mockRejectedValue(dbError)

      await expect(
        executeTool('trainer-user-1', AI_TOOLS.GET_STUDENT_PERFORMANCE, { studentId: STUDENT_ID }),
      ).rejects.toThrow('Database connection failed')
    })
  })

  // ---------------------------------------------------------------------------
  // First-turn enforcement — READ_ONLY_TOOLS exemption
  // ---------------------------------------------------------------------------

  describe('first-turn enforcement: read-only tools bypass the confirmation gate', () => {
    function stubTrainerContext() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
    }

    function stubNewConversation(conversationId = 'conv-read-only') {
      prisma.aiConversation.create.mockResolvedValue({ id: conversationId, userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-1' })
      prisma.aiConversation.update.mockResolvedValue({})
    }

    it('executes get_student_performance on the first turn without requiring prior history', async () => {
      stubTrainerContext()
      stubNewConversation()

      const snapshot = {
        studentId: 'student-1',
        studentName: 'Ana Lima',
        window: { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z', days: 90 },
        sessionCounts: { completed: 2, in_progress: 0, abandoned: 0 },
        totalSessions: 2,
        completionRate: 1,
        lastSessionAt: '2026-04-01T10:00:00.000Z',
        currentProtocol: null,
        topExercises: [],
      }
      buildAiPerformanceSnapshot.mockResolvedValue(snapshot)

      anthropicCreate
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tc-read-1',
              name: AI_TOOLS.GET_STUDENT_PERFORMANCE,
              input: { studentId: 'student-1' },
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Ana completou 2 sessões recentemente.' }],
        })

      // Empty history — first turn. Tool should execute because it is read-only.
      const result = await processAiChat('user-1', { message: 'Como está a aluna Ana?' })

      expect(buildAiPerformanceSnapshot).toHaveBeenCalledTimes(1)
      expect(result.actionsExecuted).toHaveLength(1)
      expect(result.actionsExecuted[0].tool).toBe(AI_TOOLS.GET_STUDENT_PERFORMANCE)
      expect(result.actionsExecuted[0].success).toBe(true)
    })

    it('still blocks write tools on first turn even when read-only tools are allowed', async () => {
      stubTrainerContext()
      stubNewConversation()

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tc-write-1',
            name: AI_TOOLS.IMPORT_FROM_TEMPLATE,
            input: {
              templateId: 'tmpl-1',
              assigneeId: 'student-1',
              startDate: '2026-01-01',
              expirationDate: '2026-06-01',
            },
          },
        ],
      })

      // Empty history — first turn. Write tool should be blocked.
      const result = await processAiChat('user-1', { message: 'Crie um protocolo agora' })

      expect(importFromTemplate).not.toHaveBeenCalled()
      expect(result.actionsExecuted).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // summarizeToolResult — AI performance snapshot branch (via saveToolResultMessage)
  // ---------------------------------------------------------------------------

  describe('summarizeToolResult — AI performance snapshot saved to DB', () => {
    function stubTrainerContextForRead() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])
    }

    it('saves a tool_result message containing the summarized snapshot after get_student_performance executes', async () => {
      // The service generates the assistant text locally (buildToolResultMessage)
      // and calls saveToolResultMessage with the summarized snapshot. No second LLM call.
      stubTrainerContextForRead()
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv-snap', userId: 'user-1', title: null })
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg-snap' })
      prisma.aiConversation.update.mockResolvedValue({})

      const snapshot = {
        studentId: 'student-1',
        studentName: 'Carlos Souza',
        window: { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z', days: 90 },
        sessionCounts: { completed: 5, in_progress: 0, abandoned: 1 },
        totalSessions: 6,
        completionRate: 0.83,
        lastSessionAt: '2026-04-01T10:00:00.000Z',
        currentProtocol: { id: 'p-1', name: 'Força' },
        topExercises: [
          {
            exerciseId: 'ex-1',
            name: 'Supino',
            hasLoad: true,
            sessionCount: 5,
            lastPerformedAt: '2026-04-01T10:00:00.000Z',
            latestMaxLoad: 100,
            latestAvgLoad: 90,
            latestTotalVolume: 3600,
            maxLoadDelta: 10,
            maxLoadDeltaPct: 11.11,
          },
        ],
      }
      buildAiPerformanceSnapshot.mockResolvedValue(snapshot)

      anthropicCreate
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tc-snap-1',
              name: AI_TOOLS.GET_STUDENT_PERFORMANCE,
              input: { studentId: 'student-1' },
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Carlos completou 5 de 6 sessões (83% de adesão).' }],
        })

      const result = await processAiChat('user-1', { message: 'Como está Carlos?' })

      // The service returns actionsExecuted with the tool data
      expect(result.actionsExecuted).toHaveLength(1)
      expect(result.actionsExecuted[0]).toMatchObject({
        tool: AI_TOOLS.GET_STUDENT_PERFORMANCE,
        success: true,
      })

      // The final message comes from the second LLM call, not the deterministic fallback
      expect(result.message).toBe('Carlos completou 5 de 6 sessões (83% de adesão).')

      // aiMessage.create is called 4 times:
      // 1. saveUserMessage (the user's message)
      // 2. saveAssistantMessage (the first assistant turn with tool_use rawContent)
      // 3. saveToolResultMessage (the tool_result turn)
      // 4. saveAssistantMessage (the second assistant turn — LLM analysis text)
      expect(prisma.aiMessage.create).toHaveBeenCalledTimes(4)

      // Find the aiMessage.create call that saved the tool_result
      const toolResultCall = prisma.aiMessage.create.mock.calls.find(
        (args) => args[0].data?.role === 'tool_result',
      )
      expect(toolResultCall).toBeDefined()

      // The tool_result content must be the summarized snapshot JSON
      const savedContent = JSON.parse(toolResultCall[0].data.content)
      expect(savedContent).toMatchObject({
        success: true,
        studentId: 'student-1',
        studentName: 'Carlos Souza',
        sessionCounts: snapshot.sessionCounts,
        completionRate: snapshot.completionRate,
        topExercises: expect.any(Array),
      })
    })
  })

  // ---------------------------------------------------------------------------
  // unwrapRefTag
  // ---------------------------------------------------------------------------

  describe('unwrapRefTag', () => {
    it('strips [TYPE_REF:value] wrapper and returns the inner value', () => {
      expect(unwrapRefTag('[EXERCISE_REF:abc-123]')).toBe('abc-123')
      expect(unwrapRefTag('[TRAINING_REF:xyz-456]')).toBe('xyz-456')
      expect(unwrapRefTag('[ASSIGNEE_REF:00000000-0000-0000-0000-000000000001]')).toBe(
        '00000000-0000-0000-0000-000000000001',
      )
    })

    it('passes through a raw UUID unchanged', () => {
      const uuid = '00000000-0000-0000-0000-000000000001'
      expect(unwrapRefTag(uuid)).toBe(uuid)
    })

    it('trims leading/trailing whitespace before matching', () => {
      expect(unwrapRefTag('  [EXERCISE_REF:abc-123]  ')).toBe('abc-123')
      expect(unwrapRefTag('  raw-id  ')).toBe('raw-id')
    })

    it('returns null as-is', () => {
      expect(unwrapRefTag(null)).toBeNull()
    })

    it('returns undefined as-is', () => {
      expect(unwrapRefTag(undefined)).toBeUndefined()
    })

    it('does not strip malformed tags (missing closing bracket)', () => {
      // Pattern requires exactly [...] — partial tags are left as-is
      expect(unwrapRefTag('[EXERCISE_REF:abc-123')).toBe('[EXERCISE_REF:abc-123')
    })

    it('does not strip when tag has no colon separator', () => {
      expect(unwrapRefTag('[EXERCISE_REFabc-123]')).toBe('[EXERCISE_REFabc-123]')
    })
  })

  // ---------------------------------------------------------------------------
  // sanitizeToolInputIds
  // ---------------------------------------------------------------------------

  describe('sanitizeToolInputIds', () => {
    it('unwraps wrapped scalar *Id fields', () => {
      const result = sanitizeToolInputIds({
        trainingId: '[TRAINING_REF:train-1]',
        exerciseId: '[EXERCISE_REF:ex-1]',
        name: 'Treino A',
      })
      expect(result.trainingId).toBe('train-1')
      expect(result.exerciseId).toBe('ex-1')
      expect(result.name).toBe('Treino A')
    })

    it('unwraps wrapped array *Ids fields', () => {
      const result = sanitizeToolInputIds({
        exerciseIds: ['[EXERCISE_REF:ex-1]', '[EXERCISE_REF:ex-2]', 'ex-3'],
      })
      expect(result.exerciseIds).toEqual(['ex-1', 'ex-2', 'ex-3'])
    })

    it('passes through already-raw IDs unchanged', () => {
      const raw = { trainingId: 'train-abc', exerciseIds: ['ex-1', 'ex-2'] }
      const result = sanitizeToolInputIds(raw)
      expect(result.trainingId).toBe('train-abc')
      expect(result.exerciseIds).toEqual(['ex-1', 'ex-2'])
    })

    it('handles mixed wrapped and raw entries in an *Ids array', () => {
      const result = sanitizeToolInputIds({
        exerciseIds: ['[EXERCISE_REF:wrapped-1]', 'raw-2', '[EXERCISE_REF:wrapped-3]'],
      })
      expect(result.exerciseIds).toEqual(['wrapped-1', 'raw-2', 'wrapped-3'])
    })

    it('returns null/undefined *Id values as-is', () => {
      const result = sanitizeToolInputIds({ trainingId: null, exerciseId: undefined })
      expect(result.trainingId).toBeNull()
      expect(result.exerciseId).toBeUndefined()
    })

    it('returns the input unchanged when it is null', () => {
      expect(sanitizeToolInputIds(null)).toBeNull()
    })

    it('does not mutate the original input object', () => {
      const original = { trainingId: '[TRAINING_REF:t-1]', exerciseIds: ['[EXERCISE_REF:e-1]'] }
      sanitizeToolInputIds(original)
      expect(original.trainingId).toBe('[TRAINING_REF:t-1]')
      expect(original.exerciseIds[0]).toBe('[EXERCISE_REF:e-1]')
    })
  })

  // ---------------------------------------------------------------------------
  // executeTool — reorder_exercises_in_training ref-tag sanitization
  // ---------------------------------------------------------------------------

  describe(`executeTool ${AI_TOOLS.REORDER_EXERCISES_IN_TRAINING} (disabled)`, () => {
    it('returns AI_TOOL_DISABLED error and does not call reorderExercisesInTraining', async () => {
      const result = await executeTool('user-1', AI_TOOLS.REORDER_EXERCISES_IN_TRAINING, {
        trainingId: 'train-abc',
        exerciseIds: ['ex-1', 'ex-2'],
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('AI_TOOL_DISABLED')
      expect(reorderExercisesInTraining).not.toHaveBeenCalled()
    })
  })
})
