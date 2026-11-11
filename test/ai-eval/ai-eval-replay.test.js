// CI wiring check only: it replays a SCRIPTED model answer per case to prove the fixtures are valid and the engine
// executes (or withholds) the expected tool. It says nothing about how well the real model or prompt performs;
// that accuracy comes only from `npm run ai:eval`, which calls the real model.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findMany: vi.fn(), findUnique: vi.fn() },
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

vi.mock('../../src/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getLlmProvider: vi.fn(() => ({
    chat: mockChat,
    chatStream: vi.fn(),
    buildToolResultMessages: vi.fn((raw, results) => [
      { role: 'assistant', content: raw },
      { role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content })) },
    ]),
  })),
}))

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn().mockResolvedValue(undefined),
  recordAiAction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/student-dashboard-service.js', () => ({
  buildAiPerformanceSnapshot: vi.fn().mockResolvedValue({
    studentId: 'student-ana',
    studentName: 'Ana Lima',
    window: { days: 90 },
    sessionCounts: { completed: 10, in_progress: 0, abandoned: 1 },
    totalSessions: 11,
    topExercises: [],
  }),
}))
vi.mock('../../src/services/ai-interaction-log-service.js', () => ({
  writeInteractionLog: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '../../src/db.js'
import { processAiChat } from '../../src/services/ai-training-service.js'
import { buildSystemPrompt } from '../../src/services/ai-prompt.js'
import { TOOLS } from '../../src/services/ai-tool-definitions.js'
import { AI_TOOLS } from '../../src/constants/ai.js'
import {
  USER_ID,
  CONVERSATION_ID,
  stubTrainerContext,
  stubNewConversation,
  stubExistingConversation,
  flattenSystemPrompt,
} from '../helpers/ai-engine-fixtures.js'
import { loadEvalFixtures, matchesExpected, validateCases, isSubset, buildEvalMessages, contextForCase, buildEvalSystem, historyToRows } from './eval-lib.js'

const MIN_CASES = 15
const { context, cases } = loadEvalFixtures()

// Builds the normalized provider response a correct model would produce for a case.
function replayResponse({ replay }) {
  const toolCalls = replay.toolCall ? [{ id: 'tc-replay', ...replay.toolCall }] : []
  const toolUse = toolCalls.map((call) => ({ type: 'tool_use', ...call }))
  return {
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    text: replay.text,
    toolCalls,
    rawContent: [...(replay.text ? [{ type: 'text', text: replay.text }] : []), ...toolUse],
    usage: null,
  }
}

describe('iArnold eval fixtures', () => {
  it(`should contain at least ${MIN_CASES} cases`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES)
  })

  it('should follow the fixture schema and only reference real tools', () => {
    expect(validateCases(cases, TOOLS)).toEqual([])
  })

  it('should cover every tool-selection family and every non-tool outcome', () => {
    const kinds = new Set(cases.map((evalCase) => evalCase.expected.kind))
    ;['clarify', 'followup', 'no_tool', 'no_write', 'propose', 'read', 'tool'].forEach((kind) => expect(kinds).toContain(kind))
  })

  it('should cover both edit and create tools for students and for the library', () => {
    const tools = new Set(cases.flatMap((evalCase) => (evalCase.expected.tool ? [evalCase.expected.tool] : [])))
    const required = [
      AI_TOOLS.GET_STUDENT_PERFORMANCE,
      AI_TOOLS.SEARCH_EXERCISE_LIBRARY,
      AI_TOOLS.UPDATE_EXERCISE,
      AI_TOOLS.UPDATE_TRAINING,
      AI_TOOLS.UPDATE_PROTOCOL,
      AI_TOOLS.IMPORT_FROM_TEMPLATE,
      AI_TOOLS.ADD_EXERCISES_TO_TRAINING,
      AI_TOOLS.ADD_TRAINING_TO_PROTOCOL,
      AI_TOOLS.CREATE_EXERCISE_TEMPLATE,
      AI_TOOLS.CREATE_TRAINING_TEMPLATE,
      AI_TOOLS.CREATE_PROTOCOL_TEMPLATE,
      AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE,
      AI_TOOLS.UPDATE_EXERCISE_TEMPLATE,
    ]
    required.forEach((tool) => expect(tools).toContain(tool))
  })

  it('should reject a malformed case', () => {
    const broken = [{ id: 'x', history: [], message: 'Oi', expected: { kind: 'tool', tool: 'nope', args: {} }, replay: { text: '' } }]

    expect(validateCases(broken, TOOLS).length).toBeGreaterThan(0)
  })

  it('should render the shared context into a prompt that carries the ids the cases expect', () => {
    const prompt = buildSystemPrompt(context).map((block) => block.text).join('\n')

    expect(prompt).toContain('EXERCISE_REF:ex-supino-ana')
    expect(prompt).toContain('PROTOCOL_REF:pr-joao-b')
  })

  it('should wrap every user turn of a case as untrusted input', () => {
    const messages = buildEvalMessages(cases.find((evalCase) => evalCase.history.length > 0))

    messages.filter((m) => m.role === 'user').forEach((m) => expect(m.content).toMatch(/^<user_input>[\s\S]*<\/user_input>$/))
  })
})

describe('eval matcher', () => {
  const toolCase = cases.find((evalCase) => evalCase.id === 'edit-exercise-sets')

  it('should accept a superset of the expected args', () => {
    expect(isSubset({ a: 1, list: [{ x: 1 }] }, { a: 1, b: 2, list: [{ x: 1, y: 2 }] })).toBe(true)
  })

  it('should reject a different tool', () => {
    const verdict = matchesExpected(toolCase.expected, { toolCalls: [{ name: AI_TOOLS.CREATE_EXERCISE_TEMPLATE, input: {} }], text: '' })

    expect(verdict.pass).toBe(false)
  })

  it('should reject wrong args', () => {
    const verdict = matchesExpected(toolCase.expected, { toolCalls: [{ name: AI_TOOLS.UPDATE_EXERCISE, input: { exerciseId: 'ex-other', sets: 5 } }], text: '' })

    expect(verdict.pass).toBe(false)
  })

  it('should reject a tool call where a question was expected', () => {
    const clarify = cases.find((evalCase) => evalCase.expected.kind === 'clarify')

    expect(matchesExpected(clarify.expected, { toolCalls: [{ name: AI_TOOLS.UPDATE_EXERCISE, input: {} }], text: 'Qual?' }).pass).toBe(false)
  })

  it('should reject a clarification without a question', () => {
    const clarify = cases.find((evalCase) => evalCase.expected.kind === 'clarify')

    expect(matchesExpected(clarify.expected, { toolCalls: [], text: 'Feito.' }).pass).toBe(false)
  })
})

describe('replay through the turn engine (wiring only, not model accuracy)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    prisma.aiTokenUsage.create.mockResolvedValue({})
    prisma.trainerStudent.findUnique.mockResolvedValue({ studentId: 'student-ana' })
    stubTrainerContext(prisma, context)
  })

  it('should render the case-specific context and student focus into the prompt', () => {
    const large = cases.find((evalCase) => evalCase.context === 'context-large.json')
    const focused = cases.find((evalCase) => evalCase.studentFocus)

    expect(buildEvalSystem(large, context)[1].text).toContain('Lista truncada')
    expect(buildEvalSystem(focused, context)[1].text).toContain('ALUNO EM FOCO')
  })

  it('should feed a followup tool result back as a tool_result turn', () => {
    const followup = cases.find((evalCase) => evalCase.expected.kind === 'followup')
    const messages = buildEvalMessages(followup)

    expect(messages.at(-2).content[0]).toMatchObject({ type: 'tool_use', name: followup.toolCall.name })
    expect(messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: messages.at(-2).content[0].id })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(cases.map((evalCase) => [evalCase.id, evalCase]))('should route the scripted answer of %s through the engine as expected', async (_id, evalCase) => {
    stubTrainerContext(prisma, contextForCase(evalCase, context))
    const savedHistory = historyToRows(evalCase.history)
    if (savedHistory.length > 0) stubExistingConversation(prisma, { messages: savedHistory })
    else stubNewConversation(prisma)
    mockChat.mockResolvedValue(replayResponse(evalCase))

    const result = await processAiChat(USER_ID, {
      message: evalCase.message,
      ...(savedHistory.length > 0 && { conversationId: CONVERSATION_ID }),
    })

    if (evalCase.history.some((entry) => typeof entry.content !== 'string')) {
      expect(JSON.stringify(mockChat.mock.calls[0][0].messages)).toContain('"type":"tool_result"')
    }
    const sentPrompt = flattenSystemPrompt(mockChat.mock.calls[0][0].system)
    expect(sentPrompt).toContain('student-ana')
    const called = result.actionsExecuted.map((action) => ({ name: action.tool, input: evalCase.replay.toolCall?.input }))
    expect(matchesExpected(evalCase.expected, { toolCalls: called, text: result.message })).toMatchObject({ pass: true })
  })
})
