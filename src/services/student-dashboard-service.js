import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import { DASHBOARD_DEFAULTS, DashboardMessageCode } from '../constants/training.js';
import { resolveTrainerStudent } from './workout-session-service.js';
import { formatDateOnly, addDaysMs } from '../helpers/date-helpers.js';
import { computeStudentMonthlyAdherence } from '../helpers/adherence-helpers.js';

const LOAD_HISTORY_MAX_SESSIONS = 6;

// ─── Window helpers ───────────────────────────────────────────────────────────

/**
 * Resolve query window from optional dateFrom/dateTo strings.
 * Defaults to last WINDOW_DAYS_DEFAULT days. Throws AppError when range is
 * inverted or exceeds WINDOW_DAYS_MAX.
 */
function resolveWindow({ dateFrom, dateTo }) {
  const toDate = dateTo ? new Date(dateTo) : new Date();
  const fromDate = dateFrom
    ? new Date(dateFrom)
    : addDaysMs(toDate, -DASHBOARD_DEFAULTS.WINDOW_DAYS_DEFAULT);

  if (fromDate > toDate) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_DATE_RANGE',
      messageCode: DashboardMessageCode.INVALID_DATE_RANGE,
      message: 'Invalid date range (dateFrom must be before dateTo)',
    });
  }

  // addDaysMs uses 86400000 ms/day internally; replicate for the boundary check
  const maxWindowMs = DASHBOARD_DEFAULTS.WINDOW_DAYS_MAX * 86400000;
  if (toDate.getTime() - fromDate.getTime() > maxWindowMs) {
    throw new AppError({
      httpStatus: 400,
      error: 'WINDOW_TOO_LARGE',
      messageCode: DashboardMessageCode.WINDOW_TOO_LARGE,
      message: `Date window exceeds the ${DASHBOARD_DEFAULTS.WINDOW_DAYS_MAX}-day maximum`,
    });
  }

  return { from: fromDate, to: toDate };
}

// ─── Numeric helpers ──────────────────────────────────────────────────────────

function round2(value) {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value) * 100) / 100;
}

function round1(value) {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value) * 10) / 10;
}

// ─── Streak helper ────────────────────────────────────────────────────────────

/**
 * Compute the longest run of consecutive calendar dates in a sorted array of
 * unique YYYY-MM-DD strings. Returns null for an empty input.
 *
 * @param {string[]} sortedUniqueDates - ascending order, YYYY-MM-DD
 * @returns {number|null}
 */
function computeMaxStreak(sortedUniqueDates) {
  if (sortedUniqueDates.length === 0) return null;

  let maxStreak = 1;
  let currentStreak = 1;

  for (let i = 1; i < sortedUniqueDates.length; i++) {
    const prevMs = new Date(sortedUniqueDates[i - 1]).getTime();
    const currMs = new Date(sortedUniqueDates[i]).getTime();
    const diffDays = Math.round((currMs - prevMs) / 86400000);

    if (diffDays === 1) {
      currentStreak += 1;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
    } else {
      currentStreak = 1;
    }
  }

  return maxStreak;
}

// ─── Raw SQL progression query ────────────────────────────────────────────────

/**
 * Fetch per-session exercise performance rows using raw SQL.
 *
 * Why raw SQL: a Prisma nested include would fetch every SetLog row individually
 * and compute aggregates in JS — easily thousands of rows per request. This query
 * returns pre-aggregated rows grouped by (exercise_id, workout_session_id).
 * Soft-delete filters are explicit because Prisma's auto-filter does NOT apply to $queryRaw.
 *
 * @param {string} studentUserId
 * @param {Date} from
 * @param {Date} to
 * @param {boolean} includeDurationOnly - when false, excludes exercises where has_load=false
 * @param {string|null} filterExerciseId - when set, restricts to a single exercise
 */
