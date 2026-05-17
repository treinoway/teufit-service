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

// Mock platform-plan-service — gating is tested separately
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn().mockResolvedValue(undefined),
  recordAiAction: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/services/student-dashboard-service.js', () => ({
  buildAiPerformanceSnapshot: vi.fn(),
}))

import { prisma } from '../../src/db.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { AI_RETRY, AI_TOOLS } from '../../src/constants/ai.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'

// Re-apply platform-plan-service mocks after each test (mockReset: true in vitest config).
beforeEach(() => {
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
})

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

// ---------------------------------------------------------------------------
// processAiChat — read-only tool second LLM call (get_student_performance)
// ---------------------------------------------------------------------------

const PERFORMANCE_SNAPSHOT = Object.freeze({
  studentId: 'student-perf-1',
  studentName: 'Joao Silva',
  window: 90,
  sessionCounts: { completed: 8, in_progress: 0, abandoned: 2 },
  totalSessions: 10,
  completionRate: 0.8,
  lastSessionAt: '2026-04-10T10:00:00.000Z',
  currentProtocol: { id: 'proto-1', name: 'Hipertrofia' },
  topExercises: [
    {
      exerciseId: 'ex-1',
      name: 'Supino Reto',
      hasLoad: true,
      sessionCount: 6,
      lastPerformedAt: '2026-04-10T10:00:00.000Z',
      latestMaxLoad: 80,
      latestAvgLoad: 70,
      latestTotalVolume: 2400,
      maxLoadDelta: 5,
      maxLoadDeltaPct: 6.67,
    },
  ],
})

const TOOL_USE_RESPONSE = Object.freeze({
  stopReason: 'tool_use',
  text: null,
  toolCalls: [{ id: 'tc-perf-unit-1', name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: 'student-perf-1' } }],
  rawContent: [{ type: 'tool_use', id: 'tc-perf-unit-1', name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: 'student-perf-1' } }],
})

const ANALYSIS_RESPONSE = Object.freeze({
  stopReason: 'end_turn',
  text: 'Joao completou 8 de 10 sessoes (80% de adesao). Progressao de carga no Supino Reto: +5kg.',
  toolCalls: [],
  rawContent: [{ type: 'text', text: 'Joao completou 8 de 10 sessoes (80% de adesao). Progressao de carga no Supino Reto: +5kg.' }],
})

