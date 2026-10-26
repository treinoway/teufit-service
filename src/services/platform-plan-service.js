import { AppError } from '../errors/app-error.js';
import {
  PLAN_LIMITS,
  PLATFORM_PLAN_ERRORS,
  PAST_DUE_GRACE_DAYS,
  PLATFORM_SUBSCRIPTION_STATUSES,
  ASAAS_UNLINK_DATA,
  isPurchasableTier,
  getBillingMonth,
} from '../constants/platform-plan.js';

const FREE_TIER = 'FREE';
const FREE_LIMITS = PLAN_LIMITS.FREE;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function throwPlanError(errorDef, details) {
  throw new AppError({
    httpStatus: errorDef.status,
    error: errorDef.code,
    messageCode: errorDef.messageCode,
    message: errorDef.code
      .split('_')
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' '),
    details,
  });
}

// Detaches an invite-granted tier from the unpaid Asaas link; the tier is kept.
async function detachUnbilledTier(prisma, trainerId, subscription) {
  await prisma.platformSubscription.update({ where: { trainerId }, data: ASAAS_UNLINK_DATA });
  return {
    tier: subscription.tier,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    limits: PLAN_LIMITS[subscription.tier] ?? FREE_LIMITS,
    subscription: { ...subscription, ...ASAAS_UNLINK_DATA },
  };
}

// Downgrades a paid tier to FREE once the past-due grace period has run out.
async function downgradeToFree(prisma, trainerId, subscription) {
  await prisma.platformSubscription.update({
    where: { trainerId },
    data: {
      tier: FREE_TIER,
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      asaasSubscriptionId: null,
    },
  });
  await enforceStudentCapAfterDowngrade(prisma, trainerId);
  return {
    tier: FREE_TIER,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    limits: FREE_LIMITS,
    subscription: { ...subscription, tier: FREE_TIER, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE },
  };
}

// Resolves an expired grace period: paid tiers fall to FREE, invite-granted tiers just lose the Asaas link.
function expireGracePeriod(prisma, trainerId, subscription) {
  if (isPurchasableTier(subscription.tier)) return downgradeToFree(prisma, trainerId, subscription);
  return detachUnbilledTier(prisma, trainerId, subscription);
}

export async function getTrainerPlan(prisma, trainerId) {
  const subscription = await prisma.platformSubscription.findUnique({
    where: { trainerId },
  });

  if (!subscription) {
    return {
      tier: FREE_TIER,
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      limits: FREE_LIMITS,
      subscription: null,
    };
  }

  // Past-due grace check: if status=PAST_DUE and grace period has expired,
  // downgrade to FREE without triggering another getTrainerPlan call.
  if (
    subscription.status === PLATFORM_SUBSCRIPTION_STATUSES.PAST_DUE &&
    subscription.pastDueSince !== null
  ) {
    const daysPastDue = (Date.now() - subscription.pastDueSince.getTime()) / MS_PER_DAY;
    if (daysPastDue >= PAST_DUE_GRACE_DAYS) {
      return expireGracePeriod(prisma, trainerId, subscription);
    }
  }

  const limits = PLAN_LIMITS[subscription.tier] ?? FREE_LIMITS;

  return {
    tier: subscription.tier,
    status: subscription.status,
    limits,
    subscription,
  };
}

export async function assertStudentCap(prisma, trainerId) {
  const { limits } = await getTrainerPlan(prisma, trainerId);

  if (limits.studentCap === Infinity) return;

  const activeCount = await prisma.trainerStudent.count({
    where: { trainerId, activeOnPlan: true },
  });

  if (activeCount >= limits.studentCap) {
    throwPlanError(PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED, {
      current: activeCount,
      cap: limits.studentCap,
    });
  }
}

export async function assertCanUseBranding(prisma, trainerId) {
  const { limits } = await getTrainerPlan(prisma, trainerId);

  if (!limits.branding) {
    throwPlanError(PLATFORM_PLAN_ERRORS.BRANDING_NOT_AVAILABLE);
  }
}

export async function assertCanCreateChallenge(prisma, trainerId) {
  const { limits } = await getTrainerPlan(prisma, trainerId);

  if (!limits.championships) {
    throwPlanError(PLATFORM_PLAN_ERRORS.CHAMPIONSHIPS_NOT_AVAILABLE);
  }
}

