import { prisma } from '../db.js';
import { AppError } from '../errors/app-error.js';
import { formatDateOnly, getWeekdayInTimeZone, addDaysMs } from '../helpers/date-helpers.js';
import {
  WorkoutsTodayErrorCode,
  WorkoutsTodayMessageCode,
  AUTO_COMPLETE_PENDING_AFTER_MS,
  WorkoutSessionStatus,
} from '../constants/training.js';
import { translate } from '../i18n/index.js';

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

// ─── Auto-completion helper ───────────────────────────────────────────────────

/**
 * Appends the localized auto-completion note to the session's existing notes.
 * If notes is null or empty, the note becomes the entire value.
 * If notes already has content, the note is appended with a blank line separator.
 *
 * @param {string | null} existingNotes
 * @param {string} autoNote
 * @returns {string}
 */
function buildAutoCompletionNotes(existingNotes, autoNote) {
  if (!existingNotes || existingNotes.trim() === '') {
    return autoNote;
  }
  return `${existingNotes}\n\n${autoNote}`;
}

/**
 * Attempts to auto-complete a pending workout session that has been in_progress
 * for at least AUTO_COMPLETE_PENDING_AFTER_MS milliseconds.
 *
 * The finishedAt is set to startedAt + 24h (not now) so that durationSeconds
 * always equals exactly 24 * 60 * 60, regardless of when this call runs.
 *
 * On DB failure the error is logged and the function returns false, allowing
 * the caller to degrade gracefully and still return the pending session.
 *
 * @param {object} session - The pending session { id, startedAt, notes }
 * @param {string} language - Resolved locale tag
 * @param {import('@fastify/type-provider-typebox').FastifyBaseLogger} [logger]
 * @returns {Promise<boolean>} true when the update succeeded, false on failure
 */
async function tryAutoCompleteSession(session, language, logger) {
  const finishedAt = new Date(session.startedAt.getTime() + AUTO_COMPLETE_PENDING_AFTER_MS);
  const durationSeconds = AUTO_COMPLETE_PENDING_AFTER_MS / 1000;
  const autoNote = translate('notes', 'autoCompleted24h', language);
  const notes = buildAutoCompletionNotes(session.notes, autoNote);

  try {
    await prisma.workoutSession.update({
      where: { id: session.id },
      data: {
        status: WorkoutSessionStatus.COMPLETED,
        finishedAt,
        durationSeconds,
        notes,
      },
    });
    return true;
  } catch (error) {
    // Graceful degradation: log and let the caller return the still-pending session.
    // A second concurrent call will retry and is idempotent in practice.
    if (logger) {
      logger.warn({ err: error, sessionId: session.id }, 'workouts-today: failed to auto-complete stale session');
    }
    return false;
  }
}

// ─── Per-protocol resolution helpers ─────────────────────────────────────────

/**
 * Resolves the weekDay-based target trainings for a single protocol.
 * Returns one entry per training matching today's weekday (a protocol may have
 * multiple trainings on the same day — e.g. legs + cardio on Tuesday). Falls
 * back to a single rest-day entry if no training matches.
 *
 * @param {object} protocol - Protocol with `trainings` included
 * @param {string} todayWeekday - Lowercase weekday name for the user's timezone
 * @param {Date} today - Current date object
 * @param {string} timeZone - IANA timezone identifier
 * @returns {Array<{ targetTraining: object|null, isRestDay: boolean, nextScheduledDate: string|null }>}
 */
function resolveWeekDayMode(protocol, todayWeekday, today, timeZone) {
  const matchingTrainings = protocol.trainings.filter(
    (training) => training.weekDay === todayWeekday,
  );

  if (matchingTrainings.length > 0) {
    return matchingTrainings.map((targetTraining) => ({
      targetTraining,
      isRestDay: false,
      nextScheduledDate: null,
    }));
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

  return [{ targetTraining: null, isRestDay: true, nextScheduledDate }];
}

/**
 * Resolves the order-based target training for a single protocol.
 * Queries the last completed session to determine which training is next.
 * Always returns a single entry — order mode is "next training in cycle".
 *
 * @param {object} protocol - Protocol with `trainings` included
 * @param {string} userId
 * @returns {Promise<Array<{ targetTraining: object, isRestDay: false, nextScheduledDate: null }>>}
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

  return [{ targetTraining, isRestDay: false, nextScheduledDate: null }];
}

/**
 * Resolves today's workout state for a single protocol.
 * Returns one or more entries — weekDay mode may emit N entries when the
 * protocol schedules multiple trainings on the same weekday.
 *
 * @param {object} protocol - Protocol with `trainings` included
 * @param {string} userId
 * @param {string} todayWeekday
 * @param {Date} today
 * @param {string} timeZone
 * @returns {Promise<Array<{ targetTraining: object|null, isRestDay: boolean, nextScheduledDate: string|null }>>}
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
 * If the pending session has been in_progress for >= 24h, it is auto-completed before the
 * order-mode resolution runs, so the newly completed session is correctly considered when
 * determining the next training.
 *
 * @param {string} userId
 * @param {{ timeZone: string, language?: string, logger?: object }} options
 * @returns {Promise<{ workouts: Array<object>, pendingTraining: object|null }>}
 */
export async function getTodayWorkout(userId, { timeZone, language = 'pt-BR', logger } = {}) {
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
    select: { id: true, trainingId: true, startedAt: true, status: true, notes: true },
  });

  // Auto-complete sessions that have been in_progress for >= 24h.
  // Order-mode resolution runs AFTER this update so the newly completed session
  // is visible to resolveOrderMode's findFirst({ status: 'completed' }) query.
  let pendingTraining = null;
  if (pendingSession) {
    const isStale =
      Date.now() - pendingSession.startedAt.getTime() >= AUTO_COMPLETE_PENDING_AFTER_MS;

    if (isStale) {
      const completed = await tryAutoCompleteSession(pendingSession, language, logger);
      // Only suppress pendingTraining if the update succeeded.
      // On failure, degrade gracefully and keep showing the session as pending.
      if (!completed) {
        pendingTraining = {
          sessionId: pendingSession.id,
          trainingId: pendingSession.trainingId,
          startedAt: pendingSession.startedAt,
          status: pendingSession.status,
        };
      }
    } else {
      pendingTraining = {
        sessionId: pendingSession.id,
        trainingId: pendingSession.trainingId,
        startedAt: pendingSession.startedAt,
        status: pendingSession.status,
      };
    }
  }

  const today = new Date();
  const todayWeekday = getWeekdayInTimeZone(today, timeZone);

  // TODO: if N protocols grows large, replace Promise.all fan-out with a batched query
  const perProtocolEntries = await Promise.all(
    protocolsWithTrainings.map(async (protocol) => {
      const entries = await resolveProtocolWorkout(
        protocol,
        userId,
        todayWeekday,
        today,
        timeZone,
      );

      const protocolSummary = {
        id: protocol.id,
        name: protocol.name,
        startDate: formatDateOnly(protocol.startDate),
        expirationDate: formatDateOnly(protocol.expirationDate),
      };

      return entries.map(({ targetTraining, isRestDay, nextScheduledDate }) => ({
        protocol: protocolSummary,
        targetTraining,
        isRestDay,
        nextScheduledDate,
      }));
    }),
  );

  const workoutEntries = perProtocolEntries.flat();

  return { workouts: workoutEntries, pendingTraining };
}
