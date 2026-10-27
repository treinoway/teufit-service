import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/db.js', () => ({
  prisma: {
    workoutSession: { groupBy: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    trainingProtocol: { findMany: vi.fn(), findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))

vi.mock('../../src/services/workout-session-service.js', () => ({
  resolveTrainerStudent: vi.fn(),
}))

import { prisma } from '../../src/db.js'
import { resolveTrainerStudent } from '../../src/services/workout-session-service.js'
import { buildAiPerformanceSnapshot } from '../../src/services/student-dashboard-service.js'

const TRAINER_USER_ID = 'trainer-user-1'
const TRAINER_ID = 'trainer-1'
const STUDENT_ID = 'student-1'

describe('buildAiPerformanceSnapshot trainer scoping (AC 14)', () => {
  beforeEach(() => {
    resolveTrainerStudent.mockResolvedValue({ id: TRAINER_ID })
    prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID })
    prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: TRAINER_ID, studentId: STUDENT_ID })
    prisma.user.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: 'Lima' })
    prisma.workoutSession.groupBy.mockResolvedValue([])
    prisma.workoutSession.findFirst.mockResolvedValue(null)
    prisma.trainingProtocol.findFirst.mockResolvedValue(null)
    prisma.$queryRaw.mockResolvedValue([])
  })

  it('should only look up the current protocol among protocols owned by the asking trainer', async () => {
    await buildAiPerformanceSnapshot(TRAINER_USER_ID, STUDENT_ID, {})

    expect(prisma.trainingProtocol.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assigneeId: STUDENT_ID, trainerId: TRAINER_ID }),
      }),
    )
  })

  it('should not expose the protocol of another trainer as currentProtocol', async () => {
    const foreignProtocol = { id: 'protocol-b', name: 'Protocolo do treinador B', trainerId: 'trainer-b' }
    prisma.trainingProtocol.findFirst.mockImplementation(async ({ where }) =>
      (where.trainerId === foreignProtocol.trainerId || where.trainerId === undefined ? foreignProtocol : null))

    const snapshot = await buildAiPerformanceSnapshot(TRAINER_USER_ID, STUDENT_ID, {})

    expect(snapshot.currentProtocol).toBeNull()
  })

  it('should still return the protocol of the asking trainer', async () => {
    const ownProtocol = { id: 'protocol-a', name: 'Meu protocolo', trainerId: TRAINER_ID }
    prisma.trainingProtocol.findFirst.mockImplementation(async ({ where }) =>
      (where.trainerId === TRAINER_ID ? ownProtocol : null))

    const snapshot = await buildAiPerformanceSnapshot(TRAINER_USER_ID, STUDENT_ID, {})

    expect(snapshot.currentProtocol).toEqual({ id: 'protocol-a', name: 'Meu protocolo' })
  })
})
