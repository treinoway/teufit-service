import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  PaymentStatus,
} from '../constants/subscription.js';
import { formatDateOnly, parseDateOnlyAsUtc } from '../helpers/date-helpers.js';
import { computeAmount } from './student-subscription-service.js';
import { computeCycleEndDate } from '../helpers/subscription-helpers.js';

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

async function resolveSubscriptionOrThrow(prisma, trainerId, subscriptionId) {
  const subscription = await prisma.studentSubscription.findFirst({
    where: { id: subscriptionId, trainerId },
  });

  if (!subscription) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_NOT_FOUND,
      message: 'Subscription not found',
    });
  }

  return subscription;
}

async function resolvePaymentOrThrow(prisma, trainerId, paymentId) {
  const payment = await prisma.subscriptionPayment.findFirst({
    where: { id: paymentId },
    include: { subscription: { select: { trainerId: true } } },
  });

  if (!payment || payment.subscription.trainerId !== trainerId) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.PAYMENT_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PAYMENT_NOT_FOUND,
      message: 'Subscription payment not found',
    });
  }

  return payment;
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

export async function createPayment(prisma, userId, subscriptionId, data) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);
  const subscription = await resolveSubscriptionOrThrow(prisma, trainer.id, subscriptionId);

  const cycleStartDate = parseDateOnlyAsUtc(data.cycleStartDate);
  const cycleEndDate = computeCycleEndDate(cycleStartDate, subscription.recurrence);
  const dueDate = data.dueDate ? parseDateOnlyAsUtc(data.dueDate) : cycleStartDate;
  const netAmount = computeAmount(
    subscription.price,
    subscription.discountPercent,
    subscription.discountAmount,
  );

  const payment = await prisma.subscriptionPayment.create({
    data: {
      subscriptionId: subscription.id,
      cycleStartDate,
      cycleEndDate,
      dueDate,
      amount: netAmount,
      status: PaymentStatus.PENDING,
      notes: data.notes ?? null,
    },
  });

  return formatPayment(payment);
}

export async function listPaymentsBySubscription(prisma, userId, subscriptionId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);
  await resolveSubscriptionOrThrow(prisma, trainer.id, subscriptionId);

  const payments = await prisma.subscriptionPayment.findMany({
    where: { subscriptionId },
    orderBy: [{ cycleStartDate: 'desc' }],
  });

  return payments.map(formatPayment);
}

export async function markPaymentPaid(prisma, userId, paymentId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);
  const payment = await resolvePaymentOrThrow(prisma, trainer.id, paymentId);

  const updated = await prisma.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.PAID,
      paidAt: payment.paidAt ?? new Date(),
    },
  });

  return formatPayment(updated);
}

export async function markPaymentPending(prisma, userId, paymentId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);
  const payment = await resolvePaymentOrThrow(prisma, trainer.id, paymentId);

  const updated = await prisma.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.PENDING,
      paidAt: null,
    },
  });

  return formatPayment(updated);
}

export async function updatePayment(prisma, userId, paymentId, patch) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);
  const payment = await resolvePaymentOrThrow(prisma, trainer.id, paymentId);

  const updated = await prisma.subscriptionPayment.update({
    where: { id: payment.id },
    data: {
      dueDate: patch.dueDate ? parseDateOnlyAsUtc(patch.dueDate) : payment.dueDate,
      amount: patch.amount != null ? new Decimal(patch.amount) : payment.amount,
      notes: patch.notes !== undefined ? patch.notes : payment.notes,
    },
  });

  return formatPayment(updated);
}

export async function deletePayment(prisma, userId, paymentId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);
  const payment = await resolvePaymentOrThrow(prisma, trainer.id, paymentId);

  await prisma.subscriptionPayment.delete({
    where: { id: payment.id },
  });
}
