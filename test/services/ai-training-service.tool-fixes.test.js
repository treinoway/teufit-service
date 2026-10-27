import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findMany: vi.fn() },
    trainingProtocol: { findUnique: vi.fn(), findMany: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn(), create: vi.fn() },
    trainingTemplate: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    exerciseTemplate: { findMany: vi.fn(), create: vi.fn() },
    training: { findUnique: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
    exercise: { create: vi.fn(), aggregate: vi.fn() },
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
}))
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn().mockResolvedValue(undefined),
  recordAiAction: vi.fn().mockResolvedValue(undefined),
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
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js'
import { AI_TOOLS } from '../../src/constants/ai.js'
import { TrainingCategory, ExerciseType, WeekDays } from '../../src/constants/training.js'
import {
  USER_ID,
  TRAINER_ID,
  STUDENT_ID,
  CONVERSATION_ID,
  toolResponse,
  textResponse,
  streamOf,
  drain,
  stubTrainerContext,
  stubExistingConversation,
  stubNewConversation,
} from '../helpers/ai-engine-fixtures.js'

const TRAINING_ID = 'training-1'
const PROTOCOL_ID = 'protocol-1'
const CONFIRMATION = 'Sim, pode fazer'
const LISTED_EXERCISES_MESSAGE = 'Vou adicionar:\n- Supino reto 4x10\n- Crucifixo 3x12\nConfirma?'
const INVALID_UUID_PRISMA_MESSAGE = 'Invalid `prisma.trainingProtocol.findUnique()` invocation: Inconsistent column data: Error creating UUID'

const REQUEST_HISTORY_WITH_LISTED_EXERCISES = [
  { role: 'user', content: 'Adicione supino e crucifixo ao treino de peito' },
  { role: 'assistant', content: LISTED_EXERCISES_MESSAGE },
]

const TWO_EXERCISES = [
  { name: 'Supino reto', type: ExerciseType.STRENGTH, sets: 4, repetitions: { min: 10, max: 10 }, restInterval: 60 },
  { name: 'Crucifixo', type: ExerciseType.STRENGTH, sets: 3, repetitions: { min: 12, max: 12 }, restInterval: 60 },
]

// Echoes created rows back so the tool result carries real exercise data.
function echoCreate() {
  return async ({ data }) => ({ id: `row-${data.name}`, ...data })
}

// Stubs the reads add_exercises_to_training performs before its transaction.
function stubOwnedTraining() {
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID })
  prisma.training.findUnique.mockResolvedValue({
    id: TRAINING_ID,
    deletedAt: null,
    trainingProtocol: { trainerId: TRAINER_ID },
  })
}

// Stubs the reads add_training_to_protocol performs before its transaction.
function stubOwnedProtocol() {
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID })
  prisma.trainingProtocol.findUnique.mockResolvedValue({ id: PROTOCOL_ID, trainerId: TRAINER_ID, deletedAt: null })
}

beforeEach(() => {
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  writeInteractionLog.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma))
  prisma.exercise.create.mockImplementation(echoCreate())
  prisma.training.create.mockImplementation(async ({ data }) => ({ id: `training-${data.name}`, ...data }))
  stubTrainerContext(prisma)
  stubNewConversation(prisma)
})

