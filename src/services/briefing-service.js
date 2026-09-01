/**
 * Trainer Briefing Service
 *
 * Computes KPI snapshots for the "SEUS ALUNOS AGORA" card in the trainer's
 * AI assistant view. Uses a snapshot table with a dirty-flag invalidation
 * strategy: reads are always fast (return snapshot), writes flip isDirty=true,
 * and the next read recomputes synchronously when dirty or missing.
 *
 * A daily cron at 22:00 UTC pre-warms all snapshots.
 *
 * Dependencies are injected as arguments — never import prisma singleton here.
 */

import { BriefingThresholds } from '../constants/briefing.js';
import { WorkoutSessionStatus } from '../constants/training.js';
import { NotFoundAppError } from '../errors/app-error.js';
import {
  DAY_MS,
  WEEKDAY_TO_INT,
  countWeekdayOccurrences,
  computeExpectedSessions,
} from '../helpers/adherence-helpers.js';

// Re-export so existing consumers (trainer-service) don't break.
export { DAY_MS, WEEKDAY_TO_INT, countWeekdayOccurrences };

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Return a Date that is `days` days before `from` (UTC midnight boundary).
 */
function daysAgo(days, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/**
 * Return the first moment (UTC) of the current calendar month.
 * Exported so other services (e.g. trainer-dashboard-service) that need the
 * same "current month" window share this exact boundary rather than
 * reimplementing it.
 *
 * `from` is injectable — same pattern as daysAgo() above — so a caller that
 * already captured `now` can pass it through and guarantee `monthStart` is
 * derived from the exact same instant. Without this, two independent
 * `new Date()` calls a few milliseconds apart can straddle a month boundary
 * (e.g. called at 23:59:59.999 on the last day of the month): one call sees
 * February, the other still sees January, producing an inverted/empty
 * `[monthStart, now)` range. Defaults to `new Date()` so existing callers
 * (computeBriefing below) are unaffected.
 *
 * @param {Date} [from] - instant to derive the month boundary from
 */
export function startOfCurrentMonth(from = new Date()) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
}

/**
 * Return the first moment (UTC) of the previous calendar month.
 */
function startOfPreviousMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

/**
 * Return the exclusive upper bound of the prior-month adherence window,
 * aligned to the same day-of-month + time-of-day as `now`. This makes
 * current-vs-prior month comparisons fair: dia 17 do mês compara dias 1-17
 * em ambos, não 1-17 vs 1-30. Caps to last day of prior month when the
 * current day-of-month doesn't exist there (e.g., Mar 31 vs Feb).
 */
function priorMonthAlignedEnd(now = new Date()) {
  const year = now.getUTCFullYear();
  const monthIdx = now.getUTCMonth() - 1;
  const day = now.getUTCDate();
  // Last day of prior month: day 0 of current month.
  const lastDayOfPriorMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const cappedDay = Math.min(day, lastDayOfPriorMonth);
  return new Date(Date.UTC(
    year,
    monthIdx,
    cappedDay,
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  ));
}

// ─── KPI computation ─────────────────────────────────────────────────────────

/**
 * Resolve the trainer's active roster (TrainerStudent rows with
 * activeOnPlan=true). Called ONCE per briefing computation and shared across
 * KPIs that need it (active, inactive, adherence) — avoids 3 redundant scans
 * of trainer_students per refresh.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @returns {Promise<string[]>} active student userIds
 */
async function resolveActiveRosterIds(prisma, trainerId) {
  const rows = await prisma.trainerStudent.findMany({
    where: { trainerId, activeOnPlan: true },
    select: { studentId: true },
  });
  return rows.map((r) => r.studentId);
}

/**
 * From an active roster, return the subset that completed at least one
 * WorkoutSession in the last ACTIVE_WINDOW_DAYS days.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} rosterIds
 * @returns {Promise<string[]>}
 */
async function resolveActiveStudentIds(prisma, rosterIds) {
  if (rosterIds.length === 0) return [];
  const since = daysAgo(BriefingThresholds.ACTIVE_WINDOW_DAYS);

  // groupBy, not findMany+distinct: Prisma's `distinct` is applied in memory —
  // it fetches every matching session row and dedupes in JS. groupBy compiles to
  // SQL GROUP BY, so the database returns at most one row per student.
  const rows = await prisma.workoutSession.groupBy({
    by: ['userId'],
    where: {
      userId: { in: rosterIds },
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { gte: since },
    },
  });

  return rows.map((r) => r.userId);
}

