import { AppError } from '../errors/app-error.js';
import {
  CHALLENGE_MAX_DURATION_DAYS,
  ChallengeErrorCode,
  ChallengeMessageCode,
  ChallengeParticipantMode,
  ChallengeStatus,
} from '../constants/challenge.js';
import { formatDateOnly, parseDateOnlyAsUtc } from '../helpers/date-helpers.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the trainer record for the authenticated user.
 */
async function resolveTrainer(prisma, userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
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

  return trainer;
}

/**
 * Derive the status of a challenge from its stored fields.
 * Status is not persisted — it is computed on read.
 */
function deriveStatus(challenge) {
  if (challenge.cancelledAt) return ChallengeStatus.CANCELLED;

  // NOTE: "today" is computed as server UTC date. This is an MVP simplification.
  // Future work may need to account for trainer timezone preferences.
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

  // startDate and endDate are stored as @db.Date — Prisma returns them as Date objects
  // We compare against midnight UTC boundaries for consistency
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
 * Format a challenge record for API output.
 */
function formatChallenge(challenge, participantCount = undefined) {
  const result = {
    id: challenge.id,
    trainerId: challenge.trainerId,
    name: challenge.name,
    startDate: formatDateOnly(challenge.startDate),
    endDate: formatDateOnly(challenge.endDate),
    status: deriveStatus(challenge),
    participantMode: challenge.participantMode,
    filterCriteria: challenge.filterCriteria ?? null,
    cancelledAt: challenge.cancelledAt ?? null,
    ptsWorkoutCompleted: challenge.ptsWorkoutCompleted ?? null,
    ptsStreak7Days: challenge.ptsStreak7Days ?? null,
    ptsStreak30Days: challenge.ptsStreak30Days ?? null,
    ptsDailyCheckin: challenge.ptsDailyCheckin ?? null,
    ptsEvolutionRecord: challenge.ptsEvolutionRecord ?? null,
    ptsWorkoutFeedback: challenge.ptsWorkoutFeedback ?? null,
    dailyPointsCap: challenge.dailyPointsCap ?? null,
    anonymousRanking: challenge.anonymousRanking ?? false,
    createdAt: challenge.createdAt,
    updatedAt: challenge.updatedAt ?? null,
  };

  if (participantCount !== undefined) {
    result.participantCount = participantCount;
  }

  return result;
}

/**
 * Resolve the pts snapshot for a new challenge.
 * Reads trainer's GamificationConfig and merges with any explicit overrides from data.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId - Trainer record ID
 * @param {object} data - Request body (may include explicit pts overrides)
 * @returns {Promise<object>} Resolved pts fields for the challenge
 */
async function resolveChallengePtsSnapshot(prisma, trainerId, data) {
  const config = await prisma.gamificationConfig.findUnique({
    where: { trainerId },
    select: {
      ptsWorkoutCompleted: true,
      ptsStreak7Days: true,
      ptsStreak30Days: true,
      ptsDailyCheckin: true,
      ptsEvolutionRecord: true,
      ptsWorkoutFeedback: true,
      dailyPointsCap: true,
      anonymousRanking: true,
    },
  });

  // Helper: resolve a single pts field — explicit override > config > null (system default applied at award time)
  function resolveField(fieldName) {
    if (data[fieldName] !== undefined) return data[fieldName];
    if (config?.[fieldName] !== null && config?.[fieldName] !== undefined) return config[fieldName];
    // null means "use system default at award time" — we snapshot null here, not the default
    return null;
  }

  // anonymousRanking is a boolean — false is a valid value, so we use !== undefined check only
  const anonymousRanking = data.anonymousRanking !== undefined
    ? data.anonymousRanking
    : (config?.anonymousRanking ?? false);

  return {
    ptsWorkoutCompleted: resolveField('ptsWorkoutCompleted'),
    ptsStreak7Days: resolveField('ptsStreak7Days'),
    ptsStreak30Days: resolveField('ptsStreak30Days'),
    ptsDailyCheckin: resolveField('ptsDailyCheckin'),
    ptsEvolutionRecord: resolveField('ptsEvolutionRecord'),
    ptsWorkoutFeedback: resolveField('ptsWorkoutFeedback'),
    dailyPointsCap: resolveField('dailyPointsCap'),
    anonymousRanking,
  };
}

/**
 * Compute duration in days (inclusive, i.e., same day = 1 day).
 */
function computeDurationDays(startDate, endDate) {
  const start = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  return Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Validate that the raw YYYY-MM-DD dates are coherent.
 * Also validates CREATE-time constraint: startDate >= today.
 *
 * @param {string} startDateStr
 * @param {string} endDateStr
 * @param {boolean} checkStartInFuture - true on CREATE only
 */
function validateDateRange(startDateStr, endDateStr, checkStartInFuture = false) {
  const startDate = parseDateOnlyAsUtc(startDateStr);
  const endDate = parseDateOnlyAsUtc(endDateStr);

  if (!startDate || !endDate) {
    throw new AppError({
      httpStatus: 400,
      error: ChallengeErrorCode.CHALLENGE_INVALID_DATES,
      messageCode: ChallengeMessageCode.CHALLENGE_INVALID_DATES,
      message: 'Invalid date format. Use YYYY-MM-DD.',
    });
  }

  if (endDate < startDate) {
    throw new AppError({
      httpStatus: 400,
      error: ChallengeErrorCode.CHALLENGE_INVALID_DATES,
      messageCode: ChallengeMessageCode.CHALLENGE_INVALID_DATES,
      message: 'endDate must be on or after startDate',
    });
  }

  const durationDays = computeDurationDays(startDate, endDate);
  if (durationDays > CHALLENGE_MAX_DURATION_DAYS) {
    throw new AppError({
      httpStatus: 400,
      error: ChallengeErrorCode.CHALLENGE_DURATION_EXCEEDED,
      messageCode: ChallengeMessageCode.CHALLENGE_DURATION_EXCEEDED,
      message: `Challenge duration cannot exceed ${CHALLENGE_MAX_DURATION_DAYS} days`,
    });
  }

  if (checkStartInFuture) {
    // Allow 1-day tolerance: the client sends local "today" which may already be
    // "yesterday" in UTC (e.g., 21:00 BRT = 00:00 UTC next day).
    const now = new Date();
    const yesterdayMidnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0));
    const startMidnightUtc = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate(), 0, 0, 0));

    if (startMidnightUtc < yesterdayMidnightUtc) {
      throw new AppError({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_INVALID_DATES,
        messageCode: ChallengeMessageCode.CHALLENGE_INVALID_DATES,
        message: 'startDate cannot be in the past',
      });
    }
  }

  return { startDate, endDate };
}

