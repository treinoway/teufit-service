import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import _ from 'lodash';
import s3BucketHandler from '../config/s3-bucket-handler.js';
import emailHandler from '../config/email-handler.js';
import { formatDateOnly, parseDateOnlyAsUtc } from '../helpers/date-helpers.js';
import { NotFoundAppError, ConflictAppError, AppError } from '../errors/app-error.js';
import {
  maybeMarkProfileComplete,
  maybeMarkFirstStudentLinked,
} from './trainer-onboarding-service.js';
import { markBriefingDirty } from './briefing-service.js';
import { computeExpectedSessions } from '../helpers/adherence-helpers.js';
import { assertStudentCap } from './platform-plan-service.js';
import { joinAllModeChallenges } from './challenge-participant-sync.js';
import { TrainingStatus } from '../constants/training.js';
import {
  SubscriptionStatus,
} from '../constants/subscription.js';
import {
  buildDueSoonPaymentWhere,
  buildOverduePaymentWhere,
  deriveBillingStatus,
} from '../helpers/payment-status-helpers.js';
import { todayInBusinessTz } from '../helpers/date-helpers.js';
import { buildProfessionalAssignmentLockKey } from '../helpers/subscription-owner-helpers.js';
import { resolveOwnerRows } from './professional-owner-service.js';
import { cancelSubscriptionsAfterUnlink, UnlinkedProfessional } from './unlink-billing-service.js';
import { UserStatus } from '../constants/user-status.js';
import { StudentBlocker } from '../constants/student-blocker.js';

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
      data: { status: UserStatus.ACTIVE, ...userUpdateData },
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

// Live "all" mode (CAMP-13): puts a newly linked student in the trainer's open all-mode weekly championships; a failure is logged and the link kept
async function joinNewStudentToChallenges(trainerId, studentId, logger) {
  try {
    await joinAllModeChallenges(prisma, trainerId, studentId, new Date());
  } catch (err) {
    logger.error(
      { trainerId, studentId, err },
      `[challenge-sync] failed to add student ${studentId} to the all-mode championships of trainer ${trainerId}`,
    );
  }
}

/**
 * Link a student to the authenticated trainer by the student's email.
 *
 * Contract:
 * - Input: trainerId (Trainer.id), trainerUserId (User.id of trainer), email (student's email), optional logger (defaults to console)
 * - Throws NotFoundAppError if no user with that email exists
 * - Throws AppError (422) if trainer tries to link themselves
 * - Throws ConflictAppError if the student is already linked to this trainer
 * - Output: basic student profile { id, email, firstName, lastName, avatarUrl }
 */
