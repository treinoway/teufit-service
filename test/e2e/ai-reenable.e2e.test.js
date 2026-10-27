import 'dotenv/config'
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { prisma } from '../../src/db.js'
import { setupApp } from '../helpers/setup-app.js'
import { cleanDatabase } from '../helpers/db-cleanup.js'
import { provisionTrainerPlan } from '../helpers/platform-plan.js'
import { signupVerified } from '../helpers/signup-user.js'
import { getBillingMonth, PLAN_LIMITS, PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js'
import { AI_TOOLS, AI_ERRORS, AI_MESSAGE_CODES } from '../../src/constants/ai.js'
import ptBR from '../../src/i18n/locales/pt-BR.js'
import enUS from '../../src/i18n/locales/en-US.js'

const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'

const PASSWORD = 'Test1234!'
const ALLOWED_ORIGIN = 'https://app.treinoway.test'
const LOOKALIKE_ORIGIN = `${ALLOWED_ORIGIN}.evil.example`
const CHAT_URLS = ['/trainer/ai/chat', '/trainer/ai/chat/stream']
const CONFIRMATION = 'Sim, pode fazer'
const SERVICE_UNAVAILABLE = 503
const MODEL_ERROR_MESSAGE_CODE = 'ai.modelError'
const FORBIDDEN = 403

let emailCounter = 0

// Builds a unique email so concurrent signups never collide.
function uniqueEmail(prefix) {
  emailCounter += 1
  return `${prefix}-${Date.now()}-${emailCounter}@test.com`
}

// Builds an Anthropic stream double that yields the text and resolves the final message.
function makeAnthropicStreamMock({ textChunks = [], stopReason = 'end_turn', toolUseBlocks = [] } = {}) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of textChunks) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } }
      }
    },
    finalMessage: async () => ({
      stop_reason: stopReason,
      content: [...textChunks.map((text) => ({ type: 'text', text })), ...toolUseBlocks],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  }
}

// Builds an Anthropic stream double whose iteration fails with a non-retryable provider error.
function makeFailingAnthropicStream() {
  return {
    [Symbol.asyncIterator]: async function* () {
      throw Object.assign(new Error('bad request'), { status: 400 })
    },
    finalMessage: async () => { throw Object.assign(new Error('bad request'), { status: 400 }) },
  }
}

// Parses an SSE body into { event, data } objects.
function parseSseBody(body) {
  return body
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice('event: '.length).trim()
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '))
      return { event, data: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null }
    })
    .filter((entry) => entry.event)
}

