import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingTemplate: { findUnique: vi.fn() },
    exerciseTemplate: { findUnique: vi.fn() },
    trainingTemplateExerciseTemplate: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import {
  createTrainingTemplateExercise,
  createTrainingTemplateExerciseFromTemplate,
} from '../../src/services/training-template-service.js';

const TEMPLATE_ID = 'tt1';
const LAST_ORDER = 4;

// Builds a transaction client whose junction.findFirst reports the current max order.
function makeTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    exerciseTemplate: { create: vi.fn().mockResolvedValue({ id: 'et-new', name: 'Squat', type: 'strength' }) },
    trainingTemplateExerciseTemplate: {
      findFirst: vi.fn().mockResolvedValue({ order: LAST_ORDER }),
      create: vi.fn().mockResolvedValue({ id: 'jte1' }),
    },
  };
}

describe('training-template-service — append order is computed under a template lock', () => {
  let tx;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));
    prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
    prisma.trainingTemplate.findUnique.mockResolvedValue({ id: TEMPLATE_ID, trainerId: 't1', deletedAt: null });
    prisma.exerciseTemplate.findUnique.mockResolvedValue({
      id: 'et1', trainerId: 't1', name: 'Squat', type: 'strength', deletedAt: null,
    });
  });

  describe('createTrainingTemplateExerciseFromTemplate', () => {
    it('locks the training template row before reading the max order', async () => {
      await createTrainingTemplateExerciseFromTemplate('u1', TEMPLATE_ID, { exerciseTemplateId: 'et1' });

      expect(tx.$queryRaw).toHaveBeenCalledOnce();
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.trainingTemplateExerciseTemplate.findFirst.mock.invocationCallOrder[0],
      );
    });

    it('reads the max order through the transaction client, not the shared client', async () => {
      await createTrainingTemplateExerciseFromTemplate('u1', TEMPLATE_ID, { exerciseTemplateId: 'et1' });

      expect(prisma.trainingTemplateExerciseTemplate.findFirst).not.toHaveBeenCalled();
      expect(tx.trainingTemplateExerciseTemplate.findFirst).toHaveBeenCalledOnce();
    });

    it('creates the junction row inside the transaction with max + 1 as order', async () => {
      await createTrainingTemplateExerciseFromTemplate('u1', TEMPLATE_ID, { exerciseTemplateId: 'et1' });

      expect(prisma.trainingTemplateExerciseTemplate.create).not.toHaveBeenCalled();
      expect(tx.trainingTemplateExerciseTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ order: LAST_ORDER + 1 }) }),
      );
    });

    it('keeps an explicit order without computing the append position', async () => {
      await createTrainingTemplateExerciseFromTemplate('u1', TEMPLATE_ID, { exerciseTemplateId: 'et1', order: 0 });

      expect(tx.trainingTemplateExerciseTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ order: 0 }) }),
      );
    });
  });

  describe('createTrainingTemplateExercise', () => {
    it('locks the training template row before reading the max order', async () => {
      await createTrainingTemplateExercise('u1', TEMPLATE_ID, { name: 'Squat', type: 'strength' });

      expect(tx.$queryRaw).toHaveBeenCalledOnce();
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.trainingTemplateExerciseTemplate.findFirst.mock.invocationCallOrder[0],
      );
    });

    it('reads the max order through the transaction client, not the shared client', async () => {
      await createTrainingTemplateExercise('u1', TEMPLATE_ID, { name: 'Squat', type: 'strength' });

      expect(prisma.trainingTemplateExerciseTemplate.findFirst).not.toHaveBeenCalled();
      expect(tx.trainingTemplateExerciseTemplate.findFirst).toHaveBeenCalledOnce();
    });

    it('creates the junction row with max + 1 as order', async () => {
      await createTrainingTemplateExercise('u1', TEMPLATE_ID, { name: 'Squat', type: 'strength' });

      expect(tx.trainingTemplateExerciseTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ order: LAST_ORDER + 1 }) }),
      );
    });
  });
});
