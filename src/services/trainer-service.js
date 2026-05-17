import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import _ from 'lodash';
import s3BucketHandler from '../config/s3-bucket-handler.js';
import { formatDateOnly, parseDateOnlyAsUtc } from '../helpers/date-helpers.js';
import { NotFoundAppError, ConflictAppError, AppError } from '../errors/app-error.js';
import {
  maybeMarkProfileComplete,
  maybeMarkFirstStudentLinked,
} from './trainer-onboarding-service.js';
import {
  markBriefingDirty,
  countWeekdayOccurrences,
  WEEKDAY_TO_INT,
  DAY_MS,
} from './briefing-service.js';
import { assertStudentCap } from './platform-plan-service.js';

function buildUserUpdateData(trainer) {
  const userData = {};
  if (trainer.firstName != null) userData.firstName = trainer.firstName;
  if (trainer.lastName != null) userData.lastName = trainer.lastName;
  if (trainer.birthDate != null) userData.birthDate = parseDateOnlyAsUtc(trainer.birthDate);
  if (trainer.avatar != null) userData.avatarUrl = trainer.avatar;
  return userData;
}

function buildTrainerUpdateData(trainer) {
  const trainerData = {};
  if (trainer.professionalDocument != null) trainerData.professionalDocument = trainer.professionalDocument;
  if (trainer.gymName != null) trainerData.gymName = trainer.gymName;
  if (trainer.notes != null) trainerData.notes = trainer.notes;
  if (trainer.serviceMode != null) {
    const validModes = ['online', 'in_person', 'hybrid'];
    if (!validModes.includes(trainer.serviceMode)) {
      const err = new Error(`Invalid service mode: ${trainer.serviceMode}. Valid modes are: ${validModes.join(', ')}`);
      err.code = 'INVALID_SERVICE_MODE';
      err.statusCode = 400;
      throw err;
    }
    trainerData.serviceMode = trainer.serviceMode;
  }
  return trainerData;
}

function buildAddressUpsertData(address) {
  return {
    line1: address.line1 ?? null,
    line2: address.line2 ?? null,
    neighborhood: address.neighborhood ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    stateCode: address.stateCode ?? null,
    country: address.country ?? null,
    countryCode: address.countryCode ?? null,
    postalCode: address.postalCode ?? null,
  };
}

function buildSocialsUpsertData(socials) {
  return {
    instagram: socials.instagram ?? null,
    whatsapp: socials.whatsapp ?? null,
    x: socials.x ?? null,
    threads: socials.threads ?? null,
    youtube: socials.youtube ?? null,
    linkedin: socials.linkedin ?? null,
    facebook: socials.facebook ?? null,
  };
}

/**
 * Save trainer onboarding/profile data.
 *
 * Contract:
 * - Expects caller already authenticated and authorized (trainer role)
 * - Updates Trainer + optional Address + optional SocialNetwork
 * - Sets User.status=active
 */
export async function patch({ userId, trainer, address, socials }) {
  if (trainer == null && address == null && socials == null) {
    const err = new Error('No updates provided');
    err.code = 'NO_UPDATES';
    err.statusCode = 400;
    throw err;
  }

  const result = await prisma.$transaction(async (tx) => {
    const existingTrainer = await tx.trainer.findUnique({ where: { userId } });
    if (!existingTrainer) {
      const err = new Error('Trainer profile missing');
      err.code = 'TRAINER_PROFILE_MISSING';
      err.statusCode = 409;
      throw err;
    }

    let trainerRow = existingTrainer;
    let userUpdateData = {};
    if (trainer) {
      const trainerData = buildTrainerUpdateData(trainer);
      userUpdateData = buildUserUpdateData(trainer);

      if (Object.keys(trainerData).length > 0) {
        trainerRow = await tx.trainer.update({
          where: { id: existingTrainer.id },
          data: trainerData,
        });
      }
    }

    let addressRow = null;
    if (address) {
      const addrData = buildAddressUpsertData(address);
      addressRow = await tx.address.upsert({
        where: { userId },
        create: { userId, ...addrData },
        update: addrData,
      });
    }

    let socialsRow = null;
    if (socials) {
      const socialData = buildSocialsUpsertData(socials);
      socialsRow = await tx.socialNetwork.upsert({
        where: { userId },
        create: { userId, ...socialData },
        update: socialData,
      });
    }

    const userRow = await tx.user.update({
      where: { id: userId },
      data: { status: 'active', ...userUpdateData },
    });

    await maybeMarkProfileComplete({ userId, tx });

    // Return the same response shape as GET /me:
    // - do not leak the user row
    // - omit trainer.userId
    // - merge address + socials into the payload
    // - include personal data from User
    const responseTrainer = _.omit(trainerRow, ['userId']);
    return {
      trainerRow: responseTrainer,
      userRow,
      addressRow,
      socialsRow,
    };
  });

  // Resolve avatar URL after transaction completes (non-DB work)
  const avatarUrl = await s3BucketHandler.resolveUrl(result.userRow.avatarUrl);

  return {
    ...result.trainerRow,
    firstName: result.userRow.firstName,
    lastName: result.userRow.lastName,
    birthDate: formatDateOnly(result.userRow.birthDate),
    avatarUrl,
    address: result.addressRow,
    socialNetworks: result.socialsRow,
  };
}

