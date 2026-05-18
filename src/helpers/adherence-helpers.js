/**
 * Adherence helpers shared across trainer-service, student-dashboard-service,
 * and briefing-service.
 *
 * These helpers compute "expected sessions" from a set of training protocols
 * for a given date window, following the rule:
 *   - expirationDate is INCLUSIVE end-of-day → converted to exclusive by +1 day.
 *   - Trainings without a weekDay are ignored.
 *   - The effective window is clamped to [max(startDate, windowFrom), min(expirationDate+1, windowTo)].
 *
 * Adherence is always calendar-month based (not window-relative). The canonical
 * formula is: completed / expected × 100, capped at 100, two decimal places.
 */

export const DAY_MS = 86400000;

/**
 * Map WeekDays enum string → JS Date.getUTCDay() integer.
 */
export const WEEKDAY_TO_INT = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

/**
 * Count how many times any of `weekDayInts` falls in [start, endExclusive),
 * using UTC day boundaries. `start` is snapped down to its UTC midnight before
 * iterating so a mid-day `start` still includes that day.
 *
 * Example: start=2026-05-01 (Fri), end=2026-05-17 14:00, weekDayInts={1 (Mon)}
 *   → Mondays in window: May 4, 11 → 2.
 *
 * @param {Date} start
 * @param {Date} endExclusive
 * @param {Set<number>} weekDayInts - JS getUTCDay() values (0=Sun … 6=Sat)
 * @returns {number}
 */
export function countWeekdayOccurrences(start, endExclusive, weekDayInts) {
  if (start >= endExclusive) return 0;
  if (weekDayInts.size === 0) return 0;
  const startMidnight = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endMs = endExclusive.getTime();
  let count = 0;
  for (const dow of weekDayInts) {
    const startDow = startMidnight.getUTCDay();
    const offset = (dow - startDow + 7) % 7;
    const firstMs = startMidnight.getTime() + offset * DAY_MS;
    if (firstMs >= endMs) continue;
    const span = endMs - firstMs;
    count += Math.floor((span - 1) / (7 * DAY_MS)) + 1;
  }
  return count;
}

/**
 * Compute the total number of expected sessions across all protocols for a
 * given window, following the canonical adherence formula used by all services.
 *
 * Each protocol contributes one expected session per occurrence of its
 * trainings' weekDays within the clamped overlap of the protocol and the window.
 *
 * @param {object} params
 * @param {Array<{startDate: Date, expirationDate: Date|null, trainings: Array<{weekDay: string}>}>} params.protocols
 * @param {Date} params.windowFrom - inclusive lower bound
 * @param {Date} params.windowTo - exclusive upper bound
 * @returns {number}
 */
export function computeExpectedSessions({ protocols, windowFrom, windowTo }) {
  let expected = 0;

  for (const proto of protocols) {
    if (proto.trainings.length === 0) continue;

    const effectiveStart = proto.startDate > windowFrom ? proto.startDate : windowFrom;
    // expirationDate is inclusive — convert to exclusive bound by adding a day.
    const expirationExclusive = proto.expirationDate
      ? new Date(proto.expirationDate.getTime() + DAY_MS)
      : null;
    const effectiveEnd =
      expirationExclusive && expirationExclusive < windowTo ? expirationExclusive : windowTo;

    const weekDayInts = new Set(
      proto.trainings
        .map((t) => WEEKDAY_TO_INT[t.weekDay])
        .filter((n) => n !== undefined),
    );

    expected += countWeekdayOccurrences(effectiveStart, effectiveEnd, weekDayInts);
  }

  return expected;
}

/**
 * Compute monthly adherence for a single student.
 *
 * Issues two Prisma queries (active protocols + completed session count) for
 * the requested calendar month and aggregates the results in JS.
 *
 * Use this function only for single-student contexts (e.g., the per-student
 * dashboard). For roster-level adherence, use the batched pattern in
 * listStudents to avoid N+1 queries.
 *
 * @param {object} params
 * @param {import('@prisma/client').PrismaClient} params.prisma - Injected Prisma client
 * @param {string} params.studentId - The student's user ID
 * @param {number} params.year - UTC full year (e.g. 2026)
 * @param {number} params.month - UTC 0-indexed month (0 = January … 11 = December)
 * @param {Date} [params.now] - Current timestamp; defaults to `new Date()`. Pass a
 *   pre-captured value so all month calls in a single request share the same instant.
 *
 * @returns {Promise<{
 *   adherence: number | null,
 *   completed: number | null,
 *   expected: number | null,
 *   monthStart: Date,
 * }>}
 *   - adherence: 0–100 (two decimals), null when no active protocol or expected = 0
 *   - completed: completed sessions in [monthStart, nextMonthStart), null when expected = 0
 *   - expected: expected sessions in [monthStart, min(now, nextMonthStart)), null when expected = 0
 *   - monthStart: UTC start of the month window (Date)
 */
export async function computeStudentMonthlyAdherence({ prisma, studentId, year, month, now = new Date() }) {
  const monthStart = new Date(Date.UTC(year, month, 1));
  const nextMonthStart = new Date(Date.UTC(year, month + 1, 1));

  // For the expected count we cap the window at now so future weekdays
  // inside a current month don't inflate the denominator. For past months
  // the window always covers the full month (now > nextMonthStart).
  const adherenceWindowTo = nextMonthStart < now ? nextMonthStart : now;

  const [protocols, completedGroup] = await Promise.all([
    prisma.trainingProtocol.findMany({
      where: {
        assigneeId: studentId,
        status: 'active',
        deletedAt: null,
        startDate: { lt: adherenceWindowTo },
        OR: [
          { expirationDate: null },
          { expirationDate: { gte: monthStart } },
        ],
      },
      select: {
        startDate: true,
        expirationDate: true,
        trainings: {
          where: { deletedAt: null, weekDay: { not: null } },
          select: { weekDay: true },
        },
      },
    }),
    prisma.workoutSession.aggregate({
      where: {
        userId: studentId,
        status: 'completed',
        deletedAt: null,
        // Use adherenceWindowTo (not nextMonthStart) so the completed count
        // is bounded by the same upper limit used for computeExpectedSessions.
        // For past months adherenceWindowTo === nextMonthStart (full month).
        // For the current month adherenceWindowTo === now, matching listStudents.
        startedAt: { gte: monthStart, lt: adherenceWindowTo },
      },
      _count: { _all: true },
    }),
  ]);

  const expected = computeExpectedSessions({
    protocols,
    windowFrom: monthStart,
    windowTo: adherenceWindowTo,
  });

  const completed = completedGroup._count._all;

  if (expected === 0) {
    return { adherence: null, completed: null, expected: null, monthStart };
  }

  const adherence = Math.round(Math.min(completed / expected, 1) * 100 * 100) / 100;
  return { adherence, completed, expected, monthStart };
}