/**
 * Count active students who came back after a gap:
 *   - Had a completed session in the last 7 days (RETURNING_GAP_DAYS)
 *   - AND had no completed session in the 7 days before that window
 *     (i.e., between 14d ago and 7d ago).
 *
 * This captures "came back after a gap" without full session history traversal.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @param {string[]} activeStudentIds
 * @returns {Promise<number>}
 */
async function computeReturningThisWeek(prisma, trainerId, activeStudentIds) {
  if (activeStudentIds.length === 0) return 0;

  const now = new Date();
  const sevenDaysAgo = daysAgo(BriefingThresholds.RETURNING_GAP_DAYS, now);
  const fourteenDaysAgo = daysAgo(BriefingThresholds.RETURNING_GAP_DAYS * 2, now);

  // Students with a completed session in the last 7 days
  const recentRows = await prisma.workoutSession.groupBy({
    by: ['userId'],
    where: {
      userId: { in: activeStudentIds },
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { gte: sevenDaysAgo },
    },
  });

  const recentStudentIds = recentRows.map((r) => r.userId);
  if (recentStudentIds.length === 0) return 0;

  // Among those, find students who had NO session between 14d and 7d ago
  const hadSessionInGap = await prisma.workoutSession.groupBy({
    by: ['userId'],
    where: {
      userId: { in: recentStudentIds },
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    },
  });

  const studentIdsActiveInGap = new Set(hadSessionInGap.map((r) => r.userId));
  const candidateIds = recentStudentIds.filter((id) => !studentIdsActiveInGap.has(id));
  if (candidateIds.length === 0) return 0;

  // "Returning" requires prior history. A student's very first session ever
  // is not "voltou após gap" — it's onboarding. Require at least one completed
  // session older than the gap window (i.e., before 14d ago).
  // Unbounded window (no lower bound on startedAt) — this reads the student's
  // entire session history. groupBy keeps the dedupe in SQL so the result is one
  // row per student instead of every session ever recorded.
  const hadPreGapHistory = await prisma.workoutSession.groupBy({
    by: ['userId'],
    where: {
      userId: { in: candidateIds },
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { lt: fourteenDaysAgo },
    },
  });

  return hadPreGapHistory.length;
}

/**
 * Count active students with no new personal-record load in the last
 * STAGNANT_NO_PR_DAYS days.
 *
 * Heuristic (accepted by user as a TODO-refinable starting point):
 *   For each active student, look at ExerciseLogs (via SetLogs) in the
 *   trailing STAGNANT_NO_PR_DAYS window vs. before that window, grouped by
 *   exercise. A student is NOT stagnant if, for any exercise, max(load) in
 *   the window strictly exceeds max(load) before the window for the same
 *   exercise. Otherwise the student is stagnant.
 *
 * Students with no SetLog history at all are counted as stagnant.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} activeStudentIds
 * @returns {Promise<number>}
 */