export async function linkStudentByEmail({ trainerId, trainerUserId, email, logger = console }) {
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

  await prisma.$transaction([
    prisma.trainerStudent.create({ data: { trainerId, studentId: student.id } }),
    prisma.user.update({ where: { id: student.id }, data: { status: UserStatus.ACTIVE } }),
  ]);

  await maybeMarkFirstStudentLinked({ trainerId });

  // Roster change affects activeStudents and inactiveStudents KPIs.
  // Blocking is intentional here — roster mutations are infrequent and the
  // extra latency is negligible vs. the risk of losing the dirty signal.
  // Hot-path mutations (set logs, sessions) use fire-and-forget instead.
  await markBriefingDirty(prisma, trainerId);

  await joinNewStudentToChallenges(trainerId, student.id, logger);

  // Notify the student of the new link (closed beta welcome). Fire-and-forget:
  // an email failure must never break the link operation.
  try {
    const trainerUser = await prisma.user.findUnique({
      where: { id: trainerUserId },
      select: { firstName: true, lastName: true },
    });
    const trainerName = `${trainerUser?.firstName ?? ''} ${trainerUser?.lastName ?? ''}`.trim();
    // The Resend SDK returns { data, error } instead of throwing.
    const emailResponse = await emailHandler.sendStudentLinkedEmail({ to: student.email, trainerName });
    if (emailResponse?.error) {
      console.error('Failed to send student-linked email', emailResponse.error);
    }
  } catch (emailError) {
    console.error('Failed to send student-linked email', emailError);
  }

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
 * Compute the readiness blockers for a single student.
 *
 * Order is deterministic: conditions are evaluated in exactly the sequence
 * declared by StudentBlocker and pushed conditionally — the array is never
 * sorted afterwards. This order is part of the response contract (the mobile
 * app has no client-side i18n and renders `blockersLabel` positionally).
 *
 * Decisions baked in here (not fully specified by the product ask):
 * - Multiple subscriptions (e.g. an old cancelled one plus a current active
 *   one — the common case, since history is kept) are judged by the ACTIVE
 *   subscription only. `subscription_cancelled` fires only when the student
 *   has subscription history with this trainer but NONE of it is currently
 *   ACTIVE. It never fires merely because a past subscription was cancelled.
 * - `subscription_overdue` only looks at ACTIVE subscription(s); a cancelled
 *   subscription's unpaid history is not surfaced as a blocker (the trainer
 *   can't collect on a plan the student no longer has).
 * - A student can have more than one ACTIVE subscription in edge cases
 *   (e.g. mid-migration between plans); overdue is true if ANY of them has a
 *   pending payment past due.
 *
 * @param {object} params
 * @param {boolean} params.hasActiveProtocol - true when the student has a non-expired, non-deleted, status=active protocol (regardless of start date)
 * @param {Array<{ id: string, status: string }>} params.subscriptions - all StudentSubscription rows this student has with this trainer
 * @param {Set<string>} params.overdueSubscriptionIds - subscription ids (scoped to ACTIVE ones) with a PENDING payment whose dueDate is in the past
 * @param {boolean} params.activeOnPlan - TrainerStudent.activeOnPlan (trainer's platform-plan seat quota)
 * @returns {string[]} StudentBlocker codes, in StudentBlocker enum order
 */
export function computeStudentBlockers({ hasActiveProtocol, subscriptions, overdueSubscriptionIds, activeOnPlan }) {
  const blockers = [];

  if (!hasActiveProtocol) {
    blockers.push(StudentBlocker.NO_ACTIVE_PROTOCOL);
  }

  if (subscriptions.length === 0) {
    blockers.push(StudentBlocker.NO_SUBSCRIPTION);
  } else {
    const activeSubscriptions = subscriptions.filter((s) => s.status === SubscriptionStatus.ACTIVE);
    if (activeSubscriptions.length === 0) {
      blockers.push(StudentBlocker.SUBSCRIPTION_CANCELLED);
    } else if (activeSubscriptions.some((s) => overdueSubscriptionIds.has(s.id))) {
      blockers.push(StudentBlocker.SUBSCRIPTION_OVERDUE);
    }
  }

  if (!activeOnPlan) {
    blockers.push(StudentBlocker.BLOCKED_ON_PLAN);
  }

  return blockers;
}

/**
 * List all students linked to a trainer.
 *
 * Contract:
 * - Input: trainerId (Trainer.id)
 * - Output: array of student basic profiles with current-month adherence stats
 *   plus readiness (`ready` + `blockers[]`).
 *
 * Adherence is always the current calendar month (UTC), regardless of any other
 * filters. New fields:
 *   - adherence         {number|null} — completed/expected × 100, capped at 100
 *   - adherenceCompleted {number|null} — completed sessions this calendar month
 *   - adherenceExpected  {number|null} — expected sessions this calendar month (up to now)
 *   - adherenceMonth     {string}      — "YYYY-MM-01" (always set; period metadata)
 *   - billingStatus      {string}      — overdue | due_soon | ok | none (same predicates as the dashboard)
 *   - ready              {boolean}     — true when blockers is empty
 *   - blockers           {string[]}    — StudentBlocker codes, see computeStudentBlockers()
 *
 * When the student has no active protocol or expected = 0, adherence,
 * adherenceCompleted and adherenceExpected are all null. Note this is
 * independent from `blockers`: adherence's "active protocol" window excludes
 * protocols that haven't started yet, while the `no_active_protocol` blocker
 * does not — a protocol starting tomorrow already counts as the trainer's
 * work being done.
 *
 * Queries (batched for the whole roster, constant regardless of roster size —
 * no N+1):
 *   1) trainerStudent.findMany  — roster + student profile + activeOnPlan
 *   2) trainingProtocol.findMany — adherence window (existing)
 *   3) workoutSession.groupBy    — completed sessions this month (existing)
 *   4) trainingProtocol.findMany — "has a non-expired active protocol" (own query — do NOT reuse #2, see below)
 *   5) studentSubscription.findMany — all subscriptions this roster has with this trainer
 *   6) subscriptionPayment.findMany — overdue pending payments for this roster's ACTIVE subscriptions (skipped if there are none)
 * 2-5 run batched via Promise.all; 6 depends on the subscription ids from 5.
 *
 * Why #4 can't reuse #2: #2 filters `startDate: { lt: now }` because it feeds
 * the adherence *expected sessions* window, which must exclude protocols
 * that haven't started yet. But a protocol starting tomorrow is still "the
 * trainer did the work" — reusing #2 would falsely mark that student
 * `no_active_protocol`. #4 has no startDate filter and instead checks
 * non-expiration as of *today* (not #2's monthStart cutoff).
 *
 * Why #4 filters `trainerId` and #2 does NOT (this is deliberate, not an
 * inconsistency to "fix" — do not make them match): a student can be linked
 * to more than one trainer (`TrainerStudent` is N:N, unique on
 * `[trainerId, studentId]`), and so can a `TrainingProtocol` belong to any
 * of those trainers. #2 (adherence) answers "did the student train?" — a
 * session the student logged is real regardless of which trainer assigned
 * the protocol behind it, so it is intentionally trainer-agnostic. #4 (the
 * `no_active_protocol` blocker) answers a different question: "did *this*
 * trainer give this student a routine?" — if trainer B assigned an active
 * protocol but this trainer (A) never did, A's roster must still show
 * `no_active_protocol`; inheriting B's protocol would tell A their job is
 * done when it isn't. Uses `TrainingProtocol.trainerId` + `@@index([trainerId])`.
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
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Date-only "today" boundary for the no_active_protocol / subscription_overdue
  // blocker checks — distinct from monthStart, which is the adherence window.
  const today = todayInBusinessTz(now);

  const [protocols, completedGroups, activeProtocolRows, subscriptions] = await Promise.all([
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
    // Own query for the no_active_protocol blocker — see JSDoc above for why
    // this must NOT be derived from `protocols`, and why it filters
    // `trainerId` (unlike the adherence query above) — a protocol assigned by
    // a DIFFERENT trainer this student is also linked to must not clear this
    // trainer's blocker.
    prisma.trainingProtocol.findMany({
      where: {
        trainerId,
        assigneeId: { in: studentIds },
        status: TrainingStatus.ACTIVE,
        deletedAt: null,
        OR: [
          { expirationDate: null },
          { expirationDate: { gte: today } },
        ],
      },
      select: { assigneeId: true },
    }),
    prisma.studentSubscription.findMany({
      where: {
        trainerId,
        studentId: { in: studentIds },
      },
      select: { id: true, studentId: true, status: true },
    }),
  ]);

  // Group protocols by student, then compute expected sessions per student.
  const protocolsByStudent = new Map();
  for (const proto of protocols) {
    const existing = protocolsByStudent.get(proto.assigneeId) ?? [];
    existing.push(proto);
    protocolsByStudent.set(proto.assigneeId, existing);
  }

  const expectedByStudent = new Map();
  for (const [studentId, studentProtocols] of protocolsByStudent) {
    expectedByStudent.set(
      studentId,
      computeExpectedSessions({ protocols: studentProtocols, windowFrom: monthStart, windowTo: now }),
    );
  }

  const completedByStudent = new Map(
    completedGroups.map((g) => [g.userId, g._count._all]),
  );

  const adherenceMonthString = formatDateOnly(monthStart);

  function adherenceStatsFor(studentId) {
    const expected = expectedByStudent.get(studentId) ?? 0;
    if (expected === 0) {
      return { adherence: null, adherenceCompleted: null, adherenceExpected: null };
    }
    const completed = completedByStudent.get(studentId) ?? 0;
    const pct = Math.round(Math.min(completed / expected, 1) * 100 * 100) / 100;
    return { adherence: pct, adherenceCompleted: completed, adherenceExpected: expected };
  }

  const studentsWithActiveProtocol = new Set(activeProtocolRows.map((r) => r.assigneeId));

  const subscriptionsByStudent = new Map();
  for (const subscription of subscriptions) {
    const existing = subscriptionsByStudent.get(subscription.studentId) ?? [];
    existing.push(subscription);
    subscriptionsByStudent.set(subscription.studentId, existing);
  }

  // #6 depends on #5's active subscription ids — skipped entirely when the
  // roster has none (common: brand new trainer, or a roster with only
  // no_subscription/subscription_cancelled blockers).
  const activeSubscriptionIds = subscriptions
    .filter((s) => s.status === SubscriptionStatus.ACTIVE)
    .map((s) => s.id);

  // Overdue and due-soon payments of the active subscriptions: two batched
  // queries (no per-student queries), same predicates as the dashboard counters.
  const [overduePayments, dueSoonPayments] = activeSubscriptionIds.length > 0
    ? await Promise.all([
      prisma.subscriptionPayment.findMany({
        where: { subscriptionId: { in: activeSubscriptionIds }, ...buildOverduePaymentWhere(today) },
        select: { subscriptionId: true },
      }),
      prisma.subscriptionPayment.findMany({
        where: { subscriptionId: { in: activeSubscriptionIds }, ...buildDueSoonPaymentWhere(today) },
        select: { subscriptionId: true },
      }),
    ])
    : [[], []];

  const overdueSubscriptionIds = new Set(overduePayments.map((p) => p.subscriptionId));
  const dueSoonSubscriptionIds = new Set(dueSoonPayments.map((p) => p.subscriptionId));

  return Promise.all(
    links.map(async (link) => {
      const { adherence, adherenceCompleted, adherenceExpected } = adherenceStatsFor(link.studentId);
      const blockers = computeStudentBlockers({
        hasActiveProtocol: studentsWithActiveProtocol.has(link.studentId),
        subscriptions: subscriptionsByStudent.get(link.studentId) ?? [],
        overdueSubscriptionIds,
        activeOnPlan: link.activeOnPlan,
      });
      const activeSubscriptions = (subscriptionsByStudent.get(link.studentId) ?? []).filter(
        (s) => s.status === SubscriptionStatus.ACTIVE,
      );
      const billingStatus = deriveBillingStatus({
        hasActiveSubscription: activeSubscriptions.length > 0,
        hasOverduePayment: activeSubscriptions.some((s) => overdueSubscriptionIds.has(s.id)),
        hasDueSoonPayment: activeSubscriptions.some((s) => dueSoonSubscriptionIds.has(s.id)),
      });
      return {
        id: link.student.id,
        email: link.student.email,
        firstName: link.student.firstName,
        lastName: link.student.lastName,
        avatarUrl: await s3BucketHandler.resolveUrl(link.student.avatarUrl),
        billingStatus,
        adherence,
        adherenceCompleted,
        adherenceExpected,
        adherenceMonth: adherenceMonthString,
        lastWorkoutAt: link.lastWorkoutAt,
        currentPrLoad: link.currentPrLoad,
        currentPrAt: link.currentPrAt,
        ready: blockers.length === 0,
        blockers,
      };
    }),
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
 * Get the basic profile of one student linked to the authenticated trainer.
 *
 * Contract:
 * - Input: trainerUserId (User.id of the trainer), studentId (User.id of the student)
 * - Throws ConflictAppError TRAINER_PROFILE_MISSING (409) if the user has no trainer profile
 * - Throws NotFoundAppError student.notLinked (404) if the student is not linked to this
 *   trainer or the student's account was deleted
 * - Output: { id, email, firstName, lastName, avatarUrl, activeOnPlan, linkedAt, lastWorkoutAt }
 *   (lastWorkoutAt is a denormalized ISO timestamp, null if the student never finished a session)
 */
export async function getLinkedStudent({ trainerUserId, studentId }, prismaClient = prisma) {
  const trainer = await prismaClient.trainer.findUnique({
    where: { userId: trainerUserId },
    select: { id: true },
  });

  if (!trainer) {
    throw new ConflictAppError({
      error: 'TRAINER_PROFILE_MISSING',
      messageCode: 'trainer.profileMissing',
      message: 'Trainer profile not found',
    });
  }

  const link = await prismaClient.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
    select: {
      createdAt: true,
      activeOnPlan: true,
      lastWorkoutAt: true,
      student: {
        select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true, deletedAt: true },
      },
    },
  });

  if (!link || link.student.deletedAt) {
    throw new NotFoundAppError({
      message: 'No link found between this trainer and student',
      messageCode: 'student.notLinked',
    });
  }

  const { student } = link;
  return {
    id: student.id,
    email: student.email,
    firstName: student.firstName,
    lastName: student.lastName,
    avatarUrl: await s3BucketHandler.resolveUrl(student.avatarUrl),
    activeOnPlan: link.activeOnPlan,
    linkedAt: link.createdAt,
    lastWorkoutAt: link.lastWorkoutAt,
  };
}

