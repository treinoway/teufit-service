import 'dotenv/config'
import http from 'node:http'
import { Writable } from 'node:stream'
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { prisma } from '../../src/db.js'
import { setupApp } from '../helpers/setup-app.js'
import { cleanDatabase } from '../helpers/db-cleanup.js'
import { provisionTrainerPlan } from '../helpers/platform-plan.js'
import { signupVerified } from '../helpers/signup-user.js'
import { linkStudentByInvite } from '../helpers/link-student.js'
import { AI_TOOLS } from '../../src/constants/ai.js'

const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'

const PASSWORD = 'Test1234!'
const ERROR_LEVEL = 50
const POLL_INTERVAL_MS = 25
const POLL_TIMEOUT_MS = 5000
const QUIET_PERIOD_MS = 300

let emailCounter = 0

// Builds a unique email so concurrent signups never collide.
function uniqueEmail(prefix) {
  emailCounter += 1
  return `${prefix}-${Date.now()}-${emailCounter}@test.com`
}

// Resolves once the condition returns a truthy value, or fails after the timeout.
async function waitFor(condition, description) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    const value = await condition()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

// Builds an Anthropic stream double that never answers until the abort signal fires.
function makeHangingStream(signalRef) {
  return (_params, options) => {
    signalRef.current = options.signal
    return {
      [Symbol.asyncIterator]: async function* () {
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')))
        })
      },
      finalMessage: async () => { throw new Error('aborted') },
    }
  }
}

// Builds an Anthropic stream double that ends with the given tool_use block.
function makeToolUseStream(toolUse) {
  return () => ({
    [Symbol.asyncIterator]: async function* () {},
    finalMessage: async () => ({
      stop_reason: 'tool_use',
      content: [toolUse],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  })
}

describe('e2e: AI client disconnect', () => {
  let app
  let port
  let logLines

  beforeAll(async () => {
    logLines = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(...chunk.toString().split('\n').filter(Boolean))
        callback()
      },
    })
    app = await setupApp({ logger: { level: 'info', stream } })
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = app.server.address().port
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  beforeEach(async () => {
    await cleanDatabase()
    vi.clearAllMocks()
    logLines.length = 0
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function errorLogs() {
    return logLines
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((entry) => entry && entry.level >= ERROR_LEVEL)
  }

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

  function openRequest(path, trainer, body) {
    const payload = JSON.stringify(body)
    const chunks = []
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        authorization: `Bearer ${trainer.accessToken}`,
      },
    })
    request.on('error', () => {})
    request.on('response', (response) => {
      response.on('data', (chunk) => chunks.push(chunk.toString()))
      response.on('error', () => {})
    })
    request.end(payload)
    return { request, received: () => chunks.join('') }
  }

  describe('upstream abort', () => {
    it.each([
      ['/trainer/ai/chat/stream', () => anthropicStream],
      ['/trainer/ai/chat', () => anthropicCreate],
    ])('should abort the in-flight model call when the client drops %s', async (path, mock) => {
      const trainer = await createTrainer()
      const signalRef = { current: null }
      const hanging = makeHangingStream(signalRef)
      mock().mockImplementation(path.endsWith('/stream')
        ? hanging
        : (_params, options) => new Promise((_resolve, reject) => {
          signalRef.current = options.signal
          options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')))
        }))

      const { request } = openRequest(path, trainer, { message: 'Oi' })
      await waitFor(() => signalRef.current, 'the model call to start')
      expect(signalRef.current.aborted).toBe(false)
      request.destroy()

      await waitFor(() => signalRef.current.aborted, 'the upstream signal to abort')
    })

    it('should not log a 5xx or crash when a non-streaming client leaves mid-call', async () => {
      const trainer = await createTrainer()
      const signalRef = { current: null }
      anthropicCreate.mockImplementation((_params, options) => new Promise((_resolve, reject) => {
        signalRef.current = options.signal
        options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')))
      }))

      const { request } = openRequest('/trainer/ai/chat', trainer, { message: 'Oi' })
      await waitFor(() => signalRef.current, 'the model call to start')
      request.destroy()
      await waitFor(() => signalRef.current.aborted, 'the upstream signal to abort')
      await new Promise((resolve) => setTimeout(resolve, QUIET_PERIOD_MS))

      expect(errorLogs()).toEqual([])
      const health = await app.inject({ method: 'GET', url: '/health' })
      expect(health.statusCode).toBeLessThan(500)
    })
  })

  describe('persistence after a write tool ran', () => {
    it('should still save the final assistant message and the interaction log when the client leaves right after the tool ran', async () => {
      const trainer = await createTrainer()
      const email = uniqueEmail('student')
      const signupRes = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } })
      const { user: { id: studentId } } = signupRes.json()
      await linkStudentByInvite(app, { trainerToken: trainer.accessToken, email })
      const protocol = await prisma.trainingProtocol.create({
        data: { assigneeId: studentId, trainerId: trainer.trainerId, name: 'Protocolo', startDate: new Date('2026-10-01') },
      })
      const training = await prisma.training.create({ data: { trainingProtocolId: protocol.id, name: 'Peito', category: 'strength', order: 0 } })
      const exercise = await prisma.exercise.create({ data: { trainingId: training.id, name: 'Supino', type: 'strength', order: 0, sets: 3 } })
      const conversation = await prisma.aiConversation.create({ data: { userId: trainer.userId, title: 'Seed' } })
      const base = Date.now() - 60_000
      await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'user', content: 'Muda o supino para 5 séries', createdAt: new Date(base) } })
      await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'assistant', content: 'Vou alterar o Supino para 5 séries. Confirma?', createdAt: new Date(base + 10) } })
      anthropicStream.mockImplementation(makeToolUseStream({
        type: 'tool_use',
        id: 'tc-update',
        name: AI_TOOLS.UPDATE_EXERCISE,
        input: { exerciseId: exercise.id, sets: 5 },
      }))

      const { request, received } = openRequest('/trainer/ai/chat/stream', trainer, { message: 'Sim, pode fazer', conversationId: conversation.id })
      await waitFor(() => received().includes('event: text_delta'), 'the final text event')
      request.destroy()

      const finalMessage = await waitFor(
        () => prisma.aiMessage.findFirst({ where: { conversationId: conversation.id, role: 'assistant', content: { contains: 'atualizado' } } }),
        'the final assistant message',
      )
      const log = await waitFor(() => prisma.aiInteractionLog.findFirst({ where: { conversationId: conversation.id } }), 'the interaction log')
      const updated = await prisma.exercise.findUnique({ where: { id: exercise.id } })
      expect(finalMessage.content).toContain('Supino')
      expect(log.action).toBe(AI_TOOLS.UPDATE_EXERCISE)
      expect(updated.sets).toBe(5)
    })
  })
})