// Backwards-compatible alias used by older routes/tests.
export const updateMyTrainerProfile = patch;

/**
 * Link a student to the authenticated trainer by the student's email.
 *
 * Contract:
 * - Input: trainerId (Trainer.id), trainerUserId (User.id of trainer), email (student's email)
 * - Throws NotFoundAppError if no user with that email exists
 * - Throws AppError (422) if trainer tries to link themselves
 * - Throws ConflictAppError if the student is already linked to this trainer
 * - Output: basic student profile { id, email, firstName, lastName, avatarUrl }
 */
export async function linkStudentByEmail({ trainerId, trainerUserId, email }) {
  const student = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true },
  });

  if (!student) {
    throw new NotFoundAppError({
      message: 'No user found with the provided email',
      messageCode: 'student.notFound',
    });
  }

  if (student.id === trainerUserId) {
    throw new AppError({
      httpStatus: 422,
      error: 'CANNOT_LINK_SELF',
      messageCode: 'student.cannotLinkSelf',
      message: 'A trainer cannot link themselves as a student',
    });
  }

  const existing = await prisma.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId, studentId: student.id } },
  });

  if (existing) {
    throw new ConflictAppError({
      message: 'This student is already linked to your account',
      messageCode: 'student.alreadyLinked',
    });
  }

  await assertStudentCap(prisma, trainerId);

  await prisma.trainerStudent.create({
    data: { trainerId, studentId: student.id },
  });

  await maybeMarkFirstStudentLinked({ trainerId });

  // Roster change affects activeStudents and inactiveStudents KPIs.
  // Blocking is intentional here — roster mutations are infrequent and the
  // extra latency is negligible vs. the risk of losing the dirty signal.
  // Hot-path mutations (set logs, sessions) use fire-and-forget instead.
  await markBriefingDirty(prisma, trainerId);

  const avatarUrl = await s3BucketHandler.resolveUrl(student.avatarUrl);

  return {
    id: student.id,
    email: student.email,
    firstName: student.firstName,
    lastName: student.lastName,
    avatarUrl,
  };
}

/**
 * List all students linked to a trainer.
 *
 * Contract:
 * - Input: trainerId (Trainer.id)
 * - Output: array of student basic profiles { id, email, firstName, lastName, avatarUrl }
 */
