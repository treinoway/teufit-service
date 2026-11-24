import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import { ChallengeErrorCode, ChallengeFormat, ChallengeMessageCode, ChallengeVisibility } from '../constants/challenge.js';
import { ANONYMOUS_DISPLAY_NAME } from '../constants/consistency-ranking.js';
import { PointAction } from '../constants/gamification.js';
import { effectiveVisibility, isHidden, isMinor } from '../helpers/consistency-anonymize.js';
import { weekStartFor } from '../helpers/consistency-week.js';
import { civilDateInTimeZone, getDateOnlyAsMidnightUtc, zonedWallClockToInstant } from '../helpers/date-helpers.js';
import { getConfig } from './consistency-config-service.js';
import { privacyByStudent } from './consistency-privacy-service.js';

const MS_PER_DAY = 86400000;

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

// Transaction window of a challenge: startDate 00:00 UTC inclusive to (endDate + 1 day) 00:00 UTC exclusive
function challengeWindow(challenge) {
  const endDatePlusOne = new Date(challenge.endDate);
  endDatePlusOne.setUTCDate(endDatePlusOne.getUTCDate() + 1);
  return { windowStart: getDateOnlyAsMidnightUtc(challenge.startDate), windowEnd: getDateOnlyAsMidnightUtc(endDatePlusOne) };
}

// Midnight-UTC day number of a civil date, so consecutive days differ by one
function dayNumber({ year, month, day }) {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

// Consecutive civil days with a completed workout, ending today or yesterday
function streakDaysOf(workoutInstants, timeZone, now) {
  const days = new Set(workoutInstants.map((instant) => dayNumber(civilDateInTimeZone(instant, timeZone))));
  const today = dayNumber(civilDateInTimeZone(now, timeZone));
  let day = days.has(today) ? today : today - 1;
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day -= 1;
  }
  return streak;
}

// Workouts, bonus points, points since Monday 00:00 (trainer timezone) and workout streak days per student, inside the challenge window
async function trainerFigures(prisma, challenge, studentIds, { timeZone, now }) {
  const { windowStart, windowEnd } = challengeWindow(challenge);
  const monday = zonedWallClockToInstant(weekStartFor(now, timeZone), timeZone);
  const weekStart = monday.getTime() > windowStart.getTime() ? monday : windowStart;
  const scope = { challengeId: challenge.id, studentId: { in: studentIds } };
  const [byAction, thisWeek, workoutRows] = await Promise.all([
    prisma.pointTransaction.groupBy({
      by: ['studentId', 'action'],
      where: { ...scope, action: { in: [PointAction.WORKOUT_COMPLETED, PointAction.TRAINER_BONUS] }, createdAt: { gte: windowStart, lt: windowEnd } },
      _sum: { points: true },
      _count: { _all: true },
    }),
    prisma.pointTransaction.groupBy({
      by: ['studentId'],
      where: { ...scope, createdAt: { gte: weekStart, lt: windowEnd } },
      _sum: { points: true },
    }),
    prisma.pointTransaction.findMany({
      where: { ...scope, action: PointAction.WORKOUT_COMPLETED, createdAt: { gte: windowStart, lt: windowEnd } },
      select: { studentId: true, createdAt: true },
    }),
  ]);
  return new Map(studentIds.map((studentId) => {
    const ofAction = (action) => byAction.find((row) => row.studentId === studentId && row.action === action);
    const workoutInstants = workoutRows.filter((row) => row.studentId === studentId).map((row) => row.createdAt);
    return [studentId, {
      workouts: ofAction(PointAction.WORKOUT_COMPLETED)?._count._all ?? 0,
      bonusPoints: ofAction(PointAction.TRAINER_BONUS)?._sum.points ?? 0,
      pointsThisWeek: thisWeek.find((row) => row.studentId === studentId)?._sum.points ?? 0,
      streakDays: streakDaysOf(workoutInstants, timeZone, now),
    }];
  }));
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
  const { windowStart, windowEnd } = challengeWindow(challenge);

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

// Entry of the weekly points ranking as the viewer sees it: own row as is, a colleague with an opaque id and hidden by the constancy rules
function weeklyEntryOf(entry, { viewerId, minorIds, privacies, anonymousRanking }) {
  if (entry.studentId === viewerId) return { ...entry, isMe: true };
  const hidden = isHidden({ privacy: privacies.get(entry.studentId), isMinor: minorIds.has(entry.studentId), anonymousRanking });
  return {
    ...entry,
    studentId: randomUUID(),
    firstName: hidden ? ANONYMOUS_DISPLAY_NAME : entry.firstName,
    lastName: hidden ? null : entry.lastName,
    avatarUrl: hidden ? null : entry.avatarUrl,
    isMe: false,
  };
}

// Ids of the listed students under 18 on the trainer's civil day
async function minorIdsOf(prisma, challenge, studentIds, now) {
  const { timeZone } = await getConfig(prisma, challenge.trainerId, now);
  const today = civilDateInTimeZone(now, timeZone);
  const users = await prisma.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, birthDate: true } });
  return new Set(users.filter((user) => isMinor(user.birthDate ?? null, today)).map((user) => user.id));
}