describe('processAiChat — read-only tool second LLM call', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn) => {
      if (typeof fn === 'function') return fn(prisma)
      return Promise.all(fn.map((p) => p))
    })
    buildAiPerformanceSnapshot.mockResolvedValue({ ...PERFORMANCE_SNAPSHOT })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the second LLM analysis text when get_student_performance executes successfully', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat
      .mockResolvedValueOnce(TOOL_USE_RESPONSE)
      .mockResolvedValueOnce(ANALYSIS_RESPONSE)

    const result = await processAiChat('user-1', { message: 'Como esta o Joao?' })

    expect(result.actionsExecuted).toHaveLength(1)
    expect(result.actionsExecuted[0].tool).toBe(AI_TOOLS.GET_STUDENT_PERFORMANCE)
    expect(result.actionsExecuted[0].success).toBe(true)
    expect(result.message).toBe(ANALYSIS_RESPONSE.text)
  })

  it('makes exactly two LLM chat calls for get_student_performance (tool then analysis)', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat
      .mockResolvedValueOnce(TOOL_USE_RESPONSE)
      .mockResolvedValueOnce(ANALYSIS_RESPONSE)

    await processAiChat('user-1', { message: 'Como esta o Joao?' })

    expect(mockChat).toHaveBeenCalledTimes(2)

    // Second call must include the tool_result in its messages
    const secondCallMessages = mockChat.mock.calls[1][0].messages
    const hasToolResult = secondCallMessages.some(
      (m) => m.role === 'user' && Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_result'),
    )
    expect(hasToolResult).toBe(true)
  })

  it('saves 4 DB records: user msg + first assistant (tool_use rawContent) + tool_result + second assistant (analysis)', async () => {
    stubTrainerContext()
    stubNewConversation()

    mockChat
      .mockResolvedValueOnce(TOOL_USE_RESPONSE)
      .mockResolvedValueOnce(ANALYSIS_RESPONSE)

    await processAiChat('user-1', { message: 'Como esta o Joao?' })

    expect(prisma.aiMessage.create).toHaveBeenCalledTimes(4)

    const calls = prisma.aiMessage.create.mock.calls
    const roles = calls.map((c) => c[0].data.role)
    expect(roles).toContain('user')
    expect(roles).toContain('tool_result')
    // Two assistant saves: first with rawContent (tool_use), second without (analysis text)
    const assistantCalls = calls.filter((c) => c[0].data.role === 'assistant')
    expect(assistantCalls).toHaveLength(2)
    // First assistant save has rawContent
    expect(assistantCalls[0][0].data.rawContent).toBeDefined()
    // Second assistant save is the analysis text, no rawContent
    expect(assistantCalls[1][0].data.rawContent).toBeUndefined()
    expect(assistantCalls[1][0].data.content).toBe(ANALYSIS_RESPONSE.text)
  })

  it('falls back to deterministic paragraph when second LLM call returns empty text', async () => {
    stubTrainerContext()
    stubNewConversation()

    vi.useFakeTimers()

    mockChat
      .mockResolvedValueOnce(TOOL_USE_RESPONSE)
      .mockResolvedValue({
        stopReason: 'end_turn',
        text: null,
        toolCalls: [],
        rawContent: null,
      })

    const promise = processAiChat('user-1', { message: 'Como esta o Joao?' })
    await vi.runAllTimersAsync()
    const result = await promise

    // Must NOT be the generic "Acao executada com sucesso!" default
    expect(result.message).not.toBe('Ação executada com sucesso!')
    // Must contain the student name from the snapshot
    expect(result.message).toContain('Joao Silva')
    // Must NOT be empty
    expect(result.message.length).toBeGreaterThan(10)
  })

  it('does NOT make a second LLM call for write tools (import_from_template regression guard)', async () => {
    // Existing conversation history so enforcement gate allows tool execution
    prisma.aiConversation.findUnique.mockResolvedValue({
      id: 'conv-write',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { role: 'user', content: 'Cria um protocolo' },
        { role: 'assistant', content: 'Confirma?' },
      ].reverse(),
    })
    prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
    prisma.trainerStudent.findMany.mockResolvedValue([])
    prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
    prisma.trainingTemplate.findMany.mockResolvedValue([])
    prisma.trainingProtocol.findMany.mockResolvedValue([])
    prisma.exerciseTemplate.findMany.mockResolvedValue([])
    prisma.aiMessage.create.mockResolvedValue({ id: 'msg-x' })
    prisma.aiConversation.update.mockResolvedValue({})

    // importFromTemplate resolves successfully (write tool executes)
    const { importFromTemplate } = await import('../../src/services/training-protocol-service.js')
    importFromTemplate.mockResolvedValueOnce({ id: 'new-proto-1', name: 'Protocolo Teste' })

    const writeToolResponse = {
      stopReason: 'tool_use',
      text: null,
      toolCalls: [{ id: 'tc-write-2', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: { templateId: 't1', assigneeId: 'a1', startDate: '2026-01-01', expirationDate: '2026-06-01' } }],
      rawContent: [{ type: 'tool_use', id: 'tc-write-2', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: {} }],
    }

    mockChat.mockResolvedValueOnce(writeToolResponse)

    await processAiChat('user-1', { message: 'Confirmo', conversationId: 'conv-write' })

    // Only one LLM call — write tools skip the second call
    expect(mockChat).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// processAiChatStream — read-only tool second LLM call (get_student_performance)
// ---------------------------------------------------------------------------

describe('processAiChatStream — read-only tool second LLM call', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn) => {
      if (typeof fn === 'function') return fn(prisma)
      return Promise.all(fn.map((p) => p))
    })
    buildAiPerformanceSnapshot.mockResolvedValue({ ...PERFORMANCE_SNAPSHOT })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeToolUseStream() {
    return async function* () {
      // No text_delta — tool_use response has no text content
      yield {
        type: 'complete',
        response: TOOL_USE_RESPONSE,
      }
    }
  }

  function makeAnalysisStream(text) {
    return async function* () {
      const chunks = text.match(/.{1,20}/g) || [text]
      for (const chunk of chunks) {
        yield { type: 'text_delta', content: chunk }
      }
      yield {
        type: 'complete',
        response: {
          stopReason: 'end_turn',
          text,
          toolCalls: [],
          rawContent: [{ type: 'text', text }],
        },
      }
    }
  }

  function makeEmptyStream() {
    return async function* () {
      yield {
        type: 'complete',
        response: { stopReason: 'end_turn', text: null, toolCalls: [], rawContent: null },
      }
    }
  }

  it('yields text_delta chunks from second LLM call and done event with analysis text', async () => {
    stubTrainerContext()
    stubNewConversation()

    const analysisText = 'Joao completou 8 de 10 sessoes com 80% de adesao.'

    mockChatStream
      .mockImplementationOnce(makeToolUseStream())
      .mockImplementationOnce(makeAnalysisStream(analysisText))

    const events = []
    for await (const event of processAiChatStream('user-1', { message: 'Como esta o Joao?' })) {
      events.push(event)
    }

    const textDeltas = events.filter((e) => e.event === 'text_delta')
    expect(textDeltas.length).toBeGreaterThan(0)
    const fullText = textDeltas.map((e) => e.data.content).join('')
    expect(fullText).toBe(analysisText)

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
    expect(doneEvent.data.message).toBe(analysisText)
    expect(doneEvent.data.actionsExecuted).toHaveLength(1)
    expect(doneEvent.data.actionsExecuted[0].tool).toBe(AI_TOOLS.GET_STUDENT_PERFORMANCE)
  })

  it('calls chatStream twice for get_student_performance (first stream then analysis stream)', async () => {
    stubTrainerContext()
    stubNewConversation()

    const analysisText = 'Analise de desempenho do Joao.'

    mockChatStream
      .mockImplementationOnce(makeToolUseStream())
      .mockImplementationOnce(makeAnalysisStream(analysisText))

    // eslint-disable-next-line no-unused-vars
    for await (const _ of processAiChatStream('user-1', { message: 'Desempenho' })) { /* drain */ }

    expect(mockChatStream).toHaveBeenCalledTimes(2)
  })

  it('falls back to deterministic text when follow-up stream returns empty, yields it as text_delta', async () => {
    stubTrainerContext()
    stubNewConversation()

    vi.useFakeTimers()

    mockChatStream
      .mockImplementationOnce(makeToolUseStream())
      .mockImplementation(makeEmptyStream())

    const eventsPromise = (async () => {
      const events = []
      for await (const event of processAiChatStream('user-1', { message: 'Como esta?' })) {
        events.push(event)
      }
      return events
    })()
    await vi.runAllTimersAsync()
    const events = await eventsPromise

    const textDeltas = events.filter((e) => e.event === 'text_delta')
    expect(textDeltas.length).toBeGreaterThan(0)
    const fallbackText = textDeltas.map((e) => e.data.content).join('')
    expect(fallbackText).not.toBe('Ação executada com sucesso!')
    expect(fallbackText).toContain('Joao Silva')

    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent.data.message).toBe(fallbackText)
  })

  it('does NOT call chatStream a second time for write tools (regression guard)', async () => {
    // Existing conversation so enforcement gate allows write tool execution
    prisma.aiConversation.findUnique.mockResolvedValue({
      id: 'conv-write-stream',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { role: 'user', content: 'Cria um protocolo' },
        { role: 'assistant', content: 'Confirma?' },
      ].reverse(),
    })
    prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
    prisma.trainerStudent.findMany.mockResolvedValue([])
    prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
    prisma.trainingTemplate.findMany.mockResolvedValue([])
    prisma.trainingProtocol.findMany.mockResolvedValue([])
    prisma.exerciseTemplate.findMany.mockResolvedValue([])
    prisma.aiMessage.create.mockResolvedValue({ id: 'msg-ws' })
    prisma.aiConversation.update.mockResolvedValue({})

    // importFromTemplate resolves successfully (write tool executes)
    const { importFromTemplate } = await import('../../src/services/training-protocol-service.js')
    importFromTemplate.mockResolvedValueOnce({ id: 'new-proto-s', name: 'Protocolo Stream' })

    const writeToolStreamResponse = async function* () {
      yield {
        type: 'complete',
        response: {
          stopReason: 'tool_use',
          text: null,
          toolCalls: [{ id: 'tc-write-s', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: { templateId: 't1', assigneeId: 'a1', startDate: '2026-01-01', expirationDate: '2026-06-01' } }],
          rawContent: [{ type: 'tool_use', id: 'tc-write-s', name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: {} }],
        },
      }
    }

    mockChatStream.mockImplementationOnce(writeToolStreamResponse)

    // eslint-disable-next-line no-unused-vars
    for await (const _ of processAiChatStream('user-1', { message: 'Confirmo', conversationId: 'conv-write-stream' })) { /* drain */ }

    // Write tools skip the second chatStream call
    expect(mockChatStream).toHaveBeenCalledTimes(1)
  })
})
