import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    exerciseTemplate: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/db.js';
import {
  createExerciseTemplate,
  getExerciseTemplateById,
  updateExerciseTemplate,
  deleteExerciseTemplate,
} from '../../src/services/exercise-template-service.js';

describe('exercise-template-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createExerciseTemplate', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        createExerciseTemplate('u1', { name: 'Squat', type: 'strength' }),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });

      expect(prisma.exerciseTemplate.create).not.toHaveBeenCalled();
    });

    it('throws INVALID_EXERCISE_TYPE for invalid type', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      await expect(
        createExerciseTemplate('u1', { name: 'Squat', type: 'yoga' }),
      ).rejects.toMatchObject({ code: 'INVALID_EXERCISE_TYPE', statusCode: 400 });
    });

    it('creates template with valid data', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const created = { id: 'et1', trainerId: 't1', name: 'Squat', type: 'strength' };
      prisma.exerciseTemplate.create.mockResolvedValue(created);

      const result = await createExerciseTemplate('u1', { name: 'Squat', type: 'strength' });

      expect(result).toEqual(created);
      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          trainerId: 't1',
          name: 'Squat',
          type: 'strength',
        }),
      });
    });

    it('persists notes when provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const created = { id: 'et1', trainerId: 't1', name: 'Squat', type: 'strength', notes: 'Full range of motion' };
      prisma.exerciseTemplate.create.mockResolvedValue(created);

      const result = await createExerciseTemplate('u1', {
        name: 'Squat',
        type: 'strength',
        notes: 'Full range of motion',
      });

      expect(result).toEqual(created);
      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notes: 'Full range of motion' }),
      });
    });

    it('sets notes to null when not provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const created = { id: 'et1', trainerId: 't1', name: 'Squat', type: 'strength', notes: null };
      prisma.exerciseTemplate.create.mockResolvedValue(created);

      await createExerciseTemplate('u1', { name: 'Squat', type: 'strength' });

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notes: null }),
      });
    });
  });

  describe('getExerciseTemplateById', () => {
    it('throws EXERCISE_TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(null);

      await expect(getExerciseTemplateById('u1', 'et1')).rejects.toMatchObject({
        code: 'EXERCISE_TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_PRIVATE_TEMPLATE when accessing private template of another trainer', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        id: 'et1',
        trainerId: 'other-trainer',
        isPublic: false,
        deletedAt: null,
      });

      await expect(getExerciseTemplateById('u1', 'et1')).rejects.toMatchObject({
        code: 'FORBIDDEN_PRIVATE_TEMPLATE',
        statusCode: 403,
      });
    });

    it('returns template when owner', async () => {
      const template = { id: 'et1', trainerId: 't1', name: 'Squat', isPublic: false, deletedAt: null };
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(template);

      const result = await getExerciseTemplateById('u1', 'et1');
      expect(result).toEqual(template);
    });
  });

  describe('updateExerciseTemplate', () => {
    const makeTemplate = (overrides = {}) => ({
      id: 'et1',
      trainerId: 't1',
      deletedAt: null,
      ...overrides,
    });

    it('throws FORBIDDEN_NOT_TEMPLATE_OWNER when not owner', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        id: 'et1',
        trainerId: 'other-trainer',
        deletedAt: null,
      });

      await expect(updateExerciseTemplate('u1', 'et1', { name: 'Updated' })).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_TEMPLATE_OWNER',
        statusCode: 403,
      });
    });

    it('updates notes when notes is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      const updated = { id: 'et1', notes: 'Keep core braced' };
      prisma.exerciseTemplate.update.mockResolvedValue(updated);

      const result = await updateExerciseTemplate('u1', 'et1', { notes: 'Keep core braced' });

      expect(result).toEqual(updated);
      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: expect.objectContaining({ notes: 'Keep core braced' }),
      });
    });

    it('sets notes to null when notes is explicitly null', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      const updated = { id: 'et1', notes: null };
      prisma.exerciseTemplate.update.mockResolvedValue(updated);

      await updateExerciseTemplate('u1', 'et1', { notes: null });

      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: expect.objectContaining({ notes: null }),
      });
    });

    it('does not include notes in update payload when notes is not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      prisma.exerciseTemplate.update.mockResolvedValue({ id: 'et1', name: 'Deadlift' });

      await updateExerciseTemplate('u1', 'et1', { name: 'Deadlift' });

      const callData = prisma.exerciseTemplate.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty('notes');
    });
  });

  describe('deleteExerciseTemplate', () => {
    it('throws EXERCISE_TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(null);

      await expect(deleteExerciseTemplate('u1', 'et1')).rejects.toMatchObject({
        code: 'EXERCISE_TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });
  });
});
