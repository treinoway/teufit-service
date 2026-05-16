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
      ...overrides.trainerStudent,
    },
    workoutSession: {
      findMany: vi.fn().mockResolvedValue([]),
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
        findMany: vi.fn().mockResolvedValue([]),
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
        findMany: vi.fn().mockResolvedValue([]),
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
        findMany: vi.fn()
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

    // workoutSession.findMany call order (when returningThisWeek recent returns empty,
    // the gap-window call is short-circuited):
    //   1. resolveActiveStudentIds → [studentA]
    //   2. returningThisWeek recent (last 7d) → [] (short-circuits gap check)
    //   3. inactiveStudents active-in-7d → [studentA]
    const prisma = buildMockPrisma({
      workoutSession: {
        findMany: vi.fn()
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

  it('counts returningThisWeek: student had session in last 7d but NOT in 7-14d window', async () => {
    const studentA = 'student-a';

    const prisma = buildMockPrisma({
      workoutSession: {
        findMany: vi.fn()
          // resolveActiveStudentIds
          .mockResolvedValueOnce([{ userId: studentA }])
          // returningThisWeek: recent 7d → studentA present
          .mockResolvedValueOnce([{ userId: studentA }])
          // returningThisWeek: gap 7-14d → studentA NOT present (came back after gap)
          .mockResolvedValueOnce([])
          // inactiveStudents: studentA active
          .mockResolvedValueOnce([{ userId: studentA }]),
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

  it('does not count as returning when student was active in the gap window', async () => {
    const studentA = 'student-a';

    const prisma = buildMockPrisma({
      workoutSession: {
        findMany: vi.fn()
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
        findMany: vi.fn()
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
        findMany: vi.fn()
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
        findMany: vi.fn()
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

  // Dispatch `count` results by month + status so test ordering is independent
  // of Promise.all internal scheduling. Current month and prior month differ in
  // their `where.startedAt.gte`; completed vs total differ in `where.status`.
  function adherenceCountMock({ currentCompleted, currentTotal, priorCompleted, priorTotal }) {
    return vi.fn().mockImplementation(({ where }) => {
      const gte = where.startedAt?.gte;
      const currentMonthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const isCurrentMonth = gte instanceof Date && gte.getTime() >= currentMonthStart.getTime();
      const isCompleted = where.status != null;
      if (isCurrentMonth) return isCompleted ? currentCompleted : currentTotal;
      return isCompleted ? priorCompleted : priorTotal;
    });
  }

  it('computes overallAdherence: 4 completed out of 4 total → 100', async () => {
    const prisma = buildMockPrisma({
      workoutSession: {
        findMany: vi.fn().mockResolvedValue([]), // active students: 0
        count: adherenceCountMock({
          currentCompleted: 4,
          currentTotal: 4,
          priorCompleted: 0,
          priorTotal: 0,
        }),
      },
      trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    expect(result.overallAdherence).toBe(100);
  });

  it('computes adherenceDeltaPp as current minus prior month adherence', async () => {
    const prisma = buildMockPrisma({
      workoutSession: {
        findMany: vi.fn().mockResolvedValue([]),
        count: adherenceCountMock({
          currentCompleted: 8,
          currentTotal: 10, // 80%
          priorCompleted: 3,
          priorTotal: 5,    // 60%
        }),
      },
      trainerStudent: { findMany: vi.fn().mockResolvedValue([]) },
      setLog: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeBriefing(prisma, TRAINER_ID);

    // 80 - 60 = 20pp
    expect(result.overallAdherence).toBe(80);
    expect(result.adherenceDeltaPp).toBe(20);
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
        findMany: vi.fn().mockResolvedValue([]),
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
        findMany: vi.fn().mockResolvedValue([]),
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
        findMany: workoutSessionFindMany,
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
        findMany: vi.fn().mockResolvedValue([]),
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
        findMany: vi.fn().mockResolvedValue([]),
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
