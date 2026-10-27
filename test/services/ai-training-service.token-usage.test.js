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
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { AI_TOOLS, AI_MODELS, LLM_PROVIDERS } from '../../src/constants/ai.js'
import { getBillingMonth } from '../../src/constants/platform-plan.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRAINER_ID = 'trainer-1'
const STUDENT_ID = 'student-1'
const CONVERSATION_ID = 'conv-usage-1'

const FIRST_CALL_USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 }
const SECOND_CALL_USAGE = { inputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 5 }
const SUMMED_USAGE = { inputTokens: 300, outputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 15 }

const TOOL_USE_RESPONSE = {
  stopReason: 'tool_use',
  text: null,
  toolCalls: [
    { id: 'tc-1', name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: STUDENT_ID } },
  ],
  rawContent: [{ type: 'tool_use', id: 'tc-1', name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: STUDENT_ID } }],
}

const FINAL_TEXT = 'Ana completou 2 sessões recentemente.'
const FINAL_RESPONSE = {
  stopReason: 'end_turn',
  text: FINAL_TEXT,
  toolCalls: [],
  rawContent: [{ type: 'text', text: FINAL_TEXT }],
}

beforeEach(() => {
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  writeInteractionLog.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  buildAiPerformanceSnapshot.mockResolvedValue({
    studentId: STUDENT_ID,
    studentName: 'Ana Lima',
    sessionCounts: { completed: 2 },
    topExercises: [],
  })
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
  delete process.env.LLM_PROVIDER
})

// Builds a provider stream that yields the text then a complete event carrying usage.
function streamOf(response, usage) {
  return async function* () {
    if (response.text) yield { type: 'text_delta', content: response.text }
    yield { type: 'complete', response: { ...response, usage } }
  }
}

// Collects every event of an async generator.
async function drain(generator) {
  const events = []
  for await (const event of generator) events.push(event)
  return events
}

// Asserts exactly one AiTokenUsage row was written with the given usage and call count.
async function expectSingleUsageRow(expectedUsage, llmCalls) {
  await vi.waitFor(() => expect(prisma.aiTokenUsage.create).toHaveBeenCalledOnce())
  expect(prisma.aiTokenUsage.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      trainerId: TRAINER_ID,
      conversationId: CONVERSATION_ID,
      provider: LLM_PROVIDERS.ANTHROPIC,
      model: AI_MODELS.ANTHROPIC,
      ...expectedUsage,
      llmCalls,
      billingMonth: getBillingMonth(),
    }),
  })
}

// ---------------------------------------------------------------------------
// processAiChat
// ---------------------------------------------------------------------------

describe('processAiChat — token usage recording', () => {
  it('records ONE AiTokenUsage row with summed usage and llmCalls 2 for a tool follow-up turn', async () => {
    mockChat
      .mockResolvedValueOnce({ ...TOOL_USE_RESPONSE, usage: FIRST_CALL_USAGE })
      .mockResolvedValueOnce({ ...FINAL_RESPONSE, usage: SECOND_CALL_USAGE })

    await processAiChat('user-1', { message: 'Como está a aluna Ana?' })

    await expectSingleUsageRow(SUMMED_USAGE, 2)
  })

  it('records a single-call text turn with llmCalls 1', async () => {
    mockChat.mockResolvedValueOnce({ ...FINAL_RESPONSE, usage: FIRST_CALL_USAGE })

    await processAiChat('user-1', { message: 'Oi' })

    await expectSingleUsageRow(FIRST_CALL_USAGE, 1)
  })

  it('does not record a row when no call reported usage', async () => {
    mockChat.mockResolvedValueOnce({ ...FINAL_RESPONSE, usage: null })

    await processAiChat('user-1', { message: 'Oi' })

    expect(prisma.aiTokenUsage.create).not.toHaveBeenCalled()
  })

  it('still records the usage of calls made before the turn failed', async () => {
    const failure = Object.assign(new Error('bad request'), { status: 400 })
    mockChat
      .mockResolvedValueOnce({ ...TOOL_USE_RESPONSE, usage: FIRST_CALL_USAGE })
      .mockRejectedValueOnce(failure)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await processAiChat('user-1', { message: 'Como está a aluna Ana?' }).catch(() => {})

    await expectSingleUsageRow(FIRST_CALL_USAGE, 1)
  })

  it('does not break the turn when recording usage fails', async () => {
    mockChat.mockResolvedValueOnce({ ...FINAL_RESPONSE, usage: FIRST_CALL_USAGE })
    prisma.aiTokenUsage.create.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await processAiChat('user-1', { message: 'Oi' })

    expect(result.message).toBe(FINAL_TEXT)
  })

  it('passes the summed usage (non-null) to writeInteractionLog', async () => {
    mockChat
      .mockResolvedValueOnce({ ...TOOL_USE_RESPONSE, usage: FIRST_CALL_USAGE })
      .mockResolvedValueOnce({ ...FINAL_RESPONSE, usage: SECOND_CALL_USAGE })

    await processAiChat('user-1', { message: 'Como está a aluna Ana?' })

    expect(writeInteractionLog).toHaveBeenCalledOnce()
    const { usage } = writeInteractionLog.mock.calls[0][1]
    expect(usage).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// processAiChatStream
// ---------------------------------------------------------------------------

describe('processAiChatStream — token usage recording', () => {
  it('records ONE AiTokenUsage row with summed usage and llmCalls 2 for a tool follow-up turn', async () => {
    mockChatStream
      .mockImplementationOnce(streamOf(TOOL_USE_RESPONSE, FIRST_CALL_USAGE))
      .mockImplementationOnce(streamOf(FINAL_RESPONSE, SECOND_CALL_USAGE))

    await drain(processAiChatStream('user-1', { message: 'Como está a aluna Ana?' }))

    await expectSingleUsageRow(SUMMED_USAGE, 2)
  })

  it('records a single-call text turn with llmCalls 1', async () => {
    mockChatStream.mockImplementationOnce(streamOf(FINAL_RESPONSE, FIRST_CALL_USAGE))

    await drain(processAiChatStream('user-1', { message: 'Oi' }))

    await expectSingleUsageRow(FIRST_CALL_USAGE, 1)
  })

  it('does not record a row when no call reported usage', async () => {
    mockChatStream.mockImplementationOnce(streamOf(FINAL_RESPONSE, null))

    await drain(processAiChatStream('user-1', { message: 'Oi' }))

    expect(prisma.aiTokenUsage.create).not.toHaveBeenCalled()
  })

  it('does not break the stream when recording usage fails', async () => {
    mockChatStream.mockImplementationOnce(streamOf(FINAL_RESPONSE, FIRST_CALL_USAGE))
    prisma.aiTokenUsage.create.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const events = await drain(processAiChatStream('user-1', { message: 'Oi' }))

    expect(events.at(-1).event).toBe('done')
  })

  it('passes the summed usage (non-null) to writeInteractionLog', async () => {
    mockChatStream
      .mockImplementationOnce(streamOf(TOOL_USE_RESPONSE, FIRST_CALL_USAGE))
      .mockImplementationOnce(streamOf(FINAL_RESPONSE, SECOND_CALL_USAGE))

    await drain(processAiChatStream('user-1', { message: 'Como está a aluna Ana?' }))

    expect(writeInteractionLog).toHaveBeenCalledOnce()
    const { usage } = writeInteractionLog.mock.calls[0][1]
    expect(usage).not.toBeNull()
  })
})