async function computeStagnantProgress(prisma, activeStudentIds) {
  if (activeStudentIds.length === 0) return 0;

  const windowStart = daysAgo(BriefingThresholds.STAGNANT_NO_PR_DAYS);
  // Cap historical lookback so the in-memory aggregation doesn't unbounded-grow
  // for trainers with years of history. STAGNANT_HISTORY_DAYS is large enough
  // that a stale PR from beyond this window won't realistically gate a "new PR"
  // signal — if a student hasn't hit a load in 180 days, anything inside the
  // 14-day window is effectively a new PR for stagnancy purposes.
  const historyStart = daysAgo(BriefingThresholds.STAGNANT_HISTORY_DAYS);

  // Fetch set logs with load for each active student — only exercises that have
  // load-bearing sets (load IS NOT NULL). We need both in-window and pre-window
  // rows to compare. Bucket by workoutSession.startedAt (the session date), not
  // setLog.createdAt — corrections made later shouldn't shift the bucket.
  const setLogs = await prisma.setLog.findMany({
    where: {
      load: { not: null },
      // Failed attempts (completed=false) don't represent a real PR — exclude.
      completed: true,
      exerciseLog: {
        workoutSession: {
          userId: { in: activeStudentIds },
          deletedAt: null,
          startedAt: { gte: historyStart },
        },
      },
    },
    select: {
      load: true,
      exerciseLog: {
        select: {
          exerciseId: true,
          workoutSession: { select: { userId: true, startedAt: true } },
        },
      },
    },
  });

  if (setLogs.length === 0) {
    // No load data at all — every active student is stagnant
    return activeStudentIds.length;
  }

  // Build a map: studentId → exerciseId → { inWindowMax, preWindowMax }
  const studentExerciseLoads = new Map();

  for (const setLog of setLogs) {
    const session = setLog.exerciseLog.workoutSession;
    const studentId = session.userId;
    const exerciseId = setLog.exerciseLog.exerciseId;
    const load = Number(setLog.load);
    // Bucket by session date, not log creation date — late corrections stay in
    // the bucket of the day the set actually happened.
    const isInWindow = session.startedAt >= windowStart;

    if (!studentExerciseLoads.has(studentId)) {
      studentExerciseLoads.set(studentId, new Map());
    }
    const exerciseMap = studentExerciseLoads.get(studentId);

    if (!exerciseMap.has(exerciseId)) {
      exerciseMap.set(exerciseId, { inWindowMax: null, preWindowMax: null });
    }
    const entry = exerciseMap.get(exerciseId);

    if (isInWindow) {
      entry.inWindowMax = entry.inWindowMax === null ? load : Math.max(entry.inWindowMax, load);
    } else {
      entry.preWindowMax = entry.preWindowMax === null ? load : Math.max(entry.preWindowMax, load);
    }
  }

  let stagnantCount = 0;

  for (const studentId of activeStudentIds) {
    const exerciseMap = studentExerciseLoads.get(studentId);

    if (!exerciseMap) {
      // No load data for this student at all — stagnant
      stagnantCount++;
      continue;
    }

    const hasNewPr = Array.from(exerciseMap.values()).some(({ inWindowMax, preWindowMax }) => {
      if (inWindowMax === null) return false;
      // No pre-window history for this exercise = no signal. Don't infer a PR
      // from a first occurrence — wait until there's a baseline to compare.
      if (preWindowMax === null) return false;
      return inWindowMax > preWindowMax;
    });

    if (!hasNewPr) {
      stagnantCount++;
    }
  }

  return stagnantCount;
}

/**
 * Count students in this trainer's roster (no archived/deleted links in schema,
 * so all TrainerStudent rows count) who have zero completed WorkoutSessions in
 * the last INACTIVE_NO_SESSION_DAYS days. Includes students who never had a session.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @returns {Promise<number>}
 */
async function computeInactiveStudents(prisma, rosterIds) {
  if (rosterIds.length === 0) return 0;

  const since = daysAgo(BriefingThresholds.INACTIVE_NO_SESSION_DAYS);

  // Students who DID complete a session in the window
  const activeSessions = await prisma.workoutSession.groupBy({
    by: ['userId'],
    where: {
      userId: { in: rosterIds },
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { gte: since },
    },
  });

  const activeSet = new Set(activeSessions.map((r) => r.userId));
  return rosterIds.filter((id) => !activeSet.has(id)).length;
}

/**
 * Compute adherence rate for a given calendar month window.
 *
 *   adherence = completed_sessions / expected_sessions × 100
 *
 * Expected sessions are derived from each active student's active
 * TrainingProtocols. For each protocol overlapping the window, each
 * Training row (non-deleted, weekDay set) generates one expected session
 * per occurrence of that weekDay inside the overlap.
 *
 * - Protocol `expirationDate` is treated as INCLUSIVE end-of-day.
 * - Trainings without a weekDay are ignored (no expectation).
 * - Result is capped at 100% — a student who logs extra sessions does not
 *   inflate the adherence score, since the card semantics is "did the
 *   planned sessions happen".
 * - Returns 0 (not NaN) when expected_sessions is 0.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @param {Date} monthStart - inclusive lower bound (UTC)
 * @param {Date} monthEnd - exclusive upper bound (UTC)
 * @returns {Promise<number>} 0–100 adherence percentage
 */
