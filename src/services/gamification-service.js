import { AppError } from '../errors/app-error.js';
import {
  ACTION_TO_CONFIG_FIELD,
  DEFAULT_POINT_VALUES,
  GamificationErrorCode,
  GamificationMessageCode,
  PointAction,
} from '../constants/gamification.js';
import { ChallengeStatus } from '../constants/challenge.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute the start of the current calendar day in UTC.
 * Used for daily-cap checks.
 */
function todayMidnightUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
}

/**
 * Derive the status of a challenge from its stored fields.
 * Duplicated from challenge-service to avoid circular dependency.
 */
function deriveChallengeStatus(challenge) {
  if (challenge.cancelledAt) return ChallengeStatus.CANCELLED;

  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

  const startMidnight = new Date(Date.UTC(
    challenge.startDate.getUTCFullYear(),
    challenge.startDate.getUTCMonth(),
    challenge.startDate.getUTCDate(),
    0, 0, 0,
  ));
  const endMidnight = new Date(Date.UTC(
    challenge.endDate.getUTCFullYear(),
    challenge.endDate.getUTCMonth(),
    challenge.endDate.getUTCDate(),
    0, 0, 0,
  ));

  if (todayUtc < startMidnight) return ChallengeStatus.SCHEDULED;
  if (todayUtc <= endMidnight) return ChallengeStatus.ACTIVE;
  return ChallengeStatus.COMPLETED;
}

/**
 * Return the effective point value for an action given a challenge's snapshotted config.
 * - null config field → use system default
 * - 0 → action disabled (returns 0, caller must check)
 */
export function resolvePointValue(challengeConfig, action) {
  if (action === PointAction.TRAINER_BONUS) {
    // Bonus points are provided explicitly by the trainer; no config field
    return null;
  }

  const configField = ACTION_TO_CONFIG_FIELD[action];
  if (!configField) return DEFAULT_POINT_VALUES[action] ?? 0;

  const configuredValue = challengeConfig?.[configField];
  return configuredValue !== null && configuredValue !== undefined
    ? configuredValue
    : (DEFAULT_POINT_VALUES[action] ?? 0);
}

/**
 * Compute total points earned today by a student for a given challenge.
 * Used to enforce the per-challenge daily cap.
 */
async function getDailyPointsForChallenge(prisma, studentId, challengeId) {
  const result = await prisma.pointTransaction.aggregate({
    where: {
      studentId,
      challengeId,
      createdAt: { gte: todayMidnightUtc() },
    },
    _sum: { points: true },
  });

  return result._sum.points ?? 0;
}

/**
 * Award points for a single challenge.
 * Returns the created PointTransaction, or null if skipped.
 */
async function awardPointsForChallenge({ client, studentId, trainerId, challengeId, challenge, action, referenceId, bonusPoints, reason }) {
  let points;
  if (action === PointAction.TRAINER_BONUS) {
    points = bonusPoints;
  } else {
    points = resolvePointValue(challenge, action);
    if (points === 0) return null; // action disabled for this challenge
  }

  if (!points || points <= 0) return null;

  // Daily cap check (per challenge)
  if (challenge.dailyPointsCap) {
    const dailyTotal = await getDailyPointsForChallenge(client, studentId, challengeId);
    const remaining = challenge.dailyPointsCap - dailyTotal;
    if (remaining <= 0) return null;
    points = Math.min(points, remaining);
  }

  let transaction;
  try {
    transaction = await client.pointTransaction.create({
      data: {
        studentId,
        trainerId,
        challengeId,
        action,
        points,
        referenceId: referenceId ?? null,
        reason: reason ?? null,
      },
    });
  } catch (err) {
    // P2002 = unique constraint violation → duplicate award for this challenge, skip silently
    if (err?.code === 'P2002') return null;
    throw err;
  }

  // Atomically upsert PointBalance (cross-challenge total per student+trainer)
  await client.pointBalance.upsert({
    where: { studentId_trainerId: { studentId, trainerId } },
    create: { studentId, trainerId, totalPoints: points },
    update: { totalPoints: { increment: points } },
  });

  return transaction;
}

// ─── Core award logic ─────────────────────────────────────────────────────────

/**
 * Find all active challenges a student participates in for a given trainer.
 * Returns challenge records (with snapshotted pts fields).
 */
async function findActiveStudentChallenges(prisma, studentId, trainerId) {
  const participations = await prisma.challengeParticipant.findMany({
    where: { studentId },
    select: {
      challenge: {
        select: {
          id: true,
          trainerId: true,
          startDate: true,
          endDate: true,
          cancelledAt: true,
          ptsWorkoutCompleted: true,
          ptsStreak7Days: true,
          ptsStreak30Days: true,
          ptsDailyCheckin: true,
          ptsEvolutionRecord: true,
          ptsWorkoutFeedback: true,
          dailyPointsCap: true,
        },
      },
    },
  });

  return participations
    .map((p) => p.challenge)
    .filter((c) => c.trainerId === trainerId && deriveChallengeStatus(c) === ChallengeStatus.ACTIVE);
}

/**
 * Award points for an action across all active challenges a student is enrolled in
 * for a given trainer. Creates one PointTransaction per active challenge.
 * Idempotent via the (action, referenceId, challengeId) unique constraint.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.studentId
 * @param {string} deps.trainerId - Trainer record ID
 * @param {string} deps.action - PointAction value
 * @param {string|null} deps.referenceId
 * @param {import('@prisma/client').PrismaClient|null} deps.tx - Optional transaction client
 * @returns {Promise<object[]>} Created PointTransactions (may be empty if no active challenges)
 */