/**
 * Unlink a student from the authenticated trainer.
 *
 * Contract:
 * - Input: trainerId (Trainer.id), studentId (User.id of the student), userId (User.id of the trainer)
 * - Throws NotFoundAppError if no link exists between trainer and student
 * - Returns nothing (caller should respond with 204)
 */
export async function unlinkStudent({ trainerId, studentId, userId }) {
  const existing = await prisma.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId, studentId } },
  });

  if (!existing) {
    throw new NotFoundAppError({
      message: 'No link found between this trainer and student',
      messageCode: 'student.notLinked',
    });
  }

  // The link and the subscriptions that depended on it end together: not-yet-due
  // pending charges are voided, already-due ones stay pending as debt (visible in
  // the finance overview even after the unlink).
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Same user-level key as assignPlanToStudent: waits for an in-flight assignment, and an
    // assignment starting afterwards re-checks the link and finds it gone.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${buildProfessionalAssignmentLockKey(userId, studentId)}))`;
    await tx.trainerStudent.delete({
      where: { trainerId_studentId: { trainerId, studentId } },
    });
    const owner = { ...(await resolveOwnerRows(tx, userId)), trainerId };
    await cancelSubscriptionsAfterUnlink(tx, {
      owner,
      studentId,
      unlinked: UnlinkedProfessional.TRAINER,
      now,
    });
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
