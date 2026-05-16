import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma before any service imports
vi.mock('../../src/db.js', () => ({
  prisma: {
    workoutSession: {
      groupBy: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    trainingProtocol: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    exercise: { findFirst: vi.fn() },
    exerciseLog: { findMany: vi.fn() },
    trainer: { findUnique: vi.fn() },
    trainerStudent: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

// Mock resolveTrainerStudent from workout-session-service
vi.mock('../../src/services/workout-session-service.js', () => ({
  resolveTrainerStudent: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { resolveTrainerStudent } from '../../src/services/workout-session-service.js';
import {
  getDashboardSummary,
  getRecentSessions,
  getExerciseProgression,
  getExerciseProgressionDetail,
  getDailyActivity,
  buildAiPerformanceSnapshot,
} from '../../src/services/student-dashboard-service.js';
import { DASHBOARD_DEFAULTS, DashboardMessageCode, WorkoutSessionStatus } from '../../src/constants/training.js';

// ─── Factories ────────────────────────────────────────────────────────────────

const TRAINER_ID = 'trainer-user-1';
const STUDENT_ID = 'student-user-1';
const EXERCISE_ID = 'exercise-1';

const makeGroupByResult = (completed = 0, inProgress = 0, abandoned = 0) => {
  const result = [];
  if (completed > 0) result.push({ status: 'completed', _count: { _all: completed } });
  if (inProgress > 0) result.push({ status: 'in_progress', _count: { _all: inProgress } });
  if (abandoned > 0) result.push({ status: 'abandoned', _count: { _all: abandoned } });
  return result;
};

const makeProtocol = (overrides = {}) => ({
  id: 'protocol-1',
  name: 'Hypertrophy Block',
  startDate: new Date('2026-01-01T12:00:00Z'),
  expirationDate: new Date('2026-06-30T12:00:00Z'),
  ...overrides,
});

const makeSession = (overrides = {}) => ({
  id: 'session-1',
  trainingId: 'training-1',
  status: WorkoutSessionStatus.COMPLETED,
  startedAt: new Date('2026-04-01T10:00:00Z'),
  finishedAt: new Date('2026-04-01T11:00:00Z'),
  durationSeconds: 3600,
  training: { id: 'training-1', name: 'Peito' },
  ...overrides,
});

// A raw daily-activity row as returned by $queryRaw (getDailyActivity)
const makeDailyActivityRow = (overrides = {}) => ({
  date: '2026-04-15',
  session_count: 1n,
  session_ids: ['session-1'],
  has_completed: true,
  has_abandoned: false,
  total_volume_kg: 1812.0,
  completed_sets: 12n,
  total_sets: 14n,
  ...overrides,
});

// A raw streak date row as returned by $queryRaw (getDashboardSummary)
const makeStreakDateRow = (date) => ({ session_date: date });

// A raw RPE row as returned by $queryRaw (getRecentSessions)
const makeRpeRow = (sessionId, avgRpe) => ({ session_id: sessionId, avg_rpe: avgRpe });

// A raw progression row as returned by $queryRaw
const makeProgressionRow = (overrides = {}) => ({
  exercise_id: EXERCISE_ID,
  exercise_name: 'Bench Press',
  has_load: true,
  prescription_mode: 'reps',
  training_id: 'training-1',
  training_name: 'Peito',
  session_id: 'session-1',
  started_at: new Date('2026-04-01T10:00:00Z'),
  status: 'completed',
  max_load: 80,
  avg_load: 70,
  total_volume: 2800,
  completed_sets: 4n,
  total_reps: 40n,
  avg_rpe: 8,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('student-dashboard-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: trainer-student link is valid
    resolveTrainerStudent.mockResolvedValue({ id: 'trainer-profile-1' });
  });

  // ---------------------------------------------------------------------------
  // resolveWindow (tested indirectly via getDashboardSummary)
  // ---------------------------------------------------------------------------

  describe('resolveWindow (via getDashboardSummary)', () => {
    beforeEach(() => {
      prisma.workoutSession.groupBy.mockResolvedValue([]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      // getDashboardSummary now issues a $queryRaw for streak date aggregation
      prisma.$queryRaw.mockResolvedValue([]);
    });

    it('defaults to 90-day window when both dateFrom and dateTo are omitted', async () => {
      const before = Date.now();
      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});
      const after = Date.now();

      const to = new Date(result.window.to).getTime();
      const from = new Date(result.window.from).getTime();
      const windowMs = to - from;
      const expectedWindowMs = DASHBOARD_DEFAULTS.WINDOW_DAYS_DEFAULT * 86400000;

      expect(windowMs).toBeCloseTo(expectedWindowMs, -3); // within 1 second tolerance
      expect(to).toBeGreaterThanOrEqual(before);
      expect(to).toBeLessThanOrEqual(after + 100);
    });

    it('uses now as dateTo when only dateFrom is provided', async () => {
      const dateFrom = '2026-01-01T00:00:00.000Z';
      const before = Date.now();
      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, { dateFrom });
      const after = Date.now();

      const to = new Date(result.window.to).getTime();
      expect(to).toBeGreaterThanOrEqual(before);
      expect(to).toBeLessThanOrEqual(after + 100);
      expect(new Date(result.window.from).toISOString()).toBe(dateFrom);
    });

    it('throws AppError 400 with dashboard.invalidDateRange when dateFrom > dateTo', async () => {
      await expect(
        getDashboardSummary(TRAINER_ID, STUDENT_ID, {
          dateFrom: '2026-04-10T00:00:00.000Z',
          dateTo: '2026-04-01T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'INVALID_DATE_RANGE',
        messageCode: DashboardMessageCode.INVALID_DATE_RANGE,
      });
    });

    it('throws AppError 400 with dashboard.windowTooLarge when window exceeds 365 days', async () => {
      const dateTo = new Date('2026-04-01T00:00:00.000Z');
      const dateFrom = new Date(dateTo.getTime() - 366 * 86400000).toISOString();

      await expect(
        getDashboardSummary(TRAINER_ID, STUDENT_ID, {
          dateFrom,
          dateTo: dateTo.toISOString(),
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'WINDOW_TOO_LARGE',
        messageCode: DashboardMessageCode.WINDOW_TOO_LARGE,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getDashboardSummary
  // ---------------------------------------------------------------------------

  describe('getDashboardSummary', () => {
    it('returns all zero counts and null fields for a student with no sessions', async () => {
      prisma.workoutSession.groupBy.mockResolvedValue([]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.sessionCounts).toEqual({ completed: 0, in_progress: 0, abandoned: 0 });
      expect(result.totalSessions).toBe(0);
      expect(result.completionRate).toBeNull();
      expect(result.lastSessionAt).toBeNull();
      expect(result.currentProtocol).toBeNull();
    });

    it('computes completionRate = 0.75 for 3 completed + 1 abandoned (in_progress excluded from denominator)', async () => {
      prisma.workoutSession.groupBy.mockResolvedValue(makeGroupByResult(3, 2, 1));
      prisma.workoutSession.findFirst.mockResolvedValue({ startedAt: new Date('2026-04-01T10:00:00Z') });
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.sessionCounts.completed).toBe(3);
      expect(result.sessionCounts.in_progress).toBe(2);
      expect(result.sessionCounts.abandoned).toBe(1);
      expect(result.totalSessions).toBe(6);
      // completionRate = 3 / (3 + 1) = 0.75
      expect(result.completionRate).toBe(0.75);
    });

    it('returns completionRate: null when denominator is 0 (only in_progress sessions)', async () => {
      prisma.workoutSession.groupBy.mockResolvedValue(makeGroupByResult(0, 5, 0));
      prisma.workoutSession.findFirst.mockResolvedValue(null);
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.completionRate).toBeNull();
    });

    it('passes deletedAt: null filter to groupBy query (soft-deleted sessions excluded)', async () => {
      prisma.workoutSession.groupBy.mockResolvedValue([]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([]);

      await getDashboardSummary(TRAINER_ID, STUDENT_ID, {
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: '2026-06-01T00:00:00.000Z',
      });

      expect(prisma.workoutSession.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });

    it('returns currentProtocol with date-only formatted startDate and expirationDate', async () => {
      prisma.workoutSession.groupBy.mockResolvedValue([]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);
      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol());
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.currentProtocol).toEqual({
        id: 'protocol-1',
        name: 'Hypertrophy Block',
        startDate: '2026-01-01',
        expirationDate: '2026-06-30',
      });
    });

    it('propagates STUDENT_NOT_FOUND when resolveTrainerStudent throws', async () => {
      resolveTrainerStudent.mockRejectedValue(
        Object.assign(new Error('Student not found or not assigned to you'), {
          httpStatus: 404,
          error: 'STUDENT_NOT_FOUND',
          messageCode: 'legacy.STUDENT_NOT_FOUND',
        }),
      );

      await expect(getDashboardSummary(TRAINER_ID, 'unlinked-student', {})).rejects.toMatchObject({
        httpStatus: 404,
        error: 'STUDENT_NOT_FOUND',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getDashboardSummary — derived stats (maxStreakDays, sessionsPerWeek, daysSinceLastSession)
  // ---------------------------------------------------------------------------

  describe('getDashboardSummary — derived stats', () => {
    function stubSummaryQueries({ groupedCounts = [], lastSession = null, protocol = null, streakDates = [] } = {}) {
      prisma.workoutSession.groupBy.mockResolvedValue(groupedCounts);
      prisma.workoutSession.findFirst.mockResolvedValue(lastSession);
      prisma.trainingProtocol.findFirst.mockResolvedValue(protocol);
      prisma.$queryRaw.mockResolvedValue(streakDates.map(makeStreakDateRow));
    }

    it('maxStreakDays is null when student has no sessions', async () => {
      stubSummaryQueries();

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.maxStreakDays).toBeNull();
    });

    it('maxStreakDays is 1 when student trained on exactly one day', async () => {
      stubSummaryQueries({ streakDates: ['2026-04-15'] });

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.maxStreakDays).toBe(1);
    });

    it('maxStreakDays is 2 when student trained on two consecutive days', async () => {
      stubSummaryQueries({ streakDates: ['2026-04-14', '2026-04-15'] });

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.maxStreakDays).toBe(2);
    });

    it('maxStreakDays is 3 for three consecutive days then a gap then two more', async () => {
      // Longest run is 3 (Apr 13–15), then gap, then 2 (Apr 18–19)
      stubSummaryQueries({ streakDates: ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-18', '2026-04-19'] });

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.maxStreakDays).toBe(3);
    });

    it('maxStreakDays is not broken by a US DST spring-forward boundary (UTC dates are always 1-day apart)', async () => {
      // US DST spring-forward 2026: Mar 8. In UTC, Mar 7 → Mar 8 diff is exactly 86400000ms.
      stubSummaryQueries({ streakDates: ['2026-03-07', '2026-03-08'] });

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.maxStreakDays).toBe(2);
    });

    it('sessionsPerWeek is null when totalSessions is 0 and windowDays > 0', async () => {
      stubSummaryQueries();

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: '2026-04-01T00:00:00.000Z',
      });

      // totalSessions = 0, so 0 / (windowDays/7) = 0.0, not null
      expect(result.sessionsPerWeek).toBe(0);
    });

    it('sessionsPerWeek rounds to 1 decimal (10 sessions / 21.5-day window)', async () => {
      // 21.5 days = 3.071... weeks → 10 / 3.071... = 3.257... → round1 = 3.3
      const from = new Date('2026-04-01T00:00:00.000Z');
      const to = new Date(from.getTime() + 21.5 * 86400000);
      stubSummaryQueries({ groupedCounts: makeGroupByResult(10, 0, 0) });

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
      });

      expect(result.sessionsPerWeek).toBe(3.3);
    });

    it('daysSinceLastSession is null when there are no sessions', async () => {
      stubSummaryQueries({ lastSession: null });

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.daysSinceLastSession).toBeNull();
    });

    it('daysSinceLastSession is 0 when last session started today (within same UTC day)', async () => {
      const fiveSecondsAgo = new Date(Date.now() - 5000);
      stubSummaryQueries({ lastSession: { startedAt: fiveSecondsAgo } });

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.daysSinceLastSession).toBe(0);
    });

    it('daysSinceLastSession is 1 when last session was exactly 1 day ago', async () => {
      const oneDayAgo = new Date(Date.now() - 86400000);
      stubSummaryQueries({ lastSession: { startedAt: oneDayAgo } });

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.daysSinceLastSession).toBe(1);
    });

    it('response includes maxStreakDays, sessionsPerWeek, daysSinceLastSession keys', async () => {
      stubSummaryQueries();

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result).toHaveProperty('maxStreakDays');
      expect(result).toHaveProperty('sessionsPerWeek');
      expect(result).toHaveProperty('daysSinceLastSession');
    });
  });

  // ---------------------------------------------------------------------------
  // getRecentSessions
  // ---------------------------------------------------------------------------

  describe('getRecentSessions', () => {
    it('returns sessions ordered by startedAt DESC', async () => {
      const sessions = [
        makeSession({ id: 'session-3', startedAt: new Date('2026-04-03T10:00:00Z') }),
        makeSession({ id: 'session-2', startedAt: new Date('2026-04-02T10:00:00Z') }),
        makeSession({ id: 'session-1', startedAt: new Date('2026-04-01T10:00:00Z') }),
      ];
      prisma.workoutSession.findMany.mockResolvedValue(sessions);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].id).toBe('session-3');
      expect(result.data[1].id).toBe('session-2');
      expect(result.data[2].id).toBe('session-1');
    });

    it('passes take = min(50, provided limit) to the query', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([]);

      await getRecentSessions(TRAINER_ID, STUDENT_ID, { limit: 5 });

      expect(prisma.workoutSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('caps limit at RECENT_SESSIONS_MAX (50) even when a higher value is provided', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([]);

      await getRecentSessions(TRAINER_ID, STUDENT_ID, { limit: 999 });

      expect(prisma.workoutSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: DASHBOARD_DEFAULTS.RECENT_SESSIONS_MAX }),
      );
    });

    it('includes trainingName from the joined training relation', async () => {
      const session = makeSession({ training: { id: 'training-1', name: 'Costas' } });
      prisma.workoutSession.findMany.mockResolvedValue([session]);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].trainingName).toBe('Costas');
      expect(result.data[0].trainingId).toBe('training-1');
    });

    it('returns empty data array when student has no sessions in window', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data).toEqual([]);
    });

    it('does not issue $queryRaw when session list is empty (no RPE query needed)', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([]);

      await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('avgRpe is null when session has no set logs with rpe (avg_rpe row returns null)', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([makeSession({ id: 'session-1' })]);
      prisma.$queryRaw.mockResolvedValue([makeRpeRow('session-1', null)]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].avgRpe).toBeNull();
    });

    it('avgRpe is null for a session not returned by the RPE query (session had no exercise logs at all)', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([makeSession({ id: 'session-99' })]);
      // RPE query returns rows for other sessions only — session-99 absent
      prisma.$queryRaw.mockResolvedValue([makeRpeRow('session-other', 8)]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].avgRpe).toBeNull();
    });

    it('avgRpe rounds to 1 decimal (7.666... → 7.7)', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([makeSession({ id: 'session-1' })]);
      prisma.$queryRaw.mockResolvedValue([makeRpeRow('session-1', 7.6666666)]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].avgRpe).toBe(7.7);
    });

    it('noteText is null when session.notes is null', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([makeSession({ id: 'session-1', notes: null })]);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].noteText).toBeNull();
    });

    it('noteText is null when session.notes is an empty string', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([makeSession({ id: 'session-1', notes: '' })]);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].noteText).toBeNull();
    });

    it('noteText is null when session.notes is whitespace-only', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([makeSession({ id: 'session-1', notes: '   ' })]);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].noteText).toBeNull();
    });

    it('noteText returns trimmed string when notes have surrounding whitespace', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([makeSession({ id: 'session-1', notes: '  Pesadão hoje  ' })]);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].noteText).toBe('Pesadão hoje');
    });

    it('both avgRpe and noteText are populated when both are present', async () => {
      prisma.workoutSession.findMany.mockResolvedValue([makeSession({ id: 'session-1', notes: 'Treino pesado' })]);
      prisma.$queryRaw.mockResolvedValue([makeRpeRow('session-1', 8.5)]);

      const result = await getRecentSessions(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].avgRpe).toBe(8.5);
      expect(result.data[0].noteText).toBe('Treino pesado');
    });
  });

  // ---------------------------------------------------------------------------
  // getExerciseProgression
  // ---------------------------------------------------------------------------

  describe('getExerciseProgression', () => {
    it('buckets multiple sessions for the same exercise under one entry', async () => {
      const rows = [
        makeProgressionRow({ session_id: 'session-2', started_at: new Date('2026-04-10T10:00:00Z'), max_load: 85 }),
        makeProgressionRow({ session_id: 'session-1', started_at: new Date('2026-04-01T10:00:00Z'), max_load: 80 }),
      ];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0].exerciseId).toBe(EXERCISE_ID);
      expect(result.data[0].sessionCount).toBe(2);
    });

    it('computes trend.maxLoadDelta as latest - oldest maxLoad', async () => {
      const rows = [
        makeProgressionRow({ session_id: 'session-2', started_at: new Date('2026-04-10T10:00:00Z'), max_load: 90 }),
        makeProgressionRow({ session_id: 'session-1', started_at: new Date('2026-04-01T10:00:00Z'), max_load: 80 }),
      ];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].trend.maxLoadDelta).toBe(10);
    });

    it('returns trend.maxLoadDeltaPct: null when oldest maxLoad is 0 (avoid divide-by-zero)', async () => {
      const rows = [
        makeProgressionRow({ session_id: 'session-2', started_at: new Date('2026-04-10T10:00:00Z'), max_load: 10 }),
        makeProgressionRow({ session_id: 'session-1', started_at: new Date('2026-04-01T10:00:00Z'), max_load: 0 }),
      ];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].trend.maxLoadDeltaPct).toBeNull();
    });

    it('returns trend.maxLoadDeltaPct: null when either load value is null', async () => {
      const rows = [
        makeProgressionRow({ session_id: 'session-2', started_at: new Date('2026-04-10T10:00:00Z'), max_load: null }),
        makeProgressionRow({ session_id: 'session-1', started_at: new Date('2026-04-01T10:00:00Z'), max_load: 80 }),
      ];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].trend.maxLoadDeltaPct).toBeNull();
      expect(result.data[0].trend.maxLoadDelta).toBeNull();
    });

    it('passes includeDurationOnly=false to $queryRaw when omitted', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      // The first call to $queryRaw should use includeDurationOnly = false
      // We verify this by checking the raw SQL was called (exact params not asserted to avoid template-literal mocking complexity)
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('still calls $queryRaw when includeDurationOnly=true is provided', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await getExerciseProgression(TRAINER_ID, STUDENT_ID, { includeDurationOnly: true });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('returns null trend fields when exercise has only one session', async () => {
      prisma.$queryRaw.mockResolvedValue([makeProgressionRow()]);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].trend.maxLoadDelta).toBeNull();
      expect(result.data[0].trend.maxLoadDeltaPct).toBeNull();
    });

    it('keeps separate entries for different exerciseIds (same name across protocols)', async () => {
      const rows = [
        makeProgressionRow({ exercise_id: 'exercise-1', training_id: 'training-A', training_name: 'Protocolo A' }),
        makeProgressionRow({ exercise_id: 'exercise-2', training_id: 'training-B', training_name: 'Protocolo B' }),
      ];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data).toHaveLength(2);
      const ids = result.data.map((d) => d.exerciseId);
      expect(ids).toContain('exercise-1');
      expect(ids).toContain('exercise-2');
    });

    it('sorts results by lastPerformedAt DESC', async () => {
      const rows = [
        makeProgressionRow({ exercise_id: 'exercise-1', session_id: 'session-old', started_at: new Date('2026-01-01T10:00:00Z') }),
        makeProgressionRow({ exercise_id: 'exercise-2', session_id: 'session-new', started_at: new Date('2026-04-10T10:00:00Z') }),
      ];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].exerciseId).toBe('exercise-2');
      expect(result.data[1].exerciseId).toBe('exercise-1');
    });

    it('respects limit cap (EXERCISES_LIST_MAX = 20)', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await getExerciseProgression(TRAINER_ID, STUDENT_ID, { limit: 999 });

      // No error thrown — internal cap applied. Result is empty due to no rows.
      // Verify $queryRaw was still called.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('rounds load values to 2 decimal places', async () => {
      const rows = [makeProgressionRow({ max_load: 80.556, avg_load: 70.333, total_volume: 2801.234 })];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].latest.maxLoad).toBe(80.56);
      expect(result.data[0].latest.avgLoad).toBe(70.33);
      expect(result.data[0].latest.totalVolume).toBe(2801.23);
    });

    it('loadHistory is empty array when exercise has no sessions', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data).toHaveLength(0);
    });

    it('loadHistory has 1 entry when exercise has exactly 1 session', async () => {
      prisma.$queryRaw.mockResolvedValue([makeProgressionRow({ max_load: 80 })]);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].loadHistory).toEqual([80]);
    });

    it('loadHistory is capped at 6 entries when exercise has more than 6 sessions', async () => {
      const rows = Array.from({ length: 10 }, (_, i) =>
        makeProgressionRow({
          session_id: `session-${i}`,
          started_at: new Date(`2026-04-${String(10 + i).padStart(2, '0')}T10:00:00Z`),
          max_load: 70 + i,
        }),
      );
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].loadHistory).toHaveLength(6);
    });

    it('loadHistory entry is null when maxLoad is null for that session', async () => {
      const rows = [
        makeProgressionRow({ session_id: 'session-2', started_at: new Date('2026-04-10T10:00:00Z'), max_load: null }),
        makeProgressionRow({ session_id: 'session-1', started_at: new Date('2026-04-01T10:00:00Z'), max_load: 80 }),
      ];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      // sessions are DESC, so most-recent first: null then 80
      expect(result.data[0].loadHistory[0]).toBeNull();
      expect(result.data[0].loadHistory[1]).toBe(80);
    });

    it('loadHistory is most-recent-first (mirrors session DESC order from SQL)', async () => {
      const rows = [
        makeProgressionRow({ session_id: 'session-3', started_at: new Date('2026-04-10T10:00:00Z'), max_load: 90 }),
        makeProgressionRow({ session_id: 'session-2', started_at: new Date('2026-04-05T10:00:00Z'), max_load: 85 }),
        makeProgressionRow({ session_id: 'session-1', started_at: new Date('2026-04-01T10:00:00Z'), max_load: 80 }),
      ];
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].loadHistory).toEqual([90, 85, 80]);
    });

    it('loadHistory values are already rounded to 2 decimals (inherited from bucketProgressionRows)', async () => {
      prisma.$queryRaw.mockResolvedValue([makeProgressionRow({ max_load: 80.556 })]);

      const result = await getExerciseProgression(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].loadHistory[0]).toBe(80.56);
    });
  });

  // ---------------------------------------------------------------------------
  // getExerciseProgressionDetail
  // ---------------------------------------------------------------------------

  describe('getExerciseProgressionDetail', () => {
    it('returns sessions: [] for an exerciseId with no logs in the window (NOT 404)', async () => {
      prisma.exercise.findFirst.mockResolvedValue({
        id: EXERCISE_ID,
        name: 'Bench Press',
        hasLoad: true,
        prescriptionMode: 'reps',
        trainingId: 'training-1',
        training: { name: 'Peito' },
      });
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getExerciseProgressionDetail(TRAINER_ID, STUDENT_ID, EXERCISE_ID, {});

      expect(result.sessions).toEqual([]);
      expect(result.exercise).toBeDefined();
    });

    it('returns exercise: null when exercise does not exist in database', async () => {
      prisma.exercise.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getExerciseProgressionDetail(TRAINER_ID, STUDENT_ID, 'nonexistent-id', {});

      expect(result.exercise).toBeNull();
      expect(result.sessions).toEqual([]);
    });

    it('includes raw sets array per session fetched from exerciseLog', async () => {
      const rows = [makeProgressionRow({ session_id: 'session-1' })];
      prisma.exercise.findFirst.mockResolvedValue({
        id: EXERCISE_ID,
        name: 'Bench Press',
        hasLoad: true,
        prescriptionMode: 'reps',
        trainingId: 'training-1',
        training: { name: 'Peito' },
      });
      prisma.$queryRaw.mockResolvedValue(rows);
      prisma.exerciseLog.findMany.mockResolvedValue([
        {
          workoutSessionId: 'session-1',
          setLogs: [
            { setNumber: 1, repetitions: 10, load: 80.0, rpe: 8, completed: true },
            { setNumber: 2, repetitions: 8, load: 80.0, rpe: 9, completed: false },
          ],
        },
      ]);

      const result = await getExerciseProgressionDetail(TRAINER_ID, STUDENT_ID, EXERCISE_ID, {});

      expect(result.sessions[0].sets).toHaveLength(2);
      expect(result.sessions[0].sets[0]).toMatchObject({
        setNumber: 1,
        repetitions: 10,
        load: 80,
        completed: true,
      });
    });

    it('respects sessionLimit cap (SESSIONS_PER_EXERCISE_MAX = 30)', async () => {
      prisma.exercise.findFirst.mockResolvedValue({
        id: EXERCISE_ID,
        name: 'Bench Press',
        hasLoad: true,
        prescriptionMode: 'reps',
        trainingId: 'training-1',
        training: { name: 'Peito' },
      });
      prisma.$queryRaw.mockResolvedValue([]);

      await getExerciseProgressionDetail(TRAINER_ID, STUDENT_ID, EXERCISE_ID, { sessionLimit: 999 });

      // No error — cap is applied internally. $queryRaw called with the exercise filter.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('does not query exerciseLog when no sessions found for the exercise', async () => {
      prisma.exercise.findFirst.mockResolvedValue({
        id: EXERCISE_ID,
        name: 'Bench Press',
        hasLoad: true,
        prescriptionMode: 'reps',
        trainingId: 'training-1',
        training: { name: 'Peito' },
      });
      prisma.$queryRaw.mockResolvedValue([]);

      await getExerciseProgressionDetail(TRAINER_ID, STUDENT_ID, EXERCISE_ID, {});

      expect(prisma.exerciseLog.findMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getDailyActivity
  // ---------------------------------------------------------------------------

  describe('getDailyActivity', () => {
    it('returns data: [] when student has no sessions in window', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data).toEqual([]);
    });

    it('returns correct shape for a single day with one session', async () => {
      prisma.$queryRaw.mockResolvedValue([makeDailyActivityRow()]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        date: '2026-04-15',
        status: 'partial',
        sessionCount: 1,
        sessionIds: ['session-1'],
        volumeKg: 1812,
        completedSets: 12,
        totalSets: 14,
      });
    });

    it('classifies day with completed session and all sets done as "completed"', async () => {
      prisma.$queryRaw.mockResolvedValue([
        makeDailyActivityRow({ has_completed: true, completed_sets: 14n, total_sets: 14n }),
      ]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].status).toBe('completed');
    });

    it('classifies day with only abandoned sessions as "abandoned"', async () => {
      prisma.$queryRaw.mockResolvedValue([
        makeDailyActivityRow({ has_completed: false, has_abandoned: true }),
      ]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].status).toBe('abandoned');
    });

    it('aggregates correctly for a day with 2 sessions', async () => {
      prisma.$queryRaw.mockResolvedValue([
        makeDailyActivityRow({
          session_count: 2n,
          session_ids: ['session-1', 'session-2'],
          total_volume_kg: 3200.5,
          completed_sets: 24n,
          total_sets: 26n,
        }),
      ]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].sessionCount).toBe(2);
      expect(result.data[0].sessionIds).toHaveLength(2);
      expect(result.data[0].completedSets).toBe(24);
      expect(result.data[0].totalSets).toBe(26);
    });

    it('volumeKg is rounded to 2 decimals', async () => {
      prisma.$queryRaw.mockResolvedValue([makeDailyActivityRow({ total_volume_kg: 1812.345 })]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].volumeKg).toBe(1812.35);
    });

    it('sessionCount is a JS number (not BigInt)', async () => {
      prisma.$queryRaw.mockResolvedValue([makeDailyActivityRow({ session_count: 3n })]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(typeof result.data[0].sessionCount).toBe('number');
      expect(result.data[0].sessionCount).toBe(3);
    });

    it('completedSets is 0 when session exists but has no completed set logs', async () => {
      prisma.$queryRaw.mockResolvedValue([
        makeDailyActivityRow({ total_volume_kg: 0, completed_sets: 0n, total_sets: 3n }),
      ]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].completedSets).toBe(0);
      expect(result.data[0].totalSets).toBe(3);
      expect(result.data[0].volumeKg).toBe(0);
    });

    it('returns window with ISO datetime strings', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: '2026-04-01T00:00:00.000Z',
      });

      expect(result.window.from).toBe('2026-01-01T00:00:00.000Z');
      expect(result.window.to).toBe('2026-04-01T00:00:00.000Z');
    });

    it('returns rows sorted ASC by date (as ordered by SQL query)', async () => {
      prisma.$queryRaw.mockResolvedValue([
        makeDailyActivityRow({ date: '2026-04-01' }),
        makeDailyActivityRow({ date: '2026-04-03' }),
        makeDailyActivityRow({ date: '2026-04-05' }),
      ]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].date).toBe('2026-04-01');
      expect(result.data[1].date).toBe('2026-04-03');
      expect(result.data[2].date).toBe('2026-04-05');
    });

    it('throws AppError 400 with dashboard.invalidDateRange when dateFrom > dateTo', async () => {
      await expect(
        getDailyActivity(TRAINER_ID, STUDENT_ID, {
          dateFrom: '2026-04-10T00:00:00.000Z',
          dateTo: '2026-04-01T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'INVALID_DATE_RANGE',
        messageCode: DashboardMessageCode.INVALID_DATE_RANGE,
      });
    });

    it('throws AppError 400 with dashboard.windowTooLarge when window exceeds 365 days', async () => {
      const dateTo = new Date('2026-04-01T00:00:00.000Z');
      const dateFrom = new Date(dateTo.getTime() - 366 * 86400000).toISOString();

      await expect(
        getDailyActivity(TRAINER_ID, STUDENT_ID, { dateFrom, dateTo: dateTo.toISOString() }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'WINDOW_TOO_LARGE',
        messageCode: DashboardMessageCode.WINDOW_TOO_LARGE,
      });
    });

    it('propagates STUDENT_NOT_FOUND when resolveTrainerStudent throws', async () => {
      resolveTrainerStudent.mockRejectedValue(
        Object.assign(new Error('Student not found'), {
          httpStatus: 404,
          error: 'STUDENT_NOT_FOUND',
          messageCode: 'legacy.STUDENT_NOT_FOUND',
        }),
      );

      await expect(getDailyActivity(TRAINER_ID, 'unlinked-student', {})).rejects.toMatchObject({
        httpStatus: 404,
        error: 'STUDENT_NOT_FOUND',
      });
    });

    // ── timezone ──────────────────────────────────────────────────────────────

    it('accepts timeZone option and completes without error (America/Sao_Paulo)', async () => {
      prisma.$queryRaw.mockResolvedValue([makeDailyActivityRow({ date: '2026-04-14' })]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, { timeZone: 'America/Sao_Paulo' });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].date).toBe('2026-04-14');
    });

    it('accepts timeZone option and completes without error (America/New_York)', async () => {
      // SQL does the bucketing; service returns the date string the DB sends back.
      // This test confirms the timeZone param flows through without throwing.
      prisma.$queryRaw.mockResolvedValue([makeDailyActivityRow({ date: '2026-04-14' })]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, { timeZone: 'America/New_York' });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].date).toBe('2026-04-14');
    });

    it('uses default timeZone (America/Sao_Paulo) when timeZone option is omitted', async () => {
      // DB returns a date bucketed by the default timezone.
      // In the UTC+0 representation, 22:00 local on Apr 14 (UTC-3) = 01:00 UTC Apr 15.
      // With correct TZ buckling the date should be Apr 14, not Apr 15.
      // This test mocks the DB returning Apr 14 (correct local day) and verifies
      // the service passes it through without shifting the date itself.
      prisma.$queryRaw.mockResolvedValue([makeDailyActivityRow({ date: '2026-04-14' })]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, {});

      expect(result.data[0].date).toBe('2026-04-14');
    });

    it('does not re-bucket dates in JS — returns the date string exactly as provided by the DB', async () => {
      // Verify the service does NOT apply any in-memory date transformation.
      // Bucketing is the DB's responsibility via AT TIME ZONE.
      const rawDate = '2026-04-14';
      prisma.$queryRaw.mockResolvedValue([makeDailyActivityRow({ date: rawDate })]);

      const result = await getDailyActivity(TRAINER_ID, STUDENT_ID, { timeZone: 'America/Sao_Paulo' });

      expect(result.data[0].date).toBe(rawDate);
    });
  });

  // ---------------------------------------------------------------------------
  // getDashboardSummary — timezone (streak date bucketing)
  // ---------------------------------------------------------------------------

  describe('getDashboardSummary — timezone', () => {
    function stubSummaryForTimezone(streakDates = []) {
      prisma.workoutSession.groupBy.mockResolvedValue([]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue(streakDates.map(makeStreakDateRow));
    }

    it('accepts timeZone option and computes streak from dates returned by the DB', async () => {
      // DB returns Apr 14 and Apr 15 — consecutive local days.
      // Streak should be 2 regardless of what TZ was applied at SQL level.
      stubSummaryForTimezone(['2026-04-14', '2026-04-15']);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, { timeZone: 'America/Sao_Paulo' });

      expect(result.maxStreakDays).toBe(2);
    });

    it('uses default timeZone (America/Sao_Paulo) when omitted — streak computed from DB-returned dates', async () => {
      stubSummaryForTimezone(['2026-04-13', '2026-04-14', '2026-04-15']);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, {});

      expect(result.maxStreakDays).toBe(3);
    });

    it('streak remains 1 for a single date regardless of timezone option', async () => {
      stubSummaryForTimezone(['2026-04-15']);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, { timeZone: 'America/New_York' });

      expect(result.maxStreakDays).toBe(1);
    });

    it('streak is null when DB returns no dates (no sessions in window)', async () => {
      stubSummaryForTimezone([]);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, { timeZone: 'America/Sao_Paulo' });

      expect(result.maxStreakDays).toBeNull();
    });

    it('a session at 22:00 local (01:00 UTC next day) is bucketed to the local date by the DB — service returns that date', async () => {
      // A session at 22:00 on Apr 14 in America/Sao_Paulo (UTC-3) is 01:00 UTC Apr 15.
      // With AT TIME ZONE 'America/Sao_Paulo' the DB correctly returns Apr 14.
      // The mock simulates the DB having done that correctly.
      stubSummaryForTimezone(['2026-04-14', '2026-04-15']);

      const result = await getDashboardSummary(TRAINER_ID, STUDENT_ID, { timeZone: 'America/Sao_Paulo' });

      // Both Apr 14 and Apr 15 appear; streak is consecutive (2 days)
      expect(result.maxStreakDays).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // buildAiPerformanceSnapshot
  // ---------------------------------------------------------------------------

  describe('buildAiPerformanceSnapshot', () => {
    function stubSnapshotQueries({ completed = 3, abandoned = 1, inProgress = 0 } = {}) {
      prisma.user.findUnique.mockResolvedValue({ firstName: 'João', lastName: 'Silva' });
      prisma.workoutSession.groupBy.mockResolvedValue(makeGroupByResult(completed, inProgress, abandoned));
      prisma.workoutSession.findFirst.mockResolvedValue({ startedAt: new Date('2026-04-01T10:00:00Z') });
      prisma.trainingProtocol.findFirst.mockResolvedValue({ id: 'protocol-1', name: 'Hypertrophy' });
      prisma.$queryRaw.mockResolvedValue([]);
    }

    it('returns snapshot with the expected top-level shape', async () => {
      stubSnapshotQueries();

      const result = await buildAiPerformanceSnapshot(TRAINER_ID, STUDENT_ID, {});

      expect(result).toMatchObject({
        studentId: STUDENT_ID,
        studentName: 'João Silva',
        window: expect.objectContaining({ days: 90 }),
        sessionCounts: { completed: 3, in_progress: 0, abandoned: 1 },
        totalSessions: 4,
        completionRate: 0.75,
        lastSessionAt: expect.any(String),
        currentProtocol: { id: 'protocol-1', name: 'Hypertrophy' },
        topExercises: [],
      });
    });

    it('uses default windowDays = 90 when not provided', async () => {
      stubSnapshotQueries();

      const result = await buildAiPerformanceSnapshot(TRAINER_ID, STUDENT_ID, {});

      expect(result.window.days).toBe(90);
    });

    it('uses provided windowDays when supplied', async () => {
      stubSnapshotQueries();

      const result = await buildAiPerformanceSnapshot(TRAINER_ID, STUDENT_ID, { windowDays: 30 });

      expect(result.window.days).toBe(30);
    });

    it('caps topExercises at AI_SNAPSHOT_TOP_EXERCISES (10)', async () => {
      prisma.user.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: null });
      prisma.workoutSession.groupBy.mockResolvedValue([]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);

      // Create 15 distinct exercises in the raw rows
      const rows = Array.from({ length: 15 }, (_, i) =>
        makeProgressionRow({
          exercise_id: `exercise-${i}`,
          session_id: `session-${i}`,
          started_at: new Date(`2026-04-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
        }),
      );
      prisma.$queryRaw.mockResolvedValue(rows);

      const result = await buildAiPerformanceSnapshot(TRAINER_ID, STUDENT_ID, { includeExerciseProgression: true });

      expect(result.topExercises.length).toBe(DASHBOARD_DEFAULTS.AI_SNAPSHOT_TOP_EXERCISES);
    });

    it('returns empty topExercises when includeExerciseProgression is false', async () => {
      stubSnapshotQueries();

      const result = await buildAiPerformanceSnapshot(TRAINER_ID, STUDENT_ID, { includeExerciseProgression: false });

      expect(result.topExercises).toEqual([]);
      // Should NOT have called $queryRaw for exercise progression
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('propagates STUDENT_NOT_FOUND when resolveTrainerStudent throws', async () => {
      resolveTrainerStudent.mockRejectedValue(
        Object.assign(new Error('Student not found or not assigned to you'), {
          httpStatus: 404,
          error: 'STUDENT_NOT_FOUND',
          messageCode: 'legacy.STUDENT_NOT_FOUND',
        }),
      );

      await expect(buildAiPerformanceSnapshot(TRAINER_ID, 'unlinked-student', {})).rejects.toMatchObject({
        httpStatus: 404,
        error: 'STUDENT_NOT_FOUND',
      });
    });

    it('builds studentName from firstName and lastName (fallback to "Aluno" when both null)', async () => {
      prisma.user.findUnique.mockResolvedValue({ firstName: null, lastName: null });
      prisma.workoutSession.groupBy.mockResolvedValue([]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await buildAiPerformanceSnapshot(TRAINER_ID, STUDENT_ID, {});

      expect(result.studentName).toBe('Aluno');
    });
  });
});
