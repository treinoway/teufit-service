/**
 * Asaas Subscription Service
 *
 * Domain-level functions that coordinate between:
 *   - PlatformSubscription (DB)
 *   - Asaas API (billing provider)
 *   - platform-plan-service (gating)
 *
 * All functions use dependency injection for prisma and asaas client.
 */

import { AppError } from '../errors/app-error.js';
import {
  PLAN_PRICES,
  PLATFORM_SUBSCRIPTION_STATUSES,
  ASAAS_CYCLES,
  PLATFORM_PLAN_TIERS,
} from '../constants/platform-plan.js';
import { getTrainerPlan, syncStudentCapWithPlan } from './platform-plan-service.js';
import * as asaasClient from '../billing/asaas-client.js';

const FREE_TIER = PLATFORM_PLAN_TIERS.FREE;

/**
 * Returns the PlatformSubscription row for a trainer.
 * If none exists, returns a virtual FREE subscription.
 */
export async function getTrainerSubscription(prisma, trainerId) {
  const subscription = await prisma.platformSubscription.findUnique({
    where: { trainerId },
  });
  return subscription;
}

/**
 * Returns or creates an Asaas customer for the trainer.
 * Caches the asaasCustomerId on the PlatformSubscription row.
 */
export async function createOrGetAsaasCustomer(prisma, asaasConfig, httpClient, trainer) {
  const subscription = await prisma.platformSubscription.findUnique({
    where: { trainerId: trainer.id },
  });

  if (subscription?.asaasCustomerId) {
    return asaasClient.getCustomer(httpClient, asaasConfig, subscription.asaasCustomerId);
  }

  // User has no `name` column — build a display name from first/last, falling back to
  // email so Asaas (which requires a non-empty customer name) never gets undefined.
  const displayName =
    [trainer.user.firstName, trainer.user.lastName].filter(Boolean).join(' ') ||
    trainer.user.email;

  const asaasCustomer = await asaasClient.createCustomer(httpClient, asaasConfig, {
    name: displayName,
    email: trainer.user.email,
  });

  if (subscription) {
    await prisma.platformSubscription.update({
      where: { trainerId: trainer.id },
      data: { asaasCustomerId: asaasCustomer.id },
    });
  } else {
    await prisma.platformSubscription.create({
      data: {
        trainerId: trainer.id,
        tier: FREE_TIER,
        status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
        asaasCustomerId: asaasCustomer.id,
      },
    });
  }

  return asaasCustomer;
}

/**
 * Creates an Asaas subscription for a given tier and billing type.
 * Returns { checkoutUrl, dueDate, amount }.
 *
 * Does NOT flip tier — tier flips on PAYMENT_CONFIRMED webhook.
 */
export async function createCheckout(prisma, asaasConfig, httpClient, { trainerId, tier, billingType }) {
  validateTierUpgradeable(tier);

  const trainer = await findTrainerWithUser(prisma, trainerId);

  const { tier: currentTier } = await getTrainerPlan(prisma, trainerId);
  if (currentTier === tier) {
    throw new AppError({
      httpStatus: 409,
      error: 'ALREADY_ON_TIER',
      messageCode: 'platformPlan.alreadyOnTier',
      message: 'You are already on this plan.',
    });
  }

  const asaasCustomer = await createOrGetAsaasCustomer(prisma, asaasConfig, httpClient, trainer);

  const price = PLAN_PRICES[tier].monthly;
  const nextDueDate = formatDateForAsaas(new Date());
  const externalReference = buildExternalReference(tier, trainerId);

  const asaasSubscription = await asaasClient.createSubscription(httpClient, asaasConfig, {
    customer: asaasCustomer.id,
    billingType,
    value: price,
    nextDueDate,
    cycle: ASAAS_CYCLES.MONTHLY,
    description: `Treinoway ${tier} — Mensal`,
    externalReference,
  });

  await prisma.platformSubscription.update({
    where: { trainerId },
    data: { asaasSubscriptionId: asaasSubscription.id },
  });

  return {
    checkoutUrl: asaasSubscription.invoiceUrl ?? null,
    qrCode: asaasSubscription.qrCode ?? null,
    dueDate: nextDueDate,
    amount: price,
    subscriptionId: asaasSubscription.id,
  };
}

/**
 * Schedules cancellation at the end of the current billing period.
 */
export async function cancelAtPeriodEnd(prisma, asaasConfig, httpClient, trainerId) {
  const subscription = await requireActiveSubscription(prisma, trainerId);

  await prisma.platformSubscription.update({
    where: { trainerId },
    data: { cancelAtPeriodEnd: true },
  });

  if (subscription.asaasSubscriptionId) {
    await asaasClient.cancelSubscriptionAtNextCycle(httpClient, asaasConfig, subscription.asaasSubscriptionId);
  }

  return { cancelAtPeriodEnd: true };
}

/**
 * Upgrades or downgrades to a new tier and reconciles the student cap.
 */
export async function changeTier(prisma, asaasConfig, httpClient, trainerId, newTier) {
  validateTierUpgradeable(newTier);

  const { tier: currentTier } = await getTrainerPlan(prisma, trainerId);
  if (currentTier === newTier) {
    throw new AppError({
      httpStatus: 409,
      error: 'ALREADY_ON_TIER',
      messageCode: 'platformPlan.alreadyOnTier',
      message: 'You are already on this plan.',
    });
  }

  const subscription = await requireActiveSubscription(prisma, trainerId);

  if (subscription.asaasSubscriptionId) {
    const newPrice = PLAN_PRICES[newTier].monthly;
    await asaasClient.updateSubscription(httpClient, asaasConfig, subscription.asaasSubscriptionId, {
      value: newPrice,
      externalReference: buildExternalReference(newTier, trainerId),
    });
  }

  await prisma.platformSubscription.update({
    where: { trainerId },
    data: { tier: newTier },
  });

  // Runs both ways: a downgrade blocks students over the new cap, an upgrade
  // unblocks students who were previously blocked by the old cap.
  await syncStudentCapWithPlan(prisma, trainerId);

  return { tier: newTier };
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function validateTierUpgradeable(tier) {
  if (tier === FREE_TIER || !PLATFORM_PLAN_TIERS[tier]) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_TIER',
      messageCode: 'platformPlan.invalidTier',
      message: 'Invalid plan tier.',
    });
  }
}

async function findTrainerWithUser(prisma, trainerId) {
  const trainer = await prisma.trainer.findUnique({
    where: { id: trainerId },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
  });
  if (!trainer) {
    throw new AppError({
      httpStatus: 404,
      error: 'TRAINER_NOT_FOUND',
      messageCode: 'trainer.notFound',
      message: 'Trainer profile not found.',
    });
  }
  return trainer;
}

async function requireActiveSubscription(prisma, trainerId) {
  const subscription = await prisma.platformSubscription.findUnique({
    where: { trainerId },
  });
  if (!subscription) {
    throw new AppError({
      httpStatus: 404,
      error: 'SUBSCRIPTION_NOT_FOUND',
      messageCode: 'platformPlan.invalidTier',
      message: 'No active subscription found.',
    });
  }
  return subscription;
}

function formatDateForAsaas(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildExternalReference(tier, trainerId) {
  return `tier:${tier}:trainer:${trainerId}`;
}

function parseTierFromExternalReference(externalReference) {
  if (!externalReference) return null;
  const match = externalReference.match(/^tier:([A-Z]+):trainer:/);
  return match ? match[1] : null;
}

export { parseTierFromExternalReference };