export async function listStudents({ trainerId }) {
  const links = await prisma.trainerStudent.findMany({
    where: { trainerId },
    include: {
      student: {
        select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (links.length === 0) return [];

  const studentIds = links.map((l) => l.studentId);

  // Adherence is computed on-read (not denormalized) because the denominator
  // grows with the calendar day even when no write happens — denorm would lie.
  // Two batched queries fixed, regardless of roster size:
  //   1) protocols + trainings for all students
  //   2) completed-session counts grouped by user for the current month
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [protocols, completedGroups] = await Promise.all([
    prisma.trainingProtocol.findMany({
      where: {
        assigneeId: { in: studentIds },
        status: 'active',
        deletedAt: null,
        startDate: { lt: now },
        OR: [
          { expirationDate: null },
          { expirationDate: { gte: monthStart } },
        ],
      },
      select: {
        assigneeId: true,
        startDate: true,
        expirationDate: true,
        trainings: {
          where: { deletedAt: null, weekDay: { not: null } },
          select: { weekDay: true },
        },
      },
    }),
    prisma.workoutSession.groupBy({
      by: ['userId'],
      where: {
        userId: { in: studentIds },
        status: 'completed',
        deletedAt: null,
        startedAt: { gte: monthStart, lt: now },
      },
      _count: { _all: true },
    }),
  ]);

  // Aggregate expected sessions per student in JS — no extra queries.
  const expectedByStudent = new Map();
  for (const proto of protocols) {
    if (proto.trainings.length === 0) continue;
    const effectiveStart = proto.startDate > monthStart ? proto.startDate : monthStart;
    const expirationExclusive = proto.expirationDate
      ? new Date(proto.expirationDate.getTime() + DAY_MS)
      : null;
    const effectiveEnd = expirationExclusive && expirationExclusive < now ? expirationExclusive : now;
    const weekDayInts = new Set(
      proto.trainings.map((t) => WEEKDAY_TO_INT[t.weekDay]).filter((n) => n !== undefined),
    );
    const occurrences = countWeekdayOccurrences(effectiveStart, effectiveEnd, weekDayInts);
    expectedByStudent.set(
      proto.assigneeId,
      (expectedByStudent.get(proto.assigneeId) ?? 0) + occurrences,
    );
  }

  const completedByStudent = new Map(
    completedGroups.map((g) => [g.userId, g._count._all]),
  );

  function adherenceFor(studentId) {
    const expected = expectedByStudent.get(studentId) ?? 0;
    if (expected === 0) return null;
    const completed = completedByStudent.get(studentId) ?? 0;
    const pct = (completed / expected) * 100;
    return Math.round(Math.min(pct, 100) * 100) / 100;
  }

  return Promise.all(
    links.map(async (link) => ({
      id: link.student.id,
      email: link.student.email,
      firstName: link.student.firstName,
      lastName: link.student.lastName,
      avatarUrl: await s3BucketHandler.resolveUrl(link.student.avatarUrl),
      adherence: adherenceFor(link.studentId),
      lastWorkoutAt: link.lastWorkoutAt,
      currentPrLoad: link.currentPrLoad,
      currentPrAt: link.currentPrAt,
    })),
  );
}

/**
 * Search students linked to a trainer by fuzzy name/email.
 *
 * Contract:
 * - Input: trainerId (Trainer.id), query (string), limit (number)
 * - Output: array of student basic profiles { id, email, firstName, lastName, avatarUrl }
 */
export async function searchStudents({ trainerId, query, limit = 10 }) {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const wildcardQuery = `%${normalizedQuery}%`;
  const fullNameExpr = "lower((COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')))";

  let students;
  try {
    students = await prisma.$queryRaw(
      Prisma.sql`
        SELECT
          u.id,
          u.email,
          u.first_name AS "firstName",
          u.last_name AS "lastName",
          u.avatar_url AS "avatarUrl"
        FROM trainer_students ts
        INNER JOIN users u ON u.id = ts.student_id
        WHERE ts.trainer_id = ${trainerId}::uuid
          AND u.deleted_at IS NULL
          AND (
            lower(COALESCE(u.email, '')) % ${normalizedQuery}
            OR ${Prisma.raw(fullNameExpr)} % ${normalizedQuery}
            OR lower(COALESCE(u.email, '')) LIKE ${wildcardQuery}
            OR ${Prisma.raw(fullNameExpr)} LIKE ${wildcardQuery}
          )
        ORDER BY
          GREATEST(
            similarity(lower(COALESCE(u.email, '')), ${normalizedQuery}),
            similarity(${Prisma.raw(fullNameExpr)}, ${normalizedQuery})
          ) DESC,
          u.created_at DESC
        LIMIT ${normalizedLimit}
      `,
    );
  } catch (error) {
    const errorMessage = String(error?.message || '').toLowerCase();
    const pgTrgmUnavailable =
      error?.code === 'P2010'
      || error?.code === '42883'
      || error?.code === '42704'
      || errorMessage.includes('function similarity')
      || errorMessage.includes('operator does not exist: text %')
      || errorMessage.includes('pg_trgm')
      || errorMessage.includes('42883');

    if (!pgTrgmUnavailable) {
      throw error;
    }

    students = await prisma.$queryRaw(
      Prisma.sql`
        SELECT
          u.id,
          u.email,
          u.first_name AS "firstName",
          u.last_name AS "lastName",
          u.avatar_url AS "avatarUrl"
        FROM trainer_students ts
        INNER JOIN users u ON u.id = ts.student_id
        WHERE ts.trainer_id = ${trainerId}::uuid
          AND u.deleted_at IS NULL
          AND (
            lower(COALESCE(u.email, '')) LIKE ${wildcardQuery}
            OR ${Prisma.raw(fullNameExpr)} LIKE ${wildcardQuery}
          )
        ORDER BY
          CASE
            WHEN lower(COALESCE(u.email, '')) = ${normalizedQuery} THEN 3
            WHEN ${Prisma.raw(fullNameExpr)} = ${normalizedQuery} THEN 3
            WHEN lower(COALESCE(u.email, '')) LIKE ${`${normalizedQuery}%`} THEN 2
            WHEN ${Prisma.raw(fullNameExpr)} LIKE ${`${normalizedQuery}%`} THEN 2
            ELSE 1
          END DESC,
          u.created_at DESC
        LIMIT ${normalizedLimit}
      `,
    );
  }

  return Promise.all(
    students.map(async (student) => ({
      id: student.id,
      email: student.email,
      firstName: student.firstName,
      lastName: student.lastName,
      avatarUrl: await s3BucketHandler.resolveUrl(student.avatarUrl),
    })),
  );
}

/**
 * Unlink a student from the authenticated trainer.
 *
 * Contract:
 * - Input: trainerId (Trainer.id), studentId (User.id of the student)
 * - Throws NotFoundAppError if no link exists between trainer and student
 * - Returns nothing (caller should respond with 204)
 */
export async function unlinkStudent({ trainerId, studentId }) {
  const existing = await prisma.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId, studentId } },
  });

  if (!existing) {
    throw new NotFoundAppError({
      message: 'No link found between this trainer and student',
      messageCode: 'student.notLinked',
    });
  }

  await prisma.trainerStudent.delete({
    where: { trainerId_studentId: { trainerId, studentId } },
  });

  // Roster change affects activeStudents and inactiveStudents KPIs.
  // Blocking is intentional here — roster mutations are infrequent and the
  // extra latency is negligible vs. the risk of losing the dirty signal.
  // Hot-path mutations (set logs, sessions) use fire-and-forget instead.
  await markBriefingDirty(prisma, trainerId);
}