async function computeMonthlyAdherence(prisma, rosterIds, monthStart, monthEnd) {
  if (rosterIds.length === 0) return 0;

  // Pull expected sessions (protocols) and completed count in parallel — they
  // don't depend on each other.
  const [protocols, completed] = await Promise.all([
    prisma.trainingProtocol.findMany({
      where: {
        assigneeId: { in: rosterIds },
        status: 'active',
        deletedAt: null,
        startDate: { lt: monthEnd },
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
    prisma.workoutSession.count({
      where: {
        userId: { in: rosterIds },
        status: WorkoutSessionStatus.COMPLETED,
        deletedAt: null,
        startedAt: { gte: monthStart, lt: monthEnd },
      },
    }),
  ]);

  const expected = computeExpectedSessions({ protocols, windowFrom: monthStart, windowTo: monthEnd });

  if (expected === 0) return 0;

  const pct = (completed / expected) * 100;
  return Math.round(Math.min(pct, 100) * 100) / 100;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute all 6 KPIs for a trainer without persisting to the database.
 * All queries run in parallel where possible.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId - Trainer.id (not userId)
 * @returns {Promise<{
 *   activeStudents: number,
 *   returningThisWeek: number,
 *   stagnantProgress: number,
 *   inactiveStudents: number,
 *   overallAdherence: number,
 *   adherenceDeltaPp: number,
 * }>}
 */
export async function computeBriefing(prisma, trainerId) {
  const now = new Date();
  const currentMonthStart = startOfCurrentMonth();
  const previousMonthStart = startOfPreviousMonth();
  // Align prior-month upper bound to the same day-of-month + time as `now`
  // so the delta compares equivalent windows (dia 1..N vs dia 1..N).
  const previousMonthAlignedEnd = priorMonthAlignedEnd(now);

  // Resolve active roster ONCE — shared by active, inactive, adherence (×2).
  // Then resolve activeStudentIds (subset who trained in last 30d) — shared
  // by returning + stagnant.
  const rosterIds = await resolveActiveRosterIds(prisma, trainerId);
  const activeStudentIds = await resolveActiveStudentIds(prisma, rosterIds);

  const [
    returningThisWeek,
    stagnantProgress,
    inactiveStudents,
    currentAdherence,
    previousAdherence,
  ] = await Promise.all([
    computeReturningThisWeek(prisma, trainerId, activeStudentIds),
    computeStagnantProgress(prisma, activeStudentIds),
    computeInactiveStudents(prisma, rosterIds),
    computeMonthlyAdherence(prisma, rosterIds, currentMonthStart, now),
    computeMonthlyAdherence(prisma, rosterIds, previousMonthStart, previousMonthAlignedEnd),
  ]);

  const adherenceDeltaPp = Math.round((currentAdherence - previousAdherence) * 100) / 100;

  return {
    activeStudents: activeStudentIds.length,
    returningThisWeek,
    stagnantProgress,
    inactiveStudents,
    overallAdherence: currentAdherence,
    adherenceDeltaPp,
  };
}

/**
 * Format the KPI snapshot for API responses.
 * Converts Decimal fields to fixed-precision strings and timestamps to ISO.
 *
 * @param {object} snapshot - TrainerBriefingSnapshot row
 * @returns {object}
 */
function formatSnapshot(snapshot) {
  return {
    activeStudents: snapshot.activeStudents,
    returningThisWeek: snapshot.returningThisWeek,
    stagnantProgress: snapshot.stagnantProgress,
    inactiveStudents: snapshot.inactiveStudents,
    overallAdherence: Number(snapshot.overallAdherence).toFixed(2),
    adherenceDeltaPp: Number(snapshot.adherenceDeltaPp).toFixed(2),
    computedAt: snapshot.computedAt.toISOString(),
  };
}

/**
 * Compute the briefing KPIs, persist the snapshot, and return the formatted DTO.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId - Trainer.id
 * @returns {Promise<object>}
 */
export async function refreshBriefing(prisma, trainerId) {
  const kpis = await computeBriefing(prisma, trainerId);
  const computedAt = new Date();

  const snapshot = await prisma.trainerBriefingSnapshot.upsert({
    where: { trainerId },
    create: {
      trainerId,
      activeStudents: kpis.activeStudents,
      returningThisWeek: kpis.returningThisWeek,
      stagnantProgress: kpis.stagnantProgress,
      inactiveStudents: kpis.inactiveStudents,
      overallAdherence: kpis.overallAdherence,
      adherenceDeltaPp: kpis.adherenceDeltaPp,
      computedAt,
      isDirty: false,
    },
    update: {
      activeStudents: kpis.activeStudents,
      returningThisWeek: kpis.returningThisWeek,
      stagnantProgress: kpis.stagnantProgress,
      inactiveStudents: kpis.inactiveStudents,
      overallAdherence: kpis.overallAdherence,
      adherenceDeltaPp: kpis.adherenceDeltaPp,
      computedAt,
      isDirty: false,
    },
  });

  return formatSnapshot(snapshot);
}

/**
 * Get the briefing snapshot for a trainer already resolved by Trainer.id.
 * Recomputes synchronously if the snapshot is missing or dirty.
 *
 * Extracted from getBriefing() so callers that already resolved the trainer
 * (e.g. trainer-dashboard-service) don't pay for a duplicate
 * `trainer.findUnique` lookup.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId - Trainer.id (not userId)
 * @returns {Promise<object>}
 */
export async function getBriefingByTrainerId(prisma, trainerId) {
  const snapshot = await prisma.trainerBriefingSnapshot.findUnique({
    where: { trainerId },
  });

  if (!snapshot || snapshot.isDirty) {
    return refreshBriefing(prisma, trainerId);
  }

  return formatSnapshot(snapshot);
}

/**
 * Get the briefing for the authenticated trainer user.
 * Resolves the trainer record from the user ID, then delegates to
 * getBriefingByTrainerId for the snapshot lookup.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId - User.id of the authenticated trainer
 * @returns {Promise<object>}
 */
export async function getBriefing(prisma, userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new NotFoundAppError({
      message: 'Trainer profile not found',
      messageCode: 'trainer.notFound',
    });
  }

  return getBriefingByTrainerId(prisma, trainer.id);
}

/**
 * Mark the briefing snapshot as dirty for a given trainer.
 * Uses updateMany so it silently no-ops when the snapshot row doesn't exist yet.
 *
 * IMPORTANT: Call this AFTER any enclosing transaction commits, not inside it.
 * Mixing a tx client and the outer prisma client in the same call path can
 * cause deadlocks or leak dirty-flag updates on tx rollback.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId - Trainer.id (not userId)
 * @returns {Promise<void>}
 */
export async function markBriefingDirty(prisma, trainerId) {
  await prisma.trainerBriefingSnapshot.updateMany({
    where: { trainerId },
    data: { isDirty: true },
  });
}

/**
 * Refresh all trainers who have at least one roster student.
 * Called by the daily cron to capture passage-of-time changes
 * (students becoming inactive without any write triggering dirty-flag).
 *
 * Processes trainers sequentially to avoid hammering the database with
 * parallel heavy aggregation queries.
 *
 * TODO(scaling): if running multiple instances, gate this with a
 * leader-election or DB advisory lock so only one instance runs the cron.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ error: Function, info?: Function }} [logger] - optional structured logger
 * @returns {Promise<void>}
 */
export async function refreshAllBriefings(prisma, logger) {
  // Find distinct trainerIds that have at least one roster student
  // groupBy compiles to SQL GROUP BY. findMany+distinct would read the entire
  // trainer_students table into memory just to extract the distinct trainer ids.
  const trainerRows = await prisma.trainerStudent.groupBy({
    by: ['trainerId'],
  });

  const trainerIds = trainerRows.map((r) => r.trainerId);

  for (const trainerId of trainerIds) {
    try {
      await refreshBriefing(prisma, trainerId);
    } catch (err) {
      // Log and continue — never let one trainer failure abort the entire run
      if (logger?.error) {
        logger.error({ err, trainerId }, '[cron:briefing] trainer refresh failed');
      } else {
        console.error(`[cron:briefing] Failed to refresh trainer ${trainerId}:`, err);
      }
    }
  }
}