describe('exercise and training order on append (AC 9)', () => {
  describe(AI_TOOLS.ADD_EXERCISES_TO_TRAINING, () => {
    beforeEach(() => {
      stubOwnedTraining()
    })

    it('should append new exercises after the highest existing order', async () => {
      prisma.exercise.aggregate.mockResolvedValue({ _max: { order: 4 } })

      await executeTool(USER_ID, AI_TOOLS.ADD_EXERCISES_TO_TRAINING, { trainingId: TRAINING_ID, exercises: TWO_EXERCISES })

      const orders = prisma.exercise.create.mock.calls.map(([arg]) => arg.data.order)
      expect(orders).toEqual([5, 6])
    })

    it('should start at order 0 when the training has no exercises yet', async () => {
      prisma.exercise.aggregate.mockResolvedValue({ _max: { order: null } })

      await executeTool(USER_ID, AI_TOOLS.ADD_EXERCISES_TO_TRAINING, { trainingId: TRAINING_ID, exercises: TWO_EXERCISES })

      const orders = prisma.exercise.create.mock.calls.map(([arg]) => arg.data.order)
      expect(orders).toEqual([0, 1])
    })

    it('should compute the max order only over non-deleted exercises of that training', async () => {
      prisma.exercise.aggregate.mockResolvedValue({ _max: { order: 1 } })

      await executeTool(USER_ID, AI_TOOLS.ADD_EXERCISES_TO_TRAINING, { trainingId: TRAINING_ID, exercises: TWO_EXERCISES })

      expect(prisma.exercise.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ trainingId: TRAINING_ID, deletedAt: null }),
          _max: { order: true },
        }),
      )
    })
  })

  describe(AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, () => {
    const TWO_TRAININGS = [
      { name: 'Treino C', category: TrainingCategory.STRENGTH, weekDay: WeekDays.WEDNESDAY },
      { name: 'Treino D', category: TrainingCategory.STRENGTH, weekDay: WeekDays.FRIDAY },
    ]

    beforeEach(() => {
      stubOwnedProtocol()
    })

    it('should append new trainings after the highest existing training order of the protocol', async () => {
      prisma.training.aggregate.mockResolvedValue({ _max: { order: 2 } })

      await executeTool(USER_ID, AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, { protocolId: PROTOCOL_ID, trainings: TWO_TRAININGS })

      const orders = prisma.training.create.mock.calls.map(([arg]) => arg.data.order)
      expect(orders).toEqual([3, 4])
    })

    it('should start trainings at order 0 when the protocol has none yet', async () => {
      prisma.training.aggregate.mockResolvedValue({ _max: { order: null } })

      await executeTool(USER_ID, AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, { protocolId: PROTOCOL_ID, trainings: TWO_TRAININGS })

      const orders = prisma.training.create.mock.calls.map(([arg]) => arg.data.order)
      expect(orders).toEqual([0, 1])
    })

    it('should compute the max order only over non-deleted trainings of that protocol', async () => {
      prisma.training.aggregate.mockResolvedValue({ _max: { order: 0 } })

      await executeTool(USER_ID, AI_TOOLS.ADD_TRAINING_TO_PROTOCOL, { protocolId: PROTOCOL_ID, trainings: TWO_TRAININGS })

      expect(prisma.training.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ trainingProtocolId: PROTOCOL_ID, deletedAt: null }),
          _max: { order: true },
        }),
      )
    })
  })
})

describe('missing-exercises warning (AC 10)', () => {
  beforeEach(() => {
    stubExistingConversation(prisma, { messages: REQUEST_HISTORY_WITH_LISTED_EXERCISES })
  })

  it('should not warn about missing exercises after add_exercises_to_training succeeded', async () => {
    stubOwnedTraining()
    prisma.exercise.aggregate.mockResolvedValue({ _max: { order: 0 } })
    mockChat.mockResolvedValue(toolResponse({
      name: AI_TOOLS.ADD_EXERCISES_TO_TRAINING,
      input: { trainingId: TRAINING_ID, exercises: TWO_EXERCISES },
    }))

    const result = await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    expect(result.message).not.toContain('não foram incluídos')
  })

  it('should report how many exercises were added after add_exercises_to_training succeeded', async () => {
    stubOwnedTraining()
    prisma.exercise.aggregate.mockResolvedValue({ _max: { order: 0 } })
    mockChat.mockResolvedValue(toolResponse({
      name: AI_TOOLS.ADD_EXERCISES_TO_TRAINING,
      input: { trainingId: TRAINING_ID, exercises: TWO_EXERCISES },
    }))

    const result = await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    expect(result.message).toContain('2 exercício(s) adicionado(s)')
  })

  it('should warn when add_training_to_protocol creates a training without the exercises the assistant promised', async () => {
    stubOwnedProtocol()
    prisma.training.aggregate.mockResolvedValue({ _max: { order: 0 } })
    mockChat.mockResolvedValue(toolResponse({
      name: AI_TOOLS.ADD_TRAINING_TO_PROTOCOL,
      input: { protocolId: PROTOCOL_ID, trainings: [{ name: 'Peito', category: TrainingCategory.STRENGTH }] },
    }))

    const result = await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    expect(result.message).toContain('não foram incluídos')
  })

  it('should not warn when add_training_to_protocol includes the exercises', async () => {
    stubOwnedProtocol()
    prisma.training.aggregate.mockResolvedValue({ _max: { order: 0 } })
    mockChat.mockResolvedValue(toolResponse({
      name: AI_TOOLS.ADD_TRAINING_TO_PROTOCOL,
      input: {
        protocolId: PROTOCOL_ID,
        trainings: [{ name: 'Peito', category: TrainingCategory.STRENGTH, exercises: TWO_EXERCISES }],
      },
    }))

    const result = await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    expect(result.message).not.toContain('não foram incluídos')
  })
})

