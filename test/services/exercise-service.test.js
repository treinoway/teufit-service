import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    exercise: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    training: { findUnique: vi.fn() },
    exerciseTemplate: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import {
  createExercise,
  getExerciseById,
  updateExercise,
  deleteExercise,
} from '../../src/services/exercise-service.js';

const makeExercise = (overrides = {}) => ({
  id: 'ex1',
  trainingId: 'tr1',
  name: 'Squat',
  deletedAt: null,
  training: {
    id: 'tr1',
    deletedAt: null,
    trainingProtocol: {
      id: 'p1',
      trainerId: 't1',
      assigneeId: 'u-student',
      deletedAt: null,
    },
  },
  ...overrides,
});

const makeTraining = (overrides = {}) => ({
  id: 'tr1',
  deletedAt: null,
  trainingProtocol: {
    id: 'p1',
    trainerId: 't1',
    assigneeId: 'u-student',
    deletedAt: null,
  },
  ...overrides,
});

describe('exercise-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createExercise', () => {
    it('throws INVALID_REPETITIONS when repetitions.min is 0', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());

      await expect(
        createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', repetitions: { min: 0, max: 10 } }),
      ).rejects.toMatchObject({ code: 'INVALID_REPETITIONS', statusCode: 400 });

      expect(prisma.exercise.create).not.toHaveBeenCalled();
    });

    it('throws INVALID_REPETITIONS when repetitions.max is a float', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());

      await expect(
        createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', repetitions: { min: 8, max: 12.5 } }),
      ).rejects.toMatchObject({ code: 'INVALID_REPETITIONS', statusCode: 400 });
    });

    it('creates exercise with valid repetitions object', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', name: 'Squat', repetitions: { min: 8, max: 12 } };
      prisma.exercise.create.mockResolvedValue(created);

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        repetitions: { min: 8, max: 12 },
      });

      expect(result).toEqual(created);
      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ repetitions: { min: 8, max: 12 } }),
      });
    });
  });

  describe('getExerciseById', () => {
    it('throws EXERCISE_NOT_FOUND when exercise does not exist', async () => {
      prisma.exercise.findUnique.mockResolvedValue(null);

      await expect(getExerciseById('u1', 'ex1', 'trainer')).rejects.toMatchObject({
        code: 'EXERCISE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws EXERCISE_NOT_FOUND when exercise is soft-deleted', async () => {
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ deletedAt: new Date() }));

      await expect(getExerciseById('u1', 'ex1', 'trainer')).rejects.toMatchObject({
        code: 'EXERCISE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINER_PROFILE_MISSING when trainer profile does not exist', async () => {
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getExerciseById('u1', 'ex1', 'trainer')).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own the training', async () => {
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({
          training: {
            id: 'tr1',
            deletedAt: null,
            trainingProtocol: { id: 'p1', trainerId: 'other-trainer', assigneeId: 'u-student', deletedAt: null },
          },
        }),
      );
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      await expect(getExerciseById('u1', 'ex1', 'trainer')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_PROTOCOL_OWNER',
        statusCode: 403,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_EXERCISE when assignee is not the protocol assignee', async () => {
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({
          training: {
            id: 'tr1',
            deletedAt: null,
            trainingProtocol: { id: 'p1', trainerId: 't1', assigneeId: 'other-user', deletedAt: null },
          },
        }),
      );

      await expect(getExerciseById('u1', 'ex1', 'assignee')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_EXERCISE',
        statusCode: 403,
      });
    });

    it('returns exercise when trainer owns it', async () => {
      const exercise = makeExercise();
      prisma.exercise.findUnique.mockResolvedValue(exercise);
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      const result = await getExerciseById('u1', 'ex1', 'trainer');
      expect(result).toEqual(exercise);
    });

    it('returns exercise when assignee is protocol assignee', async () => {
      const exercise = makeExercise();
      prisma.exercise.findUnique.mockResolvedValue(exercise);

      const result = await getExerciseById('u-student', 'ex1', 'assignee');
      expect(result).toEqual(exercise);
    });
  });

  describe('createExercise', () => {
    const makeTraining = () => ({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: null },
    });

    it('persists notes when provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', notes: 'Keep back straight' };
      prisma.exercise.create.mockResolvedValue(created);

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        notes: 'Keep back straight',
      });

      expect(result).toEqual(created);
      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notes: 'Keep back straight' }),
      });
    });

    it('sets notes to null when not provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', notes: null };
      prisma.exercise.create.mockResolvedValue(created);

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notes: null }),
      });
    });

    it('persists restInterval when provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', restInterval: 90 };
      prisma.exercise.create.mockResolvedValue(created);

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        restInterval: 90,
      });

      expect(result).toEqual(created);
      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ restInterval: 90 }),
      });
    });

    it('sets restInterval to null when not provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', restInterval: null };
      prisma.exercise.create.mockResolvedValue(created);

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ restInterval: null }),
      });
    });
  });

  describe('updateExercise', () => {
    it('throws EXERCISE_NOT_FOUND when exercise does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(null);

      await expect(updateExercise('u1', 'ex1', { name: 'Updated' })).rejects.toMatchObject({
        code: 'EXERCISE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('updates notes when notes is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const updated = { id: 'ex1', notes: 'Exhale on the way up' };
      prisma.exercise.update.mockResolvedValue(updated);

      const result = await updateExercise('u1', 'ex1', { notes: 'Exhale on the way up' });

      expect(result).toEqual(updated);
      expect(prisma.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ notes: 'Exhale on the way up' }),
      });
    });

    it('sets notes to null when notes is explicitly null', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const updated = { id: 'ex1', notes: null };
      prisma.exercise.update.mockResolvedValue(updated);

      await updateExercise('u1', 'ex1', { notes: null });

      expect(prisma.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ notes: null }),
      });
    });

    it('does not include notes in update payload when notes is not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      prisma.exercise.update.mockResolvedValue({ id: 'ex1', name: 'Lunge' });

      await updateExercise('u1', 'ex1', { name: 'Lunge' });

      const callData = prisma.exercise.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty('notes');
    });

    it('updates restInterval when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const updated = { id: 'ex1', restInterval: 60 };
      prisma.exercise.update.mockResolvedValue(updated);

      const result = await updateExercise('u1', 'ex1', { restInterval: 60 });

      expect(result).toEqual(updated);
      expect(prisma.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ restInterval: 60 }),
      });
    });

    it('sets restInterval to null when explicitly null', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const updated = { id: 'ex1', restInterval: null };
      prisma.exercise.update.mockResolvedValue(updated);

      await updateExercise('u1', 'ex1', { restInterval: null });

      expect(prisma.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ restInterval: null }),
      });
    });

    it('does not include restInterval in update payload when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      prisma.exercise.update.mockResolvedValue({ id: 'ex1', name: 'Lunge' });

      await updateExercise('u1', 'ex1', { name: 'Lunge' });

      const callData = prisma.exercise.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty('restInterval');
    });

    it('throws INVALID_REPETITIONS when repetitions.min is not a positive integer', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());

      await expect(
        updateExercise('u1', 'ex1', { repetitions: { min: -1, max: 10 } }),
      ).rejects.toMatchObject({ code: 'INVALID_REPETITIONS', statusCode: 400 });

      expect(prisma.exercise.update).not.toHaveBeenCalled();
    });

    it('throws INVALID_REPETITIONS when repetitions.max is 0', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());

      await expect(
        updateExercise('u1', 'ex1', { repetitions: { min: 8, max: 0 } }),
      ).rejects.toMatchObject({ code: 'INVALID_REPETITIONS', statusCode: 400 });
    });
  });

  describe('deleteExercise', () => {
    it('throws EXERCISE_NOT_FOUND when exercise does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(null);

      await expect(deleteExercise('u1', 'ex1')).rejects.toMatchObject({
        code: 'EXERCISE_NOT_FOUND',
        statusCode: 404,
      });
    });
  });
});
