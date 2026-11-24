import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
} from '../constants/subscription.js';
import { assertValidMoneyAmount, assertValidPercentage } from '../helpers/subscription-helpers.js';
import {
  defaultServiceType,
  ownerScopeWhere,
  resolvePlanOwnerColumns,
  serviceTypeNotAllowedError,
} from '../helpers/subscription-owner-helpers.js';

const { Decimal } = Prisma;

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Builds the 404 for a plan outside the owner's scope.
function planNotFoundError() {
  return new AppError({
    httpStatus: 404,
    error: SubscriptionErrorCode.PLAN_NOT_FOUND,
    messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
    message: 'Subscription plan not found',
  });
}

// Loads a plan owned by any of the owner's professional rows or throws 404.
async function findOwnedPlanOrThrow(prisma, owner, planId) {
  const plan = await prisma.subscriptionPlan.findFirst({
    where: { id: planId, ...ownerScopeWhere(owner) },
  });
  if (!plan) throw planNotFoundError();
  return plan;
}

// Resolves the service type a patch moves a plan to, refusing a change of owner row.
function resolvePatchedServiceType(owner, existing, patch) {
  if (patch.serviceType === undefined) return existing.serviceType;
  const columns = resolvePlanOwnerColumns(owner, patch.serviceType);
  const sameOwnerRow =
    columns.trainerId === existing.trainerId && columns.nutritionistId === existing.nutritionistId;
  if (!sameOwnerRow) throw serviceTypeNotAllowedError(patch.serviceType);
  return patch.serviceType;
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

function formatPlan(plan, activeSubscriptionCount, activeSubscriptionCountByKind) {
  return {
    id: plan.id,
    trainerId: plan.trainerId ?? null,
    nutritionistId: plan.nutritionistId ?? null,
    serviceType: plan.serviceType,
    name: plan.name,
    description: plan.description ?? null,
    recurrence: plan.recurrence,
    price: plan.price.toString(),
    discountPercent: plan.discountPercent != null ? plan.discountPercent.toString() : null,
    discountAmount: plan.discountAmount != null ? plan.discountAmount.toString() : null,
    billingDay: plan.billingDay ?? null,
    isArchived: plan.deletedAt != null,
    ...(activeSubscriptionCount !== undefined ? { activeSubscriptionCount } : {}),
    ...(activeSubscriptionCountByKind ? { activeSubscriptionCountByKind } : {}),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt ?? null,
  };
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function createPlan(prisma, owner, data) {
  const serviceType = data.serviceType ?? defaultServiceType(owner);
  const ownerColumns = resolvePlanOwnerColumns(owner, serviceType);

  assertValidMoneyAmount(data.price);
  assertValidMoneyAmount(data.discountAmount);
  assertValidPercentage(data.discountPercent);
  validateDiscount(data.price, data.discountPercent ?? null, data.discountAmount ?? null);

  const plan = await prisma.subscriptionPlan.create({
    data: {
      ...ownerColumns,
      serviceType,
      name: data.name,
      description: data.description ?? null,
      recurrence: data.recurrence,
      price: new Decimal(data.price),
      discountPercent: data.discountPercent != null ? new Decimal(data.discountPercent) : null,
      discountAmount: data.discountAmount != null ? new Decimal(data.discountAmount) : null,
      billingDay: data.billingDay ?? null,
    },
  });

  return formatPlan(plan);
}

// Counts active subscriptions per plan, split by whether the subscriber is linked to the owner as trainer student.
async function countActiveSubscriptionsByKind(prisma, owner, planIds) {
  const subscriptions = await prisma.studentSubscription.findMany({
    where: { planId: { in: planIds }, status: SubscriptionStatus.ACTIVE },
    select: { planId: true, studentId: true },
  });
  const studentIds = [...new Set(subscriptions.map((subscription) => subscription.studentId))];
  const links = owner.trainerId && studentIds.length > 0
    ? await prisma.trainerStudent.findMany({
      where: { trainerId: owner.trainerId, studentId: { in: studentIds } },
      select: { studentId: true },
    })
    : [];
  const linkedStudentIds = new Set(links.map((link) => link.studentId));

  const countsByPlanId = new Map();
  for (const { planId, studentId } of subscriptions) {
    const counts = countsByPlanId.get(planId) ?? { students: 0, patients: 0 };
    if (linkedStudentIds.has(studentId)) counts.students += 1;
    else counts.patients += 1;
    countsByPlanId.set(planId, counts);
  }
  return countsByPlanId;
}

const EMPTY_KIND_COUNTS = Object.freeze({ students: 0, patients: 0 });

export async function listPlans(prisma, owner, { includeArchived = false, includeKindCounts = false } = {}) {
  const plans = await prisma.subscriptionPlan.findMany({
    where: {
      ...ownerScopeWhere(owner),
      deletedAt: includeArchived ? undefined : null,
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  // One batched groupBy for every listed plan — never a count per plan.
  const planIds = plans.map((plan) => plan.id);
  const activeCounts = plans.length === 0
    ? []
    : await prisma.studentSubscription.groupBy({
      by: ['planId'],
      where: {
        planId: { in: planIds },
        status: SubscriptionStatus.ACTIVE,
      },
      _count: { _all: true },
    });
  const activeCountByPlanId = new Map(activeCounts.map((row) => [row.planId, row._count._all]));
  const kindCountsByPlanId = includeKindCounts && plans.length > 0
    ? await countActiveSubscriptionsByKind(prisma, owner, planIds)
    : new Map();

  return plans.map((plan) => formatPlan(
    plan,
    activeCountByPlanId.get(plan.id) ?? 0,
    includeKindCounts ? kindCountsByPlanId.get(plan.id) ?? EMPTY_KIND_COUNTS : undefined,
  ));
}

export async function getPlanById(prisma, owner, planId) {
  const plan = await findOwnedPlanOrThrow(prisma, owner, planId);
  return formatPlan(plan);
}

export async function updatePlan(prisma, owner, planId, patch) {
  const existing = await findOwnedPlanOrThrow(prisma, owner, planId);

  if (existing.deletedAt != null) {
    throw new AppError({
      httpStatus: 409,
      error: SubscriptionErrorCode.PLAN_ARCHIVED,
      messageCode: SubscriptionMessageCode.PLAN_ARCHIVED,
      message: 'This plan is archived and cannot be edited',
    });
  }

  const serviceType = resolvePatchedServiceType(owner, existing, patch);
  assertValidMoneyAmount(patch.price);
  assertValidMoneyAmount(patch.discountAmount);
  assertValidPercentage(patch.discountPercent);

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
      serviceType,
      price: new Decimal(newPrice),
      discountPercent:
        newDiscountPercent != null ? new Decimal(newDiscountPercent) : null,
      discountAmount:
        newDiscountAmount != null ? new Decimal(newDiscountAmount) : null,
      billingDay: patch.billingDay !== undefined ? patch.billingDay : existing.billingDay,
    },
  });

  return formatPlan(updated);
}

export async function archivePlan(prisma, owner, planId) {
  const existing = await findOwnedPlanOrThrow(prisma, owner, planId);

  // Idempotent: if already archived, preserve the original timestamp rather than overwriting it.
  const updated = await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: { deletedAt: existing.deletedAt ?? new Date() },
  });

  return formatPlan(updated);
}

export async function unarchivePlan(prisma, owner, planId) {
  await findOwnedPlanOrThrow(prisma, owner, planId);

  const updated = await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: { deletedAt: null },
  });

  return formatPlan(updated);
}
