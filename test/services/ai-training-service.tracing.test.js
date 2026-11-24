import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { importFromTemplate } from '../../src/services/training-protocol-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js'
import { PROMPT_VERSION } from '../../src/services/ai-prompt.js'
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
  stubTrainerContext,
  stubNewConversation,
  stubExistingConversation,
} from '../helpers/ai-engine-fixtures.js'

const CONFIRMATION = 'Sim, pode criar'
const REQUEST_ID = 'req-trace-1'
const IMPORT_INPUT = { templateId: 'tmpl-1', assigneeId: STUDENT_ID, startDate: '2026-11-01', expirationDate: '2026-12-27' }
const PERFORMANCE_INPUT = { studentId: STUDENT_ID }
const TRANSIENT_STATUS = 529
const BAD_REQUEST_STATUS = 400
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
const FINAL_TEXT = 'Resposta final'

// Creates a fake tracer that records every call as { op, args } in order.
function createFakeTracer({ throwing = false } = {}) {
  const calls = []
  const record = (op, args) => {
    calls.push({ op, args })
    if (throwing) throw new Error(`tracer exploded on ${op}`)
  }
  const gen = {
    firstToken: (...a) => record('gen.firstToken', a),
    end: (...a) => record('gen.end', a),
    fail: (...a) => record('gen.fail', a),
  }
  const tool = { end: (...a) => record('tool.end', a) }
  const turn = {
    setContext: (...a) => record('setContext', a),
    generation: (...a) => (record('generation', a), gen),
    tool: (...a) => (record('tool', a), tool),
    event: (...a) => record('event', a),
    end: (...a) => record('end', a),
    fail: (...a) => record('fail', a),
    abort: (...a) => record('abort', a),
  }
  const tracer = { startTurn: (...a) => (record('startTurn', a), turn), shutdown: async () => {} }
  return { tracer, calls }
}

// Lists the op names recorded so far.
function opsOf(calls) {
  return calls.map((call) => call.op)
}

// Finds the first recorded call of an op.
function callOf(calls, op) {
  return calls.find((call) => call.op === op)
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
  importFromTemplate.mockResolvedValue({ id: 'protocol-9', name: 'Protocolo A' })
  stubTrainerContext(prisma)
  stubNewConversation(prisma)
  mockChat.mockResolvedValue({ ...textResponse(FINAL_TEXT), usage: USAGE })
  mockChatStream.mockImplementation(streamOf({ ...textResponse(FINAL_TEXT), usage: USAGE }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('turn without a tracer (AC 3)', () => {
  it('should return the same result as a turn with a no-op recording tracer', async () => {
    const withoutTracer = await processAiChat(USER_ID, { message: 'Oi' })
    stubNewConversation(prisma)
    const { tracer } = createFakeTracer()

    const withTracer = await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    expect(withTracer).toEqual(withoutTracer)
  })

  it('should complete a streamed turn when no tracer is passed', async () => {
    const events = await drain(processAiChatStream(USER_ID, { message: 'Oi' }))

    expect(events.at(-1).event).toBe('done')
  })
})

describe('turn without a tool (AC 4)', () => {
  it('should start the turn with kind, request id, user message and prompt version', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    expect(callOf(calls, 'startTurn').args[0]).toEqual({ kind: 'chat', requestId: REQUEST_ID, input: 'Oi', promptVersion: PROMPT_VERSION })
  })

  it('should start a stream turn with kind stream', async () => {
    const { tracer, calls } = createFakeTracer()

    await drain(processAiChatStream(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID }))

    expect(callOf(calls, 'startTurn').args[0].kind).toBe('stream')
  })

  it('should set the trainer and conversation context', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    expect(callOf(calls, 'setContext').args[0]).toMatchObject({ trainerId: TRAINER_ID, conversationId: CONVERSATION_ID })
  })

  it('should record startTurn, setContext, one generation and end in order', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    expect(opsOf(calls)).toEqual(['startTurn', 'setContext', 'generation', 'gen.end', 'end'])
  })

  it('should open the generation for attempt 1 with the system prompt and messages as sent', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    const options = callOf(calls, 'generation').args[0]
    expect(options.attempt).toBe(1)
    expect(options.input).toEqual({ system: expect.anything(), messages: expect.any(Array) })
    expect(options.model).toEqual(expect.any(String))
  })

  it('should end the generation with the provider usage, raw content and stop reason', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    expect(callOf(calls, 'gen.end').args[0]).toMatchObject({
      output: [{ type: 'text', text: FINAL_TEXT }],
      usage: USAGE,
      stopReason: 'end_turn',
    })
  })

  it('should end the turn with the final text', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    expect(callOf(calls, 'end').args[0]).toEqual({ output: FINAL_TEXT })
  })

  it('should mark the first token when streaming', async () => {
    const { tracer, calls } = createFakeTracer()

    await drain(processAiChatStream(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID }))

    expect(opsOf(calls)).toEqual(['startTurn', 'setContext', 'generation', 'gen.firstToken', 'gen.end', 'end'])
  })

  it('should not mark a first token on a non-streaming turn', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    expect(opsOf(calls)).not.toContain('gen.firstToken')
  })
})