describe('e2e: iArnold re-enable hardening', () => {
  let app

  beforeAll(async () => {
    process.env.FRONTEND_URL = ALLOWED_ORIGIN
    app = await setupApp()
  })

  afterAll(async () => {
    if (app) await app.close()
    delete process.env.FRONTEND_URL
  })

  beforeEach(async () => {
    await cleanDatabase()
    vi.clearAllMocks()
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
    anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Olá!' }] })
    anthropicStream.mockImplementation(() => makeAnthropicStreamMock({ textChunks: ['Olá!'] }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function createTrainer({ tier = null } = {}) {
    const email = uniqueEmail('trainer')
    const signupRes = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } })
    const { user: { id: userId }, token: { accessToken: userToken } } = signupRes.json()
    const becomeRes = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: { authorization: `Bearer ${userToken}` } })
    const { token: { accessToken } } = becomeRes.json()
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } })
    if (tier) await provisionTrainerPlan(trainer.id, tier)
    return { accessToken, userId, trainerId: trainer.id }
  }

  async function createLinkedStudent(trainer) {
    const email = uniqueEmail('student')
    const signupRes = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } })
    const { user: { id: studentId } } = signupRes.json()
    await app.inject({
      method: 'POST',
      url: '/trainer/students',
      headers: { authorization: `Bearer ${trainer.accessToken}` },
      payload: { email },
    })
    return { studentId }
  }

  function postChat(url, trainer, payload, headers = {}) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${trainer.accessToken}`, ...headers },
      payload,
    })
  }

  async function seedConversation(trainer, messages) {
    const conversation = await prisma.aiConversation.create({ data: { userId: trainer.userId, title: 'Seed' } })
    const base = Date.now() - 60_000
    for (const [index, message] of messages.entries()) {
      await prisma.aiMessage.create({
        data: { conversationId: conversation.id, createdAt: new Date(base + index * 10), ...message },
      })
    }
    return conversation
  }

  const PRIOR_EXCHANGE = [
    { role: 'user', content: 'Adicione exercícios ao treino de peito' },
    { role: 'assistant', content: 'Vou adicionar supino e crucifixo. Confirma?' },
  ]

  describe('plan gate before any write (AC 1)', () => {
    it.each(CHAT_URLS)('should answer 403 platformPlan.aiNotAvailable with the standard error shape on %s', async (url) => {
      const trainer = await createTrainer()

      const res = await postChat(url, trainer, { message: 'Oi' })

      expect(res.statusCode).toBe(FORBIDDEN)
      expect(res.json()).toMatchObject({
        error: PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE.code,
        messageCode: PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE.messageCode,
        message: ptBR.errors[PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE.messageCode],
      })
    })

    it.each(CHAT_URLS)('should translate the plan error to en-US on %s', async (url) => {
      const trainer = await createTrainer()

      const res = await postChat(url, trainer, { message: 'Oi' }, { 'app-language': 'en-US' })

      expect(res.json().message).toBe(enUS.errors[PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE.messageCode])
    })

    it('should reply with JSON, not an event stream, when the stream is refused', async () => {
      const trainer = await createTrainer()

      const res = await postChat('/trainer/ai/chat/stream', trainer, { message: 'Oi' })

      expect(res.headers['content-type']).toMatch(/application\/json/)
    })

    it.each(CHAT_URLS)('should create no conversation and no message on %s when the plan forbids AI', async (url) => {
      const trainer = await createTrainer()

      await postChat(url, trainer, { message: 'Oi' })

      expect(await prisma.aiConversation.count()).toBe(0)
      expect(await prisma.aiMessage.count()).toBe(0)
    })

    it('should not save the user message into an existing conversation when the plan forbids AI', async () => {
      const trainer = await createTrainer()
      const conversation = await seedConversation(trainer, PRIOR_EXCHANGE)

      await postChat('/trainer/ai/chat', trainer, { message: 'Oi', conversationId: conversation.id })

      expect(await prisma.aiMessage.count({ where: { conversationId: conversation.id } })).toBe(PRIOR_EXCHANGE.length)
    })

    it('should not call the model when the plan forbids AI', async () => {
      const trainer = await createTrainer()

      await postChat('/trainer/ai/chat', trainer, { message: 'Oi' })

      expect(anthropicCreate).not.toHaveBeenCalled()
    })
  })

  describe('AI unavailable without an API key (AC 4)', () => {
    beforeEach(() => {
      vi.stubEnv('ANTHROPIC_API_KEY', '')
    })

    it.each(CHAT_URLS)('should answer 503 ai.unavailable with the standard error shape on %s', async (url) => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      const res = await postChat(url, trainer, { message: 'Oi' })

      expect(res.statusCode).toBe(SERVICE_UNAVAILABLE)
      expect(res.json()).toMatchObject({
        error: AI_ERRORS.UNAVAILABLE,
        messageCode: AI_MESSAGE_CODES.UNAVAILABLE,
        message: ptBR.errors[AI_MESSAGE_CODES.UNAVAILABLE],
      })
    })

    it('should reply with JSON, not an event stream, on the stream route', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      const res = await postChat('/trainer/ai/chat/stream', trainer, { message: 'Oi' })

      expect(res.headers['content-type']).toMatch(/application\/json/)
    })

    it('should create no conversation while AI is unavailable', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      await postChat('/trainer/ai/chat', trainer, { message: 'Oi' })

      expect(await prisma.aiConversation.count()).toBe(0)
    })
  })

  describe('per-student quota (AC 2)', () => {
    async function useAiActions(trainer, studentId, count) {
      await prisma.aiUsageEvent.createMany({
        data: Array.from({ length: count }, () => ({
          trainerId: trainer.trainerId,
          studentId,
          action: AI_TOOLS.UPDATE_EXERCISE,
          billingMonth: getBillingMonth(),
        })),
      })
    }

    it.each(CHAT_URLS)('should answer 403 platformPlan.aiActionsExceeded on %s for a PRO student over quota', async (url) => {
      const trainer = await createTrainer({ tier: 'PRO' })
      const { studentId } = await createLinkedStudent(trainer)
      await useAiActions(trainer, studentId, PLAN_LIMITS.PRO.aiActionsPerStudent)

      const res = await postChat(url, trainer, { message: 'Como vai o aluno?', studentId })

      expect(res.statusCode).toBe(FORBIDDEN)
      expect(res.json()).toMatchObject({
        error: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.code,
        messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode,
      })
    })

    it('should still allow a PRO student that is under quota', async () => {
      const trainer = await createTrainer({ tier: 'PRO' })
      const { studentId } = await createLinkedStudent(trainer)
      await useAiActions(trainer, studentId, PLAN_LIMITS.PRO.aiActionsPerStudent - 1)

      const res = await postChat('/trainer/ai/chat', trainer, { message: 'Como vai o aluno?', studentId })

      expect(res.statusCode).toBe(200)
    })

    it('should not count another student usage against this student', async () => {
      const trainer = await createTrainer({ tier: 'PRO' })
      const { studentId: busyStudent } = await createLinkedStudent(trainer)
      const { studentId: freshStudent } = await createLinkedStudent(trainer)
      await useAiActions(trainer, busyStudent, PLAN_LIMITS.PRO.aiActionsPerStudent)

      const res = await postChat('/trainer/ai/chat', trainer, { message: 'Como vai o aluno?', studentId: freshStudent })

      expect(res.statusCode).toBe(200)
    })

    it('should keep enforcing the DIAMOND trainer cap', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })
      const { studentId } = await createLinkedStudent(trainer)
      await useAiActions(trainer, studentId, PLAN_LIMITS.DIAMOND.aiActionsTrainerCap)

      const res = await postChat('/trainer/ai/chat', trainer, { message: 'Oi' })

      expect(res.json()).toMatchObject({ messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode })
    })
  })

  describe('studentId on chat requests (AC 20)', () => {
    it.each(CHAT_URLS)('should answer 400 when studentId is not a uuid on %s', async (url) => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      const res = await postChat(url, trainer, { message: 'Oi', studentId: 'not-a-uuid' })

      expect(res.statusCode).toBe(400)
    })

    it('should accept the studentId of a linked student', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })
      const { studentId } = await createLinkedStudent(trainer)

      const res = await postChat('/trainer/ai/chat', trainer, { message: 'Como vai o aluno?', studentId })

      expect(res.statusCode).toBe(200)
    })

    it.each(CHAT_URLS)('should refuse on %s the studentId of a student linked to another trainer', async (url) => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })
      const otherTrainer = await createTrainer({ tier: 'DIAMOND' })
      const { studentId } = await createLinkedStudent(otherTrainer)

      const res = await postChat(url, trainer, { message: 'Como vai o aluno?', studentId })

      expect([FORBIDDEN, 404]).toContain(res.statusCode)
      expect(res.json()).toHaveProperty('messageCode')
    })

    it('should not call the model nor create a conversation for a foreign student', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })
      const otherTrainer = await createTrainer({ tier: 'DIAMOND' })
      const { studentId } = await createLinkedStudent(otherTrainer)

      await postChat('/trainer/ai/chat', trainer, { message: 'Como vai o aluno?', studentId })

      expect(anthropicCreate).not.toHaveBeenCalled()
      expect(await prisma.aiConversation.count()).toBe(0)
    })
  })

  describe('conversations saved in the legacy order (AC 8)', () => {
    const TOOL_CALL_ID = 'toolu_legacy_e2e'
    const TOOL_USE_BLOCK = { type: 'tool_use', id: TOOL_CALL_ID, name: AI_TOOLS.UPDATE_EXERCISE, input: { exerciseId: 'x' } }
    const TOOL_RESULT = [{ toolCallId: TOOL_CALL_ID, content: '{"success":true}' }]

    it('should keep roles alternating when the tool_result sorts before its assistant message', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })
      const conversation = await seedConversation(trainer, [
        ...PRIOR_EXCHANGE,
        { role: 'user', content: 'Sim, pode fazer' },
        { role: 'tool_result', content: '{"success":true}', rawContent: TOOL_RESULT },
        { role: 'assistant', content: 'Atualizando...', rawContent: [{ type: 'text', text: 'Atualizando...' }, TOOL_USE_BLOCK] },
        { role: 'assistant', content: 'Exercício atualizado com sucesso!' },
      ])

      const res = await postChat('/trainer/ai/chat', trainer, { message: 'Obrigado', conversationId: conversation.id })

      const roles = anthropicCreate.mock.calls[0][0].messages.map((m) => m.role)
      expect(res.statusCode).toBe(200)
      roles.forEach((role, index) => {
        if (index > 0) expect(role).not.toBe(roles[index - 1])
      })
    })
  })

  describe('exercise order on append (AC 9)', () => {
    async function seedTrainingWithExercises(trainer, studentId, existingCount) {
      const protocol = await prisma.trainingProtocol.create({
        data: { assigneeId: studentId, trainerId: trainer.trainerId, name: 'Protocolo', startDate: new Date('2026-10-01') },
      })
      const training = await prisma.training.create({
        data: { trainingProtocolId: protocol.id, name: 'Peito', category: 'strength', order: 0 },
      })
      for (let order = 0; order < existingCount; order += 1) {
        await prisma.exercise.create({ data: { trainingId: training.id, name: `Existente ${order}`, type: 'strength', order } })
      }
      return { protocol, training }
    }

    it('should append exercises after the existing ones instead of colliding at order 0', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })
      const { studentId } = await createLinkedStudent(trainer)
      const { training } = await seedTrainingWithExercises(trainer, studentId, 3)
      const conversation = await seedConversation(trainer, PRIOR_EXCHANGE)
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          id: 'tc-add',
          name: AI_TOOLS.ADD_EXERCISES_TO_TRAINING,
          input: {
            trainingId: training.id,
            exercises: [
              { name: 'Supino reto', type: 'strength', sets: 4, repetitions: { min: 8, max: 12 }, restInterval: 60 },
              { name: 'Crucifixo', type: 'strength', sets: 3, repetitions: { min: 10, max: 12 }, restInterval: 60 },
            ],
          },
        }],
      })

      const res = await postChat('/trainer/ai/chat', trainer, { message: CONFIRMATION, conversationId: conversation.id })

      const exercises = await prisma.exercise.findMany({ where: { trainingId: training.id }, orderBy: { order: 'asc' } })
      expect(res.statusCode).toBe(200)
      expect(exercises.map((e) => e.order)).toEqual([0, 1, 2, 3, 4])
    })

    it('should not warn that exercises were left out after they were added', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })
      const { studentId } = await createLinkedStudent(trainer)
      const { training } = await seedTrainingWithExercises(trainer, studentId, 1)
      const conversation = await seedConversation(trainer, [
        { role: 'user', content: 'Adicione supino e crucifixo' },
        { role: 'assistant', content: 'Vou adicionar:\n- Supino reto 4x10\n- Crucifixo 3x12\nConfirma?' },
      ])
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          id: 'tc-add',
          name: AI_TOOLS.ADD_EXERCISES_TO_TRAINING,
          input: { trainingId: training.id, exercises: [{ name: 'Supino reto', type: 'strength', sets: 4, repetitions: { min: 10, max: 10 }, restInterval: 60 }] },
        }],
      })

      const res = await postChat('/trainer/ai/chat', trainer, { message: CONFIRMATION, conversationId: conversation.id })

      expect(res.json().message).not.toContain('não foram incluídos')
    })
  })

  describe('protocol template tool summary (AC 24)', () => {
    it('should store real exercise names and sets in the tool_result the model sees next turn', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })
      const conversation = await seedConversation(trainer, [
        { role: 'user', content: 'Crie a rotina ABC' },
        { role: 'assistant', content: 'Vou criar a rotina ABC com supino. Confirma?' },
      ])
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          id: 'tc-protocol',
          name: AI_TOOLS.CREATE_PROTOCOL_TEMPLATE,
          input: {
            name: 'Rotina ABC',
            trainings: [{
              name: 'Treino A',
              category: 'strength',
              exercises: [{ name: 'Supino reto', type: 'strength', sets: 4, repetitions: { min: 8, max: 12 }, restInterval: 90 }],
            }],
          },
        }],
      })

      await postChat('/trainer/ai/chat', trainer, { message: CONFIRMATION, conversationId: conversation.id })

      const toolResult = await prisma.aiMessage.findFirst({ where: { conversationId: conversation.id, role: 'tool_result' } })
      const summary = JSON.parse(toolResult.content)
      expect(summary.trainings[0].exercises[0]).toMatchObject({ name: 'Supino reto', sets: 4 })
    })
  })

  describe('SSE error event (AC 27)', () => {
    beforeEach(() => {
      anthropicStream.mockImplementation(() => makeFailingAnthropicStream())
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    it('should send messageCode and the pt-BR message by default', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      const res = await postChat('/trainer/ai/chat/stream', trainer, { message: 'Oi' })

      const errorEvent = parseSseBody(res.body).find((entry) => entry.event === 'error')
      expect(errorEvent.data).toMatchObject({
        messageCode: MODEL_ERROR_MESSAGE_CODE,
        message: ptBR.errors[MODEL_ERROR_MESSAGE_CODE],
      })
    })

    it('should translate the message with the app-language header', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      const res = await postChat('/trainer/ai/chat/stream', trainer, { message: 'Oi' }, { 'app-language': 'en-US' })

      const errorEvent = parseSseBody(res.body).find((entry) => entry.event === 'error')
      expect(errorEvent.data.message).toBe(enUS.errors[MODEL_ERROR_MESSAGE_CODE])
    })
  })

  describe('stream CORS allowlist (AC 28)', () => {
    it('should allow the configured frontend origin', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      const res = await postChat('/trainer/ai/chat/stream', trainer, { message: 'Oi' }, { origin: ALLOWED_ORIGIN })

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    })

    it('should not reflect an origin that merely starts with the allowed origin', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      const res = await postChat('/trainer/ai/chat/stream', trainer, { message: 'Oi' }, { origin: LOOKALIKE_ORIGIN })

      expect(res.headers['access-control-allow-origin']).not.toBe(LOOKALIKE_ORIGIN)
    })

    it('should not grant credentials to a lookalike origin', async () => {
      const trainer = await createTrainer({ tier: 'DIAMOND' })

      const res = await postChat('/trainer/ai/chat/stream', trainer, { message: 'Oi' }, { origin: LOOKALIKE_ORIGIN })

      expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    })
  })
})