/**
 * Load a challenge and verify ownership.
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

// ─── Participant resolution ────────────────────────────────────────────────────

/**
 * Resolve all student IDs that match a filter criteria for a trainer.
 * Students missing the filtered field (e.g., no birthDate for age filter) are excluded.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.trainerId - Trainer record ID
 * @param {object} deps.filter
 * @returns {Promise<string[]>} Matching student user IDs
 */
async function resolveFilterParticipants({ prisma, trainerId, filter }) {
  const where = {
    trainers: {
      some: { trainerId },
    },
    deletedAt: null,
  };

  if (filter.gender) {
    where.gender = filter.gender;
  }

  if (filter.minAge !== undefined || filter.maxAge !== undefined) {
    const now = new Date();
    if (filter.maxAge !== undefined) {
      // Student must be at least maxAge → born on or before this date
      const maxAgeDate = new Date(Date.UTC(now.getUTCFullYear() - filter.maxAge, now.getUTCMonth(), now.getUTCDate()));
      where.birthDate = { ...where.birthDate, lte: maxAgeDate };
    }
    if (filter.minAge !== undefined) {
      // Student must not yet have exceeded minAge birthday this year
      const minAgeDate = new Date(Date.UTC(now.getUTCFullYear() - filter.minAge, now.getUTCMonth(), now.getUTCDate()));
      where.birthDate = { ...where.birthDate, gte: minAgeDate };
    }
    // Exclude students without birthDate when age filter is active
    where.birthDate = where.birthDate
      ? { ...where.birthDate, not: null }
      : { not: null };
  }

  if (filter.city || filter.state) {
    where.address = {};
    if (filter.city) where.address.city = filter.city;
    if (filter.state) where.address.state = filter.state;
  }

  const students = await prisma.user.findMany({
    where,
    select: { id: true },
  });

  return students.map((s) => s.id);
}

