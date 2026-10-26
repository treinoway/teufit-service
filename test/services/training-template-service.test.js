import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingTemplate: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    exerciseTemplate: { findMany: vi.fn(), findUnique: vi.fn() },
    trainingTemplateExerciseTemplate: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/db.js';
import {
  createTrainingTemplate,
  createTrainingTemplateExercise,
  createTrainingTemplateExerciseFromTemplate,
  getTrainingTemplatesByTrainer,
  batchDeleteTrainingTemplates,
  getTrainingTemplateById,
  updateTrainingTemplate,
  updateTrainingTemplateExercise,
} from '../../src/services/training-template-service.js';

describe('training-template-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction = vi.fn().mockImplementation(async (fn) => fn({
      $queryRaw: vi.fn().mockResolvedValue([]),
      exerciseTemplate: prisma.exerciseTemplate,
      trainingTemplateExerciseTemplate: prisma.trainingTemplateExerciseTemplate,
    }));
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

    it('throws EXERCISE_TEMPLATE_NOT_FOUND when exercise template is private and owned by another trainer', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      // findMany returns empty — simulates a private template from another trainer
      // (the OR clause excludes it: trainerId !== t1 AND isPublic = false)
      prisma.exerciseTemplate.findMany.mockResolvedValue([]);

      await expect(
        createTrainingTemplate('u1', {
          name: 'Leg Day',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId: 'et-private-other' }],
        }),
      ).rejects.toMatchObject({ code: 'EXERCISE_TEMPLATE_NOT_FOUND', statusCode: 404 });

      // Verify the findMany where clause uses the OR own/public pattern
      expect(prisma.exerciseTemplate.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['et-private-other'] },
          deletedAt: null,
          OR: [{ trainerId: 't1' }, { isPublic: true }],
        },
      });
      expect(prisma.trainingTemplate.create).not.toHaveBeenCalled();
    });

    it('succeeds when exercise template is public and owned by another trainer', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      // Public template owned by a different trainer — returned by the OR clause
      const publicTemplate = {
        id: 'et-public-other',
        name: 'Public Squat',
        type: 'strength',
        videoUrl: null,
        trainerId: 'other-trainer',
        isPublic: true,
      };
      prisma.exerciseTemplate.findMany.mockResolvedValue([publicTemplate]);
      const created = {
        id: 'tt1',
        trainerId: 't1',
        name: 'Leg Day',
        category: 'strength',
        trainingTemplateExerciseTemplates: [
          {
            exerciseTemplateId: 'et-public-other',
            order: 0,
            name: 'Public Squat',
            type: 'strength',
          },
        ],
      };
      prisma.trainingTemplate.create.mockResolvedValue(created);

      const result = await createTrainingTemplate('u1', {
        name: 'Leg Day',
        category: 'strength',
        exerciseTemplates: [{ exerciseTemplateId: 'et-public-other' }],
      });

      expect(result).toEqual(created);

      // The findMany must use the OR own/public clause — not trainerId-only
      expect(prisma.exerciseTemplate.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['et-public-other'] },
          deletedAt: null,
          OR: [{ trainerId: 't1' }, { isPublic: true }],
        },
      });

      // Junction row identity must be snapshotted from the public template
      const createCall = prisma.trainingTemplate.create.mock.calls[0][0];
      const junctionRow = createCall.data.trainingTemplateExerciseTemplates.create[0];
      expect(junctionRow.exerciseTemplateId).toBe('et-public-other');
      expect(junctionRow.name).toBe('Public Squat');
      expect(junctionRow.type).toBe('strength');
    });

    it('creates junction rows with null prescription defaults when template has identity only', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      // Templates now carry only identity — no prescription fields
      const et1 = { id: 'et1', name: 'Squat', type: 'strength', videoUrl: null };
      const et2 = { id: 'et2', name: 'Lunge', type: 'strength', videoUrl: null };
      prisma.exerciseTemplate.findMany.mockResolvedValue([et1, et2]);
      const created = {
        id: 'tt1',
        trainerId: 't1',
        name: 'Leg Day',
        category: 'strength',
        trainingTemplateExerciseTemplates: [],
      };
      prisma.trainingTemplate.create.mockResolvedValue(created);

      await createTrainingTemplate('u1', {
        name: 'Leg Day',
        category: 'strength',
        exerciseTemplates: [
          { exerciseTemplateId: 'et1', order: 0 },
          { exerciseTemplateId: 'et2', order: 1 },
        ],
      });

      expect(prisma.trainingTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          trainerId: 't1',
          trainingTemplateExerciseTemplates: {
            create: [
              {
                exerciseTemplateId: 'et1',
                order: 0,
                supersetGroupId: null,
                supersetOrder: 0,
                name: 'Squat',
                type: 'strength',
                videoUrl: null,
                sets: null,
                repetitions: null,
                duration: null,
                prescriptionMode: 'reps',
                hasLoad: false,
                suggestedLoad: null,
                restInterval: null,
                notes: null,
                intensity: null,
              },
              {
                exerciseTemplateId: 'et2',
                order: 1,
                supersetGroupId: null,
                supersetOrder: 0,
                name: 'Lunge',
                type: 'strength',
                videoUrl: null,
                sets: null,
                repetitions: null,
                duration: null,
                prescriptionMode: 'reps',
                hasLoad: false,
                suggestedLoad: null,
                restInterval: null,
                notes: null,
                intensity: null,
              },
            ],
          },
        }),
        include: expect.any(Object),
      });
    });

    it('caller-supplied prescription fields override null defaults in junction rows', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const template = { id: 'et1', name: 'Squat', type: 'strength', videoUrl: null };
      prisma.exerciseTemplate.findMany.mockResolvedValue([template]);
      prisma.trainingTemplate.create.mockResolvedValue({ id: 'tt1', trainingTemplateExerciseTemplates: [] });

      await createTrainingTemplate('u1', {
        name: 'Leg Day',
        category: 'strength',
        exerciseTemplates: [
          {
            exerciseTemplateId: 'et1',
            sets: 5,
            notes: 'Focus on depth',
            hasLoad: true,
            suggestedLoad: 80,
          },
        ],
      });

      const createCall = prisma.trainingTemplate.create.mock.calls[0][0];
      const junctionRow = createCall.data.trainingTemplateExerciseTemplates.create[0];
      expect(junctionRow.sets).toBe(5);
      expect(junctionRow.notes).toBe('Focus on depth');
      expect(junctionRow.hasLoad).toBe(true);
      expect(junctionRow.suggestedLoad).toBe(80);
      // Identity from the library template
      expect(junctionRow.name).toBe('Squat');
      expect(junctionRow.type).toBe('strength');
    });

    it('junction rows inherit name/type/videoUrl from library template identity', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const template = {
        id: 'et1',
        name: 'Bench Press',
        type: 'strength',
        videoUrl: 'https://example.com/bench.mp4',
      };
      prisma.exerciseTemplate.findMany.mockResolvedValue([template]);
      prisma.trainingTemplate.create.mockResolvedValue({ id: 'tt1', trainingTemplateExerciseTemplates: [] });

      await createTrainingTemplate('u1', {
        name: 'Push Day',
        category: 'strength',
        exerciseTemplates: [{ exerciseTemplateId: 'et1' }],
      });

      const junctionRow = prisma.trainingTemplate.create.mock.calls[0][0].data.trainingTemplateExerciseTemplates.create[0];
      expect(junctionRow.name).toBe('Bench Press');
      expect(junctionRow.type).toBe('strength');
      expect(junctionRow.videoUrl).toBe('https://example.com/bench.mp4');
    });
  });

  describe('gifUrl', () => {
    const GIF_URL = 'https://example.com/squat.gif';
    const CALLER_GIF_URL = 'https://example.com/caller.gif';

    function mockOwnership() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue(null);
    }

    async function createWithLibraryTemplate(exerciseInput = {}) {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exerciseTemplate.findMany.mockResolvedValue([
        { id: 'et1', name: 'Squat', type: 'strength', videoUrl: null, gifUrl: GIF_URL },
      ]);
      prisma.trainingTemplate.create.mockResolvedValue({ id: 'tt1', trainingTemplateExerciseTemplates: [] });

      await createTrainingTemplate('u1', {
        name: 'Leg Day',
        category: 'strength',
        exerciseTemplates: [{ exerciseTemplateId: 'et1', ...exerciseInput }],
      });

      return prisma.trainingTemplate.create.mock.calls[0][0].data.trainingTemplateExerciseTemplates.create[0];
    }

    it('createTrainingTemplate junction rows inherit gifUrl from the library template', async () => {
      const junctionRow = await createWithLibraryTemplate();

      expect(junctionRow.gifUrl).toBe(GIF_URL);
    });

    it('createTrainingTemplate junction rows prefer a caller-supplied gifUrl', async () => {
      const junctionRow = await createWithLibraryTemplate({ gifUrl: CALLER_GIF_URL });

      expect(junctionRow.gifUrl).toBe(CALLER_GIF_URL);
    });

    it('createTrainingTemplateExerciseFromTemplate snapshots the library gifUrl onto the junction row', async () => {
      mockOwnership();
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        id: 'et1', name: 'Squat', type: 'strength', videoUrl: null, gifUrl: GIF_URL,
        trainerId: 't1', isPublic: false, deletedAt: null,
      });
      prisma.trainingTemplateExerciseTemplate.create.mockResolvedValue({ id: 'jte1' });

      await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', { exerciseTemplateId: 'et1' });

      expect(prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0].data.gifUrl).toBe(GIF_URL);
    });

    it('createTrainingTemplateExercise persists gifUrl on both the library template and the junction row', async () => {
      mockOwnership();
      const createdTemplate = { id: 'et-new', name: 'Squat', type: 'strength', videoUrl: null, gifUrl: GIF_URL };
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exerciseTemplate: { create: vi.fn().mockResolvedValue(createdTemplate) },
        trainingTemplateExerciseTemplate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'jte1' }),
        },
      };
      prisma.$transaction = vi.fn().mockImplementation(async (fn) => fn(txMock));

      await createTrainingTemplateExercise('u1', 'tt1', { name: 'Squat', type: 'strength', gifUrl: GIF_URL });

      expect(txMock.exerciseTemplate.create.mock.calls[0][0].data.gifUrl).toBe(GIF_URL);
      expect(txMock.trainingTemplateExerciseTemplate.create.mock.calls[0][0].data.gifUrl).toBe(GIF_URL);
    });

    it('createTrainingTemplateExercise stores gifUrl null when not provided', async () => {
      mockOwnership();
      const createdTemplate = { id: 'et-new', name: 'Squat', type: 'strength', videoUrl: null, gifUrl: null };
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exerciseTemplate: { create: vi.fn().mockResolvedValue(createdTemplate) },
        trainingTemplateExerciseTemplate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'jte1' }),
        },
      };
      prisma.$transaction = vi.fn().mockImplementation(async (fn) => fn(txMock));

      await createTrainingTemplateExercise('u1', 'tt1', { name: 'Squat', type: 'strength' });

      expect(txMock.exerciseTemplate.create.mock.calls[0][0].data.gifUrl).toBeNull();
    });
  });

  describe('getTrainingTemplatesByTrainer', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getTrainingTemplatesByTrainer('u1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('returns paginated envelope with defaults page=1 and limit=20', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const template = { id: 'tt1', name: 'Leg Day', category: 'strength' };
      prisma.trainingTemplate.findMany.mockResolvedValue([template]);
      prisma.trainingTemplate.count.mockResolvedValue(1);

      const result = await getTrainingTemplatesByTrainer('u1');

      expect(result).toEqual({ data: [template], total: 1, page: 1, limit: 20 });
    });

    it('passes name ILIKE filter when filters.q is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);
      prisma.trainingTemplate.count.mockResolvedValue(0);

      await getTrainingTemplatesByTrainer('u1', { q: 'leg' });

      const findManyCall = prisma.trainingTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({
        name: { contains: 'leg', mode: 'insensitive' },
      });
      const countCall = prisma.trainingTemplate.count.mock.calls[0][0];
      expect(countCall.where).toMatchObject({
        name: { contains: 'leg', mode: 'insensitive' },
      });
    });

    it('includes category filter in where clause when a valid category is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);
      prisma.trainingTemplate.count.mockResolvedValue(0);

      await getTrainingTemplatesByTrainer('u1', { category: 'strength' });

      const findManyCall = prisma.trainingTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ category: 'strength' });
    });

    it('silently ignores an invalid category filter value', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);
      prisma.trainingTemplate.count.mockResolvedValue(0);

      await getTrainingTemplatesByTrainer('u1', { category: 'invalid' });

      const findManyCall = prisma.trainingTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('category');
    });

    it('includes bodySegment filter in where clause when a valid bodySegment is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);
      prisma.trainingTemplate.count.mockResolvedValue(0);

      await getTrainingTemplatesByTrainer('u1', { bodySegment: 'upper' });

      const findManyCall = prisma.trainingTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ bodySegment: 'upper' });
    });

    it('silently ignores an invalid bodySegment filter value', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);
      prisma.trainingTemplate.count.mockResolvedValue(0);

      await getTrainingTemplatesByTrainer('u1', { bodySegment: 'invalid' });

      const findManyCall = prisma.trainingTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('bodySegment');
    });

    it('calculates skip from custom page and limit', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);
      prisma.trainingTemplate.count.mockResolvedValue(0);

      await getTrainingTemplatesByTrainer('u1', { page: 3, limit: 10 });

      const findManyCall = prisma.trainingTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.skip).toBe(20); // (3-1)*10
      expect(findManyCall.take).toBe(10);
    });

    it('clamps limit to maximum of 100', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findMany.mockResolvedValue([]);
      prisma.trainingTemplate.count.mockResolvedValue(0);

      const result = await getTrainingTemplatesByTrainer('u1', { limit: 999 });

      const findManyCall = prisma.trainingTemplate.findMany.mock.calls[0][0];
      expect(findManyCall.take).toBe(100);
      expect(result.limit).toBe(100);
    });
  });

  describe('batchDeleteTrainingTemplates', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        batchDeleteTrainingTemplates('u1', ['tt1', 'tt2']),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });

      expect(prisma.trainingTemplate.updateMany).not.toHaveBeenCalled();
    });

    it('calls updateMany with correct where clause and sets deletedAt', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.updateMany.mockResolvedValue({ count: 2 });

      await batchDeleteTrainingTemplates('u1', ['tt1', 'tt2']);

      expect(prisma.trainingTemplate.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['tt1', 'tt2'] }, trainerId: 't1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('returns deletedCount matching the count from updateMany', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.updateMany.mockResolvedValue({ count: 2 });

      const result = await batchDeleteTrainingTemplates('u1', ['tt1', 'tt2']);

      expect(result).toEqual({ deletedCount: 2 });
    });

    it('returns deletedCount 0 when no owned IDs match', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.updateMany.mockResolvedValue({ count: 0 });

      const result = await batchDeleteTrainingTemplates('u1', ['tt-other', 'tt-already-deleted']);

      expect(result).toEqual({ deletedCount: 0 });
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
          { order: 0, exerciseTemplate: { id: 'et1', name: 'Squat', type: 'strength', videoUrl: null, isPublic: false } },
        ],
      });

      const result = await getTrainingTemplateById('u1', 'tt1');

      expect(result.trainingTemplateExerciseTemplates).toHaveLength(1);
      expect(result.trainingTemplateExerciseTemplates[0].exerciseTemplate.name).toBe('Squat');
    });

    it('throws TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue(null);

      await expect(getTrainingTemplateById('u1', 'tt-missing')).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('updateTrainingTemplate', () => {
    it('replaces junction rows with null prescription defaults when library template has identity only', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      const et2 = {
        id: 'et2',
        name: 'Deadlift',
        type: 'strength',
        videoUrl: null,
      };
      prisma.exerciseTemplate.findMany.mockResolvedValue([et2]);
      prisma.trainingTemplate.update.mockResolvedValue({
        id: 'tt1',
        trainingTemplateExerciseTemplates: [],
      });

      await updateTrainingTemplate('u1', 'tt1', {
        exerciseTemplates: [{ exerciseTemplateId: 'et2' }],
      });

      expect(prisma.trainingTemplate.update).toHaveBeenCalledWith({
        where: { id: 'tt1' },
        data: expect.objectContaining({
          trainingTemplateExerciseTemplates: {
            deleteMany: {},
            create: [
              {
                exerciseTemplateId: 'et2',
                order: 0,
                supersetGroupId: null,
                supersetOrder: 0,
                name: 'Deadlift',
                type: 'strength',
                videoUrl: null,
                sets: null,
                repetitions: null,
                duration: null,
                prescriptionMode: 'reps',
                hasLoad: false,
                suggestedLoad: null,
                restInterval: null,
                notes: null,
                intensity: null,
              },
            ],
          },
        }),
        include: expect.any(Object),
      });
    });

    it('caller-supplied prescription overrides null defaults on update junction rows', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      const et1 = { id: 'et1', name: 'Squat', type: 'strength', videoUrl: null };
      prisma.exerciseTemplate.findMany.mockResolvedValue([et1]);
      prisma.trainingTemplate.update.mockResolvedValue({ id: 'tt1', trainingTemplateExerciseTemplates: [] });

      await updateTrainingTemplate('u1', 'tt1', {
        exerciseTemplates: [{ exerciseTemplateId: 'et1', sets: 4, restInterval: 90 }],
      });

      const updateCall = prisma.trainingTemplate.update.mock.calls[0][0];
      const junctionRow = updateCall.data.trainingTemplateExerciseTemplates.create[0];
      expect(junctionRow.sets).toBe(4);
      expect(junctionRow.restInterval).toBe(90);
    });
  });

  describe('updateTrainingTemplateExercise', () => {
    it('updates only the junction row fields provided — happy path', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue({ id: 'jt1', trainingTemplateId: 'tt1' });
      const updatedRow = {
        id: 'jt1',
        trainingTemplateId: 'tt1',
        exerciseTemplateId: 'et1',
        order: 0,
        name: 'Squat',
        sets: 5,
        exerciseTemplate: { id: 'et1', name: 'Squat', type: 'strength', videoUrl: null, isPublic: false },
      };
      prisma.trainingTemplateExerciseTemplate.update.mockResolvedValue(updatedRow);

      const result = await updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { sets: 5 });

      expect(result).toEqual(updatedRow);
      expect(prisma.trainingTemplateExerciseTemplate.update).toHaveBeenCalledWith({
        where: { id: 'jt1' },
        data: { sets: 5 },
        include: { exerciseTemplate: true },
      });
    });

    it('updates only the fields explicitly provided — does not send untouched fields', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue({ id: 'jt1', trainingTemplateId: 'tt1' });
      prisma.trainingTemplateExerciseTemplate.update.mockResolvedValue({ id: 'jt1' });

      await updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { order: 2, notes: 'Keep back straight' });

      const updateCall = prisma.trainingTemplateExerciseTemplate.update.mock.calls[0][0];
      expect(updateCall.data).toEqual({ order: 2, notes: 'Keep back straight' });
      expect(Object.keys(updateCall.data)).toHaveLength(2);
    });

    it('writes gifUrl on the junction row, including null to clear it', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue({ id: 'jt1', trainingTemplateId: 'tt1' });
      prisma.trainingTemplateExerciseTemplate.update.mockResolvedValue({ id: 'jt1' });

      await updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { gifUrl: 'https://example.com/squat.gif' });
      await updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { gifUrl: null });

      const calls = prisma.trainingTemplateExerciseTemplate.update.mock.calls;
      expect(calls[0][0].data).toEqual({ gifUrl: 'https://example.com/squat.gif' });
      expect(calls[1][0].data).toEqual({ gifUrl: null });
    });

    it('throws TRAINING_TEMPLATE_EXERCISE_NOT_FOUND when junction row does not belong to template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue(null);

      await expect(
        updateTrainingTemplateExercise('u1', 'tt1', 'jt-missing', { sets: 3 }),
      ).rejects.toMatchObject({ code: 'TRAINING_TEMPLATE_EXERCISE_NOT_FOUND', statusCode: 404 });

      expect(prisma.trainingTemplateExerciseTemplate.update).not.toHaveBeenCalled();
    });

    it('throws FORBIDDEN_NOT_TEMPLATE_OWNER when trainer does not own the template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 'other-trainer', deletedAt: null });

      await expect(
        updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { sets: 3 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN_NOT_TEMPLATE_OWNER', statusCode: 403 });

      expect(prisma.trainingTemplateExerciseTemplate.findFirst).not.toHaveBeenCalled();
      expect(prisma.trainingTemplateExerciseTemplate.update).not.toHaveBeenCalled();
    });

    it('throws TEMPLATE_NOT_FOUND when training template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue(null);

      await expect(
        updateTrainingTemplateExercise('u1', 'tt-missing', 'jt1', { sets: 3 }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND', statusCode: 404 });

      expect(prisma.trainingTemplateExerciseTemplate.findFirst).not.toHaveBeenCalled();
    });

    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { sets: 3 }),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });

      expect(prisma.trainingTemplate.findUnique).not.toHaveBeenCalled();
    });

    it('includes intensity in updateData when intensity is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue({ id: 'jt1', trainingTemplateId: 'tt1' });
      prisma.trainingTemplateExerciseTemplate.update.mockResolvedValue({ id: 'jt1' });

      await updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { intensity: 'moderate' });

      const updateCall = prisma.trainingTemplateExerciseTemplate.update.mock.calls[0][0];
      expect(updateCall.data).toEqual({ intensity: 'moderate' });
    });

    it('sets intensity to null in updateData when intensity is explicitly null', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue({ id: 'jt1', trainingTemplateId: 'tt1' });
      prisma.trainingTemplateExerciseTemplate.update.mockResolvedValue({ id: 'jt1' });

      await updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { intensity: null });

      const updateCall = prisma.trainingTemplateExerciseTemplate.update.mock.calls[0][0];
      expect(updateCall.data).toEqual({ intensity: null });
    });

    it('omits intensity from updateData when intensity is not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue({ id: 'jt1', trainingTemplateId: 'tt1' });
      prisma.trainingTemplateExerciseTemplate.update.mockResolvedValue({ id: 'jt1' });

      await updateTrainingTemplateExercise('u1', 'tt1', 'jt1', { sets: 4 });

      const updateCall = prisma.trainingTemplateExerciseTemplate.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('intensity');
      expect(updateCall.data).toEqual({ sets: 4 });
    });
  });

  describe('createTrainingTemplateExerciseFromTemplate', () => {
    // Shared setup helpers
    function mockOwnership(trainerId = 't1') {
      prisma.trainer.findUnique.mockResolvedValue({ id: trainerId });
      prisma.trainingTemplate.findUnique.mockResolvedValue({
        id: 'tt1',
        trainerId,
        deletedAt: null,
      });
    }

    function mockExerciseTemplate(fields) {
      // Library templates carry only identity — no prescription fields
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        trainerId: 't1',
        ...fields,
      });
    }

    function mockNextOrder(order = 0) {
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue(
        order === 0 ? null : { order: order - 1 },
      );
    }

    function stubCreate(returnValue = { id: 'jte1' }) {
      prisma.trainingTemplateExerciseTemplate.create.mockResolvedValue(returnValue);
    }

    it('junction row gets identity from library template and null prescription defaults when no prescription in data', async () => {
      mockOwnership();
      // Identity-only template (no prescription fields)
      const exerciseTemplate = {
        id: 'et1',
        name: 'Plank',
        type: 'endurance',
        videoUrl: null,
        deletedAt: null,
      };
      mockExerciseTemplate(exerciseTemplate);
      mockNextOrder(0);
      stubCreate();

      await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', {
        exerciseTemplateId: 'et1',
        order: 0,
      });

      const createCall = prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0];
      // Identity comes from library template
      expect(createCall.data.name).toBe('Plank');
      expect(createCall.data.type).toBe('endurance');
      expect(createCall.data.videoUrl).toBeNull();
      // Prescription defaults to null/REPS (library has no prescription)
      expect(createCall.data.prescriptionMode).toBe('reps');
      expect(createCall.data.sets).toBeNull();
      expect(createCall.data.repetitions).toBeNull();
      expect(createCall.data.duration).toBeNull();
      expect(createCall.data.hasLoad).toBe(false);
      expect(createCall.data.suggestedLoad).toBeNull();
      expect(createCall.data.restInterval).toBeNull();
      expect(createCall.data.notes).toBeNull();
      expect(createCall.data.intensity).toBeNull();
    });

    it('caller-supplied prescription overrides defaults when linking from template', async () => {
      mockOwnership();
      const exerciseTemplate = {
        id: 'et1',
        name: 'Squat',
        type: 'strength',
        videoUrl: null,
        deletedAt: null,
      };
      mockExerciseTemplate(exerciseTemplate);
      mockNextOrder(0);
      stubCreate();

      await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', {
        exerciseTemplateId: 'et1',
        order: 0,
        sets: 4,
        prescriptionMode: 'reps',
        repetitions: { min: 8, max: 12 },
        hasLoad: true,
        suggestedLoad: 80,
        restInterval: 60,
        notes: 'Full depth',
      });

      const createCall = prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0];
      // Identity from template
      expect(createCall.data.name).toBe('Squat');
      expect(createCall.data.type).toBe('strength');
      // Prescription from caller
      expect(createCall.data.sets).toBe(4);
      expect(createCall.data.prescriptionMode).toBe('reps');
      expect(createCall.data.repetitions).toEqual({ min: 8, max: 12 });
      expect(createCall.data.duration).toBeNull(); // reps mode nulls duration
      expect(createCall.data.hasLoad).toBe(true);
      expect(createCall.data.suggestedLoad).toBe(80);
      expect(createCall.data.restInterval).toBe(60);
      expect(createCall.data.notes).toBe('Full depth');
    });

    it('duration mode is applied when caller sets prescriptionMode=duration', async () => {
      mockOwnership();
      const exerciseTemplate = {
        id: 'et1',
        name: 'Plank',
        type: 'endurance',
        videoUrl: null,
        deletedAt: null,
      };
      mockExerciseTemplate(exerciseTemplate);
      mockNextOrder(0);
      stubCreate();

      await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', {
        exerciseTemplateId: 'et1',
        prescriptionMode: 'duration',
        duration: 60,
      });

      const createCall = prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0];
      expect(createCall.data.prescriptionMode).toBe('duration');
      expect(createCall.data.duration).toBe(60);
      expect(createCall.data.repetitions).toBeNull();
    });

    it('throws EXERCISE_TEMPLATE_NOT_FOUND when template does not exist', async () => {
      mockOwnership();
      prisma.exerciseTemplate.findUnique.mockResolvedValue(null);

      await expect(
        createTrainingTemplateExerciseFromTemplate('u1', 'tt1', { exerciseTemplateId: 'et-missing' }),
      ).rejects.toMatchObject({ code: 'EXERCISE_TEMPLATE_NOT_FOUND', statusCode: 404 });

      expect(prisma.trainingTemplateExerciseTemplate.create).not.toHaveBeenCalled();
    });

    it('throws EXERCISE_TEMPLATE_NOT_FOUND when template is private and belongs to a different trainer', async () => {
      mockOwnership('t1');
      // Explicit isPublic: false — the guard now checks both ownership AND visibility
      mockExerciseTemplate({
        id: 'et1',
        name: 'Squat',
        type: 'strength',
        videoUrl: null,
        trainerId: 'other-trainer',
        isPublic: false,
        deletedAt: null,
      });

      await expect(
        createTrainingTemplateExerciseFromTemplate('u1', 'tt1', { exerciseTemplateId: 'et1' }),
      ).rejects.toMatchObject({ code: 'EXERCISE_TEMPLATE_NOT_FOUND', statusCode: 404 });

      expect(prisma.trainingTemplateExerciseTemplate.create).not.toHaveBeenCalled();
    });

    it('succeeds when exercise template is public and owned by another trainer', async () => {
      mockOwnership('t1');
      // Public template from a different trainer — ownership guard allows it
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        id: 'et-public',
        name: 'Community Plank',
        type: 'endurance',
        videoUrl: 'https://example.com/plank.mp4',
        trainerId: 'other-trainer',
        isPublic: true,
        deletedAt: null,
      });
      mockNextOrder(0);
      const junctionResult = {
        id: 'jte-public',
        trainingTemplateId: 'tt1',
        exerciseTemplateId: 'et-public',
        name: 'Community Plank',
        type: 'endurance',
        videoUrl: 'https://example.com/plank.mp4',
        sets: 3,
        prescriptionMode: 'reps',
        repetitions: { min: 10, max: 15 },
        duration: null,
        hasLoad: false,
        suggestedLoad: null,
        restInterval: 30,
        notes: null,
        order: 0,
        intensity: null,
      };
      stubCreate(junctionResult);

      const result = await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', {
        exerciseTemplateId: 'et-public',
        sets: 3,
        prescriptionMode: 'reps',
        repetitions: { min: 10, max: 15 },
        restInterval: 30,
      });

      expect(result).toEqual(junctionResult);

      const createCall = prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0];
      // Identity snapshotted from the public template (not the caller)
      expect(createCall.data.name).toBe('Community Plank');
      expect(createCall.data.type).toBe('endurance');
      expect(createCall.data.videoUrl).toBe('https://example.com/plank.mp4');
      expect(createCall.data.exerciseTemplateId).toBe('et-public');
      // Prescription from caller input
      expect(createCall.data.sets).toBe(3);
      expect(createCall.data.prescriptionMode).toBe('reps');
      expect(createCall.data.repetitions).toEqual({ min: 10, max: 15 });
      expect(createCall.data.restInterval).toBe(30);
    });
  });

  describe('createTrainingTemplateExercise (ad-hoc)', () => {
    function mockOwnership(trainerId = 't1') {
      prisma.trainer.findUnique.mockResolvedValue({ id: trainerId });
      prisma.trainingTemplate.findUnique.mockResolvedValue({
        id: 'tt1',
        trainerId,
        deletedAt: null,
      });
    }

    it('creates an identity-only exerciseTemplate row and links it via junction with prescription from data', async () => {
      mockOwnership();
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue(null); // nextExerciseOrder → 0
      const createdTemplate = { id: 'et-new', name: 'Ad-hoc Squat', type: 'strength', videoUrl: null, isPublic: false };
      const createdJunction = {
        id: 'jte-new',
        trainingTemplateId: 'tt1',
        exerciseTemplateId: 'et-new',
        name: 'Ad-hoc Squat',
        type: 'strength',
        sets: 3,
        repetitions: { min: 8, max: 12 },
        prescriptionMode: 'reps',
        exerciseTemplate: createdTemplate,
      };

      prisma.$transaction = vi.fn().mockImplementation(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          exerciseTemplate: { create: vi.fn().mockResolvedValue(createdTemplate) },
          trainingTemplateExerciseTemplate: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(createdJunction),
          },
        };
        return fn(tx);
      });

      const result = await createTrainingTemplateExercise('u1', 'tt1', {
        name: 'Ad-hoc Squat',
        type: 'strength',
        sets: 3,
        prescriptionMode: 'reps',
        repetitions: { min: 8, max: 12 },
      });

      expect(result).toEqual(createdJunction);

      const txFn = prisma.$transaction.mock.calls[0][0];
      // Retrieve the tx mock to check calls
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exerciseTemplate: { create: vi.fn().mockResolvedValue(createdTemplate) },
        trainingTemplateExerciseTemplate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(createdJunction),
        },
      };
      await txFn(txMock);

      // exerciseTemplate row must contain ONLY identity fields
      const templateCreateData = txMock.exerciseTemplate.create.mock.calls[0][0].data;
      expect(templateCreateData).toMatchObject({
        trainerId: 't1',
        name: 'Ad-hoc Squat',
        type: 'strength',
        videoUrl: null,
        isPublic: false,
      });
      expect(templateCreateData).not.toHaveProperty('sets');
      expect(templateCreateData).not.toHaveProperty('repetitions');
      expect(templateCreateData).not.toHaveProperty('notes');
      expect(templateCreateData).not.toHaveProperty('prescriptionMode');

      // Junction row must contain prescription from the request data
      const junctionCreateData = txMock.trainingTemplateExerciseTemplate.create.mock.calls[0][0].data;
      expect(junctionCreateData).toMatchObject({
        sets: 3,
        prescriptionMode: 'reps',
        repetitions: { min: 8, max: 12 },
      });
    });

    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        createTrainingTemplateExercise('u1', 'tt1', { name: 'Squat', type: 'strength' }),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });
    });
  });
});
