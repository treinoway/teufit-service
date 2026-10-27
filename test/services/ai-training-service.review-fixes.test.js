import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findMany: vi.fn(), findUnique: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
    trainingProtocol: { findMany: vi.fn(), findFirst: vi.fn() },
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

vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
  updateProtocol: vi.fn(),
}))
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn(),
  recordAiAction: vi.fn(),
}))
vi.mock('../../src/services/student-dashboard-service.js', () => ({
  buildAiPerformanceSnapshot: vi.fn(),
}))
vi.mock('../../src/services/ai-interaction-log-service.js', () => ({
  writeInteractionLog: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '../../src/db.js'
import { executeTool, processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { importFromTemplate } from '../../src/services/training-protocol-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { AI_TOOLS, AI_ERRORS, AI_MESSAGE_CODES } from '../../src/constants/ai.js'
import ptBR from '../../src/i18n/locales/pt-BR.js'
import enUS from '../../src/i18n/locales/en-US.js'
import {
  USER_ID,
  STUDENT_ID,
  CONVERSATION_ID,
  PRIOR_EXCHANGE,
  textResponse,
  toolResponse,
  streamOf,
  drain,
  stubTrainerContext,
  stubNewConversation,
  stubExistingConversation,
} from '../helpers/ai-engine-fixtures.js'

const IMPORT_INPUT = { templateId: 'tmpl-1', assigneeId: STUDENT_ID, startDate: '2026-11-01', expirationDate: '2026-12-27' }
const PERFORMANCE_INPUT = { studentId: STUDENT_ID }

// Builds a provider response that asks for several tool calls at once.
function parallelToolResponse(calls) {
  const toolUses = calls.map(({ name, input }, index) => ({ type: 'tool_use', id: `tc-${index}`, name, input }))
  return {
    stopReason: 'tool_use',
    text: 'Vou fazer tudo.',
    toolCalls: toolUses.map(({ id, name, input }) => ({ id, name, input })),
    rawContent: [{ type: 'text', text: 'Vou fazer tudo.' }, ...toolUses],
    usage: null,
  }
}

// Lists the roles of every message saved during the test.
function savedRoles() {
  return prisma.aiMessage.create.mock.calls.map(([arg]) => arg.data.role)
}

beforeEach(() => {
  vi.clearAllMocks()
  assertCanUseAi.mockReset()
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  prisma.trainerStudent.findUnique.mockResolvedValue({ studentId: STUDENT_ID })
  buildAiPerformanceSnapshot.mockResolvedValue({ studentName: 'Ana Lima', sessionCounts: { completed: 2 }, totalSessions: 2 })
  mockChat.mockResolvedValue(textResponse('Ok'))
  mockChatStream.mockImplementation(streamOf(textResponse('Ok')))
  stubTrainerContext(prisma)
  stubNewConversation(prisma)
})

describe('parallel tool calls never reach execution (B1)', () => {
  const CASES = [
    ['read + read', [{ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT }, { name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT }]],
    ['read + write', [{ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT }, { name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }]],
    ['write + read', [{ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }, { name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT }]],
  ]

  describe.each([
    ['first turn', () => stubNewConversation(prisma), {}],
    ['later turn', () => stubExistingConversation(prisma), { conversationId: CONVERSATION_ID }],
  ])('on the %s', (_label, stub, extraArgs) => {
    beforeEach(() => {
      stub()
    })

    it.each(CASES)('should answer "one action at a time" for %s and execute nothing', async (_name, calls) => {
      mockChat.mockResolvedValue(parallelToolResponse(calls))

      const result = await processAiChat(USER_ID, { message: 'Sim, pode fazer', ...extraArgs })

      expect(result.actionsExecuted).toEqual([])
      expect(result.message).toMatch(/uma ação por vez/)
      expect(importFromTemplate).not.toHaveBeenCalled()
      expect(buildAiPerformanceSnapshot).not.toHaveBeenCalled()
    })

    it.each(CASES)('should not persist the unanswered tool_use blocks for %s', async (_name, calls) => {
      mockChat.mockResolvedValue(parallelToolResponse(calls))

      await processAiChat(USER_ID, { message: 'Sim, pode fazer', ...extraArgs })

      expect(savedRoles()).not.toContain('tool_result')
      const assistantSaves = prisma.aiMessage.create.mock.calls.filter(([arg]) => arg.data.role === 'assistant')
      assistantSaves.forEach(([arg]) => expect(arg.data.rawContent).toBeUndefined())
    })
  })

  it('should block parallel calls in streamed turns too', async () => {
    mockChatStream.mockImplementationOnce(streamOf(parallelToolResponse(CASES[1][1])))

    const events = await drain(processAiChatStream(USER_ID, { message: 'Como vai a Ana?' }))

    expect(events.at(-1).data.actionsExecuted).toEqual([])
    expect(buildAiPerformanceSnapshot).not.toHaveBeenCalled()
  })
})

describe('history rebuild repairs tool turns that lack results (B1)', () => {
  const TOOL_USES = [
    { type: 'tool_use', id: 'tc-a', name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT },
    { type: 'tool_use', id: 'tc-b', name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT },
  ]
  const BROKEN_HISTORY = [
    ...PRIOR_EXCHANGE,
    { role: 'assistant', content: 'Consultando...', rawContent: TOOL_USES },
    { role: 'tool_result', content: '{"success":true}', rawContent: [{ toolCallId: 'tc-a', content: '{"success":true}' }] },
    { role: 'assistant', content: 'Pronto.' },
  ]

  it('should answer every tool_use id of a saved assistant turn, in order', async () => {
    stubExistingConversation(prisma, { messages: BROKEN_HISTORY })

    await processAiChat(USER_ID, { message: 'Obrigado', conversationId: CONVERSATION_ID })

    const sent = mockChat.mock.calls[0][0].messages
    const toolResultTurn = sent.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
    expect(toolResultTurn.content.map((b) => b.tool_use_id)).toEqual(['tc-a', 'tc-b'])
  })

  it('should mark the synthesized result as not executed', async () => {
    stubExistingConversation(prisma, { messages: BROKEN_HISTORY })

    await processAiChat(USER_ID, { message: 'Obrigado', conversationId: CONVERSATION_ID })

    const sent = mockChat.mock.calls[0][0].messages
    const toolResultTurn = sent.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
    expect(JSON.parse(toolResultTurn.content[1].content)).toMatchObject({ success: false, error: 'ONE_ACTION_PER_TURN' })
  })

  it('should keep a complete tool turn untouched', async () => {
    const complete = [
      ...PRIOR_EXCHANGE,
      { role: 'assistant', content: 'Consultando...', rawContent: [TOOL_USES[0]] },
      { role: 'tool_result', content: '{"success":true}', rawContent: [{ toolCallId: 'tc-a', content: 'RESULT-A' }] },
      { role: 'assistant', content: 'Pronto.' },
    ]
    stubExistingConversation(prisma, { messages: complete })

    await processAiChat(USER_ID, { message: 'Obrigado', conversationId: CONVERSATION_ID })

    const sent = mockChat.mock.calls[0][0].messages
    const toolResultTurn = sent.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
    expect(toolResultTurn.content).toEqual([{ type: 'tool_result', tool_use_id: 'tc-a', content: 'RESULT-A' }])
  })
})

describe('confirmation needs the assistant to have asked (S4)', () => {
  beforeEach(() => {
    mockChat.mockResolvedValue(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }))
  })

  it('should block "sim" when the last assistant message did not ask for confirmation', async () => {
    stubExistingConversation(prisma, {
      messages: [
        { role: 'user', content: 'Quais modelos eu tenho?' },
        { role: 'assistant', content: 'Você tem os modelos Full Body e ABC.' },
      ],
    })

    const result = await processAiChat(USER_ID, { message: 'sim', conversationId: CONVERSATION_ID })

    expect(importFromTemplate).not.toHaveBeenCalled()
    expect(result.message).toMatch(/confirm/i)
  })

  it('should run the tool when the assistant asked and the trainer said "fechado"', async () => {
    importFromTemplate.mockResolvedValue({ id: 'p-1', name: 'Protocolo A' })
    stubExistingConversation(prisma)

    await processAiChat(USER_ID, { message: 'fechado', conversationId: CONVERSATION_ID })

    expect(importFromTemplate).toHaveBeenCalledTimes(1)
  })

  it.each(['faz o B em vez disso', 'pode trocar por crucifixo'])('should block the substitution "%s" even though it sounds affirmative', async (message) => {
    stubExistingConversation(prisma)

    await processAiChat(USER_ID, { message, conversationId: CONVERSATION_ID })

    expect(importFromTemplate).not.toHaveBeenCalled()
  })
})

describe('tool failure logs carry no PII (S5)', () => {
  const PRISMA_MESSAGE = 'Invalid `prisma.user.findUnique()` invocation: Argument email: "ana@segredo.com" is invalid'

  it('should log only the error name, code and meta keys for an unexpected failure', async () => {
    const failure = Object.assign(new Error(PRISMA_MESSAGE), { name: 'PrismaClientValidationError', code: 'P2007', meta: { target: ['email'] } })
    importFromTemplate.mockRejectedValue(failure)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {})

    await executeTool(USER_ID, AI_TOOLS.IMPORT_FROM_TEMPLATE, IMPORT_INPUT)

    const everything = JSON.stringify([errorLog.mock.calls, infoLog.mock.calls])
    expect(everything).not.toContain('ana@segredo.com')
    expect(everything).not.toContain('invocation')
    expect(errorLog.mock.calls[0][1]).toEqual({ name: 'PrismaClientValidationError', code: 'P2007', metaKeys: ['target'] })
  })

  it('should not put the student lookup error message in the logs', async () => {
    stubExistingConversation(prisma)
    prisma.trainingProtocol.findFirst.mockRejectedValue(new Error(PRISMA_MESSAGE))
    mockChat.mockResolvedValue(toolResponse({ name: AI_TOOLS.UPDATE_PROTOCOL, input: { protocolId: 'pr-1', name: 'Novo' } }))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})

    await processAiChat(USER_ID, { message: 'Sim, pode fazer', conversationId: CONVERSATION_ID })

    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('ana@segredo.com')
  })
})

