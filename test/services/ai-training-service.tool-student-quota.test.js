import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findMany: vi.fn(), findUnique: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
    trainingProtocol: { findMany: vi.fn(), findFirst: vi.fn() },
    training: { findFirst: vi.fn() },
    exercise: { findFirst: vi.fn() },
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
    buildToolResultMessages: vi.fn(),
  })),
}))

vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
  updateProtocol: vi.fn(),
}))
vi.mock('../../src/services/training-service.js', () => ({ updateTraining: vi.fn() }))
vi.mock('../../src/services/exercise-service.js', () => ({ updateExercise: vi.fn() }))
vi.mock('../../src/services/exercise-template-service.js', () => ({
  createExerciseTemplate: vi.fn(),
  updateExerciseTemplate: vi.fn(),
}))
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn(),
  recordAiAction: vi.fn(),
}))
vi.mock('../../src/services/ai-interaction-log-service.js', () => ({
  writeInteractionLog: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '../../src/db.js'
import { AppError } from '../../src/errors/app-error.js'
import { processAiChat } from '../../src/services/ai-training-service.js'
import { updateExercise } from '../../src/services/exercise-service.js'
import { updateTraining } from '../../src/services/training-service.js'
import { updateProtocol } from '../../src/services/training-protocol-service.js'
import { updateExerciseTemplate } from '../../src/services/exercise-template-service.js'
import { assertCanUseAi, recordAiAction } from '../../src/services/platform-plan-service.js'
import { AI_TOOLS } from '../../src/constants/ai.js'
import { PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js'
import {
  USER_ID,
  TRAINER_ID,
  STUDENT_ID,
  CONVERSATION_ID,
  toolResponse,
  stubTrainerContext,
  stubExistingConversation,
} from '../helpers/ai-engine-fixtures.js'

const CONFIRMATION = 'Sim, pode fazer'
const OTHER_STUDENT_ID = 'student-2'

// Runs a confirmed turn in which the model calls the given write tool.
async function runConfirmedToolTurn(name, input, extraArgs = {}) {
  mockChat.mockResolvedValue(toolResponse({ name, input }))
  return processAiChat(USER_ID, { message: CONFIRMATION, conversationId: CONVERSATION_ID, ...extraArgs })
}

// Makes assertCanUseAi reject for one student only.
function overQuotaFor(studentId) {
  assertCanUseAi.mockImplementation(async (_prisma, _trainerId, checkedStudentId) => {
    if (checkedStudentId === studentId) {
      throw new AppError({
        httpStatus: 403,
        error: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.code,
        messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode,
        message: 'exceeded',
      })
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  assertCanUseAi.mockReset()
  assertCanUseAi.mockResolvedValue(undefined)
  recordAiAction.mockResolvedValue(undefined)
  prisma.aiTokenUsage.create.mockResolvedValue({})
  prisma.trainerStudent.findUnique.mockResolvedValue({ studentId: STUDENT_ID })
  prisma.exercise.findFirst.mockResolvedValue({ training: { trainingProtocol: { assigneeId: STUDENT_ID } } })
  prisma.training.findFirst.mockResolvedValue({ trainingProtocol: { assigneeId: STUDENT_ID } })
  prisma.trainingProtocol.findFirst.mockResolvedValue({ assigneeId: STUDENT_ID })
  updateExercise.mockResolvedValue({ id: 'ex-1', name: 'Supino' })
  updateTraining.mockResolvedValue({ id: 'tr-1', name: 'Peito' })
  updateProtocol.mockResolvedValue({ id: 'pr-1', name: 'Hipertrofia' })
  updateExerciseTemplate.mockResolvedValue({ id: 'et-1', name: 'Supino' })
  stubTrainerContext(prisma)
  stubExistingConversation(prisma)
})

describe('student resolved from the targeted protocol, training or exercise', () => {
  it.each([
    [AI_TOOLS.UPDATE_EXERCISE, { exerciseId: 'ex-1', sets: 5 }, () => prisma.exercise.findFirst],
    [AI_TOOLS.UPDATE_TRAINING, { trainingId: 'tr-1', name: 'Peito A' }, () => prisma.training.findFirst],
    [AI_TOOLS.UPDATE_PROTOCOL, { protocolId: 'pr-1', name: 'Novo nome' }, () => prisma.trainingProtocol.findFirst],
  ])('should re-check the quota of the assignee before running %s', async (tool, input, lookup) => {
    await runConfirmedToolTurn(tool, input)

    expect(lookup()).toHaveBeenCalledTimes(1)
    expect(assertCanUseAi).toHaveBeenCalledWith(expect.anything(), TRAINER_ID, STUDENT_ID)
  })

  it.each([
    [AI_TOOLS.UPDATE_EXERCISE, { exerciseId: 'ex-1', sets: 5 }, () => updateExercise],
    [AI_TOOLS.UPDATE_TRAINING, { trainingId: 'tr-1', name: 'Peito A' }, () => updateTraining],
    [AI_TOOLS.UPDATE_PROTOCOL, { protocolId: 'pr-1', name: 'Novo nome' }, () => updateProtocol],
  ])('should block %s and not execute it when that student is over quota', async (tool, input, service) => {
    overQuotaFor(STUDENT_ID)

    await expect(runConfirmedToolTurn(tool, input)).rejects.toMatchObject({
      httpStatus: 403,
      messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode,
    })
    expect(service()).not.toHaveBeenCalled()
  })

  it('should record the action against the resolved student', async () => {
    await runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE, { exerciseId: 'ex-1', sets: 5 })

    expect(recordAiAction).toHaveBeenCalledWith(expect.anything(), TRAINER_ID, STUDENT_ID, AI_TOOLS.UPDATE_EXERCISE)
  })

  it('should unwrap a REF-tagged id before the lookup', async () => {
    await runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE, { exerciseId: '[EXERCISE_REF:ex-1]', sets: 5 })

    expect(prisma.exercise.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'ex-1' }) }),
    )
  })

  it('should only resolve targets owned by the asking trainer', async () => {
    await runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE, { exerciseId: 'ex-1', sets: 5 })

    expect(JSON.stringify(prisma.exercise.findFirst.mock.calls[0][0].where)).toContain(TRAINER_ID)
  })

  it('should not re-check a student already checked from the request body', async () => {
    await runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE, { exerciseId: 'ex-1', sets: 5 }, { studentId: STUDENT_ID })

    const checkedStudents = assertCanUseAi.mock.calls.map(([, , studentId]) => studentId)
    expect(checkedStudents).toEqual([STUDENT_ID])
  })

  it('should check a different student than the body one when the tool targets another student', async () => {
    prisma.exercise.findFirst.mockResolvedValue({ training: { trainingProtocol: { assigneeId: OTHER_STUDENT_ID } } })
    overQuotaFor(OTHER_STUDENT_ID)

    await expect(
      runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE, { exerciseId: 'ex-1', sets: 5 }, { studentId: STUDENT_ID }),
    ).rejects.toMatchObject({ httpStatus: 403 })
    expect(updateExercise).not.toHaveBeenCalled()
  })
})

