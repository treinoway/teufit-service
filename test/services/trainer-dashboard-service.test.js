/**
 * Unit tests for trainer-dashboard-service.js
 *
 * trainer-dashboard-service receives prisma via injection — no db.js mock needed.
 * briefing-service is mocked wholesale: getTrainerDashboard delegates engagement.*
 * (except weekPrCount) to getBriefingByTrainerId rather than recomputing it, so
 * briefing internals are out of scope here (covered by briefing-service.test.js).
 *
 * Query-shape assertions matter more than usual in this file: every KPI is a
 * DB-side count/aggregate, so the "business logic" IS the where-clause. Several
 * edge cases from the spec (empty-payments subscription, expirationDate=null
 * exclusion) are Prisma/SQL-semantic guarantees (`some`/`none` on an empty
 * relation, `lt`/`gte` against NULL) that a mocked prisma.count cannot actually
 * exercise — those are covered behaviorally in
 * test/e2e/trainer-dashboard.e2e.test.js against a real database. This file
 * verifies the where-clauses those semantics rely on are constructed correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTrainerDashboard } from '../../src/services/trainer-dashboard-service.js';
import { SubscriptionStatus, PaymentStatus } from '../../src/constants/subscription.js';
import { getDateOnlyAsMidnightUtc, addDaysMs } from '../../src/helpers/date-helpers.js';

// Mocked wholesale — see file docstring. startOfCurrentMonth is re-implemented
// (not stubbed to a constant) so it stays correct under vi.useFakeTimers()
// without needing to keep a hardcoded date in sync with each test's system time.
// Mirrors the real signature (from = new Date()) rather than ignoring args —
// this lets tests assert getTrainerDashboard passes its own captured `now`
// through, instead of letting the mock silently call `new Date()` again.
vi.mock('../../src/services/briefing-service.js', () => ({
  getBriefingByTrainerId: vi.fn(),
  startOfCurrentMonth: vi.fn((from = new Date()) => {
    return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  }),
}));

import { getBriefingByTrainerId, startOfCurrentMonth } from '../../src/services/briefing-service.js';

const TRAINER_ID = 'trainer-001';
const USER_ID = 'user-001';

const DEFAULT_BRIEFING = {
  inactiveStudents: 0,
  overallAdherence: '0.00',
  adherenceDeltaPp: '0.00',
};

/**
 * Build a minimal mock prisma object. Each property defaults to a vi.fn()
 * that resolves to an empty/zero value, matching buildMockPrisma in
 * briefing-service.test.js.
 */
function buildMockPrisma(overrides = {}) {
  return {
    trainer: {
      findUnique: vi.fn().mockResolvedValue({ id: TRAINER_ID }),
      ...overrides.trainer,
    },
    studentSubscription: {
      count: vi.fn().mockResolvedValue(0),
      // Backs resolveAllSubscriptionIds — defaults to a non-empty id list so
      // finance's computeFinance() doesn't hit its empty-list short-circuit
      // in tests that don't care about subscription ids specifically.
      findMany: vi.fn().mockResolvedValue([{ id: 'sub-default-1' }, { id: 'sub-default-2' }]),
      ...overrides.studentSubscription,
    },
    trainingProtocol: {
      count: vi.fn().mockResolvedValue(0),
      ...overrides.trainingProtocol,
    },
    subscriptionPayment: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } }),
      ...overrides.subscriptionPayment,
    },
    trainerStudent: {
      count: vi.fn().mockResolvedValue(0),
      ...overrides.trainerStudent,
    },
  };
}