/**
 * Preview which students would be selected for given mode/filter/studentIds.
 * Safe to call without creating a challenge.
 */
export async function previewParticipants({ prisma, trainerUserId, mode, filter, studentIds }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);

  if (mode === ChallengeParticipantMode.ALL) {
    return resolveFilterParticipants({ prisma, trainerId: trainer.id, filter: {} });
  }

  if (mode === ChallengeParticipantMode.FILTER) {
    return resolveFilterParticipants({ prisma, trainerId: trainer.id, filter: filter ?? {} });
  }

  if (mode === ChallengeParticipantMode.EXPLICIT) {
    // Validate all provided IDs belong to this trainer
    const validStudents = await prisma.trainerStudent.findMany({
      where: {
        trainerId: trainer.id,
        studentId: { in: studentIds ?? [] },
      },
      select: { studentId: true },
    });
    return validStudents.map((s) => s.studentId);
  }

  return [];
}

// ─── Challenge CRUD ────────────────────────────────────────────────────────────

/**
 * Create a challenge and snapshot participants.
 *
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {string} deps.trainerUserId
 * @param {object} deps.data
 */
export async function createChallenge({ prisma, trainerUserId, data }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);

  validateDateRange(data.startDate, data.endDate, true);

  // Resolve participants
  let resolvedStudentIds;
  if (data.participantMode === ChallengeParticipantMode.ALL) {
    resolvedStudentIds = await resolveFilterParticipants({
      prisma,
      trainerId: trainer.id,
      filter: {},
    });
  } else if (data.participantMode === ChallengeParticipantMode.FILTER) {
    resolvedStudentIds = await resolveFilterParticipants({
      prisma,
      trainerId: trainer.id,
      filter: data.filter ?? {},
    });
  } else {
    // EXPLICIT
    if (!data.studentIds?.length) {
      resolvedStudentIds = [];
    } else {
      const valid = await prisma.trainerStudent.findMany({
        where: {
          trainerId: trainer.id,
          studentId: { in: data.studentIds },
        },
        select: { studentId: true },
      });

      const invalidIds = data.studentIds.filter(
        (id) => !valid.some((v) => v.studentId === id),
      );

      if (invalidIds.length > 0) {
        throw new AppError({
          httpStatus: 400,
          error: ChallengeErrorCode.CHALLENGE_PARTICIPANT_NOT_TRAINEE,
          messageCode: ChallengeMessageCode.CHALLENGE_PARTICIPANT_NOT_TRAINEE,
          message: 'Some student IDs are not trainees of this trainer',
          details: { invalidIds },
        });
      }

      resolvedStudentIds = valid.map((v) => v.studentId);
    }
  }

  // Reject filter mode that resolves to 0 participants (explicit and all allow empty)
  if (
    data.participantMode === ChallengeParticipantMode.FILTER &&
    resolvedStudentIds.length === 0
  ) {
    throw new AppError({
      httpStatus: 422,
      error: ChallengeErrorCode.CHALLENGE_FILTER_EMPTY,
      messageCode: ChallengeMessageCode.CHALLENGE_FILTER_EMPTY,
      message: 'The filter criteria matched no students',
    });
  }

  const ptsSnapshot = await resolveChallengePtsSnapshot(prisma, trainer.id, data);

  const challenge = await prisma.$transaction(async (tx) => {
    const created = await tx.challenge.create({
      data: {
        trainerId: trainer.id,
        name: data.name.trim(),
        startDate: parseDateOnlyAsUtc(data.startDate),
        endDate: parseDateOnlyAsUtc(data.endDate),
        participantMode: data.participantMode,
        filterCriteria: data.participantMode === ChallengeParticipantMode.FILTER
          ? (data.filter ?? null)
          : null,
        ...ptsSnapshot,
      },
    });

    if (resolvedStudentIds.length > 0) {
      await tx.challengeParticipant.createMany({
        data: resolvedStudentIds.map((studentId) => ({
          challengeId: created.id,
          studentId,
        })),
        skipDuplicates: true,
      });
    }

    return created;
  });

  // Silently update the trainer's GamificationConfig template with the values used.
  // Fire-and-forget: a failure here must not block the challenge creation response.
  prisma.gamificationConfig.upsert({
    where: { trainerId: trainer.id },
    update: {
      ptsWorkoutCompleted: challenge.ptsWorkoutCompleted,
      ptsStreak7Days: challenge.ptsStreak7Days,
      ptsStreak30Days: challenge.ptsStreak30Days,
      ptsDailyCheckin: challenge.ptsDailyCheckin,
      ptsEvolutionRecord: challenge.ptsEvolutionRecord,
      ptsWorkoutFeedback: challenge.ptsWorkoutFeedback,
      dailyPointsCap: challenge.dailyPointsCap,
      anonymousRanking: challenge.anonymousRanking,
    },
    create: {
      trainerId: trainer.id,
      enabled: true,
      ptsWorkoutCompleted: challenge.ptsWorkoutCompleted,
      ptsStreak7Days: challenge.ptsStreak7Days,
      ptsStreak30Days: challenge.ptsStreak30Days,
      ptsDailyCheckin: challenge.ptsDailyCheckin,
      ptsEvolutionRecord: challenge.ptsEvolutionRecord,
      ptsWorkoutFeedback: challenge.ptsWorkoutFeedback,
      dailyPointsCap: challenge.dailyPointsCap,
      anonymousRanking: challenge.anonymousRanking,
    },
  }).catch(() => {});

  return formatChallenge(challenge, resolvedStudentIds.length);
}

