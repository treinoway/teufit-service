import { ChallengeFormat } from '../constants/challenge.js';
import { SeasonStatus, WeekStatus } from '../constants/consistency-ranking.js';
import { isEligible, liveAverage, rankStandings, scoreWeek, seasonFigures } from '../helpers/consistency-math.js';
import { doneWindow, weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { getConfig, ruleForWeek } from './consistency-config-service.js';
import { pausesFor } from './consistency-pause-service.js';
import { countDone } from './consistency-progress-service.js';
import { ensureCurrentSeasonLocked } from './consistency-season-service.js';
import { materializeTargets } from './consistency-target-service.js';

const LOCK_KEY_PREFIX = 'consistency-close';
const MS_PER_WEEK = 7 * 86400000;
const NO_COUNTS = Object.freeze({ workouts: 0, cardio: 0 });
const TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10000, timeout: 120000 });

// "YYYY-MM-DD" of a @db.Date value
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Civil date of a @db.Date value
function civilOf(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Midnight-UTC Date of a civil date
function dbDateOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Civil Monday of the nth week of a season
function seasonWeekStart(season, index) {
  return civilOf(new Date(season.startWeek.getTime() + index * MS_PER_WEEK));
}

// Civil date moved by whole weeks
function addWeeks(civil, weeks) {
  return civilOf(new Date(dbDateOf(civil).getTime() + weeks * MS_PER_WEEK));
}

// Display name of a student user, the same fallback the standings use
function displayName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.username || '';
}

// Per-pillar expected and done counts stored with a result
function pillarCounts(expected, done) {
  return { workouts: { expected: expected.workouts, done: done.workouts }, cardio: { expected: expected.cardio, done: done.cardio } };
}

// Result row of one linked student: neutral when linked after Monday 00:00 or without target, paused per team/student pause
function buildResult(link, ctx) {
  const expected = ctx.targets.get(link.studentId) ?? NO_COUNTS;
  const done = ctx.done.get(link.studentId) ?? NO_COUNTS;
  const base = {
    trainerId: ctx.trainerId,
    studentId: link.studentId,
    seasonId: ctx.seasonId,
    weekStart: ctx.weekStartDate,
    pillars: pillarCounts(expected, done),
    weights: { weights: ctx.rule.weights, activePillars: ctx.rule.activePillars },
    closedAt: ctx.now,
  };
  if (link.createdAt.getTime() > ctx.startInstant.getTime()) return { ...base, status: WeekStatus.NEUTRAL, score: null };
  const pause = ctx.pauses.students.has(link.studentId) ? ctx.pauses.students.get(link.studentId) : ctx.pauses.team;
  if (pause) return { ...base, status: WeekStatus.PAUSED, score: null };
  const score = scoreWeek({ expected, done, weights: ctx.rule.weights, activePillars: ctx.rule.activePillars });
  return { ...base, status: score === null ? WeekStatus.NEUTRAL : WeekStatus.VALID, score };
}

// Standing row of one student from the stored results (most recent first) of the season
function buildStandingFigures(studentId, user, results, { season, elapsed, minPodiumWeeks }) {
  const figures = seasonFigures(results, season.id);
  return {
    studentId,
    name: displayName(user),
    eligible: isEligible({ validWeeks: figures.validWeeks, elapsedWeeks: elapsed, minPodiumWeeks }),
    average: liveAverage(figures.scores, null),
    validWeeks: figures.validWeeks,
    weeksAt100: figures.weeksAt100,
    streak: figures.streak,
  };
}

// Stored results of the students up to the closed week, most recent first, grouped by student
async function readResultsUpTo(tx, trainerId, studentIds, weekStartDate) {
  const rows = await tx.consistencyWeeklyResult.findMany({
    where: { trainerId, studentId: { in: studentIds }, weekStart: { lte: weekStartDate } },
    orderBy: { weekStart: 'desc' },
  });
  const byStudent = new Map();
  for (const row of rows) byStudent.set(row.studentId, [...(byStudent.get(row.studentId) ?? []), row]);
  return byStudent;
}

