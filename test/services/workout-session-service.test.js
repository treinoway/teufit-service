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
      delete: vi.fn(),
    },
    setLog: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
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
  undoSubstituteExerciseLog,
  getExerciseLastPerformance,
} from '../../src/services/workout-session-service.js';
import {
  WorkoutSessionStatus,
  ExerciseLogStatus,
  SubstituteMessageCode,
  LastPerformanceErrorCode,
  LastPerformanceMessageCode,
  WorkoutSessionFinalizedErrorCode,
  WorkoutSessionFinalizedMessageCode,
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
          $queryRaw: vi.fn().mockResolvedValue([]),
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

  // ── undoSubstituteExerciseLog ─────────────────────────────────────────────

  describe('undoSubstituteExerciseLog', () => {
    const makeSubstituteLog = (overrides = {}) =>
      makeExerciseLog({
        id: 'elog-sub',
        exerciseId: 'sub-ex-1',
        order: 3,
        status: ExerciseLogStatus.PENDING,
        substitutedByExerciseId: null,
        workoutSession: makeSession({ userId: 'user-1' }),
        ...overrides,
      });

    const makePrincipalForUndo = (overrides = {}) => ({
      id: 'elog-principal',
      workoutSessionId: 'session-1',
      exerciseId: 'ex-1',
      status: ExerciseLogStatus.SUBSTITUTED,
      order: 2,
      substitutedByExerciseId: 'sub-ex-1',
      ...overrides,
    });

    it('throws EXERCISE_LOG_NOT_FOUND (404) when substitute log does not exist', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(null);

      await expect(
        undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub'),
      ).rejects.toMatchObject({
        code: 'EXERCISE_LOG_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_SESSION (403) when session does not belong to user', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(
        makeSubstituteLog({
          workoutSession: makeSession({ userId: 'other-user' }),
        }),
      );

      await expect(
        undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub'),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_SESSION',
        statusCode: 403,
      });
    });

    it('throws VALIDATION_ERROR / exercise.undoNotSubstitute (400) when no principal log references this substitute', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeSubstituteLog());
      prisma.exerciseLog.findFirst.mockResolvedValue(null);

      await expect(
        undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub'),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: SubstituteMessageCode.UNDO_NOT_SUBSTITUTE,
        httpStatus: 400,
      });
    });

    it('throws VALIDATION_ERROR / exercise.undoHasSets (400) when the substitute log already has set logs', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeSubstituteLog());
      prisma.exerciseLog.findFirst.mockResolvedValue(makePrincipalForUndo());
      prisma.setLog.count.mockResolvedValue(1);

      await expect(
        undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub'),
      ).rejects.toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: SubstituteMessageCode.UNDO_HAS_SETS,
        httpStatus: 400,
      });
    });

    it('executes the correct transaction operations on success', async () => {
      const substituteLog = makeSubstituteLog();
      const principalLog = makePrincipalForUndo();

      prisma.exerciseLog.findUnique.mockResolvedValue(substituteLog);
      prisma.exerciseLog.findFirst.mockResolvedValue(principalLog);
      prisma.setLog.count.mockResolvedValue(0);

      const txUpdate = vi.fn().mockResolvedValue({});
      const txDelete = vi.fn().mockResolvedValue({});
      const txUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          exerciseLog: {
            update: txUpdate,
            delete: txDelete,
            updateMany: txUpdateMany,
          },
        };
        return fn(tx);
      });

      await undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub');

      // Principal must be reset
      expect(txUpdate).toHaveBeenCalledWith({
        where: { id: principalLog.id },
        data: { status: ExerciseLogStatus.PENDING, substitutedByExerciseId: null },
      });

      // Substitute must be hard-deleted
      expect(txDelete).toHaveBeenCalledWith({ where: { id: substituteLog.id } });

      // Downstream logs must be shifted back
      expect(txUpdateMany).toHaveBeenCalledWith({
        where: { workoutSessionId: 'session-1', order: { gt: substituteLog.order } },
        data: { order: { decrement: 1 } },
      });
    });

    it('returns undefined (204-compatible) on success', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeSubstituteLog());
      prisma.exerciseLog.findFirst.mockResolvedValue(makePrincipalForUndo());
      prisma.setLog.count.mockResolvedValue(0);

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          exerciseLog: {
            update: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        };
        return fn(tx);
      });

      const result = await undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub');

      expect(result).toBeUndefined();
    });

    it('throws EXERCISE_LOG_NOT_FOUND (404) on re-call after successful undo (idempotent 404)', async () => {
      // After undo the substitute log is deleted, so findUnique returns null on the second call
      prisma.exerciseLog.findUnique.mockResolvedValue(null);

      await expect(
        undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub'),
      ).rejects.toMatchObject({
        code: 'EXERCISE_LOG_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  // ── SESSION_FINALIZED guard ───────────────────────────────────────────────

  describe('SESSION_FINALIZED guard', () => {
    const finalizedErrorShape = {
      httpStatus: 409,
      error: WorkoutSessionFinalizedErrorCode,
      messageCode: WorkoutSessionFinalizedMessageCode,
    };

    // Helper to build a terminal session mock for resolveUserSession
    function mockTerminalSession(status) {
      prisma.workoutSession.findUnique.mockResolvedValue(
        makeSession({ status }),
      );
    }

    // Helper to build a terminal exerciseLog mock for resolveExerciseLog
    function mockTerminalExerciseLog(status) {
      prisma.exerciseLog.findUnique.mockResolvedValue(
        makeExerciseLog({ workoutSession: makeSession({ status }) }),
      );
    }

    // ── updateSession ──────────────────────────────────────────────────────

    describe('updateSession', () => {
      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'throws SESSION_FINALIZED (409) when session is %s and data.status is provided',
        async (terminalStatus) => {
          mockTerminalSession(terminalStatus);

          await expect(
            updateSession('user-1', 'session-1', { status: WorkoutSessionStatus.COMPLETED }),
          ).rejects.toMatchObject({
            ...finalizedErrorShape,
            details: { sessionId: 'session-1', status: terminalStatus },
          });
        },
      );

      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'allows notes-only patch on a %s session (no status in data)',
        async (terminalStatus) => {
          mockTerminalSession(terminalStatus);
          prisma.workoutSession.update.mockResolvedValue(
            makeSession({ status: terminalStatus, notes: 'post-workout note' }),
          );

          await expect(
            updateSession('user-1', 'session-1', { notes: 'post-workout note' }),
          ).resolves.toBeDefined();

          // update must have been called — no guard triggered
          expect(prisma.workoutSession.update).toHaveBeenCalledOnce();
        },
      );

      it('does NOT throw for IN_PROGRESS session (happy path regression)', async () => {
        prisma.workoutSession.findUnique.mockResolvedValue(makeSession());
        prisma.workoutSession.update.mockResolvedValue(
          makeSession({ status: WorkoutSessionStatus.COMPLETED }),
        );

        await expect(
          updateSession('user-1', 'session-1', { status: WorkoutSessionStatus.COMPLETED }),
        ).resolves.toBeDefined();
      });
    });

    // ── updateExerciseLog ──────────────────────────────────────────────────

    describe('updateExerciseLog', () => {
      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'throws SESSION_FINALIZED (409) when session is %s',
        async (terminalStatus) => {
          mockTerminalExerciseLog(terminalStatus);

          await expect(
            updateExerciseLog('user-1', 'session-1', 'elog-1', { status: ExerciseLogStatus.COMPLETED }),
          ).rejects.toMatchObject(finalizedErrorShape);
        },
      );

      it('does NOT throw for IN_PROGRESS session (happy path regression)', async () => {
        prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
        prisma.exerciseLog.update.mockResolvedValue(
          makeExerciseLog({ status: ExerciseLogStatus.COMPLETED }),
        );

        await expect(
          updateExerciseLog('user-1', 'session-1', 'elog-1', { status: ExerciseLogStatus.COMPLETED }),
        ).resolves.toBeDefined();
      });
    });

    // ── createSetLog ───────────────────────────────────────────────────────

    describe('createSetLog', () => {
      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'throws SESSION_FINALIZED (409) when session is %s',
        async (terminalStatus) => {
          mockTerminalExerciseLog(terminalStatus);

          await expect(
            createSetLog('user-1', 'session-1', 'elog-1', { setNumber: 1 }),
          ).rejects.toMatchObject(finalizedErrorShape);
        },
      );

      it('does NOT throw for IN_PROGRESS session (happy path regression)', async () => {
        prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
        prisma.setLog.create.mockResolvedValue(makeSetLog());

        await expect(
          createSetLog('user-1', 'session-1', 'elog-1', { setNumber: 1 }),
        ).resolves.toBeDefined();
      });
    });

    // ── updateSetLog ───────────────────────────────────────────────────────

    describe('updateSetLog', () => {
      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'throws SESSION_FINALIZED (409) when session is %s',
        async (terminalStatus) => {
          mockTerminalExerciseLog(terminalStatus);

          await expect(
            updateSetLog('user-1', 'session-1', 'elog-1', 'slog-1', { load: 70 }),
          ).rejects.toMatchObject(finalizedErrorShape);
        },
      );

      it('does NOT throw for IN_PROGRESS session (happy path regression)', async () => {
        prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
        prisma.setLog.findUnique.mockResolvedValue(makeSetLog());
        prisma.setLog.update.mockResolvedValue(makeSetLog({ load: 70 }));

        await expect(
          updateSetLog('user-1', 'session-1', 'elog-1', 'slog-1', { load: 70 }),
        ).resolves.toBeDefined();
      });
    });

    // ── deleteSetLog ───────────────────────────────────────────────────────

    describe('deleteSetLog', () => {
      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'throws SESSION_FINALIZED (409) when session is %s',
        async (terminalStatus) => {
          mockTerminalExerciseLog(terminalStatus);

          await expect(
            deleteSetLog('user-1', 'session-1', 'elog-1', 'slog-1'),
          ).rejects.toMatchObject(finalizedErrorShape);
        },
      );

      it('does NOT throw for IN_PROGRESS session (happy path regression)', async () => {
        prisma.exerciseLog.findUnique.mockResolvedValue(makeExerciseLog());
        prisma.setLog.findUnique.mockResolvedValue(makeSetLog());
        prisma.setLog.delete.mockResolvedValue(makeSetLog());

        await expect(
          deleteSetLog('user-1', 'session-1', 'elog-1', 'slog-1'),
        ).resolves.toBeDefined();
      });
    });

    // ── substituteExerciseLog ──────────────────────────────────────────────

    describe('substituteExerciseLog', () => {
      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'throws SESSION_FINALIZED (409) when session is %s',
        async (terminalStatus) => {
          prisma.exerciseLog.findUnique.mockResolvedValue(
            makeExerciseLog({
              exerciseId: 'ex-1',
              status: ExerciseLogStatus.PENDING,
              substitutedByExerciseId: null,
              workoutSession: makeSession({ status: terminalStatus }),
            }),
          );

          await expect(
            substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1'),
          ).rejects.toMatchObject(finalizedErrorShape);
        },
      );

      it('does NOT throw for IN_PROGRESS session when guard conditions are met', async () => {
        prisma.exerciseLog.findUnique.mockResolvedValue(
          makeExerciseLog({
            exerciseId: 'ex-1',
            order: 2,
            status: ExerciseLogStatus.PENDING,
            substitutedByExerciseId: null,
            workoutSession: makeSession(),
          }),
        );
        prisma.exercise.findUnique.mockResolvedValue({
          id: 'sub-ex-1',
          substituteForExerciseId: 'ex-1',
          deletedAt: null,
        });
        prisma.$transaction.mockImplementation(async (fn) => {
          const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            exerciseLog: {
              updateMany: vi.fn().mockResolvedValue({ count: 0 }),
              update: vi.fn().mockResolvedValue({}),
              create: vi.fn().mockResolvedValue({ id: 'elog-new', order: 3, setLogs: [] }),
            },
          };
          return fn(tx);
        });

        await expect(
          substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1'),
        ).resolves.toBeDefined();
      });
    });

    // ── undoSubstituteExerciseLog ──────────────────────────────────────────

    describe('undoSubstituteExerciseLog', () => {
      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'throws SESSION_FINALIZED (409) when session is %s',
        async (terminalStatus) => {
          prisma.exerciseLog.findUnique.mockResolvedValue(
            makeExerciseLog({
              id: 'elog-sub',
              exerciseId: 'sub-ex-1',
              workoutSession: makeSession({ status: terminalStatus }),
            }),
          );

          await expect(
            undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub'),
          ).rejects.toMatchObject(finalizedErrorShape);
        },
      );

      it('does NOT throw for IN_PROGRESS session (happy path regression)', async () => {
        prisma.exerciseLog.findUnique.mockResolvedValue(
          makeExerciseLog({ id: 'elog-sub', exerciseId: 'sub-ex-1', workoutSession: makeSession() }),
        );
        prisma.exerciseLog.findFirst.mockResolvedValue({
          id: 'elog-principal',
          workoutSessionId: 'session-1',
          exerciseId: 'ex-1',
          status: ExerciseLogStatus.SUBSTITUTED,
          order: 2,
          substitutedByExerciseId: 'sub-ex-1',
        });
        prisma.setLog.count.mockResolvedValue(0);
        prisma.$transaction.mockImplementation(async (fn) => {
          const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            exerciseLog: {
              update: vi.fn().mockResolvedValue({}),
              delete: vi.fn().mockResolvedValue({}),
              updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
          };
          return fn(tx);
        });

        await expect(
          undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub'),
        ).resolves.toBeUndefined();
      });
    });

    // ── deleteSession (carve-out) ──────────────────────────────────────────

    describe('deleteSession', () => {
      it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
        'soft-deletes successfully even when session is %s (no guard)',
        async (terminalStatus) => {
          prisma.workoutSession.findUnique.mockResolvedValue(makeSession({ status: terminalStatus }));
          prisma.workoutSession.update.mockResolvedValue(
            makeSession({ status: terminalStatus, deletedAt: new Date() }),
          );

          await expect(
            deleteSession('user-1', 'session-1'),
          ).resolves.toBeDefined();

          expect(prisma.workoutSession.update).toHaveBeenCalledWith({
            where: { id: 'session-1' },
            data: { deletedAt: expect.any(Date) },
          });
        },
      );
    });
  });

  // ── getExerciseLastPerformance ────────────────────────────────────────────

  describe('getExerciseLastPerformance', () => {
    const makeExerciseRow = (overrides = {}) => ({
      id: 'ex-1',
      deletedAt: null,
      training: {
        trainingProtocol: { assigneeId: 'user-1' },
      },
      ...overrides,
    });

    const makeLastExerciseLog = (overrides = {}) => ({
      workoutSession: { startedAt: new Date('2026-05-10T08:30:00.000Z') },
      setLogs: [
        {
          setNumber: 1,
          repetitions: 10,
          load: 80.0,
          duration: null,
          rpe: 7,
          restSeconds: 90,
          completed: true,
        },
        {
          setNumber: 2,
          repetitions: 8,
          load: 80.0,
          duration: null,
          rpe: 8,
          restSeconds: 90,
          completed: true,
        },
      ],
      ...overrides,
    });

    it('throws 404 with exercise.notFound when exercise does not exist', async () => {
      prisma.exercise.findUnique.mockResolvedValue(null);

      await expect(getExerciseLastPerformance('user-1', 'ex-1')).rejects.toMatchObject({
        httpStatus: 404,
        error: LastPerformanceErrorCode.EXERCISE_NOT_FOUND,
        messageCode: LastPerformanceMessageCode.EXERCISE_NOT_FOUND,
      });
    });

    it('throws 404 with exercise.notFound when exercise is soft-deleted', async () => {
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow({ deletedAt: new Date() }));

      await expect(getExerciseLastPerformance('user-1', 'ex-1')).rejects.toMatchObject({
        httpStatus: 404,
        error: LastPerformanceErrorCode.EXERCISE_NOT_FOUND,
        messageCode: LastPerformanceMessageCode.EXERCISE_NOT_FOUND,
      });
    });

    it('throws 403 with exercise.notYours when exercise belongs to a different student', async () => {
      prisma.exercise.findUnique.mockResolvedValue(
        makeExerciseRow({
          training: { trainingProtocol: { assigneeId: 'other-user' } },
        }),
      );

      await expect(getExerciseLastPerformance('user-1', 'ex-1')).rejects.toMatchObject({
        httpStatus: 403,
        error: LastPerformanceErrorCode.EXERCISE_NOT_YOURS,
        messageCode: LastPerformanceMessageCode.EXERCISE_NOT_YOURS,
      });
    });

    it('returns { performedAt: null, sets: [], bestSet: null } when no prior exercise log exists', async () => {
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(null);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result).toEqual({ performedAt: null, sets: [], bestSet: null });
    });

    it('returns performedAt and all set logs from the most recent completed session', async () => {
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(makeLastExerciseLog());

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.performedAt).toEqual(new Date('2026-05-10T08:30:00.000Z'));
      expect(result.sets).toHaveLength(2);
      expect(result.sets[0]).toMatchObject({
        setNumber: 1,
        repetitions: 10,
        load: 80.0,
        completed: true,
      });
    });

    it('includes cardio/duration fields when load is null', async () => {
      const cardioLog = makeLastExerciseLog({
        setLogs: [
          {
            setNumber: 1,
            repetitions: null,
            load: null,
            duration: 1800,
            rpe: null,
            restSeconds: 60,
            completed: true,
          },
        ],
      });
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(cardioLog);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.sets[0]).toMatchObject({
        setNumber: 1,
        repetitions: null,
        load: null,
        duration: 1800,
        completed: true,
      });
    });

    it('queries exerciseLog with the correct userId and status exclusion filter', async () => {
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(null);

      await getExerciseLastPerformance('user-1', 'ex-1');

      expect(prisma.exerciseLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            exerciseId: 'ex-1',
            workoutSession: expect.objectContaining({
              userId: 'user-1',
              status: { not: WorkoutSessionStatus.IN_PROGRESS },
              deletedAt: null,
            }),
          }),
        }),
      );
    });

    it('returns only sets from the most recent session when multiple sessions exist for the same day', async () => {
      // The service uses findFirst with orderBy startedAt DESC — the mock returns what
      // Prisma would have returned: the single most-recent match. This test verifies
      // the ordering clause is passed correctly.
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(makeLastExerciseLog());

      await getExerciseLastPerformance('user-1', 'ex-1');

      expect(prisma.exerciseLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { workoutSession: { startedAt: 'desc' } },
        }),
      );
    });

    // ── bestSet computation via getExerciseLastPerformance ─────────────────

    it('bestSet — picks set with highest tonnage (load × repetitions)', async () => {
      // set 1: 100 × 5 = 500 tonnage; set 2: 80 × 8 = 640 tonnage → set 2 wins
      const log = makeLastExerciseLog({
        setLogs: [
          { setNumber: 1, repetitions: 5,  load: 100.0, duration: null, rpe: 7,  restSeconds: 90, completed: true },
          { setNumber: 2, repetitions: 8,  load: 80.0,  duration: null, rpe: 8,  restSeconds: 90, completed: true },
        ],
      });
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(log);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.bestSet).toMatchObject({
        setNumber: 2,
        load: 80.0,
        repetitions: 8,
        completed: true,
        tonnage: 640,
      });
    });

    it('bestSet — tie-break by load: equal tonnage, higher load wins', async () => {
      // 100 × 4 = 400; 80 × 5 = 400 → same tonnage, load 100 wins
      const log = makeLastExerciseLog({
        setLogs: [
          { setNumber: 1, repetitions: 4, load: 100.0, duration: null, rpe: null, restSeconds: null, completed: true },
          { setNumber: 2, repetitions: 5, load: 80.0,  duration: null, rpe: null, restSeconds: null, completed: true },
        ],
      });
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(log);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.bestSet).toMatchObject({ setNumber: 1, load: 100.0, repetitions: 4, tonnage: 400 });
    });

    it('bestSet — tie-break by setNumber: equal tonnage AND equal load, lower setNumber wins', async () => {
      // Both: 100 × 4 = 400 → setNumber 1 beats setNumber 2
      const log = makeLastExerciseLog({
        setLogs: [
          { setNumber: 1, repetitions: 4, load: 100.0, duration: null, rpe: null, restSeconds: null, completed: true },
          { setNumber: 2, repetitions: 4, load: 100.0, duration: null, rpe: null, restSeconds: null, completed: true },
        ],
      });
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(log);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.bestSet).toMatchObject({ setNumber: 1, load: 100.0, repetitions: 4, tonnage: 400 });
    });

    it('bestSet — non-completed sets are excluded even if they have higher tonnage', async () => {
      // set 1 (completed=false): 200 × 10 = 2000 — must be ignored
      // set 2 (completed=true):  80  × 8  = 640  — should be bestSet
      const log = makeLastExerciseLog({
        setLogs: [
          { setNumber: 1, repetitions: 10, load: 200.0, duration: null, rpe: null, restSeconds: null, completed: false },
          { setNumber: 2, repetitions: 8,  load: 80.0,  duration: null, rpe: null, restSeconds: null, completed: true },
        ],
      });
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(log);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.bestSet).toMatchObject({ setNumber: 2, load: 80.0, repetitions: 8, tonnage: 640 });
    });

    it('bestSet — null load/reps excluded; returns null when no qualifying set exists', async () => {
      // All sets have null load or null reps — none qualifies
      const log = makeLastExerciseLog({
        setLogs: [
          { setNumber: 1, repetitions: null, load: null,  duration: 1800, rpe: null, restSeconds: null, completed: true },
          { setNumber: 2, repetitions: 10,   load: null,  duration: null, rpe: null, restSeconds: null, completed: true },
          { setNumber: 3, repetitions: null, load: 80.0,  duration: null, rpe: null, restSeconds: null, completed: true },
        ],
      });
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(log);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.bestSet).toBeNull();
    });

    it('bestSet.tonnage equals load × repetitions of the chosen set', async () => {
      const expectedLoad = 120.0;
      const expectedReps = 6;
      const expectedTonnage = expectedLoad * expectedReps; // 720

      const log = makeLastExerciseLog({
        setLogs: [
          { setNumber: 1, repetitions: expectedReps, load: expectedLoad, duration: null, rpe: 9, restSeconds: 120, completed: true },
        ],
      });
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(log);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.bestSet).not.toBeNull();
      expect(result.bestSet.tonnage).toBe(expectedTonnage);
      expect(result.bestSet.load).toBe(expectedLoad);
      expect(result.bestSet.repetitions).toBe(expectedReps);
    });

    it('bestSet includes rpe, restSeconds, and duration from the winning set', async () => {
      const log = makeLastExerciseLog({
        setLogs: [
          { setNumber: 1, repetitions: 10, load: 80.0, duration: 45, rpe: 8, restSeconds: 120, completed: true },
        ],
      });
      prisma.exercise.findUnique.mockResolvedValue(makeExerciseRow());
      prisma.exerciseLog.findFirst.mockResolvedValue(log);

      const result = await getExerciseLastPerformance('user-1', 'ex-1');

      expect(result.bestSet).toMatchObject({
        duration: 45,
        rpe: 8,
        restSeconds: 120,
        completed: true,
      });
    });
  });

  // ── getSession with previousLog ───────────────────────────────────────────

  describe('getSession — previousLog attachment', () => {
    const makePreviousLogRow = (overrides = {}) => ({
      id: 'prev-elog-1',
      exercise_id: 'ex-1',
      workout_session_id: 'prev-session-1',
      finished_at: new Date('2026-05-01T10:00:00Z'),
      ...overrides,
    });

    const makeSessionWithExerciseLogs = (exerciseLogs = [], overrides = {}) => ({
      id: 'session-1',
      trainingId: 'training-1',
      userId: 'user-1',
      status: WorkoutSessionStatus.IN_PROGRESS,
      startedAt: new Date('2026-05-10T09:00:00Z'),
      finishedAt: null,
      durationSeconds: null,
      deletedAt: null,
      notes: null,
      training: { id: 'training-1', name: 'Chest Day', category: 'strength', estimatedDurationSeconds: 3600 },
      exerciseLogs,
      ...overrides,
    });

    const makeExerciseLogInSession = (overrides = {}) => ({
      id: 'elog-1',
      workoutSessionId: 'session-1',
      exerciseId: 'ex-1',
      substitutedByExerciseId: null,
      status: ExerciseLogStatus.PENDING,
      order: 0,
      notes: null,
      exercise: { id: 'ex-1', name: 'Bench Press' },
      setLogs: [],
      ...overrides,
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('throws WORKOUT_SESSION_NOT_FOUND when session does not exist', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(null);

      await expect(getSession('user-1', 'session-1')).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws WORKOUT_SESSION_NOT_FOUND when session is soft-deleted', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(
        makeSessionWithExerciseLogs([], { deletedAt: new Date() }),
      );

      await expect(getSession('user-1', 'session-1')).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws FORBIDDEN_NOT_YOUR_SESSION when session belongs to another user', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(
        makeSessionWithExerciseLogs([], { userId: 'other-user' }),
      );

      await expect(getSession('user-1', 'session-1')).rejects.toMatchObject({
        code: 'FORBIDDEN_NOT_YOUR_SESSION',
        statusCode: 403,
      });
    });

    it('skips both batch queries when session has no exerciseLogs', async () => {
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs([]));

      await getSession('user-1', 'session-1');

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.setLog.findMany).not.toHaveBeenCalled();
    });

    it('attaches previousLog from the most recent completed session', async () => {
      const exerciseLogs = [makeExerciseLogInSession()];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));

      const previousLogRow = makePreviousLogRow();
      prisma.$queryRaw.mockResolvedValue([previousLogRow]);

      prisma.setLog.findMany.mockResolvedValue([
        { exerciseLogId: 'prev-elog-1', setNumber: 1, repetitions: 10, load: 80.0, duration: null },
        { exerciseLogId: 'prev-elog-1', setNumber: 2, repetitions: 8, load: 80.0, duration: null },
      ]);

      const session = await getSession('user-1', 'session-1');

      expect(session.exerciseLogs[0].previousLog).toMatchObject({
        workoutSessionId: 'prev-session-1',
        finishedAt: expect.any(Date),
        setLogs: [
          { setNumber: 1, repetitions: 10, load: 80.0, duration: null },
          { setNumber: 2, repetitions: 8, load: 80.0, duration: null },
        ],
      });
    });

    it('sets previousLog to null when no prior completed session exists', async () => {
      const exerciseLogs = [makeExerciseLogInSession()];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([]);

      const session = await getSession('user-1', 'session-1');

      expect(session.exerciseLogs[0].previousLog).toBeNull();
      expect(prisma.setLog.findMany).not.toHaveBeenCalled();
    });

    it('uses substitutedByExerciseId as effective exerciseId when set', async () => {
      const exerciseLogs = [
        makeExerciseLogInSession({
          exerciseId: 'ex-1',
          substitutedByExerciseId: 'sub-ex-1',
        }),
      ];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([]);

      await getSession('user-1', 'session-1');

      // $queryRaw tagged template passes the template strings array as arg[0],
      // followed by interpolated values. The exercise IDs array is interpolated first.
      const rawCallArgs = prisma.$queryRaw.mock.calls[0];
      // rawCallArgs[0] = TemplateStringsArray, rawCallArgs[1] = exerciseIds array
      const exerciseIdsArg = rawCallArgs[1];
      expect(Array.isArray(exerciseIdsArg)).toBe(true);
      expect(exerciseIdsArg).toContain('sub-ex-1');
      expect(exerciseIdsArg).not.toContain('ex-1');
    });

    it('attaches previousLog using substitute exercise history when substituted', async () => {
      const exerciseLogs = [
        makeExerciseLogInSession({
          exerciseId: 'ex-1',
          substitutedByExerciseId: 'sub-ex-1',
        }),
      ];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));

      const previousLogRow = makePreviousLogRow({
        id: 'prev-sub-elog-1',
        exercise_id: 'sub-ex-1',
        workout_session_id: 'prev-session-2',
      });
      prisma.$queryRaw.mockResolvedValue([previousLogRow]);

      prisma.setLog.findMany.mockResolvedValue([
        { exerciseLogId: 'prev-sub-elog-1', setNumber: 1, repetitions: 15, load: null, duration: 1800 },
      ]);

      const session = await getSession('user-1', 'session-1');

      expect(session.exerciseLogs[0].previousLog).toMatchObject({
        workoutSessionId: 'prev-session-2',
        setLogs: [{ setNumber: 1, repetitions: 15, load: null, duration: 1800 }],
      });
    });

    it('batches queries for multiple exerciseLogs — fires $queryRaw only once', async () => {
      const exerciseLogs = [
        makeExerciseLogInSession({ id: 'elog-1', exerciseId: 'ex-1' }),
        makeExerciseLogInSession({ id: 'elog-2', exerciseId: 'ex-2' }),
      ];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([]);

      await getSession('user-1', 'session-1');

      expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    });

    it('maps setLogs to the correct exerciseLog when multiple previous logs exist', async () => {
      const exerciseLogs = [
        makeExerciseLogInSession({ id: 'elog-1', exerciseId: 'ex-1' }),
        makeExerciseLogInSession({ id: 'elog-2', exerciseId: 'ex-2' }),
      ];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));

      prisma.$queryRaw.mockResolvedValue([
        makePreviousLogRow({ id: 'prev-elog-1', exercise_id: 'ex-1', workout_session_id: 'prev-s-1' }),
        makePreviousLogRow({ id: 'prev-elog-2', exercise_id: 'ex-2', workout_session_id: 'prev-s-2' }),
      ]);

      prisma.setLog.findMany.mockResolvedValue([
        { exerciseLogId: 'prev-elog-1', setNumber: 1, repetitions: 10, load: 80.0, duration: null },
        { exerciseLogId: 'prev-elog-2', setNumber: 1, repetitions: null, load: null, duration: 600 },
      ]);

      const session = await getSession('user-1', 'session-1');

      expect(session.exerciseLogs[0].previousLog.setLogs).toHaveLength(1);
      expect(session.exerciseLogs[0].previousLog.setLogs[0]).toMatchObject({ setNumber: 1, load: 80.0 });
      expect(session.exerciseLogs[1].previousLog.setLogs).toHaveLength(1);
      expect(session.exerciseLogs[1].previousLog.setLogs[0]).toMatchObject({ setNumber: 1, duration: 600 });
    });

    it('passes currentSessionId to $queryRaw to exclude the current session', async () => {
      const exerciseLogs = [makeExerciseLogInSession()];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([]);

      await getSession('user-1', 'session-1');

      // $queryRaw tagged template interpolated values: [exerciseIds, userId, status, currentSessionId]
      const rawCallArgs = prisma.$queryRaw.mock.calls[0];
      const interpolatedValues = rawCallArgs.slice(1); // skip the TemplateStringsArray
      // currentSessionId is the 4th interpolated value (index 3 of the slice)
      expect(interpolatedValues).toContainEqual('session-1');
    });

    it('does not include setLogs with completed=false in previousLog', async () => {
      // The setLog query filters completed=true at the DB level.
      // This test verifies the findMany call uses the correct filter.
      const exerciseLogs = [makeExerciseLogInSession()];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([makePreviousLogRow()]);
      prisma.setLog.findMany.mockResolvedValue([]);

      await getSession('user-1', 'session-1');

      expect(prisma.setLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ completed: true }),
        }),
      );
    });

    it('previousLog.setLogs is empty array when prior log had no completed sets', async () => {
      const exerciseLogs = [makeExerciseLogInSession()];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([makePreviousLogRow()]);
      prisma.setLog.findMany.mockResolvedValue([]);

      const session = await getSession('user-1', 'session-1');

      expect(session.exerciseLogs[0].previousLog.setLogs).toEqual([]);
    });

    it('previousLog includes bestSet with correct tonnage when prior session has qualifying sets', async () => {
      // set: 80 × 10 = 800 tonnage
      const exerciseLogs = [makeExerciseLogInSession()];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([makePreviousLogRow()]);
      prisma.setLog.findMany.mockResolvedValue([
        { exerciseLogId: 'prev-elog-1', setNumber: 1, repetitions: 10, load: 80.0, duration: null, rpe: 7, restSeconds: 90, completed: true },
      ]);

      const session = await getSession('user-1', 'session-1');

      const previousLog = session.exerciseLogs[0].previousLog;
      expect(previousLog).not.toBeNull();
      expect(previousLog.bestSet).toMatchObject({
        setNumber: 1,
        load: 80.0,
        repetitions: 10,
        completed: true,
        tonnage: 800,
      });
    });

    it('previousLog.bestSet is null when prior session had no completed sets with load and reps', async () => {
      const exerciseLogs = [makeExerciseLogInSession()];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([makePreviousLogRow()]);
      // Cardio-only set: no load, no reps — bestSet must be null
      prisma.setLog.findMany.mockResolvedValue([
        { exerciseLogId: 'prev-elog-1', setNumber: 1, repetitions: null, load: null, duration: 1800, rpe: null, restSeconds: 60, completed: true },
      ]);

      const session = await getSession('user-1', 'session-1');

      expect(session.exerciseLogs[0].previousLog.bestSet).toBeNull();
    });

    it('previousLog.bestSet picks highest-tonnage set when multiple sets exist', async () => {
      // set 1: 100 × 3 = 300; set 2: 70 × 6 = 420 → set 2 wins
      const exerciseLogs = [makeExerciseLogInSession()];
      prisma.workoutSession.findUnique.mockResolvedValue(makeSessionWithExerciseLogs(exerciseLogs));
      prisma.$queryRaw.mockResolvedValue([makePreviousLogRow()]);
      prisma.setLog.findMany.mockResolvedValue([
        { exerciseLogId: 'prev-elog-1', setNumber: 1, repetitions: 3, load: 100.0, duration: null, rpe: 9, restSeconds: 120, completed: true },
        { exerciseLogId: 'prev-elog-1', setNumber: 2, repetitions: 6, load: 70.0,  duration: null, rpe: 7, restSeconds: 90,  completed: true },
      ]);

      const session = await getSession('user-1', 'session-1');

      expect(session.exerciseLogs[0].previousLog.bestSet).toMatchObject({
        setNumber: 2,
        load: 70.0,
        repetitions: 6,
        tonnage: 420,
      });
    });
  });

  // ── lockWorkoutSessionForUpdate — lock ordering ────────────────────────────

  describe('lockWorkoutSessionForUpdate — lock ordering', () => {
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
      order: 3,
      setLogs: [],
      ...overrides,
    });

    const makeSubstituteLog = (overrides = {}) =>
      makeExerciseLog({
        id: 'elog-sub',
        exerciseId: 'sub-ex-1',
        order: 3,
        status: ExerciseLogStatus.PENDING,
        substitutedByExerciseId: null,
        workoutSession: makeSession({ userId: 'user-1' }),
        ...overrides,
      });

    const makePrincipalForUndo = (overrides = {}) => ({
      id: 'elog-principal',
      workoutSessionId: 'session-1',
      exerciseId: 'ex-1',
      status: ExerciseLogStatus.SUBSTITUTED,
      order: 2,
      substitutedByExerciseId: 'sub-ex-1',
      ...overrides,
    });

    it('substituteExerciseLog — $queryRaw fires before first exerciseLog write', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makePrincipalLog());
      prisma.exercise.findUnique.mockResolvedValue(makeSubstituteExercise());

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exerciseLog: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          update: vi.fn().mockResolvedValue({}),
          create: vi.fn().mockResolvedValue(makeNewLog()),
        },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await substituteExerciseLog('user-1', 'session-1', 'elog-1', 'sub-ex-1');

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.exerciseLog.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('undoSubstituteExerciseLog — $queryRaw fires before first exerciseLog write', async () => {
      prisma.exerciseLog.findUnique.mockResolvedValue(makeSubstituteLog());
      prisma.exerciseLog.findFirst.mockResolvedValue(makePrincipalForUndo());
      prisma.setLog.count.mockResolvedValue(0);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        exerciseLog: {
          update: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await undoSubstituteExerciseLog('user-1', 'session-1', 'elog-sub');

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.exerciseLog.update.mock.invocationCallOrder[0],
      );
    });
  });
});