/**
 * List challenges for a trainer with optional status filter.
 */
export async function listChallenges({ prisma, trainerUserId, status }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);

  const challenges = await prisma.challenge.findMany({
    where: { trainerId: trainer.id },
    include: { _count: { select: { participants: true } } },
    orderBy: { startDate: 'desc' },
  });

  const formatted = challenges.map((c) => formatChallenge(c, c._count.participants));

  if (!status) return formatted;

  return formatted.filter((c) => c.status === status);
}

/**
 * Get a single challenge detail.
 */
export async function getChallenge({ prisma, trainerUserId, challengeId }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);
  const challenge = await resolveChallenge(prisma, challengeId, trainer.id);

  const participantCount = await prisma.challengeParticipant.count({
    where: { challengeId },
  });

  return formatChallenge(challenge, participantCount);
}

/**
 * Update a challenge's name and/or endDate.
 * - startDate is locked once the challenge has started
 * - endDate cannot be moved before today
 */
export async function updateChallenge({ prisma, trainerUserId, challengeId, data }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);
  const challenge = await resolveChallenge(prisma, challengeId, trainer.id);

  if (challenge.cancelledAt) {
    throw new AppError({
      httpStatus: 409,
      error: ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED,
      messageCode: ChallengeMessageCode.CHALLENGE_ALREADY_CANCELLED,
      message: 'Cannot update a cancelled challenge',
    });
  }

  const currentStatus = deriveStatus(challenge);

  const updateData = {};

  const PTS_FIELDS = [
    'ptsWorkoutCompleted',
    'ptsStreak7Days',
    'ptsStreak30Days',
    'ptsDailyCheckin',
    'ptsEvolutionRecord',
    'ptsWorkoutFeedback',
    'dailyPointsCap',
    'anonymousRanking',
  ];

  const hasPtsUpdate = PTS_FIELDS.some((field) => data[field] !== undefined);

  if (hasPtsUpdate && currentStatus !== ChallengeStatus.SCHEDULED) {
    throw new AppError({
      httpStatus: 400,
      error: ChallengeErrorCode.CHALLENGE_NOT_SCHEDULABLE,
      messageCode: ChallengeMessageCode.CHALLENGE_NOT_SCHEDULABLE,
      message: 'Point rules can only be changed before the challenge starts.',
    });
  }

  if (hasPtsUpdate) {
    for (const field of PTS_FIELDS) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }
  }

  if (data.name !== undefined) {
    updateData.name = data.name.trim();
  }

  if (data.startDate !== undefined) {
    if (currentStatus !== ChallengeStatus.SCHEDULED) {
      throw new AppError({
        httpStatus: 409,
        error: ChallengeErrorCode.CHALLENGE_ALREADY_STARTED,
        messageCode: ChallengeMessageCode.CHALLENGE_ALREADY_STARTED,
        message: 'Cannot change startDate after the challenge has started',
      });
    }
    updateData.startDate = parseDateOnlyAsUtc(data.startDate);
  }

  if (data.endDate !== undefined) {
    const now = new Date();
    const todayMidnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const newEndDate = parseDateOnlyAsUtc(data.endDate);
    const newEndMidnight = new Date(Date.UTC(newEndDate.getUTCFullYear(), newEndDate.getUTCMonth(), newEndDate.getUTCDate(), 0, 0, 0));

    if (newEndMidnight < todayMidnightUtc) {
      throw new AppError({
        httpStatus: 400,
        error: ChallengeErrorCode.CHALLENGE_INVALID_DATES,
        messageCode: ChallengeMessageCode.CHALLENGE_INVALID_DATES,
        message: 'endDate cannot be moved to a date in the past',
      });
    }

    // IMPORTANT: if you add new updatable date fields here, ensure they are
    // factored into this re-validation — validateDateRange enforces the
    // CHALLENGE_MAX_DURATION_DAYS cap and must be called for every combination.
    const effectiveStartDate = updateData.startDate ?? challenge.startDate;
    const formattedStartDate = formatDateOnly(effectiveStartDate);
    validateDateRange(formattedStartDate, data.endDate, false);
    updateData.endDate = parseDateOnlyAsUtc(data.endDate);
  }

  const updated = await prisma.challenge.update({
    where: { id: challengeId },
    data: updateData,
  });

  const participantCount = await prisma.challengeParticipant.count({
    where: { challengeId },
  });

  return formatChallenge(updated, participantCount);
}

