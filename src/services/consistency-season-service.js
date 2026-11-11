import { AppError } from '../errors/app-error.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, SeasonNotStartedReason, SeasonStatus } from '../constants/consistency-ranking.js';
import { formatDateOnly } from '../helpers/date-helpers.js';
import { weekStartFor } from '../helpers/consistency-week.js';
import { getConfig } from './consistency-config-service.js';

const LAUNCH_WEEK_ENV = 'CONSISTENCY_RANKING_LAUNCH_WEEK';
const DAYS_IN_WEEK = 7;
const MS_PER_DAY = 86400000;
const SEASON_LOCK_KEY_PREFIX = 'consistency-season';
const TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10000, timeout: 120000 });
const LAUNCH_WEEK_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

// Midnight-UTC millisecond key of a civil date, comparable with @db.Date values
function civilKey({ year, month, day }) {
  return Date.UTC(year, month - 1, day);
}

// Launch week from the env as a civil date, or null when unset or malformed
function readLaunchWeek() {
  const match = LAUNCH_WEEK_FORMAT.exec((process.env[LAUNCH_WEEK_ENV] ?? '').trim());
  if (!match) return null;
  const civil = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(civilKey(civil));
  const isReal = check.getUTCMonth() + 1 === civil.month && check.getUTCDate() === civil.day;
  return isReal ? civil : null;
}

// Active season of the trainer or null
function findActiveSeason(prisma, trainerId) {
  return prisma.consistencySeason.findFirst({ where: { trainerId, status: SeasonStatus.ACTIVE } });
}

// Monday after the previous season's last closed week as a millisecond key, or null when it never closed a week
async function nextSeasonMondayKey(prisma, lastSeason) {
  if (!lastSeason?.closedAt) return null;
  const lastClose = await prisma.consistencyWeekClose.findFirst({
    where: { trainerId: lastSeason.trainerId, weekStart: { gte: lastSeason.startWeek } },
    orderBy: { weekStart: 'desc' },
  });
  if (!lastClose) return null;
  return lastClose.weekStart.getTime() + DAYS_IN_WEEK * MS_PER_DAY;
}

// Creates the next season starting on the given Monday, numbered after the last one
function createNextSeason(prisma, trainerId, startKey, weeks, lastSeason) {
  return prisma.consistencySeason.create({
    data: { trainerId, number: (lastSeason?.number ?? 0) + 1, startWeek: new Date(startKey), weeks },
  });
}

// Assessment saying why no season can run now; startsOn is the Monday it can start (YYYY-MM-DD) or null
function notStarted(reason, startsOnKey = null) {
  return { notStarted: { reason, startsOn: startsOnKey === null ? null : formatDateOnly(new Date(startsOnKey)) } };
}

// Single source of the season rules: { active } when one runs, { notStarted } when none can start, or { next } with what the new season needs
async function assessCurrentSeason(prisma, trainerId, now) {
  const active = await findActiveSeason(prisma, trainerId);
  if (active) return { active };
  const launchWeek = readLaunchWeek();
  if (!launchWeek) return notStarted(SeasonNotStartedReason.LAUNCH_PENDING);
  const config = await getConfig(prisma, trainerId, now);
  const weekStartKey = civilKey(weekStartFor(now, config.timeZone));
  if (weekStartKey < civilKey(launchWeek)) return notStarted(SeasonNotStartedReason.LAUNCH_PENDING, civilKey(launchWeek));
  const activeStudents = await prisma.trainerStudent.count({ where: { trainerId, activeOnPlan: true } });
  if (activeStudents === 0) return notStarted(SeasonNotStartedReason.NO_ACTIVE_STUDENT);
  const lastSeason = await prisma.consistencySeason.findFirst({ where: { trainerId }, orderBy: { number: 'desc' } });
  const nextMondayKey = await nextSeasonMondayKey(prisma, lastSeason);
  if (nextMondayKey !== null && nextMondayKey > weekStartKey) return notStarted(SeasonNotStartedReason.BETWEEN_SEASONS, nextMondayKey);
  return { next: { startKey: weekStartKey, weeks: config.seasonWeeks, lastSeason } };
}

/**
 * Current active season of the trainer, creating the next one on the current Monday when due (null before launch, without an active student, or while the previous season's closing week runs).
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {Date} now
 * @returns {Promise<{ id: string, trainerId: string, number: number, startWeek: Date, weeks: number, status: string, closeRequestedAt: Date|null, closedAt: Date|null }|null>}
 */
export async function ensureCurrentSeason(prisma, trainerId, now) {
  const { active, next } = await assessCurrentSeason(prisma, trainerId, now);
  if (active) return active;
  if (!next) return null;
  return createNextSeason(prisma, trainerId, next.startKey, next.weeks, next.lastSeason);
}

/**
 * Why the trainer has no current season, without creating one: launchPending, noActiveStudent or betweenSeasons with the Monday it can start; null when a season runs or is due.
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {Date} now
 * @returns {Promise<{ reason: string, startsOn: string|null }|null>} startsOn as YYYY-MM-DD
 */
export async function seasonNotStartedReason(prisma, trainerId, now) {
  const { notStarted: reason } = await assessCurrentSeason(prisma, trainerId, now);
  return reason ?? null;
}

/**
 * Same as ensureCurrentSeason, but creates the season under a per-trainer advisory lock so concurrent callers cannot number it twice.
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {Date} now
 * @returns {Promise<object|null>}
 */
export async function ensureCurrentSeasonLocked(prisma, trainerId, now) {
  const active = await findActiveSeason(prisma, trainerId);
  if (active) return active;
  const key = `${SEASON_LOCK_KEY_PREFIX}:${trainerId}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    return ensureCurrentSeason(tx, trainerId, now);
  }, TRANSACTION_OPTIONS);
}

/**
 * Marks the active season to end at the next weekly close (the running week is not cut); idempotent.
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {Date} now
 * @returns {Promise<object>} the active season with closeRequestedAt set
 */
export async function requestEarlyClose(prisma, trainerId, now) {
  const active = await findActiveSeason(prisma, trainerId);
  if (!active) {
    throw new AppError({
      httpStatus: 404,
      error: ConsistencyErrorCode.SEASON_NOT_FOUND,
      messageCode: ConsistencyMessageCode.SEASON_NOT_FOUND,
      message: 'No active consistency season',
    });
  }
  if (active.closeRequestedAt) return active;
  return prisma.consistencySeason.update({ where: { id: active.id }, data: { closeRequestedAt: now } });
}

/**
 * All seasons of the trainer, newest first.
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @returns {Promise<object[]>}
 */
export function listSeasons(prisma, trainerId) {
  return prisma.consistencySeason.findMany({ where: { trainerId }, orderBy: { number: 'desc' } });
}