describe('turn with a read-only tool (AC 5)', () => {
  beforeEach(() => {
    mockChat
      .mockResolvedValueOnce({ ...toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT }), usage: USAGE })
      .mockResolvedValueOnce({ ...textResponse(FINAL_TEXT), usage: USAGE })
  })

  it('should record generation, tool, follow-up generation, then end', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Como esta a Ana?' }, { tracer, requestId: REQUEST_ID })

    expect(opsOf(calls)).toEqual([
      'startTurn', 'setContext', 'generation', 'gen.end', 'tool', 'tool.end', 'generation', 'gen.end', 'end',
    ])
  })

  it('should name the tool and pass its input', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Como esta a Ana?' }, { tracer, requestId: REQUEST_ID })

    expect(callOf(calls, 'tool').args[0]).toMatchObject({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT })
  })

  it('should end the tool as successful', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Como esta a Ana?' }, { tracer, requestId: REQUEST_ID })

    expect(callOf(calls, 'tool.end').args[0]).toMatchObject({ success: true })
  })
})

describe('turn with a write tool (AC 6)', () => {
  beforeEach(() => {
    stubExistingConversation(prisma)
    mockChat.mockResolvedValue({ ...toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }), usage: USAGE })
  })

  it('should record generation then tool and end with the deterministic reply', async () => {
    const { tracer, calls } = createFakeTracer()

    const result = await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID }, { tracer, requestId: REQUEST_ID })

    expect(opsOf(calls)).toEqual(['startTurn', 'setContext', 'generation', 'gen.end', 'tool', 'tool.end', 'end'])
    expect(callOf(calls, 'end').args[0]).toEqual({ output: result.message })
  })

  it('should record a guard-blocked event with the tool name and no tool span when the guard blocks', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Crie o protocolo', conversationId: CONVERSATION_ID }, { tracer, requestId: REQUEST_ID })

    expect(opsOf(calls)).not.toContain('tool')
    expect(callOf(calls, 'event').args).toEqual(['guard-blocked', { tool: AI_TOOLS.IMPORT_FROM_TEMPLATE }])
  })

  it('should still end the turn after a guard block', async () => {
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Crie o protocolo', conversationId: CONVERSATION_ID }, { tracer, requestId: REQUEST_ID })

    expect(opsOf(calls).at(-1)).toBe('end')
  })
})