// Writes the frozen standings of the season from its stored results, including students no longer linked
async function freezeStandings(tx, season, weekStartDate, now) {
  const seasonRows = await tx.consistencyWeeklyResult.findMany({
    where: { trainerId: season.trainerId, seasonId: season.id },
    select: { studentId: true },
  });
  const studentIds = [...new Set(seasonRows.map((row) => row.studentId))];
  if (studentIds.length === 0) return;
  const [config, results, users] = await Promise.all([
    getConfig(tx, season.trainerId, now),
    readResultsUpTo(tx, season.trainerId, studentIds, weekStartDate),
    tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, firstName: true, lastName: true, username: true } }),
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  const elapsed = Math.round((weekStartDate.getTime() - season.startWeek.getTime()) / MS_PER_WEEK) + 1;
  const context = { season, elapsed, minPodiumWeeks: config.minPodiumWeeks };
  const figures = studentIds.map((id) => buildStandingFigures(id, userById.get(id), results.get(id) ?? [], context));
  const positions = new Map(rankStandings(figures.filter((row) => row.eligible)).map((row) => [row.studentId, row.position]));
  await tx.consistencySeasonStanding.createMany({
    data: figures.map((row) => ({
      seasonId: season.id,
      trainerId: season.trainerId,
      studentId: row.studentId,
      position: positions.get(row.studentId) ?? null,
      eligible: row.eligible,
      average: row.average,
      validWeeks: row.validWeeks,
      weeks100: row.weeksAt100,
      streak: row.streak,
      frozenAt: now,
    })),
    skipDuplicates: true,
  });
}

// Whether the closed week ends the season: its last week or an early close was requested (RANK-45)
function endsSeason(season, weekStartDate) {
  const lastMonday = season.startWeek.getTime() + (season.weeks - 1) * MS_PER_WEEK;
  return weekStartDate.getTime() >= lastMonday || season.closeRequestedAt !== null;
}

// Freezes the standings and marks the season closed; the next one opens through ensureCurrentSeason
async function closeSeason(tx, season, weekStartDate, now) {
  await freezeStandings(tx, season, weekStartDate, now);
  await tx.consistencySeason.update({ where: { id: season.id }, data: { status: SeasonStatus.CLOSED, closedAt: now } });
}

// Everything the result rows of a week depend on, read once per trainer and week; onlyStudentIds narrows the active links
async function loadWeekContext(tx, { trainerId, seasonId, onlyStudentIds = null }, weekStart, now) {
  const rule = await ruleForWeek(tx, trainerId, weekStart);
  const previousRule = await ruleForWeek(tx, trainerId, addWeeks(weekStart, -1));
  const links = await tx.trainerStudent.findMany({
    where: { trainerId, activeOnPlan: true, ...(onlyStudentIds ? { studentId: { in: onlyStudentIds } } : {}) },
    select: { studentId: true, createdAt: true },
  });
  const ids = links.map((link) => link.studentId);
  const [targets, done, pauses] = await Promise.all([
    materializeTargets(tx, trainerId, weekStart, ids),
    countDone(tx, trainerId, ids, doneWindow(weekStart, rule, previousRule)),
    pausesFor(tx, trainerId, [weekStart]),
  ]);
  const ctx = {
    trainerId,
    seasonId,
    rule,
    now,
    targets,
    done,
    weekStartDate: dbDateOf(weekStart),
    startInstant: weekBounds(weekStart, rule).startInstant,
    pauses: pauses.get(dateKey(dbDateOf(weekStart))),
  };
  return { links, ctx };
}

// Open weekly championship filter (not closed nor cancelled), with extra conditions
function openWeeklyChampionships(extra = {}) {
  return { format: ChallengeFormat.WEEKS, closedAt: null, cancelledAt: null, ...extra };
}

