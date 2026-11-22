import 'dotenv/config'
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { prisma } from '../../src/db.js'
import { setupApp } from '../helpers/setup-app.js'
import { cleanDatabase } from '../helpers/db-cleanup.js'
import { provisionTrainerPlan } from '../helpers/platform-plan.js'
import { signupVerified } from '../helpers/signup-user.js'
import { linkStudentByInvite } from '../helpers/link-student.js'
import { AI_ERRORS, AI_MESSAGE_CODES } from '../../src/constants/ai.js'
import ptBR from '../../src/i18n/locales/pt-BR.js'
import enUS from '../../src/i18n/locales/en-US.js'

const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'

const PASSWORD = 'Test1234!'
const SECRET_ANSWER = 'RESPOSTA-PRIVADA-DO-TREINADOR-B'
const CHAT_URL = '/trainer/ai/chat'
const STREAM_URL = '/trainer/ai/chat/stream'

let emailCounter = 0

// Builds a unique email so concurrent signups never collide.
function uniqueEmail(prefix) {
  emailCounter += 1
  return `${prefix}-${Date.now()}-${emailCounter}@test.com`
}

// Builds an Anthropic stream double that yields the text and resolves the final message.
function makeAnthropicStreamMock(text) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }
    },
    finalMessage: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
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

