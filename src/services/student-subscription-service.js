import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
  PaymentStatus,
  CANCELLATION_REASON_REPLACED,
  ServiceType,
} from '../constants/subscription.js';
import { addDaysMs, formatDateOnly, parseDateOnlyAsUtc, todayInBusinessTz } from '../helpers/date-helpers.js';
import {
  assertValidMoneyAmount,
  assertValidPercentage,
  computeAmount,
  computeEffectiveStart,
  computeNextCycle,
  formatPayment,
} from '../helpers/subscription-helpers.js';
import {
  buildProfessionalAssignmentLockKey,
  ownerScopeWhere,
  requiredLinkSatisfied,
} from '../helpers/subscription-owner-helpers.js';
import { cancelUpcomingPayments, materializeCycles } from './subscription-cycle-service.js';
import { validateDiscount } from './subscription-plan-service.js';
import { assertStudentActiveOnPlan } from './platform-plan-service.js';
import { loadLinks, resolveOwnerRows } from './professional-owner-service.js';

const { Decimal } = Prisma;
const UNIQUE_VIOLATION_CODE = 'P2002';

// Re-exported for existing importers; the implementation lives in subscription-helpers.js.
export { computeAmount };

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Loads the live links and throws 403 student.notLinked unless they satisfy the service type.
async function assertLinkedOrThrow(client, owner, studentId, serviceType) {
  const links = await loadLinks(client, owner, studentId);

  if (!requiredLinkSatisfied(serviceType, links)) {
    throw new AppError({
      httpStatus: 403,
      error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
      messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      message: 'This student is not linked to your account',
    });
  }

  return links;
}

// Builds the 404 for a subscription outside the owner's scope.
function subscriptionNotFoundError() {
  return new AppError({
    httpStatus: 404,
    error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
    messageCode: SubscriptionMessageCode.SUBSCRIPTION_NOT_FOUND,
    message: 'Subscription not found',
  });
}

