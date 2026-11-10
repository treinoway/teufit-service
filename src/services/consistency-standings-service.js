import { AppError } from '../errors/app-error.js';
import {
  ConsistencyErrorCode,
  ConsistencyMessageCode,
  Pillar,
  SeasonStatus,
  WeekStatus,
} from '../constants/consistency-ranking.js';
import { isEligible, liveAverage, rankStandings, scoreWeek, seasonFigures } from '../helpers/consistency-math.js';
import { doneWindow, weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { getConfig, ruleForWeek } from './consistency-config-service.js';
import { countDone } from './consistency-progress-service.js';
import { pausesFor } from './consistency-pause-service.js';
import { ensureCurrentSeason } from './consistency-season-service.js';
import { materializeTargets } from './consistency-target-service.js';

const MS_PER_WEEK = 7 * 86400000;
const NO_COUNTS = Object.freeze({ workouts: 0, cardio: 0 });
const STUDENT_SELECT = { select: { firstName: true, lastName: true, username: true } };

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

// Display name of a student user
function displayName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.username || '';
}

// 404 for a season number the trainer does not have
function seasonNotFoundError() {
  return new AppError({
    httpStatus: 404,
    error: ConsistencyErrorCode.SEASON_NOT_FOUND,
    messageCode: ConsistencyMessageCode.SEASON_NOT_FOUND,
    message: 'Consistency season not found',
  });
}

// Season block of the response, with currentWeek as "X" of the season's Y weeks
function summarizeSeason(season, currentWeek) {
  const lastMonday = new Date(season.startWeek.getTime() + (season.weeks - 1) * MS_PER_WEEK);
  return {
    number: season.number,
    startWeek: dateKey(season.startWeek),
    endWeek: dateKey(lastMonday),
    weeks: season.weeks,
    currentWeek,
    status: season.status,
  };
}

// 1-based index of the running week inside the season, clamped to its length
function elapsedWeeksOf(season, mondayDate) {
  const index = Math.round((mondayDate.getTime() - season.startWeek.getTime()) / MS_PER_WEEK) + 1;
  return Math.min(Math.max(index, 1), season.weeks);
}

// Per-pillar expected and done counts of the tracked pillars
function pillarCounts(expected, done) {
  return {
    [Pillar.WORKOUTS]: { expected: expected.workouts, done: done.workouts },
    [Pillar.CARDIO]: { expected: expected.cardio, done: done.cardio },
  };
}

// Status and partial score of one student's running week (joined late -> neutral, paused, no target -> neutral)
function weekOutcome(link, ctx) {
  const expected = ctx.targets.get(link.studentId) ?? NO_COUNTS;
  const done = ctx.done.get(link.studentId) ?? NO_COUNTS;
  const pillars = pillarCounts(expected, done);
  const neutral = { status: WeekStatus.NEUTRAL, partial: null, pillars };
  if (link.createdAt.getTime() > ctx.startInstant.getTime()) return neutral;
  const pause = ctx.pauses.students.has(link.studentId) ? ctx.pauses.students.get(link.studentId) : ctx.pauses.team;
  if (pause) return { status: WeekStatus.PAUSED, partial: null, pillars };
  const partial = scoreWeek({ expected, done, weights: ctx.rule.weights, activePillars: ctx.rule.activePillars });
  return partial === null ? neutral : { status: WeekStatus.VALID, partial, pillars };
}

// Evaluates the running week of every linked student with one read per kind
async function evaluateRunningWeek(prisma, trainerId, mondayDate, links) {
  const weekStart = civilOf(mondayDate);
  const rule = await ruleForWeek(prisma, trainerId, weekStart);
  const previousRule = await ruleForWeek(prisma, trainerId, civilOf(new Date(mondayDate.getTime() - MS_PER_WEEK)));
  const window = doneWindow(weekStart, rule, previousRule);
  const ids = links.map((link) => link.studentId);
  const [targets, done, pauses] = await Promise.all([
    materializeTargets(prisma, trainerId, weekStart, ids),
    countDone(prisma, trainerId, ids, window),
    pausesFor(prisma, trainerId, [weekStart]),
  ]);
  const startInstant = weekBounds(weekStart, rule).startInstant;
  const ctx = { rule, targets, done, pauses: pauses.get(dateKey(mondayDate)), startInstant };
  return new Map(links.map((link) => [link.studentId, weekOutcome(link, ctx)]));
}

// Stored results of the students grouped by student, most recent week first
async function readResultsByStudent(prisma, trainerId, studentIds, mondayDate) {
  const rows = await prisma.consistencyWeeklyResult.findMany({
    where: { trainerId, studentId: { in: studentIds }, weekStart: { lt: mondayDate } },
    orderBy: { weekStart: 'desc' },
  });
  const byStudent = new Map();
  for (const row of rows) byStudent.set(row.studentId, [...(byStudent.get(row.studentId) ?? []), row]);
  return byStudent;
}

