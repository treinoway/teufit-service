/**
 * Unit tests for getSessionDetail (GET /admin/manager/sessions/:sessionId).
 * Assumed Prisma calls on the injected admin client:
 * - workoutSession.findUnique (or findFirst) with a nested select: training, user, exerciseLogs (exercise + setLogs)
 * - $queryRaw for the previous-session lookup, rows shaped { id, exercise_id, workout_session_id, finished_at }
 * - setLog.findMany for the previous logs' sets (faked to honour where.exerciseLogId and where.completed)
 * - exercise.findMany for substitute exercise names (faked to honour where.id.in)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { AdminManagerMessageCode } from '../../src/constants/admin-manager.js';
import { ExerciseLogStatus, WorkoutSessionStatus } from '../../src/constants/training.js';
import { getSessionDetail } from '../../src/services/admin-manager-service.js';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRAINING_ID = '55555555-5555-4555-8555-555555555555';
const EXERCISE_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_EXERCISE_ID = '77777777-7777-4777-8777-777777777777';
const SUBSTITUTE_EXERCISE_ID = '88888888-8888-4888-8888-888888888888';
const EXERCISE_LOG_ID = '99999999-9999-4999-8999-999999999991';
const OTHER_EXERCISE_LOG_ID = '99999999-9999-4999-8999-999999999992';
const PREVIOUS_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PREVIOUS_EXERCISE_LOG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SET_LOG_ID_1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const SET_LOG_ID_2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const SUBSTITUTE_NAME = 'Supino com halteres';
const STARTED_AT = new Date('2026-04-10T09:00:00.000Z');
const FINISHED_AT = new Date('2026-04-10T10:00:00.000Z');
const PREVIOUS_FINISHED_AT = new Date('2026-04-08T10:00:00.000Z');
const DELETED_AT = new Date('2026-04-12T10:00:00.000Z');
const DURATION_SECONDS = 3600;
const NOT_FOUND_STATUS = 404;
const UNAVAILABLE_STATUS = 503;
const STATEMENT_TIMEOUT_CODE = '57014';
const SESSION_NOT_FOUND_CODE = 'admin.sessionNotFound';
const QUERY_TIMEOUT_CODE = 'admin.queryTimeout';
const NOT_FOUND_ERROR = 'NOT_FOUND';
const ASC = 'asc';

const mockAdminDb = {
  workoutSession: { findUnique: vi.fn(), findFirst: vi.fn() },
  exercise: { findMany: vi.fn() },
  setLog: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
};

// Builds a logged set row as stored in set_logs.
function makeSetLogRow(overrides = {}) {
  return {
    id: SET_LOG_ID_1,
    setNumber: 1,
    repetitions: 10,
    load: 60,
    duration: null,
    rpe: 8,
    restSeconds: 90,
    completed: true,
    notes: null,
    ...overrides,
  };
}

// Builds an exercise log row with its prescribed exercise and set logs.
function makeExerciseLogRow(overrides = {}) {
  return {
    id: EXERCISE_LOG_ID,
    exerciseId: EXERCISE_ID,
    order: 0,
    status: ExerciseLogStatus.COMPLETED,
    notes: 'Boa execução',
    substitutedByExerciseId: null,
    exercise: {
      id: EXERCISE_ID,
      name: 'Supino reto',
      sets: 3,
      repetitions: [10, 10, 8],
      hasLoad: true,
      suggestedLoad: 60,
      restInterval: 90,
      prescriptionMode: 'reps',
    },
    setLogs: [makeSetLogRow()],
    ...overrides,
  };
}

// Builds a workout session row as the nested select returns it.
function makeSessionRow(overrides = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    trainingId: TRAINING_ID,
    status: WorkoutSessionStatus.COMPLETED,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    durationSeconds: DURATION_SECONDS,
    notes: 'Treino pesado',
    deletedAt: null,
    training: { id: TRAINING_ID, name: 'Treino A' },
    user: { id: USER_ID, firstName: 'Bia', lastName: 'Souza', email: 'bia@example.com' },
    exerciseLogs: [makeExerciseLogRow()],
    ...overrides,
  };
}

// Builds a previous-session row as the raw lookup returns it.
function makePreviousRow(overrides = {}) {
  return {
    id: PREVIOUS_EXERCISE_LOG_ID,
    exercise_id: EXERCISE_ID,
    workout_session_id: PREVIOUS_SESSION_ID,
    finished_at: PREVIOUS_FINISHED_AT,
    ...overrides,
  };
}

// Tells whether a Prisma scalar filter (plain value or { in }) matches the value.
function matchesFilter(filter, value) {
  if (filter === undefined) return true;
  if (filter && Array.isArray(filter.in)) return filter.in.includes(value);
  return filter === value;
}

// Fakes setLog.findMany over in-memory rows, honouring exerciseLogId and completed filters.
function fakeSetLogFindMany(rows) {
  return async ({ where = {} } = {}) => rows.filter(
    (row) => matchesFilter(where.exerciseLogId, row.exerciseLogId) && matchesFilter(where.completed, row.completed),
  );
}

// Fakes exercise.findMany over in-memory rows, honouring the id filter.
function fakeExerciseFindMany(rows) {
  return async ({ where = {} } = {}) => rows.filter((row) => matchesFilter(where.id, row.id));
}

// Makes both session lookups resolve to the same row so either Prisma method works.
function resolveSession(row) {
  mockAdminDb.workoutSession.findUnique.mockResolvedValue(row);
  mockAdminDb.workoutSession.findFirst.mockResolvedValue(row);
}

// Returns the args of whichever session lookup the implementation used.
function sessionQueryArgs() {
  const call = mockAdminDb.workoutSession.findUnique.mock.calls[0] ?? mockAdminDb.workoutSession.findFirst.mock.calls[0];
  return call[0];
}

// Extracts SQL text and bound values from a $queryRaw call (tagged template or Prisma.sql object).
function rawQueryOf(call) {
  const [first, ...rest] = call;
  if (first && Array.isArray(first.values) && first.strings) {
    return { text: first.strings.join('?').toLowerCase(), values: first.values };
  }
  return { text: Array.from(first).join('?').toLowerCase(), values: rest };
}

// Returns the first $queryRaw call as text plus values.
function firstRawQuery() {
  expect(mockAdminDb.$queryRaw).toHaveBeenCalled();
  return rawQueryOf(mockAdminDb.$queryRaw.mock.calls[0]);
}

// Tells whether any bound value is a Date equal to the expected one.
function hasDateValue(values, expected) {
  return values.some((value) => value instanceof Date && value.getTime() === expected.getTime());
}

// Flattens bound values so array parameters can be searched for ids.
function flatValues(values) {
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

// Normalizes a Prisma orderBy (object or array) to an array.
function toOrderList(orderBy) {
  return [].concat(orderBy ?? []);
}

// Builds a Postgres statement-timeout error as a raw pg driver error.
function makePgTimeoutError() {
  return Object.assign(new Error('canceling statement due to statement timeout'), { code: STATEMENT_TIMEOUT_CODE });
}

// Calls the service for the default session id and returns the thrown error.
function callExpectingError() {
  return getSessionDetail(mockAdminDb, { sessionId: SESSION_ID }).catch((error) => error);
}

beforeEach(() => {
  resolveSession(makeSessionRow());
  mockAdminDb.$queryRaw.mockResolvedValue([]);
  mockAdminDb.setLog.findMany.mockImplementation(fakeSetLogFindMany([]));
  mockAdminDb.exercise.findMany.mockImplementation(fakeExerciseFindMany([]));
});

describe('getSessionDetail', () => {
  describe('criterion 2: unknown session', () => {
    it('should keep the stable messageCode constant', () => {
      expect(AdminManagerMessageCode.SESSION_NOT_FOUND).toBe(SESSION_NOT_FOUND_CODE);
    });

    it('should throw a 404 AppError admin.sessionNotFound when the session does not exist', async () => {
      resolveSession(null);

      const error = await callExpectingError();

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        httpStatus: NOT_FOUND_STATUS,
        error: NOT_FOUND_ERROR,
        messageCode: SESSION_NOT_FOUND_CODE,
        message: expect.any(String),
      });
    });
  });

  describe('criterion 1: statement timeout mapping', () => {
    it('should map a timeout on the session query to a 503 admin.queryTimeout', async () => {
      mockAdminDb.workoutSession.findUnique.mockRejectedValue(makePgTimeoutError());
      mockAdminDb.workoutSession.findFirst.mockRejectedValue(makePgTimeoutError());

      const error = await callExpectingError();

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ httpStatus: UNAVAILABLE_STATUS, messageCode: QUERY_TIMEOUT_CODE });
    });

    it('should map a timeout on the previous-log lookup to a 503 admin.queryTimeout', async () => {
      mockAdminDb.$queryRaw.mockRejectedValue(makePgTimeoutError());

      const error = await callExpectingError();

      expect(error).toMatchObject({ httpStatus: UNAVAILABLE_STATUS, messageCode: QUERY_TIMEOUT_CODE });
    });

    it('should rethrow non-timeout errors unchanged', async () => {
      const boom = new Error('connection reset');
      mockAdminDb.workoutSession.findUnique.mockRejectedValue(boom);
      mockAdminDb.workoutSession.findFirst.mockRejectedValue(boom);

      const error = await callExpectingError();

      expect(error).toBe(boom);
    });
  });

  describe('criterion 3: session shape', () => {
    it('should return the session header, training and student', async () => {
      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result).toMatchObject({
        id: SESSION_ID,
        status: WorkoutSessionStatus.COMPLETED,
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        durationSec: DURATION_SECONDS,
        notes: 'Treino pesado',
        deletedAt: null,
        training: { id: TRAINING_ID, name: 'Treino A' },
        student: { id: USER_ID, firstName: 'Bia', lastName: 'Souza', email: 'bia@example.com' },
      });
    });

    it('should look the session up by id without filtering out soft-deleted rows', async () => {
      await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      const { where } = sessionQueryArgs();
      expect(where).toMatchObject({ id: SESSION_ID });
      expect(where).not.toHaveProperty('deletedAt');
    });

    it('should return a soft-deleted session with its deletedAt', async () => {
      resolveSession(makeSessionRow({ deletedAt: DELETED_AT }));

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result).toMatchObject({ id: SESSION_ID, deletedAt: DELETED_AT });
    });

    it('should return an in-progress session with a null finishedAt', async () => {
      resolveSession(makeSessionRow({ status: WorkoutSessionStatus.IN_PROGRESS, finishedAt: null, durationSeconds: null }));

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result).toMatchObject({ status: WorkoutSessionStatus.IN_PROGRESS, finishedAt: null, durationSec: null });
    });

    it('should use select and never include on the session query', async () => {
      await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      const args = sessionQueryArgs();
      expect(args.select).toBeDefined();
      expect(args.include).toBeUndefined();
    });

    it('should return an empty exerciseLogs list for a session without logs', async () => {
      resolveSession(makeSessionRow({ exerciseLogs: [] }));

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs).toEqual([]);
    });
  });

  describe('criterion 4: exercise logs and set logs', () => {
    it('should map each exercise log with its prescribed exercise', async () => {
      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0]).toMatchObject({
        id: EXERCISE_LOG_ID,
        order: 0,
        status: ExerciseLogStatus.COMPLETED,
        notes: 'Boa execução',
        substitutedByExerciseId: null,
        substitutedByExerciseName: null,
        exercise: {
          id: EXERCISE_ID,
          name: 'Supino reto',
          sets: 3,
          repetitions: [10, 10, 8],
          suggestedLoad: 60,
          restInterval: 90,
          prescriptionMode: 'reps',
        },
      });
    });

    it('should return every stored set field, including incomplete sets', async () => {
      const incomplete = makeSetLogRow({ id: SET_LOG_ID_2, setNumber: 2, repetitions: 4, completed: false, notes: 'Falhou' });
      resolveSession(makeSessionRow({ exerciseLogs: [makeExerciseLogRow({ setLogs: [makeSetLogRow(), incomplete] })] }));

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0].setLogs).toEqual([
        { id: SET_LOG_ID_1, setNumber: 1, repetitions: 10, load: 60, duration: null, rpe: 8, restSeconds: 90, completed: true, notes: null },
        { id: SET_LOG_ID_2, setNumber: 2, repetitions: 4, load: 60, duration: null, rpe: 8, restSeconds: 90, completed: false, notes: 'Falhou' },
      ]);
    });

    it('should order exercise logs by order asc then id asc', async () => {
      await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      const { exerciseLogs } = sessionQueryArgs().select;
      expect(toOrderList(exerciseLogs.orderBy)).toEqual([{ order: ASC }, { id: ASC }]);
    });

    it('should order set logs by setNumber asc', async () => {
      await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      const { setLogs } = sessionQueryArgs().select.exerciseLogs.select;
      expect(toOrderList(setLogs.orderBy)[0]).toEqual({ setNumber: ASC });
    });

    it('should not filter out incomplete set logs in the session query', async () => {
      await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      const { setLogs } = sessionQueryArgs().select.exerciseLogs.select;
      expect(setLogs.where?.completed).toBeUndefined();
    });

    it('should resolve the substitute exercise name for a substituted log', async () => {
      resolveSession(makeSessionRow({
        exerciseLogs: [makeExerciseLogRow({ status: ExerciseLogStatus.SUBSTITUTED, substitutedByExerciseId: SUBSTITUTE_EXERCISE_ID })],
      }));
      mockAdminDb.exercise.findMany.mockImplementation(fakeExerciseFindMany([{ id: SUBSTITUTE_EXERCISE_ID, name: SUBSTITUTE_NAME }]));

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0]).toMatchObject({
        status: ExerciseLogStatus.SUBSTITUTED,
        substitutedByExerciseId: SUBSTITUTE_EXERCISE_ID,
        substitutedByExerciseName: SUBSTITUTE_NAME,
      });
    });

    it('should return a null substitute name when the substitute exercise is not found', async () => {
      resolveSession(makeSessionRow({ exerciseLogs: [makeExerciseLogRow({ substitutedByExerciseId: SUBSTITUTE_EXERCISE_ID })] }));

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0].substitutedByExerciseName).toBeNull();
    });
  });

  describe('criterion 5: previousLog', () => {
    it('should only consider sessions that finished before this session started', async () => {
      await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      const { text, values } = firstRawQuery();
      expect(text).toMatch(/finished_at\s*</);
      expect(hasDateValue(values, STARTED_AT)).toBe(true);
    });

    it('should restrict the lookup to the same student, completed and non-deleted sessions', async () => {
      await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      const { text, values } = firstRawQuery();
      expect(values).toContain(USER_ID);
      expect(text.includes(WorkoutSessionStatus.COMPLETED) || values.includes(WorkoutSessionStatus.COMPLETED)).toBe(true);
      expect(text).toMatch(/deleted_at\s+is\s+null/);
    });

    it('should attach the previous session with completed sets only and its best set', async () => {
      mockAdminDb.$queryRaw.mockResolvedValue([makePreviousRow()]);
      mockAdminDb.setLog.findMany.mockImplementation(fakeSetLogFindMany([
        { exerciseLogId: PREVIOUS_EXERCISE_LOG_ID, setNumber: 1, repetitions: 10, load: 50, duration: null, rpe: null, restSeconds: null, completed: true },
        { exerciseLogId: PREVIOUS_EXERCISE_LOG_ID, setNumber: 2, repetitions: 8, load: 70, duration: null, rpe: null, restSeconds: null, completed: true },
        { exerciseLogId: PREVIOUS_EXERCISE_LOG_ID, setNumber: 3, repetitions: 12, load: 90, duration: null, rpe: null, restSeconds: null, completed: false },
      ]));

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0].previousLog).toMatchObject({
        workoutSessionId: PREVIOUS_SESSION_ID,
        finishedAt: PREVIOUS_FINISHED_AT,
        setLogs: [
          { setNumber: 1, repetitions: 10, load: 50, duration: null },
          { setNumber: 2, repetitions: 8, load: 70, duration: null },
        ],
        bestSet: { setNumber: 2, load: 70, repetitions: 8 },
      });
    });

    it('should return a null bestSet when no previous set has load and repetitions', async () => {
      mockAdminDb.$queryRaw.mockResolvedValue([makePreviousRow()]);
      mockAdminDb.setLog.findMany.mockImplementation(fakeSetLogFindMany([
        { exerciseLogId: PREVIOUS_EXERCISE_LOG_ID, setNumber: 1, repetitions: null, load: null, duration: 30, rpe: null, restSeconds: null, completed: true },
      ]));

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0].previousLog).toMatchObject({ setLogs: [{ setNumber: 1, duration: 30 }], bestSet: null });
    });

    it('should return null previousLog when there is no earlier session for the exercise', async () => {
      const otherLog = makeExerciseLogRow({ id: OTHER_EXERCISE_LOG_ID, exerciseId: OTHER_EXERCISE_ID, order: 1, exercise: { ...makeExerciseLogRow().exercise, id: OTHER_EXERCISE_ID } });
      resolveSession(makeSessionRow({ exerciseLogs: [makeExerciseLogRow(), otherLog] }));
      mockAdminDb.$queryRaw.mockResolvedValue([makePreviousRow()]);

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0].previousLog).toMatchObject({ workoutSessionId: PREVIOUS_SESSION_ID });
      expect(result.exerciseLogs[1].previousLog).toBeNull();
    });

    it('should return null previousLog for every log when the lookup finds nothing', async () => {
      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0].previousLog).toBeNull();
    });

    it('should look up and key the previous log by the substitute exercise when the log was substituted', async () => {
      resolveSession(makeSessionRow({ exerciseLogs: [makeExerciseLogRow({ substitutedByExerciseId: SUBSTITUTE_EXERCISE_ID })] }));
      mockAdminDb.$queryRaw.mockResolvedValue([makePreviousRow({ exercise_id: SUBSTITUTE_EXERCISE_ID })]);

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(flatValues(firstRawQuery().values)).toContain(SUBSTITUTE_EXERCISE_ID);
      expect(result.exerciseLogs[0].previousLog).toMatchObject({ workoutSessionId: PREVIOUS_SESSION_ID });
    });

    it('should not use the prescribed exercise history for a substituted log', async () => {
      resolveSession(makeSessionRow({ exerciseLogs: [makeExerciseLogRow({ substitutedByExerciseId: SUBSTITUTE_EXERCISE_ID })] }));
      mockAdminDb.$queryRaw.mockResolvedValue([makePreviousRow({ exercise_id: EXERCISE_ID })]);

      const result = await getSessionDetail(mockAdminDb, { sessionId: SESSION_ID });

      expect(result.exerciseLogs[0].previousLog).toBeNull();
    });
  });
});
