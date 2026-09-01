/**
 * Unit tests for briefing-service.js
 *
 * briefing-service receives prisma via injection — no db.js mock needed.
 * Each test constructs a fake prisma object with the minimal methods required.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeBriefing,
  getBriefing,
  markBriefingDirty,
  refreshAllBriefings,
  refreshBriefing,
} from '../../src/services/briefing-service.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/**
 * Build a minimal mock prisma object.
 * Each property defaults to a vi.fn() that resolves to the provided value.
 */
function buildMockPrisma(overrides = {}) {
  return {
    trainer: {
      findUnique: vi.fn().mockResolvedValue(null),
      ...overrides.trainer,
    },
    trainerStudent: {
      findMany: vi.fn().mockResolvedValue([]),
      // refreshAllBriefings uses groupBy(['trainerId']) — SQL GROUP BY — rather
      // than findMany+distinct, which would read the whole roster table.
      groupBy: vi.fn().mockResolvedValue([]),
      ...overrides.trainerStudent,
    },
    trainingProtocol: {
      findMany: vi.fn().mockResolvedValue([]),
      ...overrides.trainingProtocol,
    },
    workoutSession: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      ...overrides.workoutSession,
    },
    setLog: {
      findMany: vi.fn().mockResolvedValue([]),
      ...overrides.setLog,
    },
    trainerBriefingSnapshot: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      ...overrides.trainerBriefingSnapshot,
    },
  };
}

// ─── computeBriefing ─────────────────────────────────────────────────────────

