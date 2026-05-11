import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    exercise: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    training: { findUnique: vi.fn() },
    exerciseTemplate: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import {
  createExercise,
  getExerciseById,
  updateExercise,
  deleteExercise,
  reorderExercisesInTraining,
  addSubstitute,
  reorderSubstitutes,
  reorderSupersetMembers,
} from '../../src/services/exercise-service.js';
import { SupersetMessageCode, SubstituteMessageCode } from '../../src/constants/training.js';

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
      const created = { id: 'ex1', name: 'Squat', repetitions: { min: 8, max: 12 }, prescriptionMode: 'reps' };
      prisma.exercise.create.mockResolvedValue(created);

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        repetitions: { min: 8, max: 12 },
      });

      expect(result).toEqual(created);
      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ repetitions: { min: 8, max: 12 }, prescriptionMode: 'reps' }),
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
      const exercise = makeExercise({ prescriptionMode: 'reps' });
      prisma.exercise.findUnique.mockResolvedValue(exercise);
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });

      const result = await getExerciseById('u1', 'ex1', 'trainer');
      expect(result).toEqual(exercise);
    });

    it('returns exercise when assignee is protocol assignee', async () => {
      const exercise = makeExercise({ prescriptionMode: 'reps' });
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
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', notes: 'Keep back straight', prescriptionMode: 'reps' };
      prisma.exercise.create.mockResolvedValue(created);

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        notes: 'Keep back straight',
      });

      expect(result).toEqual(created);
      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notes: 'Keep back straight', prescriptionMode: 'reps' }),
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
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', restInterval: 90, prescriptionMode: 'reps' };
      prisma.exercise.create.mockResolvedValue(created);

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        restInterval: 90,
      });

      expect(result).toEqual(created);
      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ restInterval: 90, prescriptionMode: 'reps' }),
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

    it('persists duration mode and nulls repetitions when prescriptionMode is "duration"', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.create.mockResolvedValue({ id: 'ex1', prescriptionMode: 'duration' });

      await createExercise('u1', 'tr1', { name: 'Plank', type: 'strength', prescriptionMode: 'duration', duration: 45 });

      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ prescriptionMode: 'duration', duration: 45, repetitions: null }),
      });
    });

    it('persists reps mode and nulls duration when prescriptionMode is "reps"', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.create.mockResolvedValue({ id: 'ex1', prescriptionMode: 'reps' });

      await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        prescriptionMode: 'reps',
        repetitions: { min: 8, max: 12 },
      });

      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ prescriptionMode: 'reps', repetitions: { min: 8, max: 12 }, duration: null }),
      });
    });

    it('defaults to "reps" mode when prescriptionMode is not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.create.mockResolvedValue({ id: 'ex1', prescriptionMode: 'reps' });

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(prisma.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ prescriptionMode: 'reps' }),
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
      const updated = { id: 'ex1', notes: 'Exhale on the way up', prescriptionMode: 'reps' };
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
      const updated = { id: 'ex1', restInterval: 60, prescriptionMode: 'reps' };
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

    it('sets prescriptionMode to "duration" and nulls repetitions when switching to duration mode', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      prisma.exercise.update.mockResolvedValue({ id: 'ex1', prescriptionMode: 'duration' });

      await updateExercise('u1', 'ex1', { prescriptionMode: 'duration', duration: 60 });

      expect(prisma.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ prescriptionMode: 'duration', duration: 60, repetitions: null }),
      });
    });

    it('sets prescriptionMode to "reps" and nulls duration when switching to reps mode', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      prisma.exercise.update.mockResolvedValue({ id: 'ex1', prescriptionMode: 'reps' });

      await updateExercise('u1', 'ex1', { prescriptionMode: 'reps', repetitions: { min: 6, max: 10 } });

      expect(prisma.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ prescriptionMode: 'reps', repetitions: { min: 6, max: 10 }, duration: null }),
      });
    });

    it('does not include prescriptionMode in update payload when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      prisma.exercise.update.mockResolvedValue({ id: 'ex1' });

      await updateExercise('u1', 'ex1', { name: 'Lunge' });

      const callData = prisma.exercise.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty('prescriptionMode');
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

    it('M1: throws VALIDATION_ERROR when flipping to reps mode without providing repetitions', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());

      await expect(
        updateExercise('u1', 'ex1', { prescriptionMode: 'reps' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

      expect(prisma.exercise.update).not.toHaveBeenCalled();
    });

    it('M1: throws VALIDATION_ERROR when flipping to reps mode with repetitions explicitly null', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());

      await expect(
        updateExercise('u1', 'ex1', { prescriptionMode: 'reps', repetitions: null }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

      expect(prisma.exercise.update).not.toHaveBeenCalled();
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

  describe('reorderExercisesInTraining', () => {
    const makeTrainingWithExercises = (exercises = [], overrides = {}) => ({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: {
        id: 'p1',
        trainerId: 't1',
        deletedAt: null,
      },
      exercises,
      ...overrides,
    });

    const activeExercises = [
      { id: 'ex1', name: 'Squat' },
      { id: 'ex2', name: 'Lunge' },
      { id: 'ex3', name: 'Deadlift' },
    ];

    function setupHappyPath(exerciseIds = ['ex3', 'ex1', 'ex2']) {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingWithExercises(activeExercises));

      const txMock = { exercise: { update: vi.fn().mockResolvedValue({}) } };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      return { txMock, exerciseIds };
    }

    it('returns trainingId and exercises in new order on success', async () => {
      const { exerciseIds } = setupHappyPath(['ex3', 'ex1', 'ex2']);

      const result = await reorderExercisesInTraining('u1', 'tr1', exerciseIds);

      expect(result).toEqual({
        trainingId: 'tr1',
        exercises: [
          { id: 'ex3', name: 'Deadlift', order: 0 },
          { id: 'ex1', name: 'Squat', order: 1 },
          { id: 'ex2', name: 'Lunge', order: 2 },
        ],
      });
    });

    it('updates each exercise with its index as order inside a transaction', async () => {
      const { txMock } = setupHappyPath(['ex3', 'ex1', 'ex2']);

      await reorderExercisesInTraining('u1', 'tr1', ['ex3', 'ex1', 'ex2']);

      expect(prisma.$transaction).toHaveBeenCalledOnce();
      expect(txMock.exercise.update).toHaveBeenCalledTimes(3);
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'ex3' }, data: { order: 0 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'ex1' }, data: { order: 1 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'ex2' }, data: { order: 2 } });
    });

    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'ex3']),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws TRAINING_NOT_FOUND when training does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1']),
      ).rejects.toMatchObject({ code: 'TRAINING_NOT_FOUND', statusCode: 404 });
    });

    it('throws TRAINING_NOT_FOUND when training is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTrainingWithExercises(activeExercises, { deletedAt: new Date() }),
      );

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'ex3']),
      ).rejects.toMatchObject({ code: 'TRAINING_NOT_FOUND', statusCode: 404 });
    });

    it('throws TRAINING_NOT_FOUND when protocol is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTrainingWithExercises(activeExercises, {
          trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: new Date() },
        }),
      );

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'ex3']),
      ).rejects.toMatchObject({ code: 'TRAINING_NOT_FOUND', statusCode: 404 });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own the protocol', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(
        makeTrainingWithExercises(activeExercises, {
          trainingProtocol: { id: 'p1', trainerId: 'other-trainer', deletedAt: null },
        }),
      );

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'ex3']),
      ).rejects.toMatchObject({ code: 'FORBIDDEN_NOT_PROTOCOL_OWNER', statusCode: 403 });
    });

    it('throws VALIDATION_ERROR with details when exerciseIds is empty', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingWithExercises(activeExercises));

      await expect(
        reorderExercisesInTraining('u1', 'tr1', []),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        statusCode: 400,
        details: expect.objectContaining({ reason: expect.stringContaining('non-empty') }),
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws VALIDATION_ERROR with duplicates detail when exerciseIds contains duplicates', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingWithExercises(activeExercises));

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'ex1']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        statusCode: 400,
        details: expect.objectContaining({ reason: 'duplicate IDs', duplicates: ['ex1'] }),
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws VALIDATION_ERROR when fewer IDs are passed than active exercises', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingWithExercises(activeExercises));

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        statusCode: 400,
        details: expect.objectContaining({ reason: 'length mismatch', expected: 3, received: 2 }),
      });
    });

    it('throws VALIDATION_ERROR when more IDs are passed than active exercises', async () => {
      // Any extra ID is by definition unknown — unknown-ID check fires before length-mismatch.
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingWithExercises(activeExercises));

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'ex3', 'ex-extra']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        statusCode: 400,
        details: expect.objectContaining({
          reason: 'unknown or soft-deleted exercise IDs',
          unknownIds: ['ex-extra'],
        }),
      });
    });

    it('throws VALIDATION_ERROR with unknownIds detail when an ID does not belong to this training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingWithExercises(activeExercises));

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'ex-foreign']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        statusCode: 400,
        details: expect.objectContaining({ reason: 'unknown or soft-deleted exercise IDs', unknownIds: ['ex-foreign'] }),
      });
    });

    it('excludes soft-deleted exercises from the active count and rejects them if passed', async () => {
      const exercisesWithDeleted = [
        { id: 'ex1', name: 'Squat' },
        { id: 'ex2', name: 'Lunge' },
        // ex-deleted is intentionally absent because the query uses `deletedAt: null`
      ];
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingWithExercises(exercisesWithDeleted));

      // Passing the soft-deleted ID: length matches (2) but the ID is not in the active set
      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex-deleted']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        statusCode: 400,
        details: expect.objectContaining({ reason: 'unknown or soft-deleted exercise IDs' }),
      });
    });

    it('rolls back all updates when the transaction callback throws', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingWithExercises(activeExercises));

      const dbError = new Error('DB constraint violation');
      prisma.$transaction.mockRejectedValue(dbError);

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'ex3']),
      ).rejects.toThrow('DB constraint violation');
    });
  });

  // ─── reorderExercisesInTraining — substitute + superset rules ────────────────

  describe('reorderExercisesInTraining — substitute and superset validation', () => {
    it('rejects when a substitute ID is included in the payload', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue({
        id: 'tr1',
        deletedAt: null,
        trainingProtocol: { trainerId: 't1', deletedAt: null },
        exercises: [
          { id: 'ex1', name: 'Squat', substituteForExerciseId: null, supersetGroupId: null },
          { id: 'ex2', name: 'Lunge', substituteForExerciseId: null, supersetGroupId: null },
          { id: 'sub1', name: 'Leg Press', substituteForExerciseId: 'ex1', supersetGroupId: null },
        ],
      });

      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex2', 'sub1']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        statusCode: 400,
        details: expect.objectContaining({ substituteIds: ['sub1'] }),
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects reorder that splits a superset group', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue({
        id: 'tr1',
        deletedAt: null,
        trainingProtocol: { trainerId: 't1', deletedAt: null },
        exercises: [
          { id: 'ex1', name: 'Bench', substituteForExerciseId: null, supersetGroupId: 'group-a' },
          { id: 'ex2', name: 'Flye', substituteForExerciseId: null, supersetGroupId: 'group-a' },
          { id: 'ex3', name: 'Squat', substituteForExerciseId: null, supersetGroupId: null },
        ],
      });

      // Attempt to split the group: ex3 placed between ex1 and ex2
      await expect(
        reorderExercisesInTraining('u1', 'tr1', ['ex1', 'ex3', 'ex2']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: SupersetMessageCode.MEMBERSHIP_INVALID,
        statusCode: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts reorder that keeps superset group members contiguous', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue({
        id: 'tr1',
        deletedAt: null,
        trainingProtocol: { trainerId: 't1', deletedAt: null },
        exercises: [
          { id: 'ex1', name: 'Bench', substituteForExerciseId: null, supersetGroupId: 'group-a' },
          { id: 'ex2', name: 'Flye', substituteForExerciseId: null, supersetGroupId: 'group-a' },
          { id: 'ex3', name: 'Squat', substituteForExerciseId: null, supersetGroupId: null },
        ],
      });

      const txMock = { exercise: { update: vi.fn().mockResolvedValue({}) } };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      // Move the superset group after ex3 — still contiguous
      const result = await reorderExercisesInTraining('u1', 'tr1', ['ex3', 'ex1', 'ex2']);

      expect(result.trainingId).toBe('tr1');
      expect(result.exercises).toHaveLength(3);
      expect(prisma.$transaction).toHaveBeenCalledOnce();
    });
  });

  // ─── deleteExercise — cascade behavior ───────────────────────────────────────

  describe('deleteExercise — cascade and superset cleanup', () => {
    it('soft-deletes all substitutes when principal is deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: null, supersetGroupId: null }),
      );

      const txMock = {
        exercise: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      expect(txMock.exercise.updateMany).toHaveBeenCalledWith({
        where: { substituteForExerciseId: 'ex1', deletedAt: null },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      });
    });

    it('clears supersetGroupId on remaining member when group drops to 1', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: null, supersetGroupId: 'group-a', trainingId: 'tr1' }),
      );

      // clearGroupIfUndersized now runs inside the transaction (Minor fix).
      // The txMock must include findMany (returns 1 remaining member) and updateMany.
      const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const txMock = {
        exercise: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: txUpdateMany,
          findMany: vi.fn().mockResolvedValue([{ id: 'ex2' }]), // 1 remaining → clear
        },
      };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      // The group-clear updateMany is called inside the transaction
      expect(txUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ supersetGroupId: 'group-a', deletedAt: null }),
          data: { supersetGroupId: null, supersetOrder: 0 },
        }),
      );
    });

    it('does not clear supersetGroupId when group still has 2+ members', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: null, supersetGroupId: 'group-a', trainingId: 'tr1' }),
      );

      // 2 remaining members → group survives, updateMany for group-clear NOT called
      const txUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
      const txMock = {
        exercise: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: txUpdateMany,
          findMany: vi.fn().mockResolvedValue([{ id: 'ex2' }, { id: 'ex3' }]), // 2 remaining
        },
      };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      // updateMany is only called to soft-delete substitutes (substituteForExerciseId filter),
      // not for the group-clear path.
      const groupClearCall = txUpdateMany.mock.calls.find(
        ([arg]) => arg?.data?.supersetGroupId === null,
      );
      expect(groupClearCall).toBeUndefined();
    });
  });

  // ─── addSubstitute ────────────────────────────────────────────────────────────

  describe('addSubstitute', () => {
    const makePrincipal = (overrides = {}) => ({
      id: 'principal-1',
      trainingId: 'tr1',
      deletedAt: null,
      substituteForExerciseId: null,
      supersetGroupId: null,
      training: {
        deletedAt: null,
        trainingProtocol: { trainerId: 't1', deletedAt: null },
      },
      ...overrides,
    });

    it('throws TRAINER_PROFILE_MISSING when trainer does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength' }),
      ).rejects.toMatchObject({ code: 'TRAINER_PROFILE_MISSING', statusCode: 404 });
    });

    it('throws EXERCISE_NOT_FOUND when principal does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(null);

      await expect(
        addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength' }),
      ).rejects.toMatchObject({ code: 'EXERCISE_NOT_FOUND', statusCode: 404 });
    });

    it('throws FORBIDDEN_NOT_PROTOCOL_OWNER when trainer does not own the training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makePrincipal({ training: { deletedAt: null, trainingProtocol: { trainerId: 'other-trainer', deletedAt: null } } }),
      );

      await expect(
        addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN_NOT_PROTOCOL_OWNER', statusCode: 403 });
    });

    it('throws VALIDATION_ERROR with substituteCannotChain when principal is itself a substitute', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makePrincipal({ substituteForExerciseId: 'some-other-principal' }),
      );

      await expect(
        addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength' }),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: SubstituteMessageCode.CANNOT_CHAIN,
        statusCode: 400,
      });
    });

    // P1 fix: principal in superset is now ALLOWED (per plan edge case #4).
    // The constraint is on the CANDIDATE (substitute), not the principal.
    it('does NOT throw when principal is in a superset (P1 fix: bi-set member can have substitutes)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makePrincipal({ supersetGroupId: 'group-a' }),
      );

      const created = { id: 'sub-1', name: 'Alt', substituteOrder: 0, substituteForExerciseId: 'principal-1', prescriptionMode: 'reps' };
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          exercise: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(created),
          },
        };
        return fn(tx);
      });

      const result = await addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength' });
      expect(result).toEqual(created);
    });

    it('assigns substituteOrder 0 for the first substitute', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipal());
      const created = { id: 'sub-1', name: 'Alt', substituteOrder: 0, substituteForExerciseId: 'principal-1', prescriptionMode: 'reps' };

      // findFirst + create now run inside $transaction (Minor race-condition fix)
      const txCreate = vi.fn().mockResolvedValue(created);
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          exercise: {
            findFirst: vi.fn().mockResolvedValue(null), // no existing substitutes
            create: txCreate,
          },
        };
        return fn(tx);
      });

      const result = await addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength' });

      expect(result).toEqual(created);
      expect(txCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          substituteForExerciseId: 'principal-1',
          substituteOrder: 0,
          trainingId: 'tr1',
        }),
      });
    });

    it('assigns substituteOrder 1 when one substitute already exists', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipal());
      const created = { id: 'sub-2', substituteOrder: 1, prescriptionMode: 'reps' };

      // findFirst + create now run inside $transaction (Minor race-condition fix)
      const txCreate = vi.fn().mockResolvedValue(created);
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          exercise: {
            findFirst: vi.fn().mockResolvedValue({ substituteOrder: 0 }), // one existing
            create: txCreate,
          },
        };
        return fn(tx);
      });

      await addSubstitute('u1', 'principal-1', { name: 'Alt 2', type: 'strength' });

      expect(txCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ substituteOrder: 1 }),
      });
    });
  });

  // ─── reorderSubstitutes ───────────────────────────────────────────────────────

  describe('reorderSubstitutes', () => {
    const makePrincipalRow = (overrides = {}) => ({
      id: 'principal-1',
      trainingId: 'tr1',
      deletedAt: null,
      substituteForExerciseId: null,
      training: { deletedAt: null, trainingProtocol: { trainerId: 't1', deletedAt: null } },
      ...overrides,
    });

    it('throws EXERCISE_NOT_FOUND when principal does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(null);

      await expect(
        reorderSubstitutes('u1', 'principal-1', ['sub1', 'sub2']),
      ).rejects.toMatchObject({ code: 'EXERCISE_NOT_FOUND', statusCode: 404 });
    });

    it('throws VALIDATION_ERROR when list length does not match active substitutes', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipalRow());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'sub1', name: 'Alt 1' },
        { id: 'sub2', name: 'Alt 2' },
      ]);

      await expect(
        reorderSubstitutes('u1', 'principal-1', ['sub1']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        statusCode: 400,
        details: expect.objectContaining({ expected: 2, received: 1 }),
      });
    });

    it('throws VALIDATION_ERROR when unknown substitute IDs are provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipalRow());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'sub1', name: 'Alt 1' },
        { id: 'sub2', name: 'Alt 2' },
      ]);

      await expect(
        reorderSubstitutes('u1', 'principal-1', ['sub1', 'sub-unknown']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        details: expect.objectContaining({ unknownIds: ['sub-unknown'] }),
      });
    });

    it('updates substituteOrder in a transaction and returns result array', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipalRow());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'sub1', name: 'Alt 1' },
        { id: 'sub2', name: 'Alt 2' },
      ]);

      const txMock = { exercise: { update: vi.fn().mockResolvedValue({}) } };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      const result = await reorderSubstitutes('u1', 'principal-1', ['sub2', 'sub1']);

      expect(result).toEqual([
        { id: 'sub2', name: 'Alt 2', substituteOrder: 0 },
        { id: 'sub1', name: 'Alt 1', substituteOrder: 1 },
      ]);
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'sub2' }, data: { substituteOrder: 0 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'sub1' }, data: { substituteOrder: 1 } });
    });
  });

  // ─── reorderSupersetMembers ───────────────────────────────────────────────────

  describe('reorderSupersetMembers', () => {
    it('throws EXERCISE_NOT_FOUND (superset group not found) when no active members exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([]); // no members

      await expect(
        reorderSupersetMembers('u1', 'tr1', 'group-a', ['ex1', 'ex2']),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws VALIDATION_ERROR when list length does not match active members', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'ex1', name: 'Bench' },
        { id: 'ex2', name: 'Flye' },
      ]);

      await expect(
        reorderSupersetMembers('u1', 'tr1', 'group-a', ['ex1']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        details: expect.objectContaining({ expected: 2, received: 1 }),
      });
    });

    it('throws VALIDATION_ERROR with unknownIds when ID not in group', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'ex1', name: 'Bench' },
        { id: 'ex2', name: 'Flye' },
      ]);

      await expect(
        reorderSupersetMembers('u1', 'tr1', 'group-a', ['ex1', 'ex-unknown']),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        details: expect.objectContaining({ unknownIds: ['ex-unknown'] }),
      });
    });

    it('updates supersetOrder in a transaction and returns result array', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'ex1', name: 'Bench' },
        { id: 'ex2', name: 'Flye' },
      ]);

      const txMock = { exercise: { update: vi.fn().mockResolvedValue({}) } };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      const result = await reorderSupersetMembers('u1', 'tr1', 'group-a', ['ex2', 'ex1']);

      expect(result).toEqual([
        { id: 'ex2', name: 'Flye', supersetOrder: 0 },
        { id: 'ex1', name: 'Bench', supersetOrder: 1 },
      ]);
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'ex2' }, data: { supersetOrder: 0 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'ex1' }, data: { supersetOrder: 1 } });
    });
  });
});
