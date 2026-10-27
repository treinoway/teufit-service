import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('../../src/services/ai-interaction-log-service.js', () => ({
  writeInteractionLog: vi.fn().mockResolvedValue(undefined),
}))

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../../src/db.js'
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js'
import { importFromTemplate } from '../../src/services/training-protocol-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js'
import { AI_TOOLS } from '../../src/constants/ai.js'
import { USER_ID, CONVERSATION_ID, stubTrainerContext, stubExistingConversation } from '../helpers/ai-engine-fixtures.js'

const TOOL_CALL_ID = 'toolu_legacy_1'
const IMPORT_INPUT = { templateId: 'tmpl-1', assigneeId: 'student-1', startDate: '2026-11-01', expirationDate: '2026-12-27' }
const TOOL_USE_BLOCK = { type: 'tool_use', id: TOOL_CALL_ID, name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }
const TOOL_RESULT_RECORD = [{ toolCallId: TOOL_CALL_ID, content: '{"success":true,"name":"Protocolo A"}' }]

// Chronological history of a finished tool turn, in the order a correct writer would store it.
const CORRECT_TOOL_HISTORY = [
  { role: 'user', content: 'Crie o protocolo A para a Ana' },
  { role: 'assistant', content: 'Vou criar o protocolo A. Confirma?' },
  { role: 'user', content: 'Sim, pode criar' },
  { role: 'assistant', content: 'Criando...', rawContent: [{ type: 'text', text: 'Criando...' }, TOOL_USE_BLOCK] },
  { role: 'tool_result', content: TOOL_RESULT_RECORD[0].content, rawContent: TOOL_RESULT_RECORD },
  { role: 'assistant', content: 'Protocolo "Protocolo A" criado com sucesso!' },
]

// The same turn as the legacy writer stored it: parallel inserts let tool_result sort before its assistant.
const LEGACY_TOOL_HISTORY = [
  CORRECT_TOOL_HISTORY[0],
  CORRECT_TOOL_HISTORY[1],
  CORRECT_TOOL_HISTORY[2],
  CORRECT_TOOL_HISTORY[4],
  CORRECT_TOOL_HISTORY[3],
  CORRECT_TOOL_HISTORY[5],
]

// Asserts every tool_use is answered by the very next message and no tool_result is orphaned.
function expectValidToolPairing(messages) {
  messages.forEach((message, index) => {
    const blocks = Array.isArray(message.content) ? message.content : []
    const toolUseIds = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id)
    if (message.role === 'assistant' && toolUseIds.length > 0) {
      const next = messages[index + 1]
      const answeredIds = (Array.isArray(next?.content) ? next.content : [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => b.tool_use_id)
      expect(next?.role).toBe('user')
      expect(answeredIds).toEqual(toolUseIds)
    }
    const resultIds = blocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)
    if (resultIds.length > 0) {
      const previous = messages[index - 1]
      const requestedIds = (Array.isArray(previous?.content) ? previous.content : [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => b.id)
      expect(previous?.role).toBe('assistant')
      expect(resultIds).toEqual(requestedIds)
    }
  })
}

// Asserts consecutive messages always alternate roles (Anthropic rejects repeats).
function expectAlternatingRoles(messages) {
  const roles = messages.map((m) => m.role)
  roles.forEach((role, index) => {
    if (index > 0) expect(role).not.toBe(roles[index - 1])
  })
}

beforeEach(() => {
  Anthropic.mockImplementation(function () {
    this.messages = { create: anthropicCreate, stream: anthropicStream }
  })
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  writeInteractionLog.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  stubTrainerContext(prisma)
})

