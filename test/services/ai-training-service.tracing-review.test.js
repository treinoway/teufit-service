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
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({ maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/services/platform-plan-service.js', () => ({ assertCanUseAi: vi.fn(), recordAiAction: vi.fn() }))
vi.mock('../../src/services/student-dashboard-service.js', () => ({ buildAiPerformanceSnapshot: vi.fn() }))
vi.mock('../../src/services/ai-interaction-log-service.js', () => ({ writeInteractionLog: vi.fn() }))

import { prisma } from '../../src/db.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js'
import { PROMPT_VERSION } from '../../src/services/ai-prompt.js'
import { AI_TOOLS } from '../../src/constants/ai.js'
import { AppError } from '../../src/errors/app-error.js'
import { USER_ID, TRAINER_ID, STUDENT_ID, textResponse, toolResponse, streamOf, stubTrainerContext, stubNewConversation } from '../helpers/ai-engine-fixtures.js'

const FINAL_TEXT = 'Resposta final'
const TRANSIENT_STATUS = 529
const BAD_REQUEST_STATUS = 400

// Creates a fake tracer recording every call in order.
function createFakeTracer() {
  const calls = []
  const rec = (op) => (...args) => { calls.push({ op, args }) }
  const gen = { firstToken: rec('gen.firstToken'), end: rec('gen.end'), fail: rec('gen.fail') }
  const turn = {
    setContext: rec('setContext'),
    generation: (...args) => (calls.push({ op: 'generation', args }), gen),
    tool: (...args) => (calls.push({ op: 'tool', args }), { end: rec('tool.end') }),
    event: rec('event'),
    end: rec('end'),
    fail: rec('fail'),
    abort: rec('abort'),
  }
  return { tracer: { startTurn: (...args) => (calls.push({ op: 'startTurn', args }), turn), shutdown: async () => {} }, calls }
}

beforeEach(() => {
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  writeInteractionLog.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: TRAINER_ID, studentId: STUDENT_ID })
  prisma.trainerStudent.findFirst.mockResolvedValue({ trainerId: TRAINER_ID, studentId: STUDENT_ID })
  prisma.anamnesisResponse.findMany.mockResolvedValue([])
  buildAiPerformanceSnapshot.mockResolvedValue({ studentId: STUDENT_ID, studentName: 'Ana', sessionCounts: { completed: 1 }, topExercises: [] })
  stubTrainerContext(prisma)
  stubNewConversation(prisma)
  mockChat.mockResolvedValue(textResponse(FINAL_TEXT))
  mockChatStream.mockImplementation(streamOf(textResponse(FINAL_TEXT)))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('later generations carry a compact input (review 4)', () => {
  it('should send the full prompt only on the first generation and only appended messages on the follow-up', async () => {
    mockChat
      .mockResolvedValueOnce(toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: STUDENT_ID } }))
      .mockResolvedValueOnce(textResponse(FINAL_TEXT))
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Como esta a Ana?' }, { tracer, requestId: 'r' })

    const [first, followUp] = calls.filter((c) => c.op === 'generation').map((c) => c.args[0].input)
    expect(first.system).not.toHaveProperty('sameAs')
    expect(followUp.system).toEqual({ sameAs: 'first-generation', promptVersion: PROMPT_VERSION })
    expect(followUp.messages).toHaveLength(2)
  })

  it('should send an empty message list on a retried attempt', async () => {
    mockChat.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: TRANSIENT_STATUS })).mockResolvedValueOnce(textResponse(FINAL_TEXT))
    const { tracer, calls } = createFakeTracer()
    vi.useFakeTimers()

    const promise = processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: 'r' })
    await vi.runAllTimersAsync()
    await promise

    const inputs = calls.filter((c) => c.op === 'generation').map((c) => c.args[0].input)
    expect(inputs[1]).toEqual({ system: { sameAs: 'first-generation', promptVersion: PROMPT_VERSION }, messages: [] })
  })
})

describe('turn settlement (review 6, 7)', () => {
  it('should pass a 4xx AppError to trace.fail unchanged so the tracer can mark it WARNING', async () => {
    const refusal = new AppError({ httpStatus: 403, error: 'PLAN_LIMIT', messageCode: 'plan.limit', message: 'limit' })
    assertCanUseAi.mockRejectedValue(refusal)
    const { tracer, calls } = createFakeTracer()

    await expect(processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: 'r' })).rejects.toBe(refusal)

    expect(calls.at(-1).op).toBe('fail')
    expect(calls.at(-1).args[0]).toBe(refusal)
  })

  it('should fail, not abort, a chat turn whose error says aborted while the signal is not aborted', async () => {
    mockChat.mockRejectedValue(Object.assign(new Error('x'), { aborted: true, status: BAD_REQUEST_STATUS }))
    const { tracer, calls } = createFakeTracer()

    await processAiChat(USER_ID, { message: 'Oi' }, { tracer, requestId: 'r', signal: new AbortController().signal }).catch(() => {})

    expect(calls.at(-1).op).toBe('fail')
  })

  it('should abort a streamed turn closed early', async () => {
    const { tracer, calls } = createFakeTracer()
    const stream = processAiChatStream(USER_ID, { message: 'Oi' }, { tracer, requestId: 'r' })

    await stream.next()
    await stream.return()

    expect(calls.at(-1).op).toBe('abort')
  })
})
