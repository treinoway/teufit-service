import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
  PaymentStatus,
  CANCELLATION_REASON_REPLACED,
} from '../constants/subscription.js';
import { addDaysMs, formatDateOnly, parseDateOnlyAsUtc, todayInBusinessTz } from '../helpers/date-helpers.js';
import {
  assertValidMoneyAmount,
  assertValidPercentage,
  buildAssignmentLockKey,
  computeAmount,
  computeNextCycle,
  formatPayment,
} from '../helpers/subscription-helpers.js';
import { cancelUpcomingPayments, materializeCycles } from './subscription-cycle-service.js';
import { validateDiscount } from './subscription-plan-service.js';
import { assertStudentActiveOnPlan } from './platform-plan-service.js';

const { Decimal } = Prisma;
const UNIQUE_VIOLATION_CODE = 'P2002';

// Re-exported for existing importers; the implementation lives in subscription-helpers.js.
export { computeAmount };

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function resolveTrainerOrThrow(prisma, userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.TRAINER_NOT_FOUND,
      messageCode: SubscriptionMessageCode.TRAINER_NOT_FOUND,
      message: 'Trainer profile not found',
    });
  }

  return trainer;
}

async function verifyTrainerStudentLink(client, trainerId, studentId) {
  const link = await client.trainerStudent.findFirst({
    where: { trainerId, studentId },
  });

  if (!link) {
    throw new AppError({
      httpStatus: 403,
      error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
      messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      message: 'This student is not linked to your account',
    });
  }
}

function formatSubscription(sub) {
  return {
    id: sub.id,
    trainerId: sub.trainerId,
    studentId: sub.studentId,
    planId: sub.planId,
    recurrence: sub.recurrence,
    price: sub.price.toString(),
    discountPercent: sub.discountPercent != null ? sub.discountPercent.toString() : null,
    discountAmount: sub.discountAmount != null ? sub.discountAmount.toString() : null,
    startDate: formatDateOnly(sub.startDate),
    status: sub.status,
    cancelledAt: sub.cancelledAt ?? null,
    cancellationReason: sub.cancellationReason ?? null,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt ?? null,
  };
}

function buildAlreadyActiveError() {
  return new AppError({
    httpStatus: 409,
    error: SubscriptionErrorCode.SUBSCRIPTION_ALREADY_ACTIVE,
    messageCode: SubscriptionMessageCode.SUBSCRIPTION_ALREADY_ACTIVE,
    message: 'This student already has an active subscription',
  });
}

/**
 * Serialize assignments per trainer/student pair: only one assignment can be
 * in flight at a time. A concurrent one (double click, two tabs) gets a
 * deterministic 409 immediately instead of racing the replace-then-insert
 * sequence (which could otherwise create a duplicate due charge for the
 * subscription it just replaced). Assignments that do not overlap in time
 * replace the previous subscription as usual. The lock is transaction-scoped.
 */
async function acquireAssignmentLockOrThrow(tx, trainerId, studentId) {
  const [{ locked }] = await tx.$queryRaw`
    SELECT pg_try_advisory_xact_lock(hashtext(${buildAssignmentLockKey(trainerId, studentId)})) AS locked
  `;
  if (!locked) throw buildAlreadyActiveError();
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function assignPlanToStudent(prisma, userId, studentId, data, now = new Date()) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  await verifyTrainerStudentLink(prisma, trainer.id, studentId);
  await assertStudentActiveOnPlan(prisma, trainer.id, studentId);

  // Verify plan exists, belongs to trainer, and is not archived
  const plan = await prisma.subscriptionPlan.findFirst({
    where: { id: data.planId, trainerId: trainer.id },
  });

  if (!plan) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.PLAN_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      message: 'Subscription plan not found',
    });
  }

  if (plan.deletedAt != null) {
    throw new AppError({
      httpStatus: 409,
      error: SubscriptionErrorCode.PLAN_ARCHIVED,
      messageCode: SubscriptionMessageCode.PLAN_ARCHIVED,
      message: 'This plan is archived and cannot be used',
    });
  }

  // Resolve discount: override falls back to plan defaults
  const effectiveDiscountPercent =
    data.discountPercent !== undefined ? data.discountPercent : plan.discountPercent;
  const effectiveDiscountAmount =
    data.discountAmount !== undefined ? data.discountAmount : plan.discountAmount;

  // Validate mutual exclusion: caller could pass discountPercent=0 while plan has discountAmount,
  // or vice versa, ending up with both effective fields non-null simultaneously.
  assertValidMoneyAmount(data.discountAmount);
  assertValidPercentage(data.discountPercent);
  validateDiscount(plan.price, effectiveDiscountPercent, effectiveDiscountAmount);

  const startDate = parseDateOnlyAsUtc(data.startDate);
  const today = todayInBusinessTz(now);
  // First billed cycle: grid cycle 0 for a present/future start; for a backdated
  // start, the grid cycle that contains today — a stale past cycle is never billed.
  const firstCycle = computeNextCycle({ startDate, recurrence: plan.recurrence }, null, today);
  const netAmount = computeAmount(plan.price, effectiveDiscountPercent, effectiveDiscountAmount);

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      await acquireAssignmentLockOrThrow(tx, trainer.id, studentId);
      // Re-check inside the lock: an unlink may have committed since the first check.
      await verifyTrainerStudentLink(tx, trainer.id, studentId);

      // Replace the active subscription(s) of this student under this trainer.
      const replaced = await tx.studentSubscription.findMany({
        where: { trainerId: trainer.id, studentId, status: SubscriptionStatus.ACTIVE },
        select: {
          id: true,
          startDate: true,
          recurrence: true,
          price: true,
          discountPercent: true,
          discountAmount: true,
        },
      });
      const replacedIds = replaced.map((subscription) => subscription.id);
      if (replacedIds.length > 0) {
        // Future-dated replacement: the old plan keeps billing until the new one
        // starts, so its cycles starting in [today+1, newStart) must exist before
        // it is cancelled (the conditional insert only writes for active subscriptions).
        if (firstCycle.cycleStartDate > today) {
          await materializeCycles(tx, replaced, addDaysMs(firstCycle.cycleStartDate, -1), today, today);
        }

        await tx.studentSubscription.updateMany({
          where: { id: { in: replacedIds } },
          data: {
            status: SubscriptionStatus.CANCELLED,
            cancelledAt: now,
            cancellationReason: CANCELLATION_REASON_REPLACED,
          },
        });
        // Void only the replaced plan's pending charges starting on/after the new
        // first cycle (the new plan bills that period). Older cycles stay billable
        // at full price, even if they overlap the new start — no proration.
        await cancelUpcomingPayments(tx, { id: { in: replacedIds } }, today, {
          now,
          replacementCycleStart: firstCycle.cycleStartDate,
        });
      }

      const subscription = await tx.studentSubscription.create({
        data: {
          trainerId: trainer.id,
          studentId,
          planId: plan.id,
          recurrence: plan.recurrence,
          price: plan.price,
          discountPercent:
            effectiveDiscountPercent != null ? new Decimal(effectiveDiscountPercent) : null,
          discountAmount:
            effectiveDiscountAmount != null ? new Decimal(effectiveDiscountAmount) : null,
          startDate,
          status: SubscriptionStatus.ACTIVE,
        },
      });

      const payment = await tx.subscriptionPayment.create({
        data: {
          subscriptionId: subscription.id,
          cycleIndex: firstCycle.cycleIndex,
          cycleStartDate: firstCycle.cycleStartDate,
          cycleEndDate: firstCycle.cycleEndDate,
          dueDate: firstCycle.cycleStartDate,
          amount: netAmount,
          status: PaymentStatus.PENDING,
        },
      });

      return { subscription, payment };
    });
  } catch (error) {
    // Safety net: the per-pair partial unique index (one active subscription
    // per trainer/student) rejected a concurrent insert.
    if (error?.code === UNIQUE_VIOLATION_CODE) throw buildAlreadyActiveError();
    throw error;
  }

  return {
    ...formatSubscription(result.subscription),
    firstPayment: formatPayment(result.payment, today),
  };
}

