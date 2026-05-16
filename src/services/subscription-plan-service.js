import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
} from '../constants/subscription.js';

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

/**
 * Validate mutual exclusion and bounds for discount fields.
 * Throws if both are set, or if either exceeds price.
 */
export function validateDiscount(price, discountPercent, discountAmount) {
  const hasPercent = discountPercent != null;
  const hasAmount = discountAmount != null;

  if (hasPercent && hasAmount) {
    throw new AppError({
      httpStatus: 400,
      error: SubscriptionErrorCode.BOTH_DISCOUNTS_SET,
      messageCode: SubscriptionMessageCode.BOTH_DISCOUNTS_SET,
      message: 'Set only one discount type: percentage or fixed amount',
    });
  }

  const priceDecimal = new Decimal(price);

  if (hasPercent) {
    const pct = new Decimal(discountPercent);
    if (pct.lessThan(0) || pct.greaterThan(100)) {
      throw new AppError({
        httpStatus: 400,
        error: SubscriptionErrorCode.DISCOUNT_EXCEEDS_PRICE,
        messageCode: SubscriptionMessageCode.DISCOUNT_EXCEEDS_PRICE,
        message: 'Discount percentage must be between 0 and 100',
      });
    }
  }

  if (hasAmount) {
    const amt = new Decimal(discountAmount);
    if (amt.greaterThan(priceDecimal)) {
      throw new AppError({
        httpStatus: 400,
        error: SubscriptionErrorCode.DISCOUNT_EXCEEDS_PRICE,
        messageCode: SubscriptionMessageCode.DISCOUNT_EXCEEDS_PRICE,
        message: 'The discount cannot exceed the plan price',
      });
    }
  }
}

function formatPlan(plan) {
  return {
    id: plan.id,
    trainerId: plan.trainerId,
    name: plan.name,
    description: plan.description ?? null,
    recurrence: plan.recurrence,
    price: plan.price.toString(),
    discountPercent: plan.discountPercent != null ? plan.discountPercent.toString() : null,
    discountAmount: plan.discountAmount != null ? plan.discountAmount.toString() : null,
    isArchived: plan.deletedAt != null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt ?? null,
  };
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function createPlan(prisma, userId, data) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  validateDiscount(data.price, data.discountPercent ?? null, data.discountAmount ?? null);

  const plan = await prisma.subscriptionPlan.create({
    data: {
      trainerId: trainer.id,
      name: data.name,
      description: data.description ?? null,
      recurrence: data.recurrence,
      price: new Decimal(data.price),
      discountPercent: data.discountPercent != null ? new Decimal(data.discountPercent) : null,
      discountAmount: data.discountAmount != null ? new Decimal(data.discountAmount) : null,
    },
  });

  return formatPlan(plan);
}

export async function listPlans(prisma, userId, { includeArchived = false } = {}) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const plans = await prisma.subscriptionPlan.findMany({
    where: {
      trainerId: trainer.id,
      deletedAt: includeArchived ? undefined : null,
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  return plans.map(formatPlan);
}

export async function getPlanById(prisma, userId, planId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const plan = await prisma.subscriptionPlan.findFirst({
    where: { id: planId, trainerId: trainer.id },
  });

  if (!plan) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.PLAN_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      message: 'Subscription plan not found',
    });
  }

  return formatPlan(plan);
}

export async function updatePlan(prisma, userId, planId, patch) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const existing = await prisma.subscriptionPlan.findFirst({
    where: { id: planId, trainerId: trainer.id },
  });

  if (!existing) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.PLAN_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      message: 'Subscription plan not found',
    });
  }

  if (existing.deletedAt != null) {
    throw new AppError({
      httpStatus: 409,
      error: SubscriptionErrorCode.PLAN_ARCHIVED,
      messageCode: SubscriptionMessageCode.PLAN_ARCHIVED,
      message: 'This plan is archived and cannot be edited',
    });
  }

  const newPrice = patch.price != null ? patch.price : existing.price;
  const newDiscountPercent =
    patch.discountPercent !== undefined ? patch.discountPercent : existing.discountPercent;
  const newDiscountAmount =
    patch.discountAmount !== undefined ? patch.discountAmount : existing.discountAmount;

  validateDiscount(newPrice, newDiscountPercent, newDiscountAmount);

  const updated = await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: {
      name: patch.name !== undefined ? patch.name : existing.name,
      description: patch.description !== undefined ? patch.description : existing.description,
      recurrence: patch.recurrence !== undefined ? patch.recurrence : existing.recurrence,
      price: new Decimal(newPrice),
      discountPercent:
        newDiscountPercent != null ? new Decimal(newDiscountPercent) : null,
      discountAmount:
        newDiscountAmount != null ? new Decimal(newDiscountAmount) : null,
    },
  });

  return formatPlan(updated);
}

export async function archivePlan(prisma, userId, planId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const existing = await prisma.subscriptionPlan.findFirst({
    where: { id: planId, trainerId: trainer.id },
  });

  if (!existing) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.PLAN_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      message: 'Subscription plan not found',
    });
  }

  // Idempotent: if already archived, preserve the original timestamp rather than overwriting it.
  const updated = await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: { deletedAt: existing.deletedAt ?? new Date() },
  });

  return formatPlan(updated);
}

export async function unarchivePlan(prisma, userId, planId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const existing = await prisma.subscriptionPlan.findFirst({
    where: { id: planId, trainerId: trainer.id },
  });

  if (!existing) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.PLAN_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
      message: 'Subscription plan not found',
    });
  }

  const updated = await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: { deletedAt: null },
  });

  return formatPlan(updated);
}