/**
 * Cancel a challenge (sets cancelledAt).
 */
export async function cancelChallenge({ prisma, trainerUserId, challengeId }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);
  const challenge = await resolveChallenge(prisma, challengeId, trainer.id);

  if (challenge.cancelledAt) {
    throw new AppError({
      httpStatus: 409,
      error: ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED,
      messageCode: ChallengeMessageCode.CHALLENGE_ALREADY_CANCELLED,
      message: 'Challenge is already cancelled',
    });
  }

  const currentStatus = deriveStatus(challenge);

  if (currentStatus === ChallengeStatus.COMPLETED) {
    throw new AppError({
      httpStatus: 409,
      error: ChallengeErrorCode.CHALLENGE_ALREADY_ENDED,
      messageCode: ChallengeMessageCode.CHALLENGE_ALREADY_ENDED,
      message: 'Cannot cancel a completed challenge',
    });
  }

  const updated = await prisma.challenge.update({
    where: { id: challengeId },
    data: { cancelledAt: new Date() },
  });

  return formatChallenge(updated);
}

/**
 * Hard-delete a challenge. Only allowed if status is "scheduled".
 */
export async function deleteChallenge({ prisma, trainerUserId, challengeId }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);
  const challenge = await resolveChallenge(prisma, challengeId, trainer.id);

  const currentStatus = deriveStatus(challenge);

  if (currentStatus !== ChallengeStatus.SCHEDULED) {
    throw new AppError({
      httpStatus: 409,
      error: ChallengeErrorCode.CHALLENGE_NOT_DELETABLE,
      messageCode: ChallengeMessageCode.CHALLENGE_NOT_DELETABLE,
      message: 'Only scheduled challenges can be deleted. Cancel active challenges instead.',
    });
  }

  await prisma.challenge.delete({ where: { id: challengeId } });
}

// ─── Participant management ────────────────────────────────────────────────────

/**
 * List participants of a challenge.
 */
