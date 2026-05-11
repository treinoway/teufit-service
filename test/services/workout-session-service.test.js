import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    training: { findUnique: vi.fn() },
    workoutSession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    exercise: {
      findUnique: vi.fn(),
    },
    exerciseLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    setLog: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import {
  startSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  updateExerciseLog,
  createSetLog,
  updateSetLog,
  deleteSetLog,
  listStudentSessions,
  getStudentSession,
  substituteExerciseLog,
} from '../../src/services/workout-session-service.js';
import {
  WorkoutSessionStatus,
  ExerciseLogStatus,
  SubstituteMessageCode,
} from '../../src/constants/training.js';

// ─── Factories ────────────────────────────────────────────────────────────────

const makeTraining = (overrides = {}) => ({
  id: 'training-1',
  deletedAt: null,
  trainingProtocol: { id: 'protocol-1', assigneeId: 'user-1', deletedAt: null },
  exercises: [
    { id: 'ex-1', order: 0 },
    { id: 'ex-2', order: 1 },
  ],
  ...overrides,
});

const makeSession = (overrides = {}) => ({
  id: 'session-1',
  trainingId: 'training-1',
  userId: 'user-1',
  status: WorkoutSessionStatus.IN_PROGRESS,
  startedAt: new Date('2026-01-01T10:00:00Z'),
  finishedAt: null,
  durationSeconds: null,
  deletedAt: null,
  notes: null,
  ...overrides,
});

const makeExerciseLog = (overrides = {}) => ({
  id: 'elog-1',
  workoutSessionId: 'session-1',
  exerciseId: 'ex-1',
  status: ExerciseLogStatus.PENDING,
  order: 0,
  notes: null,
  workoutSession: makeSession(),
  ...overrides,
});

