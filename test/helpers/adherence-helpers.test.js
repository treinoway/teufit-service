import { describe, it, expect, vi } from 'vitest';
import {
  DAY_MS,
  WEEKDAY_TO_INT,
  countWeekdayOccurrences,
  computeExpectedSessions,
  computeStudentMonthlyAdherence,
} from '../../src/helpers/adherence-helpers.js';

// ─── countWeekdayOccurrences ──────────────────────────────────────────────────

describe('countWeekdayOccurrences', () => {
  it('returns 0 when start >= endExclusive', () => {
    const d = new Date('2026-05-01T00:00:00Z');
    expect(countWeekdayOccurrences(d, d, new Set([1]))).toBe(0);
  });

  it('returns 0 when weekDayInts set is empty', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-05-08T00:00:00Z');
    expect(countWeekdayOccurrences(start, end, new Set())).toBe(0);
  });

  it('counts a single weekday occurring once in a 7-day window', () => {
    // May 4 2026 is Monday (WEEKDAY_TO_INT.monday = 1)
    const start = new Date(Date.UTC(2026, 4, 1)); // Fri
    const end = new Date(Date.UTC(2026, 4, 8));   // Fri — exactly 7 days
    // Mondays in window: May 4 only (May 8 excluded)
    expect(countWeekdayOccurrences(start, end, new Set([WEEKDAY_TO_INT.monday]))).toBe(1);
  });

  it('counts a single weekday occurring twice in a 14-day window', () => {
    const start = new Date(Date.UTC(2026, 4, 1)); // Fri
    const end = new Date(Date.UTC(2026, 4, 15));  // Fri — 14 days
    // Mondays: May 4, May 11
    expect(countWeekdayOccurrences(start, end, new Set([WEEKDAY_TO_INT.monday]))).toBe(2);
  });

  it('counts all 7 weekdays across a 7-day window as 7', () => {
    const start = new Date(Date.UTC(2026, 4, 1)); // Fri
    const end = new Date(Date.UTC(2026, 4, 8));   // Fri (exclusive)
    const allDays = new Set(Object.values(WEEKDAY_TO_INT));
    expect(countWeekdayOccurrences(start, end, allDays)).toBe(7);
  });

  it('counts all 7 weekdays across a 15-day window as 15', () => {
    // May 1..15 inclusive → May 1 to May 16 exclusive
    const start = new Date(Date.UTC(2026, 4, 1));
    const end = new Date(Date.UTC(2026, 4, 16));
    const allDays = new Set(Object.values(WEEKDAY_TO_INT));
    expect(countWeekdayOccurrences(start, end, allDays)).toBe(15);
  });

  it('snaps mid-day start to UTC midnight so the start day is included', () => {
    // May 4 2026 is Monday — start at 14:00 UTC snaps to midnight May 4.
    // end = May 11 14:00. Mondays in [May 4 00:00, May 11 14:00): May 4 and May 11 both qualify.
    const start = new Date(Date.UTC(2026, 4, 4, 14, 0, 0)); // Mon 14:00
    const end = new Date(Date.UTC(2026, 4, 11, 14, 0, 0));   // next Mon 14:00
    expect(countWeekdayOccurrences(start, end, new Set([WEEKDAY_TO_INT.monday]))).toBe(2);
  });

  it('does not count endExclusive itself even when it falls on the target weekday', () => {
    // May 11 is Monday — end is exclusive so it should NOT be counted
    const start = new Date(Date.UTC(2026, 4, 1));
    const end = new Date(Date.UTC(2026, 4, 11)); // Mon, exclusive
    // Only May 4 should be counted, not May 11
    expect(countWeekdayOccurrences(start, end, new Set([WEEKDAY_TO_INT.monday]))).toBe(1);
  });

  it('handles multiple weekdays in the same set', () => {
    // Mon + Wed in May 1–15 window (14 days, exclusive end May 15)
    // Mondays: May 4, 11 → 2; Wednesdays: May 6, 13 → 2 → total 4
    const start = new Date(Date.UTC(2026, 4, 1));
    const end = new Date(Date.UTC(2026, 4, 15));
    expect(countWeekdayOccurrences(start, end, new Set([
      WEEKDAY_TO_INT.monday,
      WEEKDAY_TO_INT.wednesday,
    ]))).toBe(4);
  });

  it('WEEKDAY_TO_INT maps all 7 day strings to unique integers 0–6', () => {
    const values = Object.values(WEEKDAY_TO_INT);
    expect(new Set(values).size).toBe(7);
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(6);
  });

  it('DAY_MS is exactly 86400000', () => {
    expect(DAY_MS).toBe(86400000);
  });
});

// ─── computeExpectedSessions ──────────────────────────────────────────────────

