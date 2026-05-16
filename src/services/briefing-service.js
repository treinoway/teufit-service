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
 */
function startOfCurrentMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Return the first moment (UTC) of the previous calendar month.
 */
function startOfPreviousMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

/**
 * Return the first moment (UTC) of the current calendar month
 * (i.e., the exclusive upper bound of the previous month).
 */
function endOfPreviousMonth() {
  return startOfCurrentMonth();
}

// ─── KPI computation ─────────────────────────────────────────────────────────

/**
 * Return the distinct set of studentIds who were active in the last
 * ACTIVE_WINDOW_DAYS days. Used by other KPI functions to scope their queries.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @returns {Promise<string[]>}
 */
async function resolveActiveStudentIds(prisma, trainerId) {
  const since = daysAgo(BriefingThresholds.ACTIVE_WINDOW_DAYS);

  const rows = await prisma.workoutSession.findMany({
    where: {
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { gte: since },
      user: {
        trainers: {
          some: { trainerId },
        },
      },
    },
    select: { userId: true },
    distinct: ['userId'],
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
  const recentRows = await prisma.workoutSession.findMany({
    where: {
      userId: { in: activeStudentIds },
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { gte: sevenDaysAgo },
    },
    select: { userId: true },
    distinct: ['userId'],
  });

  const recentStudentIds = recentRows.map((r) => r.userId);
  if (recentStudentIds.length === 0) return 0;

  // Among those, find students who had NO session between 14d and 7d ago
  const hadSessionInGap = await prisma.workoutSession.findMany({
    where: {
      userId: { in: recentStudentIds },
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    },
    select: { userId: true },
    distinct: ['userId'],
  });

  const studentIdsActiveInGap = new Set(hadSessionInGap.map((r) => r.userId));
  const returning = recentStudentIds.filter((id) => !studentIdsActiveInGap.has(id));

  return returning.length;
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
      // If no pre-window data, treat the in-window load as a PR (first time loading)
      if (preWindowMax === null) return true;
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
async function computeInactiveStudents(prisma, trainerId) {
  const since = daysAgo(BriefingThresholds.INACTIVE_NO_SESSION_DAYS);

  // All students on roster
  const rosterRows = await prisma.trainerStudent.findMany({
    where: { trainerId },
    select: { studentId: true },
  });

  if (rosterRows.length === 0) return 0;

  const rosterStudentIds = rosterRows.map((r) => r.studentId);

  // Students who DID complete a session in the window
  const activeSessions = await prisma.workoutSession.findMany({
    where: {
      userId: { in: rosterStudentIds },
      status: WorkoutSessionStatus.COMPLETED,
      deletedAt: null,
      startedAt: { gte: since },
    },
    select: { userId: true },
    distinct: ['userId'],
  });

  const activeSet = new Set(activeSessions.map((r) => r.userId));
  const inactiveCount = rosterStudentIds.filter((id) => !activeSet.has(id)).length;

  return inactiveCount;
}

/**
 * Compute adherence rate for a given calendar month window.
 * adherence = (completed sessions in window) / (all non-deleted sessions in window) * 100
 *
 * WorkoutSession has no scheduledDate field. We use startedAt as the proxy for
 * the "session date" for both numerator and denominator.
 *
 * Returns 0 if denominator is 0 (no sessions in month).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @param {Date} monthStart - inclusive lower bound (UTC)
 * @param {Date} monthEnd - exclusive upper bound (UTC, start of next month)
 * @returns {Promise<number>} 0–100 adherence percentage
 */
async function computeMonthlyAdherence(prisma, trainerId, monthStart, monthEnd) {
  const baseWhere = {
    deletedAt: null,
    startedAt: { gte: monthStart, lt: monthEnd },
    user: {
      trainers: {
        some: { trainerId },
      },
    },
  };

  const [completedCount, totalCount] = await Promise.all([
    prisma.workoutSession.count({
      where: {
        ...baseWhere,
        status: WorkoutSessionStatus.COMPLETED,
      },
    }),
    prisma.workoutSession.count({
      where: baseWhere,
    }),
  ]);

  if (totalCount === 0) return 0;
  return Math.round((completedCount / totalCount) * 100 * 100) / 100;
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
  const currentMonthStart = startOfCurrentMonth();
  const previousMonthStart = startOfPreviousMonth();
  const previousMonthEnd = endOfPreviousMonth();

  // activeStudentIds is shared across multiple KPIs — resolve first
  const activeStudentIds = await resolveActiveStudentIds(prisma, trainerId);

  const [
    returningThisWeek,
    stagnantProgress,
    inactiveStudents,
    currentAdherence,
    previousAdherence,
  ] = await Promise.all([
    computeReturningThisWeek(prisma, trainerId, activeStudentIds),
    computeStagnantProgress(prisma, activeStudentIds),
    computeInactiveStudents(prisma, trainerId),
    computeMonthlyAdherence(prisma, trainerId, currentMonthStart, new Date()),
    computeMonthlyAdherence(prisma, trainerId, previousMonthStart, previousMonthEnd),
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
 * Get the briefing for the authenticated trainer user.
 * Resolves the trainer record from the user ID, then reads the snapshot.
 * Recomputes synchronously if the snapshot is missing or dirty.
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

  const snapshot = await prisma.trainerBriefingSnapshot.findUnique({
    where: { trainerId: trainer.id },
  });

  if (!snapshot || snapshot.isDirty) {
    return refreshBriefing(prisma, trainer.id);
  }

  return formatSnapshot(snapshot);
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
  const trainerRows = await prisma.trainerStudent.findMany({
    select: { trainerId: true },
    distinct: ['trainerId'],
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
