import 'dotenv/config'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { prisma } from '../../src/db.js'
import { setupApp } from '../helpers/setup-app.js'
import { cleanDatabase } from '../helpers/db-cleanup.js'
import { provisionTrainerPlan } from '../helpers/platform-plan.js'

// Mock the Anthropic SDK so no real API calls are made.
// We do NOT mock the whole ai-training-service so that real service logic
// (schema validation, DB persistence, etc.) executes during E2E tests.
//
// anthropicCreate is a stable vi.fn() reference. The constructor mock is
// re-applied in beforeEach because mockReset:true clears implementations.
const anthropicCreate = vi.fn()
const anthropicStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { signupVerified } from '../helpers/signup-user.js';
import { linkStudentByInvite } from '../helpers/link-student.js';

/**
 * Build a mock Anthropic stream object that yields text_delta events
 * and resolves finalMessage() to a messages.create-compatible response.
 */
function makeAnthropicStreamMock({ textChunks = [], stopReason = 'end_turn', toolUseBlocks = [] } = {}) {
  const finalContent = [
    ...textChunks.map((t) => ({ type: 'text', text: t })),
    ...toolUseBlocks,
  ]
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of textChunks) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } }
      }
    },
    finalMessage: async () => ({
      stop_reason: stopReason,
      content: finalContent,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  }
}

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
      this.messages = { create: anthropicCreate, stream: anthropicStream }
    })
  })

  // ---------------------------------------------------------------------------
  // Helper: create a trainer account and return a valid Bearer token
  // ---------------------------------------------------------------------------
  async function createTrainerWithToken() {
    const email = `trainer-${Date.now()}@test.com`
    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'Test1234!' },
    })
    const { user: { id: userId }, token: { accessToken: userToken } } = signupRes.json()

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${userToken}` },
    })
    const { token: { accessToken } } = becomeRes.json()

    // Trainers created via signup + become-trainer have no PlatformSubscription
    // row, so getTrainerPlan() defaults them to FREE (no AI access). Provision
    // DIAMOND so AI-gated routes under test aren't blocked by the plan gate.
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } })
    await provisionTrainerPlan(trainer.id)

    return { accessToken }
  }

  // ---------------------------------------------------------------------------
  // Helper: create a student account and return a valid Bearer token
  // ---------------------------------------------------------------------------
  async function createStudentWithToken() {
    const signupRes = await signupVerified(app, {
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

  // ---------------------------------------------------------------------------
  // Multi-turn conversation persistence (rawContent + tool_result)
  // ---------------------------------------------------------------------------
  describe('multi-turn conversation persistence', () => {
    /**
     * Builds a conversation with 2 prior text turns so the enforcement gate
     * (requires >= 2 messages in history) allows tool execution on the next turn.
     */
    async function buildConversationWithTwoTurns(accessToken) {
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Como posso ajudar?' }],
      })
      const turn1Res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Olá' },
      })
      const { conversationId } = turn1Res.json()

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Ok, confirma a criação?' }],
      })
      await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Cria um protocolo', conversationId },
      })

      return conversationId
    }

    it('conversation includes tool_result and rawContent messages after tool execution', async () => {
      const { accessToken } = await createTrainerWithToken()
      const conversationId = await buildConversationWithTwoTurns(accessToken)

      // Turn 3: tool execution — enforcement gate is cleared (2 messages in history)
      // The tool will fail gracefully (no template found) — that is still a valid tool execution path
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tc-e2e-1',
            name: 'import_from_template',
            // Use a valid UUID that does not exist in DB — service returns AppError 404 gracefully
            input: {
              templateId: '00000000-0000-0000-0000-000000000001',
              assigneeId: '00000000-0000-0000-0000-000000000002',
              startDate: '2026-01-01',
              expirationDate: '2026-06-01',
            },
          },
        ],
      })

      const turn3Res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Confirmo', conversationId },
      })

      // Tool execution result returned even on failure (graceful AppError catch)
      expect(turn3Res.statusCode).toBe(200)
      expect(turn3Res.json().actionsExecuted).toHaveLength(1)

      // The GET /conversations/:id endpoint deliberately filters out role: 'tool_result'
      // rows and omits rawContent from its select (internal-only fields — see
      // getConversation in src/services/ai-training-service.js). So persistence must be
      // verified directly against the DB rather than through the filtered endpoint.
      const persistedMessages = await prisma.aiMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
      })

      // A tool_result message should exist
      const toolResultMsg = persistedMessages.find((m) => m.role === 'tool_result')
      expect(toolResultMsg).toBeDefined()

      // The assistant message that triggered the tool should have rawContent
      const assistantMsgWithRaw = persistedMessages.find(
        (m) => m.role === 'assistant' && m.rawContent != null,
      )
      expect(assistantMsgWithRaw).toBeDefined()
    })

    it('allows a 4th turn after a completed tool execution (no history reconstruction error)', async () => {
      const { accessToken } = await createTrainerWithToken()
      const conversationId = await buildConversationWithTwoTurns(accessToken)

      // Turn 3: tool execution
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tc-e2e-3',
            name: 'import_from_template',
            input: {
              templateId: '00000000-0000-0000-0000-000000000001',
              assigneeId: '00000000-0000-0000-0000-000000000002',
              startDate: '2026-01-01',
              expirationDate: '2026-06-01',
            },
          },
        ],
      })
      await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Confirmo', conversationId },
      })

      // Turn 4: follow-up message — history reconstruction must succeed without throwing
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Claro! O que mais você precisa?' }],
      })
      const turn4Res = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'E outro protocolo?', conversationId },
      })

      expect(turn4Res.statusCode).toBe(200)
      expect(turn4Res.json().message).toBe('Claro! O que mais você precisa?')
    })

    it('does not expose tool_result messages to the LLM as plain text in history', async () => {
      const { accessToken } = await createTrainerWithToken()
      const conversationId = await buildConversationWithTwoTurns(accessToken)

      // Turn 3: tool execution
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tc-e2e-4',
            name: 'import_from_template',
            input: {
              templateId: '00000000-0000-0000-0000-000000000001',
              assigneeId: '00000000-0000-0000-0000-000000000002',
              startDate: '2026-01-01',
              expirationDate: '2026-06-01',
            },
          },
        ],
      })
      await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Confirmo', conversationId },
      })

      // Turn 4: capture what messages were sent to the LLM
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Aqui está o que posso fazer.' }],
      })
      await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'O que mais posso fazer?', conversationId },
      })

      // The last Anthropic call should have messages that include the reconstructed
      // tool_use/tool_result pair — NOT plain text for the tool result
      const lastCallMessages = anthropicCreate.mock.calls.at(-1)[0].messages

      // There must be no message with role 'user' that has a plain-string tool_result content
      // (tool results should be structured content blocks, not plain text)
      const suspectUserMessages = lastCallMessages.filter(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('success'),
      )
      expect(suspectUserMessages).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // get_student_performance — tool execution with real DB
  // ---------------------------------------------------------------------------
  describe('get_student_performance tool execution', () => {
    async function createLinkedStudentForTrainer(trainerToken) {
      const email = `ai-student-${Date.now()}@test.com`
      const signupRes = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: 'Test1234!' },
      })
      expect(signupRes.statusCode).toBe(201)
      const { user: { id: studentId } } = signupRes.json()

      await linkStudentByInvite(app, { trainerToken, email })

      return { studentId }
    }

    it('executes get_student_performance on first turn (read-only tool), makes second LLM call for analysis, returns actionsExecuted with success:true', async () => {
      const { accessToken } = await createTrainerWithToken()
      const { studentId } = await createLinkedStudentForTrainer(accessToken)

      // First call: LLM returns tool_use for get_student_performance on first turn (read-only — bypasses confirmation gate).
      // Second call: LLM returns the analysis text after receiving the tool_result.
      anthropicCreate
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tc-perf-1',
              name: 'get_student_performance',
              input: { studentId },
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'O aluno tem boa adesão nos últimos 90 dias.' }],
        })

      const chatRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Como está o desempenho do aluno?' },
      })

      // Tool executed on first turn — actionsExecuted must include the tool
      expect(chatRes.statusCode).toBe(200)
      const chatBody = chatRes.json()
      expect(chatBody.actionsExecuted).toHaveLength(1)
      expect(chatBody.actionsExecuted[0]).toMatchObject({
        tool: 'get_student_performance',
        success: true,
      })
      // actionsExecuted.data should contain the snapshot with studentId
      expect(chatBody.actionsExecuted[0].data).toMatchObject({ studentId })

      // The final message comes from the second LLM call (analysis), not a local fallback
      expect(chatBody.message).toBe('O aluno tem boa adesão nos últimos 90 dias.')

      // Anthropic was called twice: once for tool_use, once for analysis
      expect(anthropicCreate).toHaveBeenCalledTimes(2)

      // The conversation should be findable by GET
      const convRes = await app.inject({
        method: 'GET',
        url: `/trainer/ai/conversations/${chatBody.conversationId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      })
      expect(convRes.statusCode).toBe(200)
      const { messages } = convRes.json()

      // Conversation must have the user message, the tool_result, and two assistant messages
      // (first with tool_use rawContent, second with the analysis text)
      expect(messages.length).toBeGreaterThanOrEqual(2)
      const userMsg = messages.find((m) => m.role === 'user')
      const assistantMsgs = messages.filter((m) => m.role === 'assistant')
      expect(userMsg).toBeDefined()
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(2)
    })

    it('returns success: false in tool_result when student is not linked to trainer', async () => {
      const { accessToken } = await createTrainerWithToken()
      const UNLINKED_UUID = '00000000-0000-0000-0000-000000000077'

      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tc-perf-unlinked',
            name: 'get_student_performance',
            input: { studentId: UNLINKED_UUID },
          },
        ],
      })
      anthropicCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Aluno não encontrado.' }],
      })

      const chatRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Dados de um aluno' },
      })

      expect(chatRes.statusCode).toBe(200)
      const body = chatRes.json()
      expect(body.actionsExecuted).toHaveLength(1)
      expect(body.actionsExecuted[0].success).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // POST /trainer/ai/chat/stream — get_student_performance SSE streaming
  // ---------------------------------------------------------------------------
  describe('POST /trainer/ai/chat/stream — get_student_performance second LLM stream', () => {
    async function createLinkedStudentForTrainer(trainerToken) {
      const email = `ai-stream-student-${Date.now()}@test.com`
      const signupRes = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: 'Test1234!' },
      })
      expect(signupRes.statusCode).toBe(201)
      const { user: { id: studentId } } = signupRes.json()

      await linkStudentByInvite(app, { trainerToken, email })

      return { studentId }
    }

    /**
     * Parse SSE body text into an array of { event, data } objects.
     */
    function parseSseBody(body) {
      const events = []
      const blocks = body.split('\n\n').filter((b) => b.trim())
      for (const block of blocks) {
        const lines = block.split('\n')
        let event = null
        let data = null
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice('event: '.length).trim()
          if (line.startsWith('data: ')) {
            try { data = JSON.parse(line.slice('data: '.length).trim()) } catch { data = null }
          }
        }
        if (event && data !== null) events.push({ event, data })
      }
      return events
    }

    it('yields text_delta SSE events from the second LLM call and a done event with analysis text', async () => {
      const { accessToken } = await createTrainerWithToken()
      const { studentId } = await createLinkedStudentForTrainer(accessToken)

      // First stream call: tool_use for get_student_performance
      anthropicStream.mockReturnValueOnce(
        makeAnthropicStreamMock({
          textChunks: [],
          stopReason: 'tool_use',
          toolUseBlocks: [
            {
              type: 'tool_use',
              id: 'tc-stream-perf-1',
              name: 'get_student_performance',
              input: { studentId },
            },
          ],
        }),
      )

      // Second stream call: analysis text in chunks
      anthropicStream.mockReturnValueOnce(
        makeAnthropicStreamMock({
          textChunks: ['O aluno completou ', '8 sessões com ', '80% de adesão.'],
          stopReason: 'end_turn',
        }),
      )

      const streamRes = await app.inject({
        method: 'POST',
        url: '/trainer/ai/chat/stream',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { message: 'Como está o desempenho do aluno?' },
      })

      expect(streamRes.statusCode).toBe(200)
      expect(streamRes.headers['content-type']).toMatch(/text\/event-stream/)

      const events = parseSseBody(streamRes.body)

      // Must have text_delta events from the second LLM call
      const textDeltas = events.filter((e) => e.event === 'text_delta')
      expect(textDeltas.length).toBeGreaterThan(0)

      const fullText = textDeltas.map((e) => e.data.content).join('')
      expect(fullText).toBe('O aluno completou 8 sessões com 80% de adesão.')

      // Must have a done event with the full analysis text
      const doneEvent = events.find((e) => e.event === 'done')
      expect(doneEvent).toBeDefined()
      expect(doneEvent.data.message).toBe('O aluno completou 8 sessões com 80% de adesão.')
      expect(doneEvent.data.actionsExecuted).toHaveLength(1)
      expect(doneEvent.data.actionsExecuted[0]).toMatchObject({
        tool: 'get_student_performance',
        success: true,
      })

      // Anthropic stream was called twice (tool then analysis)
      expect(anthropicStream).toHaveBeenCalledTimes(2)
    })
  })
})
