import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainingProtocol: { findFirst: vi.fn() },
    workoutSession: { findFirst: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import { getTodayWorkout } from '../../src/services/workouts-today-service.js';
import { WorkoutsTodayMessageCode } from '../../src/constants/training.js';

// ─── Factories ───────────────────────────────────────────────────────────────

const makeTraining = (overrides = {}, index = 0) => ({
  id: `tr-${index}`,
  trainingProtocolId: 'proto-1',
  name: 'Training A',
  category: 'strength',
  bodySegment: null,
  weekDay: null,
  order: 0,
  notes: null,
  deletedAt: null,
  exercises: [],
  ...overrides,
});

const makeProtocol = (trainings = [], overrides = {}) => ({
  id: 'proto-1',
  name: 'Test Protocol',
  startDate: new Date('2025-01-01'),
  expirationDate: null,
  trainings,
  ...overrides,
});

const makeSession = (overrides = {}) => ({
  id: 'sess-1',
  trainingId: 'tr-1',
  startedAt: new Date('2025-04-01T10:00:00Z'),
  status: 'in_progress',
  ...overrides,
});

const defaultOptions = { timeZone: 'America/Sao_Paulo' };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('workouts-today-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no pending in_progress session
    prisma.workoutSession.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── weekDay mode ─────────────────────────────────────────────────────────

  describe('weekDay mode', () => {
    it('returns matching training when today weekday matches', async () => {
      // Stub "today" to a known Wednesday in UTC (also Wednesday in São Paulo UTC-3)
      // 2025-04-16 is a Wednesday
      vi.setSystemTime(new Date('2025-04-16T12:00:00Z'));

      const wednesdayTraining = makeTraining({ id: 'tr-wed', weekDay: 'wednesday', order: 0 }, 0);
      const fridayTraining = makeTraining({ id: 'tr-fri', weekDay: 'friday', order: 1 }, 1);

      prisma.trainingProtocol.findFirst.mockResolvedValue(
        makeProtocol([wednesdayTraining, fridayTraining]),
      );

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.targetTraining.id).toBe('tr-wed');
      expect(result.isRestDay).toBe(false);
      expect(result.nextScheduledDate).toBeNull();
    });

    it('returns rest day with nextScheduledDate when today does not match any training', async () => {
      // 2025-04-16 is a Wednesday
      vi.setSystemTime(new Date('2025-04-16T12:00:00Z'));

      // Only monday and friday trainings — Wednesday is a rest day
      const mondayTraining = makeTraining({ id: 'tr-mon', weekDay: 'monday', order: 0 }, 0);
      const fridayTraining = makeTraining({ id: 'tr-fri', weekDay: 'friday', order: 1 }, 1);

      prisma.trainingProtocol.findFirst.mockResolvedValue(
        makeProtocol([mondayTraining, fridayTraining]),
      );

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.isRestDay).toBe(true);
      expect(result.targetTraining).toBeNull();
      // Next friday is 2025-04-18 (2 days away)
      expect(result.nextScheduledDate).toBe('2025-04-18');
    });

    it('returns nextScheduledDate: null when no match found in next 7 days', async () => {
      // Protocol with a single training on wednesday; today is also wednesday
      // but we want to test the 7-day scan returning null
      // Use a date (e.g. thursday 2025-04-17) and a protocol with ONLY thursday training
      // but the thursday training → today matches → not rest day
      // To get null nextScheduledDate we need: today doesn't match AND none of +1..+7 match
      // Setup: today = thursday, protocol only has a training on 'thursday'
      // but that means today DOES match → not rest day.
      // Instead: today = thursday, no trainings at all for +0..+7 (impossible with 7 days)
      // Actually with 7 days covering a full week, it's impossible to miss unless
      // the only weekday is the same as today (which would be caught as a match).
      // Correct scenario: today = thursday, protocol only has 'thursday' training → today matches.
      // For null nextScheduledDate: protocol has no trainings at all → emptyProtocol error.
      // The correct test: training weekDay = 'thursday', today = wednesday.
      // The +1 day is thursday → match found! nextScheduledDate is tomorrow.
      // For 7-day null scan: all 7 days ahead DO NOT have a match.
      // This requires a protocol with a weekDay that NEVER appears in +1..+7.
      // That's impossible in a 7-day window (all 7 days of the week are covered).
      // So nextScheduledDate can only be null if there are zero trainings (handled elsewhere)
      // OR if all trainings' weekDay values don't appear in the next 7 days.
      // But +1..+7 covers all 7 weekdays. The ONLY way is if trainings[].weekDay is NOT a real weekday.
      // Per plan: "no match in 7 days → nextScheduledDate: null". This is theoretically unreachable
      // in a correct dataset, but the service handles it gracefully.
      // We simulate it by using an invalid weekDay value so it never matches:
      vi.setSystemTime(new Date('2025-04-16T12:00:00Z')); // Wednesday

      const strangeTraining = makeTraining({ id: 'tr-x', weekDay: 'holiday', order: 0 }, 0);

      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([strangeTraining]));

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.isRestDay).toBe(true);
      expect(result.nextScheduledDate).toBeNull();
    });

    it('uses weekDay mode when only one of multiple trainings has a weekDay set', async () => {
      // 2025-04-14 is a Monday
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z'));

      const mondayTraining = makeTraining({ id: 'tr-mon', weekDay: 'monday', order: 0 }, 0);
      const orderOnlyTraining = makeTraining({ id: 'tr-order', weekDay: null, order: 1 }, 1);

      prisma.trainingProtocol.findFirst.mockResolvedValue(
        makeProtocol([mondayTraining, orderOnlyTraining]),
      );

      const result = await getTodayWorkout('user-1', defaultOptions);

      // weekDay mode because mondayTraining has weekDay != null
      expect(result.targetTraining.id).toBe('tr-mon');
      expect(result.isRestDay).toBe(false);
    });
  });

  // ── order mode ────────────────────────────────────────────────────────────

  describe('order mode', () => {
    it('returns first training when there are no completed sessions', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);
      const t1 = makeTraining({ id: 'tr-1', weekDay: null, order: 1 }, 1);
      const t2 = makeTraining({ id: 'tr-2', weekDay: null, order: 2 }, 2);

      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([t0, t1, t2]));
      // Both pending and completed findFirst calls return null
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null) // pending in_progress
        .mockResolvedValueOnce(null); // last completed

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.targetTraining.id).toBe('tr-0');
      expect(result.isRestDay).toBe(false);
      expect(result.nextScheduledDate).toBeNull();
    });

    it('returns next training after last completed session', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);
      const t1 = makeTraining({ id: 'tr-1', weekDay: null, order: 1 }, 1);
      const t2 = makeTraining({ id: 'tr-2', weekDay: null, order: 2 }, 2);

      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([t0, t1, t2]));
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null) // pending in_progress
        .mockResolvedValueOnce({ training: { order: 0 } }); // last completed = order 0

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.targetTraining.id).toBe('tr-1');
    });

    it('cycles back to first training when last completed was the max order', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);
      const t1 = makeTraining({ id: 'tr-1', weekDay: null, order: 1 }, 1);
      const t2 = makeTraining({ id: 'tr-2', weekDay: null, order: 2 }, 2);

      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([t0, t1, t2]));
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null) // pending in_progress
        .mockResolvedValueOnce({ training: { order: 2 } }); // last completed = max order

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.targetTraining.id).toBe('tr-0');
    });

    it('always has isRestDay: false and nextScheduledDate: null in order mode', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);

      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([t0]));
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.isRestDay).toBe(false);
      expect(result.nextScheduledDate).toBeNull();
    });
  });

  // ── Error cases ───────────────────────────────────────────────────────────

  describe('error cases', () => {
    it('throws workoutsToday.noActiveProtocol (404) when no active protocol exists', async () => {
      prisma.trainingProtocol.findFirst.mockResolvedValue(null);

      await expect(getTodayWorkout('user-1', defaultOptions)).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: WorkoutsTodayMessageCode.NO_ACTIVE_PROTOCOL,
        error: 'NO_ACTIVE_PROTOCOL',
      });
    });

    it('throws workoutsToday.emptyProtocol (404) when protocol has no trainings', async () => {
      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([]));

      await expect(getTodayWorkout('user-1', defaultOptions)).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: WorkoutsTodayMessageCode.EMPTY_PROTOCOL,
        error: 'EMPTY_PROTOCOL',
      });
    });
  });

  // ── pendingTraining ───────────────────────────────────────────────────────

  describe('pendingTraining', () => {
    it('populates pendingTraining from a cross-protocol in_progress session', async () => {
      // 2025-04-14 Monday
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z'));

      const t0 = makeTraining({ id: 'tr-0', weekDay: 'monday', order: 0 }, 0);
      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([t0]));

      const crossProtocolSession = makeSession({
        id: 'sess-cross',
        trainingId: 'tr-other-protocol',
        status: 'in_progress',
        startedAt: new Date('2025-04-14T08:00:00Z'),
      });
      prisma.workoutSession.findFirst.mockResolvedValue(crossProtocolSession);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.pendingTraining).not.toBeNull();
      expect(result.pendingTraining.sessionId).toBe('sess-cross');
      expect(result.pendingTraining.trainingId).toBe('tr-other-protocol');
      expect(result.pendingTraining.status).toBe('in_progress');
      expect(result.pendingTraining.startedAt).toBeDefined();
    });

    it('returns pendingTraining: null when no in_progress session exists', async () => {
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z'));

      const t0 = makeTraining({ id: 'tr-0', weekDay: 'monday', order: 0 }, 0);
      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([t0]));
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.pendingTraining).toBeNull();
    });
  });

  // ── Timezone handling ─────────────────────────────────────────────────────

  describe('timezone handling', () => {
    it('resolves weekday using the provided timezone, not UTC', async () => {
      // 2025-04-16T02:30:00Z = still Tuesday April 15 in America/Sao_Paulo (UTC-3: 2025-04-15T23:30)
      // UTC weekday: Wednesday (April 16)
      // São Paulo weekday: Tuesday (April 15)
      vi.setSystemTime(new Date('2025-04-16T02:30:00Z'));

      const tuesdayTraining = makeTraining({ id: 'tr-tue', weekDay: 'tuesday', order: 0 }, 0);
      const wednesdayTraining = makeTraining({ id: 'tr-wed', weekDay: 'wednesday', order: 1 }, 1);

      prisma.trainingProtocol.findFirst.mockResolvedValue(
        makeProtocol([tuesdayTraining, wednesdayTraining]),
      );
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      const result = await getTodayWorkout('user-1', { timeZone: 'America/Sao_Paulo' });

      // São Paulo sees Tuesday → should match tuesdayTraining
      expect(result.targetTraining.id).toBe('tr-tue');
      expect(result.isRestDay).toBe(false);
    });
  });

  // ── Multiple active protocols ─────────────────────────────────────────────

  describe('protocol selection', () => {
    it('queries protocols ordered by startDate desc to pick the latest one', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);
      prisma.trainingProtocol.findFirst.mockResolvedValue(makeProtocol([t0]));
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await getTodayWorkout('user-1', defaultOptions);

      const callArgs = prisma.trainingProtocol.findFirst.mock.calls[0][0];
      expect(callArgs.orderBy).toEqual({ startDate: 'desc' });
      expect(callArgs.where).toMatchObject({ status: 'active', deletedAt: null });
    });
  });
});