async function fetchProgressionRows(studentUserId, from, to, includeDurationOnly, filterExerciseId = null, includeAbandoned = false) {
  const rows = await prisma.$queryRaw`
    SELECT
      e.id AS exercise_id,
      e.name AS exercise_name,
      e.has_load,
      e.prescription_mode,
      e.training_id,
      t.name AS training_name,
      ws.id AS session_id,
      ws.started_at,
      ws.status,
      MAX(sl.load) FILTER (WHERE sl.completed = TRUE) AS max_load,
      AVG(sl.load) FILTER (WHERE sl.completed = TRUE) AS avg_load,
      SUM(sl.load * sl.repetitions) FILTER (WHERE sl.completed = TRUE) AS total_volume,
      COUNT(*) FILTER (WHERE sl.completed = TRUE) AS completed_sets,
      SUM(sl.repetitions) FILTER (WHERE sl.completed = TRUE) AS total_reps,
      AVG(sl.rpe) FILTER (WHERE sl.rpe IS NOT NULL AND sl.completed = TRUE) AS avg_rpe
    FROM workout_sessions ws
    JOIN exercise_logs el ON el.workout_session_id = ws.id
    JOIN exercises e ON e.id = el.exercise_id AND e.deleted_at IS NULL
    JOIN trainings t ON t.id = e.training_id
    JOIN set_logs sl ON sl.exercise_log_id = el.id
    WHERE ws.user_id = ${studentUserId}::uuid
      AND ws.deleted_at IS NULL
      AND ws.started_at >= ${from}
      AND ws.started_at <= ${to}
      AND (${includeDurationOnly} = TRUE OR e.has_load = TRUE)
      AND (${filterExerciseId}::uuid IS NULL OR e.id = ${filterExerciseId}::uuid)
      AND (${includeAbandoned} = TRUE OR ws.status <> 'abandoned')
    GROUP BY e.id, e.name, e.has_load, e.prescription_mode, e.training_id, t.name,
             ws.id, ws.started_at, ws.status
    ORDER BY e.id, ws.started_at DESC
  `;

  return rows;
}

/**
 * Bucket raw aggregation rows by exercise_id and enrich with session-level metadata.
 */
function bucketProgressionRows(rawRows) {
  const exerciseMap = new Map();

  for (const row of rawRows) {
    const exerciseId = row.exercise_id;

    if (!exerciseMap.has(exerciseId)) {
      exerciseMap.set(exerciseId, {
        exerciseId,
        exerciseName: row.exercise_name,
        hasLoad: row.has_load,
        prescriptionMode: row.prescription_mode,
        trainingId: row.training_id,
        trainingName: row.training_name,
        sessions: [],
      });
    }

    exerciseMap.get(exerciseId).sessions.push({
      sessionId: row.session_id,
      date: row.started_at,
      status: row.status,
      maxLoad: round2(row.max_load),
      avgLoad: round2(row.avg_load),
      totalVolume: round2(row.total_volume),
      completedSets: Number(row.completed_sets ?? 0),
      totalReps: Number(row.total_reps ?? 0),
      avgRpe: row.avg_rpe !== null ? round2(row.avg_rpe) : null,
    });
  }

  return exerciseMap;
}

// ─── Sorting helpers ──────────────────────────────────────────────────────────

/**
 * Sort comparator: descending by lastPerformedAt ISO string.
 * Pre-converts to timestamps before comparing to avoid allocating Date objects per swap.
 */
function byLastPerformedAtDesc(a, b) {
  const tA = a.lastPerformedAt ? new Date(a.lastPerformedAt).getTime() : 0;
  const tB = b.lastPerformedAt ? new Date(b.lastPerformedAt).getTime() : 0;
  return tB - tA;
}

// ─── Trend helpers ────────────────────────────────────────────────────────────

