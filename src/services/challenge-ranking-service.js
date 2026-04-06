import { AppError } from '../errors/app-error.js';
import { ChallengeErrorCode, ChallengeMessageCode } from '../constants/challenge.js';
import { getDateOnlyAsMidnightUtc } from '../helpers/date-helpers.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Load a challenge by ID, verifying it belongs to the given trainer.
 */
async function resolveChallenge(prisma, challengeId, trainerId) {
  const challenge = await prisma.challenge.findUnique({
    where: { id: challengeId },
  });

  if (!challenge) {
    throw new AppError({
      httpStatus: 404,
      error: ChallengeErrorCode.CHALLENGE_NOT_FOUND,
      messageCode: ChallengeMessageCode.CHALLENGE_NOT_FOUND,
      message: 'Challenge not found',
    });
  }

  if (challenge.trainerId !== trainerId) {
    throw new AppError({
      httpStatus: 403,
      error: ChallengeErrorCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      messageCode: ChallengeMessageCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      message: 'You do not own this challenge',
    });
  }

  return challenge;
}

/**
 * Load a challenge by ID, verifying the requesting student is a participant.
 */
async function resolveChallengeForStudent(prisma, challengeId, studentId) {
  const challenge = await prisma.challenge.findUnique({
    where: { id: challengeId },
  });

  if (!challenge) {
    throw new AppError({
      httpStatus: 404,
      error: ChallengeErrorCode.CHALLENGE_NOT_FOUND,
      messageCode: ChallengeMessageCode.CHALLENGE_NOT_FOUND,
      message: 'Challenge not found',
    });
  }

  const participant = await prisma.challengeParticipant.findUnique({
    where: { challengeId_studentId: { challengeId, studentId } },
  });

  if (!participant) {
    throw new AppError({
      httpStatus: 403,
      error: ChallengeErrorCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      messageCode: ChallengeMessageCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      message: 'You are not a participant in this challenge',
    });
  }

  return challenge;
}

/**
 * Compute challenge ranking entries.
 *
 * Boundary math:
 *   - windowStart = startDate @ 00:00:00.000 UTC (inclusive)
 *   - windowEnd   = (endDate + 1 day) @ 00:00:00.000 UTC (exclusive)
 *
 * This means a transaction timestamped exactly at startDate 00:00:00 UTC counts,
 * and one at endDate 23:59:59 UTC also counts. A transaction at (endDate+1) 00:00:00 does not.
 *
 * We use getDateOnlyAsMidnightUtc() — NOT parseDateOnlyAsUtc() — to get precise
 * midnight boundaries. parseDateOnlyAsUtc() stores at noon to avoid timezone shifts
 * in @db.Date fields; we need the actual midnight boundary here.
 */
async function computeChallengeRankingEntries(prisma, challenge, requestingStudentId, anonymousRanking) {
  const windowStart = getDateOnlyAsMidnightUtc(challenge.startDate);

  // endDate boundary is exclusive: we want all transactions BEFORE (endDate+1)@midnight
  const endDatePlusOne = new Date(challenge.endDate);
  endDatePlusOne.setUTCDate(endDatePlusOne.getUTCDate() + 1);
  const windowEnd = getDateOnlyAsMidnightUtc(endDatePlusOne);

  // Fetch all participant IDs
  const participantRows = await prisma.challengeParticipant.findMany({
    where: { challengeId: challenge.id },
    select: { studentId: true },
  });

  const participantIds = participantRows.map((p) => p.studentId);

  if (participantIds.length === 0) {
    return [];
  }

  // Aggregate points for each participant within the challenge window
  // Filter by challengeId (transactions are now challenge-scoped, not trainer-scoped)
  const grouped = await prisma.pointTransaction.groupBy({
    by: ['studentId'],
    where: {
      challengeId: challenge.id,
      studentId: { in: participantIds },
      createdAt: {
        gte: windowStart,
        lt: windowEnd,
      },
    },
    _sum: { points: true },
    _min: { createdAt: true },
  });

  // Build a map of points and tiebreaker for participants who scored
  const scoredMap = Object.fromEntries(
    grouped.map((g) => [
      g.studentId,
      { points: g._sum.points ?? 0, firstTransactionAt: g._min.createdAt ?? null },
    ]),
  );

  // Every participant appears in the ranking — those with 0 go to the bottom
  const allEntries = participantIds.map((studentId) => ({
    studentId,
    points: scoredMap[studentId]?.points ?? 0,
    firstTransactionAt: scoredMap[studentId]?.firstTransactionAt ?? null,
  }));

  // Sort: points desc, then first-transaction asc (tiebreaker), then 0-point entries last
  allEntries.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    // Both scored: whoever accumulated first wins
    if (a.firstTransactionAt && b.firstTransactionAt) {
      return a.firstTransactionAt.getTime() - b.firstTransactionAt.getTime();
    }
    // Participant with no transactions goes after those with transactions
    if (a.firstTransactionAt) return -1;
    if (b.firstTransactionAt) return 1;
    return 0;
  });

  // Fetch student details
  const students = await prisma.user.findMany({
    where: { id: { in: participantIds } },
    select: { id: true, firstName: true, lastName: true, avatarUrl: true },
  });

  const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));

  return allEntries.map((entry, index) => {
    const student = studentMap[entry.studentId];
    const position = index + 1;
    const isRequester = entry.studentId === requestingStudentId;

    return {
      position,
      studentId: entry.studentId,
      firstName: anonymousRanking && !isRequester
        ? `Aluno #${position}`
        : (student?.firstName ?? null),
      lastName: anonymousRanking && !isRequester ? null : (student?.lastName ?? null),
      avatarUrl: anonymousRanking && !isRequester ? null : (student?.avatarUrl ?? null),
      points: entry.points,
    };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the ranking for a challenge (trainer-facing).
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.trainerUserId
 * @param {string} deps.challengeId
 * @returns {Promise<object[]>}
 */
export async function getChallengeRankingForTrainer({ prisma, trainerUserId, challengeId }) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId: trainerUserId },
    select: { id: true },
  });

  if (!trainer) {
    throw new AppError({
      httpStatus: 404,
      error: ChallengeErrorCode.TRAINER_PROFILE_MISSING,
      messageCode: ChallengeMessageCode.TRAINER_PROFILE_MISSING,
      message: 'Trainer profile not found',
    });
  }

  const challenge = await resolveChallenge(prisma, challengeId, trainer.id);

  // anonymousRanking is snapshotted on the challenge at creation time
  const anonymousRanking = challenge.anonymousRanking ?? false;

  return computeChallengeRankingEntries(prisma, challenge, null, anonymousRanking);
}

/**
 * Get the ranking for a challenge (student-facing).
 * Includes the student's own position highlighted.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.studentId - userId of the student
 * @param {string} deps.challengeId
 * @returns {Promise<{ entries: object[], myPosition: number|null, myPoints: number }>}
 */
export async function getChallengeRankingForStudent({ prisma, studentId, challengeId }) {
  const challenge = await resolveChallengeForStudent(prisma, challengeId, studentId);

  // anonymousRanking is snapshotted on the challenge at creation time
  const anonymousRanking = challenge.anonymousRanking ?? false;

  const entries = await computeChallengeRankingEntries(prisma, challenge, studentId, anonymousRanking);

  const myEntry = entries.find((e) => e.studentId === studentId);

  return {
    entries,
    myPosition: myEntry?.position ?? null,
    myPoints: myEntry?.points ?? 0,
  };
}