describe('tools without a student', () => {
  it('should not look up a student for a library template tool', async () => {
    await runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE_TEMPLATE, { templateId: 'et-1', name: 'Supino inclinado' })

    expect(prisma.exercise.findFirst).not.toHaveBeenCalled()
    expect(prisma.training.findFirst).not.toHaveBeenCalled()
    expect(prisma.trainingProtocol.findFirst).not.toHaveBeenCalled()
  })

  it('should keep only the initial plan gate for a library template tool', async () => {
    await runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE_TEMPLATE, { templateId: 'et-1', name: 'Supino inclinado' })

    expect(assertCanUseAi).toHaveBeenCalledTimes(1)
  })

  it('should not check any student quota when the target is not found for this trainer', async () => {
    prisma.exercise.findFirst.mockResolvedValue(null)

    await runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE, { exerciseId: 'ex-foreign', sets: 5 })

    expect(assertCanUseAi).toHaveBeenCalledTimes(1)
    expect(updateExercise).toHaveBeenCalledTimes(1)
  })

  it('should log and carry on when the student lookup fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    prisma.exercise.findFirst.mockRejectedValue(new Error('db down'))

    const result = await runConfirmedToolTurn(AI_TOOLS.UPDATE_EXERCISE, { exerciseId: 'ex-1', sets: 5 })

    expect(result.actionsExecuted[0]).toMatchObject({ tool: AI_TOOLS.UPDATE_EXERCISE, success: true })
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})