// Participants of the trainer's open weekly championships holding the Monday; null when no such championship exists
async function championshipStudentIds(tx, trainerId, mondayDate) {
  const challenges = await tx.challenge.findMany({
    where: openWeeklyChampionships({ trainerId, startDate: { lte: mondayDate }, endDate: { gte: mondayDate } }),
    select: { participants: { select: { studentId: true } } },
  });
  if (challenges.length === 0) return null;
  return [...new Set(challenges.flatMap((challenge) => challenge.participants.map((row) => row.studentId)))];
}

// Stores one result per active student in scope for the week
async function storeWeek(tx, scope, weekStart, now) {
  const { links, ctx } = await loadWeekContext(tx, scope, weekStart, now);
  const rows = links.map((link) => buildResult(link, ctx));
  await tx.consistencyWeeklyResult.createMany({ data: rows, skipDuplicates: true });
  return { rows, weekStartDate: ctx.weekStartDate };
}

// Writes the closed-week mark of the trainer's week
function markWeekClosed(tx, trainerId, weekStartDate, now, studentsCount) {
  return tx.consistencyWeekClose.create({ data: { trainerId, weekStart: weekStartDate, closedAt: now, studentsCount } });
}

// Week close without an active season: results only for the students of a weekly championship holding the week (CAMP-72)
async function closeChampionshipWeek(tx, trainerId, weekStart, now) {
  const studentIds = await championshipStudentIds(tx, trainerId, dbDateOf(weekStart));
  if (!studentIds) return null;
  const { rows, weekStartDate } = await storeWeek(tx, { trainerId, seasonId: null, onlyStudentIds: studentIds }, weekStart, now);
  await markWeekClosed(tx, trainerId, weekStartDate, now, rows.length);
  return { studentsCount: rows.length, seasonClosed: false };
}

/**
 * Closes one week of the trainer inside the caller's transaction: with an active season, stores one result per active student, freezes the season when it ends and writes the closed-week mark; without one, does the same only for the students of the weekly championships holding the week (CAMP-72).
 *
 * @param {object} tx - Prisma transaction client
 * @param {string} trainerId
 * @param {{ year: number, month: number, day: number }} weekStart - civil Monday
 * @param {Date} [now]
 * @returns {Promise<{ studentsCount: number, seasonClosed: boolean }|null>} null when the trainer has neither an active season nor a weekly championship holding the week
 */
export async function closeWeek(tx, trainerId, weekStart, now = new Date()) {
  const season = await tx.consistencySeason.findFirst({ where: { trainerId, status: SeasonStatus.ACTIVE } });
  if (!season) return closeChampionshipWeek(tx, trainerId, weekStart, now);
  const { rows, weekStartDate } = await storeWeek(tx, { trainerId, seasonId: season.id }, weekStart, now);
  const seasonClosed = endsSeason(season, weekStartDate);
  if (seasonClosed) await closeSeason(tx, season, weekStartDate, now);
  await markWeekClosed(tx, trainerId, weekStartDate, now, rows.length);
  return { studentsCount: rows.length, seasonClosed };
}

// Takes the transaction-scoped advisory lock of the (trainer, week) pair without waiting
async function tryAcquireCloseLock(tx, trainerId, weekKey) {
  const key = `${LOCK_KEY_PREFIX}:${trainerId}:${weekKey}`;
  const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
  return locked;
}

// Closes the (trainer, week) pair in its own transaction; null when another run holds the lock or already closed it
function closeWeekLocked(prisma, trainerId, weekStart, now) {
  const weekKey = dateKey(dbDateOf(weekStart));
  return prisma.$transaction(async (tx) => {
    if (!(await tryAcquireCloseLock(tx, trainerId, weekKey))) return null;
    const alreadyClosed = await tx.consistencyWeekClose.findUnique({
      where: { trainerId_weekStart: { trainerId, weekStart: dbDateOf(weekStart) } },
    });
    if (alreadyClosed) return null;
    return closeWeek(tx, trainerId, weekStart, now);
  }, TRANSACTION_OPTIONS);
}