// Loads a plan owned by any of the owner's rows and usable for a new assignment, or throws.
async function findAssignablePlanOrThrow(prisma, owner, planId) {
  const plan = await prisma.subscriptionPlan.findFirst({
    where: { id: planId, ...ownerScopeWhere(owner) },
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

  return plan;
}

// Consumes the trainer seat quota when the assignment bills a person who is the owner's trainer student.
async function assertTrainerSeatIfNeeded(prisma, owner, studentId, serviceType, links) {
  const billsTraining =
    serviceType === ServiceType.TRAINING || (serviceType === ServiceType.BOTH && links.trainerLinked);
  if (owner.trainerId && billsTraining) {
    await assertStudentActiveOnPlan(prisma, owner.trainerId, studentId);
  }
}

function formatSubscription(sub) {
  return {
    id: sub.id,
    trainerId: sub.trainerId ?? null,
    nutritionistId: sub.nutritionistId ?? null,
    serviceType: sub.serviceType,
    studentId: sub.studentId,
    planId: sub.planId,
    recurrence: sub.recurrence,
    price: sub.price.toString(),
    discountPercent: sub.discountPercent != null ? sub.discountPercent.toString() : null,
    discountAmount: sub.discountAmount != null ? sub.discountAmount.toString() : null,
    billingDay: sub.billingDay ?? sub.startDate.getUTCDate(),
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
 * Serialize assignments per professional-user/student pair: only one assignment can be
 * in flight at a time. A concurrent one (double click, two tabs) gets a
 * deterministic 409 immediately instead of racing the replace-then-insert
 * sequence (which could otherwise create a duplicate due charge for the
 * subscription it just replaced). Assignments that do not overlap in time
 * replace the previous subscription as usual. The lock is transaction-scoped.
 */
async function acquireAssignmentLockOrThrow(tx, userId, studentId) {
  const [{ locked }] = await tx.$queryRaw`
    SELECT pg_try_advisory_xact_lock(hashtext(${buildProfessionalAssignmentLockKey(userId, studentId)})) AS locked
  `;
  if (!locked) throw buildAlreadyActiveError();
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function assignPlanToStudent(prisma, owner, studentId, data, now = new Date()) {
  const plan = await findAssignablePlanOrThrow(prisma, owner, data.planId);
  const links = await assertLinkedOrThrow(prisma, owner, studentId, plan.serviceType);
  await assertTrainerSeatIfNeeded(prisma, owner, studentId, plan.serviceType, links);

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
  const billingDay = data.billingDay ?? plan.billingDay ?? null;
  const firstCycle = computeNextCycle({ startDate, recurrence: plan.recurrence, billingDay }, null, today);
  const effectiveStart = computeEffectiveStart(firstCycle.cycleStartDate, startDate);
  const netAmount = computeAmount(plan.price, effectiveDiscountPercent, effectiveDiscountAmount);

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      await acquireAssignmentLockOrThrow(tx, owner.userId, studentId);
      // Re-check inside the lock: an unlink may have committed since the first check.
      await assertLinkedOrThrow(tx, owner, studentId, plan.serviceType);

      // Replace the active subscription(s) of this student held by this professional user through any owner row.
      const replacementOwner = await resolveOwnerRows(tx, owner.userId, owner);
      const replaced = await tx.studentSubscription.findMany({
        where: { ...ownerScopeWhere(replacementOwner), studentId, status: SubscriptionStatus.ACTIVE },
        select: {
          id: true,
          startDate: true,
          recurrence: true,
          price: true,
          discountPercent: true,
          discountAmount: true,
          billingDay: true,
        },
      });
      const replacedIds = replaced.map((subscription) => subscription.id);
      if (replacedIds.length > 0) {
        // Future-dated replacement: the old plan keeps billing until the new one
        // starts, so its cycles starting in [today+1, newStart) must exist before
        // it is cancelled (the conditional insert only writes for active subscriptions).
        if (effectiveStart > today) {
          await materializeCycles(tx, replaced, addDaysMs(effectiveStart, -1), today, today);
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
          replacementCycleStart: effectiveStart,
        });
      }

      const subscription = await tx.studentSubscription.create({
        data: {
          trainerId: plan.trainerId,
          nutritionistId: plan.nutritionistId,
          serviceType: plan.serviceType,
          studentId,
          planId: plan.id,
          recurrence: plan.recurrence,
          price: plan.price,
          discountPercent:
            effectiveDiscountPercent != null ? new Decimal(effectiveDiscountPercent) : null,
          discountAmount:
            effectiveDiscountAmount != null ? new Decimal(effectiveDiscountAmount) : null,
          billingDay,
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
          dueDate: effectiveStart,
          amount: netAmount,
          status: PaymentStatus.PENDING,
        },
      });

      return { subscription, payment };
    });
  } catch (error) {
    // Safety net: the per-pair partial unique indexes (one active subscription
    // per trainer/student and per nutritionist/student) rejected a concurrent insert.
    if (error?.code === UNIQUE_VIOLATION_CODE) throw buildAlreadyActiveError();
    throw error;
  }

  return {
    ...formatSubscription(result.subscription),
    firstPayment: formatPayment(result.payment, today),
  };
}

// Scoped by owner only (no live link required) so the billing history stays
// reachable after the student is unlinked.
export async function listSubscriptionsByStudent(prisma, owner, studentId) {
  const subscriptions = await prisma.studentSubscription.findMany({
    where: { ...ownerScopeWhere(owner), studentId },
    orderBy: [{ createdAt: 'desc' }],
  });

  return subscriptions.map(formatSubscription);
}

export async function getActiveSubscriptionByStudent(prisma, owner, studentId) {
  await assertLinkedOrThrow(prisma, owner, studentId, ServiceType.BOTH);

  const subscription = await prisma.studentSubscription.findFirst({
    where: {
      ...ownerScopeWhere(owner),
      studentId,
      status: SubscriptionStatus.ACTIVE,
    },
    orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
  });

  return subscription ? formatSubscription(subscription) : null;
}

export async function listSubscriptions(prisma, owner, { status, planId } = {}) {
  const where = { ...ownerScopeWhere(owner) };
  if (status) where.status = status;
  if (planId) where.planId = planId;

  const subscriptions = await prisma.studentSubscription.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
  });

  return subscriptions.map(formatSubscription);
}

export async function getSubscriptionById(prisma, owner, subscriptionId) {
  const subscription = await prisma.studentSubscription.findFirst({
    where: { id: subscriptionId, ...ownerScopeWhere(owner) },
  });

  if (!subscription) throw subscriptionNotFoundError();

  return formatSubscription(subscription);
}

export async function cancelSubscription(prisma, owner, subscriptionId, { reason } = {}, now = new Date()) {
  const subscription = await prisma.studentSubscription.findFirst({
    where: { id: subscriptionId, ...ownerScopeWhere(owner) },
  });

  if (!subscription) throw subscriptionNotFoundError();

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
