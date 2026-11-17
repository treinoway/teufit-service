import {
  WEIGHT_TRAINING_MET,
  WEIGHT_TRAINING_NAME,
  DEFAULT_SESSION_MINUTES,
  DAYS_PER_WEEK,
  TRAINING_SESSIONS_LOOKBACK,
} from '../constants/nutrition.js';
import { requirePatientLink } from './nutritionist-patient-service.js';

const SECONDS_PER_MINUTE = 60;
const ACTIVE_PROTOCOL_STATUS = 'active';
const COMPLETED_SESSION_STATUS = 'completed';

// Average of a list of numbers (0 when empty).
function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Sessions per week: distinct week days of the protocol trainings.
function sessionsPerWeek(trainings) {
  const weekDays = new Set(trainings.map((training) => training.weekDay).filter(Boolean));
  return weekDays.size > 0 ? weekDays.size : Math.min(trainings.length, DAYS_PER_WEEK);
}

// Average session minutes: recent sessions first, then the estimated training durations.
function averageMinutes(sessions, trainings) {
  const sessionSeconds = sessions.map((session) => session.durationSeconds).filter((seconds) => seconds > 0);
  const estimatedSeconds = trainings.map((training) => training.estimatedDurationSeconds).filter((seconds) => seconds > 0);
  const seconds = average(sessionSeconds.length > 0 ? sessionSeconds : estimatedSeconds);
  return seconds > 0 ? Math.round(seconds / SECONDS_PER_MINUTE) : DEFAULT_SESSION_MINUTES;
}

// Loads the recent completed sessions of the protocol.
function findRecentSessions(prisma, { patientId, protocolId }) {
  return prisma.workoutSession.findMany({
    where: {
      userId: patientId,
      status: COMPLETED_SESSION_STATUS,
      durationSeconds: { gt: 0 },
      training: { trainingProtocolId: protocolId },
    },
    orderBy: { startedAt: 'desc' },
    take: TRAINING_SESSIONS_LOOKBACK,
    select: { durationSeconds: true },
  });
}

/**
 * Suggests the weight-training activity of the patient from the active training protocol.
 *
 * @returns {Promise<{ items: Array<{ name: string, met: number, minutes: number, perWeek: number }> }>}
 */
export async function suggestActivitiesFromTraining(prisma, { patientId }) {
  const protocol = await prisma.trainingProtocol.findFirst({
    where: { assigneeId: patientId, status: ACTIVE_PROTOCOL_STATUS, deletedAt: null },
    orderBy: { startDate: 'desc' },
    include: { trainings: { where: { deletedAt: null } } },
  });
  if (!protocol || protocol.trainings.length === 0) return { items: [] };

  const sessions = await findRecentSessions(prisma, { patientId, protocolId: protocol.id });
  return {
    items: [
      {
        name: WEIGHT_TRAINING_NAME,
        met: WEIGHT_TRAINING_MET,
        minutes: averageMinutes(sessions, protocol.trainings),
        perWeek: sessionsPerWeek(protocol.trainings),
      },
    ],
  };
}

/**
 * Training-based activity suggestion for a patient linked to the nutritionist (404 otherwise).
 */
export async function listTrainingActivities(prisma, { nutritionistId, patientId }) {
  await requirePatientLink(prisma, { nutritionistId, patientId });
  return suggestActivitiesFromTraining(prisma, { patientId });
}