// Weeks of the season whose close instant has passed and that have no closed-week mark, oldest first
async function findDueWeeks(prisma, season, now) {
  const marks = await prisma.consistencyWeekClose.findMany({ where: { trainerId: season.trainerId, weekStart: { gte: season.startWeek } } });
  const closed = new Set(marks.map((mark) => dateKey(mark.weekStart)));
  const due = [];
  for (let index = 0; index < season.weeks; index += 1) {
    const weekStart = seasonWeekStart(season, index);
    const rule = await ruleForWeek(prisma, season.trainerId, weekStart);
    if (weekBounds(weekStart, rule).closeInstant.getTime() > now.getTime()) break;
    if (!closed.has(dateKey(dbDateOf(weekStart)))) due.push(weekStart);
  }
  return due;
}

// Logs a successful week close with the number of students closed
function logClosed(logger, trainerId, weekKey, outcome) {
  logger.info(
    { trainerId, weekStart: weekKey, studentsCount: outcome.studentsCount, seasonClosed: outcome.seasonClosed },
    `[consistency-close] closed week ${weekKey} for trainer ${trainerId}: ${outcome.studentsCount} students`,
  );
}

// Closes the trainer's due weeks in order; a failure stops this trainer (its later weeks depend on it) and is logged
async function closeWeeksInOrder(prisma, logger, trainerId, dueWeeks, now) {
  for (const weekStart of dueWeeks) {
    const weekKey = dateKey(dbDateOf(weekStart));
    try {
      const outcome = await closeWeekLocked(prisma, trainerId, weekStart, now);
      if (outcome) logClosed(logger, trainerId, weekKey, outcome);
      if (outcome?.seasonClosed) return;
    } catch (err) {
      logger.error(
        { trainerId, weekStart: weekKey, err },
        `[consistency-close] failed to close week ${weekKey} for trainer ${trainerId}`,
      );
      return;
    }
  }
}

// Closes the due weeks of one season in order
async function closeSeasonWeeks(prisma, logger, season, now) {
  await closeWeeksInOrder(prisma, logger, season.trainerId, await findDueWeeks(prisma, season, now), now);
}

// Started open weekly championships grouped by trainer, only for trainers without an active season (CAMP-72)
async function championshipsWithoutSeason(prisma, now) {
  const challenges = await prisma.challenge.findMany({
    where: openWeeklyChampionships({ startDate: { lte: now } }),
    select: { trainerId: true, startDate: true, endDate: true },
    orderBy: [{ trainerId: 'asc' }],
  });
  if (challenges.length === 0) return new Map();
  const seasons = await prisma.consistencySeason.findMany({
    where: { status: SeasonStatus.ACTIVE, trainerId: { in: [...new Set(challenges.map((row) => row.trainerId))] } },
    select: { trainerId: true },
  });
  const withSeason = new Set(seasons.map((row) => row.trainerId));
  const byTrainer = new Map();
  for (const row of challenges.filter((challenge) => !withSeason.has(challenge.trainerId))) {
    byTrainer.set(row.trainerId, [...(byTrainer.get(row.trainerId) ?? []), row]);
  }
  return byTrainer;
}

// Mondays of the championships whose close instant has passed and that have no closed-week mark, oldest first
async function findChampionshipDueWeeks(prisma, trainerId, challenges, now) {
  const times = new Set();
  for (const challenge of challenges) {
    for (let time = challenge.startDate.getTime(); time <= challenge.endDate.getTime(); time += MS_PER_WEEK) times.add(time);
  }
  const mondays = [...times].sort((a, b) => a - b).map((time) => new Date(time));
  const marks = await prisma.consistencyWeekClose.findMany({ where: { trainerId, weekStart: { in: mondays } } });
  const closed = new Set(marks.map((mark) => dateKey(mark.weekStart)));
  const due = [];
  for (const monday of mondays) {
    const weekStart = civilOf(monday);
    const rule = await ruleForWeek(prisma, trainerId, weekStart);
    if (weekBounds(weekStart, rule).closeInstant.getTime() > now.getTime()) break;
    if (!closed.has(dateKey(monday))) due.push(weekStart);
  }
  return due;
}

