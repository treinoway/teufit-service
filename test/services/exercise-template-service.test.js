import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    exerciseTemplate: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/db.js';
import { advancedTechniqueLinksInclude } from '../../src/helpers/advanced-technique-refs.js';
import {
  createExerciseTemplate,
  getExerciseTemplatesByTrainer,
  batchDeleteExerciseTemplates,
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

      expect(prisma.exerciseTemplate.create).not.toHaveBeenCalled();
    });

    it('creates template with only identity fields — no prescription', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const created = {
        id: 'et1',
        trainerId: 't1',
        name: 'Squat',
        type: 'strength',
        videoUrl: null,
        isPublic: false,
      };
      prisma.exerciseTemplate.create.mockResolvedValue(created);

      const result = await createExerciseTemplate('u1', { name: 'Squat', type: 'strength' });

      expect(result).toEqual(created);
      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: {
          trainerId: 't1',
          name: 'Squat',
          type: 'strength',
          videoUrl: null,
          gifUrl: null,
          isPublic: false,
        },
        include: advancedTechniqueLinksInclude,
      });
    });

    it('persists videoUrl when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.create.mockResolvedValue({
        id: 'et1',
        trainerId: 't1',
        name: 'Squat',
        type: 'strength',
        videoUrl: 'https://example.com/video.mp4',
        isPublic: false,
      });

      await createExerciseTemplate('u1', {
        name: 'Squat',
        type: 'strength',
        videoUrl: 'https://example.com/video.mp4',
      });

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoUrl: 'https://example.com/video.mp4' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('sets videoUrl to null when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.create.mockResolvedValue({ id: 'et1' });

      await createExerciseTemplate('u1', { name: 'Squat', type: 'strength' });

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoUrl: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('persists gifUrl when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.create.mockResolvedValue({ id: 'et1' });

      await createExerciseTemplate('u1', { name: 'Squat', type: 'strength', gifUrl: 'https://example.com/squat.gif' });

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: 'https://example.com/squat.gif' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('sets gifUrl to null when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.create.mockResolvedValue({ id: 'et1' });

      await createExerciseTemplate('u1', { name: 'Squat', type: 'strength' });

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('persists isPublic: true when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.create.mockResolvedValue({ id: 'et1', isPublic: true });

      await createExerciseTemplate('u1', { name: 'Squat', type: 'strength', isPublic: true });

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isPublic: true }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('defaults isPublic to false when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.create.mockResolvedValue({ id: 'et1', isPublic: false });

      await createExerciseTemplate('u1', { name: 'Squat', type: 'strength' });

      expect(prisma.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isPublic: false }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('does NOT include prescription fields (sets/reps/duration/notes/etc.) in create payload', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.create.mockResolvedValue({ id: 'et1' });

      // Pass prescription data that the service should ignore
      await createExerciseTemplate('u1', {
        name: 'Squat',
        type: 'strength',
        sets: 4,
        repetitions: { min: 8, max: 12 },
        duration: 60,
        notes: 'Keep back straight',
        restInterval: 90,
        hasLoad: true,
        suggestedLoad: 60,
        prescriptionMode: 'reps',
        intensity: 'moderate',
      });

      const createData = prisma.exerciseTemplate.create.mock.calls[0][0].data;
      expect(createData).not.toHaveProperty('sets');
      expect(createData).not.toHaveProperty('repetitions');
      expect(createData).not.toHaveProperty('duration');
      expect(createData).not.toHaveProperty('notes');
      expect(createData).not.toHaveProperty('restInterval');
      expect(createData).not.toHaveProperty('hasLoad');
      expect(createData).not.toHaveProperty('suggestedLoad');
      expect(createData).not.toHaveProperty('prescriptionMode');
      expect(createData).not.toHaveProperty('intensity');
    });

    it('create payload contains exactly the four identity fields plus trainerId', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.create.mockResolvedValue({ id: 'et1' });

      await createExerciseTemplate('u1', { name: 'Squat', type: 'strength' });

      const createData = prisma.exerciseTemplate.create.mock.calls[0][0].data;
      expect(Object.keys(createData).sort()).toEqual(['gifUrl', 'isPublic', 'name', 'trainerId', 'type', 'videoUrl'].sort());
    });
  });

  describe('getExerciseTemplatesByTrainer', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getExerciseTemplatesByTrainer('u1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('returns paginated envelope with defaults page=1 and limit=20', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const template = { id: 'et1', name: 'Squat', type: 'strength' };
      prisma.exerciseTemplate.findMany.mockResolvedValue([template]);
      prisma.exerciseTemplate.count.mockResolvedValue(1);

      const result = await getExerciseTemplatesByTrainer('u1');

      expect(result).toEqual({ data: [template], total: 1, page: 1, limit: 20 });
    });

    it('passes name ILIKE filter when filters.q is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findMany.mockResolvedValue([]);
      prisma.exerciseTemplate.count.mockResolvedValue(0);

      await getExerciseTemplatesByTrainer('u1', { q: 'squat' });

      const findManyCall = prisma.exerciseTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({
        name: { contains: 'squat', mode: 'insensitive' },
      });
      const countCall = prisma.exerciseTemplate.count.mock.calls[0][0];
      expect(countCall.where).toMatchObject({
        name: { contains: 'squat', mode: 'insensitive' },
      });
    });

    it('includes type filter in where clause when a valid type is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findMany.mockResolvedValue([]);
      prisma.exerciseTemplate.count.mockResolvedValue(0);

      await getExerciseTemplatesByTrainer('u1', { type: 'strength' });

      const findManyCall = prisma.exerciseTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ type: 'strength' });
    });

    it('silently ignores an invalid type filter value', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findMany.mockResolvedValue([]);
      prisma.exerciseTemplate.count.mockResolvedValue(0);

      await getExerciseTemplatesByTrainer('u1', { type: 'invalid' });

      const findManyCall = prisma.exerciseTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('type');
    });

    it('calculates skip from custom page and limit', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findMany.mockResolvedValue([]);
      prisma.exerciseTemplate.count.mockResolvedValue(0);

      await getExerciseTemplatesByTrainer('u1', { page: 3, limit: 10 });

      const findManyCall = prisma.exerciseTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.skip).toBe(20); // (3-1)*10
      expect(findManyCall.take).toBe(10);
    });

    it('clamps limit to maximum of 100', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findMany.mockResolvedValue([]);
      prisma.exerciseTemplate.count.mockResolvedValue(0);

      const result = await getExerciseTemplatesByTrainer('u1', { limit: 500 });

      const findManyCall = prisma.exerciseTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.take).toBe(100);
      expect(result.limit).toBe(100);
    });
  });

  describe('batchDeleteExerciseTemplates', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        batchDeleteExerciseTemplates('u1', ['et1', 'et2']),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });

      expect(prisma.exerciseTemplate.updateMany).not.toHaveBeenCalled();
    });

    it('calls updateMany with correct where clause and sets deletedAt', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.updateMany.mockResolvedValue({ count: 2 });

      await batchDeleteExerciseTemplates('u1', ['et1', 'et2']);

      expect(prisma.exerciseTemplate.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['et1', 'et2'] }, trainerId: 't1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('returns deletedCount matching the count from updateMany', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.updateMany.mockResolvedValue({ count: 3 });

      const result = await batchDeleteExerciseTemplates('u1', ['et1', 'et2', 'et3']);

      expect(result).toEqual({ deletedCount: 3 });
    });

    it('returns deletedCount 0 when no owned IDs match', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.updateMany.mockResolvedValue({ count: 0 });

      const result = await batchDeleteExerciseTemplates('u1', ['et-other', 'et-already-deleted']);

      expect(result).toEqual({ deletedCount: 0 });
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

    it('returns template when owner — identity fields only in mock', async () => {
      const template = {
        id: 'et1',
        trainerId: 't1',
        name: 'Squat',
        type: 'strength',
        videoUrl: null,
        isPublic: false,
        deletedAt: null,
      };
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(template);

      const result = await getExerciseTemplateById('u1', 'et1');
      expect(result).toEqual(template);
    });

    it('returns public template even when accessed by a different trainer', async () => {
      const template = {
        id: 'et1',
        trainerId: 'other-trainer',
        name: 'Squat',
        type: 'strength',
        videoUrl: null,
        isPublic: true,
        deletedAt: null,
      };
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(template);

      const result = await getExerciseTemplateById('u1', 'et1');
      expect(result).toEqual(template);
    });

    it('throws EXERCISE_TEMPLATE_NOT_FOUND when template is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        id: 'et1',
        trainerId: 't1',
        isPublic: false,
        deletedAt: new Date(),
      });

      await expect(getExerciseTemplateById('u1', 'et1')).rejects.toMatchObject({
        code: 'EXERCISE_TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('updateExerciseTemplate', () => {
    const makeTemplate = (overrides = {}) => ({
      id: 'et1',
      trainerId: 't1',
      name: 'Squat',
      type: 'strength',
      videoUrl: null,
      isPublic: false,
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

      expect(prisma.exerciseTemplate.update).not.toHaveBeenCalled();
    });

    it('throws EXERCISE_TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(null);

      await expect(updateExerciseTemplate('u1', 'et1', { name: 'Updated' })).rejects.toMatchObject({
        code: 'EXERCISE_TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('updates name when name is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      const updated = { id: 'et1', name: 'Deadlift', type: 'strength', videoUrl: null, isPublic: false };
      prisma.exerciseTemplate.update.mockResolvedValue(updated);

      const result = await updateExerciseTemplate('u1', 'et1', { name: 'Deadlift' });

      expect(result).toEqual(updated);
      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: { name: 'Deadlift' },
        include: advancedTechniqueLinksInclude,
      });
    });

    it('updates type when type is valid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      const updated = { id: 'et1', name: 'Running', type: 'cardio', videoUrl: null, isPublic: false };
      prisma.exerciseTemplate.update.mockResolvedValue(updated);

      const result = await updateExerciseTemplate('u1', 'et1', { type: 'cardio' });

      expect(result).toEqual(updated);
      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: { type: 'cardio' },
        include: advancedTechniqueLinksInclude,
      });
    });

    it('throws INVALID_EXERCISE_TYPE when type is invalid', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());

      await expect(updateExerciseTemplate('u1', 'et1', { type: 'yoga' })).rejects.toMatchObject({
        code: 'INVALID_EXERCISE_TYPE',
        statusCode: 400,
      });

      expect(prisma.exerciseTemplate.update).not.toHaveBeenCalled();
    });

    it('updates videoUrl when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      const updated = { id: 'et1', videoUrl: 'https://example.com/video.mp4' };
      prisma.exerciseTemplate.update.mockResolvedValue(updated);

      const result = await updateExerciseTemplate('u1', 'et1', { videoUrl: 'https://example.com/video.mp4' });

      expect(result).toEqual(updated);
      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: { videoUrl: 'https://example.com/video.mp4' },
        include: advancedTechniqueLinksInclude,
      });
    });

    it('updates gifUrl when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      prisma.exerciseTemplate.update.mockResolvedValue({ id: 'et1' });

      await updateExerciseTemplate('u1', 'et1', { gifUrl: 'https://example.com/squat.gif' });

      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: { gifUrl: 'https://example.com/squat.gif' },
        include: advancedTechniqueLinksInclude,
      });
    });

    it('clears gifUrl when null is sent', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      prisma.exerciseTemplate.update.mockResolvedValue({ id: 'et1' });

      await updateExerciseTemplate('u1', 'et1', { gifUrl: null });

      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: { gifUrl: null },
        include: advancedTechniqueLinksInclude,
      });
    });

    it('updates isPublic when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      const updated = { id: 'et1', isPublic: true };
      prisma.exerciseTemplate.update.mockResolvedValue(updated);

      const result = await updateExerciseTemplate('u1', 'et1', { isPublic: true });

      expect(result).toEqual(updated);
      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: { isPublic: true },
        include: advancedTechniqueLinksInclude,
      });
    });

    it('does NOT include prescription fields in update payload when passed', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      prisma.exerciseTemplate.update.mockResolvedValue({ id: 'et1', name: 'Squat' });

      await updateExerciseTemplate('u1', 'et1', {
        name: 'Squat',
        sets: 4,
        repetitions: { min: 8, max: 12 },
        notes: 'Keep form',
        restInterval: 60,
        hasLoad: true,
        prescriptionMode: 'reps',
        intensity: 'moderate',
      });

      const updateData = prisma.exerciseTemplate.update.mock.calls[0][0].data;
      expect(updateData).not.toHaveProperty('sets');
      expect(updateData).not.toHaveProperty('repetitions');
      expect(updateData).not.toHaveProperty('notes');
      expect(updateData).not.toHaveProperty('restInterval');
      expect(updateData).not.toHaveProperty('hasLoad');
      expect(updateData).not.toHaveProperty('prescriptionMode');
      expect(updateData).not.toHaveProperty('intensity');
      // Name should still be present
      expect(updateData).toHaveProperty('name', 'Squat');
    });

    it('sends only the provided identity fields (sparse update)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      prisma.exerciseTemplate.update.mockResolvedValue({ id: 'et1', name: 'Lunge' });

      await updateExerciseTemplate('u1', 'et1', { name: 'Lunge' });

      const updateData = prisma.exerciseTemplate.update.mock.calls[0][0].data;
      expect(updateData).toEqual({ name: 'Lunge' });
      expect(Object.keys(updateData)).toHaveLength(1);
    });

    it('does not call update when no fields are provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());
      prisma.exerciseTemplate.update.mockResolvedValue({ id: 'et1' });

      await updateExerciseTemplate('u1', 'et1', {});

      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: {},
        include: advancedTechniqueLinksInclude,
      });
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

    it('throws FORBIDDEN_NOT_TEMPLATE_OWNER when trainer does not own the template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        id: 'et1',
        trainerId: 'other-trainer',
        deletedAt: null,
      });

      await expect(deleteExerciseTemplate('u1', 'et1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_TEMPLATE_OWNER',
        statusCode: 403,
      });

      expect(prisma.exerciseTemplate.update).not.toHaveBeenCalled();
    });

    it('soft-deletes the template by setting deletedAt', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        id: 'et1',
        trainerId: 't1',
        deletedAt: null,
      });
      const deleted = { id: 'et1', deletedAt: new Date() };
      prisma.exerciseTemplate.update.mockResolvedValue(deleted);

      const result = await deleteExerciseTemplate('u1', 'et1');

      expect(result).toEqual(deleted);
      expect(prisma.exerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'et1' },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });
});