// Points ranking of a weekly championship with the constancy privacy and visibility: own row only with "Só a posição", nothing with "Desligado" (APP-74, AD-077)
async function weeklyStudentRanking(prisma, challenge, studentId, entries, now) {
  const myEntry = entries.find((entry) => entry.studentId === studentId);
  const myPoints = myEntry?.points ?? 0;
  const ids = entries.map((entry) => entry.studentId);
  const [minorIds, privacies] = await Promise.all([minorIdsOf(prisma, challenge, ids, now), privacyByStudent(prisma, ids)]);
  const visibility = effectiveVisibility(challenge.visibility, minorIds.has(studentId));
  if (visibility === ChallengeVisibility.OFF) return { entries: [], myPosition: null, myPoints };
  const visible = visibility === ChallengeVisibility.FULL ? entries : entries.filter((entry) => entry === myEntry);
  const context = { viewerId: studentId, minorIds, privacies, anonymousRanking: challenge.anonymousRanking ?? false };
  return { entries: visible.map((entry) => weeklyEntryOf(entry, context)), myPosition: myEntry?.position ?? null, myPoints };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the ranking for a challenge (trainer-facing).
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.trainerUserId
 * @param {string} deps.challengeId
 * @param {Date} [deps.now]
 * @returns {Promise<object[]>} entries with workouts, bonusPoints, pointsThisWeek and streakDays
 */
export async function getChallengeRankingForTrainer({ prisma, trainerUserId, challengeId, now = new Date() }) {
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

  const entries = await computeChallengeRankingEntries(prisma, challenge, null, anonymousRanking);
  if (entries.length === 0) return entries;
  const { timeZone } = await getConfig(prisma, trainer.id, now);
  const figures = await trainerFigures(prisma, challenge, entries.map((entry) => entry.studentId), { timeZone, now });
  return entries.map((entry) => ({ ...entry, ...figures.get(entry.studentId) }));
}

/**
 * Get the ranking for a challenge (student-facing).
 * Includes the student's own position highlighted; a weekly championship follows the constancy privacy and visibility (APP-74).
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.studentId - userId of the student
 * @param {string} deps.challengeId
 * @param {Date} [deps.now]
 * @returns {Promise<{ entries: object[], myPosition: number|null, myPoints: number }>}
 */
export async function getChallengeRankingForStudent({ prisma, studentId, challengeId, now = new Date() }) {
  const challenge = await resolveChallengeForStudent(prisma, challengeId, studentId);

  if (challenge.format === ChallengeFormat.WEEKS) {
    const entries = await computeChallengeRankingEntries(prisma, challenge, studentId, false);
    return weeklyStudentRanking(prisma, challenge, studentId, entries, now);
  }

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