describe('performance fallback date uses the trainer timezone (nit)', () => {
  it('should render a late-evening session on the Sao Paulo calendar day', async () => {
    buildAiPerformanceSnapshot.mockResolvedValue({
      studentName: 'Ana Lima',
      window: { days: 30 },
      sessionCounts: { completed: 1 },
      totalSessions: 1,
      lastSessionAt: '2026-10-27T01:30:00.000Z',
      topExercises: [],
    })
    mockChatStream
      .mockImplementationOnce(streamOf(toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT })))
      .mockImplementationOnce(async function* () { throw Object.assign(new Error('bad'), { status: 400 }) })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const events = await drain(processAiChatStream(USER_ID, { message: 'Como vai a Ana?' }))

    expect(events.find((event) => event.event === 'done').data.message).toContain('26/10/2026')
  })
})

describe('provider timeout (nit)', () => {
  it('should map a timed-out model call to a translated 504 instead of a generic 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockChat.mockRejectedValue(Object.assign(new Error('Request timed out.'), { timedOut: true }))

    await expect(processAiChat(USER_ID, { message: 'Oi' })).rejects.toMatchObject({
      httpStatus: 504,
      error: AI_ERRORS.TIMEOUT,
      messageCode: AI_MESSAGE_CODES.TIMEOUT,
    })
  })

  it('should have the timeout message in both locales', () => {
    expect(ptBR.errors['ai.timeout']).toMatch(/demorou/)
    expect(enUS.errors['ai.timeout']).toMatch(/too long/)
  })
})

