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

// ─── Main service function ───────────────────────────────────────────────────

/**
 * Resolves which training the student should do today.
 *
 * Decision logic:
 * - weekDay mode (any training has weekDay != null): match today's weekday, else rest day.
 * - order mode (all trainings have weekDay == null): pick next after last completed session, cycling.
 *
 * @param {string} userId
 * @param {{ timeZone: string }} options
 */
export async function getTodayWorkout(userId, { timeZone }) {
  const protocol = await prisma.trainingProtocol.findFirst({
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

  if (!protocol) throw noActiveProtocolError();
  if (protocol.trainings.length === 0) throw emptyProtocolError();

  const pendingSession = await prisma.workoutSession.findFirst({
    where: { userId, status: 'in_progress', deletedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { id: true, trainingId: true, startedAt: true, status: true },
  });

  const today = new Date();
  const todayWeekday = getWeekdayInTimeZone(today, timeZone);
  const isWeekDayBased = protocol.trainings.some((training) => training.weekDay !== null);

  let targetTraining = null;
  let isRestDay = false;
  let nextScheduledDate = null;

  if (isWeekDayBased) {
    const matchingTraining = protocol.trainings.find((training) => training.weekDay === todayWeekday);
    if (matchingTraining) {
      targetTraining = matchingTraining;
    } else {
      isRestDay = true;
      for (let daysAhead = 1; daysAhead <= 7; daysAhead++) {
        const futureDate = addDaysMs(today, daysAhead);
        const futureWeekday = getWeekdayInTimeZone(futureDate, timeZone);
        const futureMatch = protocol.trainings.find((training) => training.weekDay === futureWeekday);
        if (futureMatch) {
          nextScheduledDate = formatDateOnly(futureDate);
          break;
        }
      }
    }
  } else {
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

    if (!lastCompletedSession) {
      targetTraining = protocol.trainings[0];
    } else {
      const nextTraining = protocol.trainings.find(
        (training) => training.order > lastCompletedSession.training.order,
      );
      targetTraining = nextTraining ?? protocol.trainings[0];
    }
  }

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
    pendingTraining: pendingSession
      ? {
          sessionId: pendingSession.id,
          trainingId: pendingSession.trainingId,
          startedAt: pendingSession.startedAt,
          status: pendingSession.status,
        }
      : null,
  };
}