function computeExerciseTrend(sessions) {
  if (sessions.length < 2) {
    return { maxLoadDelta: null, maxLoadDeltaPct: null };
  }

  const latestMaxLoad = sessions[0].maxLoad;
  const oldestMaxLoad = sessions[sessions.length - 1].maxLoad;

  if (latestMaxLoad === null || oldestMaxLoad === null) {
    return { maxLoadDelta: null, maxLoadDeltaPct: null };
  }

  const delta = round2(latestMaxLoad - oldestMaxLoad);

  if (oldestMaxLoad === 0) {
    return { maxLoadDelta: delta, maxLoadDeltaPct: null };
  }

  return {
    maxLoadDelta: delta,
    maxLoadDeltaPct: round2((delta / oldestMaxLoad) * 100),
  };
}

// ─── Public service functions ─────────────────────────────────────────────────

/**
 * Get aggregated dashboard summary for a student.
 * Includes session counts by status, completionRate, lastSessionAt, and currentProtocol.
 *
 * Adherence fields (adherence, adherenceCompleted, adherenceExpected, adherenceMonth,
 * previousAdherence, previousAdherenceMonth) are ALWAYS the current and previous calendar
 * months, regardless of the dateFrom/dateTo period picker. This intentionally decouples
 * adherence from the dashboard's date window, matching the listStudents roster view.
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {object} options - { dateFrom, dateTo, timeZone }
 */