describe('tool turn persistence order (AC 8)', () => {
  beforeEach(() => {
    stubExistingConversation(prisma, { messages: CORRECT_TOOL_HISTORY.slice(0, 2) })
    importFromTemplate.mockResolvedValue({ id: 'protocol-9', name: 'Protocolo A' })
    anthropicCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Criando...' }, TOOL_USE_BLOCK],
    })
  })

  async function runTurnHoldingAssistantInsert() {
    const startedWhileAssistantPending = []
    let releaseAssistant
    const assistantHold = new Promise((resolve) => { releaseAssistant = resolve })
    let assistantToolUseHeld = false

    prisma.aiMessage.create.mockImplementation(async ({ data }) => {
      const isToolUseAssistant = data.role === 'assistant' && data.rawContent
      if (isToolUseAssistant) {
        assistantToolUseHeld = true
        await assistantHold
        assistantToolUseHeld = false
      } else if (assistantToolUseHeld) {
        startedWhileAssistantPending.push({ role: data.role, createdAt: data.createdAt })
      }
      return { id: 'msg' }
    })

    const turn = processAiChat(USER_ID, { message: 'Sim, pode criar', conversationId: CONVERSATION_ID })
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseAssistant()
    await turn
    return startedWhileAssistantPending
  }

  it('should not start the tool_result insert before the assistant tool_use insert has finished', async () => {
    const startedEarly = await runTurnHoldingAssistantInsert()

    const unorderedToolResult = startedEarly.find((write) => write.role === 'tool_result' && !write.createdAt)
    expect(unorderedToolResult).toBeUndefined()
  })

  it('should insert the assistant tool_use row before the tool_result row', async () => {
    await runTurnHoldingAssistantInsert()

    const savedRoles = prisma.aiMessage.create.mock.calls.map(([arg]) => arg.data.role)
    expect(savedRoles.indexOf('assistant')).toBeLessThan(savedRoles.indexOf('tool_result'))
  })

  it('should insert tool_result before the final assistant text', async () => {
    await runTurnHoldingAssistantInsert()

    const savedRoles = prisma.aiMessage.create.mock.calls.map(([arg]) => arg.data.role)
    expect(savedRoles.indexOf('tool_result')).toBeLessThan(savedRoles.lastIndexOf('assistant'))
  })

  it('should persist tool turns in the same order when streaming', async () => {
    anthropicStream.mockReturnValueOnce({
      [Symbol.asyncIterator]: async function* () {},
      finalMessage: async () => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'Criando...' }, TOOL_USE_BLOCK] }),
    })
    const startedWhileHeld = []
    let releaseAssistant
    const assistantHold = new Promise((resolve) => { releaseAssistant = resolve })
    let held = false
    prisma.aiMessage.create.mockImplementation(async ({ data }) => {
      if (data.role === 'assistant' && data.rawContent) {
        held = true
        await assistantHold
        held = false
      } else if (held) {
        startedWhileHeld.push({ role: data.role, createdAt: data.createdAt })
      }
      return { id: 'msg' }
    })

    const turn = (async () => {
      for await (const event of processAiChatStream(USER_ID, { message: 'Sim, pode criar', conversationId: CONVERSATION_ID })) {
        void event
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseAssistant()
    await turn

    expect(startedWhileHeld.find((write) => write.role === 'tool_result' && !write.createdAt)).toBeUndefined()
  })
})

describe('legacy conversations saved in the buggy order (AC 8)', () => {
  beforeEach(() => {
    stubExistingConversation(prisma, { messages: LEGACY_TOOL_HISTORY })
    anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'De nada!' }] })
  })

  it('should replay the tool turn as assistant(tool_use) followed by user(tool_result)', async () => {
    await processAiChat(USER_ID, { message: 'Obrigado', conversationId: CONVERSATION_ID })

    expectValidToolPairing(anthropicCreate.mock.calls[0][0].messages)
  })

  it('should keep roles alternating so the provider does not reject the request', async () => {
    await processAiChat(USER_ID, { message: 'Obrigado', conversationId: CONVERSATION_ID })

    expectAlternatingRoles(anthropicCreate.mock.calls[0][0].messages)
  })

  it('should not turn the tool_result record into plain text in the history', async () => {
    await processAiChat(USER_ID, { message: 'Obrigado', conversationId: CONVERSATION_ID })

    const sent = JSON.stringify(anthropicCreate.mock.calls[0][0].messages)
    expect(sent).not.toContain('"role":"tool_result"')
  })

  it('should complete the turn instead of failing on the legacy ordering', async () => {
    const result = await processAiChat(USER_ID, { message: 'Obrigado', conversationId: CONVERSATION_ID })

    expect(result.message).toBe('De nada!')
  })

  it('should replay a correctly ordered tool turn with the same valid pairing', async () => {
    stubExistingConversation(prisma, { messages: CORRECT_TOOL_HISTORY })

    await processAiChat(USER_ID, { message: 'Obrigado', conversationId: CONVERSATION_ID })

    expectValidToolPairing(anthropicCreate.mock.calls[0][0].messages)
  })
})
