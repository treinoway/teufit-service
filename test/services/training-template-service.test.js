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
    exerciseTemplate: { findMany: vi.fn(), findUnique: vi.fn() },
    trainingTemplateExerciseTemplate: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/db.js';
import {
  createTrainingTemplate,
  createTrainingTemplateExerciseFromTemplate,
  getTrainingTemplateById,
  updateTrainingTemplate,
  updateTrainingTemplateExercise,
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

    it('creates template with exerciseTemplates and links them with snapshot fields', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const et1 = { id: 'et1', name: 'Squat', type: 'strength', videoUrl: null, sets: 4, repetitions: null, duration: null, hasLoad: true, suggestedLoad: 60, restInterval: null, notes: null };
      const et2 = { id: 'et2', name: 'Lunge', type: 'strength', videoUrl: null, sets: 3, repetitions: null, duration: null, hasLoad: false, suggestedLoad: null, restInterval: 60, notes: null };
      prisma.exerciseTemplate.findMany.mockResolvedValue([et1, et2]);
      const created = {
        id: 'tt1',
        trainerId: 't1',
        name: 'Leg Day',
        category: 'strength',
        trainingTemplateExerciseTemplates: [
          { id: 'jte1', exerciseTemplateId: 'et1', order: 0, name: 'Squat', exerciseTemplate: et1 },
          { id: 'jte2', exerciseTemplateId: 'et2', order: 1, name: 'Lunge', exerciseTemplate: et2 },
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
        data: expect.objectContaining({
          trainerId: 't1',
          trainingTemplateExerciseTemplates: {
            create: [
              {
                exerciseTemplateId: 'et1',
                order: 0,
                name: 'Squat',
                type: 'strength',
                videoUrl: null,
                sets: 4,
                repetitions: null,
                duration: null,
                prescriptionMode: 'reps',
                hasLoad: true,
                suggestedLoad: 60,
                restInterval: null,
                notes: null,
              },
              {
                exerciseTemplateId: 'et2',
                order: 1,
                name: 'Lunge',
                type: 'strength',
                videoUrl: null,
                sets: 3,
                repetitions: null,
                duration: null,
                prescriptionMode: 'reps',
                hasLoad: false,
                suggestedLoad: null,
                restInterval: 60,
                notes: null,
              },
            ],
          },
        }),
        include: expect.any(Object),
      });
    });

    it('input override takes precedence over template snapshot when creating with exerciseTemplates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      const template = {
        id: 'et1',
        name: 'Squat',
        type: 'strength',
        videoUrl: null,
        sets: 4,
        repetitions: null,
        duration: null,
        hasLoad: true,
        suggestedLoad: 60,
        restInterval: null,
        notes: null,
      };
      prisma.exerciseTemplate.findMany.mockResolvedValue([template]);
      prisma.trainingTemplate.create.mockResolvedValue({ id: 'tt1', trainingTemplateExerciseTemplates: [] });

      await createTrainingTemplate('u1', {
        name: 'Leg Day',
        category: 'strength',
        exerciseTemplates: [{ exerciseTemplateId: 'et1', sets: 5, notes: 'Focus on depth' }],
      });

      const createCall = prisma.trainingTemplate.create.mock.calls[0][0];
      const junctionRow = createCall.data.trainingTemplateExerciseTemplates.create[0];
      expect(junctionRow.sets).toBe(5);
      expect(junctionRow.notes).toBe('Focus on depth');
      // Non-overridden fields still come from the template
      expect(junctionRow.name).toBe('Squat');
      expect(junctionRow.suggestedLoad).toBe(60);
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
    it('replaces exerciseTemplates and snapshots fields from ExerciseTemplate', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingTemplate.findUnique.mockResolvedValue({ id: 'tt1', trainerId: 't1', deletedAt: null });
      const et2 = {
        id: 'et2',
        name: 'Deadlift',
        type: 'strength',
        videoUrl: null,
        sets: 5,
        repetitions: null,
        duration: null,
        hasLoad: true,
        suggestedLoad: 100,
        restInterval: 90,
        notes: null,
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
                name: 'Deadlift',
                type: 'strength',
                videoUrl: null,
                sets: 5,
                repetitions: null,
                duration: null,
                prescriptionMode: 'reps',
                hasLoad: true,
                suggestedLoad: 100,
                restInterval: 90,
                notes: null,
              },
            ],
          },
        }),
        include: expect.any(Object),
      });
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
        exerciseTemplate: { id: 'et1', name: 'Squat' },
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
  });

  describe('createTrainingTemplateExerciseFromTemplate', () => {
    // Shared setup helpers used by all four cases below.
    function mockOwnership(trainerId = 't1') {
      prisma.trainer.findUnique.mockResolvedValue({ id: trainerId });
      prisma.trainingTemplate.findUnique.mockResolvedValue({
        id: 'tt1',
        trainerId,
        deletedAt: null,
      });
    }

    function mockExerciseTemplate(fields) {
      prisma.exerciseTemplate.findUnique.mockResolvedValue({ trainerId: 't1', ...fields });
    }

    function mockNextOrder(order = 0) {
      // nextExerciseOrder uses trainingTemplateExerciseTemplate.findFirst
      prisma.trainingTemplateExerciseTemplate.findFirst.mockResolvedValue(
        order === 0 ? null : { order: order - 1 },
      );
    }

    function stubCreate(returnValue = { id: 'jte1' }) {
      prisma.trainingTemplateExerciseTemplate.create.mockResolvedValue(returnValue);
    }

    it('junction row gets prescriptionMode=duration, duration populated, repetitions null when source template mode is duration', async () => {
      mockOwnership();
      const exerciseTemplate = {
        id: 'et1',
        name: 'Plank',
        type: 'endurance',
        videoUrl: null,
        sets: 3,
        repetitions: null,
        duration: 60,
        prescriptionMode: 'duration',
        hasLoad: false,
        suggestedLoad: null,
        restInterval: 30,
        notes: null,
      };
      mockExerciseTemplate(exerciseTemplate);
      mockNextOrder(0);
      stubCreate();

      await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', {
        exerciseTemplateId: 'et1',
        order: 0,
      });

      const createCall = prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0];
      expect(createCall.data.prescriptionMode).toBe('duration');
      expect(createCall.data.duration).toBe(60);
      expect(createCall.data.repetitions).toBeNull();
    });

    it('junction row gets prescriptionMode=reps, repetitions populated, duration null when source template mode is reps', async () => {
      mockOwnership();
      const exerciseTemplate = {
        id: 'et2',
        name: 'Squat',
        type: 'strength',
        videoUrl: null,
        sets: 4,
        repetitions: 12,
        duration: null,
        prescriptionMode: 'reps',
        hasLoad: true,
        suggestedLoad: 80,
        restInterval: 60,
        notes: null,
      };
      mockExerciseTemplate(exerciseTemplate);
      mockNextOrder(0);
      stubCreate();

      await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', {
        exerciseTemplateId: 'et2',
        order: 0,
      });

      const createCall = prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0];
      expect(createCall.data.prescriptionMode).toBe('reps');
      expect(createCall.data.repetitions).toBe(12);
      expect(createCall.data.duration).toBeNull();
    });

    it('legacy dirty source with both fields populated and null mode infers reps, nulls duration', async () => {
      // resolvePrescriptionMode: mode is null, duration !== null but repetitions !== null → REPS
      mockOwnership();
      const exerciseTemplate = {
        id: 'et3',
        name: 'Row',
        type: 'strength',
        videoUrl: null,
        sets: 3,
        repetitions: 10,
        duration: 45,
        prescriptionMode: null,
        hasLoad: true,
        suggestedLoad: 40,
        restInterval: 45,
        notes: null,
      };
      mockExerciseTemplate(exerciseTemplate);
      mockNextOrder(0);
      stubCreate();

      await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', {
        exerciseTemplateId: 'et3',
        order: 0,
      });

      const createCall = prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0];
      expect(createCall.data.prescriptionMode).toBe('reps');
      expect(createCall.data.repetitions).toBe(10);
      expect(createCall.data.duration).toBeNull();
    });

    it('legacy dirty source with only duration populated and null mode infers duration, nulls repetitions', async () => {
      // resolvePrescriptionMode: mode is null, duration !== null AND repetitions === null → DURATION
      mockOwnership();
      const exerciseTemplate = {
        id: 'et4',
        name: 'Hold',
        type: 'endurance',
        videoUrl: null,
        sets: 4,
        repetitions: null,
        duration: 90,
        prescriptionMode: null,
        hasLoad: false,
        suggestedLoad: null,
        restInterval: null,
        notes: null,
      };
      mockExerciseTemplate(exerciseTemplate);
      mockNextOrder(0);
      stubCreate();

      await createTrainingTemplateExerciseFromTemplate('u1', 'tt1', {
        exerciseTemplateId: 'et4',
        order: 0,
      });

      const createCall = prisma.trainingTemplateExerciseTemplate.create.mock.calls[0][0];
      expect(createCall.data.prescriptionMode).toBe('duration');
      expect(createCall.data.duration).toBe(90);
      expect(createCall.data.repetitions).toBeNull();
    });
  });
});