export async function getDashboardSummary(trainerUserId, studentId, { dateFrom, dateTo, timeZone = 'America/Sao_Paulo' } = {}) {
  await resolveTrainerStudent(trainerUserId, studentId);

  const dateWindow = resolveWindow({ dateFrom, dateTo });

  const where = {
    userId: studentId,
    deletedAt: null,
    startedAt: { gte: dateWindow.from, lte: dateWindow.to },
  };

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth();

  // Previous month with correct year rollover (e.g. Jan → previous = Dec of prior year).
  const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
  const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;

  const [groupedCounts, lastSession, activeProtocols, activeDateRows, currentAdherence, previousAdherence] =
    await Promise.all([
      prisma.workoutSession.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      prisma.workoutSession.findFirst({
        where,
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      // Protocols for the currentProtocol display card only — weekdays not needed here.
      prisma.trainingProtocol.findMany({
        where: {
          assigneeId: studentId,
          status: 'active',
          deletedAt: null,
          startDate: { lt: dateWindow.to },
          OR: [
            { expirationDate: null },
            { expirationDate: { gte: dateWindow.from } },
          ],
        },
        orderBy: { startDate: 'desc' },
        select: {
          id: true,
          name: true,
          startDate: true,
          expirationDate: true,
        },
      }),
      prisma.$queryRaw`
        SELECT DISTINCT TO_CHAR(DATE(started_at AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS session_date
        FROM workout_sessions
        WHERE user_id = ${studentId}::uuid
          AND deleted_at IS NULL
          AND started_at >= ${dateWindow.from}
          AND started_at <= ${dateWindow.to}
        ORDER BY session_date ASC
      `,
      // Adherence is always the current calendar month — independent of dateWindow.
      // Pass `now` so both calls share the same instant (avoids sub-second skew).
      computeStudentMonthlyAdherence({ prisma, studentId, year: currentYear, month: currentMonth, now }),
      computeStudentMonthlyAdherence({ prisma, studentId, year: prevYear, month: prevMonth, now }),
    ]);

  const sessionCounts = {
    completed: 0,
    in_progress: 0,
    abandoned: 0,
  };

  for (const group of groupedCounts) {
    if (group.status in sessionCounts) {
      sessionCounts[group.status] = group._count._all;
    }
  }

  const totalSessions = sessionCounts.completed + sessionCounts.in_progress + sessionCounts.abandoned;
  const completionDenominator = sessionCounts.completed + sessionCounts.abandoned;
  const completionRate =
    completionDenominator > 0
      ? round2(sessionCounts.completed / completionDenominator)
      : null;

  const activeDates = activeDateRows.map((row) => row.session_date);
  const maxStreakDays = computeMaxStreak(activeDates);

  const windowDays = (dateWindow.to.getTime() - dateWindow.from.getTime()) / 86400000;
  const sessionsPerWeek = windowDays > 0 ? round1(totalSessions / (windowDays / 7)) : null;

  const lastSessionAt = lastSession?.startedAt ?? null;
  const daysSinceLastSession =
    lastSessionAt !== null
      ? Math.floor((Date.now() - lastSessionAt.getTime()) / 86400000)
      : null;

  // The most recent protocol is first (orderBy: startDate desc) — use it for
  // the currentProtocol display card.
  const latestProtocol = activeProtocols[0] ?? null;

  return {
    window: { from: dateWindow.from.toISOString(), to: dateWindow.to.toISOString() },
    sessionCounts,
    totalSessions,
    completionRate,
    adherence: currentAdherence.adherence,
    adherenceCompleted: currentAdherence.completed,
    adherenceExpected: currentAdherence.expected,
    adherenceMonth: formatDateOnly(currentAdherence.monthStart),
    previousAdherence: previousAdherence.adherence,
    previousAdherenceMonth: formatDateOnly(previousAdherence.monthStart),
    lastSessionAt: lastSessionAt?.toISOString() ?? null,
    currentProtocol: latestProtocol
      ? {
          id: latestProtocol.id,
          name: latestProtocol.name,
          startDate: formatDateOnly(latestProtocol.startDate),
          expirationDate: formatDateOnly(latestProtocol.expirationDate),
        }
      : null,
    maxStreakDays,
    sessionsPerWeek,
    daysSinceLastSession,
  };
}

/**
 * Get the most recent workout sessions for a student (trainer view).
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {object} options - { dateFrom, dateTo, limit }
 */
export async function getRecentSessions(trainerUserId, studentId, { dateFrom, dateTo, limit } = {}) {
  await resolveTrainerStudent(trainerUserId, studentId);

  const dateWindow = resolveWindow({ dateFrom, dateTo });
  const take = Math.min(
    DASHBOARD_DEFAULTS.RECENT_SESSIONS_MAX,
    Math.max(1, parseInt(limit ?? DASHBOARD_DEFAULTS.RECENT_SESSIONS_DEFAULT, 10)),
  );

  const sessions = await prisma.workoutSession.findMany({
    where: {
      userId: studentId,
      deletedAt: null,
      startedAt: { gte: dateWindow.from, lte: dateWindow.to },
    },
    orderBy: { startedAt: 'desc' },
    take,
    include: {
      training: { select: { id: true, name: true } },
    },
  });

  const sessionIds = sessions.map((s) => s.id);
  const rpeBySession = {};

  if (sessionIds.length > 0) {
    const rpeRows = await prisma.$queryRaw`
      SELECT ws.id AS session_id,
             AVG(sl.rpe) FILTER (WHERE sl.rpe IS NOT NULL AND sl.completed = TRUE) AS avg_rpe
      FROM workout_sessions ws
      JOIN exercise_logs el ON el.workout_session_id = ws.id
      JOIN set_logs sl ON sl.exercise_log_id = el.id
      WHERE ws.id = ANY(${sessionIds}::uuid[])
      GROUP BY ws.id
    `;

    for (const row of rpeRows) {
      rpeBySession[row.session_id] = row.avg_rpe !== null ? round1(row.avg_rpe) : null;
    }
  }

  const data = sessions.map((session) => ({
    id: session.id,
    trainingId: session.trainingId,
    trainingName: session.training?.name ?? null,
    status: session.status,
    startedAt: session.startedAt.toISOString(),
    finishedAt: session.finishedAt?.toISOString() ?? null,
    durationSeconds: session.durationSeconds ?? null,
    avgRpe: rpeBySession[session.id] ?? null,
    noteText: session.notes?.trim() || null,
  }));

  return {
    window: { from: dateWindow.from.toISOString(), to: dateWindow.to.toISOString() },
    data,
  };
}

/**
 * Get per-exercise progression aggregates for a student over a date window.
 *
 * Returns one entry per exerciseId with latest session aggregates and load trend.
 * Duration-only exercises are excluded by default (opt in via includeDurationOnly=true).
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {object} options - { dateFrom, dateTo, limit, includeDurationOnly }
 */
export async function getExerciseProgression(trainerUserId, studentId, { dateFrom, dateTo, limit, includeDurationOnly } = {}) {
  await resolveTrainerStudent(trainerUserId, studentId);

  const dateWindow = resolveWindow({ dateFrom, dateTo });
  const take = Math.min(
    DASHBOARD_DEFAULTS.EXERCISES_LIST_MAX,
    Math.max(1, parseInt(limit ?? DASHBOARD_DEFAULTS.EXERCISES_LIST_DEFAULT, 10)),
  );
  const includeAll = includeDurationOnly === true || includeDurationOnly === 'true';

  const rawRows = await fetchProgressionRows(studentId, dateWindow.from, dateWindow.to, includeAll, null);
  const exerciseMap = bucketProgressionRows(rawRows);

  const result = [];
  for (const [, exerciseData] of exerciseMap) {
    const { sessions } = exerciseData;
    const latest = sessions[0] ?? null;
    const trend = computeExerciseTrend(sessions);

    const loadHistory = sessions
      .slice(0, LOAD_HISTORY_MAX_SESSIONS)
      .map((s) => s.maxLoad ?? null);

    result.push({
      exerciseId: exerciseData.exerciseId,
      exerciseName: exerciseData.exerciseName,
      hasLoad: exerciseData.hasLoad,
      prescriptionMode: exerciseData.prescriptionMode,
      trainingId: exerciseData.trainingId,
      trainingName: exerciseData.trainingName,
      sessionCount: sessions.length,
      lastPerformedAt: latest?.date?.toISOString() ?? null,
      latest: latest
        ? {
            date: latest.date.toISOString(),
            maxLoad: latest.maxLoad,
            avgLoad: latest.avgLoad,
            totalVolume: latest.totalVolume,
            completedSets: latest.completedSets,
            totalReps: latest.totalReps,
            avgRpe: latest.avgRpe,
          }
        : null,
      trend,
      loadHistory,
    });
  }

  result.sort(byLastPerformedAtDesc);

  return {
    window: { from: dateWindow.from.toISOString(), to: dateWindow.to.toISOString() },
    data: result.slice(0, take),
  };
}

/**
 * Get per-session progression detail for a single exercise.
 *
 * A non-existent or unlogged exerciseId returns empty sessions array (not 404)
 * because the exercise may legitimately have no logs in the window.
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {string} exerciseId
 * @param {object} options - { dateFrom, dateTo, sessionLimit }
 */
export async function getExerciseProgressionDetail(trainerUserId, studentId, exerciseId, { dateFrom, dateTo, sessionLimit, includeAbandoned = false } = {}) {
  await resolveTrainerStudent(trainerUserId, studentId);

  const dateWindow = resolveWindow({ dateFrom, dateTo });
  const take = Math.min(
    DASHBOARD_DEFAULTS.SESSIONS_PER_EXERCISE_MAX,
    Math.max(1, parseInt(sessionLimit ?? DASHBOARD_DEFAULTS.SESSIONS_PER_EXERCISE_DEFAULT, 10)),
  );

  // Fetch exercise metadata and aggregated rows in parallel — independent queries
  const [exercise, rawRows] = await Promise.all([
    prisma.exercise.findFirst({
      where: { id: exerciseId, deletedAt: null },
      select: {
        id: true,
        name: true,
        hasLoad: true,
        prescriptionMode: true,
        trainingId: true,
        training: { select: { name: true } },
      },
    }),
    fetchProgressionRows(studentId, dateWindow.from, dateWindow.to, true, exerciseId, includeAbandoned),
  ]);

  const exerciseMap = bucketProgressionRows(rawRows);
  const exerciseData = exerciseMap.get(exerciseId);
  const sessions = exerciseData ? exerciseData.sessions.slice(0, take) : [];

  const sessionIds = sessions.map((s) => s.sessionId);
  const setLogsBySession = {};

  if (sessionIds.length > 0) {
    const exerciseLogs = await prisma.exerciseLog.findMany({
      where: {
        exerciseId,
        workoutSessionId: { in: sessionIds },
      },
      include: {
        setLogs: { orderBy: { setNumber: 'asc' } },
      },
    });

    for (const log of exerciseLogs) {
      setLogsBySession[log.workoutSessionId] = log.setLogs.map((sl) => ({
        setNumber: sl.setNumber,
        repetitions: sl.repetitions ?? null,
        load: round2(sl.load),
        rpe: sl.rpe ?? null,
        completed: sl.completed,
      }));
    }
  }

  const sessionDetails = sessions.map((s) => ({
    ...s,
    date: s.date.toISOString(),
    sets: setLogsBySession[s.sessionId] ?? [],
  }));

  return {
    exercise: exercise
      ? {
          id: exercise.id,
          name: exercise.name,
          hasLoad: exercise.hasLoad,
          prescriptionMode: exercise.prescriptionMode,
          trainingId: exercise.trainingId,
          trainingName: exercise.training?.name ?? null,
        }
      : null,
    window: { from: dateWindow.from.toISOString(), to: dateWindow.to.toISOString() },
    sessions: sessionDetails,
  };
}

/**
 * Get daily activity summary for a student over a date window.
 *
 * Returns one row per calendar day in the student's timezone where the student
 * had at least one session. Days with zero sessions are omitted — the frontend
 * treats absence as "empty". Volume and set counts are aggregated from completed
 * set logs only.
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {object} options - { dateFrom, dateTo, timeZone }
 */
export async function getDailyActivity(trainerUserId, studentId, { dateFrom, dateTo, timeZone = 'America/Sao_Paulo' } = {}) {
  await resolveTrainerStudent(trainerUserId, studentId);

  const dateWindow = resolveWindow({ dateFrom, dateTo });

  const rows = await prisma.$queryRaw`
    WITH sessions_with_date AS (
      SELECT
        ws.id,
        ws.status,
        DATE(ws.started_at AT TIME ZONE ${timeZone}) AS session_date
      FROM workout_sessions ws
      WHERE ws.user_id = ${studentId}::uuid
        AND ws.deleted_at IS NULL
        AND ws.started_at >= ${dateWindow.from}
        AND ws.started_at <= ${dateWindow.to}
    )
    SELECT
      TO_CHAR(swd.session_date, 'YYYY-MM-DD') AS date,
      COUNT(DISTINCT swd.id) AS session_count,
      ARRAY_AGG(DISTINCT swd.id::text) AS session_ids,
      BOOL_OR(swd.status = 'completed') AS has_completed,
      BOOL_OR(swd.status = 'abandoned') AS has_abandoned,
      COALESCE(SUM(sl.load * sl.repetitions) FILTER (WHERE sl.completed = TRUE), 0) AS total_volume_kg,
      COUNT(*) FILTER (WHERE sl.completed = TRUE) AS completed_sets,
      COUNT(sl.id) AS total_sets
    FROM sessions_with_date swd
    LEFT JOIN exercise_logs el ON el.workout_session_id = swd.id
    LEFT JOIN set_logs sl ON sl.exercise_log_id = el.id
    GROUP BY swd.session_date
    ORDER BY swd.session_date ASC
  `;

  const resolveDayStatus = (row) => {
    const completedSets = Number(row.completed_sets);
    const totalSets = Number(row.total_sets);
    if (row.has_completed) {
      return totalSets > 0 && completedSets < totalSets ? 'partial' : 'completed';
    }
    if (row.has_abandoned) return 'abandoned';
    return 'partial';
  };

  const data = rows.map((row) => ({
    date: row.date,
    status: resolveDayStatus(row),
    sessionCount: Number(row.session_count),
    sessionIds: row.session_ids,
    volumeKg: round2(Number(row.total_volume_kg)),
    completedSets: Number(row.completed_sets),
    totalSets: Number(row.total_sets),
  }));

  return {
    window: { from: dateWindow.from.toISOString(), to: dateWindow.to.toISOString() },
    data,
  };
}

/**
 * Build a trimmed AI-friendly performance snapshot for a student.
 * Used by iArnold's get_student_performance tool — returns top N exercises
 * by lastPerformedAt to stay within token budget.
 *
 * @param {string} trainerUserId
 * @param {string} studentId
 * @param {object} options - { windowDays, includeExerciseProgression }
 */
export async function buildAiPerformanceSnapshot(trainerUserId, studentId, { windowDays = DASHBOARD_DEFAULTS.WINDOW_DAYS_DEFAULT, includeExerciseProgression = true } = {}) {
  await resolveTrainerStudent(trainerUserId, studentId);

  const to = new Date();
  const from = addDaysMs(to, -windowDays);

  const [student, groupedCounts, lastSession, currentProtocol] = await Promise.all([
    prisma.user.findUnique({
      where: { id: studentId },
      select: { firstName: true, lastName: true },
    }),
    prisma.workoutSession.groupBy({
      by: ['status'],
      where: { userId: studentId, deletedAt: null, startedAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    prisma.workoutSession.findFirst({
      where: { userId: studentId, deletedAt: null, startedAt: { gte: from, lte: to } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
    prisma.trainingProtocol.findFirst({
      where: { assigneeId: studentId, status: 'active', deletedAt: null },
      orderBy: { startDate: 'desc' },
      select: { id: true, name: true },
    }),
  ]);

  const sessionCounts = { completed: 0, in_progress: 0, abandoned: 0 };
  for (const group of groupedCounts) {
    if (group.status in sessionCounts) {
      sessionCounts[group.status] = group._count._all;
    }
  }

  const totalSessions = sessionCounts.completed + sessionCounts.in_progress + sessionCounts.abandoned;
  const completionDenominator = sessionCounts.completed + sessionCounts.abandoned;
  const completionRate =
    completionDenominator > 0
      ? round2(sessionCounts.completed / completionDenominator)
      : null;

  let topExercises = [];

  if (includeExerciseProgression) {
    const rawRows = await fetchProgressionRows(studentId, from, to, false, null);
    const exerciseMap = bucketProgressionRows(rawRows);

    const exercises = [];
    for (const [, exerciseData] of exerciseMap) {
      const { sessions } = exerciseData;
      const trend = computeExerciseTrend(sessions);
      const latest = sessions[0] ?? null;

      exercises.push({
        exerciseId: exerciseData.exerciseId,
        name: exerciseData.exerciseName,
        hasLoad: exerciseData.hasLoad,
        sessionCount: sessions.length,
        lastPerformedAt: latest?.date?.toISOString() ?? null,
        latestMaxLoad: latest?.maxLoad ?? null,
        latestAvgLoad: latest?.avgLoad ?? null,
        latestTotalVolume: latest?.totalVolume ?? null,
        maxLoadDelta: trend.maxLoadDelta,
        maxLoadDeltaPct: trend.maxLoadDeltaPct,
      });
    }

    exercises.sort(byLastPerformedAtDesc);

    topExercises = exercises.slice(0, DASHBOARD_DEFAULTS.AI_SNAPSHOT_TOP_EXERCISES);
  }

  const studentName = [student?.firstName, student?.lastName].filter(Boolean).join(' ') || 'Aluno';

  return {
    studentId,
    studentName,
    window: { from: from.toISOString(), to: to.toISOString(), days: windowDays },
    sessionCounts,
    totalSessions,
    completionRate,
    lastSessionAt: lastSession?.startedAt?.toISOString() ?? null,
    currentProtocol: currentProtocol ? { id: currentProtocol.id, name: currentProtocol.name } : null,
    topExercises,
  };
}
