import { AppError } from '../errors/app-error.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, SeasonStatus } from '../constants/consistency-ranking.js';
import { weekStartFor } from '../helpers/consistency-week.js';
import { getConfig } from './consistency-config-service.js';

const LAUNCH_WEEK_ENV = 'CONSISTENCY_RANKING_LAUNCH_WEEK';
const DAYS_IN_WEEK = 7;
const MS_PER_DAY = 86400000;
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

// Whether the previous season closed so recently that its following Monday is still ahead
function isBeforeNextSeasonMonday(lastSeason, weekStartKey, timeZone) {
  if (!lastSeason?.closedAt) return false;
  const closedMonday = weekStartFor(lastSeason.closedAt, timeZone);
  return civilKey(closedMonday) + DAYS_IN_WEEK * MS_PER_DAY > weekStartKey;
}

// Creates the next season starting on the given Monday, numbered after the last one
function createNextSeason(prisma, trainerId, startKey, weeks, lastSeason) {
  return prisma.consistencySeason.create({
    data: { trainerId, number: (lastSeason?.number ?? 0) + 1, startWeek: new Date(startKey), weeks },
  });
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
  const active = await findActiveSeason(prisma, trainerId);
  if (active) return active;
  const launchWeek = readLaunchWeek();
  if (!launchWeek) return null;
  const config = await getConfig(prisma, trainerId, now);
  const weekStartKey = civilKey(weekStartFor(now, config.timeZone));
  if (weekStartKey < civilKey(launchWeek)) return null;
  const activeStudents = await prisma.trainerStudent.count({ where: { trainerId, activeOnPlan: true } });
  if (activeStudents === 0) return null;
  const lastSeason = await prisma.consistencySeason.findFirst({ where: { trainerId }, orderBy: { number: 'desc' } });
  if (isBeforeNextSeasonMonday(lastSeason, weekStartKey, config.timeZone)) return null;
  return createNextSeason(prisma, trainerId, weekStartKey, config.seasonWeeks, lastSeason);
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
