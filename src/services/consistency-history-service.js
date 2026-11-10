import { SeasonStatus, WeekStatus } from '../constants/consistency-ranking.js';
import { shortNameOf } from '../helpers/consistency-names.js';

const HISTORY_MIN_WEEKS = 4;
const FULL_SCORE = 100;
const MS_PER_WEEK = 7 * 86400000;
const AVERAGE_DECIMALS = 2;

// "YYYY-MM-DD" of a @db.Date value
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Mean rounded to two places, or null for an empty list
function meanOf(values) {
  if (values.length === 0) return null;
  const factor = 10 ** AVERAGE_DECIMALS;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * factor) / factor;
}

// Longest run of consecutive scores at 100
function longestRunAt100(scores) {
  let longest = 0;
  let current = 0;
  for (const score of scores) {
    current = score >= FULL_SCORE ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

// History row of one student from the valid scores since the join, oldest first
function historyRow(link, scores) {
  return {
    studentId: link.studentId,
    ...shortNameOf(link.student),
    validWeeks: scores.length,
    average: meanOf(scores),
    weeks100: scores.filter((score) => score >= FULL_SCORE).length,
    longestStreak: longestRunAt100(scores),
  };
}

// Orders history rows by average, weeks at 100 and name
function byAverageThenName(a, b) {
  return b.average - a.average || b.weeks100 - a.weeks100 || a.displayName.localeCompare(b.displayName, 'pt-BR', { sensitivity: 'base' });
}

/**
 * General history of the team: for students with 4 or more valid weeks, the average of every valid week since the join, the weeks at 100 and the longest run at 100.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @returns {Promise<{ rows: object[] }>} ordered by average
 */
export async function getGeneralHistory(prisma, trainerId) {
  const links = await prisma.trainerStudent.findMany({
    where: { trainerId, activeOnPlan: true },
    select: { studentId: true, student: { select: { firstName: true, lastName: true, username: true } } },
  });
  if (links.length === 0) return { rows: [] };
  const results = await prisma.consistencyWeeklyResult.findMany({
    where: { trainerId, studentId: { in: links.map((link) => link.studentId) }, status: WeekStatus.VALID },
    orderBy: { weekStart: 'asc' },
    select: { studentId: true, score: true, weekStart: true },
  });
  const rows = links
    .map((link) => historyRow(link, results.filter((row) => row.studentId === link.studentId).map((row) => Number(row.score))))
    .filter((row) => row.validWeeks >= HISTORY_MIN_WEEKS);
  return { rows: rows.sort(byAverageThenName) };
}

// Summary of one closed season: dates, participants and the mean of the eligible students' averages
function seasonSummary(season) {
  const eligibleAverages = season.standings.filter((standing) => standing.eligible).map((standing) => Number(standing.average));
  return {
    number: season.number,
    startWeek: dateKey(season.startWeek),
    endWeek: dateKey(new Date(season.startWeek.getTime() + (season.weeks - 1) * MS_PER_WEEK)),
    weeks: season.weeks,
    participants: season.standings.length,
    average: meanOf(eligibleAverages),
  };
}

/**
 * Closed seasons of the trainer with number, dates, participants and average, newest first.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @returns {Promise<Array<{ number: number, startWeek: string, endWeek: string, weeks: number, participants: number, average: number|null }>>}
 */
export async function listSeasonSummaries(prisma, trainerId) {
  const seasons = await prisma.consistencySeason.findMany({
    where: { trainerId, status: SeasonStatus.CLOSED },
    orderBy: { number: 'desc' },
    select: { number: true, startWeek: true, weeks: true, standings: { select: { eligible: true, average: true } } },
  });
  return seasons.map(seasonSummary);
}
