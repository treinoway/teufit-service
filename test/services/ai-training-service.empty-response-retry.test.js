import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock Prisma before any service imports
vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findMany: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
    trainingProtocol: { findMany: vi.fn() },
    exerciseTemplate: { findMany: vi.fn() },
    aiConversation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    aiMessage: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

// Mock the LLM provider module so we can control chat() and chatStream() directly.
// This avoids the SDK→Provider chain and lets us inject any response shape.
const mockChat = vi.fn()
const mockChatStream = vi.fn()

vi.mock('../../src/llm/index.js', () => ({
  getLlmProvider: vi.fn(() => ({
    chat: mockChat,
    chatStream: mockChatStream,
    buildToolResultMessages: vi.fn((rawContent, toolResults) => [
      { role: 'assistant', content: rawContent },
      {
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.toolCallId,
          content: r.content,
        })),
      },
    ]),
  })),
}))

vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
}))

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '../../src/db.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { AI_RETRY } from '../../src/constants/ai.js'

// ---------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------

const EMPTY_RESPONSE = Object.freeze({
  stopReason: 'end_turn',
  text: null,
  toolCalls: [],
  rawContent: null,
})

const TEXT_RESPONSE = Object.freeze({
  stopReason: 'end_turn',
  text: 'Olá! Como posso ajudar?',
  toolCalls: [],
  rawContent: [{ type: 'text', text: 'Olá! Como posso ajudar?' }],
})

const FALLBACK_MESSAGE = 'Desculpe, não consegui gerar uma resposta. Tente reformular seu pedido.'

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

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

/**
 * Build an async generator that yields text_delta chunks and then a complete event.
 * Pass text=null and skipTextDeltas=true for an empty stream response.
 */
