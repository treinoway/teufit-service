/**
 * Asaas Webhook Service
 *
 * Handles incoming Asaas webhook events and updates PlatformSubscription state.
 *
 * Idempotency: payment events are skipped if the asaasPaymentId is already
 * in the desired final state.
 *
 * All functions accept prisma as first argument (DI). The logger is optional
 * and defaults to console.
 */

import {
  ASAAS_WEBHOOK_EVENTS,
  ASAAS_PAYMENT_STATUSES,
  PLATFORM_SUBSCRIPTION_STATUSES,
  PLATFORM_PLAN_TIERS,
  isTierUpgrade,
} from '../constants/platform-plan.js';
import { enforceStudentCapAfterDowngrade, reactivateStudentsUpToCap } from './platform-plan-service.js';
import { parseTierFromExternalReference } from './asaas-subscription-service.js';

const FREE_TIER = PLATFORM_PLAN_TIERS.FREE;

/**
 * Main dispatcher — routes events to their specific handlers.
 * Returns false if the event type is unrecognized (caller should still 200).
 */
export async function handleWebhookEvent(prisma, event, logger = console) {
  const { event: eventType, payment, subscription } = event;

  switch (eventType) {
    case ASAAS_WEBHOOK_EVENTS.PAYMENT_CREATED:
      await handlePaymentCreated(prisma, payment, logger);
      break;

    case ASAAS_WEBHOOK_EVENTS.PAYMENT_CONFIRMED:
    case ASAAS_WEBHOOK_EVENTS.PAYMENT_RECEIVED:
      await handlePaymentConfirmed(prisma, payment, logger);
      break;

    case ASAAS_WEBHOOK_EVENTS.PAYMENT_OVERDUE:
      await handlePaymentOverdue(prisma, payment, logger);
      break;

    case ASAAS_WEBHOOK_EVENTS.PAYMENT_REFUNDED:
      await handlePaymentRefunded(prisma, payment, logger);
      break;

    case ASAAS_WEBHOOK_EVENTS.SUBSCRIPTION_CREATED:
      logger.info({ subscriptionId: subscription?.id }, '[asaas-webhook] SUBSCRIPTION_CREATED — no-op');
      break;

    case ASAAS_WEBHOOK_EVENTS.SUBSCRIPTION_DELETED:
      await handleSubscriptionDeleted(prisma, subscription, logger);
      break;

    case ASAAS_WEBHOOK_EVENTS.SUBSCRIPTION_UPDATED:
      logger.info({ subscriptionId: subscription?.id }, '[asaas-webhook] SUBSCRIPTION_UPDATED — no-op');
      break;

    default:
      logger.warn({ eventType }, '[asaas-webhook] Unrecognized event type — ignoring');
      return false;
  }

  return true;
}

// ─── Event handlers ────────────────────────────────────────────────────────────

async function handlePaymentCreated(prisma, payment, logger) {
  if (!payment?.id) return;

  const existing = await prisma.platformSubscriptionPayment.findUnique({
    where: { asaasPaymentId: payment.id },
  });
  if (existing) {
    logger.info({ paymentId: payment.id }, '[asaas-webhook] PAYMENT_CREATED — already exists, skipping');
    return;
  }

  const platformSubscription = await findSubscriptionByAsaasId(prisma, payment.subscription);
  if (!platformSubscription) {
    logger.warn({ asaasSubscriptionId: payment.subscription }, '[asaas-webhook] PAYMENT_CREATED — subscription not found in DB');
    return;
  }

  await prisma.platformSubscriptionPayment.create({
    data: {
      subscriptionId: platformSubscription.id,
      asaasPaymentId: payment.id,
      amount: payment.value ?? 0,
      status: ASAAS_PAYMENT_STATUSES.PENDING,
      dueDate: parseDueDate(payment.dueDate),
      billingType: normalizeBillingType(payment.billingType),
    },
  });

  logger.info({ paymentId: payment.id }, '[asaas-webhook] PAYMENT_CREATED — upserted as PENDING');
}

async function handlePaymentConfirmed(prisma, payment, logger) {
  if (!payment?.id) return;

  const existingPayment = await prisma.platformSubscriptionPayment.findUnique({
    where: { asaasPaymentId: payment.id },
  });

  // Idempotency: skip if already confirmed
  if (existingPayment?.status === ASAAS_PAYMENT_STATUSES.CONFIRMED) {
    logger.info({ paymentId: payment.id }, '[asaas-webhook] PAYMENT_CONFIRMED — already confirmed, skipping');
    return;
  }

  const platformSubscription = await findSubscriptionByAsaasId(prisma, payment.subscription);
  if (!platformSubscription) {
    logger.warn({ asaasSubscriptionId: payment.subscription }, '[asaas-webhook] PAYMENT_CONFIRMED — subscription not found in DB');
    return;
  }

  // Upsert the payment record
  await prisma.platformSubscriptionPayment.upsert({
    where: { asaasPaymentId: payment.id },
    create: {
      subscriptionId: platformSubscription.id,
      asaasPaymentId: payment.id,
      amount: payment.value ?? 0,
      status: ASAAS_PAYMENT_STATUSES.CONFIRMED,
      dueDate: parseDueDate(payment.dueDate),
      paidAt: new Date(),
      billingType: normalizeBillingType(payment.billingType),
    },
    update: {
      status: ASAAS_PAYMENT_STATUSES.CONFIRMED,
      paidAt: new Date(),
    },
  });

  // Resolve the tier from the subscription's externalReference
  const resolvedTier = resolveTierFromPayment(payment, platformSubscription);

  if (resolvedTier === null) {
    logger.warn(
      {
        paymentId: payment.id,
        trainerId: platformSubscription.trainerId,
        externalReference: payment.externalReference ?? null,
      },
      '[asaas-webhook] PAYMENT_CONFIRMED — externalReference missing or unparseable; tier left unchanged',
    );
  }

  // Compute new period end: 1 month from due date
  const currentPeriodEnd = payment.dueDate
    ? addOneMonth(new Date(payment.dueDate))
    : null;

  await prisma.platformSubscription.update({
    where: { id: platformSubscription.id },
    data: {
      ...(resolvedTier !== null && { tier: resolvedTier }),
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      pastDueSince: null,
      currentPeriodEnd,
      cancelAtPeriodEnd: false,
    },
  });

  if (resolvedTier !== null && isTierUpgrade(platformSubscription.tier, resolvedTier)) {
    await reactivateStudentsUpToCap(prisma, platformSubscription.trainerId);
  }

  logger.info(
    { paymentId: payment.id, tier: resolvedTier ?? platformSubscription.tier },
    '[asaas-webhook] PAYMENT_CONFIRMED — subscription activated',
  );
}