// Scoped by trainerId only (no live link required) so the billing history stays
// reachable after the student is unlinked.
export async function listSubscriptionsByStudent(prisma, userId, studentId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const subscriptions = await prisma.studentSubscription.findMany({
    where: { trainerId: trainer.id, studentId },
    orderBy: [{ createdAt: 'desc' }],
  });

  return subscriptions.map(formatSubscription);
}

export async function getActiveSubscriptionByStudent(prisma, userId, studentId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  await verifyTrainerStudentLink(prisma, trainer.id, studentId);

  const subscription = await prisma.studentSubscription.findFirst({
    where: {
      trainerId: trainer.id,
      studentId,
      status: SubscriptionStatus.ACTIVE,
    },
  });

  return subscription ? formatSubscription(subscription) : null;
}

export async function listSubscriptions(prisma, userId, { status, planId } = {}) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const where = { trainerId: trainer.id };
  if (status) where.status = status;
  if (planId) where.planId = planId;

  const subscriptions = await prisma.studentSubscription.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
  });

  return subscriptions.map(formatSubscription);
}

export async function getSubscriptionById(prisma, userId, subscriptionId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const subscription = await prisma.studentSubscription.findFirst({
    where: { id: subscriptionId, trainerId: trainer.id },
  });

  if (!subscription) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_NOT_FOUND,
      message: 'Subscription not found',
    });
  }

  return formatSubscription(subscription);
}

export async function cancelSubscription(prisma, userId, subscriptionId, { reason } = {}, now = new Date()) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const subscription = await prisma.studentSubscription.findFirst({
    where: { id: subscriptionId, trainerId: trainer.id },
  });

  if (!subscription) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_NOT_FOUND,
      message: 'Subscription not found',
    });
  }

  if (subscription.status === SubscriptionStatus.CANCELLED) {
    throw new AppError({
      httpStatus: 409,
      error: SubscriptionErrorCode.CANNOT_EDIT_CANCELLED,
      messageCode: SubscriptionMessageCode.CANNOT_EDIT_CANCELLED,
      message: 'Cannot edit a cancelled subscription',
    });
  }

  const today = todayInBusinessTz(now);
  const updated = await prisma.$transaction(async (tx) => {
    // Conditional on still being active: a concurrent cancel/replace/unlink wins
    // and this call answers 409 instead of overwriting its cancellation data.
    const { count } = await tx.studentSubscription.updateMany({
      where: { id: subscriptionId, status: SubscriptionStatus.ACTIVE },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: now,
        cancellationReason: reason ?? null,
      },
    });
    if (count === 0) {
      throw new AppError({
        httpStatus: 409,
        error: SubscriptionErrorCode.CANNOT_EDIT_CANCELLED,
        messageCode: SubscriptionMessageCode.CANNOT_EDIT_CANCELLED,
        message: 'Cannot edit a cancelled subscription',
      });
    }
    // Not-yet-due charges are voided; already-due pending ones remain as debt.
    await cancelUpcomingPayments(tx, { id: subscriptionId }, today, { now });
    return tx.studentSubscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  });

  return formatSubscription(updated);
}
