import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    training: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    trainingProtocol: { findUnique: vi.fn() },
    trainingTemplate: { findUnique: vi.fn() },
    exercise: { create: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import {
  createTraining,
  getTrainingById,
  updateTraining,
  deleteTraining,
  importFromTemplate,
} from '../../src/services/training-service.js';

const makeTraining = (overrides = {}) => ({
  id: 'tr1',
  trainingProtocolId: 'p1',
  name: 'Training A',
  deletedAt: null,
  trainingProtocol: {
    id: 'p1',
    trainerId: 't1',
    assigneeId: 'u-student',
    deletedAt: null,
  },
  ...overrides,
});

describe('training-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getTrainingById', () => {
    it('throws TRAINING_NOT_FOUND when training does not exist', async () => {
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training is soft-deleted', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining({ deletedAt: new Date() }));

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when parent protocol is soft-deleted', async () => {
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 't1', assigneeId: 'u-student', deletedAt: new Date() },
        }),
      );

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINER_PROFILE_MISSING when trainer profile does not exist', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own the training', async () => {
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 'other-trainer', assigneeId: 'u-student', deletedAt: null },
        }),
      );
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      await expect(getTrainingById('u1', 'tr1', 'trainer')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_TRAINING when student is not the assignee', async () => {
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 't1', assigneeId: 'other-user', deletedAt: null },
        }),
      );

      await expect(getTrainingById('u1', 'tr1', 'assignee')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_TRAINING',
        statusCode: 403,
      });
    });

    it('returns training when trainer owns it', async () => {
      const training = makeTraining();
      prisma.training.findUnique.mockResolvedValue(training);
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      const result = await getTrainingById('u1', 'tr1', 'trainer');

      expect(result).toEqual(training);
    });

    it('returns training when student is the assignee', async () => {
      const training = makeTraining();
      prisma.training.findUnique.mockResolvedValue(training);

      const result = await getTrainingById('u-student', 'tr1', 'assignee');

      expect(result).toEqual(training);
    });
  });

  describe('updateTraining', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
      expect(prisma.training.findUnique).not.toHaveBeenCalled();
    });

    it('throws TRAINING_NOT_FOUND when training does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining({ deletedAt: new Date() }));

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when parent protocol is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: new Date() },
        }),
      );

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 'other-trainer', deletedAt: null },
        }),
      );

      await expect(updateTraining('u1', 'tr1', { name: 'New' })).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('updates and returns training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const updated = makeTraining({ name: 'New Name' });
      prisma.training.update.mockResolvedValue(updated);

      const result = await updateTraining('u1', 'tr1', { name: 'New Name' });

      expect(result).toEqual(updated);
      expect(prisma.training.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tr1' },
          data: expect.objectContaining({ name: 'New Name' }),
        }),
      );
    });

    it('clears weekDay when null is passed', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining({ weekDay: 'monday' }));
      const updated = makeTraining({ weekDay: null });
      prisma.training.update.mockResolvedValue(updated);

      const result = await updateTraining('u1', 'tr1', { weekDay: null });

      expect(result).toEqual(updated);
      expect(prisma.training.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tr1' },
          data: expect.objectContaining({ weekDay: null }),
        }),
      );
    });
  });

  describe('importFromTemplate', () => {
    const makeJunctionRow = (overrides = {}) => ({
      exerciseTemplateId: 'et-1',
      name: 'Supino',
      type: 'strength',
      videoUrl: 'https://example.com/video',
      order: 0,
      sets: 3,
      repetitions: { min: 8, max: 12 },
      duration: null,
      hasLoad: true,
      suggestedLoad: 60,
      restInterval: 90,
      notes: 'Keep back straight',
      ...overrides,
    });

    const makeTemplate = (overrides = {}) => ({
      id: 'tmpl-1',
      trainerId: 't1',
      name: 'Leg Day',
      description: 'Treino de pernas',
      category: 'strength',
      bodySegment: 'lower',
      deletedAt: null,
      isPublic: false,
      trainingTemplateExerciseTemplates: [],
      ...overrides,
    });

    beforeEach(() => {
      prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
      // recomputeTrainingDuration calls tx.exercise.findMany and tx.training.update
      prisma.exercise.findMany.mockResolvedValue([]);
      prisma.training.update.mockResolvedValue({});
    });

    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(importFromTemplate('u1', 'p1', 'tmpl-1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws TEMPLATE_NOT_FOUND when template does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(null);

      await expect(importFromTemplate('u1', 'p1', 'tmpl-1')).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TEMPLATE_NOT_FOUND when template is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate({ deletedAt: new Date() }));

      await expect(importFromTemplate('u1', 'p1', 'tmpl-1')).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_PRIVATE_TEMPLATE when template belongs to another trainer and is not public', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainerId: 'other-trainer', isPublic: false }),
      );

      await expect(importFromTemplate('u1', 'p1', 'tmpl-1')).rejects.toMatchObject({
        code: 'FORBIDDEN_PRIVATE_TEMPLATE',
        statusCode: 403,
      });
    });

    it('does not throw FORBIDDEN_PRIVATE_TEMPLATE when template belongs to another trainer but is public', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainerId: 'other-trainer', isPublic: true }),
      );
      const createdTraining = { id: 'tr-1', exercises: [] };
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue(createdTraining);

      const result = await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(result).toEqual(createdTraining);
    });

    it('imports template with zero exercises and returns exercises as empty array', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(makeTemplate({ trainingTemplateExerciseTemplates: [] }));
      const createdTraining = { id: 'tr-1', exercises: [] };
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue(createdTraining);

      const result = await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(result.exercises).toEqual([]);
      expect(prisma.exercise.create).not.toHaveBeenCalled();
    });

    it('imports template with N>=2 exercises and returns them in correct order', async () => {
      const junctionRow1 = makeJunctionRow({ exerciseTemplateId: 'et-1', order: 0, name: 'Supino' });
      const junctionRow2 = makeJunctionRow({
        exerciseTemplateId: 'et-2',
        order: 1,
        name: 'Crucifixo',
        videoUrl: null,
        hasLoad: false,
        suggestedLoad: null,
        restInterval: 60,
        notes: null,
      });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow1, junctionRow2] }),
      );

      const ex1 = { id: 'ex-1', order: 0, name: 'Supino' };
      const ex2 = { id: 'ex-2', order: 1, name: 'Crucifixo' };
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [ex1, ex2] });

      const result = await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(result.exercises).toHaveLength(2);
      expect(result.exercises[0].order).toBe(0);
      expect(result.exercises[1].order).toBe(1);
    });

    it('snapshots all exercise fields field-by-field including restInterval, repetitions, hasLoad, suggestedLoad, videoUrl, notes', async () => {
      const junctionRow = makeJunctionRow();

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow] }),
      );
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });

      await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(prisma.exercise.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trainingId: 'tr-1',
            exerciseTemplateId: junctionRow.exerciseTemplateId,
            name: junctionRow.name,
            type: junctionRow.type,
            videoUrl: junctionRow.videoUrl,
            order: junctionRow.order,
            sets: junctionRow.sets,
            repetitions: junctionRow.repetitions,
            duration: junctionRow.duration,
            hasLoad: junctionRow.hasLoad,
            suggestedLoad: junctionRow.suggestedLoad,
            restInterval: junctionRow.restInterval,
            notes: junctionRow.notes,
          }),
        }),
      );
    });

    it('regression: non-null restInterval from junction row is copied to Exercise', async () => {
      const junctionRow = makeJunctionRow({ restInterval: 120 });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow] }),
      );
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });

      await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(prisma.exercise.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ restInterval: 120 }),
        }),
      );
    });

    it('snapshots prescriptionMode from junction row and applies exclusivity for reps mode', async () => {
      const junctionRow = makeJunctionRow({
        prescriptionMode: 'reps',
        repetitions: { min: 8, max: 12 },
        duration: null,
      });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow] }),
      );
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });

      await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(prisma.exercise.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            prescriptionMode: 'reps',
            repetitions: { min: 8, max: 12 },
            duration: null,
          }),
        }),
      );
    });

    it('snapshots prescriptionMode from junction row and applies exclusivity for duration mode', async () => {
      const junctionRow = makeJunctionRow({
        prescriptionMode: 'duration',
        duration: 45,
        repetitions: null,
      });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow] }),
      );
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });

      await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(prisma.exercise.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            prescriptionMode: 'duration',
            duration: 45,
            repetitions: null,
          }),
        }),
      );
    });

    it('regression C1: cleans dirty junction row that has both repetitions and duration set when mode is duration', async () => {
      // Simulates legacy data: junction row has both fields populated
      const junctionRow = makeJunctionRow({
        prescriptionMode: 'duration',
        duration: 30,
        repetitions: { min: 10, max: 10 }, // dirty — should be nulled by exclusivity
      });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow] }),
      );
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });

      await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(prisma.exercise.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            prescriptionMode: 'duration',
            duration: 30,
            repetitions: null,
          }),
        }),
      );
    });

    it('regression C1: cleans dirty junction row that has both repetitions and duration set when mode is reps', async () => {
      const junctionRow = makeJunctionRow({
        prescriptionMode: 'reps',
        repetitions: { min: 8, max: 12 },
        duration: 45, // dirty — should be nulled by exclusivity
      });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow] }),
      );
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });

      await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(prisma.exercise.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            prescriptionMode: 'reps',
            repetitions: { min: 8, max: 12 },
            duration: null,
          }),
        }),
      );
    });

    it('regression C1: infers duration mode from junction row with null prescriptionMode when duration set and repetitions null', async () => {
      const junctionRow = makeJunctionRow({
        prescriptionMode: null,
        duration: 60,
        repetitions: null,
      });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow] }),
      );
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });

      await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(prisma.exercise.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            prescriptionMode: 'duration',
            duration: 60,
            repetitions: null,
          }),
        }),
      );
    });

    it('rolls back when one of the exercise.create calls rejects', async () => {
      const junctionRow1 = makeJunctionRow({ order: 0 });
      const junctionRow2 = makeJunctionRow({ exerciseTemplateId: 'et-2', order: 1 });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue(
        makeTemplate({ trainingTemplateExerciseTemplates: [junctionRow1, junctionRow2] }),
      );
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.exercise.create
        .mockResolvedValueOnce({ id: 'ex-1' })
        .mockRejectedValueOnce(new Error('DB error'));

      // When the transaction itself throws, $transaction should propagate the error
      prisma.$transaction.mockImplementationOnce(async (fn) => {
        await fn(prisma);
      });

      await expect(importFromTemplate('u1', 'p1', 'tmpl-1')).rejects.toThrow('DB error');

      // The training was not returned (transaction did not complete)
      expect(prisma.training.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('deleteTraining', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining({ deletedAt: new Date() }));

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when parent protocol is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: new Date() },
        }),
      );

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'p1', trainerId: 'other-trainer', deletedAt: null },
        }),
      );

      await expect(deleteTraining('u1', 'tr1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('soft deletes training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const deleted = makeTraining({ deletedAt: new Date() });
      prisma.training.update.mockResolvedValue(deleted);

      const result = await deleteTraining('u1', 'tr1');

      expect(result).toEqual(deleted);
      expect(prisma.training.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tr1' },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });
  });

  describe('createTraining — estimated duration', () => {
    it('persists estimatedDurationSeconds: 0 on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      const created = { id: 'tr-1', estimatedDurationSeconds: 0 };
      prisma.training.create.mockResolvedValue(created);

      const result = await createTraining('u1', 'p1', { name: 'Leg Day', category: 'strength' });

      expect(result).toEqual(created);
      expect(prisma.training.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ estimatedDurationSeconds: 0 }),
        }),
      );
    });
  });

  describe('importFromTemplate — estimated duration', () => {
    const makeJunctionRow = (overrides = {}) => ({
      exerciseTemplateId: 'et-1',
      name: 'Squat',
      type: 'strength',
      order: 0,
      sets: 3,
      repetitions: { min: 8, max: 12 },
      duration: null,
      prescriptionMode: 'reps',
      hasLoad: false,
      suggestedLoad: null,
      restInterval: 60,
      notes: null,
      videoUrl: null,
      supersetGroupId: null,
      supersetOrder: 0,
      ...overrides,
    });

    beforeEach(() => {
      prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
      prisma.exercise.findMany.mockResolvedValue([]);
      prisma.training.update.mockResolvedValue({});
    });

    it('calls training.update with estimatedDurationSeconds after import', async () => {
      const junction = makeJunctionRow({ sets: 3, repetitions: { min: 10, max: 10 }, restInterval: 60 });
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.trainingProtocol.findUnique.mockResolvedValue({ id: 'p1', trainerId: 't1', deletedAt: null });
      prisma.trainingTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-1',
        trainerId: 't1',
        name: 'Leg Day',
        description: null,
        category: 'strength',
        bodySegment: null,
        deletedAt: null,
        isPublic: false,
        trainingTemplateExerciseTemplates: [junction],
      });
      prisma.training.create.mockResolvedValue({ id: 'tr-1' });
      prisma.exercise.create.mockResolvedValue({ id: 'ex-1' });
      prisma.exercise.findMany.mockResolvedValue([
        { sets: 3, repetitions: { min: 10, max: 10 }, duration: null, prescriptionMode: 'reps', restInterval: 60, substituteForExerciseId: null },
      ]);
      prisma.training.findUnique.mockResolvedValue({ id: 'tr-1', exercises: [] });

      await importFromTemplate('u1', 'p1', 'tmpl-1');

      expect(prisma.training.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tr-1' },
          data: { estimatedDurationSeconds: expect.any(Number) },
        }),
      );

      const updateCall = prisma.training.update.mock.calls.find(
        ([arg]) => arg?.data?.estimatedDurationSeconds !== undefined,
      );
      expect(updateCall[0].data.estimatedDurationSeconds).toBeGreaterThan(0);
    });
  });

});

