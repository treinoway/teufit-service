import { NotFoundAppError } from '../errors/app-error.js';
import { DEFAULT_CONFIG, Faixa, PANEL_DEFAULTS, WeekStatus } from '../constants/consistency-ranking.js';
import { weekStartFor } from '../helpers/consistency-week.js';
import { getConfig } from './consistency-config-service.js';
import { lastContact } from './consistency-contact-service.js';
import { faixaFor, weakestPillar } from './consistency-insights-service.js';
import { ensureCurrentSeason } from './consistency-season-service.js';
import { getPanelStandings } from './consistency-standings-service.js';

const MS_PER_WEEK = 7 * 86400000;
const STUDENT_NOT_FOUND = 'student.notFound';
const WeekState = Object.freeze({ CLOSED: 'closed', CURRENT: 'current', FUTURE: 'future' });

// "YYYY-MM-DD" of a @db.Date value
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Number of a Decimal-like value, or null when absent
function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

// 404 for a student that is not linked to the trainer
function studentNotFoundError() {
  return new NotFoundAppError({ message: 'Student not found', messageCode: STUDENT_NOT_FOUND });
}

// Link of the student to the trainer with the name and whatsapp, or 404
async function readStudent(prisma, trainerId, studentId) {
  const link = await prisma.trainerStudent.findFirst({
    where: { trainerId, studentId },
    select: { student: { select: { firstName: true, lastName: true, username: true, socials: { select: { whatsapp: true } } } } },
  });
  if (!link) throw studentNotFoundError();
  return link.student;
}

// Midnight-UTC Monday of the running week in the trainer's timezone
function currentMonday(now, config) {
  const { year, month, day } = weekStartFor(now, config.timeZone ?? DEFAULT_CONFIG.timeZone);
  return new Date(Date.UTC(year, month - 1, day));
}

// Stored closed weeks of the student in the season, keyed by "YYYY-MM-DD"
async function readClosedWeeks(prisma, trainerId, studentId, season) {
  const rows = await prisma.consistencyWeeklyResult.findMany({ where: { trainerId, studentId, seasonId: season.id } });
  return new Map(rows.map((row) => [dateKey(row.weekStart), row]));
}

// One week of the chart: a closed week with its stored score, the running week with its partial, or a future week
function weekEntry(season, index, { monday, closedWeeks, row }) {
  const start = new Date(season.startWeek.getTime() + index * MS_PER_WEEK);
  const base = { weekStart: dateKey(start), number: index + 1 };
  if (start.getTime() > monday.getTime()) return { ...base, state: WeekState.FUTURE, status: null, score: null };
  if (start.getTime() === monday.getTime()) {
    return { ...base, state: WeekState.CURRENT, status: row?.weekStatus ?? WeekStatus.NEUTRAL, score: row?.currentWeekScore ?? null };
  }
  const stored = closedWeeks.get(base.weekStart);
  return { ...base, state: WeekState.CLOSED, status: stored?.status ?? WeekStatus.NEUTRAL, score: numberOrNull(stored?.score) };
}

// Week-by-week chart of the season, empty when the trainer has no season
async function buildWeeks(prisma, trainerId, studentId, season, context) {
  if (!season) return [];
  const closedWeeks = await readClosedWeeks(prisma, trainerId, studentId, season);
  return Array.from({ length: season.weeks }, (_, index) => weekEntry(season, index, { ...context, closedWeeks }));
}

// Average and band of each closed season the student took part in, newest first
async function readPreviousSeasons(prisma, trainerId, studentId) {
  const standings = await prisma.consistencySeasonStanding.findMany({
    where: { trainerId, studentId },
    include: { season: { select: { number: true, startWeek: true, weeks: true } } },
  });
  return standings
    .map(({ season, average, eligible }) => ({
      number: season.number,
      startWeek: dateKey(season.startWeek),
      endWeek: dateKey(new Date(season.startWeek.getTime() + (season.weeks - 1) * MS_PER_WEEK)),
      average: numberOrNull(average),
      faixa: faixaFor(average, eligible),
    }))
    .sort((a, b) => b.number - a.number);
}

// Standing fields of the student, or the entering defaults when the student has no valid week yet
function standingOf(row, total) {
  if (!row) {
    return { displayName: null, position: null, total, average: null, faixa: Faixa.ENTERING, risk: null, pause: null, signals: [], seasonPillars: [] };
  }
  const { displayName, initials, position, average, faixa, risk, pause, signals, seasonPillars } = row;
  return { displayName, initials, position, total, average, faixa, risk, pause, signals, seasonPillars };
}

/**
 * Everything the student panel shows: standing, risk, week-by-week chart, season pillars, weakest pillar, previous seasons and last contact.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} studentId - User.id; 404 when the student is not linked to the trainer
 * @param {Date} [now]
 * @returns {Promise<object>}
 */
export async function getStudentPanel(prisma, trainerId, studentId, now = new Date()) {
  const student = await readStudent(prisma, trainerId, studentId);
  const [standings, config, season, previousSeasons, lastContactAt] = await Promise.all([
    getPanelStandings(prisma, trainerId, { now }),
    getConfig(prisma, trainerId, now),
    ensureCurrentSeason(prisma, trainerId, now),
    readPreviousSeasons(prisma, trainerId, studentId),
    lastContact(prisma, trainerId, studentId),
  ]);
  const row = [...standings.rows, ...standings.entering].find((candidate) => candidate.studentId === studentId);
  const standing = standingOf(row, standings.rows.length);
  const weeks = await buildWeeks(prisma, trainerId, studentId, season, { monday: currentMonday(now, config), row });
  return {
    studentId,
    firstName: student.firstName,
    whatsapp: student.socials?.whatsapp ?? null,
    ...standing,
    riskLimit: config.riskLimit ?? PANEL_DEFAULTS.riskLimit,
    weeks,
    weakestPillar: weakestPillar(standing.seasonPillars),
    previousSeasons,
    lastContact: lastContactAt,
  };
}