// Closes the championship weeks of each trainer without an active season, one trainer failing not stopping the others (CAMP-72)
async function closeChampionshipWeeks(prisma, logger, now) {
  for (const [trainerId, challenges] of await championshipsWithoutSeason(prisma, now)) {
    try {
      await closeWeeksInOrder(prisma, logger, trainerId, await findChampionshipDueWeeks(prisma, trainerId, challenges, now), now);
    } catch (err) {
      logger.error({ trainerId, weekStart: null, err }, `[consistency-close] failed to list due weeks for trainer ${trainerId}`);
    }
  }
}

/**
 * Closes, in order, every due week of each trainer's active season and, for trainers without one, of their open weekly championships (CAMP-72), once each (advisory lock per trainer and week); a failing trainer is logged and retried on the next run.
 *
 * @param {object} prisma
 * @param {{ info: Function, error: Function }} logger
 * @param {Date} [now]
 * @returns {Promise<void>}
 */
export async function closeDueWeeks(prisma, logger, now = new Date()) {
  const seasons = await prisma.consistencySeason.findMany({
    where: { status: SeasonStatus.ACTIVE },
    orderBy: [{ trainerId: 'asc' }],
  });
  for (const season of seasons) {
    try {
      await closeSeasonWeeks(prisma, logger, season, now);
    } catch (err) {
      logger.error(
        { trainerId: season.trainerId, weekStart: null, err },
        `[consistency-close] failed to list due weeks for trainer ${season.trainerId}`,
      );
    }
  }
  await closeChampionshipWeeks(prisma, logger, now);
}

// Whether the Monday falls inside the season's weeks
function isWithinSeason(season, weekStart) {
  const offset = dbDateOf(weekStart).getTime() - season.startWeek.getTime();
  return offset >= 0 && offset < season.weeks * MS_PER_WEEK;
}

// Ensures the season and freezes the running week's targets of one trainer's active students
async function prepareTrainer(prisma, trainerId, studentIds, now) {
  const season = await ensureCurrentSeasonLocked(prisma, trainerId, now);
  if (!season) return;
  const config = await getConfig(prisma, trainerId, now);
  const weekStart = weekStartFor(now, config.timeZone);
  if (!isWithinSeason(season, weekStart)) return;
  await materializeTargets(prisma, trainerId, weekStart, studentIds);
}

// Active student ids grouped by trainer
async function activeStudentsByTrainer(prisma) {
  const links = await prisma.trainerStudent.findMany({ where: { activeOnPlan: true }, select: { trainerId: true, studentId: true } });
  const byTrainer = new Map();
  for (const link of links) byTrainer.set(link.trainerId, [...(byTrainer.get(link.trainerId) ?? []), link.studentId]);
  return byTrainer;
}

/**
 * Opens the season when due and materializes the running week's targets for every trainer with an active student; one trainer failing is logged (when a logger is given) and does not stop the others.
 *
 * @param {object} prisma
 * @param {Date} [now]
 * @param {{ error: Function }|null} [logger]
 * @returns {Promise<void>}
 */
export async function prepareCurrentWeek(prisma, now = new Date(), logger = null) {
  const byTrainer = await activeStudentsByTrainer(prisma);
  for (const [trainerId, studentIds] of byTrainer) {
    try {
      await prepareTrainer(prisma, trainerId, studentIds, now);
    } catch (err) {
      logger?.error({ trainerId, err }, `[consistency-close] failed to prepare the current week for trainer ${trainerId}`);
    }
  }
}