describe('retried model call (AC 7)', () => {
  it('should open one generation per attempt and fail the first with the provider error', async () => {
    const transient = Object.assign(new Error('overloaded'), { status: TRANSIENT_STATUS })
    mockChat.mockRejectedValueOnce(transient).mockResolvedValueOnce({ ...textResponse(FINAL_TEXT), usage: USAGE })
    const { tracer, calls } = createFakeTracer()
    vi.useFakeTimers()

    const promise = processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })
    await vi.runAllTimersAsync()
    await promise

    expect(opsOf(calls)).toEqual(['startTurn', 'setContext', 'generation', 'gen.fail', 'generation', 'gen.end', 'end'])
    expect(callOf(calls, 'gen.fail').args[0]).toBe(transient)
    expect(calls.filter((c) => c.op === 'generation').map((c) => c.args[0].attempt)).toEqual([1, 2])
  })

  it('should open a new generation for an empty reply that is retried', async () => {
    mockChat
      .mockResolvedValueOnce({ ...textResponse(''), usage: USAGE })
      .mockResolvedValueOnce({ ...textResponse(FINAL_TEXT), usage: USAGE })
    const { tracer, calls } = createFakeTracer()
    vi.useFakeTimers()

    const promise = processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })
    await vi.runAllTimersAsync()
    await promise

    expect(calls.filter((c) => c.op === 'generation')).toHaveLength(2)
  })
})

describe('failed and aborted turns (AC 8)', () => {
  it('should fail the turn when the provider errors with a non-retryable status', async () => {
    const providerError = Object.assign(new Error('bad request'), { status: BAD_REQUEST_STATUS })
    mockChat.mockRejectedValue(providerError)
    const { tracer, calls } = createFakeTracer()

    await expect(processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })).rejects.toBeDefined()

    expect(opsOf(calls)).toEqual(['startTurn', 'setContext', 'generation', 'gen.fail', 'fail'])
  })

  it('should fail the turn when the reply was cut off by max_tokens', async () => {
    mockChat.mockResolvedValue({ ...textResponse('cortado'), stopReason: 'max_tokens', usage: USAGE })
    const { tracer, calls } = createFakeTracer()

    await expect(processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })).rejects.toBeDefined()

    expect(opsOf(calls).at(-1)).toBe('fail')
    expect(opsOf(calls)).not.toContain('end')
  })

  it('should abort the turn when the signal was aborted by a client disconnect', async () => {
    const controller = new AbortController()
    mockChat.mockImplementation(async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { aborted: true })
    })
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID, signal: controller.signal }).catch(() => {})

    expect(opsOf(calls).at(-1)).toBe('abort')
    expect(opsOf(calls)).not.toContain('fail')
  })

  it('should abort a streamed turn whose client leaves mid-stream', async () => {
    const controller = new AbortController()
    const { tracer, calls } = createFakeTracer()
    const stream = processAiChatStream(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID, signal: controller.signal })

    for await (const event of stream) {
      if (event.event === 'text_delta') {
        controller.abort()
        break
      }
    }

    expect(opsOf(calls).at(-1)).toBe('abort')
  })
})

describe('faulty tracer (AC 9)', () => {
  it('should return the same result as an untraced turn when every tracer method throws', async () => {
    const untraced = await processAiChat(USER_ID, { message: 'Oi' })
    stubNewConversation(prisma)
    const { tracer } = createFakeTracer({ throwing: true })

    const traced = await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })

    expect(traced).toEqual(untraced)
  })

  it('should complete a tool turn when every tracer method throws', async () => {
    stubExistingConversation(prisma)
    mockChat.mockResolvedValue({ ...toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }), usage: USAGE })
    const { tracer } = createFakeTracer({ throwing: true })

    const result = await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID }, { tracer, requestId: REQUEST_ID })

    expect(result.actionsExecuted).toHaveLength(1)
  })

  it('should complete a streamed turn when every tracer method throws', async () => {
    const { tracer } = createFakeTracer({ throwing: true })

    const events = await drain(processAiChatStream(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID }))

    expect(events.at(-1).event).toBe('done')
  })

  it('should still surface the real error when the provider fails and the tracer throws', async () => {
    mockChat.mockRejectedValue(Object.assign(new Error('bad request'), { status: BAD_REQUEST_STATUS }))
    const { tracer } = createFakeTracer({ throwing: true })

    await expect(processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: REQUEST_ID })).rejects.toSatisfy((err) => !String(err?.message).includes('tracer exploded'))
  })
})
