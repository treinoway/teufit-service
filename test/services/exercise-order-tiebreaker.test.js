import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    training: { findUnique: vi.fn() },
    trainingProtocol: { findUnique: vi.fn(), findMany: vi.fn() },
    trainingTemplate: { findUnique: vi.fn() },
    trainingProtocolTemplate: { findUnique: vi.fn() },
    exercise: { findMany: vi.fn() },
    workoutSession: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import { getExercisesByTraining } from '../../src/services/exercise-service.js';
import { importFromTemplate as importTrainingFromTemplate } from '../../src/services/training-service.js';
import { importFromTemplate as importProtocolFromTemplate } from '../../src/services/training-protocol-service.js';
import { getProtocolTemplateById } from '../../src/services/training-protocol-template-service.js';
import { getTodayWorkout } from '../../src/services/workouts-today-service.js';
import { startSession } from '../../src/services/workout-session-service.js';

// Orders ties by creation time, then id, so rows sharing an `order` come back in a total, stable sequence.
const ORDER_THEN_CREATION = [{ order: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

describe('order tie-breaker on exercise/junction reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getExercisesByTraining sorts principal exercises by order then createdAt', async () => {
    prisma.training.findUnique.mockResolvedValue({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: { id: 'p1', trainerId: 't1', assigneeId: 'u1', deletedAt: null },
    });
    prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
    prisma.exercise.findMany.mockResolvedValue([]);

    await getExercisesByTraining('u-trainer', 'tr1', 'trainer');

    expect(prisma.exercise.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: ORDER_THEN_CREATION }),
    );
  });

  it('training importFromTemplate reads template junction rows by order then createdAt', async () => {
    prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
    prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
    prisma.trainingTemplate.findUnique.mockResolvedValue(null);

    await expect(importTrainingFromTemplate('u1', 'p1', 'tt1')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });

    const { include } = prisma.trainingTemplate.findUnique.mock.calls[0][0];
    expect(include.trainingTemplateExerciseTemplates.orderBy).toEqual(ORDER_THEN_CREATION);
  });

  it('protocol importFromTemplate reads nested junction rows by order then createdAt', async () => {
    prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
    prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(null);

    await expect(importProtocolFromTemplate('u1', 'tpl1', 'assignee1')).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });

    const { include } = prisma.trainingProtocolTemplate.findUnique.mock.calls[0][0];
    expect(include.trainings.include.trainingTemplate.include.trainingTemplateExerciseTemplates.orderBy).toEqual(
      ORDER_THEN_CREATION,
    );
  });

  it('getProtocolTemplateById reads junction rows by order then createdAt', async () => {
    prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
    prisma.trainingProtocolTemplate.findUnique.mockResolvedValue(null);

    await expect(getProtocolTemplateById('u1', 'tpl1')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });

    const { include } = prisma.trainingProtocolTemplate.findUnique.mock.calls[0][0];
    expect(include.trainings.include.trainingTemplate.include.trainingTemplateExerciseTemplates.orderBy).toEqual(
      ORDER_THEN_CREATION,
    );
  });

  it('getTodayWorkout reads each training exercises by order then createdAt', async () => {
    prisma.trainingProtocol.findMany.mockResolvedValue([]);

    await expect(getTodayWorkout('u1')).rejects.toBeDefined();

    const { include } = prisma.trainingProtocol.findMany.mock.calls[0][0];
    expect(include.trainings.include.exercises.orderBy).toEqual(ORDER_THEN_CREATION);
  });

  it('startSession (resolveAssigneeTraining) reads principal exercises by order then createdAt', async () => {
    prisma.training.findUnique.mockResolvedValue(null);

    await expect(startSession('u1', 'tr1')).rejects.toMatchObject({ code: 'TRAINING_NOT_FOUND' });

    const { include } = prisma.training.findUnique.mock.calls[0][0];
    expect(include.exercises.orderBy).toEqual(ORDER_THEN_CREATION);
  });
});