describe('computeBriefing', () => {
  const TRAINER_ID = 'trainer-001';

  it('returns all zeros for an empty roster', async () => {
    const prisma = buildMockPrisma({
      trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.activeStudents).toBe(0);
    expect(result.returningThisWeek).toBe(0);
    expect(result.stagnantProgress).toBe(0);
    expect(result.inactiveStudents).toBe(0);
    expect(result.overallAdherence).toBe(0);
    expect(result.adherenceDeltaPp).toBe(0);
  });

  it('returns overallAdherence=0 and adherenceDeltaPp=0 when denominator is zero (not NaN)', async () => {
    const prisma = buildMockPrisma({
      trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(Number.isNaN(result.overallAdherence)).toBe(false);
    expect(Number.isNaN(result.adherenceDeltaPp)).toBe(false);
    expect(result.overallAdherence).toBe(0);
    expect(result.adherenceDeltaPp).toBe(0);
  });

  it('counts activeStudents from completed sessions in last 30 days', async () => {
    const studentA = 'student-a';
    const studentB = 'student-b';

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn()
          // First call: resolveActiveStudentIds — returns 2 distinct users
          .mockResolvedValueOnce([{ userId: studentA }, { userId: studentB }])
          // Second call: returningThisWeek (recent 7d)
          .mockResolvedValueOnce([])
          // Third call: returningThisWeek (gap check)
          .mockResolvedValueOnce([])
          // Fourth call: inactiveStudents active set
          .mockResolvedValueOnce([{ userId: studentA }, { userId: studentB }]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([
          { studentId: studentA },
          { studentId: studentB },
        ]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.activeStudents).toBe(2);
  });

  it('counts inactiveStudents correctly — students with no completed session in last 7 days', async () => {
    const studentA = 'student-a';
    const studentB = 'student-b';
    const studentC = 'student-c';

    // workoutSession.groupBy call order (when returningThisWeek recent returns empty,
    // the gap-window call is short-circuited):
    //   1. resolveActiveStudentIds → [studentA]
    //   2. returningThisWeek recent (last 7d) → [] (short-circuits gap check)
    //   3. inactiveStudents active-in-7d → [studentA]
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn()
          .mockResolvedValueOnce([{ userId: studentA }]) // resolveActiveStudentIds
          .mockResolvedValueOnce([])                      // returningThisWeek recent (→ skip gap)
          .mockResolvedValueOnce([{ userId: studentA }]), // inactiveStudents
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([
          { studentId: studentA },
          { studentId: studentB },
          { studentId: studentC },
        ]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    // studentB and studentC have no session in last 7d → 2 inactive
    expect(result.inactiveStudents).toBe(2);
  });

  // Dispatch workoutSession.groupBy results based on the shape of `where`.
  // Branches of computeBriefing run via Promise.all so call order is not stable;
  // routing by the query's distinguishing fields makes the test deterministic.
  function workoutSessionGroupByMock({ active, recent, gap, preGap, inactive }) {
    return vi.fn().mockImplementation(({ where }) => {
      const { startedAt } = where;
      if (startedAt?.gte && startedAt?.lt) {
        // Bounded window: gap (7..14d ago).
        return gap ?? [];
      }
      if (startedAt?.lt && !startedAt?.gte) {
        // < bound only: pre-gap (older than 14d).
        return preGap ?? [];
      }
      if (startedAt?.gte && where.user) {
        // gte-only with user trainers filter → resolveActiveStudentIds (30d).
        return active ?? [];
      }
      if (startedAt?.gte && Array.isArray(where.userId?.in)) {
        // gte + userId IN: could be recent (7d) or inactive (7d).
        // Distinguish by whether the inactive branch is set.
        // The two are run with different gte values; if same, use heuristic by call shape.
        // Both queries use the same shape — disambiguate by call count.
        if (!workoutSessionGroupByMock._recentReturned) {
          workoutSessionGroupByMock._recentReturned = true;
          return recent ?? [];
        }
        return inactive ?? [];
      }
      return [];
    });
  }

  it('counts returningThisWeek: student had session in last 7d but NOT in 7-14d window AND has pre-gap history', async () => {
    workoutSessionGroupByMock._recentReturned = false;
    const studentA = 'student-a';

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: workoutSessionGroupByMock({
          active: [{ userId: studentA }],
          recent: [{ userId: studentA }],
          gap: [],
          preGap: [{ userId: studentA }], // has history older than 14d
          inactive: [{ userId: studentA }],
        }),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.returningThisWeek).toBe(1);
  });

  it('does NOT count as returning when student has no pre-gap history (first sessions ever)', async () => {
    workoutSessionGroupByMock._recentReturned = false;
    const studentA = 'student-a';

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: workoutSessionGroupByMock({
          active: [{ userId: studentA }],
          recent: [{ userId: studentA }],
          gap: [],
          preGap: [], // no history older than 14d
          inactive: [{ userId: studentA }],
        }),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.returningThisWeek).toBe(0);
  });

  it('does not count as returning when student was active in the gap window', async () => {
    const studentA = 'student-a';

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn()
          // resolveActiveStudentIds
          .mockResolvedValueOnce([{ userId: studentA }])
          // returningThisWeek: recent 7d → studentA present
          .mockResolvedValueOnce([{ userId: studentA }])
          // returningThisWeek: gap 7-14d → studentA also present (not a gap return)
          .mockResolvedValueOnce([{ userId: studentA }])
          // inactiveStudents
          .mockResolvedValueOnce([{ userId: studentA }]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.returningThisWeek).toBe(0);
  });

  it('counts student as stagnant when in-window max load does not exceed pre-window max', async () => {
    const studentA = 'student-a';
    const exerciseId = 'exercise-001';

    // Pre-window load: 100kg. In-window load: 100kg. Same → stagnant.
    const preWindowLog = {
      load: 100,
      exerciseLog: {
        exerciseId,
        workoutSession: { userId: studentA, startedAt: daysAgo(20) }, // before 14d window
      },
    };
    const inWindowLog = {
      load: 100,
      exerciseLog: {
        exerciseId,
        workoutSession: { userId: studentA, startedAt: daysAgo(7) }, // inside 14d window
      },
    };

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn()
          .mockResolvedValueOnce([{ userId: studentA }]) // resolveActiveStudentIds
          .mockResolvedValueOnce([]) // returningThisWeek recent
          .mockResolvedValueOnce([]) // returningThisWeek gap
          .mockResolvedValueOnce([{ userId: studentA }]), // inactiveStudents
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      setLog: {
        findMany: vi.fn().mockResolvedValue([preWindowLog, inWindowLog]),
      },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.stagnantProgress).toBe(1);
  });

  it('does not count student as stagnant when in-window max load strictly exceeds pre-window max', async () => {
    const studentA = 'student-a';
    const exerciseId = 'exercise-001';

    // Pre-window load: 100kg. In-window load: 105kg. New PR → not stagnant.
    const preWindowLog = {
      load: 100,
      exerciseLog: {
        exerciseId,
        workoutSession: { userId: studentA, startedAt: daysAgo(20) },
      },
    };
    const inWindowLog = {
      load: 105,
      exerciseLog: {
        exerciseId,
        workoutSession: { userId: studentA, startedAt: daysAgo(7) },
      },
    };

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn()
          .mockResolvedValueOnce([{ userId: studentA }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ userId: studentA }]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      setLog: {
        findMany: vi.fn().mockResolvedValue([preWindowLog, inWindowLog]),
      },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.stagnantProgress).toBe(0);
  });

  it('counts student with no load history as stagnant', async () => {
    const studentA = 'student-a';

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn()
          .mockResolvedValueOnce([{ userId: studentA }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ userId: studentA }]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) }, // no set logs at all
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.stagnantProgress).toBe(1);
  });

  // Adherence count dispatch: numerator only (completed). Current vs prior month
  // distinguished by `where.startedAt.gte` value.
  function adherenceCountMock({ currentCompleted, priorCompleted }) {
    return vi.fn().mockImplementation(({ where }) => {
      const gte = where.startedAt?.gte;
      const currentMonthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const isCurrentMonth = gte instanceof Date && gte.getTime() >= currentMonthStart.getTime();
      return isCurrentMonth ? currentCompleted : priorCompleted;
    });
  }

  // Build a protocol fixture that started before the test month and never expires,
  // training on every weekday so expected = number of days in window.
  function buildAllDaysProtocol(assigneeId) {
    return {
      startDate: new Date(Date.UTC(2020, 0, 1)),
      expirationDate: null,
      trainings: [
        { weekDay: 'monday' },
        { weekDay: 'tuesday' },
        { weekDay: 'wednesday' },
        { weekDay: 'thursday' },
        { weekDay: 'friday' },
        { weekDay: 'saturday' },
        { weekDay: 'sunday' },
      ],
      _assigneeId: assigneeId,
    };
  }

  it('computes overallAdherence: completed/expected → 100 when fully adherent', async () => {
    // Fake time to a known date so we can predict expected count.
    // 2026-05-15 12:00 UTC → window [May 1 00:00, May 15 12:00).
    // With every weekday active, expected = 15 (days 1..15 inclusive).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 12, 0, 0)));

    const studentA = 'student-a';
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]), // active students irrelevant
        count: adherenceCountMock({ currentCompleted: 15, priorCompleted: 0 }),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      trainingProtocol: {
        findMany: vi.fn().mockResolvedValue([buildAllDaysProtocol(studentA)]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.overallAdherence).toBe(100);
    vi.useRealTimers();
  });

  it('caps adherence at 100% when completed exceeds expected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 12, 0, 0)));

    const studentA = 'student-a';
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: adherenceCountMock({ currentCompleted: 30, priorCompleted: 0 }), // expected=15
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      trainingProtocol: {
        findMany: vi.fn().mockResolvedValue([buildAllDaysProtocol(studentA)]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.overallAdherence).toBe(100);
    vi.useRealTimers();
  });

  it('returns 0 adherence when no active protocols (no expected sessions)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 12, 0, 0)));

    const studentA = 'student-a';
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      trainingProtocol: { findMany: vi.fn().mockResolvedValue([]) },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.overallAdherence).toBe(0);
    expect(result.adherenceDeltaPp).toBe(0);
    vi.useRealTimers();
  });

  it('computes adherenceDeltaPp as current minus prior month adherence', async () => {
    // 2026-05-15 12:00 UTC. Window: May 1..15 (15 days), April 1..15 (15 days).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 12, 0, 0)));

    const studentA = 'student-a';
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        // expected = 15 both months. 12/15 = 80%, 9/15 = 60%.
        count: adherenceCountMock({ currentCompleted: 12, priorCompleted: 9 }),
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      trainingProtocol: {
        findMany: vi.fn().mockResolvedValue([buildAllDaysProtocol(studentA)]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.overallAdherence).toBe(80);
    expect(result.adherenceDeltaPp).toBe(20);
    vi.useRealTimers();
  });

  it('resolves the active roster once via trainerStudent.findMany with activeOnPlan=true', async () => {
    const trainerStudentFindMany = vi.fn().mockResolvedValue([]);
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: { findMany: trainerStudentFindMany },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await computeBriefing(prisma, TRAINER_ID);

    // Single roster resolution shared across active/inactive/adherence KPIs.
    expect(trainerStudentFindMany).toHaveBeenCalledTimes(1);
    expect(trainerStudentFindMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, activeOnPlan: true },
      select: { studentId: true },
    });
  });

  it('filters roster by activeOnPlan=true when counting inactive students', async () => {
    const trainerStudentFindMany = vi.fn().mockResolvedValue([]);
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: { findMany: trainerStudentFindMany },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await computeBriefing(prisma, TRAINER_ID);

    expect(trainerStudentFindMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, activeOnPlan: true },
      select: { studentId: true },
    });
  });

  it('scopes adherence count queries to the pre-resolved roster via userId IN', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 12, 0, 0)));

    const studentA = 'student-a';
    const count = vi.fn().mockResolvedValue(0);
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count,
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      trainingProtocol: {
        findMany: vi.fn().mockResolvedValue([buildAllDaysProtocol(studentA)]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await computeBriefing(prisma, TRAINER_ID);

    expect(count.mock.calls.length).toBeGreaterThan(0);
    for (const call of count.mock.calls) {
      // Roster is pre-resolved; no nested user.trainers.some join.
      expect(call[0].where.userId).toEqual({ in: [studentA] });
      expect(call[0].where.user).toBeUndefined();
    }
    vi.useRealTimers();
  });

  it('uses an aligned prior-month upper bound for the delta window', async () => {
    // Provide roster + protocol so count is called for both months.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 17, 14, 0, 0))); // May 17 14:00

    const studentA = 'student-a';
    const count = vi.fn().mockResolvedValue(0);
    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count,
      },
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([{ studentId: studentA }]),
      },
      trainingProtocol: {
        findMany: vi.fn().mockResolvedValue([buildAllDaysProtocol(studentA)]),
      },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await computeBriefing(prisma, TRAINER_ID);

    const currentMonthStart = new Date(Date.UTC(2026, 4, 1));
    const priorMonthUpperBounds = count.mock.calls
      .map((c) => c[0].where.startedAt.lt)
      .filter((d) => d < currentMonthStart);
    expect(priorMonthUpperBounds.length).toBeGreaterThan(0);
    // Today is May 17 → prior bound should be Apr 17 (same day-of-month).
    for (const bound of priorMonthUpperBounds) {
      expect(bound.getUTCMonth()).toBe(3); // April (0-indexed)
      expect(bound.getUTCDate()).toBe(17);
    }
    vi.useRealTimers();
  });
});

