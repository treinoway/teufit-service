import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findMany: vi.fn(), findUnique: vi.fn() },
    anamnesisResponse: { findMany: vi.fn() },
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
  getLlmProvider: vi.fn(() => ({ chat: mockChat, chatStream: vi.fn(), buildToolResultMessages: vi.fn() })),
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
import { processAiChat } from '../../src/services/ai-training-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'
import { AI_LIMITS } from '../../src/constants/ai.js'
import { USER_ID, TRAINER_ID, STUDENT_ID, textResponse, stubTrainerContext, stubNewConversation } from '../helpers/ai-engine-fixtures.js'

// Returns the dynamic system block of the first model call.
function dynamicPrompt() {
  return mockChat.mock.calls[0][0].system.at(-1).text
}

beforeEach(() => {
  vi.clearAllMocks()
  prisma.aiTokenUsage.create.mockResolvedValue({})
  prisma.trainerStudent.findUnique.mockResolvedValue({ studentId: STUDENT_ID })
  prisma.anamnesisResponse.findMany.mockResolvedValue([])
  buildAiPerformanceSnapshot.mockResolvedValue({ studentName: 'Ana Lima', sessionCounts: { completed: 3 }, totalSessions: 3 })
  mockChat.mockResolvedValue(textResponse('Ok'))
  stubTrainerContext(prisma)
  stubNewConversation(prisma)
})

describe('student focus loading', () => {
  it('should only read submitted anamneses that THIS trainer linked to the student, newest first', async () => {
    await processAiChat(USER_ID, { message: 'Oi', studentId: STUDENT_ID })

    expect(prisma.anamnesisResponse.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        studentId: STUDENT_ID,
        submittedAt: { not: null },
        anamnesis: { deletedAt: null, studentAnamneses: { some: { studentId: STUDENT_ID, trainerId: TRAINER_ID } } },
      },
      orderBy: { submittedAt: 'desc' },
      take: 1,
    }))
  })

  it('should not open the filter to general forms another trainer linked to a shared student', async () => {
    await processAiChat(USER_ID, { message: 'Oi', studentId: STUDENT_ID })

    const { where } = prisma.anamnesisResponse.findMany.mock.calls[0][0]
    expect(JSON.stringify(where)).not.toContain('isGeneral')
    expect(where.anamnesis.studentAnamneses.some.trainerId).toBe(TRAINER_ID)
  })

  it('should ask for a cheap snapshot (no per-exercise progression) over the configured window', async () => {
    await processAiChat(USER_ID, { message: 'Oi', studentId: STUDENT_ID })

    expect(buildAiPerformanceSnapshot).toHaveBeenCalledWith(USER_ID, STUDENT_ID, {
      windowDays: AI_LIMITS.CONTEXT_PERFORMANCE_WINDOW_DAYS,
      includeExerciseProgression: false,
    })
  })

  it('should still answer when the anamnesis query fails, noting there is no anamnesis', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    prisma.anamnesisResponse.findMany.mockRejectedValue(new Error('db down'))

    await processAiChat(USER_ID, { message: 'Oi', studentId: STUDENT_ID })

    expect(dynamicPrompt()).toContain('Anamnese: nao respondida.')
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('should still answer when the snapshot fails, noting performance is unavailable', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    buildAiPerformanceSnapshot.mockRejectedValue(new Error('db down'))

    await processAiChat(USER_ID, { message: 'Oi', studentId: STUDENT_ID })

    expect(dynamicPrompt()).toContain('Desempenho: indisponivel.')
    logged.mockRestore()
  })

  it('should read the anamnesis only after ownership of the student was verified', async () => {
    prisma.trainerStudent.findUnique.mockResolvedValue(null)

    await processAiChat(USER_ID, { message: 'Oi', studentId: STUDENT_ID }).catch(() => {})

    expect(prisma.anamnesisResponse.findMany).not.toHaveBeenCalled()
  })
})
