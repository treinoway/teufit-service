import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
  PaymentStatus,
} from '../constants/subscription.js';
import { formatDateOnly, parseDateOnlyAsUtc } from '../helpers/date-helpers.js';
import { computeCycleEndDate } from '../helpers/subscription-helpers.js';
import { validateDiscount } from './subscription-plan-service.js';

const { Decimal } = Prisma;

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

async function verifyTrainerStudentLink(prisma, trainerId, studentId) {
  const link = await prisma.trainerStudent.findFirst({
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

/**
 * Compute the net amount after applying discount.
 * Returns a Decimal floored at 0.
 */
export function computeAmount(price, discountPercent, discountAmount) {
  const priceDecimal = new Decimal(price);

  if (discountPercent != null) {
    const pct = new Decimal(discountPercent);
    const discounted = priceDecimal.times(pct).dividedBy(100);
    return Decimal.max(priceDecimal.minus(discounted), new Decimal(0));
  }

  if (discountAmount != null) {
    const amt = new Decimal(discountAmount);
    return Decimal.max(priceDecimal.minus(amt), new Decimal(0));
  }

  return priceDecimal;
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

function formatPayment(payment) {
  return {
    id: payment.id,
    subscriptionId: payment.subscriptionId,
    cycleStartDate: formatDateOnly(payment.cycleStartDate),
    cycleEndDate: formatDateOnly(payment.cycleEndDate),
    dueDate: formatDateOnly(payment.dueDate),
    amount: payment.amount.toString(),
    status: payment.status,
    paidAt: payment.paidAt ?? null,
    notes: payment.notes ?? null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt ?? null,
  };
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function assignPlanToStudent(prisma, userId, studentId, data) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  await verifyTrainerStudentLink(prisma, trainer.id, studentId);

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
  validateDiscount(plan.price, effectiveDiscountPercent, effectiveDiscountAmount);

  const startDate = parseDateOnlyAsUtc(data.startDate);
  const cycleEndDate = computeCycleEndDate(startDate, plan.recurrence);
  const netAmount = computeAmount(plan.price, effectiveDiscountPercent, effectiveDiscountAmount);

  const result = await prisma.$transaction(async (tx) => {
    // Cancel any existing active subscription for this student under this trainer
    await tx.studentSubscription.updateMany({
      where: {
        trainerId: trainer.id,
        studentId,
        status: SubscriptionStatus.ACTIVE,
      },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: 'Replaced by new plan assignment',
      },
    });

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
        cycleStartDate: startDate,
        cycleEndDate,
        dueDate: startDate,
        amount: netAmount,
        status: PaymentStatus.PENDING,
      },
    });

    return { subscription, payment };
  });

  return {
    ...formatSubscription(result.subscription),
    firstPayment: formatPayment(result.payment),
  };
}

export async function listSubscriptionsByStudent(prisma, userId, studentId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  await verifyTrainerStudentLink(prisma, trainer.id, studentId);

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

export async function cancelSubscription(prisma, userId, subscriptionId, { reason } = {}) {
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

  const updated = await prisma.studentSubscription.update({
    where: { id: subscriptionId },
    data: {
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: new Date(),
      cancellationReason: reason ?? null,
    },
  });

  return formatSubscription(updated);
}