// ─── markBriefingDirty ────────────────────────────────────────────────────────

describe('markBriefingDirty', () => {
  it('calls updateMany with correct where and data', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildMockPrisma({
      trainerBriefingSnapshot: { updateMany },
    });

    await markBriefingDirty(prisma, 'trainer-001');

    expect(updateMany).toHaveBeenCalledWith({
      where: { trainerId: 'trainer-001' },
      data: { isDirty: true },
    });
  });

  it('does not throw when no snapshot row exists (updateMany returns count:0)', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = buildMockPrisma({
      trainerBriefingSnapshot: { updateMany },
    });

    await expect(markBriefingDirty(prisma, 'trainer-no-snapshot')).resolves.not.toThrow();
  });
});

// ─── refreshBriefing ──────────────────────────────────────────────────────────

describe('refreshBriefing', () => {
  it('upserts snapshot with isDirty=false and returns formatted DTO', async () => {
    const computedAt = new Date('2026-05-15T22:00:00.000Z');
    const snapshotRow = {
      activeStudents: 5,
      returningThisWeek: 1,
      stagnantProgress: 2,
      inactiveStudents: 0,
      overallAdherence: '87.50',
      adherenceDeltaPp: '3.00',
      computedAt,
    };

    const upsert = vi.fn().mockResolvedValue(snapshotRow);

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
      trainerBriefingSnapshot: { upsert },
    });

    const result = await refreshBriefing(prisma, 'trainer-001');

    // upsert was called
    expect(upsert).toHaveBeenCalledOnce();
    const upsertCall = upsert.mock.calls[0][0];
    expect(upsertCall.update.isDirty).toBe(false);
    expect(upsertCall.create.isDirty).toBe(false);

    // result is formatted
    expect(result.overallAdherence).toBe('87.50');
    expect(result.adherenceDeltaPp).toBe('3.00');
    expect(result.computedAt).toBe('2026-05-15T22:00:00.000Z');
  });

  it('formats overallAdherence and adherenceDeltaPp as strings with 2 decimal places', async () => {
    const snapshotRow = {
      activeStudents: 0,
      returningThisWeek: 0,
      stagnantProgress: 0,
      inactiveStudents: 0,
      overallAdherence: 87,
      adherenceDeltaPp: -3.5,
      computedAt: new Date('2026-05-15T22:00:00.000Z'),
    };

    const prisma = buildMockPrisma({
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
      trainerBriefingSnapshot: {
        upsert: vi.fn().mockResolvedValue(snapshotRow),
      },
    });

    const result = await refreshBriefing(prisma, 'trainer-001');

    expect(result.overallAdherence).toBe('87.00');
    expect(result.adherenceDeltaPp).toBe('-3.50');
  });
});

