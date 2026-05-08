import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainingProtocol: { findMany: vi.fn() },
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
      // 2025-04-16 is a Wednesday
      vi.setSystemTime(new Date('2025-04-16T12:00:00Z'));

      const wednesdayTraining = makeTraining({ id: 'tr-wed', weekDay: 'wednesday', order: 0 }, 0);
      const fridayTraining = makeTraining({ id: 'tr-fri', weekDay: 'friday', order: 1 }, 1);

      prisma.trainingProtocol.findMany.mockResolvedValue([
        makeProtocol([wednesdayTraining, fridayTraining]),
      ]);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts[0].targetTraining.id).toBe('tr-wed');
      expect(result.workouts[0].isRestDay).toBe(false);
      expect(result.workouts[0].nextScheduledDate).toBeNull();
    });

    it('returns rest day with nextScheduledDate when today does not match any training', async () => {
      // 2025-04-16 is a Wednesday
      vi.setSystemTime(new Date('2025-04-16T12:00:00Z'));

      // Only monday and friday trainings — Wednesday is a rest day
      const mondayTraining = makeTraining({ id: 'tr-mon', weekDay: 'monday', order: 0 }, 0);
      const fridayTraining = makeTraining({ id: 'tr-fri', weekDay: 'friday', order: 1 }, 1);

      prisma.trainingProtocol.findMany.mockResolvedValue([
        makeProtocol([mondayTraining, fridayTraining]),
      ]);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts[0].isRestDay).toBe(true);
      expect(result.workouts[0].targetTraining).toBeNull();
      // Next friday is 2025-04-18 (2 days away)
      expect(result.workouts[0].nextScheduledDate).toBe('2025-04-18');
    });

    it('returns nextScheduledDate: null when no weekDay match found in next 7 days', async () => {
      // An impossible weekDay value ensures the 7-day scan finds no match
      vi.setSystemTime(new Date('2025-04-16T12:00:00Z')); // Wednesday

      const strangeTraining = makeTraining({ id: 'tr-x', weekDay: 'holiday', order: 0 }, 0);

      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([strangeTraining])]);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts[0].isRestDay).toBe(true);
      expect(result.workouts[0].nextScheduledDate).toBeNull();
    });

    it('uses weekDay mode when only one of multiple trainings has a weekDay set', async () => {
      // 2025-04-14 is a Monday
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z'));

      const mondayTraining = makeTraining({ id: 'tr-mon', weekDay: 'monday', order: 0 }, 0);
      const orderOnlyTraining = makeTraining({ id: 'tr-order', weekDay: null, order: 1 }, 1);

      prisma.trainingProtocol.findMany.mockResolvedValue([
        makeProtocol([mondayTraining, orderOnlyTraining]),
      ]);

      const result = await getTodayWorkout('user-1', defaultOptions);

      // weekDay mode because mondayTraining has weekDay != null
      expect(result.workouts[0].targetTraining.id).toBe('tr-mon');
      expect(result.workouts[0].isRestDay).toBe(false);
    });
  });

  // ── order mode ────────────────────────────────────────────────────────────

  describe('order mode', () => {
    it('returns first training when there are no completed sessions', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);
      const t1 = makeTraining({ id: 'tr-1', weekDay: null, order: 1 }, 1);
      const t2 = makeTraining({ id: 'tr-2', weekDay: null, order: 2 }, 2);

      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([t0, t1, t2])]);
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null) // pending in_progress
        .mockResolvedValueOnce(null); // last completed

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts[0].targetTraining.id).toBe('tr-0');
      expect(result.workouts[0].isRestDay).toBe(false);
      expect(result.workouts[0].nextScheduledDate).toBeNull();
    });

    it('returns next training after last completed session', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);
      const t1 = makeTraining({ id: 'tr-1', weekDay: null, order: 1 }, 1);
      const t2 = makeTraining({ id: 'tr-2', weekDay: null, order: 2 }, 2);

      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([t0, t1, t2])]);
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null) // pending in_progress
        .mockResolvedValueOnce({ training: { order: 0 } }); // last completed = order 0

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts[0].targetTraining.id).toBe('tr-1');
    });

    it('cycles back to first training when last completed was the max order', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);
      const t1 = makeTraining({ id: 'tr-1', weekDay: null, order: 1 }, 1);
      const t2 = makeTraining({ id: 'tr-2', weekDay: null, order: 2 }, 2);

      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([t0, t1, t2])]);
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null) // pending in_progress
        .mockResolvedValueOnce({ training: { order: 2 } }); // last completed = max order

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts[0].targetTraining.id).toBe('tr-0');
    });

    it('always has isRestDay: false and nextScheduledDate: null in order mode', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);

      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([t0])]);
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts[0].isRestDay).toBe(false);
      expect(result.workouts[0].nextScheduledDate).toBeNull();
    });
  });

  // ── Error cases ───────────────────────────────────────────────────────────

  describe('error cases', () => {
    it('throws workoutsToday.noActiveProtocol (404) when no active protocol exists', async () => {
      prisma.trainingProtocol.findMany.mockResolvedValue([]);

      await expect(getTodayWorkout('user-1', defaultOptions)).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: WorkoutsTodayMessageCode.NO_ACTIVE_PROTOCOL,
        error: 'NO_ACTIVE_PROTOCOL',
      });
    });

    it('throws workoutsToday.emptyProtocol (404) when all active protocols have no trainings', async () => {
      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([])]);

      await expect(getTodayWorkout('user-1', defaultOptions)).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: WorkoutsTodayMessageCode.EMPTY_PROTOCOL,
        error: 'EMPTY_PROTOCOL',
      });
    });
  });

  // ── pendingTraining (envelope level) ─────────────────────────────────────

  describe('pendingTraining', () => {
    it('populates pendingTraining at the envelope level from a cross-protocol in_progress session', async () => {
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z')); // Monday

      const t0 = makeTraining({ id: 'tr-0', weekDay: 'monday', order: 0 }, 0);
      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([t0])]);

      const crossProtocolSession = makeSession({
        id: 'sess-cross',
        trainingId: 'tr-other-protocol',
        status: 'in_progress',
        startedAt: new Date('2025-04-14T08:00:00Z'),
      });
      prisma.workoutSession.findFirst.mockResolvedValue(crossProtocolSession);

      const result = await getTodayWorkout('user-1', defaultOptions);

      // pendingTraining is at the envelope root, not inside each workout entry
      expect(result.pendingTraining).not.toBeNull();
      expect(result.pendingTraining.sessionId).toBe('sess-cross');
      expect(result.pendingTraining.trainingId).toBe('tr-other-protocol');
      expect(result.pendingTraining.status).toBe('in_progress');
      expect(result.pendingTraining.startedAt).toBeDefined();
    });

    it('returns pendingTraining: null at the envelope level when no in_progress session exists', async () => {
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z'));

      const t0 = makeTraining({ id: 'tr-0', weekDay: 'monday', order: 0 }, 0);
      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([t0])]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.pendingTraining).toBeNull();
    });

    it('does not embed pendingTraining inside workout entries', async () => {
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z'));

      const t0 = makeTraining({ id: 'tr-0', weekDay: 'monday', order: 0 }, 0);
      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([t0])]);
      prisma.workoutSession.findFirst.mockResolvedValue(makeSession());

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts[0]).not.toHaveProperty('pendingTraining');
    });
  });

  // ── Multiple active protocols ─────────────────────────────────────────────

  describe('multi-protocol fan-out', () => {
    it('returns one workout entry per active protocol', async () => {
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z')); // Monday

      const proto1 = makeProtocol(
        [makeTraining({ id: 'tr-p1', weekDay: 'monday', order: 0 }, 0)],
        { id: 'proto-1', name: 'Strength' },
      );
      const proto2 = makeProtocol(
        [makeTraining({ id: 'tr-p2', weekDay: null, order: 0 }, 1)],
        { id: 'proto-2', name: 'Mobility' },
      );

      prisma.trainingProtocol.findMany.mockResolvedValue([proto1, proto2]);
      // pending check returns null; order-mode session lookup returns null too
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts).toHaveLength(2);
      expect(result.workouts[0].protocol.id).toBe('proto-1');
      expect(result.workouts[1].protocol.id).toBe('proto-2');
    });

    it('pendingTraining appears once at the envelope, not inside each entry', async () => {
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z')); // Monday

      const proto1 = makeProtocol(
        [makeTraining({ id: 'tr-p1', weekDay: 'monday', order: 0 }, 0)],
        { id: 'proto-1', name: 'Strength' },
      );
      const proto2 = makeProtocol(
        [makeTraining({ id: 'tr-p2', weekDay: null, order: 0 }, 1)],
        { id: 'proto-2', name: 'Mobility' },
      );

      prisma.trainingProtocol.findMany.mockResolvedValue([proto1, proto2]);

      const session = makeSession({ id: 'sess-active', trainingId: 'tr-p1' });
      // First call: pending session. Second call: order-mode completed lookup.
      prisma.workoutSession.findFirst
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(null);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.pendingTraining).not.toBeNull();
      expect(result.pendingTraining.sessionId).toBe('sess-active');

      // pendingTraining must NOT appear in any individual workout entry
      for (const entry of result.workouts) {
        expect(entry).not.toHaveProperty('pendingTraining');
      }
    });

    it('skips protocols with no trainings and does not throw if at least one has trainings', async () => {
      vi.setSystemTime(new Date('2025-04-14T12:00:00Z'));

      const emptyProto = makeProtocol([], { id: 'proto-empty', name: 'Empty' });
      const activeProto = makeProtocol(
        [makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0)],
        { id: 'proto-active', name: 'Active' },
      );

      prisma.trainingProtocol.findMany.mockResolvedValue([emptyProto, activeProto]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      const result = await getTodayWorkout('user-1', defaultOptions);

      expect(result.workouts).toHaveLength(1);
      expect(result.workouts[0].protocol.id).toBe('proto-active');
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

      prisma.trainingProtocol.findMany.mockResolvedValue([
        makeProtocol([tuesdayTraining, wednesdayTraining]),
      ]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      const result = await getTodayWorkout('user-1', { timeZone: 'America/Sao_Paulo' });

      // São Paulo sees Tuesday → should match tuesdayTraining
      expect(result.workouts[0].targetTraining.id).toBe('tr-tue');
      expect(result.workouts[0].isRestDay).toBe(false);
    });
  });

  // ── Protocol query shape ──────────────────────────────────────────────────

  describe('protocol query', () => {
    it('queries active protocols ordered by startDate desc', async () => {
      const t0 = makeTraining({ id: 'tr-0', weekDay: null, order: 0 }, 0);
      prisma.trainingProtocol.findMany.mockResolvedValue([makeProtocol([t0])]);
      prisma.workoutSession.findFirst.mockResolvedValue(null);

      await getTodayWorkout('user-1', defaultOptions);

      const callArgs = prisma.trainingProtocol.findMany.mock.calls[0][0];
      expect(callArgs.orderBy).toEqual({ startDate: 'desc' });
      expect(callArgs.where).toMatchObject({ status: 'active', deletedAt: null });
    });
  });
});
