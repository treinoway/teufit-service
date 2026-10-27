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

const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn(),
}))
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn().mockResolvedValue(undefined),
  recordAiAction: vi.fn().mockResolvedValue(undefined),
}))

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../../src/db.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { AI_ERRORS, AI_MESSAGE_CODES } from '../../src/constants/ai.js'
import { USER_ID, drain, stubTrainerContext, stubNewConversation } from '../helpers/ai-engine-fixtures.js'

const SERVICE_UNAVAILABLE = 503

describe('AI unavailable when ANTHROPIC_API_KEY is missing (AC 4)', () => {
  beforeEach(() => {
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
    stubTrainerContext(prisma)
    stubNewConversation(prisma)
    vi.stubEnv('LLM_PROVIDER', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('should reject processAiChat with a 503 ai.unavailable AppError', async () => {
    await expect(processAiChat(USER_ID, { message: 'Oi' })).rejects.toMatchObject({
      httpStatus: SERVICE_UNAVAILABLE,
      error: AI_ERRORS.UNAVAILABLE,
      messageCode: AI_MESSAGE_CODES.UNAVAILABLE,
    })
  })

  it('should reject processAiChatStream with a 503 ai.unavailable AppError before yielding events', async () => {
    const turn = drain(processAiChatStream(USER_ID, { message: 'Oi' }))

    await expect(turn).rejects.toMatchObject({
      httpStatus: SERVICE_UNAVAILABLE,
      messageCode: AI_MESSAGE_CODES.UNAVAILABLE,
    })
  })

  it('should not create a conversation or message while AI is unavailable', async () => {
    await processAiChat(USER_ID, { message: 'Oi' }).catch(() => {})

    expect(prisma.aiConversation.create).not.toHaveBeenCalled()
    expect(prisma.aiMessage.create).not.toHaveBeenCalled()
  })

  it('should not call the Anthropic SDK while AI is unavailable', async () => {
    await processAiChat(USER_ID, { message: 'Oi' }).catch(() => {})

    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('should not expose internals in the 503 message', async () => {
    const error = await processAiChat(USER_ID, { message: 'Oi' }).catch((err) => err)

    expect(error.message).not.toMatch(/ANTHROPIC_API_KEY|apiKey|undefined/i)
  })
})