export async function assertCanUseAi(prisma, trainerId, studentId = null) {
  const { limits } = await getTrainerPlan(prisma, trainerId);

  if (limits.aiActionsPerStudent === 0 && limits.aiActionsTrainerCap === 0) {
    throwPlanError(PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE);
  }

  const billingMonth = getBillingMonth();

  if (studentId !== null && limits.aiActionsPerStudent !== Infinity) {
    const studentUsed = await prisma.aiUsageEvent.count({
      where: { trainerId, studentId, billingMonth },
    });

    if (studentUsed >= limits.aiActionsPerStudent) {
      throwPlanError(PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED, {
        used: studentUsed,
        remaining: 0,
        cap: limits.aiActionsPerStudent,
        scope: 'student',
      });
    }
  }

  if (limits.aiActionsTrainerCap !== null) {
    const trainerUsed = await prisma.aiUsageEvent.count({
      where: { trainerId, billingMonth },
    });

    if (trainerUsed >= limits.aiActionsTrainerCap) {
      throwPlanError(PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED, {
        used: trainerUsed,
        remaining: 0,
        cap: limits.aiActionsTrainerCap,
        scope: 'trainer',
      });
    }
  }
}

export async function recordAiAction(prisma, trainerId, studentId, action) {
  await prisma.aiUsageEvent.create({
    data: {
      trainerId,
      studentId: studentId ?? null,
      action,
      billingMonth: getBillingMonth(),
    },
  });
}

export async function assertStudentActiveOnPlan(prisma, trainerId, studentId) {
  const link = await prisma.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId, studentId } },
    select: { activeOnPlan: true },
  });

  if (!link || !link.activeOnPlan) {
    throwPlanError(PLATFORM_PLAN_ERRORS.STUDENT_BLOCKED_ON_PLAN, {
      studentId,
    });
  }
}

/**
 * Build the `platformPlan` payload for the /me response.
 *
 * Returns the combined plan + usage summary for the given trainer ID.
 * Never returns null — callers are responsible for guard-checking that a
 * Trainer record exists before calling this function.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId - Internal Trainer.id (not userId)
 */
export async function buildPlatformPlanForMe(prisma, trainerId) {
  const { tier, status, limits, subscription } = await getTrainerPlan(prisma, trainerId);
  const billingMonth = getBillingMonth();

  const [activeStudentCount, blockedStudentCount, aiUsageByStudent] = await Promise.all([
    prisma.trainerStudent.count({ where: { trainerId, activeOnPlan: true } }),
    prisma.trainerStudent.count({ where: { trainerId, activeOnPlan: false } }),
    prisma.aiUsageEvent.groupBy({
      by: ['studentId'],
      where: { trainerId, billingMonth },
      _count: { _all: true },
    }),
  ]);

  const totalAiActions = aiUsageByStudent.reduce((sum, row) => sum + row._count._all, 0);

  const finiteOrNull = (value) => (value === Infinity ? null : value);

  return {
    tier,
    status,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    limits: {
      studentCap: finiteOrNull(limits.studentCap),
      aiActionsPerStudent: finiteOrNull(limits.aiActionsPerStudent),
      aiActionsTrainerCap: finiteOrNull(limits.aiActionsTrainerCap),
      branding: limits.branding,
      championships: limits.championships,
    },
    usage: {
      students: {
        active: activeStudentCount,
        blocked: blockedStudentCount,
        cap: finiteOrNull(limits.studentCap),
      },
      aiActions: {
        total: totalAiActions,
        byStudent: aiUsageByStudent.map((row) => ({
          studentId: row.studentId,
          count: row._count._all,
        })),
      },
    },
  };
}

export async function enforceStudentCapAfterDowngrade(prisma, trainerId) {
  const { limits } = await getTrainerPlan(prisma, trainerId);

  if (limits.studentCap === Infinity) return;

  const activeStudents = await prisma.trainerStudent.findMany({
    where: { trainerId, activeOnPlan: true },
    orderBy: { createdAt: 'asc' },
    select: { trainerId: true, studentId: true },
  });

  const excessCount = activeStudents.length - limits.studentCap;
  if (excessCount <= 0) return;

  const toBlock = activeStudents.slice(0, excessCount);

  await prisma.trainerStudent.updateMany({
    where: {
      trainerId,
      studentId: { in: toBlock.map((s) => s.studentId) },
    },
    data: { activeOnPlan: false },
  });
}

// Reactivates the oldest blocked students until the trainer's active count reaches the plan cap.
export async function reactivateStudentsUpToCap(prisma, trainerId) {
  const { limits } = await getTrainerPlan(prisma, trainerId);

  const activeCount = await prisma.trainerStudent.count({
    where: { trainerId, activeOnPlan: true },
  });
  const freeSlots = limits.studentCap === Infinity ? Infinity : limits.studentCap - activeCount;
  if (freeSlots <= 0) return;

  const blockedStudents = await prisma.trainerStudent.findMany({
    where: { trainerId, activeOnPlan: false },
    orderBy: { createdAt: 'asc' },
    select: { studentId: true },
    ...(freeSlots === Infinity ? {} : { take: freeSlots }),
  });
  const toReactivate = blockedStudents.slice(0, freeSlots);
  if (toReactivate.length === 0) return;

  await prisma.trainerStudent.updateMany({
    where: { trainerId, studentId: { in: toReactivate.map((link) => link.studentId) } },
    data: { activeOnPlan: true },
  });
}