beforeEach(() => {
  getBriefingByTrainerId.mockReset();
  getBriefingByTrainerId.mockResolvedValue(DEFAULT_BRIEFING);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getTrainerDashboard', () => {
  // ─── Trainer resolution ────────────────────────────────────────────────────

  it('throws NotFoundAppError with trainer.notFound messageCode and 404 status when no trainer profile exists', async () => {
    const prisma = buildMockPrisma({ trainer: { findUnique: vi.fn().mockResolvedValue(null) } });

    await expect(getTrainerDashboard(prisma, USER_ID)).rejects.toMatchObject({
      error: 'NOT_FOUND',
      messageCode: 'trainer.notFound',
      httpStatus: 404,
    });
  });

  it('resolves the trainer by userId, selecting only id', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: TRAINER_ID });
    const prisma = buildMockPrisma({ trainer: { findUnique } });

    await getTrainerDashboard(prisma, USER_ID);

    expect(findUnique).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      select: { id: true },
    });
  });

  it('delegates engagement KPIs to getBriefingByTrainerId using trainer.id (not userId)', async () => {
    const prisma = buildMockPrisma();

    await getTrainerDashboard(prisma, USER_ID);

    expect(getBriefingByTrainerId).toHaveBeenCalledWith(prisma, TRAINER_ID);
  });

  // ─── Full happy-path shape ──────────────────────────────────────────────────

  it('returns the full documented response shape with all fields populated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));

    getBriefingByTrainerId.mockResolvedValue({
      inactiveStudents: 5,
      overallAdherence: '78.50',
      adherenceDeltaPp: '3.20',
    });

    const prisma = buildMockPrisma({
      studentSubscription: {
        count: vi.fn()
          .mockResolvedValueOnce(3) // expiredCount
          .mockResolvedValueOnce(2), // renewingSoonCount
      },
      trainingProtocol: {
        count: vi.fn()
          .mockResolvedValueOnce(4) // expiredCount
          .mockResolvedValueOnce(2), // expiringSoonCount
      },
      subscriptionPayment: {
        aggregate: vi.fn()
          .mockResolvedValueOnce({ _sum: { amount: 2500 } }) // monthReceived
          .mockResolvedValueOnce({ _sum: { amount: 12000 } }) // totalReceived
          .mockResolvedValueOnce({ _sum: { amount: 450 }, _count: { _all: 3 } }), // overdue
      },
      trainerStudent: {
        count: vi.fn().mockResolvedValue(4), // weekPrCount
      },
    });

    const result = await getTrainerDashboard(prisma, USER_ID);

    expect(result).toEqual({
      plans: { expiredCount: 3, renewingSoonCount: 2 },
      routines: { expiredCount: 4, expiringSoonCount: 2 },
      finance: { monthReceived: '2500.00', totalReceived: '12000.00', overdueCount: 3, overdueAmount: '450.00' },
      engagement: { inactiveStudentsCount: 5, adherenceMonthPct: '78.50', adherenceDeltaPp: '3.20', weekPrCount: 4 },
      generatedAt: '2026-07-14T12:00:00.000Z',
    });
  });

  it('generatedAt is a valid ISO timestamp reflecting the instant the dashboard was built', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T09:30:00.000Z'));

    const prisma = buildMockPrisma();
    const result = await getTrainerDashboard(prisma, USER_ID);

    expect(result.generatedAt).toBe('2026-07-14T09:30:00.000Z');
  });

  // ─── Empty sums → "0.00" string, never null/number ─────────────────────────

  describe('finance empty sums', () => {
    it('formats monthReceived, totalReceived, and overdueAmount as "0.00" strings (not null) when no rows match', async () => {
      const prisma = buildMockPrisma({
        subscriptionPayment: {
          aggregate: vi.fn()
            .mockResolvedValueOnce({ _sum: { amount: null } })
            .mockResolvedValueOnce({ _sum: { amount: null } })
            .mockResolvedValueOnce({ _sum: { amount: null }, _count: { _all: 0 } }),
        },
      });

      const result = await getTrainerDashboard(prisma, USER_ID);

      expect(result.finance.monthReceived).toBe('0.00');
      expect(result.finance.totalReceived).toBe('0.00');
      expect(result.finance.overdueAmount).toBe('0.00');
      expect(result.finance.overdueCount).toBe(0);
      expect(typeof result.finance.monthReceived).toBe('string');
      expect(typeof result.finance.totalReceived).toBe('string');
      expect(typeof result.finance.overdueAmount).toBe('string');
    });
  });

  // ─── adherenceDeltaPp negative pass-through ─────────────────────────────────

  it('passes through a negative adherenceDeltaPp string from the briefing snapshot unchanged', async () => {
    getBriefingByTrainerId.mockResolvedValue({
      inactiveStudents: 2,
      overallAdherence: '40.00',
      adherenceDeltaPp: '-3.20',
    });

    const prisma = buildMockPrisma();
    const result = await getTrainerDashboard(prisma, USER_ID);

    expect(result.engagement.adherenceDeltaPp).toBe('-3.20');
    expect(result.engagement.adherenceDeltaPp).toMatch(/^-?\d+(\.\d{1,2})?$/);
  });

  // ─── plans.expiredCount vs finance.overdueCount divergence ─────────────────

  describe('plans.expiredCount vs finance.overdueCount — different units, different scoping', () => {
    it('queries plans.expiredCount as SUBSCRIPTIONS scoped to status=active only', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
      const today = getDateOnlyAsMidnightUtc(new Date('2026-07-14T12:00:00.000Z'));

      const studentSubscriptionCount = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      const prisma = buildMockPrisma({ studentSubscription: { count: studentSubscriptionCount } });

      const result = await getTrainerDashboard(prisma, USER_ID);

      expect(result.plans.expiredCount).toBe(1);
      expect(studentSubscriptionCount).toHaveBeenNthCalledWith(1, {
        where: {
          trainerId: TRAINER_ID,
          status: SubscriptionStatus.ACTIVE,
          payments: { some: { status: PaymentStatus.PENDING, dueDate: { lt: today } } },
        },
      });
    });

    it('resolves subscriptionIds via findMany scoped by trainerId ONLY (no status filter), and uses that full id list for finance.overdueCount — proving cancelled subscriptions are not excluded', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
      const today = getDateOnlyAsMidnightUtc(new Date('2026-07-14T12:00:00.000Z'));

      const findMany = vi.fn().mockResolvedValue([
        { id: 'sub-active' },
        { id: 'sub-cancelled' },
      ]);
      const aggregate = vi.fn()
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _sum: { amount: 450 }, _count: { _all: 3 } });
      const prisma = buildMockPrisma({
        studentSubscription: { findMany },
        subscriptionPayment: { aggregate },
      });

      const result = await getTrainerDashboard(prisma, USER_ID);

      expect(result.finance.overdueCount).toBe(3);

      // resolveAllSubscriptionIds queries by trainerId ONLY — no status
      // filter — so a cancelled subscription's id is included in the list.
      expect(findMany).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        select: { id: true },
      });
      expect(findMany.mock.calls[0][0].where.status).toBeUndefined();

      const overdueCall = aggregate.mock.calls[2][0];
      expect(overdueCall).toEqual({
        where: {
          subscriptionId: { in: ['sub-active', 'sub-cancelled'] },
          status: PaymentStatus.PENDING,
          dueDate: { lt: today },
        },
        _count: { _all: true },
        _sum: { amount: true },
      });
    });

    it('a single active subscription with 3 overdue payments produces expiredCount=1 but overdueCount=3', async () => {
      const prisma = buildMockPrisma({
        studentSubscription: { count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0) },
        subscriptionPayment: {
          aggregate: vi.fn()
            .mockResolvedValueOnce({ _sum: { amount: null } })
            .mockResolvedValueOnce({ _sum: { amount: null } })
            .mockResolvedValueOnce({ _sum: { amount: 300 }, _count: { _all: 3 } }),
        },
      });

      const result = await getTrainerDashboard(prisma, USER_ID);

      expect(result.plans.expiredCount).toBe(1);
      expect(result.finance.overdueCount).toBe(3);
    });
  });

  // ─── plans.renewingSoonCount — 7-day inclusive window ───────────────────────

  describe('plans.renewingSoonCount window', () => {
    it('queries with an inclusive [today, today+7d] window via gte/lte, and excludes payments beyond the window via none/gt', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
      const today = getDateOnlyAsMidnightUtc(new Date('2026-07-14T12:00:00.000Z'));
      const windowEnd = addDaysMs(today, 7);

      const studentSubscriptionCount = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(2);
      const prisma = buildMockPrisma({ studentSubscription: { count: studentSubscriptionCount } });

      await getTrainerDashboard(prisma, USER_ID);

      expect(studentSubscriptionCount).toHaveBeenNthCalledWith(2, {
        where: {
          trainerId: TRAINER_ID,
          status: SubscriptionStatus.ACTIVE,
          payments: {
            some: { cycleEndDate: { gte: today, lte: windowEnd } },
            none: { cycleEndDate: { gt: windowEnd } },
          },
        },
      });
    });
  });

  // ─── routines.expiredCount / expiringSoonCount ──────────────────────────────

  describe('routines window queries', () => {
    it('queries expiredCount with a strict (exclusive) lt today and non-null expirationDate', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
      const today = getDateOnlyAsMidnightUtc(new Date('2026-07-14T12:00:00.000Z'));

      const trainingProtocolCount = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(0);
      const prisma = buildMockPrisma({ trainingProtocol: { count: trainingProtocolCount } });

      await getTrainerDashboard(prisma, USER_ID);

      expect(trainingProtocolCount).toHaveBeenNthCalledWith(1, {
        where: {
          trainerId: TRAINER_ID,
          status: 'active',
          deletedAt: null,
          expirationDate: { not: null, lt: today },
        },
      });
    });

    it('queries expiringSoonCount with an inclusive [today, today+7d] window (gte/lte)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
      const today = getDateOnlyAsMidnightUtc(new Date('2026-07-14T12:00:00.000Z'));
      const windowEnd = addDaysMs(today, 7);

      const trainingProtocolCount = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(2);
      const prisma = buildMockPrisma({ trainingProtocol: { count: trainingProtocolCount } });

      await getTrainerDashboard(prisma, USER_ID);

      expect(trainingProtocolCount).toHaveBeenNthCalledWith(2, {
        where: {
          trainerId: TRAINER_ID,
          status: 'active',
          deletedAt: null,
          expirationDate: { gte: today, lte: windowEnd },
        },
      });
    });

    it('uses the exact same inclusive-both-ends 7-day window boundary as plans.renewingSoonCount', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));

      const studentSubscriptionCount = vi.fn().mockResolvedValue(0);
      const trainingProtocolCount = vi.fn().mockResolvedValue(0);
      const prisma = buildMockPrisma({
        studentSubscription: { count: studentSubscriptionCount },
        trainingProtocol: { count: trainingProtocolCount },
      });

      await getTrainerDashboard(prisma, USER_ID);

      const renewingSoonWhere = studentSubscriptionCount.mock.calls[1][0].where;
      const expiringSoonWhere = trainingProtocolCount.mock.calls[1][0].where;

      const renewingSoonWindowEnd = renewingSoonWhere.payments.some.cycleEndDate.lte;
      const expiringSoonWindowEnd = expiringSoonWhere.expirationDate.lte;

      // Same day offset (today + 7d), same convention (inclusive both ends
      // via lte, not lt) — symmetry required by the spec.
      expect(expiringSoonWindowEnd.getTime()).toBe(renewingSoonWindowEnd.getTime());
      expect(renewingSoonWhere.payments.some.cycleEndDate.gte).toBeInstanceOf(Date);
      expect(expiringSoonWhere.expirationDate.gte).toBeInstanceOf(Date);
    });
  });

  // ─── finance.monthReceived / totalReceived date windows ─────────────────────

  describe('finance date windows', () => {
    it('scopes monthReceived to [monthStart, now) and totalReceived to all-time, both PAID and filtered by the resolved subscriptionId list', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-07-14T12:00:00.000Z');
      vi.setSystemTime(now);
      const monthStart = new Date(Date.UTC(2026, 6, 1));

      const findMany = vi.fn().mockResolvedValue([{ id: 'sub-x' }]);
      const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } });
      const prisma = buildMockPrisma({
        studentSubscription: { findMany },
        subscriptionPayment: { aggregate },
      });

      await getTrainerDashboard(prisma, USER_ID);

      const monthReceivedCall = aggregate.mock.calls[0][0];
      expect(monthReceivedCall).toEqual({
        where: {
          subscriptionId: { in: ['sub-x'] },
          status: PaymentStatus.PAID,
          paidAt: { gte: monthStart, lt: now },
        },
        _sum: { amount: true },
      });

      const totalReceivedCall = aggregate.mock.calls[1][0];
      expect(totalReceivedCall).toEqual({
        where: {
          subscriptionId: { in: ['sub-x'] },
          status: PaymentStatus.PAID,
        },
        _sum: { amount: true },
      });
    });

    it('derives monthStart from the SAME captured `now` instant used for generatedAt and the paidAt upper bound — guards against a month-boundary race from two independent `new Date()` calls', async () => {
      vi.useFakeTimers();
      // Last instant of January (UTC) — the exact scenario the bug fix
      // targets: a second, independent `new Date()` call a moment later
      // would already read February.
      const now = new Date('2026-01-31T23:59:59.999Z');
      vi.setSystemTime(now);

      startOfCurrentMonth.mockClear();

      const findMany = vi.fn().mockResolvedValue([{ id: 'sub-x' }]);
      const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } });
      const prisma = buildMockPrisma({
        studentSubscription: { findMany },
        subscriptionPayment: { aggregate },
      });

      const result = await getTrainerDashboard(prisma, USER_ID);

      // startOfCurrentMonth must be called with the exact `now` instant
      // reflected in generatedAt — not a fresh, independently-read `new Date()`.
      expect(startOfCurrentMonth).toHaveBeenCalledWith(now);
      expect(result.generatedAt).toBe(now.toISOString());

      // monthStart must resolve to January 1st, not February 1st — proving
      // the range isn't inverted/empty at the exact millisecond of the race.
      const monthReceivedCall = aggregate.mock.calls[0][0];
      expect(monthReceivedCall.where.paidAt.gte).toEqual(new Date(Date.UTC(2026, 0, 1)));
      expect(monthReceivedCall.where.paidAt.lt).toEqual(now);
    });
  });

  // ─── finance subscriptionId resolution ──────────────────────────────────────

  describe('finance subscriptionId resolution', () => {
    it('short-circuits computeFinance without querying subscriptionPayment.aggregate when the trainer has zero subscriptions ever', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const aggregate = vi.fn();
      const prisma = buildMockPrisma({
        studentSubscription: { findMany },
        subscriptionPayment: { aggregate },
      });

      const result = await getTrainerDashboard(prisma, USER_ID);

      expect(aggregate).not.toHaveBeenCalled();
      expect(result.finance).toEqual({
        monthReceived: '0.00',
        totalReceived: '0.00',
        overdueCount: 0,
        overdueAmount: '0.00',
      });
    });
  });

  // ─── engagement.weekPrCount ──────────────────────────────────────────────────

  describe('engagement.weekPrCount', () => {
    it('is computed live (not from the briefing snapshot) via trainerStudent.count with currentPrAt >= today-7d', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
      const today = getDateOnlyAsMidnightUtc(new Date('2026-07-14T12:00:00.000Z'));
      const prWindowStart = addDaysMs(today, -7);

      const trainerStudentCount = vi.fn().mockResolvedValue(4);
      const prisma = buildMockPrisma({ trainerStudent: { count: trainerStudentCount } });

      const result = await getTrainerDashboard(prisma, USER_ID);

      expect(result.engagement.weekPrCount).toBe(4);
      expect(trainerStudentCount).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID, activeOnPlan: true, currentPrAt: { gte: prWindowStart } },
      });
    });

    it('filters to activeOnPlan: true — same active-only population as the snapshot-derived inactiveStudentsCount/adherenceMonthPct/adherenceDeltaPp fields in the same engagement block', async () => {
      const trainerStudentCount = vi.fn().mockResolvedValue(0);
      const prisma = buildMockPrisma({ trainerStudent: { count: trainerStudentCount } });

      await getTrainerDashboard(prisma, USER_ID);

      const whereClause = trainerStudentCount.mock.calls[0][0].where;
      expect(whereClause.activeOnPlan).toBe(true);
    });
  });
});