const makeSetLog = (overrides = {}) => ({
  id: 'slog-1',
  exerciseLogId: 'elog-1',
  setNumber: 1,
  repetitions: 10,
  load: 60.0,
  duration: null,
  rpe: 7,
  restSeconds: 90,
  completed: true,
  notes: null,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('workout-session-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── startSession ──────────────────────────────────────────────────────────

  describe('startSession', () => {
    it('throws TRAINING_NOT_FOUND when training does not exist', async () => {
      prisma.training.findUnique.mockResolvedValue(null);

      await expect(startSession('user-1', 'training-1')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TRAINING_NOT_FOUND when training is soft-deleted', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining({ deletedAt: new Date() }));

      await expect(startSession('user-1', 'training-1')).rejects.toMatchObject({
        code: 'TRAINING_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_TRAINING when training not assigned to user', async () => {
      prisma.training.findUnique.mockResolvedValue(
        makeTraining({
          trainingProtocol: { id: 'protocol-1', assigneeId: 'other-user', deletedAt: null },
        }),
      );

      await expect(startSession('user-1', 'training-1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_TRAINING',
        statusCode: 403,
      });
    });

    it('throws SESSION_ALREADY_IN_PROGRESS when user has active session', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.workoutSession.findFirst.mockResolvedValue({ id: 'existing-session' });

      await expect(startSession('user-1', 'training-1')).rejects.toMatchObject({
        error: 'SESSION_ALREADY_IN_PROGRESS',
        httpStatus: 409,
        details: { activeSessionId: 'existing-session' },
      });
    });

    it('includes activeSessionId in the 409 error details', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.workoutSession.findFirst.mockResolvedValue({ id: 'active-session-abc' });

      let thrown;
      try {
        await startSession('user-1', 'training-1');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect(thrown.details.activeSessionId).toBe('active-session-abc');
    });

    it('creates session and exercise logs in transaction on success', async () => {
      const training = makeTraining();
      prisma.training.findUnique.mockResolvedValue(training);
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      const createdSession = makeSession({ id: 'new-session', exerciseLogs: [] });
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          workoutSession: {
            create: vi.fn().mockResolvedValue({ id: 'new-session' }),
            findUnique: vi.fn().mockResolvedValue(createdSession),
          },
          exerciseLog: {
            createMany: vi.fn().mockResolvedValue({ count: 2 }),
          },
        };
        return fn(tx);
      });

      const result = await startSession('user-1', 'training-1');

      expect(result).toEqual(createdSession);
    });

    it('passes notes to session creation', async () => {
      prisma.training.findUnique.mockResolvedValue(makeTraining());
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      let capturedCreateData;
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          workoutSession: {
            create: vi.fn().mockImplementation(({ data }) => {
              capturedCreateData = data;
              return Promise.resolve({ id: 'new-session' });
            }),
            findUnique: vi.fn().mockResolvedValue(makeSession({ id: 'new-session' })),
          },
          exerciseLog: {
            createMany: vi.fn().mockResolvedValue({ count: 2 }),
          },
        };
        return fn(tx);
      });

      await startSession('user-1', 'training-1', { notes: 'Leg day, feeling strong' });

      expect(capturedCreateData).toMatchObject({ notes: 'Leg day, feeling strong' });
    });
  });

  // ── listSessions ──────────────────────────────────────────────────────────

  describe('listSessions', () => {
    it('returns paginated sessions for user', async () => {
      const sessions = [makeSession()];
      prisma.workoutSession.findMany.mockResolvedValue(sessions);
      prisma.workoutSession.count.mockResolvedValue(1);

      const result = await listSessions('user-1', { page: 1, limit: 20 });

      expect(result).toMatchObject({ data: sessions, total: 1, page: 1, limit: 20 });
    });

    it('applies trainingId filter', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([]);
      prisma.workoutSession.count.mockResolvedValue(0);

      await listSessions('user-1', { trainingId: 'training-1' });

      expect(prisma.workoutSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ trainingId: 'training-1' }),
        }),
      );
    });

    it('applies status filter', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([]);
      prisma.workoutSession.count.mockResolvedValue(0);

      await listSessions('user-1', { status: WorkoutSessionStatus.COMPLETED });

      expect(prisma.workoutSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: WorkoutSessionStatus.COMPLETED }),
        }),
      );
    });

    it('always filters by userId and excludes soft-deleted', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([]);
      prisma.workoutSession.count.mockResolvedValue(0);

      await listSessions('user-1', {});

      expect(prisma.workoutSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', deletedAt: null }),
        }),
      );
    });
  });

  // ── getSession ────────────────────────────────────────────────────────────

  describe('getSession', () => {
    it('throws WORKOUT_SESSION_NOT_FOUND when session does not exist', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(null);

      await expect(getSession('user-1', 'session-1')).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws WORKOUT_SESSION_NOT_FOUND when session is soft-deleted', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(makeSession({ deletedAt: new Date() }));

      await expect(getSession('user-1', 'session-1')).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_SESSION when session belongs to another user', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(makeSession({ userId: 'other-user' }));

      await expect(getSession('user-1', 'session-1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_SESSION',
        statusCode: 403,
      });
    });

    it('returns session when user owns it', async () => {
      const session = makeSession();
      prisma.workoutSession.findUnique.mockResolvedValue(session);

      const result = await getSession('user-1', 'session-1');

      expect(result).toEqual(session);
    });
  });

  // ── updateSession ─────────────────────────────────────────────────────────

  describe('updateSession', () => {
    it('throws WORKOUT_SESSION_NOT_FOUND when session does not exist', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(null);

      await expect(updateSession('user-1', 'session-1', { notes: 'test' })).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('sets finishedAt and calculates durationSeconds when status is completed', async () => {
      const startedAt = new Date('2026-01-01T10:00:00Z');
      prisma.workoutSession.findUnique.mockResolvedValue(makeSession({ startedAt }));
      prisma.workoutSession.update.mockResolvedValue(makeSession({ status: WorkoutSessionStatus.COMPLETED }));

      await updateSession('user-1', 'session-1', { status: WorkoutSessionStatus.COMPLETED });

      const updateCall = prisma.workoutSession.update.mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        status: WorkoutSessionStatus.COMPLETED,
        finishedAt: expect.any(Date),
        durationSeconds: expect.any(Number),
      });
      expect(updateCall.data.durationSeconds).toBeGreaterThan(0);
    });

    it('sets finishedAt and calculates durationSeconds when status is abandoned', async () => {
      const startedAt = new Date('2026-01-01T10:00:00Z');
      prisma.workoutSession.findUnique.mockResolvedValue(makeSession({ startedAt }));
      prisma.workoutSession.update.mockResolvedValue(makeSession({ status: WorkoutSessionStatus.ABANDONED }));

      await updateSession('user-1', 'session-1', { status: WorkoutSessionStatus.ABANDONED });

      const updateCall = prisma.workoutSession.update.mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        status: WorkoutSessionStatus.ABANDONED,
        finishedAt: expect.any(Date),
        durationSeconds: expect.any(Number),
      });
    });

    it('does not set finishedAt when only notes are updated', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(makeSession());
      prisma.workoutSession.update.mockResolvedValue(makeSession({ notes: 'updated notes' }));

      await updateSession('user-1', 'session-1', { notes: 'updated notes' });

      const updateCall = prisma.workoutSession.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('finishedAt');
      expect(updateCall.data).not.toHaveProperty('durationSeconds');
      expect(updateCall.data).toMatchObject({ notes: 'updated notes' });
    });
  });

  // ── deleteSession ─────────────────────────────────────────────────────────

  describe('deleteSession', () => {
    it('throws WORKOUT_SESSION_NOT_FOUND when session does not exist', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(null);

      await expect(deleteSession('user-1', 'session-1')).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('soft-deletes by setting deletedAt', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(makeSession());
      prisma.workoutSession.update.mockResolvedValue(makeSession({ deletedAt: new Date() }));

      await deleteSession('user-1', 'session-1');

      expect(prisma.workoutSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  // ── updateExerciseLog ─────────────────────────────────────────────────────

  describe('updateExerciseLog', () => {
    it('throws EXERCISE_LOG_NOT_FOUND when exercise log does not exist', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(null);

      await expect(
        updateExerciseLog('user-1', 'session-1', 'elog-1', { status: ExerciseLogStatus.COMPLETED }),
      ).rejects.toMatchObject({
        code: 'EXERCISE_LOG_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws EXERCISE_LOG_NOT_IN_SESSION when log belongs to different session', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(
        makeExerciseLog({ workoutSessionId: 'other-session' }),
      );

      await expect(
        updateExerciseLog('user-1', 'session-1', 'elog-1', { status: ExerciseLogStatus.COMPLETED }),
      ).rejects.toMatchObject({
        code: 'EXERCISE_LOG_NOT_IN_SESSION',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_SESSION when session belongs to another user', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(
        makeExerciseLog({ workoutSession: makeSession({ userId: 'other-user' }) }),
      );

      await expect(
        updateExerciseLog('user-1', 'session-1', 'elog-1', { status: ExerciseLogStatus.COMPLETED }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_SESSION',
        statusCode: 403,
      });
    });

    it('updates status and notes when authorized', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
      const updated = makeExerciseLog({ status: ExerciseLogStatus.COMPLETED, notes: 'done' });
      prisma.exerciseLog.update.mockResolvedValue(updated);

      const result = await updateExerciseLog('user-1', 'session-1', 'elog-1', {
        status: ExerciseLogStatus.COMPLETED,
        notes: 'done',
      });

      expect(result).toEqual(updated);
      expect(prisma.exerciseLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'elog-1' },
          data: { status: ExerciseLogStatus.COMPLETED, notes: 'done' },
        }),
      );
    });
  });

  // ── createSetLog ──────────────────────────────────────────────────────────

  describe('createSetLog', () => {
    it('throws EXERCISE_LOG_NOT_FOUND when exercise log does not exist', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(null);

      await expect(
        createSetLog('user-1', 'session-1', 'elog-1', { setNumber: 1 }),
      ).rejects.toMatchObject({
        code: 'EXERCISE_LOG_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('creates set log with provided data', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
      const setLog = makeSetLog();
      prisma.setLog.create.mockResolvedValue(setLog);

      const result = await createSetLog('user-1', 'session-1', 'elog-1', {
        setNumber: 1,
        repetitions: 10,
        load: 60.0,
        rpe: 7,
        restSeconds: 90,
      });

      expect(result).toEqual(setLog);
      expect(prisma.setLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          exerciseLogId: 'elog-1',
          setNumber: 1,
          repetitions: 10,
          load: 60.0,
          rpe: 7,
          restSeconds: 90,
          completed: true,
        }),
      });
    });

    it('defaults completed to true when not provided', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
      prisma.setLog.create.mockResolvedValue(makeSetLog());

      await createSetLog('user-1', 'session-1', 'elog-1', { setNumber: 1 });

      expect(prisma.setLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ completed: true }),
      });
    });
  });

  // ── updateSetLog ──────────────────────────────────────────────────────────

  describe('updateSetLog', () => {
    it('throws SET_LOG_NOT_FOUND when set log does not exist', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
      prisma.setLog.findUnique.mockResolvedValue(null);

      await expect(
        updateSetLog('user-1', 'session-1', 'elog-1', 'slog-1', { load: 70 }),
      ).rejects.toMatchObject({
        code: 'SET_LOG_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws SET_LOG_NOT_IN_EXERCISE_LOG when set log belongs to different exercise log', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
      prisma.setLog.findUnique.mockResolvedValue(makeSetLog({ exerciseLogId: 'other-elog' }));

      await expect(
        updateSetLog('user-1', 'session-1', 'elog-1', 'slog-1', { load: 70 }),
      ).rejects.toMatchObject({
        code: 'SET_LOG_NOT_IN_EXERCISE_LOG',
        statusCode: 404,
      });
    });

    it('updates provided fields only', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
      prisma.setLog.findUnique.mockResolvedValue(makeSetLog());
      const updated = makeSetLog({ load: 70.0 });
      prisma.setLog.update.mockResolvedValue(updated);

      const result = await updateSetLog('user-1', 'session-1', 'elog-1', 'slog-1', { load: 70.0 });

      expect(result).toEqual(updated);
      expect(prisma.setLog.update).toHaveBeenCalledWith({
        where: { id: 'slog-1' },
        data: { load: 70.0 },
      });
    });
  });

  // ── deleteSetLog ──────────────────────────────────────────────────────────

  describe('deleteSetLog', () => {
    it('throws SET_LOG_NOT_FOUND when set log does not exist', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
      prisma.setLog.findUnique.mockResolvedValue(null);

      await expect(
        deleteSetLog('user-1', 'session-1', 'elog-1', 'slog-1'),
      ).rejects.toMatchObject({
        code: 'SET_LOG_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('hard-deletes the set log', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
      prisma.setLog.findUnique.mockResolvedValue(makeSetLog());
      prisma.setLog.delete.mockResolvedValue(makeSetLog());

      await deleteSetLog('user-1', 'session-1', 'elog-1', 'slog-1');

      expect(prisma.setLog.delete).toHaveBeenCalledWith({ where: { id: 'slog-1' } });
    });
  });

  // ── listStudentSessions ───────────────────────────────────────────────────

  describe('listStudentSessions', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer has no profile', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        listStudentSessions('trainer-user-1', 'student-1', {}),
      ).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws STUDENT_NOT_FOUND when no trainer-student relationship exists', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainerStudent.findUnique.mockResolvedValue(null);

      await expect(
        listStudentSessions('trainer-user-1', 'student-1', {}),
      ).rejects.toMatchObject({
        code: 'STUDENT_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('returns paginated sessions for student', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });

      const sessions = [makeSession({ userId: 'student-1' })];
      prisma.workoutSession.findMany.mockResolvedValue(sessions);
      prisma.workoutSession.count.mockResolvedValue(1);

      const result = await listStudentSessions('trainer-user-1', 'student-1', {});

      expect(result).toMatchObject({ data: sessions, total: 1, page: 1, limit: 20 });
      expect(prisma.workoutSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'student-1' }),
        }),
      );
    });
  });

  // ── getStudentSession ─────────────────────────────────────────────────────

  describe('getStudentSession', () => {
    it('throws TRAINER_PROFILE_MISSING when trainer has no profile', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        getStudentSession('trainer-user-1', 'student-1', 'session-1'),
      ).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
    });

    it('throws WORKOUT_SESSION_NOT_FOUND when session does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.workoutSession.findUnique.mockResolvedValue(null);

      await expect(
        getStudentSession('trainer-user-1', 'student-1', 'session-1'),
      ).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_SESSION when session does not belong to student', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.workoutSession.findUnique.mockResolvedValue(makeSession({ userId: 'other-user' }));

      await expect(
        getStudentSession('trainer-user-1', 'student-1', 'session-1'),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_SESSION',
        statusCode: 403,
      });
    });

    it('returns session when trainer owns student and session belongs to student', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      const session = makeSession({ userId: 'student-1' });
      prisma.workoutSession.findUnique.mockResolvedValue(session);

      const result = await getStudentSession('trainer-user-1', 'student-1', 'session-1');

      expect(result).toEqual(session);
    });
  });

  // ── substituteExerciseLog ─────────────────────────────────────────────────

  describe('substituteExerciseLog', () => {
    const makePrincipalLog = (overrides = {}) =>
      makeExerciseLog({
        id: 'elog-1',
        exerciseId: 'ex-1',
        order: 2,
        status: ExerciseLogStatus.PENDING,
        substitutedByExerciseId: null,
        workoutSession: makeSession({ userId: 'user-1' }),
        ...overrides,
      });

    const makeSubstituteExercise = (overrides = {}) => ({
      id: 'sub-ex-1',
      substituteForExerciseId: 'ex-1',
      deletedAt: null,
      ...overrides,
    });

    const makeNewLog = (overrides = {}) => ({
      id: 'elog-new',
      workoutSessionId: 'session-1',
      exerciseId: 'sub-ex-1',
      status: ExerciseLogStatus.PENDING,
      // C1 fix: order is now principal.order + 1 (integer), not + 0.5 (float)
      order: 3,
      setLogs: [],
      ...overrides,
    });

    it('throws EXERCISE_LOG_NOT_FOUND when principal log does not exist', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(null);

      await expect(
        substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1'),
      ).rejects.toMatchObject({
        code: 'EXERCISE_LOG_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws EXERCISE_NOT_FOUND when substitute exercise does not exist', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makePrincipalLog());
      prisma.exercise.findUnique.mockResolvedValue(null);

      await expect(
        substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1'),
      ).rejects.toMatchObject({
        code: 'EXERCISE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws EXERCISE_NOT_FOUND when substitute exercise is soft-deleted', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makePrincipalLog());
      prisma.exercise.findUnique.mockResolvedValue(
        makeSubstituteExercise({ deletedAt: new Date() }),
      );

      await expect(
        substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1'),
      ).rejects.toMatchObject({
        code: 'EXERCISE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws VALIDATION_ERROR when exercise is not a substitute for the principal', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makePrincipalLog());
      prisma.exercise.findUnique.mockResolvedValue(
        makeSubstituteExercise({ substituteForExerciseId: 'other-ex' }),
      );

      await expect(
        substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        messageCode: SubstituteMessageCode.NOT_FOUND,
        statusCode: 400,
      });
    });

    it('throws EXERCISE_LOG_ALREADY_SUBSTITUTED (409) when log is already substituted with a different exercise', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(
        makePrincipalLog({
          status: ExerciseLogStatus.SUBSTITUTED,
          substitutedByExerciseId: 'other-sub-ex',
        }),
      );

      await expect(
        substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1'),
      ).rejects.toMatchObject({
        code: 'EXERCISE_LOG_ALREADY_SUBSTITUTED',
        messageCode: SubstituteMessageCode.LOG_ALREADY_SUBSTITUTED,
        statusCode: 409,
      });
    });

    it('returns existing new log idempotently when already substituted with same exercise', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(
        makePrincipalLog({
          status: ExerciseLogStatus.SUBSTITUTED,
          substitutedByExerciseId: 'sub-ex-1',
        }),
      );
      const existingLog = makeNewLog();
      prisma.exerciseLog.findFirst.mockResolvedValue(existingLog);

      const result = await substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1');

      expect(result).toEqual(existingLog);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates new log and marks principal as substituted on success', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makePrincipalLog());
      prisma.exercise.findUnique.mockResolvedValue(makeSubstituteExercise());
      const newLog = makeNewLog();

      // C1 fix: tx now calls updateMany (shift) before update (mark substituted) and create
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          exerciseLog: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            update: vi.fn().mockResolvedValue({}),
            create: vi.fn().mockResolvedValue(newLog),
          },
        };
        return fn(tx);
      });

      const result = await substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1');

      expect(result).toEqual(newLog);
      // C1: order is now an integer (principal.order + 1 = 3), not a float
      expect(result.order).toBe(3);
    });
  });
});