describe('computeExpectedSessions', () => {
  const WINDOW_FROM = new Date(Date.UTC(2026, 4, 1));  // May 1
  const WINDOW_TO   = new Date(Date.UTC(2026, 4, 16)); // May 16 (exclusive) — 15 days

  it('returns 0 for an empty protocols array', () => {
    expect(computeExpectedSessions({ protocols: [], windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(0);
  });

  it('returns 0 when all protocols have no trainings', () => {
    const protocols = [
      { startDate: new Date(Date.UTC(2026, 0, 1)), expirationDate: null, trainings: [] },
    ];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(0);
  });

  it('counts a single protocol with one weekday across a 15-day window', () => {
    // Mondays in May 1–15: May 4, 11 → 2
    const protocols = [{
      startDate: new Date(Date.UTC(2026, 0, 1)),
      expirationDate: null,
      trainings: [{ weekDay: 'monday' }],
    }];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(2);
  });

  it('clamps the window lower bound to protocol.startDate when startDate > windowFrom', () => {
    // Protocol starts May 5 — only Mon May 11 falls in window (not May 4)
    const protocols = [{
      startDate: new Date(Date.UTC(2026, 4, 5)),
      expirationDate: null,
      trainings: [{ weekDay: 'monday' }],
    }];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(1);
  });

  it('treats expirationDate as inclusive and clips effectively at expirationDate+1d', () => {
    // expirationDate = May 4 (Monday, inclusive) → exclusive end = May 5
    // Only May 4 Monday qualifies (May 11 is beyond May 5 exclusive)
    const protocols = [{
      startDate: new Date(Date.UTC(2026, 0, 1)),
      expirationDate: new Date(Date.UTC(2026, 4, 4)), // May 4
      trainings: [{ weekDay: 'monday' }],
    }];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(1);
  });

  it('returns 0 when expirationDate is before windowFrom', () => {
    // Protocol expired before window begins
    const protocols = [{
      startDate: new Date(Date.UTC(2026, 0, 1)),
      expirationDate: new Date(Date.UTC(2026, 3, 30)), // Apr 30, before May 1
      trainings: [{ weekDay: 'monday' }],
    }];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(0);
  });

  it('returns 0 when protocol.startDate is after windowTo', () => {
    const protocols = [{
      startDate: new Date(Date.UTC(2026, 4, 20)), // after window end
      expirationDate: null,
      trainings: [{ weekDay: 'monday' }],
    }];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(0);
  });

  it('aggregates expected sessions across multiple protocols', () => {
    // Protocol A: Mon in May 1–15 → 2
    // Protocol B: Wed in May 1–15 → 2 (Wed May 6, 13)
    // Total: 4
    const protocols = [
      {
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [{ weekDay: 'monday' }],
      },
      {
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [{ weekDay: 'wednesday' }],
      },
    ];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(4);
  });

  it('ignores trainings with undefined weekDay (not in WEEKDAY_TO_INT map)', () => {
    // A training with weekDay: null would be filtered at the query level, but
    // computeExpectedSessions also handles it gracefully via .filter(n => n !== undefined)
    const protocols = [{
      startDate: new Date(Date.UTC(2026, 0, 1)),
      expirationDate: null,
      trainings: [{ weekDay: 'monday' }, { weekDay: 'NOT_A_DAY' }],
    }];
    // Only 'monday' is valid — 2 Mondays in window
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(2);
  });

  it('handles a protocol with multiple trainings on different weekdays', () => {
    // WINDOW_TO = May 16 (exclusive). Mon + Fri in May 1–15 (inclusive).
    // Mondays: May 4, 11 → 2; Fridays: May 1, 8, 15 → 3 (May 15 < May 16 exclusive end)
    // Total: 5
    const protocols = [{
      startDate: new Date(Date.UTC(2026, 0, 1)),
      expirationDate: null,
      trainings: [{ weekDay: 'monday' }, { weekDay: 'friday' }],
    }];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(5);
  });

  it('counts 15 expected sessions when protocol has all 7 days and window is 15 days', () => {
    const protocols = [{
      startDate: new Date(Date.UTC(2026, 0, 1)),
      expirationDate: null,
      trainings: [
        { weekDay: 'monday' }, { weekDay: 'tuesday' }, { weekDay: 'wednesday' },
        { weekDay: 'thursday' }, { weekDay: 'friday' }, { weekDay: 'saturday' }, { weekDay: 'sunday' },
      ],
    }];
    expect(computeExpectedSessions({ protocols, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).toBe(15);
  });
});

// ─── computeStudentMonthlyAdherence ──────────────────────────────────────────

describe('computeStudentMonthlyAdherence', () => {
  const STUDENT_ID = 'student-1';

  // Build a minimal Prisma mock with the two methods the helper needs.
  function makePrisma({ protocols = [], completedCount = 0 } = {}) {
    return {
      trainingProtocol: {
        findMany: vi.fn().mockResolvedValue(protocols),
      },
      workoutSession: {
        aggregate: vi.fn().mockResolvedValue({ _count: { _all: completedCount } }),
      },
    };
  }

  // ── No active protocol ────────────────────────────────────────────────────

  it('returns { adherence: null, completed: null, expected: null } when there are no active protocols', async () => {
    const prisma = makePrisma({ protocols: [], completedCount: 3 });

    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2026, month: 4, // May
      now: new Date(Date.UTC(2026, 4, 15, 12, 0, 0)),
    });

    expect(result.adherence).toBeNull();
    expect(result.completed).toBeNull();
    expect(result.expected).toBeNull();
    expect(result.monthStart).toEqual(new Date(Date.UTC(2026, 4, 1)));
  });

  it('returns adherence: null when protocol has no trainings with weekDay (expected = 0)', async () => {
    const prisma = makePrisma({
      protocols: [{
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [], // no weekDay trainings → expected = 0
      }],
      completedCount: 5,
    });

    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2026, month: 4,
      now: new Date(Date.UTC(2026, 4, 15, 12, 0, 0)),
    });

    expect(result.adherence).toBeNull();
    expect(result.completed).toBeNull();
    expect(result.expected).toBeNull();
  });

  // ── Current month mid-month state ─────────────────────────────────────────

  it('computes correct expected and completed for a current month mid-month snapshot', async () => {
    // now = May 15 noon UTC (Thursday). Month window: May 1 → May 15 noon.
    // Protocol trains Mon+Wed. Mondays in [May 1, May 15): May 5, 12 → 2.
    // Wednesdays in [May 1, May 15): May 7, 14 → 2. Total expected = 4.
    const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0)); // May 15 noon
    const prisma = makePrisma({
      protocols: [{
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [{ weekDay: 'monday' }, { weekDay: 'wednesday' }],
      }],
      completedCount: 3,
    });

    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2026, month: 4, now,
    });

    expect(result.expected).toBe(4);
    expect(result.completed).toBe(3);
    expect(result.adherence).toBe(75);
    expect(result.monthStart).toEqual(new Date(Date.UTC(2026, 4, 1)));
  });

  // ── Previous month (full window) ──────────────────────────────────────────

  it('for a past month, window covers the full month (nextMonthStart < now, so windowTo = nextMonthStart)', async () => {
    // now = May 15 UTC. Previous month = April (month=3).
    // April window: Apr 1 → May 1 (exclusive). Full month, no capping.
    // Protocol trains every Friday. Fridays in April 2026: Apr 3, 10, 17, 24 → 4.
    const now = new Date(Date.UTC(2026, 4, 15, 0, 0, 0)); // May 15
    const prisma = makePrisma({
      protocols: [{
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [{ weekDay: 'friday' }],
      }],
      completedCount: 4,
    });

    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2026, month: 3, now, // April
    });

    expect(result.expected).toBe(4);
    expect(result.completed).toBe(4);
    expect(result.adherence).toBe(100);
    expect(result.monthStart).toEqual(new Date(Date.UTC(2026, 3, 1)));
  });

  // ── Year boundary ──────────────────────────────────────────────────────────

  it('handles January correctly — previous month is December of the prior year', async () => {
    // This test exercises the year-rollover path in the caller, not the helper
    // itself. The helper simply receives year=2025, month=11 (December).
    // December 2025 window: Dec 1 → Jan 1 2026. Monday Dec 2026-1: Dec 1, 8, 15, 22, 29 → 5.
    const now = new Date(Date.UTC(2026, 0, 15, 0, 0, 0)); // Jan 15 2026
    const prisma = makePrisma({
      protocols: [{
        startDate: new Date(Date.UTC(2025, 0, 1)),
        expirationDate: null,
        trainings: [{ weekDay: 'monday' }],
      }],
      completedCount: 5,
    });

    // December 2025 (month=11 in 0-indexed). Jan 1 2026 < Jan 15 2026 so full month used.
    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2025, month: 11, now, // December 2025
    });

    // Mondays in December 2025: Dec 1, 8, 15, 22, 29 → 5
    expect(result.expected).toBe(5);
    expect(result.completed).toBe(5);
    expect(result.adherence).toBe(100);
    expect(result.monthStart).toEqual(new Date(Date.UTC(2025, 11, 1)));
  });

  // ── Multiple protocols ─────────────────────────────────────────────────────

  it('aggregates expected sessions correctly across multiple active protocols', async () => {
    // now = May 15 noon UTC. adherenceWindowTo = May 15 noon (current month).
    // Protocol A: Mon → Mondays in [May 1, May 15 noon): May 5, 12 → 2
    // Protocol B: Fri → Fridays in [May 1, May 15 noon): May 1, 8, 15 → 3
    //   (May 15 midnight < May 15 noon, so May 15 is included)
    // Total expected = 5. Completed = 5 → 100%.
    const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
    const prisma = makePrisma({
      protocols: [
        {
          startDate: new Date(Date.UTC(2026, 0, 1)),
          expirationDate: null,
          trainings: [{ weekDay: 'monday' }],
        },
        {
          startDate: new Date(Date.UTC(2026, 0, 1)),
          expirationDate: null,
          trainings: [{ weekDay: 'friday' }],
        },
      ],
      completedCount: 5,
    });

    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2026, month: 4, now,
    });

    expect(result.expected).toBe(5);
    expect(result.completed).toBe(5);
    expect(result.adherence).toBe(100);
  });

  // ── Cap at 100 ─────────────────────────────────────────────────────────────

  it('caps adherence at 100 when completed exceeds expected', async () => {
    // 1 Monday expected, 99 completed → cap at 100.
    const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
    const prisma = makePrisma({
      protocols: [{
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [{ weekDay: 'monday' }],
      }],
      completedCount: 99,
    });

    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2026, month: 4, now,
    });

    expect(result.adherence).toBe(100);
  });

  // ── Rounding ───────────────────────────────────────────────────────────────

  it('rounds adherence to 2 decimal places', async () => {
    // 3 expected Mondays (May 5, 12, 19), 1 completed → 33.33...% → 33.33
    const now = new Date(Date.UTC(2026, 4, 22, 0, 0, 0)); // May 22 — after 3rd Monday
    const prisma = makePrisma({
      protocols: [{
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [{ weekDay: 'monday' }],
      }],
      completedCount: 1,
    });

    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2026, month: 4, now,
    });

    expect(result.adherence).toBe(33.33);
  });

  // ── now param propagation ─────────────────────────────────────────────────

  it('uses the provided now param instead of creating a new Date() internally', async () => {
    // Passing a fixed `now` means the windowTo is deterministic.
    // Use now = exact start of June (nextMonthStart for May = Jun 1), so
    // adherenceWindowTo = nextMonthStart (exactly on boundary → nextMonthStart < now is false
    // when now === nextMonthStart, so windowTo = now = Jun 1 = full May).
    const now = new Date(Date.UTC(2026, 5, 1, 0, 0, 0)); // Jun 1 — just after May ends
    const prisma = makePrisma({
      protocols: [{
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [{ weekDay: 'friday' }],
      }],
      completedCount: 5,
    });

    // Fridays in May 2026: May 1, 8, 15, 22, 29 → 5
    const result = await computeStudentMonthlyAdherence({
      prisma, studentId: STUDENT_ID, year: 2026, month: 4, now,
    });

    expect(result.expected).toBe(5);
    expect(result.adherence).toBe(100);
  });

  // ── workoutSession.aggregate query correctness ────────────────────────────

  it('passes correct studentId and adherenceWindowTo (not nextMonthStart) to workoutSession.aggregate', async () => {
    // now = May 15 noon → adherenceWindowTo = now (current month not yet ended).
    // The aggregate MUST use lt: now, not lt: nextMonthStart, so completed
    // and expected are bounded by the same instant.
    const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
    const prisma = makePrisma({ protocols: [], completedCount: 0 });

    await computeStudentMonthlyAdherence({
      prisma, studentId: 'specific-student-id', year: 2026, month: 4, now,
    });

    expect(prisma.workoutSession.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'specific-student-id',
          status: 'completed',
          deletedAt: null,
          startedAt: {
            gte: new Date(Date.UTC(2026, 4, 1)),
            lt: now, // adherenceWindowTo = now for current month
          },
        }),
      }),
    );
  });

  it('uses nextMonthStart (not now) as the aggregate upper bound for a fully past month', async () => {
    // now = May 15. April is fully past (nextMonthStart=May 1 < now).
    // adherenceWindowTo = May 1 = nextMonthStart — not now.
    const now = new Date(Date.UTC(2026, 4, 15, 0, 0, 0));
    const prisma = makePrisma({ protocols: [], completedCount: 0 });

    await computeStudentMonthlyAdherence({
      prisma, studentId: 'past-month-student', year: 2026, month: 3, now, // April
    });

    expect(prisma.workoutSession.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startedAt: {
            gte: new Date(Date.UTC(2026, 3, 1)), // Apr 1
            lt: new Date(Date.UTC(2026, 4, 1)),  // May 1 = nextMonthStart (not May 15)
          },
        }),
      }),
    );
  });
});