/**
 * List all active trainers visible to any authenticated user.
 *
 * Contract:
 * - No input required (public listing within authenticated scope)
 * - Filters out soft-deleted trainers and users with inactive/deleted accounts
 * - Output: array of public trainer profiles { id, firstName, lastName, avatarUrl, serviceMode, address, socialNetworks }
 */
export async function listTrainers() {
  const trainers = await prisma.trainer.findMany({
    where: {
      deletedAt: null,
      user: { deletedAt: null },
    },
    include: {
      user: {
        select: {
          firstName: true,
          lastName: true,
          avatarUrl: true,
          address: { select: { city: true, state: true, country: true } },
          socials: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return Promise.all(
    trainers.map(async (trainer) => ({
      id: trainer.id,
      firstName: trainer.user.firstName,
      lastName: trainer.user.lastName,
      avatarUrl: await s3BucketHandler.resolveUrl(trainer.user.avatarUrl),
      serviceMode: trainer.serviceMode,
      address: trainer.user.address ?? null,
      socialNetworks: trainer.user.socials ?? null,
    })),
  );
}

/**
 * Get the trainer profile (and related 1:1 resources) for a given userId.
 *
 * Contract:
 * - Input: userId (uuid string)
 * - Output: trainer row including the linked user + address + socials (may be null)
 */
export async function getOneByUserId(userId) {
  if (!userId) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: 'userId is required',
    });
  }

  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    include: {
      user: {
        include: {
          address: true,
          socials: true,
        },
      },
    },
  });

  if (!trainer) {
    throw new NotFoundAppError({
      message: 'Trainer profile not found',
      messageCode: 'trainer.notFound',
    });
  }

  const responseTrainer = _.omit(trainer, ['user', 'userId']);
  const avatarUrl = await s3BucketHandler.resolveUrl(trainer.user.avatarUrl);
  // Flatten to match the structure returned by patch()
  // (trainer model doesn't have address/socials relations; those live on user)
  return {
    ...responseTrainer,
    firstName: trainer.user.firstName,
    lastName: trainer.user.lastName,
    birthDate: formatDateOnly(trainer.user.birthDate),
    avatarUrl,
    address: trainer.user.address,
    socialNetworks: trainer.user.socials,
  };
}