describe('failed turns tell the client which conversation to retry in', () => {
  it('should attach the new conversation id to details when the model fails on a first turn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockChat.mockRejectedValue(Object.assign(new Error('boom'), { status: 400 }))

    const error = await processAiChat(USER_ID, { message: 'Oi' }).catch((err) => err)

    expect(error.details).toEqual({ conversationId: CONVERSATION_ID })
    expect(error.conversationId).toBe(CONVERSATION_ID)
  })

  it('should keep the existing details next to the conversation id', async () => {
    stubExistingConversation(prisma)
    mockChat.mockResolvedValue(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }))
    const { AppError } = await import('../../src/errors/app-error.js')
    assertCanUseAi.mockImplementation(async (_prisma, _trainerId, studentId) => {
      if (studentId === STUDENT_ID) {
        throw new AppError({ httpStatus: 403, error: 'AI_ACTIONS_EXCEEDED', messageCode: 'platformPlan.aiActionsExceeded', message: 'x', details: { scope: 'student' } })
      }
    })

    const error = await processAiChat(USER_ID, { message: 'Sim, pode fazer', conversationId: CONVERSATION_ID }).catch((err) => err)

    expect(error.details).toEqual({ scope: 'student', conversationId: CONVERSATION_ID })
  })

  it('should not attach a conversation id to refusals that happen before setup', async () => {
    assertCanUseAi.mockRejectedValue(Object.assign(new Error('plan'), { httpStatus: 403 }))

    const error = await processAiChat(USER_ID, { message: 'Oi' }).catch((err) => err)

    expect(error.conversationId).toBeUndefined()
    expect(prisma.aiConversation.create).not.toHaveBeenCalled()
  })

  it('should carry the conversation id on streamed failures too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockChatStream.mockImplementationOnce(async function* () { throw Object.assign(new Error('boom'), { status: 400 }) })

    const error = await drain(processAiChatStream(USER_ID, { message: 'Oi' })).catch((err) => err)

    expect(error.conversationId).toBe(CONVERSATION_ID)
  })
})