describe('nested [REF:...] unwrapping (AC 11)', () => {
  beforeEach(() => {
    prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID })
    prisma.trainingProtocolTemplate.create.mockImplementation(async ({ data }) => ({ id: 'pt-1', name: data.name, type: null, trainings: [] }))
  })

  it('should unwrap trainings[].trainingTemplateId before the ownership check', async () => {
    prisma.trainingTemplate.findFirst.mockImplementation(async ({ where }) => (where.id === 'tt-1' ? { id: 'tt-1' } : null))

    const result = await executeTool(USER_ID, AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, {
      name: 'Rotina ABC',
      trainings: [{ trainingTemplateId: '[REF:tt-1]', weekDay: WeekDays.MONDAY }],
    })

    expect(result).toMatchObject({ success: true })
  })

  it('should unwrap trainings[].exerciseTemplateIds before the ownership check', async () => {
    prisma.exerciseTemplate.findMany.mockImplementation(async ({ where }) =>
      where.id.in.every((id) => id === 'ex-1') ? [{ id: 'ex-1', name: 'Supino', type: ExerciseType.STRENGTH }] : [])
    prisma.trainingTemplate.create.mockResolvedValue({ id: 'tt-new' })

    const result = await executeTool(USER_ID, AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, {
      name: 'Rotina ABC',
      trainings: [{ name: 'Treino A', category: TrainingCategory.STRENGTH, exerciseTemplateIds: ['[REF:ex-1]'] }],
    })

    expect(result).toMatchObject({ success: true })
  })

  it('should still reject a nested trainingTemplateId that the trainer does not own', async () => {
    prisma.trainingTemplate.findFirst.mockResolvedValue(null)

    const result = await executeTool(USER_ID, AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, {
      name: 'Rotina ABC',
      trainings: [{ trainingTemplateId: '[REF:tt-foreign]' }],
    })

    expect(result).toMatchObject({ success: false })
  })

  it('should unwrap an id nested two levels deep', async () => {
    prisma.trainingTemplate.findFirst.mockImplementation(async ({ where }) => (where.id === 'tt-2' ? { id: 'tt-2' } : null))

    const result = await executeTool(USER_ID, AI_TOOLS.CREATE_PROTOCOL_TEMPLATE, {
      name: 'Rotina ABC',
      trainings: [{ trainingTemplateId: ' [TRAINING_TEMPLATE_REF:tt-2] ' }],
    })

    expect(result).toMatchObject({ success: true })
  })
})

