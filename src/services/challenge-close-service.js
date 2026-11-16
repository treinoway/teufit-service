import { AppError } from '../errors/app-error.js';
import {
  ChallengeErrorCode,
  ChallengeFormat,
  ChallengeMessageCode,
  ChallengeStatus,
} from '../constants/challenge.js';
import { SeasonStatus } from '../constants/consistency-ranking.js';
import { currentWeekOf, weeklyStatus } from '../helpers/challenge-weeks.js';
import { weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { formatDateOnly } from '../helpers/date-helpers.js';
import { computeChallengeStandings, ownedChallenge } from './challenge-consistency-service.js';
import { getConfig, ruleForWeek } from './consistency-config-service.js';

const LOCK_KEY_PREFIX = 'challenge-close';
const MS_PER_DAY = 86400000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const DAYS_TO_SUNDAY = 6;
const TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10000, timeout: 120000 });

// Civil date of a @db.Date value
function civilOf(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Midnight-UTC Date of a civil date
function dbDateOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Monday of the last championship week (endDate is its Sunday)
function lastMondayOf(challenge) {
  return new Date(challenge.endDate.getTime() - DAYS_TO_SUNDAY * MS_PER_DAY);
}

// Whether the last week's close instant (rule of that week) has passed
async function lastWeekClosePassed(prisma, challenge, now) {
  const lastMonday = civilOf(lastMondayOf(challenge));
  const rule = await ruleForWeek(prisma, challenge.trainerId, lastMonday);
  return weekBounds(lastMonday, rule).closeInstant.getTime() <= now.getTime();
}

// Whether the last week is closed: the trainer's closed-week mark exists, or, with no active season (no mark is ever written), its close passed
async function isDue(prisma, challenge, now) {
  const mark = await prisma.consistencyWeekClose.findUnique({
    where: { trainerId_weekStart: { trainerId: challenge.trainerId, weekStart: lastMondayOf(challenge) } },
  });
  if (mark) return true;
  const season = await prisma.consistencySeason.findFirst({
    where: { trainerId: challenge.trainerId, status: SeasonStatus.ACTIVE },
  });
  if (season) return false;
  return lastWeekClosePassed(prisma, challenge, now);
}

// Takes the transaction-scoped advisory lock of the championship without waiting
async function tryAcquireCloseLock(tx, challengeId) {
  const key = `${LOCK_KEY_PREFIX}:${challengeId}`;
  const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
  return locked;
}

// Frozen standing row of one participant
function standingData(challengeId, row, now) {
  return {
    challengeId,
    studentId: row.studentId,
    position: row.eligible ? row.position : null,
    eligible: row.eligible,
    average: row.average,
    validWeeks: row.validWeeks,
    weeks100: row.weeksAt100,
    streak: row.streak,
    frozenAt: now,
  };
}

// Freezes the standings and closes the championship in its own transaction; null when another run holds the lock or already closed it
function closeChallengeLocked(prisma, challengeId, now) {
  return prisma.$transaction(async (tx) => {
    if (!(await tryAcquireCloseLock(tx, challengeId))) return null;
    const challenge = await tx.challenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.closedAt || challenge.cancelledAt) return null;
    const { rows, entering } = await computeChallengeStandings(tx, challenge, now);
    await tx.challengeConsistencyStanding.createMany({
      data: [...rows, ...entering].map((row) => standingData(challengeId, row, now)),
      skipDuplicates: true,
    });
    await tx.challenge.update({ where: { id: challengeId }, data: { closedAt: now } });
    return { ranked: rows.length, entering: entering.length };
  }, TRANSACTION_OPTIONS);
}

// Closes one championship when due and logs it
async function closeIfDue(prisma, logger, challenge, now) {
  if (!(await isDue(prisma, challenge, now))) return;
  const outcome = await closeChallengeLocked(prisma, challenge.id, now);
  if (!outcome) return;
  logger.info(
    { challengeId: challenge.id, trainerId: challenge.trainerId, ranked: outcome.ranked, entering: outcome.entering },
    `[challenge-close] closed championship ${challenge.id}: ${outcome.ranked} ranked`,
  );
}

/**
 * Closes every open weekly championship whose last week is closed, once each (advisory lock per championship), freezing its standings; a failing one is logged and retried on the next run.
 *
 * @param {object} prisma
 * @param {{ info: Function, error: Function }} logger
 * @param {Date} [now]
 * @returns {Promise<void>}
 */
export async function closeDueChallenges(prisma, logger, now = new Date()) {
  const candidates = await prisma.challenge.findMany({
    where: {
      format: ChallengeFormat.WEEKS,
      closedAt: null,
      cancelledAt: null,
      endDate: { lte: new Date(now.getTime() + MS_PER_WEEK) },
    },
    orderBy: [{ endDate: 'asc' }],
  });
  for (const challenge of candidates) {
    try {
      await closeIfDue(prisma, logger, challenge, now);
    } catch (err) {
      logger.error(
        { challengeId: challenge.id, trainerId: challenge.trainerId, err },
        `[challenge-close] failed to close championship ${challenge.id}`,
      );
    }
  }
}

// 409 for a championship that is not a running weekly one
function notClosable() {
  return new AppError({
    httpStatus: 409,
    error: ChallengeErrorCode.CHALLENGE_NOT_CLOSABLE,
    messageCode: ChallengeMessageCode.CHALLENGE_NOT_CLOSABLE,
    message: 'Only a running weekly championship can be closed early',
  });
}

/**
 * Ends a running weekly championship early: the running week becomes the last one (end on its Sunday) and the job closes it at that week's close.
 *
 * @param {object} prisma
 * @param {string} trainerUserId - authenticated trainer's user id
 * @param {string} challengeId
 * @param {Date} [now]
 * @returns {Promise<{ id: string, status: string, weeks: number, endDate: string, closeRequestedAt: Date, closesAt: Date }>}
 */
export async function requestEarlyClose(prisma, trainerUserId, challengeId, now = new Date()) {
  const challenge = await ownedChallenge(prisma, trainerUserId, challengeId);
  if (challenge.format !== ChallengeFormat.WEEKS) throw notClosable();
  const { timeZone } = await getConfig(prisma, challenge.trainerId, now);
  const status = weeklyStatus(challenge, { now, timeZone });
  if (status !== ChallengeStatus.ACTIVE) throw notClosable();

  const monday = weekStartFor(now, timeZone);
  const mondayDate = dbDateOf(monday);
  const weeks = currentWeekOf(challenge, mondayDate);
  const endDate = new Date(mondayDate.getTime() + DAYS_TO_SUNDAY * MS_PER_DAY);
  const updated = await prisma.challenge.update({
    where: { id: challenge.id },
    data: { weeks, endDate, closeRequestedAt: now },
  });
  const rule = await ruleForWeek(prisma, challenge.trainerId, monday);
  return {
    id: updated.id,
    status,
    weeks: updated.weeks,
    endDate: formatDateOnly(updated.endDate),
    closeRequestedAt: updated.closeRequestedAt,
    closesAt: weekBounds(monday, rule).closeInstant,
  };
}
