import 'dotenv/config'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { setupApp } from '../helpers/setup-app.js'
import { cleanDatabase } from '../helpers/db-cleanup.js'

// Mock the Anthropic SDK so no real API calls are made.
// We do NOT mock the whole ai-training-service so that real service logic
// (schema validation, DB persistence, etc.) executes during E2E tests.
//
// anthropicCreate is a stable vi.fn() reference. The constructor mock is
// re-applied in beforeEach because mockReset:true clears implementations.
const anthropicCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'

const hasDatabaseUrl = !!process.env.DATABASE_URL
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip

e2eDescribe('e2e: AI Assistant routes', () => {
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
    // Re-apply constructor mock after mockReset clears it.
    // Must use a regular function (not arrow) — arrow functions cannot be `new`-ed.
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate }
    })
  })

  // ---------------------------------------------------------------------------
  // Helper: create a trainer account and return a valid Bearer token
  // ---------------------------------------------------------------------------
  async function createTrainerWithToken() {
    const email = `trainer-${Date.now()}@test.com`
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'Test1234!' },
    })
    const userToken = signupRes.json().token.accessToken

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${userToken}` },
    })
    const { token: { accessToken } } = becomeRes.json()
    return { accessToken }
  }

  // ---------------------------------------------------------------------------
  // Helper: create a student account and return a valid Bearer token
  // ---------------------------------------------------------------------------
  async function createStudentWithToken() {
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: `student-${Date.now()}@test.com`,
        password: 'Test1234!',
      },
    })
    return { accessToken: signupRes.json().token.accessToken }
  }

  // ---------------------------------------------------------------------------
  // POST /trainer/ai/chat — Authentication
  // ---------------------------------------------------------------------------
  describe('POST /trainer/ai/chat — authentication', () => {
    it('returns 401 when no authorization token is provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        payload: { message: 'Olá' },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
      })
    })

    it('returns 403 when authenticated as a student (missing TRAINER role)', async () => {
      const { accessToken } = await createStudentWithToken()

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Olá' },
      })

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({
        error: expect.any(String),
        messageCode: expect.any(String),
      })
    })
  })

  // ---------------------------------------------------------------------------
  // POST /trainer/ai/chat — Request validation
  // ---------------------------------------------------------------------------
  describe('POST /trainer/ai/chat — request validation', () => {
    it('returns 400 when message field is missing', async () => {
      const { accessToken } = await createTrainerWithToken()

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {},
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      })
    })

    it('returns 400 when message is an empty string', async () => {
      const { accessToken } = await createTrainerWithToken()

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: '' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      })
    })

    it('returns 400 when conversationId is not a valid UUID', async () => {
      const { accessToken } = await createTrainerWithToken()

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Olá', conversationId: 'not-a-uuid' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      })
    })
  })

  // ---------------------------------------------------------------------------
  // POST /trainer/ai/chat — Success path
  // ---------------------------------------------------------------------------
  describe('POST /trainer/ai/chat — success path', () => {
    it('returns 200 with conversationId, message and actionsExecuted on first message', async () => {
      const { accessToken } = await createTrainerWithToken()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá! Como posso ajudar com os treinos hoje?' }],
      })

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Olá' },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(typeof body.conversationId).toBe('string')
      expect(typeof body.message).toBe('string')
      expect(Array.isArray(body.actionsExecuted)).toBe(true)
    })

    it('returns 200 with the same conversationId when continuing an existing conversation', async () => {
      const { accessToken } = await createTrainerWithToken()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá!' }],
      })

      const firstRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Olá' },
      })

      expect(firstRes.statusCode).toBe(200)
      const { conversationId } = firstRes.json()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Claro! O que você deseja criar?' }],
      })

      const secondRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Quero criar um treino', conversationId },
      })

      expect(secondRes.statusCode).toBe(200)
      expect(secondRes.json().conversationId).toBe(conversationId)
    })

    it('returns 404 when conversationId belongs to another user', async () => {
      const trainer1 = await createTrainerWithToken()
      const trainer2 = await createTrainerWithToken()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá!' }],
      })

      const firstRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${trainer1.accessToken}` },
        payload: { message: 'Olá' },
      })

      expect(firstRes.statusCode).toBe(200)
      const { conversationId } = firstRes.json()

      const secondRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${trainer2.accessToken}` },
        payload: { message: 'Olá', conversationId },
      })

      expect(secondRes.statusCode).toBe(404)
      expect(secondRes.json()).toMatchObject({
        error: 'AI_CONVERSATION_NOT_FOUND',
        messageCode: 'ai.conversationNotFound',
      })
    })
  })

  // ---------------------------------------------------------------------------
  // GET /trainer/ai/conversations
  // ---------------------------------------------------------------------------
  describe('GET /trainer/ai/conversations', () => {
    it('returns 401 when no authorization token is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/trainer/ai/conversations',
      })

      expect(res.statusCode).toBe(401)
    })

    it('returns empty array when trainer has no conversations', async () => {
      const { accessToken } = await createTrainerWithToken()

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/ai/conversations',
        headers: { authorization: `Bearer ${accessToken}` },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    })

    it('returns conversations ordered by updatedAt desc', async () => {
      const { accessToken } = await createTrainerWithToken()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá!' }],
      })

      await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Primeira conversa' },
      })

      await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Segunda conversa' },
      })

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/ai/conversations',
        headers: { authorization: `Bearer ${accessToken}` },
      })

      expect(res.statusCode).toBe(200)
      const conversations = res.json()
      expect(conversations).toHaveLength(2)
      conversations.forEach(c => {
        expect(c).toMatchObject({ id: expect.any(String), createdAt: expect.any(String) })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // GET /trainer/ai/conversations/:conversationId
  // ---------------------------------------------------------------------------
  describe('GET /trainer/ai/conversations/:conversationId', () => {
    it('returns 404 when conversation does not exist', async () => {
      const { accessToken } = await createTrainerWithToken()

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/ai/conversations/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
      })

      expect(res.statusCode).toBe(404)
    })

    it('returns conversation with messages', async () => {
      const { accessToken } = await createTrainerWithToken()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá!' }],
      })

      const chatRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Olá' },
      })

      const { conversationId } = chatRes.json()

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/ai/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.id).toBe(conversationId)
      expect(Array.isArray(body.messages)).toBe(true)
      expect(body.messages.length).toBeGreaterThanOrEqual(2) // user + assistant
    })

    it('returns 404 when conversation belongs to another user', async () => {
      const trainer1 = await createTrainerWithToken()
      const trainer2 = await createTrainerWithToken()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá!' }],
      })

      const chatRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${trainer1.accessToken}` },
        payload: { message: 'Olá' },
      })

      const { conversationId } = chatRes.json()

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/ai/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${trainer2.accessToken}` },
      })

      expect(res.statusCode).toBe(404)
    })
  })

  // ---------------------------------------------------------------------------
  // DELETE /trainer/ai/conversations/:conversationId
  // ---------------------------------------------------------------------------
  describe('DELETE /trainer/ai/conversations/:conversationId', () => {
    it('returns 404 when conversation does not exist', async () => {
      const { accessToken } = await createTrainerWithToken()

      const res = await app.inject({
        method: 'DELETE',
        url: '/trainer/ai/conversations/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
      })

      expect(res.statusCode).toBe(404)
    })

    it('returns 204 and removes the conversation', async () => {
      const { accessToken } = await createTrainerWithToken()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá!' }],
      })

      const chatRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Olá' },
      })

      const { conversationId } = chatRes.json()

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/trainer/ai/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      })

      expect(deleteRes.statusCode).toBe(204)

      const getRes = await app.inject({
        method: 'GET',
        url: `/trainer/ai/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      })

      expect(getRes.statusCode).toBe(404)
    })

    it('returns 404 when trying to delete another user conversation', async () => {
      const trainer1 = await createTrainerWithToken()
      const trainer2 = await createTrainerWithToken()

      anthropicCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Olá!' }],
      })

      const chatRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${trainer1.accessToken}` },
        payload: { message: 'Olá' },
      })

      const { conversationId } = chatRes.json()

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/ai/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${trainer2.accessToken}` },
      })

      expect(res.statusCode).toBe(404)
    })
  })
})
