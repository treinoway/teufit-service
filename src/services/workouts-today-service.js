import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import { formatDateOnly, getWeekdayInTimeZone, addDaysMs } from '../helpers/date-helpers.js';
import { WorkoutsTodayErrorCode, WorkoutsTodayMessageCode } from '../constants/training.js';

// ─── Error factories ─────────────────────────────────────────────────────────

function noActiveProtocolError() {
  return new AppError({
    httpStatus: 404,
    error: WorkoutsTodayErrorCode.NO_ACTIVE_PROTOCOL,
    messageCode: WorkoutsTodayMessageCode.NO_ACTIVE_PROTOCOL,
    message: 'You do not have an active training protocol.',
  });
}

function emptyProtocolError() {
  return new AppError({
    httpStatus: 404,
    error: WorkoutsTodayErrorCode.EMPTY_PROTOCOL,
    messageCode: WorkoutsTodayMessageCode.EMPTY_PROTOCOL,
    message: 'Your active protocol does not have any workouts yet.',
  });
}

// ─── Per-protocol resolution helpers ─────────────────────────────────────────

/**
 * Resolves the weekDay-based target training and rest-day state for a single protocol.
 *
 * @param {object} protocol - Protocol with `trainings` included
 * @param {string} todayWeekday - Lowercase weekday name for the user's timezone
 * @param {Date} today - Current date object
 * @param {string} timeZone - IANA timezone identifier
 * @returns {{ targetTraining: object|null, isRestDay: boolean, nextScheduledDate: string|null }}
 */
function resolveWeekDayMode(protocol, todayWeekday, today, timeZone) {
  const matchingTraining = protocol.trainings.find(
    (training) => training.weekDay === todayWeekday,
  );

  if (matchingTraining) {
    return { targetTraining: matchingTraining, isRestDay: false, nextScheduledDate: null };
  }

  let nextScheduledDate = null;
  for (let daysAhead = 1; daysAhead <= 7; daysAhead++) {
    const futureDate = addDaysMs(today, daysAhead);
    const futureWeekday = getWeekdayInTimeZone(futureDate, timeZone);
    const futureMatch = protocol.trainings.find(
      (training) => training.weekDay === futureWeekday,
    );
    if (futureMatch) {
      nextScheduledDate = formatDateOnly(futureDate);
      break;
    }
  }

  return { targetTraining: null, isRestDay: true, nextScheduledDate };
}

/**
 * Resolves the order-based target training for a single protocol.
 * Queries the last completed session to determine which training is next.
 *
 * @param {object} protocol - Protocol with `trainings` included
 * @param {string} userId
 * @returns {Promise<{ targetTraining: object, isRestDay: false, nextScheduledDate: null }>}
 */
async function resolveOrderMode(protocol, userId) {
  const lastCompletedSession = await prisma.workoutSession.findFirst({
    where: {
      userId,
      status: 'completed',
      deletedAt: null,
      training: { trainingProtocolId: protocol.id },
    },
    orderBy: { finishedAt: 'desc' },
    select: { training: { select: { order: true } } },
  });

  let targetTraining;
  if (!lastCompletedSession) {
    targetTraining = protocol.trainings[0];
  } else {
    const nextTraining = protocol.trainings.find(
      (training) => training.order > lastCompletedSession.training.order,
    );
    targetTraining = nextTraining ?? protocol.trainings[0];
  }

  return { targetTraining, isRestDay: false, nextScheduledDate: null };
}

/**
 * Resolves today's workout state for a single protocol.
 *
 * @param {object} protocol - Protocol with `trainings` included
 * @param {string} userId
 * @param {string} todayWeekday
 * @param {Date} today
 * @param {string} timeZone
 * @returns {Promise<{ targetTraining: object|null, isRestDay: boolean, nextScheduledDate: string|null }>}
 */
async function resolveProtocolWorkout(protocol, userId, todayWeekday, today, timeZone) {
  const isWeekDayBased = protocol.trainings.some((training) => training.weekDay !== null);

  if (isWeekDayBased) {
    return resolveWeekDayMode(protocol, todayWeekday, today, timeZone);
  }

  return resolveOrderMode(protocol, userId);
}

// ─── Main service function ───────────────────────────────────────────────────

/**
 * Resolves which training(s) the student should do today, one entry per active protocol.
 *
 * Decision logic per protocol:
 * - weekDay mode (any training has weekDay != null): match today's weekday, else rest day.
 * - order mode (all trainings have weekDay == null): pick next after last completed session, cycling.
 *
 * Protocols with no trainings are skipped. If all active protocols are empty, throws EMPTY_PROTOCOL.
 * The single pending in-progress session is reported once at the top level, not per-protocol.
 *
 * @param {string} userId
 * @param {{ timeZone: string }} options
 * @returns {Promise<{ workouts: Array<object> }>}
 */
export async function getTodayWorkout(userId, { timeZone }) {
  const protocols = await prisma.trainingProtocol.findMany({
    where: { assigneeId: userId, status: 'active', deletedAt: null },
    orderBy: { startDate: 'desc' },
    include: {
      trainings: {
        where: { deletedAt: null },
        orderBy: { order: 'asc' },
        include: {
          exercises: { where: { deletedAt: null }, orderBy: { order: 'asc' } },
        },
      },
    },
  });

  if (protocols.length === 0) throw noActiveProtocolError();

  const protocolsWithTrainings = protocols.filter(
    (protocol) => protocol.trainings.length > 0,
  );

  if (protocolsWithTrainings.length === 0) throw emptyProtocolError();

  const pendingSession = await prisma.workoutSession.findFirst({
    where: { userId, status: 'in_progress', deletedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { id: true, trainingId: true, startedAt: true, status: true },
  });

  const pendingTraining = pendingSession
    ? {
        sessionId: pendingSession.id,
        trainingId: pendingSession.trainingId,
        startedAt: pendingSession.startedAt,
        status: pendingSession.status,
      }
    : null;

  const today = new Date();
  const todayWeekday = getWeekdayInTimeZone(today, timeZone);

  // TODO: if N protocols grows large, replace Promise.all fan-out with a batched query
  const workoutEntries = await Promise.all(
    protocolsWithTrainings.map(async (protocol) => {
      const { targetTraining, isRestDay, nextScheduledDate } = await resolveProtocolWorkout(
        protocol,
        userId,
        todayWeekday,
        today,
        timeZone,
      );

      return {
        protocol: {
          id: protocol.id,
          name: protocol.name,
          startDate: formatDateOnly(protocol.startDate),
          expirationDate: formatDateOnly(protocol.expirationDate),
        },
        targetTraining,
        isRestDay,
        nextScheduledDate,
      };
    }),
  );

  return { workouts: workoutEntries, pendingTraining };
}