describe('e2e: iArnold review fixes', () => {
  let app

  beforeAll(async () => {
    app = await setupApp()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  beforeEach(async () => {
    await cleanDatabase()
    vi.clearAllMocks()
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
    anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Olá!' }] })
    anthropicStream.mockImplementation(() => makeAnthropicStreamMock('Olá!'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function createTrainer() {
    const email = uniqueEmail('trainer')
    const signupRes = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } })
    const { user: { id: userId }, token: { accessToken: userToken } } = signupRes.json()
    const becomeRes = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: { authorization: `Bearer ${userToken}` } })
    const { token: { accessToken } } = becomeRes.json()
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } })
    await provisionTrainerPlan(trainer.id, 'DIAMOND')
    return { accessToken, userId, trainerId: trainer.id }
  }

  async function linkStudent(trainer, email) {
    await linkStudentByInvite(app, { trainerToken: trainer.accessToken, email })
  }

  async function createSharedStudent(...trainers) {
    const email = uniqueEmail('student')
    const signupRes = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } })
    const { user: { id: studentId } } = signupRes.json()
    for (const trainer of trainers) await linkStudent(trainer, email)
    return studentId
  }

  function post(url, trainer, payload, headers = {}) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${trainer.accessToken}`, ...headers },
      payload,
    })
  }

  describe('anamnesis is only visible to the trainer who linked it (B2)', () => {
    async function seedGeneralAnamnesisLinkedBy(trainer, studentId) {
      const anamnesis = await prisma.anamnesis.create({ data: { title: 'Geral', isGeneral: true } })
      const section = await prisma.anamnesisSection.create({ data: { anamnesisId: anamnesis.id, title: 'Saúde' } })
      const question = await prisma.anamnesisQuestion.create({ data: { sectionId: section.id, text: 'Observações privadas?', type: 'text' } })
      await prisma.studentAnamnesis.create({ data: { anamnesisId: anamnesis.id, studentId, trainerId: trainer.trainerId } })
      const response = await prisma.anamnesisResponse.create({ data: { anamnesisId: anamnesis.id, studentId, submittedAt: new Date() } })
      await prisma.anamnesisAnswer.create({ data: { responseId: response.id, questionId: question.id, value: SECRET_ANSWER } })
    }

    function promptSentToModel() {
      return anthropicCreate.mock.calls[0][0].system.map((block) => block.text).join('\n')
    }

    it('should not send trainer B answers about a shared student to trainer A', async () => {
      const trainerA = await createTrainer()
      const trainerB = await createTrainer()
      const studentId = await createSharedStudent(trainerA, trainerB)
      await seedGeneralAnamnesisLinkedBy(trainerB, studentId)

      const res = await post(CHAT_URL, trainerA, { message: 'Monte um treino para ele', studentId })

      expect(res.statusCode).toBe(200)
      expect(promptSentToModel()).not.toContain(SECRET_ANSWER)
    })

    it('should send the answers to the trainer who linked the anamnesis', async () => {
      const trainerA = await createTrainer()
      const trainerB = await createTrainer()
      const studentId = await createSharedStudent(trainerA, trainerB)
      await seedGeneralAnamnesisLinkedBy(trainerB, studentId)

      const res = await post(CHAT_URL, trainerB, { message: 'Monte um treino para ele', studentId })

      expect(res.statusCode).toBe(200)
      expect(promptSentToModel()).toContain(SECRET_ANSWER)
    })

    it('should ignore a soft-deleted anamnesis even for the trainer who linked it', async () => {
      const trainerB = await createTrainer()
      const studentId = await createSharedStudent(trainerB)
      await seedGeneralAnamnesisLinkedBy(trainerB, studentId)
      await prisma.anamnesis.updateMany({ data: { deletedAt: new Date() } })

      await post(CHAT_URL, trainerB, { message: 'Monte um treino para ele', studentId })

      expect(promptSentToModel()).not.toContain(SECRET_ANSWER)
    })
  })

  describe('failed turns expose the conversation to retry in', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      anthropicCreate.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }))
      anthropicStream.mockImplementation(() => makeFailingAnthropicStream())
    })

    it('should return the conversation id in details of the JSON error from /chat', async () => {
      const trainer = await createTrainer()

      const res = await post(CHAT_URL, trainer, { message: 'Oi' })

      const conversation = await prisma.aiConversation.findFirst({ where: { userId: trainer.userId } })
      expect(res.statusCode).toBe(502)
      expect(res.json()).toMatchObject({
        error: AI_ERRORS.MODEL_ERROR,
        messageCode: AI_MESSAGE_CODES.MODEL_ERROR,
        details: { conversationId: conversation.id },
      })
    })

    it('should return the conversation id at the top level of the SSE error event', async () => {
      const trainer = await createTrainer()

      const res = await post(STREAM_URL, trainer, { message: 'Oi' })

      const conversation = await prisma.aiConversation.findFirst({ where: { userId: trainer.userId } })
      const errorEvent = parseSseBody(res.body).find((entry) => entry.event === 'error')
      expect(errorEvent.data).toEqual({
        error: AI_ERRORS.MODEL_ERROR,
        messageCode: AI_MESSAGE_CODES.MODEL_ERROR,
        message: ptBR.errors[AI_MESSAGE_CODES.MODEL_ERROR],
        conversationId: conversation.id,
      })
    })

    it('should reuse the conversation and the saved message when the client retries', async () => {
      const trainer = await createTrainer()
      const first = await post(CHAT_URL, trainer, { message: 'Oi' })
      const { conversationId } = first.json().details
      anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Olá!' }] })

      const retry = await post(CHAT_URL, trainer, { message: 'Oi', conversationId })

      expect(retry.statusCode).toBe(200)
      expect(await prisma.aiConversation.count()).toBe(1)
      expect(await prisma.aiMessage.count({ where: { conversationId, role: 'user' } })).toBe(1)
      expect(await prisma.aiMessage.count({ where: { conversationId, role: 'assistant' } })).toBe(1)
    })

    it('should title the conversation once the retry succeeds', async () => {
      const trainer = await createTrainer()
      const { conversationId } = (await post(CHAT_URL, trainer, { message: 'Oi, tudo bem?' })).json().details
      anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Olá!' }] })

      await post(CHAT_URL, trainer, { message: 'Oi, tudo bem?', conversationId })

      const conversation = await prisma.aiConversation.findUnique({ where: { id: conversationId } })
      expect(conversation.title).toBe('Oi, tudo bem?')
    })
  })

  describe('SSE progress texts follow app-language', () => {
    it('should send the pt-BR status text by default', async () => {
      const trainer = await createTrainer()

      const res = await post(STREAM_URL, trainer, { message: 'Oi' })

      const statuses = parseSseBody(res.body).filter((entry) => entry.event === 'status')
      expect(statuses[0].data.message).toBe(`${ptBR.ai.status.analyzing}...`)
    })

    it('should send the en-US status text with app-language en-US', async () => {
      const trainer = await createTrainer()

      const res = await post(STREAM_URL, trainer, { message: 'Oi' }, { 'app-language': 'en-US' })

      const statuses = parseSseBody(res.body).filter((entry) => entry.event === 'status')
      expect(statuses[0].data.message).toBe(`${enUS.ai.status.analyzing}...`)
    })
  })
})
