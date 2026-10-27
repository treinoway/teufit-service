import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Prisma before any service imports
vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingProtocol: { findUnique: vi.fn(), findMany: vi.fn() },
    trainerStudent: { findMany: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
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

const anthropicCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
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

import { prisma } from '../../src/db.js'
import Anthropic from '@anthropic-ai/sdk'
import { processAiChat } from '../../src/services/ai-training-service.js'
import { AI_LIMITS } from '../../src/constants/ai.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'

// Re-apply platform-plan-service mocks after each test (mockReset: true in vitest config).
beforeEach(() => {
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
})

const WINDOW_SIZE = AI_LIMITS.MAX_HISTORY_ITEMS * 2 // 40

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(role, content, extra = {}) {
  return { role, content, rawContent: null, ...extra }
}

/** Build N alternating user/assistant message pairs (total 2*N messages). */
function makePairs(count) {
  const messages = []
  for (let i = 0; i < count; i++) {
    messages.push(makeMessage('user', `user message ${i}`))
    messages.push(makeMessage('assistant', `assistant message ${i}`))
  }
  return messages
}

describe('loadConversationHistory — truncation window', () => {
  function stubTrainerContext() {
    prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' })
    prisma.trainerStudent.findMany.mockResolvedValue([])
    prisma.trainingProtocolTemplate.findMany.mockResolvedValue([])
    prisma.trainingTemplate.findMany.mockResolvedValue([])
    prisma.trainingProtocol.findMany.mockResolvedValue([])
    prisma.exerciseTemplate.findMany.mockResolvedValue([])
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate }
    })
    prisma.$transaction.mockImplementation(async (fn) => {
      if (typeof fn === 'function') return fn(prisma)
      return Promise.all(fn.map((p) => p))
    })

    anthropicCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'OK' }],
      usage: {},
    })
    prisma.aiMessage.create.mockResolvedValue({ id: 'msg-save' })
    prisma.aiConversation.update.mockResolvedValue({})
  })

  // -------------------------------------------------------------------------
  // (a) History smaller than the limit
  // -------------------------------------------------------------------------

  it('(a) includes all messages when history is smaller than the window limit', async () => {
    stubTrainerContext()

    // 4 messages — well under the 40-message window.
    // Prisma returns them in DESC order (orderBy: { createdAt: 'desc' });
    // the service reverses them back to ASC before building the history.
    const smallHistoryAsc = makePairs(2) // [u0, a0, u1, a1]
    const smallHistoryDesc = [...smallHistoryAsc].reverse() // [a1, u1, a0, u0]
    prisma.aiConversation.findUnique.mockResolvedValue({
      id: 'conv-small',
      userId: 'user-1',
      title: 'T',
      messages: smallHistoryDesc,
    })

    await processAiChat('user-1', { message: 'Nova pergunta', conversationId: 'conv-small' })

    const llmCall = anthropicCreate.mock.calls[0][0]
    // Exclude the new user turn appended by processAiChat
    const historyMessages = llmCall.messages.slice(0, -1)

    expect(historyMessages).toHaveLength(4)
    // After reversing DESC→ASC, first message must be the oldest user message (replayed wrapped as untrusted input)
    expect(historyMessages[0]).toMatchObject({ role: 'user', content: '<user_input>user message 0</user_input>' })
    expect(historyMessages[3]).toMatchObject({ role: 'assistant', content: 'assistant message 1' })
  })

  // -------------------------------------------------------------------------
  // (b) History larger than the limit — Prisma query uses take: WINDOW_SIZE
  // -------------------------------------------------------------------------

  it('(b) queries Prisma with take: WINDOW_SIZE in DESC order when history exceeds the limit', async () => {
    stubTrainerContext()

    // Return only the last WINDOW_SIZE messages (simulating Prisma's take behaviour).
    // In reality Prisma enforces the take server-side; here we just return the slice.
    const lastMessages = makePairs(WINDOW_SIZE / 2) // exactly 40 items
    prisma.aiConversation.findUnique.mockResolvedValue({
      id: 'conv-large',
      userId: 'user-1',
      title: 'T',
      // Simulate DESC order — Prisma returns newest first
      messages: [...lastMessages].reverse(),
    })

    await processAiChat('user-1', { message: 'Nova', conversationId: 'conv-large' })

    // Verify the query used the correct take and orderBy
    expect(prisma.aiConversation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          messages: expect.objectContaining({
            take: WINDOW_SIZE,
            orderBy: { createdAt: 'desc' },
          }),
        }),
      }),
    )

    // Verify the history is reassembled in chronological (ASC) order
    const llmCall = anthropicCreate.mock.calls[0][0]
    const historyMessages = llmCall.messages.slice(0, -1)

    expect(historyMessages).toHaveLength(WINDOW_SIZE)
    expect(historyMessages[0]).toMatchObject({ role: 'user', content: '<user_input>user message 0</user_input>' })
    expect(historyMessages[WINDOW_SIZE - 1]).toMatchObject({
      role: 'assistant',
      content: `assistant message ${WINDOW_SIZE / 2 - 1}`,
    })
  })

  // -------------------------------------------------------------------------
  // (c) Orphan tool_result at the beginning after truncation
  // -------------------------------------------------------------------------

  it('(c) discards orphan tool_result messages at the start of the truncated window', async () => {
    stubTrainerContext()

    // After truncation the window starts with a tool_result (orphan — its assistant
    // turn was cut off). The service must skip it and begin from the next message.
    const orphanToolResult = makeMessage('tool_result', 'tool output', {
      rawContent: [{ toolCallId: 'tc-1', content: 'result' }],
    })
    const normalPairs = makePairs(3) // [u0, a0, u1, a1, u2, a2]

    // Simulate DESC order returned by Prisma: newest first.
    // The slice window captured [orphanToolResult, u0, a0, u1, a1, u2, a2].
    // After reversing to ASC: [a2, u2, a1, u1, a0, u0, orphanToolResult].
    // Wait — we want the orphan FIRST in ASC order (oldest).
    // So in DESC order (what Prisma returns) it must be LAST.
    const desc = [...normalPairs].reverse() // [a2, u2, a1, u1, a0, u0]
    desc.push(orphanToolResult)             // orphan is the oldest → last in DESC
    // After service reverses: [orphanToolResult, u0, a0, u1, a1, u2, a2]

    prisma.aiConversation.findUnique.mockResolvedValue({
      id: 'conv-orphan',
      userId: 'user-1',
      title: 'T',
      messages: desc,
    })

    await processAiChat('user-1', { message: 'Agora', conversationId: 'conv-orphan' })

    const llmCall = anthropicCreate.mock.calls[0][0]
    const historyMessages = llmCall.messages.slice(0, -1) // exclude new user turn

    // The orphan tool_result must NOT appear in the history sent to the LLM
    const hasOrphan = historyMessages.some((m) => m.role === 'tool_result')
    expect(hasOrphan).toBe(false)

    // The remaining 6 messages from the normal pairs must all be present
    expect(historyMessages).toHaveLength(6)
    expect(historyMessages[0]).toMatchObject({ role: 'user', content: '<user_input>user message 0</user_input>' })
    expect(historyMessages[5]).toMatchObject({ role: 'assistant', content: 'assistant message 2' })
  })
})