function makeStreamResponse({ text = null, stopReason = 'end_turn' } = {}) {
  return async function* () {
    if (text) {
      yield { type: 'text_delta', content: text }
    }
    yield {
      type: 'complete',
      response: {
        stopReason,
        text: text ?? null,
        toolCalls: [],
        rawContent: text ? [{ type: 'text', text }] : null,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// processAiChat — empty response retry
// ---------------------------------------------------------------------------

describe('processAiChat — empty LLM response retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn) => {
      if (typeof fn === 'function') return fn(prisma)
      return Promise.all(fn.map((p) => p))
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns non-empty text without retrying when provider responds on first attempt', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat.mockResolvedValue(TEXT_RESPONSE)

    vi.useFakeTimers()
    const promise = processAiChat('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    const result = await promise

    expect(mockChat).toHaveBeenCalledTimes(1)
    expect(result.message).toBe(TEXT_RESPONSE.text)
    expect(result.actionsExecuted).toEqual([])
  })

  it('retries and returns non-empty text when provider returns empty on attempt 1 and text on attempt 2', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat
      .mockResolvedValueOnce(EMPTY_RESPONSE)
      .mockResolvedValueOnce(TEXT_RESPONSE)

    vi.useFakeTimers()
    const promise = processAiChat('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    const result = await promise

    expect(mockChat).toHaveBeenCalledTimes(2)
    expect(result.message).toBe(TEXT_RESPONSE.text)
  })

  it('returns the fallback message after exhausting all 3 attempts with empty responses', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat.mockResolvedValue(EMPTY_RESPONSE)

    vi.useFakeTimers()
    const promise = processAiChat('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    const result = await promise

    expect(mockChat).toHaveBeenCalledTimes(AI_RETRY.MAX_ATTEMPTS)
    expect(result.message).toBe(FALLBACK_MESSAGE)
    expect(result.actionsExecuted).toEqual([])
  })

  it('saves the fallback message to DB when all retries are exhausted', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat.mockResolvedValue(EMPTY_RESPONSE)

    vi.useFakeTimers()
    const promise = processAiChat('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    await promise

    const assistantSaveCall = prisma.aiMessage.create.mock.calls.find(
      (call) => call[0].data.role === 'assistant',
    )
    expect(assistantSaveCall).toBeDefined()
    expect(assistantSaveCall[0].data.content).toBe(FALLBACK_MESSAGE)
  })

  it('applies exponential backoff delays between empty-response retries (1s, then 2s)', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat.mockResolvedValue(EMPTY_RESPONSE)

    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

    const promise = processAiChat('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    await promise

    const retryDelays = setTimeoutSpy.mock.calls
      .map((args) => args[1])
      .filter((delay) => delay > 0)

    // Attempt 1 empty → delay BASE_DELAY_MS * 2^0 = 1000ms
    // Attempt 2 empty → delay BASE_DELAY_MS * 2^1 = 2000ms
    // Attempt 3 empty → no delay (loop exits)
    expect(retryDelays).toContain(AI_RETRY.BASE_DELAY_MS * 2 ** 0)
    expect(retryDelays).toContain(AI_RETRY.BASE_DELAY_MS * 2 ** 1)
  })

  it('does not apply empty-response retry delay after the final attempt', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat.mockResolvedValue(EMPTY_RESPONSE)

    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

    const promise = processAiChat('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    await promise

    const retryDelays = setTimeoutSpy.mock.calls
      .map((args) => args[1])
      .filter((delay) => delay > 0)

    // Only 2 inter-attempt delays for 3 total attempts (no delay after the last)
    const emptyRetryDelays = retryDelays.filter(
      (d) => d === AI_RETRY.BASE_DELAY_MS * 2 ** 0 || d === AI_RETRY.BASE_DELAY_MS * 2 ** 1,
    )
    expect(emptyRetryDelays).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// processAiChatStream — empty response retry
// ---------------------------------------------------------------------------

describe('processAiChatStream — empty LLM response retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn) => {
      if (typeof fn === 'function') return fn(prisma)
      return Promise.all(fn.map((p) => p))
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Collect all yielded events from the processAiChatStream generator into an array.
   * This helper drives the generator to completion, respecting fake timers.
   */
  async function collectStreamEvents(userId, params) {
    const events = []
    for await (const event of processAiChatStream(userId, params)) {
      events.push(event)
    }
    return events
  }

  it('yields text_delta and done events without retrying when stream returns text on first attempt', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChatStream.mockImplementation(makeStreamResponse({ text: 'Ótimo!' }))

    vi.useFakeTimers()
    const eventsPromise = collectStreamEvents('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    const events = await eventsPromise

    expect(mockChatStream).toHaveBeenCalledTimes(1)

    const textDeltas = events.filter((e) => e.event === 'text_delta')
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.content).toBe('Ótimo!')

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(doneEvent.data.message).toBe('Ótimo!')
    expect(doneEvent.data.actionsExecuted).toEqual([])
  })

  it('retries on empty stream attempt 1 and yields only one set of text_delta events from attempt 2', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChatStream
      .mockImplementationOnce(makeStreamResponse({ text: null }))
      .mockImplementationOnce(makeStreamResponse({ text: 'Tentativa 2 funcionou!' }))

    vi.useFakeTimers()
    const eventsPromise = collectStreamEvents('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    const events = await eventsPromise

    expect(mockChatStream).toHaveBeenCalledTimes(2)

    // No text_delta from the empty first attempt — only one from the second
    const textDeltas = events.filter((e) => e.event === 'text_delta')
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.content).toBe('Tentativa 2 funcionou!')

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent.data.message).toBe('Tentativa 2 funcionou!')
  })

  it('done event contains the fallback message after all 3 stream attempts return empty', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChatStream.mockImplementation(makeStreamResponse({ text: null }))

    vi.useFakeTimers()
    const eventsPromise = collectStreamEvents('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    const events = await eventsPromise

    expect(mockChatStream).toHaveBeenCalledTimes(AI_RETRY.MAX_ATTEMPTS)

    const textDeltas = events.filter((e) => e.event === 'text_delta')
    expect(textDeltas).toHaveLength(0)

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(doneEvent.data.message).toBe(FALLBACK_MESSAGE)
    expect(doneEvent.data.actionsExecuted).toEqual([])
  })

  it('saves the fallback message to DB when all stream retries are exhausted', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChatStream.mockImplementation(makeStreamResponse({ text: null }))

    vi.useFakeTimers()
    const eventsPromise = collectStreamEvents('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    await eventsPromise

    const assistantSaveCall = prisma.aiMessage.create.mock.calls.find(
      (call) => call[0].data.role === 'assistant',
    )
    expect(assistantSaveCall).toBeDefined()
    expect(assistantSaveCall[0].data.content).toBe(FALLBACK_MESSAGE)
  })

  it('does not yield text_delta events from failed empty attempts before a successful retry', async () => {
    stubTrainerContext()
    stubNewConversation()

    // Two empty attempts, then a successful one
    mockChatStream
      .mockImplementationOnce(makeStreamResponse({ text: null }))
      .mockImplementationOnce(makeStreamResponse({ text: null }))
      .mockImplementationOnce(makeStreamResponse({ text: 'Terceira tentativa!' }))

    vi.useFakeTimers()
    const eventsPromise = collectStreamEvents('user-1', { message: 'Olá' })
    await vi.runAllTimersAsync()
    const events = await eventsPromise

    expect(mockChatStream).toHaveBeenCalledTimes(AI_RETRY.MAX_ATTEMPTS)

    const textDeltas = events.filter((e) => e.event === 'text_delta')
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.content).toBe('Terceira tentativa!')

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent.data.message).toBe('Terceira tentativa!')
  })
})
