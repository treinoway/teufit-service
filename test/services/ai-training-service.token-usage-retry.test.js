import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findMany: vi.fn() },
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

vi.mock('../../src/llm/index.js', () => ({
  getLlmProvider: vi.fn(() => ({
    chat: mockChat,
    chatStream: mockChatStream,
    buildToolResultMessages: vi.fn(),
  })),
}))

vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
}))

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn().mockResolvedValue(undefined),
  recordAiAction: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/services/student-dashboard-service.js', () => ({
  buildAiPerformanceSnapshot: vi.fn(),
}))

vi.mock('../../src/services/ai-interaction-log-service.js', () => ({
  writeInteractionLog: vi.fn(),
}))

import { prisma } from '../../src/db.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { AI_MODELS, LLM_PROVIDERS } from '../../src/constants/ai.js'

const TRAINER_ID = 'trainer-1'
const CONVERSATION_ID = 'conv-retry-1'

const EMPTY_CALL_USAGE = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 40, cacheWriteTokens: 10 }
const GOOD_CALL_USAGE = { inputTokens: 110, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 5 }
const SUMMED_USAGE = { inputTokens: 210, outputTokens: 25, cacheReadTokens: 40, cacheWriteTokens: 15 }

const GOOD_TEXT = 'Olá! Como posso ajudar?'
const EMPTY_RESPONSE = { stopReason: 'end_turn', text: null, toolCalls: [], rawContent: null }
const GOOD_RESPONSE = {
  stopReason: 'end_turn',
  text: GOOD_TEXT,
  toolCalls: [],
  rawContent: [{ type: 'text', text: GOOD_TEXT }],
}

beforeEach(() => {
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  writeInteractionLog.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID })
  prisma.trainerStudent.findMany.mockResolvedValue([])
  prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
  prisma.trainingTemplate.findMany.mockResolvedValue([])
  prisma.trainingProtocol.findMany.mockResolvedValue([])
  prisma.exerciseTemplate.findMany.mockResolvedValue([])
  prisma.aiConversation.create.mockResolvedValue({ id: CONVERSATION_ID, userId: 'user-1', title: null })
  prisma.aiMessage.create.mockResolvedValue({ id: 'msg-1' })
  prisma.aiConversation.update.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.LLM_PROVIDER
})

// Provider stream yielding the text (if any) then a complete event carrying usage.
function streamOf(response, usage) {
  return async function* () {
    if (response.text) yield { type: 'text_delta', content: response.text }
    yield { type: 'complete', response: { ...response, usage } }
  }
}

// Runs a promise-returning action under fake timers so retry delays elapse instantly.
async function runWithFakeTimers(action) {
  vi.useFakeTimers()
  const pending = action()
  await vi.runAllTimersAsync()
  const result = await pending
  vi.useRealTimers()
  return result
}

// Collects every event of an async generator.
async function drain(generator) {
  const events = []
  for await (const event of generator) events.push(event)
  return events
}

// Stubs one empty call then one good call on the non-streaming provider.
function stubEmptyThenGoodChat() {
  mockChat
    .mockResolvedValueOnce({ ...EMPTY_RESPONSE, usage: EMPTY_CALL_USAGE })
    .mockResolvedValueOnce({ ...GOOD_RESPONSE, usage: GOOD_CALL_USAGE })
}

// Stubs one empty stream then one good stream.
function stubEmptyThenGoodStream() {
  mockChatStream
    .mockImplementationOnce(streamOf(EMPTY_RESPONSE, EMPTY_CALL_USAGE))
    .mockImplementationOnce(streamOf(GOOD_RESPONSE, GOOD_CALL_USAGE))
}

// ---------------------------------------------------------------------------
// processAiChat
// ---------------------------------------------------------------------------

describe('processAiChat — token usage across an empty-response retry', () => {
  it('records ONE AiTokenUsage row with llmCalls 2 and the summed usage', async () => {
    stubEmptyThenGoodChat()

    await runWithFakeTimers(() => processAiChat('user-1', { message: 'Olá' }))

    await vi.waitFor(() => expect(prisma.aiTokenUsage.create).toHaveBeenCalledOnce())
    expect(prisma.aiTokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ trainerId: TRAINER_ID, ...SUMMED_USAGE, llmCalls: 2 }),
    })
  })

  it('passes exactly the summed usage object to writeInteractionLog', async () => {
    stubEmptyThenGoodChat()

    await runWithFakeTimers(() => processAiChat('user-1', { message: 'Olá' }))

    expect(writeInteractionLog).toHaveBeenCalledOnce()
    expect(writeInteractionLog.mock.calls[0][1].usage).toEqual(SUMMED_USAGE)
  })

  it('records the Gemini provider and model for a retried turn', async () => {
    process.env.LLM_PROVIDER = LLM_PROVIDERS.GEMINI
    stubEmptyThenGoodChat()

    await runWithFakeTimers(() => processAiChat('user-1', { message: 'Olá' }))

    await vi.waitFor(() => expect(prisma.aiTokenUsage.create).toHaveBeenCalledOnce())
    expect(prisma.aiTokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: LLM_PROVIDERS.GEMINI,
        model: process.env.GEMINI_MODEL || AI_MODELS.GEMINI,
        llmCalls: 2,
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// processAiChatStream
// ---------------------------------------------------------------------------

describe('processAiChatStream — token usage across an empty-response retry', () => {
  it('records ONE AiTokenUsage row with llmCalls 2 and the summed usage', async () => {
    stubEmptyThenGoodStream()

    await runWithFakeTimers(() => drain(processAiChatStream('user-1', { message: 'Olá' })))

    await vi.waitFor(() => expect(prisma.aiTokenUsage.create).toHaveBeenCalledOnce())
    expect(prisma.aiTokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ trainerId: TRAINER_ID, ...SUMMED_USAGE, llmCalls: 2 }),
    })
  })

  it('passes exactly the summed usage object to writeInteractionLog', async () => {
    stubEmptyThenGoodStream()

    await runWithFakeTimers(() => drain(processAiChatStream('user-1', { message: 'Olá' })))

    expect(writeInteractionLog).toHaveBeenCalledOnce()
    expect(writeInteractionLog.mock.calls[0][1].usage).toEqual(SUMMED_USAGE)
  })

  it('records the Gemini provider and model for a retried turn', async () => {
    process.env.LLM_PROVIDER = LLM_PROVIDERS.GEMINI
    stubEmptyThenGoodStream()

    await runWithFakeTimers(() => drain(processAiChatStream('user-1', { message: 'Olá' })))

    await vi.waitFor(() => expect(prisma.aiTokenUsage.create).toHaveBeenCalledOnce())
    expect(prisma.aiTokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: LLM_PROVIDERS.GEMINI,
        model: process.env.GEMINI_MODEL || AI_MODELS.GEMINI,
        llmCalls: 2,
      }),
    })
  })
})