// ─── getBriefing ─────────────────────────────────────────────────────────────

describe('getBriefing', () => {
  const USER_ID = 'user-001';
  const TRAINER_ID = 'trainer-001';

  it('throws NotFoundAppError when trainer profile does not exist', async () => {
    const prisma = buildMockPrisma({
      trainer: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(getBriefing(prisma, USER_ID)).rejects.toMatchObject({
      error: 'NOT_FOUND',
      messageCode: 'trainer.notFound',
    });
  });

  it('returns cached snapshot without recomputing when snapshot is clean', async () => {
    const snapshot = {
      activeStudents: 10,
      returningThisWeek: 2,
      stagnantProgress: 1,
      inactiveStudents: 0,
      overallAdherence: '90.00',
      adherenceDeltaPp: '5.00',
      computedAt: new Date('2026-05-15T22:00:00.000Z'),
      isDirty: false,
    };

    const workoutSessionFindMany = vi.fn();
    const prisma = buildMockPrisma({
      trainer: {
        findUnique: vi.fn().mockResolvedValue({ id: TRAINER_ID }),
      },
      trainerBriefingSnapshot: {
        findUnique: vi.fn().mockResolvedValue(snapshot),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      workoutSession: {
        groupBy: workoutSessionFindMany,
        count: vi.fn(),
      },
    });

    const result = await getBriefing(prisma, USER_ID);

    // Should NOT have called compute machinery
    expect(workoutSessionFindMany).not.toHaveBeenCalled();
    expect(result.activeStudents).toBe(10);
    expect(result.overallAdherence).toBe('90.00');
  });

  it('recomputes when snapshot is dirty', async () => {
    const dirtySnapshot = {
      activeStudents: 5,
      returningThisWeek: 0,
      stagnantProgress: 0,
      inactiveStudents: 0,
      overallAdherence: '50.00',
      adherenceDeltaPp: '0.00',
      computedAt: new Date('2026-05-14T22:00:00.000Z'),
      isDirty: true,
    };

    const freshSnapshot = {
      ...dirtySnapshot,
      activeStudents: 7,
      computedAt: new Date('2026-05-15T22:00:00.000Z'),
      isDirty: false,
    };

    const upsert = vi.fn().mockResolvedValue(freshSnapshot);

    const prisma = buildMockPrisma({
      trainer: {
        findUnique: vi.fn().mockResolvedValue({ id: TRAINER_ID }),
      },
      trainerBriefingSnapshot: {
        findUnique: vi.fn().mockResolvedValue(dirtySnapshot),
        upsert,
        updateMany: vi.fn(),
      },
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await getBriefing(prisma, USER_ID);

    expect(upsert).toHaveBeenCalledOnce();
    expect(result.activeStudents).toBe(7);
  });

  it('recomputes when no snapshot exists', async () => {
    const newSnapshot = {
      activeStudents: 0,
      returningThisWeek: 0,
      stagnantProgress: 0,
      inactiveStudents: 0,
      overallAdherence: '0.00',
      adherenceDeltaPp: '0.00',
      computedAt: new Date('2026-05-15T22:00:00.000Z'),
      isDirty: false,
    };

    const upsert = vi.fn().mockResolvedValue(newSnapshot);

    const prisma = buildMockPrisma({
      trainer: {
        findUnique: vi.fn().mockResolvedValue({ id: TRAINER_ID }),
      },
      trainerBriefingSnapshot: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert,
        updateMany: vi.fn(),
      },
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await getBriefing(prisma, USER_ID);

    expect(upsert).toHaveBeenCalledOnce();
    expect(result.activeStudents).toBe(0);
  });
});

// ─── refreshAllBriefings ─────────────────────────────────────────────────────

describe('refreshAllBriefings', () => {
  const SNAPSHOT = {
    activeStudents: 0,
    returningThisWeek: 0,
    stagnantProgress: 0,
    inactiveStudents: 0,
    overallAdherence: '0.00',
    adherenceDeltaPp: '0.00',
    computedAt: new Date('2026-05-15T22:00:00.000Z'),
    isDirty: false,
  };

  function buildCronPrisma({ trainerIds = [], upsert } = {}) {
    return buildMockPrisma({
      trainerStudent: {
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue(trainerIds.map((trainerId) => ({ trainerId }))),
      },
      trainerBriefingSnapshot: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: upsert ?? vi.fn().mockResolvedValue(SNAPSHOT),
        updateMany: vi.fn(),
      },
    });
  }

  it('collects distinct trainer ids with groupBy so the dedupe happens in SQL', async () => {
    const prisma = buildCronPrisma({ trainerIds: ['trainer-a'] });

    await refreshAllBriefings(prisma);

    // findMany+distinct would pull every roster row into memory to dedupe in JS.
    expect(prisma.trainerStudent.groupBy).toHaveBeenCalledWith({ by: ['trainerId'] });
  });

  it('refreshes one snapshot per trainer', async () => {
    const upsert = vi.fn().mockResolvedValue(SNAPSHOT);
    const prisma = buildCronPrisma({ trainerIds: ['trainer-a', 'trainer-b'], upsert });

    await refreshAllBriefings(prisma);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0].where).toEqual({ trainerId: 'trainer-a' });
    expect(upsert.mock.calls[1][0].where).toEqual({ trainerId: 'trainer-b' });
  });

  it('does nothing when no trainer has roster students', async () => {
    const upsert = vi.fn().mockResolvedValue(SNAPSHOT);
    const prisma = buildCronPrisma({ trainerIds: [], upsert });

    await refreshAllBriefings(prisma);

    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps going and logs when one trainer fails — a single failure must not abort the run', async () => {
    const boom = new Error('db exploded');
    const upsert = vi
      .fn()
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(SNAPSHOT);
    const prisma = buildCronPrisma({ trainerIds: ['trainer-a', 'trainer-b'], upsert });
    const logger = { error: vi.fn() };

    await expect(refreshAllBriefings(prisma, logger)).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toMatchObject({ err: boom, trainerId: 'trainer-a' });
  });
});
