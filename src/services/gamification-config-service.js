import { AppError } from '../errors/app-error.js';
import {
  DEFAULT_POINT_VALUES,
  DEFAULT_STREAK_TOLERANCE_HOURS,
  GamificationErrorCode,
  GamificationMessageCode,
} from '../constants/gamification.js';

/**
 * Resolve the trainer record by userId. Throws if not found.
 */
async function resolveTrainer(prisma, userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new AppError({
      httpStatus: 404,
      error: GamificationErrorCode.TRAINER_PROFILE_MISSING,
      messageCode: GamificationMessageCode.TRAINER_PROFILE_MISSING,
      message: 'Trainer profile not found',
    });
  }

  return trainer;
}

/**
 * Fill null config fields with system defaults so callers always get a complete
 * config object without needing to handle null checks everywhere.
 */
function applyDefaults(config) {
  return {
    ...config,
    ptsWorkoutCompleted: config.ptsWorkoutCompleted ?? DEFAULT_POINT_VALUES.workout_completed,
    ptsStreak7Days: config.ptsStreak7Days ?? DEFAULT_POINT_VALUES.streak_7_days,
    ptsStreak30Days: config.ptsStreak30Days ?? DEFAULT_POINT_VALUES.streak_30_days,
    ptsDailyCheckin: config.ptsDailyCheckin ?? DEFAULT_POINT_VALUES.daily_checkin,
    ptsEvolutionRecord: config.ptsEvolutionRecord ?? DEFAULT_POINT_VALUES.evolution_record,
    ptsWorkoutFeedback: config.ptsWorkoutFeedback ?? DEFAULT_POINT_VALUES.workout_feedback,
    streakToleranceHours: config.streakToleranceHours ?? DEFAULT_STREAK_TOLERANCE_HOURS,
  };
}

/**
 * Upsert a trainer's gamification config.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.trainerId - Trainer record ID (not userId)
 * @param {object} deps.data
 * @returns {Promise<object>}
 */
export async function upsertConfig({ prisma, trainerId, data }) {
  const config = await prisma.gamificationConfig.upsert({
    where: { trainerId },
    create: {
      trainerId,
      enabled: data.enabled ?? true,
      ptsWorkoutCompleted: data.ptsWorkoutCompleted ?? null,
      ptsStreak7Days: data.ptsStreak7Days ?? null,
      ptsStreak30Days: data.ptsStreak30Days ?? null,
      ptsDailyCheckin: data.ptsDailyCheckin ?? null,
      ptsEvolutionRecord: data.ptsEvolutionRecord ?? null,
      ptsWorkoutFeedback: data.ptsWorkoutFeedback ?? null,
      dailyPointsCap: data.dailyPointsCap ?? null,
      streakToleranceHours: data.streakToleranceHours ?? DEFAULT_STREAK_TOLERANCE_HOURS,
      anonymousRanking: data.anonymousRanking ?? false,
    },
    update: {
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      ...(data.ptsWorkoutCompleted !== undefined && { ptsWorkoutCompleted: data.ptsWorkoutCompleted }),
      ...(data.ptsStreak7Days !== undefined && { ptsStreak7Days: data.ptsStreak7Days }),
      ...(data.ptsStreak30Days !== undefined && { ptsStreak30Days: data.ptsStreak30Days }),
      ...(data.ptsDailyCheckin !== undefined && { ptsDailyCheckin: data.ptsDailyCheckin }),
      ...(data.ptsEvolutionRecord !== undefined && { ptsEvolutionRecord: data.ptsEvolutionRecord }),
      ...(data.ptsWorkoutFeedback !== undefined && { ptsWorkoutFeedback: data.ptsWorkoutFeedback }),
      ...(data.dailyPointsCap !== undefined && { dailyPointsCap: data.dailyPointsCap }),
      ...(data.streakToleranceHours !== undefined && { streakToleranceHours: data.streakToleranceHours }),
      ...(data.anonymousRanking !== undefined && { anonymousRanking: data.anonymousRanking }),
    },
  });

  return applyDefaults(config);
}

/**
 * Get a trainer's gamification config with system defaults applied.
 * Returns a synthesized config with defaults if none has been created yet.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.trainerId - Trainer record ID
 * @returns {Promise<object>}
 */
export async function getConfig({ prisma, trainerId }) {
  const config = await prisma.gamificationConfig.findUnique({
    where: { trainerId },
  });

  if (!config) {
    // Return a virtual default config — the trainer simply hasn't customized yet
    return applyDefaults({
      id: null,
      trainerId,
      enabled: true,
      ptsWorkoutCompleted: null,
      ptsStreak7Days: null,
      ptsStreak30Days: null,
      ptsDailyCheckin: null,
      ptsEvolutionRecord: null,
      ptsWorkoutFeedback: null,
      dailyPointsCap: null,
      streakToleranceHours: DEFAULT_STREAK_TOLERANCE_HOURS,
      anonymousRanking: false,
      createdAt: null,
      updatedAt: null,
    });
  }

  return applyDefaults(config);
}

/**
 * Upsert a trainer's gamification config by userId.
 * Route-layer convenience wrapper that resolves the trainer record first.
 */
export async function upsertConfigByUserId({ prisma, userId, data }) {
  const trainer = await resolveTrainer(prisma, userId);
  return upsertConfig({ prisma, trainerId: trainer.id, data });
}

/**
 * Get a trainer's gamification config by userId.
 */
export async function getConfigByUserId({ prisma, userId }) {
  const trainer = await resolveTrainer(prisma, userId);
  return getConfig({ prisma, trainerId: trainer.id });
}