export async function listParticipants({ prisma, trainerUserId, challengeId }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);
  await resolveChallenge(prisma, challengeId, trainer.id);

  const participants = await prisma.challengeParticipant.findMany({
    where: { challengeId },
    include: {
      student: {
        select: { id: true, firstName: true, lastName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return participants.map((p) => ({
    id: p.id,
    studentId: p.studentId,
    firstName: p.student.firstName,
    lastName: p.student.lastName,
    avatarUrl: p.student.avatarUrl,
    addedAt: p.createdAt,
  }));
}

/**
 * Bulk-add participants to a challenge.
 * All studentIds must be trainees of the trainer.
 * Throws on any duplicate (409).
 */
export async function addParticipants({ prisma, trainerUserId, challengeId, studentIds }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);
  await resolveChallenge(prisma, challengeId, trainer.id);

  // Validate all IDs are trainees
  const valid = await prisma.trainerStudent.findMany({
    where: {
      trainerId: trainer.id,
      studentId: { in: studentIds },
    },
    select: { studentId: true },
  });

  const invalidIds = studentIds.filter((id) => !valid.some((v) => v.studentId === id));
  if (invalidIds.length > 0) {
    throw new AppError({
      httpStatus: 400,
      error: ChallengeErrorCode.CHALLENGE_PARTICIPANT_NOT_TRAINEE,
      messageCode: ChallengeMessageCode.CHALLENGE_PARTICIPANT_NOT_TRAINEE,
      message: 'Some student IDs are not trainees of this trainer',
      details: { invalidIds },
    });
  }

  // Check for duplicates (per confirmed design: 409, not idempotent)
  const existing = await prisma.challengeParticipant.findMany({
    where: {
      challengeId,
      studentId: { in: studentIds },
    },
    select: { studentId: true },
  });

  if (existing.length > 0) {
    throw new AppError({
      httpStatus: 409,
      error: ChallengeErrorCode.CHALLENGE_PARTICIPANT_DUPLICATE,
      messageCode: ChallengeMessageCode.CHALLENGE_PARTICIPANT_DUPLICATE,
      message: 'Some students are already participants in this challenge',
      details: { duplicateIds: existing.map((e) => e.studentId) },
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.challengeParticipant.createMany({
      data: studentIds.map((studentId) => ({ challengeId, studentId })),
    });
  });

  const participantCount = await prisma.challengeParticipant.count({ where: { challengeId } });

  return { added: studentIds.length, participantCount };
}

/**
 * Remove a participant from a challenge.
 * Note: removing after start is allowed (per design). Their PointTransactions
 * remain in the global ranking but they leave this challenge's leaderboard.
 */
export async function removeParticipant({ prisma, trainerUserId, challengeId, studentId }) {
  const trainer = await resolveTrainer(prisma, trainerUserId);
  await resolveChallenge(prisma, challengeId, trainer.id);

  const participant = await prisma.challengeParticipant.findUnique({
    where: { challengeId_studentId: { challengeId, studentId } },
  });

  if (!participant) {
    throw new AppError({
      httpStatus: 404,
      error: ChallengeErrorCode.CHALLENGE_PARTICIPANT_NOT_FOUND,
      messageCode: ChallengeMessageCode.CHALLENGE_PARTICIPANT_NOT_FOUND,
      message: 'Participant not found in this challenge',
    });
  }

  await prisma.challengeParticipant.delete({
    where: { challengeId_studentId: { challengeId, studentId } },
  });
}

// ─── Student-facing challenge access ──────────────────────────────────────────

/**
 * List challenges a student participates in, optionally filtered by trainerId/status.
 */
export async function listStudentChallenges({ prisma, studentId, trainerId, status }) {
  const where = {
    participants: {
      some: { studentId },
    },
  };

  if (trainerId) {
    where.trainerId = trainerId;
  }

  const challenges = await prisma.challenge.findMany({
    where,
    include: { _count: { select: { participants: true } } },
    orderBy: { startDate: 'desc' },
  });

  const formatted = challenges.map((c) => formatChallenge(c, c._count.participants));

  if (!status) return formatted;

  return formatted.filter((c) => c.status === status);
}

/**
 * Get a single challenge as a student.
 * Verifies the student is a participant (403 if not).
 */
export async function getStudentChallenge({ prisma, studentId, challengeId }) {
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

  const participantCount = await prisma.challengeParticipant.count({ where: { challengeId } });

  return formatChallenge(challenge, participantCount);
}