describe('non-AppError tool failures (AC 12)', () => {
  const prismaFailure = () => new Error(INVALID_UUID_PRISMA_MESSAGE)
  const IMPORT_INPUT = { templateId: 'bad-id', assigneeId: STUDENT_ID, startDate: '2026-11-01', expirationDate: '2026-12-27' }

  it('should return success:false instead of throwing when a tool throws an unexpected error', async () => {
    importFromTemplate.mockRejectedValue(prismaFailure())
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await executeTool(USER_ID, AI_TOOLS.IMPORT_FROM_TEMPLATE, IMPORT_INPUT)

    expect(result).toMatchObject({ success: false, error: expect.any(String) })
  })

  it('should not leak the internal error text to the model', async () => {
    importFromTemplate.mockRejectedValue(prismaFailure())
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await executeTool(USER_ID, AI_TOOLS.IMPORT_FROM_TEMPLATE, IMPORT_INPUT)

    expect(JSON.stringify(result)).not.toMatch(/prisma|UUID|invocation/i)
  })

  it('should log the unexpected error', async () => {
    importFromTemplate.mockRejectedValue(prismaFailure())
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await executeTool(USER_ID, AI_TOOLS.IMPORT_FROM_TEMPLATE, IMPORT_INPUT)

    expect(logged).toHaveBeenCalled()
  })

  it('should complete the turn with an assistant reply when the tool throws unexpectedly', async () => {
    stubExistingConversation(prisma)
    importFromTemplate.mockRejectedValue(prismaFailure())
    mockChat.mockResolvedValue(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    expect(result.actionsExecuted[0]).toMatchObject({ tool: AI_TOOLS.IMPORT_FROM_TEMPLATE, success: false })
    expect(result.message).toBeTruthy()
  })

  it('should record a success:false tool_result for the model when the tool throws unexpectedly', async () => {
    stubExistingConversation(prisma)
    importFromTemplate.mockRejectedValue(prismaFailure())
    mockChat.mockResolvedValue(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID })

    const toolResultSave = prisma.aiMessage.create.mock.calls.find(([arg]) => arg.data.role === 'tool_result')
    expect(JSON.parse(toolResultSave[0].data.content)).toMatchObject({ success: false })
  })

  it('should complete a streamed turn when the tool throws unexpectedly', async () => {
    stubExistingConversation(prisma)
    importFromTemplate.mockRejectedValue(prismaFailure())
    mockChatStream.mockImplementationOnce(streamOf(toolResponse({ name: AI_TOOLS.IMPORT_FROM_TEMPLATE, input: IMPORT_INPUT })))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const events = await drain(processAiChatStream(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID }))

    expect(events.at(-1)).toMatchObject({ event: 'done' })
  })
})

describe('get_student_performance fallback text (AC 13)', () => {
  const SNAPSHOT = {
    studentId: STUDENT_ID,
    studentName: 'Ana Lima',
    window: { from: '2026-09-26T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z', days: 30 },
    sessionCounts: { completed: 6, in_progress: 0, abandoned: 2 },
    totalSessions: 8,
    completionRate: 0.75,
    lastSessionAt: '2026-10-24T12:00:00.000Z',
    currentProtocol: null,
    topExercises: [],
  }

  async function runWithFailingAnalysis() {
    buildAiPerformanceSnapshot.mockResolvedValue(SNAPSHOT)
    const failure = Object.assign(new Error('bad request'), { status: 400 })
    mockChatStream
      .mockImplementationOnce(streamOf(toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: STUDENT_ID } })))
      .mockImplementationOnce(async function* () { throw failure })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const events = await drain(processAiChatStream(USER_ID, { message: 'Como vai a Ana?' }))
    return events.find((event) => event.event === 'done').data.message
  }

  it('should state completed out of total sessions with the real numbers', async () => {
    const message = await runWithFailingAnalysis()

    expect(message).toContain('6 de 8 sessões')
  })

  it('should state the window in days as a number', async () => {
    const message = await runWithFailingAnalysis()

    expect(message).toContain('últimos 30 dias')
  })

  it('should never render an object or a zero denominator', async () => {
    const message = await runWithFailingAnalysis()

    expect(message).not.toMatch(/\[object Object\]|\bde 0 sess/)
  })

  it('should render the same real numbers in the non-streaming fallback', async () => {
    buildAiPerformanceSnapshot.mockResolvedValue(SNAPSHOT)
    mockChat
      .mockResolvedValueOnce(toolResponse({ name: AI_TOOLS.GET_STUDENT_PERFORMANCE, input: { studentId: STUDENT_ID } }))
      .mockResolvedValue(textResponse(''))
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const turn = processAiChat(USER_ID, { message: 'Como vai a Ana?' })
    await vi.runAllTimersAsync()
    const result = await turn
    vi.useRealTimers()

    expect(result.message).toContain('6 de 8 sessões')
  })
})