async function handlePaymentOverdue(prisma, payment, logger) {
  if (!payment?.id) return;

  const platformSubscription = await findSubscriptionByAsaasId(prisma, payment.subscription);
  if (!platformSubscription) {
    logger.warn({ asaasSubscriptionId: payment.subscription }, '[asaas-webhook] PAYMENT_OVERDUE — subscription not found in DB');
    return;
  }

  // Update payment status
  await prisma.platformSubscriptionPayment.upsert({
    where: { asaasPaymentId: payment.id },
    create: {
      subscriptionId: platformSubscription.id,
      asaasPaymentId: payment.id,
      amount: payment.value ?? 0,
      status: ASAAS_PAYMENT_STATUSES.OVERDUE,
      dueDate: parseDueDate(payment.dueDate),
      billingType: normalizeBillingType(payment.billingType),
    },
    update: {
      status: ASAAS_PAYMENT_STATUSES.OVERDUE,
    },
  });

  // Only set pastDueSince once — don't overwrite if already set
  const pastDueSince = platformSubscription.pastDueSince ?? new Date();

  await prisma.platformSubscription.update({
    where: { id: platformSubscription.id },
    data: {
      status: PLATFORM_SUBSCRIPTION_STATUSES.PAST_DUE,
      pastDueSince,
    },
  });

  logger.info({ paymentId: payment.id }, '[asaas-webhook] PAYMENT_OVERDUE — marked PAST_DUE');
}

async function handlePaymentRefunded(prisma, payment, logger) {
  if (!payment?.id) return;

  await prisma.platformSubscriptionPayment.updateMany({
    where: { asaasPaymentId: payment.id },
    data: { status: ASAAS_PAYMENT_STATUSES.REFUNDED },
  });

  logger.info({ paymentId: payment.id }, '[asaas-webhook] PAYMENT_REFUNDED — marked as refunded');
}

async function handleSubscriptionDeleted(prisma, subscription, logger) {
  if (!subscription?.id) return;

  const platformSubscription = await findSubscriptionByAsaasId(prisma, subscription.id);
  if (!platformSubscription) {
    logger.warn({ asaasSubscriptionId: subscription.id }, '[asaas-webhook] SUBSCRIPTION_DELETED — not found in DB');
    return;
  }

  await prisma.platformSubscription.update({
    where: { id: platformSubscription.id },
    data: {
      tier: FREE_TIER,
      status: PLATFORM_SUBSCRIPTION_STATUSES.CANCELED,
      asaasSubscriptionId: null,
    },
  });

  await enforceStudentCapAfterDowngrade(prisma, platformSubscription.trainerId);

  logger.info(
    { asaasSubscriptionId: subscription.id, trainerId: platformSubscription.trainerId },
    '[asaas-webhook] SUBSCRIPTION_DELETED — downgraded to FREE, soft-block enforced',
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

const VALID_BILLING_TYPES = new Set(['PIX', 'CREDIT_CARD', 'BOLETO']);

function normalizeBillingType(rawBillingType) {
  if (VALID_BILLING_TYPES.has(rawBillingType)) return rawBillingType;
  // UNDEFINED or anything else → default to PIX (least assumption)
  return 'PIX';
}

function parseDueDate(rawDueDate) {
  if (rawDueDate) {
    const parsed = new Date(rawDueDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

async function findSubscriptionByAsaasId(prisma, asaasSubscriptionId) {
  if (!asaasSubscriptionId) return null;
  return prisma.platformSubscription.findFirst({
    where: { asaasSubscriptionId },
  });
}

/**
 * Parses the intended tier from the payment's externalReference.
 * Returns the tier string on success, or null if externalReference is
 * missing, unparseable, or resolves to FREE (which should never be billed).
 * Callers must NOT flip the subscription tier when null is returned.
 */
function resolveTierFromPayment(payment, platformSubscription) {
  const refTier = parseTierFromExternalReference(payment.externalReference);
  if (refTier && PLATFORM_PLAN_TIERS[refTier] && refTier !== FREE_TIER) {
    return refTier;
  }
  // externalReference is missing or unparseable — fall back to the existing
  // DB tier only when it is already a paid tier (safe: we know from previous
  // payment/checkout what tier was set). If the current tier is FREE we cannot
  // verify what was purchased, so return null to block any upgrade.
  if (platformSubscription.tier !== FREE_TIER) {
    return platformSubscription.tier;
  }
  return null;
}

function addOneMonth(date) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + 1);
  return result;
}
