import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingTemplate: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    exerciseTemplate: { findMany: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import {
  createTrainingTemplate,
  getTrainingTemplateById,
  updateTrainingTemplate,
} from '../../src/services/training-template-service.js';

describe('training-template-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createTrainingTemplate', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        createTrainingTemplate('u1', { name: 'Leg Day', category: 'strength' }),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });

      expect(prisma.trainingTemplate.create).not.toHaveBeenCalled();
    });

    it('throws INVALID_CATEGORY for invalid category', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      await expect(
        createTrainingTemplate('u1', { name: 'Leg Day', category: 'invalid' }),
      ).rejects.toMatchObject({ code: 'INVALID_CATEGORY', statusCode: 400 });
    });

    it('creates template without exerciseTemplates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const created = {
        id: 'tt1',
        trainerId: 't1',
        name: 'Leg Day',
        category: 'strength',
        trainingTemplateExerciseTemplates: [],
      };
      prisma.trainingTemplate.create.mockResolvedValue(created);

      const result = await createTrainingTemplate('u1', {
        name: 'Leg Day',
        category: 'strength',
      });

      expect(result).toEqual(created);
      expect(prisma.trainingTemplate.create).toHaveBeenCalledWith({
        data: {
          trainerId: 't1',
          name: 'Leg Day',
          description: null,
          category: 'strength',
          bodySegment: null,
          tags: [],
          isPublic: false,
        },
        include: expect.any(Object),
      });
      expect(prisma.exerciseTemplate.findMany).not.toHaveBeenCalled();
    });

    it('throws EXERCISE_TEMPLATE_NOT_FOUND when exercise template does not exist or is not owned', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findMany.mockResolvedValue([]);

      await expect(
        createTrainingTemplate('u1', {
          name: 'Leg Day',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId: 'et-missing' }],
        }),
      ).rejects.toMatchObject({ code: 'EXERCISE_TEMPLATE_NOT_FOUND', statusCode: 404 });

      expect(prisma.trainingTemplate.create).not.toHaveBeenCalled();
    });

    it('creates template with exerciseTemplates and links them', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findMany.mockResolvedValue([
        { id: 'et1' },
        { id: 'et2' },
      ]);
      const created = {
        id: 'tt1',
        trainerId: 't1',
        name: 'Leg Day',
        category: 'strength',
        trainingTemplateExerciseTemplates: [
          { id: 'jte1', exerciseTemplateId: 'et1', order: 0, exerciseTemplate: { id: 'et1', name: 'Squat' } },
          { id: 'jte2', exerciseTemplateId: 'et2', order: 1, exerciseTemplate: { id: 'et2', name: 'Lunge' } },
        ],
      };
      prisma.trainingTemplate.create.mockResolvedValue(created);

      const result = await createTrainingTemplate('u1', {
        name: 'Leg Day',
        category: 'strength',
        exerciseTemplates: [
          { exerciseTemplateId: 'et1', order: 0 },
          { exerciseTemplateId: 'et2', order: 1 },
        ],
      });

      expect(result).toEqual(created);
      expect(prisma.trainingTemplate.create).toHaveBeenCalledWith({
        data: {
          trainerId: 't1',
          name: 'Leg Day',
          description: null,
          category: 'strength',
          bodySegment: null,
          tags: [],
          isPublic: false,
          trainingTemplateExerciseTemplates: {
            create: [
              { exerciseTemplateId: 'et1', order: 0 },
              { exerciseTemplateId: 'et2', order: 1 },
            ],
          },
        },
        include: expect.any(Object),
      });
    });
  });

  describe('getTrainingTemplateById', () => {
    it('returns template with trainingTemplateExerciseTemplates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({
        id: 'tt1',
        trainerId: 't1',
        name: 'Leg Day',
        trainingTemplateExerciseTemplates: [
          { order: 0, exerciseTemplate: { id: 'et1', name: 'Squat' } },
        ],
      });

      const result = await getTrainingTemplateById('u1', 'tt1');

      expect(result.trainingTemplateExerciseTemplates).toHaveLength(1);
      expect(result.trainingTemplateExerciseTemplates[0].exerciseTemplate.name).toBe('Squat');
    });
  });

  describe('updateTrainingTemplate', () => {
    it('replaces exerciseTemplates when exerciseTemplates is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({
        id: 'tt1',
        trainerId: 't1',
      });
      prisma.exerciseTemplate.findMany.mockResolvedValue([{ id: 'et2' }]);
      const updated = {
        id: 'tt1',
        trainingTemplateExerciseTemplates: [
          { exerciseTemplateId: 'et2', order: 0, exerciseTemplate: { id: 'et2' } },
        ],
      };
      prisma.trainingTemplate.update.mockResolvedValue(updated);

      await updateTrainingTemplate('u1', 'tt1', {
        exerciseTemplates: [{ exerciseTemplateId: 'et2' }],
      });

      expect(prisma.trainingTemplate.update).toHaveBeenCalledWith({
        where: { id: 'tt1' },
        data: expect.objectContaining({
          trainingTemplateExerciseTemplates: {
            deleteMany: {},
            create: [{ exerciseTemplateId: 'et2', order: 0 }],
          },
        }),
        include: expect.any(Object),
      });
    });
  });
});
