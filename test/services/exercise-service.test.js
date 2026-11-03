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
    training: { findUnique: vi.fn(), update: vi.fn() },
    exerciseTemplate: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import { advancedTechniqueLinksInclude } from '../../src/helpers/advanced-technique-refs.js';
import {
  createExercise,
  createFromTemplate,
  getExerciseById,
  updateExercise,
  deleteExercise,
  reorderExercisesInTraining,
  addSubstitute,
  reorderSubstitutes,
  reorderSupersetMembers,
  dissolveSuperset,
} from '../../src/services/exercise-service.js';
import { ExerciseIntensityMessageCode, SupersetMessageCode, SubstituteMessageCode } from '../../src/constants/training.js';

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

  describe('createExercise — validation', () => {
    it('throws INVALID_REPETITIONS when repetitions.min is 0', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());

      await expect(
        createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', repetitions: { min: 0, max: 10 } }),
      ).rejects.toMatchObject({ code: 'INVALID_REPETITIONS', statusCode: 400 });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws INVALID_REPETITIONS when repetitions.max is a float', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());

      await expect(
        createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', repetitions: { min: 8, max: 12.5 } }),
      ).rejects.toMatchObject({ code: 'INVALID_REPETITIONS', statusCode: 400 });
    });

    it('creates exercise with valid repetitions object via transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', name: 'Squat', repetitions: { min: 8, max: 12 }, prescriptionMode: 'reps' };
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          create: vi.fn().mockResolvedValue(created),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { order: null } }),
        },
        exerciseTemplate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        repetitions: { min: 8, max: 12 },
      });

      expect(result).toEqual(created);
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ repetitions: { min: 8, max: 12 }, prescriptionMode: 'reps' }),
        include: advancedTechniqueLinksInclude,
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

    function makeCreateTxMock(createdExercise, maxOrder = null) {
      return {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          create: vi.fn().mockResolvedValue(createdExercise),
          findMany: vi.fn().mockResolvedValue([createdExercise]),
          aggregate: vi.fn().mockResolvedValue({ _max: { order: maxOrder } }),
        },
        exerciseTemplate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
    }

    it('persists notes when provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', notes: 'Keep back straight', prescriptionMode: 'reps' };
      const txMock = makeCreateTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        notes: 'Keep back straight',
      });

      expect(result).toEqual(created);
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notes: 'Keep back straight', prescriptionMode: 'reps' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('sets notes to null when not provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', notes: null };
      const txMock = makeCreateTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notes: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('persists restInterval when provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', restInterval: 90, prescriptionMode: 'reps' };
      const txMock = makeCreateTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        restInterval: 90,
      });

      expect(result).toEqual(created);
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ restInterval: 90, prescriptionMode: 'reps' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('sets restInterval to null when not provided on create', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', trainingId: 'tr1', name: 'Squat', type: 'strength', restInterval: null };
      const txMock = makeCreateTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ restInterval: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('persists duration mode and nulls repetitions when prescriptionMode is "duration"', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', prescriptionMode: 'duration' };
      const txMock = makeCreateTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Plank', type: 'strength', prescriptionMode: 'duration', duration: 45 });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ prescriptionMode: 'duration', duration: 45, repetitions: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('persists reps mode and nulls duration when prescriptionMode is "reps"', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', prescriptionMode: 'reps' };
      const txMock = makeCreateTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', {
        name: 'Squat',
        type: 'strength',
        prescriptionMode: 'reps',
        repetitions: { min: 8, max: 12 },
      });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ prescriptionMode: 'reps', repetitions: { min: 8, max: 12 }, duration: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('defaults to "reps" mode when prescriptionMode is not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', prescriptionMode: 'reps' };
      const txMock = makeCreateTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ prescriptionMode: 'reps' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('calls recomputeTrainingDuration inside the transaction after creating the exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', sets: 3, repetitions: { min: 8, max: 12 }, prescriptionMode: 'reps', restInterval: 60, substituteForExerciseId: null, deletedAt: null };
      const txMock = makeCreateTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.training.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tr1' }, data: { estimatedDurationSeconds: expect.any(Number) } }),
      );
    });

    it('appends a new exercise to the end of the training (max order + 1)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex3', order: 2, prescriptionMode: 'reps' };
      const txMock = makeCreateTxMock(created, 1);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 2 }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('uses order 0 for the first exercise in an empty training', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', order: 0, prescriptionMode: 'reps' };
      const txMock = makeCreateTxMock(created, null);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 0 }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('respects an explicit order when provided (no append)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', order: 5, prescriptionMode: 'reps' };
      const txMock = makeCreateTxMock(created, 1);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', order: 5 });

      expect(txMock.exercise.aggregate).not.toHaveBeenCalled();
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 5 }),
        include: advancedTechniqueLinksInclude,
      });
    });
  });

  describe('createExercise — library template auto-creation', () => {
    const makeTraining = () => ({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: null },
    });

    function makeLibraryTxMock(createdExercise) {
      return {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          create: vi.fn().mockResolvedValue(createdExercise),
          findMany: vi.fn().mockResolvedValue([createdExercise]),
          aggregate: vi.fn().mockResolvedValue({ _max: { order: null } }),
        },
        exerciseTemplate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
    }

    it('creates a private template when none exists and links it to the exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const txMock = makeLibraryTxMock({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isPublic: false,
          trainerId: 't1',
          name: 'Squat',
          type: 'strength',
        }),
        select: { id: true },
      });
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ exerciseTemplateId: 'tpl1' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('reuses an existing template (dedup by name + type) without creating a new one', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const txMock = makeLibraryTxMock({ id: 'ex1', prescriptionMode: 'reps' });
      txMock.exerciseTemplate.findFirst.mockResolvedValue({ id: 'existing-tpl' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exerciseTemplate.create).not.toHaveBeenCalled();
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ exerciseTemplateId: 'existing-tpl' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('dedups by case-insensitive name + type + trainerId', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const txMock = makeLibraryTxMock({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exerciseTemplate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            trainerId: 't1',
            type: 'strength',
            name: { equals: 'Squat', mode: 'insensitive' },
            deletedAt: null,
          }),
        }),
      );
    });
  });

  describe('createExercise — intensity', () => {
    const makeTraining = () => ({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: null },
    });

    function makeIntensityTxMock(createdExercise) {
      return {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          create: vi.fn().mockResolvedValue(createdExercise),
          findMany: vi.fn().mockResolvedValue([createdExercise]),
          aggregate: vi.fn().mockResolvedValue({ _max: { order: null } }),
        },
        exerciseTemplate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
    }

    it('persists intensity when set on a cardio exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      const created = { id: 'ex1', type: 'cardio', intensity: 'moderate', prescriptionMode: 'duration' };
      const txMock = makeIntensityTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await createExercise('u1', 'tr1', {
        name: 'Running',
        type: 'cardio',
        prescriptionMode: 'duration',
        duration: 30,
        intensity: 'moderate',
      });

      expect(result).toEqual(created);
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'cardio', intensity: 'moderate' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('throws VALIDATION_ERROR with exercise.intensityRequiresCardio when intensity set on strength exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());

      await expect(
        createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', intensity: 'moderate' }),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: ExerciseIntensityMessageCode.INTENSITY_REQUIRES_CARDIO,
        statusCode: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('addSubstitute — library template auto-creation', () => {
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

    it('creates and links a library template for the new substitute', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipal());
      const created = { id: 'sub-1', name: 'Alt', substituteOrder: 0, substituteForExerciseId: 'principal-1', prescriptionMode: 'reps' };

      const txCreate = vi.fn().mockResolvedValue(created);
      const tplFindFirst = vi.fn().mockResolvedValue(null);
      const tplCreate = vi.fn().mockResolvedValue({ id: 'tpl1' });
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          exercise: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: txCreate,
          },
          exerciseTemplate: {
            findFirst: tplFindFirst,
            create: tplCreate,
          },
        };
        return fn(tx);
      });

      await addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength' });

      expect(tplFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            trainerId: 't1',
            type: 'strength',
            name: { equals: 'Alt', mode: 'insensitive' },
            deletedAt: null,
          }),
        }),
      );
      expect(tplCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ isPublic: false, trainerId: 't1', name: 'Alt', type: 'strength' }),
        select: { id: true },
      });
      expect(txCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ exerciseTemplateId: 'tpl1', substituteForExerciseId: 'principal-1' }),
        include: advancedTechniqueLinksInclude,
      });
    });
  });

  describe('updateExercise', () => {
    // updateExercise wraps the actual DB write in a prisma.$transaction with a
    // training row lock. Tests that reach the write path must wire up a txMock.
    function makeUpdateTxMock(updatedExercise) {
      return {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          update: vi.fn().mockResolvedValue(updatedExercise),
          findMany: vi.fn().mockResolvedValue([]),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
    }

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
      const txMock = makeUpdateTxMock(updated);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await updateExercise('u1', 'ex1', { notes: 'Exhale on the way up' });

      expect(result).toEqual(updated);
      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ notes: 'Exhale on the way up' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('sets notes to null when notes is explicitly null', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const updated = { id: 'ex1', notes: null };
      const txMock = makeUpdateTxMock(updated);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { notes: null });

      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ notes: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('does not include notes in update payload when notes is not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = makeUpdateTxMock({ id: 'ex1', name: 'Lunge' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { name: 'Lunge' });

      const callData = txMock.exercise.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty('notes');
    });

    it('updates restInterval when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const updated = { id: 'ex1', restInterval: 60, prescriptionMode: 'reps' };
      const txMock = makeUpdateTxMock(updated);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await updateExercise('u1', 'ex1', { restInterval: 60 });

      expect(result).toEqual(updated);
      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ restInterval: 60 }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('sets restInterval to null when explicitly null', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const updated = { id: 'ex1', restInterval: null };
      const txMock = makeUpdateTxMock(updated);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { restInterval: null });

      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ restInterval: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('does not include restInterval in update payload when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = makeUpdateTxMock({ id: 'ex1', name: 'Lunge' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { name: 'Lunge' });

      const callData = txMock.exercise.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty('restInterval');
    });

    it('sets prescriptionMode to "duration" and nulls repetitions when switching to duration mode', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = makeUpdateTxMock({ id: 'ex1', prescriptionMode: 'duration' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { prescriptionMode: 'duration', duration: 60 });

      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ prescriptionMode: 'duration', duration: 60, repetitions: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('sets prescriptionMode to "reps" and nulls duration when switching to reps mode', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = makeUpdateTxMock({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { prescriptionMode: 'reps', repetitions: { min: 6, max: 10 } });

      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ prescriptionMode: 'reps', repetitions: { min: 6, max: 10 }, duration: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('does not include prescriptionMode in update payload when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = makeUpdateTxMock({ id: 'ex1' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { name: 'Lunge' });

      const callData = txMock.exercise.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty('prescriptionMode');
    });

    it('throws INVALID_REPETITIONS when repetitions.min is not a positive integer', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());

      await expect(
        updateExercise('u1', 'ex1', { repetitions: { min: -1, max: 10 } }),
      ).rejects.toMatchObject({ code: 'INVALID_REPETITIONS', statusCode: 400 });

      expect(prisma.$transaction).not.toHaveBeenCalled();
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

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('M1: throws VALIDATION_ERROR when flipping to reps mode with repetitions explicitly null', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());

      await expect(
        updateExercise('u1', 'ex1', { prescriptionMode: 'reps', repetitions: null }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('recomputes training duration when sets is updated', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ trainingId: 'tr1' }));
      const txMock = makeUpdateTxMock({ id: 'ex1', sets: 4, prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { sets: 4 });

      expect(txMock.training.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tr1' }, data: { estimatedDurationSeconds: expect.any(Number) } }),
      );
    });

    it('recomputes training duration when restInterval is updated', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ trainingId: 'tr1' }));
      const txMock = makeUpdateTxMock({ id: 'ex1', restInterval: 90, prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { restInterval: 90 });

      expect(txMock.training.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tr1' }, data: { estimatedDurationSeconds: expect.any(Number) } }),
      );
    });

    it('does not recompute training duration when only notes is updated', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ trainingId: 'tr1' }));
      const txMock = makeUpdateTxMock({ id: 'ex1', notes: 'Exhale on the way up', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { notes: 'Exhale on the way up' });

      expect(txMock.training.update).not.toHaveBeenCalled();
    });

    it('does not recompute training duration when only name is updated', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ trainingId: 'tr1' }));
      const txMock = makeUpdateTxMock({ id: 'ex1', name: 'Squat v2', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { name: 'Squat v2' });

      expect(txMock.training.update).not.toHaveBeenCalled();
    });
  });

  describe('updateExercise — intensity', () => {
    function makeUpdateTxMock(updatedExercise) {
      return {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          update: vi.fn().mockResolvedValue(updatedExercise),
          findMany: vi.fn().mockResolvedValue([]),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
    }

    it('persists intensity when set on a cardio exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ type: 'cardio', intensity: null }));
      const updated = { id: 'ex1', type: 'cardio', intensity: 'vigorous', prescriptionMode: 'reps' };
      const txMock = makeUpdateTxMock(updated);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await updateExercise('u1', 'ex1', { intensity: 'vigorous' });

      expect(result).toEqual(updated);
      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ intensity: 'vigorous' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('throws VALIDATION_ERROR when setting intensity on a non-cardio exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ type: 'strength', intensity: null }));

      await expect(
        updateExercise('u1', 'ex1', { intensity: 'moderate' }),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: ExerciseIntensityMessageCode.INTENSITY_REQUIRES_CARDIO,
        statusCode: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws VALIDATION_ERROR when changing type to strength while intensity is set on the exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ type: 'cardio', intensity: 'light' }));

      await expect(
        updateExercise('u1', 'ex1', { type: 'strength' }),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: ExerciseIntensityMessageCode.INTENSITY_REQUIRES_CARDIO,
        statusCode: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts clearing intensity to null on a cardio exercise', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise({ type: 'cardio', intensity: 'light' }));
      const updated = { id: 'ex1', type: 'cardio', intensity: null, prescriptionMode: 'reps' };
      const txMock = makeUpdateTxMock(updated);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await updateExercise('u1', 'ex1', { intensity: null });

      expect(result).toEqual(updated);
      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ intensity: null }),
        include: advancedTechniqueLinksInclude,
      });
    });
  });

  describe('createFromTemplate — recompute duration', () => {
    const makeTraining = () => ({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: null },
    });

    // Library templates carry only identity — no prescription fields
    const makeTemplate = (overrides = {}) => ({
      id: 'tmpl-1',
      trainerId: 't1',
      name: 'Squat',
      type: 'strength',
      isPublic: false,
      deletedAt: null,
      videoUrl: null,
      ...overrides,
    });

    it('calls recomputeTrainingDuration inside the transaction after creating from template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());

      const created = { id: 'ex1', trainingId: 'tr1', sets: 3, repetitions: { min: 8, max: 12 }, prescriptionMode: 'reps', restInterval: 60, substituteForExerciseId: null, deletedAt: null };
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          create: vi.fn().mockResolvedValue(created),
          findMany: vi.fn().mockResolvedValue([created]),
          aggregate: vi.fn().mockResolvedValue({ _max: { order: null } }),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createFromTemplate('u1', 'tr1', 'tmpl-1');

      expect(txMock.training.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tr1' }, data: { estimatedDurationSeconds: expect.any(Number) } }),
      );
    });

    it('appends from-template exercise to the end of the training (max order + 1)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeTemplate());

      const created = { id: 'ex9', trainingId: 'tr1', order: 4, prescriptionMode: 'reps', substituteForExerciseId: null, deletedAt: null };
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          create: vi.fn().mockResolvedValue(created),
          findMany: vi.fn().mockResolvedValue([created]),
          aggregate: vi.fn().mockResolvedValue({ _max: { order: 3 } }),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createFromTemplate('u1', 'tr1', 'tmpl-1');

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 4 }),
        include: advancedTechniqueLinksInclude,
      });
    });
  });

  describe('createFromTemplate — intensity', () => {
    const makeTraining = () => ({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: null },
    });

    // Library templates carry only identity — no prescription or intensity
    const makeCardioTemplate = (overrides = {}) => ({
      id: 'tmpl-cardio',
      trainerId: 't1',
      name: 'Running',
      type: 'cardio',
      isPublic: false,
      deletedAt: null,
      videoUrl: null,
      ...overrides,
    });

    function makeTxMock(created) {
      return {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          create: vi.fn().mockResolvedValue(created),
          findMany: vi.fn().mockResolvedValue([created]),
          aggregate: vi.fn().mockResolvedValue({ _max: { order: null } }),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
    }

    it('defaults intensity to null when caller does not provide it (library template has no intensity)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeCardioTemplate());
      const created = { id: 'ex1', type: 'cardio', intensity: null, prescriptionMode: 'reps' };
      const txMock = makeTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await createFromTemplate('u1', 'tr1', 'tmpl-cardio');

      expect(result).toEqual(created);
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ intensity: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('sets intensity when caller explicitly provides it for a cardio type', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeCardioTemplate());
      const created = { id: 'ex1', type: 'cardio', intensity: 'vigorous', prescriptionMode: 'reps' };
      const txMock = makeTxMock(created);
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await createFromTemplate('u1', 'tr1', 'tmpl-cardio', { intensity: 'vigorous' });

      expect(result).toEqual(created);
      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ intensity: 'vigorous' }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('throws VALIDATION_ERROR when caller sets intensity on a strength template type', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      // Strength template — library has no intensity, caller provides it
      prisma.exerciseTemplate.findUnique.mockResolvedValue({
        id: 'tmpl-strength',
        trainerId: 't1',
        name: 'Squat',
        type: 'strength',
        isPublic: false,
        deletedAt: null,
        videoUrl: null,
      });

      await expect(
        createFromTemplate('u1', 'tr1', 'tmpl-strength', { intensity: 'moderate' }),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: ExerciseIntensityMessageCode.INTENSITY_REQUIRES_CARDIO,
        statusCode: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws VALIDATION_ERROR when caller overrides type to strength while setting intensity', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeCardioTemplate());

      // Caller overrides type to strength AND sets intensity — should fail
      await expect(
        createFromTemplate('u1', 'tr1', 'tmpl-cardio', { type: 'strength', intensity: 'moderate' }),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: ExerciseIntensityMessageCode.INTENSITY_REQUIRES_CARDIO,
        statusCode: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
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

      const txMock = { $queryRaw: vi.fn().mockResolvedValue([]), exercise: { update: vi.fn().mockResolvedValue({}) } };
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
        details: expect.objectContaining({
          reason: expect.stringContaining('length mismatch'),
          expected: 3,
          received: 2,
          missingIds: expect.any(Array),
          extraIds: expect.any(Array),
        }),
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

      const txMock = { $queryRaw: vi.fn().mockResolvedValue([]), exercise: { update: vi.fn().mockResolvedValue({}) } };
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
    function makeDeleteTxMock({ findManyResult = [] } = {}) {
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue(findManyResult),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      return txMock;
    }

    it('soft-deletes all substitutes when principal is deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: null, supersetGroupId: null }),
      );

      const txMock = makeDeleteTxMock();
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      expect(txMock.exercise.updateMany).toHaveBeenCalledWith({
        where: { substituteForExerciseId: 'ex1', deletedAt: null },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      });
    });

    it('calls recomputeTrainingDuration inside the transaction when principal is deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: null, supersetGroupId: null, trainingId: 'tr1' }),
      );

      const txMock = makeDeleteTxMock();
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      expect(txMock.training.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tr1' }, data: { estimatedDurationSeconds: expect.any(Number) } }),
      );
    });

    it('does not call recomputeTrainingDuration when a substitute is deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: 'principal-1', supersetGroupId: null, trainingId: 'tr1' }),
      );

      const txMock = makeDeleteTxMock();
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      expect(txMock.training.update).not.toHaveBeenCalled();
    });

    it('clears supersetGroupId on remaining member when group drops to 1', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: null, supersetGroupId: 'group-a', trainingId: 'tr1' }),
      );

      // clearGroupIfUndersized now runs inside the transaction (Minor fix).
      // The txMock must include findMany (returns 1 remaining member) and updateMany.
      const txMock = makeDeleteTxMock({ findManyResult: [{ id: 'ex2' }] });
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      // The group-clear updateMany is called inside the transaction
      expect(txMock.exercise.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ supersetGroupId: 'group-a', deletedAt: null }),
          data: { supersetGroupId: null, supersetOrder: 0, supersetRestInterval: null },
        }),
      );
    });

    it('does not clear supersetGroupId when group still has 2+ members', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: null, supersetGroupId: 'group-a', trainingId: 'tr1' }),
      );

      // 2 remaining members → group survives, updateMany for group-clear NOT called
      const txMock = makeDeleteTxMock({ findManyResult: [{ id: 'ex2' }, { id: 'ex3' }] });
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      // updateMany is only called to soft-delete substitutes (substituteForExerciseId filter),
      // not for the group-clear path.
      const groupClearCall = txMock.exercise.updateMany.mock.calls.find(
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
          $queryRaw: vi.fn().mockResolvedValue([]),
          exercise: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(created),
          },
          exerciseTemplate: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
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
          $queryRaw: vi.fn().mockResolvedValue([]),
          exercise: {
            findFirst: vi.fn().mockResolvedValue(null), // no existing substitutes
            create: txCreate,
          },
          exerciseTemplate: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
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
        include: advancedTechniqueLinksInclude,
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
          $queryRaw: vi.fn().mockResolvedValue([]),
          exercise: {
            findFirst: vi.fn().mockResolvedValue({ substituteOrder: 0 }), // one existing
            create: txCreate,
          },
          exerciseTemplate: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
          },
        };
        return fn(tx);
      });

      await addSubstitute('u1', 'principal-1', { name: 'Alt 2', type: 'strength' });

      expect(txCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ substituteOrder: 1 }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('throws VALIDATION_ERROR when adding a substitute with intensity on a non-cardio type', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue({
        id: 'principal-1',
        trainingId: 'tr1',
        deletedAt: null,
        substituteForExerciseId: null,
        supersetGroupId: null,
        training: { deletedAt: null, trainingProtocol: { trainerId: 't1', deletedAt: null } },
      });

      await expect(
        addSubstitute('u1', 'principal-1', { name: 'Alt Squat', type: 'strength', intensity: 'moderate' }),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: ExerciseIntensityMessageCode.INTENSITY_REQUIRES_CARDIO,
        statusCode: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
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

      const txMock = { $queryRaw: vi.fn().mockResolvedValue([]), exercise: { update: vi.fn().mockResolvedValue({}) } };
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

      const txMock = { $queryRaw: vi.fn().mockResolvedValue([]), exercise: { update: vi.fn().mockResolvedValue({}) } };
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

  // ─── lockTrainingForUpdate — call ordering ────────────────────────────────────

  describe('lockTrainingForUpdate — lock ordering', () => {
    it('calls $queryRaw before exercise.create in createExercise happy path', async () => {
      const makeTrainingForLock = () => ({
        id: 'tr1',
        deletedAt: null,
        trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: null },
      });

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingForLock());
      const created = { id: 'ex1', prescriptionMode: 'reps' };
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          create: vi.fn().mockResolvedValue(created),
          findMany: vi.fn().mockResolvedValue([created]),
          aggregate: vi.fn().mockResolvedValue({ _max: { order: null } }),
        },
        exerciseTemplate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.exercise.create.mock.invocationCallOrder[0],
      );
    });

    it('calls $queryRaw before exercise.update in deleteExercise (soft-delete principal)', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(
        makeExercise({ substituteForExerciseId: null, supersetGroupId: null, trainingId: 'tr1' }),
      );
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await deleteExercise('u1', 'ex1');

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.exercise.update.mock.invocationCallOrder[0],
      );
    });

    it('calls $queryRaw before exercise.update in reorderExercisesInTraining', async () => {
      const exercises = [
        { id: 'ex1', name: 'Squat' },
        { id: 'ex2', name: 'Lunge' },
      ];
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue({
        id: 'tr1',
        deletedAt: null,
        trainingProtocol: { trainerId: 't1', deletedAt: null },
        exercises: exercises.map((e) => ({ ...e, substituteForExerciseId: null, supersetGroupId: null })),
      });
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation((fn) => fn(txMock));

      await reorderExercisesInTraining('u1', 'tr1', ['ex2', 'ex1']);

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.exercise.update.mock.invocationCallOrder[0],
      );
    });
  });

  // ─── reorderExercisesInTraining — UUID-sorted lock order ─────────────────────

  describe('reorderExercisesInTraining — id-sorted lock order', () => {
    it('applies exercise.update calls in ascending UUID order regardless of input order', async () => {
      // These UUIDs have a known sort order: aaa-id < mmm-id < zzz-id
      const exerciseIds = ['zzz-id', 'aaa-id', 'mmm-id'];
      const exercises = [
        { id: 'zzz-id', name: 'Z Exercise', substituteForExerciseId: null, supersetGroupId: null },
        { id: 'aaa-id', name: 'A Exercise', substituteForExerciseId: null, supersetGroupId: null },
        { id: 'mmm-id', name: 'M Exercise', substituteForExerciseId: null, supersetGroupId: null },
      ];

      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue({
        id: 'tr1',
        deletedAt: null,
        trainingProtocol: { trainerId: 't1', deletedAt: null },
        exercises,
      });

      const updateCalls = [];
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          update: vi.fn().mockImplementation(async (args) => {
            updateCalls.push(args.where.id);
            return {};
          }),
        },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await reorderExercisesInTraining('u1', 'tr1', exerciseIds);

      // Updates must be applied in ascending UUID order (aaa < mmm < zzz)
      expect(updateCalls).toEqual(['aaa-id', 'mmm-id', 'zzz-id']);

      // But assigned order values must follow the INPUT array positions
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'zzz-id' }, data: { order: 0 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'aaa-id' }, data: { order: 1 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'mmm-id' }, data: { order: 2 } });
    });
  });

  // ─── reorderSubstitutes — lock ordering ──────────────────────────────────────

  describe('reorderSubstitutes — lock ordering', () => {
    const makePrincipalRow = (overrides = {}) => ({
      id: 'principal-1',
      trainingId: 'tr1',
      deletedAt: null,
      substituteForExerciseId: null,
      training: { deletedAt: null, trainingProtocol: { trainerId: 't1', deletedAt: null } },
      ...overrides,
    });

    it('calls $queryRaw lock before the first exercise.update inside the transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipalRow());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'sub1', name: 'Alt 1' },
        { id: 'sub2', name: 'Alt 2' },
      ]);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await reorderSubstitutes('u1', 'principal-1', ['sub2', 'sub1']);

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.exercise.update.mock.invocationCallOrder[0],
      );
    });

    it('applies exercise.update calls in ascending UUID order regardless of input order', async () => {
      // zzz-sub > mmm-sub > aaa-sub lexicographically; input order is zzz, aaa, mmm
      const inputOrder = ['zzz-sub', 'aaa-sub', 'mmm-sub'];
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipalRow());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'zzz-sub', name: 'Z Sub' },
        { id: 'aaa-sub', name: 'A Sub' },
        { id: 'mmm-sub', name: 'M Sub' },
      ]);

      const updateCalls = [];
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          update: vi.fn().mockImplementation(async (args) => {
            updateCalls.push(args.where.id);
            return {};
          }),
        },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await reorderSubstitutes('u1', 'principal-1', inputOrder);

      // Updates applied in ascending UUID order (aaa < mmm < zzz)
      expect(updateCalls).toEqual(['aaa-sub', 'mmm-sub', 'zzz-sub']);
    });

    it('returned array preserves input order with correct substituteOrder index values', async () => {
      const inputOrder = ['zzz-sub', 'aaa-sub', 'mmm-sub'];
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipalRow());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'zzz-sub', name: 'Z Sub' },
        { id: 'aaa-sub', name: 'A Sub' },
        { id: 'mmm-sub', name: 'M Sub' },
      ]);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await reorderSubstitutes('u1', 'principal-1', inputOrder);

      // Return order must follow the caller's input, not the DB apply order
      expect(result).toEqual([
        { id: 'zzz-sub', name: 'Z Sub', substituteOrder: 0 },
        { id: 'aaa-sub', name: 'A Sub', substituteOrder: 1 },
        { id: 'mmm-sub', name: 'M Sub', substituteOrder: 2 },
      ]);

      // The substituteOrder values written to DB must also match input-position
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'zzz-sub' }, data: { substituteOrder: 0 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'aaa-sub' }, data: { substituteOrder: 1 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'mmm-sub' }, data: { substituteOrder: 2 } });
    });
  });

  // ─── reorderSupersetMembers — lock ordering ───────────────────────────────────

  describe('reorderSupersetMembers — lock ordering', () => {
    it('calls $queryRaw lock before the first exercise.update inside the transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'ex1', name: 'Bench' },
        { id: 'ex2', name: 'Flye' },
      ]);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await reorderSupersetMembers('u1', 'tr1', 'group-a', ['ex2', 'ex1']);

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.exercise.update.mock.invocationCallOrder[0],
      );
    });

    it('applies exercise.update calls in ascending UUID order regardless of input order', async () => {
      // zzz-ex > mmm-ex > aaa-ex lexicographically; input order is zzz, aaa, mmm
      const inputOrder = ['zzz-ex', 'aaa-ex', 'mmm-ex'];
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'zzz-ex', name: 'Z Member' },
        { id: 'aaa-ex', name: 'A Member' },
        { id: 'mmm-ex', name: 'M Member' },
      ]);

      const updateCalls = [];
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: {
          update: vi.fn().mockImplementation(async (args) => {
            updateCalls.push(args.where.id);
            return {};
          }),
        },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await reorderSupersetMembers('u1', 'tr1', 'group-a', inputOrder);

      // Updates applied in ascending UUID order (aaa < mmm < zzz)
      expect(updateCalls).toEqual(['aaa-ex', 'mmm-ex', 'zzz-ex']);
    });

    it('returned array preserves input order with correct supersetOrder index values', async () => {
      const inputOrder = ['zzz-ex', 'aaa-ex', 'mmm-ex'];
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'zzz-ex', name: 'Z Member' },
        { id: 'aaa-ex', name: 'A Member' },
        { id: 'mmm-ex', name: 'M Member' },
      ]);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await reorderSupersetMembers('u1', 'tr1', 'group-a', inputOrder);

      // Return order must follow the caller's input, not the DB apply order
      expect(result).toEqual([
        { id: 'zzz-ex', name: 'Z Member', supersetOrder: 0 },
        { id: 'aaa-ex', name: 'A Member', supersetOrder: 1 },
        { id: 'mmm-ex', name: 'M Member', supersetOrder: 2 },
      ]);

      // The supersetOrder values written to DB must also match input-position
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'zzz-ex' }, data: { supersetOrder: 0 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'aaa-ex' }, data: { supersetOrder: 1 } });
      expect(txMock.exercise.update).toHaveBeenCalledWith({ where: { id: 'mmm-ex' }, data: { supersetOrder: 2 } });
    });
  });

  // ─── dissolveSuperset — lock ordering ────────────────────────────────────────

  describe('dissolveSuperset — lock ordering', () => {
    it('calls $queryRaw lock before exercise.updateMany inside the transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'ex1' },
        { id: 'ex2' },
      ]);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await dissolveSuperset('u1', 'tr1', 'group-a');

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.exercise.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('issues updateMany with correct where/data payload to clear the group', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'ex1' },
        { id: 'ex2' },
      ]);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await dissolveSuperset('u1', 'tr1', 'group-a');

      expect(txMock.exercise.updateMany).toHaveBeenCalledWith({
        where: { trainingId: 'tr1', supersetGroupId: 'group-a', deletedAt: null },
        data: { supersetGroupId: null, supersetOrder: 0, supersetRestInterval: null },
      });
    });

    it('returns dissolvedCount equal to the number of pre-locked members', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.exercise.findMany.mockResolvedValue([
        { id: 'ex1' },
        { id: 'ex2' },
        { id: 'ex3' },
      ]);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      const result = await dissolveSuperset('u1', 'tr1', 'group-a');

      expect(result).toEqual({
        supersetGroupId: 'group-a',
        trainingId: 'tr1',
        dissolvedCount: 3,
      });
    });
  });

  describe('gifUrl', () => {
    const GIF_URL = 'https://example.com/squat.gif';
    const TEMPLATE_GIF_URL = 'https://example.com/template.gif';
    const makeTrainingRow = () => ({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: null },
    });
    const makeCreateTx = (created, tplFindFirst = null) => ({
      $queryRaw: vi.fn().mockResolvedValue([]),
      exercise: {
        create: vi.fn().mockResolvedValue(created),
        findMany: vi.fn().mockResolvedValue([created]),
        findFirst: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({ _max: { order: null } }),
      },
      exerciseTemplate: {
        findFirst: vi.fn().mockResolvedValue(tplFindFirst),
        create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
      },
      training: { update: vi.fn().mockResolvedValue({}) },
    });
    const makeLibraryTemplate = (overrides = {}) => ({
      id: 'tmpl-1',
      trainerId: 't1',
      name: 'Squat',
      type: 'strength',
      isPublic: false,
      deletedAt: null,
      videoUrl: null,
      gifUrl: TEMPLATE_GIF_URL,
      ...overrides,
    });

    it('createExercise persists gifUrl on the exercise and the auto-created library template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingRow());
      const txMock = makeCreateTx({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', gifUrl: GIF_URL });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: GIF_URL }),
        include: advancedTechniqueLinksInclude,
      });
      expect(txMock.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: GIF_URL }),
        select: { id: true },
      });
    });

    it('createExercise sets gifUrl to null when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingRow());
      const txMock = makeCreateTx({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('createFromTemplate falls back to the template gifUrl when the caller omits it', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingRow());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeLibraryTemplate());
      const txMock = makeCreateTx({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createFromTemplate('u1', 'tr1', 'tmpl-1');

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: TEMPLATE_GIF_URL }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('createFromTemplate prefers the caller gifUrl over the template value', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingRow());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeLibraryTemplate());
      const txMock = makeCreateTx({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createFromTemplate('u1', 'tr1', 'tmpl-1', { gifUrl: GIF_URL });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: GIF_URL }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('createFromTemplate honours an explicit null gifUrl instead of the template value', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingRow());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeLibraryTemplate());
      const txMock = makeCreateTx({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await createFromTemplate('u1', 'tr1', 'tmpl-1', { gifUrl: null });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('updateExercise writes gifUrl when provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { update: vi.fn().mockResolvedValue({ id: 'ex1' }), findMany: vi.fn().mockResolvedValue([]) },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { gifUrl: GIF_URL });

      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ gifUrl: GIF_URL }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('updateExercise clears gifUrl when null is sent', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { update: vi.fn().mockResolvedValue({ id: 'ex1' }), findMany: vi.fn().mockResolvedValue([]) },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { gifUrl: null });

      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ gifUrl: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('updateExercise leaves gifUrl out of the update payload when not provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exercise: { update: vi.fn().mockResolvedValue({ id: 'ex1' }), findMany: vi.fn().mockResolvedValue([]) },
        training: { update: vi.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await updateExercise('u1', 'ex1', { name: 'Lunge' });

      expect(txMock.exercise.update.mock.calls[0][0].data).not.toHaveProperty('gifUrl');
    });

    it('addSubstitute persists gifUrl on the substitute and its library template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue({
        id: 'principal-1',
        trainingId: 'tr1',
        deletedAt: null,
        substituteForExerciseId: null,
        supersetGroupId: null,
        training: { deletedAt: null, trainingProtocol: { trainerId: 't1', deletedAt: null } },
      });
      const txMock = makeCreateTx({ id: 'sub-1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength', gifUrl: GIF_URL });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: GIF_URL }),
        include: advancedTechniqueLinksInclude,
      });
      expect(txMock.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gifUrl: GIF_URL }),
        select: { id: true },
      });
    });
  });

  describe('videoFileKey', () => {
    const OWN_KEY = 'exercise-videos/t1/11111111-1111-4111-8111-111111111111.mp4';
    const OTHER_KEY = 'exercise-videos/t1/22222222-2222-4222-8222-222222222222.webm';
    const FOREIGN_KEY = 'exercise-videos/t2/33333333-3333-4333-8333-333333333333.mp4';
    const INVALID_KEY_MESSAGE_CODE = 'exerciseVideo.invalidFileKey';
    const makeTrainingRow = () => ({
      id: 'tr1',
      deletedAt: null,
      trainingProtocol: { id: 'p1', trainerId: 't1', deletedAt: null },
    });
    const makeCreateTx = (created) => ({
      $queryRaw: vi.fn().mockResolvedValue([]),
      exercise: {
        create: vi.fn().mockResolvedValue(created),
        findMany: vi.fn().mockResolvedValue([created]),
        findFirst: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({ _max: { order: null } }),
      },
      exerciseTemplate: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'tpl1' }),
      },
      training: { update: vi.fn().mockResolvedValue({}) },
    });
    const makeLibraryTemplate = (overrides = {}) => ({
      id: 'tmpl-1',
      trainerId: 't1',
      name: 'Squat',
      type: 'strength',
      isPublic: false,
      deletedAt: null,
      videoUrl: null,
      gifUrl: null,
      videoFileKey: OTHER_KEY,
      ...overrides,
    });
    const makeUpdateTx = () => ({
      $queryRaw: vi.fn().mockResolvedValue([]),
      exercise: { update: vi.fn().mockResolvedValue({ id: 'ex1' }), findMany: vi.fn().mockResolvedValue([]) },
      training: { update: vi.fn().mockResolvedValue({}) },
    });
    const makePrincipal = () => ({
      id: 'principal-1',
      trainingId: 'tr1',
      deletedAt: null,
      substituteForExerciseId: null,
      supersetGroupId: null,
      training: { deletedAt: null, trainingProtocol: { trainerId: 't1', deletedAt: null } },
    });

    function arrangeCreate() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.training.findUnique.mockResolvedValue(makeTrainingRow());
      const txMock = makeCreateTx({ id: 'ex1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));
      return txMock;
    }

    function arrangeUpdate() {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makeExercise());
      const txMock = makeUpdateTx();
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));
      return txMock;
    }

    it('createExercise persists videoFileKey on the exercise and the auto-created library template', async () => {
      const txMock = arrangeCreate();

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', videoFileKey: OWN_KEY });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: OWN_KEY }),
        include: advancedTechniqueLinksInclude,
      });
      expect(txMock.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: OWN_KEY }),
        select: { id: true },
      });
    });

    it('createExercise stores videoFileKey null when not provided', async () => {
      const txMock = arrangeCreate();

      await createExercise('u1', 'tr1', { name: 'Squat', type: 'strength' });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('createExercise rejects a key of another trainer with the invalid-key messageCode', async () => {
      const txMock = arrangeCreate();

      await expect(
        createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', videoFileKey: FOREIGN_KEY }),
      ).rejects.toMatchObject({ statusCode: 400, messageCode: INVALID_KEY_MESSAGE_CODE });
      expect(txMock.exercise.create).not.toHaveBeenCalled();
    });

    it('createExercise rejects a key outside the exercise-videos prefix', async () => {
      arrangeCreate();

      await expect(
        createExercise('u1', 'tr1', { name: 'Squat', type: 'strength', videoFileKey: 'avatars/t1/a.mp4' }),
      ).rejects.toMatchObject({ statusCode: 400, messageCode: INVALID_KEY_MESSAGE_CODE });
    });

    it('createFromTemplate falls back to the template videoFileKey when the caller omits it', async () => {
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeLibraryTemplate());
      const txMock = arrangeCreate();

      await createFromTemplate('u1', 'tr1', 'tmpl-1');

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: OTHER_KEY }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('createFromTemplate prefers the caller videoFileKey over the template value', async () => {
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeLibraryTemplate());
      const txMock = arrangeCreate();

      await createFromTemplate('u1', 'tr1', 'tmpl-1', { videoFileKey: OWN_KEY });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: OWN_KEY }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('createFromTemplate honours an explicit null videoFileKey instead of the template value', async () => {
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeLibraryTemplate());
      const txMock = arrangeCreate();

      await createFromTemplate('u1', 'tr1', 'tmpl-1', { videoFileKey: null });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('createFromTemplate rejects a key of another trainer', async () => {
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeLibraryTemplate());
      arrangeCreate();

      await expect(
        createFromTemplate('u1', 'tr1', 'tmpl-1', { videoFileKey: FOREIGN_KEY }),
      ).rejects.toMatchObject({ statusCode: 400, messageCode: INVALID_KEY_MESSAGE_CODE });
    });

    it('updateExercise writes videoFileKey when provided', async () => {
      const txMock = arrangeUpdate();

      await updateExercise('u1', 'ex1', { videoFileKey: OWN_KEY });

      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ videoFileKey: OWN_KEY }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('updateExercise clears videoFileKey when null is sent', async () => {
      const txMock = arrangeUpdate();

      await updateExercise('u1', 'ex1', { videoFileKey: null });

      expect(txMock.exercise.update).toHaveBeenCalledWith({
        where: { id: 'ex1' },
        data: expect.objectContaining({ videoFileKey: null }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('updateExercise leaves videoFileKey out of the update payload when not provided', async () => {
      const txMock = arrangeUpdate();

      await updateExercise('u1', 'ex1', { name: 'Lunge' });

      expect(txMock.exercise.update.mock.calls[0][0].data).not.toHaveProperty('videoFileKey');
    });

    it('updateExercise rejects a key of another trainer', async () => {
      arrangeUpdate();

      await expect(
        updateExercise('u1', 'ex1', { videoFileKey: FOREIGN_KEY }),
      ).rejects.toMatchObject({ statusCode: 400, messageCode: INVALID_KEY_MESSAGE_CODE });
    });

    it('addSubstitute persists videoFileKey on the substitute and its library template', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipal());
      const txMock = makeCreateTx({ id: 'sub-1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength', videoFileKey: OWN_KEY });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: OWN_KEY }),
        include: advancedTechniqueLinksInclude,
      });
      expect(txMock.exerciseTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: OWN_KEY }),
        select: { id: true },
      });
    });

    it('addSubstitute inherits videoFileKey from the linked library template when the caller omits it', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipal());
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeLibraryTemplate());
      const txMock = makeCreateTx({ id: 'sub-1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength', exerciseTemplateId: 'tmpl-1' });

      expect(txMock.exercise.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ videoFileKey: OTHER_KEY }),
        include: advancedTechniqueLinksInclude,
      });
    });

    it('addSubstitute rejects a key of another trainer', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
      prisma.exercise.findUnique.mockResolvedValue(makePrincipal());
      const txMock = makeCreateTx({ id: 'sub-1', prescriptionMode: 'reps' });
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await expect(
        addSubstitute('u1', 'principal-1', { name: 'Alt', type: 'strength', videoFileKey: FOREIGN_KEY }),
      ).rejects.toMatchObject({ statusCode: 400, messageCode: INVALID_KEY_MESSAGE_CODE });
    });
  });
});