describe('retrying an unanswered message (orphan conversations)', () => {
  const UNANSWERED = [{ role: 'user', content: 'Oi, tudo bem?' }]

  it('should not save the same user message twice', async () => {
    stubExistingConversation(prisma, { messages: UNANSWERED })

    await processAiChat(USER_ID, { message: 'Oi, tudo bem?', conversationId: CONVERSATION_ID })

    expect(savedRoles()).not.toContain('user')
  })

  it('should send the message to the model exactly once', async () => {
    stubExistingConversation(prisma, { messages: UNANSWERED })

    await processAiChat(USER_ID, { message: 'Oi, tudo bem?', conversationId: CONVERSATION_ID })

    const userTurns = mockChat.mock.calls[0][0].messages.filter((m) => m.role === 'user')
    expect(userTurns).toHaveLength(1)
  })

  it('should still save a different message after an unanswered one', async () => {
    stubExistingConversation(prisma, { messages: UNANSWERED })

    await processAiChat(USER_ID, { message: 'Outra coisa', conversationId: CONVERSATION_ID })

    expect(savedRoles()).toContain('user')
  })

  it('should still save the message when the same text was already answered', async () => {
    stubExistingConversation(prisma, { messages: [{ role: 'user', content: 'Oi' }, { role: 'assistant', content: 'Olá!' }] })

    await processAiChat(USER_ID, { message: 'Oi', conversationId: CONVERSATION_ID })

    expect(savedRoles()).toContain('user')
  })

  it('should title a conversation that never got a title on its first attempt', async () => {
    prisma.aiConversation.findUnique.mockResolvedValue({
      id: CONVERSATION_ID,
      userId: USER_ID,
      title: null,
      messages: [{ role: 'user', content: 'Oi, tudo bem?' }],
    })
    prisma.aiMessage.create.mockResolvedValue({ id: 'm' })
    prisma.aiConversation.update.mockResolvedValue({})

    await processAiChat(USER_ID, { message: 'Oi, tudo bem?', conversationId: CONVERSATION_ID })

    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Oi, tudo bem?' }) }),
    )
  })
})

describe('progress texts follow the request language', () => {
  async function statusMessages(language, extra = {}) {
    const events = await drain(processAiChatStream(USER_ID, { message: 'Como vai a Ana?', ...extra }, { language }))
    return events.filter((event) => event.event === 'status').map((event) => event.data.message)
  }

  it('should say "Analisando seu pedido..." in pt-BR by default', async () => {
    expect(await statusMessages(undefined)).toContain('Analisando seu pedido...')
  })

  it('should say "Analyzing your request..." in en-US', async () => {
    expect(await statusMessages('en-US')).toContain('Analyzing your request...')
  })

  it.each([
    ['pt-BR', 'Consultando desempenho do aluno...'],
    ['en-US', 'Checking student performance...'],
  ])('should translate the tool progress text in %s', async (language, expected) => {
    mockChatStream
      .mockImplementationOnce(streamOf(toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: PERFORMANCE_INPUT })))
      .mockImplementationOnce(streamOf(textResponse('A Ana treinou 2 vezes.')))

    expect(await statusMessages(language)).toContain(expected)
  })

  it('should have a progress text for every tool in both locales', () => {
    Object.values(AI_TOOLS).forEach((tool) => {
      expect(ptBR.ai.toolStatus[tool]).toEqual(expect.any(String))
      expect(enUS.ai.toolStatus[tool]).toEqual(expect.any(String))
    })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
