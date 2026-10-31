import { DEFAULT_LOCALE } from '../i18n/constants.js';
import { translate, translateTemplate } from '../i18n/index.js';
import { PushEventType, fcmStaleTokenCodes } from '../constants/mobile-app.js';

const PUSH_NAMESPACE = 'push';

const PushCopyKey = Object.freeze({
  [PushEventType.WORKOUT_COMPLETED]: {
    title: 'workoutCompletedTitle',
    body: 'workoutCompletedBody',
  },
  [PushEventType.ANAMNESIS_SUBMITTED]: {
    title: 'anamnesisSubmittedTitle',
    body: 'anamnesisSubmittedBody',
  },
});

/**
 * Lists the user ids of the active trainers linked to the student, optionally only the given trainer.
 */
async function findTrainerUserIds(prisma, studentId, trainerId) {
  const links = await prisma.trainerStudent.findMany({
    where: {
      studentId,
      activeOnPlan: true,
      trainer: { deletedAt: null },
      ...(trainerId ? { trainerId } : {}),
    },
    select: { trainer: { select: { userId: true } } },
  });

  return links.map((link) => link.trainer.userId);
}

/**
 * Builds the student's display name for the push text, with a localized fallback.
 */
async function resolveStudentName(prisma, studentId) {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { firstName: true, lastName: true },
  });
  const fullName = [student?.firstName, student?.lastName].filter(Boolean).join(' ');

  return fullName || translate(PUSH_NAMESPACE, 'studentFallbackName', DEFAULT_LOCALE);
}

/**
 * Builds the notification title and body; carries only the student name and the event.
 */
function buildNotification(eventType, studentName) {
  const keys = PushCopyKey[eventType];

  return {
    title: translate(PUSH_NAMESPACE, keys.title, DEFAULT_LOCALE),
    body: translateTemplate(PUSH_NAMESPACE, keys.body, DEFAULT_LOCALE, { studentName }),
  };
}

/**
 * Tells whether an FCM failure means the token will never work again.
 */
function isStaleTokenError(error) {
  return fcmStaleTokenCodes.includes(error?.code);
}

/**
 * Sends to one device; drops the token when FCM says it is dead, logs any other failure.
 */
async function deliverToDevice({ prisma, fcmClient, logger }, device, message) {
  try {
    await fcmClient.sendToToken({ ...message, token: device.token });
  } catch (error) {
    if (!isStaleTokenError(error)) {
      logger.warn({ err: error }, 'trainer-push: delivery failed');
      return;
    }
    await prisma.device.deleteMany({ where: { token: device.token } });
  }
}

/**
 * Resolves the student's trainers and fans the event out to their devices.
 */
async function dispatch(dependencies, { studentId, trainerId, eventType, dataIds }) {
  const { prisma } = dependencies;
  const trainerUserIds = await findTrainerUserIds(prisma, studentId, trainerId);
  if (trainerUserIds.length === 0) return;

  const devices = await prisma.device.findMany({ where: { userId: { in: trainerUserIds } } });
  if (devices.length === 0) return;

  const studentName = await resolveStudentName(prisma, studentId);
  const message = {
    notification: buildNotification(eventType, studentName),
    data: { type: eventType, studentId, ...dataIds },
  };

  await Promise.allSettled(devices.map((device) => deliverToDevice(dependencies, device, message)));
}

/**
 * Runs the dispatch and swallows every failure so the main operation is never affected.
 */
async function safeDispatch(dependencies, event) {
  try {
    await dispatch(dependencies, event);
  } catch (error) {
    dependencies.logger.warn({ err: error, eventType: event.eventType }, 'trainer-push: dispatch failed');
  }
}

/**
 * Builds the trainer push notifier; its methods never throw.
 *
 * @param {{ prisma: object, fcmClient: { sendToToken: Function }, logger?: object }} dependencies
 */
export function createTrainerPushService({ prisma, fcmClient, logger = console }) {
  const dependencies = { prisma, fcmClient, logger };

  return {
    notifyWorkoutCompleted: ({ studentId, sessionId }) =>
      safeDispatch(dependencies, {
        studentId,
        eventType: PushEventType.WORKOUT_COMPLETED,
        dataIds: { sessionId },
      }),
    notifyAnamnesisSubmitted: ({ studentId, anamnesisId, trainerId }) =>
      safeDispatch(dependencies, {
        studentId,
        trainerId,
        eventType: PushEventType.ANAMNESIS_SUBMITTED,
        dataIds: { anamnesisId },
      }),
  };
}