// Season figures of one student from stored closed weeks plus the running week
function summarizeStudent(link, results, week, { season, elapsed, minPodiumWeeks }) {
  const figures = seasonFigures(results, season.id);
  const validWeeks = figures.validWeeks + (week.status === WeekStatus.VALID ? 1 : 0);
  return {
    studentId: link.studentId,
    name: displayName(link.student),
    eligible: isEligible({ validWeeks, elapsedWeeks: elapsed, minPodiumWeeks }),
    average: liveAverage(figures.scores, week.partial),
    validWeeks,
    weeksAt100: figures.weeksAt100,
    streak: figures.streak,
    partialScore: week.partial,
    weekStatus: week.status,
    pillars: week.pillars,
  };
}

// Students still entering the season, with the valid weeks they lack, ordered by name
function enteringList(students, required) {
  return students
    .filter((student) => !student.eligible)
    .map(({ studentId, name, validWeeks }) => ({ studentId, name, validWeeks, weeksMissing: required - validWeeks }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
}

// Live standings of the active season: ranked rows plus students still entering
async function liveStandings(prisma, trainerId, season, now) {
  const config = await getConfig(prisma, trainerId, now);
  const mondayDate = dbDateOf(weekStartFor(now, config.timeZone));
  const elapsed = elapsedWeeksOf(season, mondayDate);
  const links = await prisma.trainerStudent.findMany({
    where: { trainerId, activeOnPlan: true },
    select: { studentId: true, createdAt: true, student: STUDENT_SELECT },
  });
  if (links.length === 0) return { season: summarizeSeason(season, elapsed), rows: [], entering: [] };

  const ids = links.map((link) => link.studentId);
  const [weeks, results] = await Promise.all([
    evaluateRunningWeek(prisma, trainerId, mondayDate, links),
    readResultsByStudent(prisma, trainerId, ids, mondayDate),
  ]);
  const context = { season, elapsed, minPodiumWeeks: config.minPodiumWeeks };
  const students = links
    .map((link) => summarizeStudent(link, results.get(link.studentId) ?? [], weeks.get(link.studentId), context))
    .filter((student) => student.validWeeks > 0);
  return {
    season: summarizeSeason(season, elapsed),
    rows: rankStandings(students.filter((student) => student.eligible)),
    entering: enteringList(students, Math.min(config.minPodiumWeeks, elapsed)),
  };
}

// Orders by stored position, then by name for tied students
function byPositionThenName(a, b) {
  if (a.position !== b.position) return (a.position ?? 0) - (b.position ?? 0);
  return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
}

// Frozen standings of a closed season, read from the stored snapshot
async function frozenStandings(prisma, trainerId, season, now) {
  const config = await getConfig(prisma, trainerId, now);
  const required = Math.min(config.minPodiumWeeks, season.weeks);
  const stored = await prisma.consistencySeasonStanding.findMany({
    where: { seasonId: season.id },
    include: { student: STUDENT_SELECT },
    orderBy: { position: 'asc' },
  });
  const named = stored.map((row) => ({ ...row, name: displayName(row.student) })).sort(byPositionThenName);
  const rows = named
    .filter((row) => row.eligible)
    .map((row) => ({
      studentId: row.studentId,
      name: row.name,
      position: row.position,
      eligible: true,
      average: row.average,
      validWeeks: row.validWeeks,
      weeksAt100: row.weeks100,
      streak: row.streak,
    }));
  const entering = named
    .filter((row) => !row.eligible && row.validWeeks > 0)
    .map((row) => ({ studentId: row.studentId, name: row.name, validWeeks: row.validWeeks, weeksMissing: Math.max(required - row.validWeeks, 0) }));
  return { season: summarizeSeason(season, season.weeks), rows, entering };
}

// Season asked for: the one with that number (404 when absent) or the current one
async function resolveSeason(prisma, trainerId, seasonNumber, now) {
  if (seasonNumber === undefined || seasonNumber === null) return ensureCurrentSeason(prisma, trainerId, now);
  const found = await prisma.consistencySeason.findFirst({ where: { trainerId, number: seasonNumber } });
  if (!found) throw seasonNotFoundError();
  return found;
}

/**
 * Standings of a trainer's team: live for the active season, frozen for a closed one; season is null (empty lists) before any season exists.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {{ seasonNumber?: number, now?: Date }} [options]
 * @returns {Promise<{ season: object|null, rows: object[], entering: object[] }>}
 */
export async function getStandings(prisma, trainerId, { seasonNumber, now = new Date() } = {}) {
  const season = await resolveSeason(prisma, trainerId, seasonNumber, now);
  if (!season) return { season: null, rows: [], entering: [] };
  if (season.status === SeasonStatus.CLOSED) return frozenStandings(prisma, trainerId, season, now);
  return liveStandings(prisma, trainerId, season, now);
}
