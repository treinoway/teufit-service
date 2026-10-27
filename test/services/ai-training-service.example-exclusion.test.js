import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingProtocol: { findMany: vi.fn() },
    trainerStudent: { findMany: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
    exerciseTemplate: { findMany: vi.fn() },
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));
vi.mock('../../src/services/training-protocol-service.js', () => ({ importFromTemplate: vi.fn() }));
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/student-dashboard-service.js', () => ({ buildAiPerformanceSnapshot: vi.fn() }));
vi.mock('../../src/services/exercise-service.js', () => ({
  reorderExercisesInTraining: vi.fn(),
  updateExercise: vi.fn(),
}));
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertCanUseAi: vi.fn(),
  recordAiAction: vi.fn(),
  assertStudentCap: vi.fn(),
  assertCanUseBranding: vi.fn(),
  assertCanCreateChallenge: vi.fn(),
  assertStudentActiveOnPlan: vi.fn(),
  enforceStudentCapAfterDowngrade: vi.fn(),
  getTrainerPlan: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { buildTrainerContext } from '../../src/services/ai-training-service.js';

const TRAINER_ID = 'trainer-1';

describe('buildTrainerContext example exclusion', () => {
  beforeEach(() => {
    prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
    prisma.trainerStudent.findMany.mockResolvedValue([]);
    prisma.trainingProtocolTemplate.findMany.mockResolvedValue([]);
    prisma.trainingTemplate.findMany.mockResolvedValue([]);
    prisma.trainingProtocol.findMany.mockResolvedValue([]);
    prisma.exerciseTemplate.findMany.mockResolvedValue([]);
  });

  it('should exclude example routines from the protocol template context query', async () => {
    await buildTrainerContext('user-1');

    expect(prisma.trainingProtocolTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { trainerId: TRAINER_ID, deletedAt: null, isExample: false },
      }),
    );
  });

  it('should exclude example trainings from the training template context query', async () => {
    await buildTrainerContext('user-1');

    expect(prisma.trainingTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null, isExample: false }),
      }),
    );
  });
});