export async function awardPoints({ prisma, studentId, trainerId, action, referenceId = null, tx = null }) {
  const client = tx ?? prisma;

  // Check if gamification is globally disabled for this trainer
  const config = await client.gamificationConfig.findUnique({
    where: { trainerId },
    select: { enabled: true },
  });

  if (config && !config.enabled) return [];

  const activeChallenges = await findActiveStudentChallenges(client, studentId, trainerId);

  if (activeChallenges.length === 0) return [];

  // Process challenges sequentially to avoid PointBalance upsert race conditions
  // when a student participates in multiple active challenges simultaneously.
  const results = [];
  for (const challenge of activeChallenges) {
    const transaction = await awardPointsForChallenge({
      client,
      studentId,
      trainerId,
      challengeId: challenge.id,
      challenge,
      action,
      referenceId,
      bonusPoints: null,
      reason: null,
    });
    if (transaction) results.push(transaction);
  }

  return results;
}

// ─── Workout completion trigger ────────────────────────────────────────────────

/**
 * Award workout completion points across all active challenges.
 * Resolves the trainer from the WorkoutSession → Training → TrainingProtocol chain.
 * Fire-and-forget safe: never throws to the caller.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.userId - Student userId
 * @param {object} deps.workoutSession - Completed WorkoutSession record
 */
export async function awardWorkoutCompletionPoints({ prisma, userId, workoutSession }) {
  try {
    const training = await prisma.training.findUnique({
      where: { id: workoutSession.trainingId },
      select: {
        trainingProtocol: {
          select: { trainerId: true },
        },
      },
    });

    if (!training?.trainingProtocol?.trainerId) {
      return;
    }

    const { trainerId } = training.trainingProtocol;

    await awardPoints({
      prisma,
      studentId: userId,
      trainerId,
      action: PointAction.WORKOUT_COMPLETED,
      referenceId: workoutSession.id,
    });
  } catch (err) {
    console.error('Failed to award workout completion points', err);
  }
}

// ─── Student point history ─────────────────────────────────────────────────────

/**
 * Return paginated point transaction history for a student scoped to a challenge.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.studentId
 * @param {string} deps.challengeId
 * @param {number} deps.page
 * @param {number} deps.limit
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number }>}
 */
export async function getStudentPointHistory({ prisma, studentId, challengeId, page = 1, limit = 20 }) {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.pointTransaction.findMany({
      where: { studentId, challengeId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.pointTransaction.count({
      where: { studentId, challengeId },
    }),
  ]);

  return { data: transactions, total, page, limit };
}

/**
 * Return total points and a per-action breakdown for a student within a challenge.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.studentId
 * @param {string} deps.challengeId
 * @returns {Promise<{ totalPoints: number, breakdown: Record<string, number> }>}
 */
export async function getStudentPointSummary({ prisma, studentId, challengeId }) {
  const grouped = await prisma.pointTransaction.groupBy({
    by: ['action'],
    where: { studentId, challengeId },
    _sum: { points: true },
  });

  const breakdown = Object.fromEntries(
    grouped.map((row) => [row.action, row._sum.points ?? 0]),
  );

  const totalPoints = grouped.reduce((sum, row) => sum + (row._sum.points ?? 0), 0);

  return { totalPoints, breakdown };
}

// ─── Manual bonus ─────────────────────────────────────────────────────────────

/**
 * Award a manual bonus to a student within a specific active challenge.
 * Validates trainer ownership, student participation, and challenge active status.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.trainerUserId - userId of the trainer
 * @param {string} deps.challengeId
 * @param {string} deps.studentId - userId of the student
 * @param {number} deps.points
 * @param {string|null} deps.reason
 * @returns {Promise<object>} Created PointTransaction
 */
export async function awardManualBonus({ prisma, trainerUserId, challengeId, studentId, points, reason = null }) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId: trainerUserId },
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

  const challenge = await prisma.challenge.findUnique({
    where: { id: challengeId },
    select: {
      id: true,
      trainerId: true,
      startDate: true,
      endDate: true,
      cancelledAt: true,
      dailyPointsCap: true,
    },
  });

  if (!challenge || challenge.trainerId !== trainer.id) {
    throw new AppError({
      httpStatus: 404,
      error: 'CHALLENGE_NOT_FOUND',
      messageCode: 'challenge.notFound',
      message: 'Challenge not found',
    });
  }

  const challengeStatus = deriveChallengeStatus(challenge);
  if (challengeStatus !== ChallengeStatus.ACTIVE) {
    throw new AppError({
      httpStatus: 400,
      error: GamificationErrorCode.CHALLENGE_NOT_ACTIVE,
      messageCode: GamificationMessageCode.CHALLENGE_NOT_ACTIVE,
      message: 'Bonus points can only be awarded on active challenges',
    });
  }

  const participant = await prisma.challengeParticipant.findUnique({
    where: { challengeId_studentId: { challengeId, studentId } },
  });

  if (!participant) {
    throw new AppError({
      httpStatus: 404,
      error: GamificationErrorCode.STUDENT_NOT_TRAINEE,
      messageCode: GamificationMessageCode.STUDENT_NOT_TRAINEE,
      message: 'Student is not a participant in this challenge',
    });
  }

  // TRAINER_BONUS has no daily cap — pass a challenge object without dailyPointsCap
  const challengeForBonus = { ...challenge, dailyPointsCap: null };

  const transaction = await awardPointsForChallenge({
    client: prisma,
    studentId,
    trainerId: trainer.id,
    challengeId,
    challenge: challengeForBonus,
    action: PointAction.TRAINER_BONUS,
    referenceId: null,
    bonusPoints: points,
    reason,
  });

  return transaction;
}
