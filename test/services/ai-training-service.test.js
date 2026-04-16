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

import { prisma } from '../../src/db.js'
import Anthropic from '@anthropic-ai/sdk'
import { importFromTemplate } from '../../src/services/training-protocol-service.js'
import {
  buildTrainerContext,
  executeTool,
  processAiChat,
  listConversations,
  getConversation,
  deleteConversation,
} from '../../src/services/ai-training-service.js'
import { AI_TOOLS, AI_ERRORS, AI_LIMITS, AI_RETRY } from '../../src/constants/ai.js'

describe('ai-training-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Re-apply Anthropic constructor mock after mockReset clears implementations.
    // Must use a regular function (not arrow) because `new` requires a constructor.
    Anthropic.mockImplementation(function () { this.messages = { create: anthropicCreate } })

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

    it('queries all context entities with take: AI_LIMITS.MAX_CONTEXT_ITEMS', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
      prisma.trainerStudent.findMany.mockResolvedValue([])
      prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
      prisma.trainingTemplate.findMany.mockResolvedValue([])
      prisma.trainingProtocol.findMany.mockResolvedValue([])
      prisma.exerciseTemplate.findMany.mockResolvedValue([])

      await buildTrainerContext('user-1')

      expect(prisma.trainerStudent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: AI_LIMITS.MAX_CONTEXT_ITEMS }),
      )
      expect(prisma.trainingProtocolTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: AI_LIMITS.MAX_CONTEXT_ITEMS }),
      )
      expect(prisma.trainingTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: AI_LIMITS.MAX_CONTEXT_ITEMS }),
      )
      expect(prisma.trainingProtocol.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: AI_LIMITS.MAX_CONTEXT_ITEMS }),
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
      prisma.aiConversation.findUnique.mockResolvedValue({
        id: conversationId,
        userId,
        title: 'Test',
        messages,
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

      // Conversation history includes a prior tool_use/tool_result exchange
      prisma.aiConversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [
          { role: 'user', content: 'Cria usando template A', rawContent: null },
          { role: 'assistant', content: 'Protocolo criado!', rawContent: rawAssistantContent },
          { role: 'tool_result', content: '{"success":true}', rawContent: toolResultData },
          { role: 'user', content: 'E agora, cria outro?', rawContent: null },
          { role: 'assistant', content: 'Claro, confirma?', rawContent: null },
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
      it('persists all five exercise fields in exerciseTemplate.create', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-created-1' })
        prisma.trainingTemplate.create.mockResolvedValue({
          id: 'tt-1',
          name: 'Treino A',
          category: 'strength',
          trainingTemplateExerciseTemplates: [
            {
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

        await executeTool('user-1', AI_TOOLS.CREATE_TRAINING_TEMPLATE, {
          name: 'Treino A',
          category: 'strength',
          exercises: [EXERCISE_INPUT],
        })

        expect(prisma.exerciseTemplate.create).toHaveBeenCalledTimes(1)
        expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              sets: 4,
              repetitions: { min: 8, max: 12 },
              restInterval: 90,
              hasLoad: true,
              suggestedLoad: 60,
            }),
          }),
        )
      })

      it('includes hasLoad and suggestedLoad in the exerciseTemplate select on the follow-up read', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-created-1' })
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

        expect(exerciseSelect).toMatchObject({
          hasLoad: true,
          suggestedLoad: true,
        })
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
      it('persists all five exercise fields in exerciseTemplate.create for inline exercises', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-created-2' })
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

        expect(prisma.exerciseTemplate.create).toHaveBeenCalledTimes(1)
        expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              sets: 4,
              repetitions: { min: 8, max: 12 },
              restInterval: 90,
              hasLoad: true,
              suggestedLoad: 60,
            }),
          }),
        )
      })

      it('includes hasLoad and suggestedLoad in the exerciseTemplate select on the protocol follow-up read', async () => {
        prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
        prisma.exerciseTemplate.create.mockResolvedValue({ id: 'ex-created-2' })
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

        expect(exerciseSelect).toMatchObject({
          hasLoad: true,
          suggestedLoad: true,
        })
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
  })
})
