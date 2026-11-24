import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
  PaymentStatus,
  CYCLE_GENERATION_LEAD_DAYS,
  BUSINESS_TIMEZONE,
  PAID_AT_MAX_ADVANCE_MONTHS,
} from '../constants/subscription.js';
import {
  addDaysMs,
  addMonthsClamped,
  formatDateOnly,
  getDateOnlyAsMidnightUtc,
  parseDateOnlyAsUtc,
  todayInBusinessTz,
  zonedWallClockToInstant,
} from '../helpers/date-helpers.js';
import {
  assertValidMoneyAmount,
  computeAmount,
  computeNextCycle,
  formatPayment,
} from '../helpers/subscription-helpers.js';
import { ownerScopeWhere } from '../helpers/subscription-owner-helpers.js';
import { insertCyclesForActiveSubscriptions } from './subscription-cycle-service.js';

const MIDDAY_HOUR = 12;

const { Decimal } = Prisma;

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Loads a subscription owned by any of the owner's rows or throws 404.
async function resolveSubscriptionOrThrow(prisma, owner, subscriptionId) {
  const subscription = await prisma.studentSubscription.findFirst({
    where: { id: subscriptionId, ...ownerScopeWhere(owner) },
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

// Loads a payment whose subscription is owned by any of the owner's rows or throws 404.
async function resolvePaymentOrThrow(prisma, owner, paymentId) {
  const payment = await prisma.subscriptionPayment.findFirst({
    where: { id: paymentId, subscription: ownerScopeWhere(owner) },
    include: {
      subscription: { select: { status: true, cancelledAt: true, startDate: true } },
    },
  });

  if (!payment) {
    throw new AppError({
      httpStatus: 404,
      error: SubscriptionErrorCode.PAYMENT_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PAYMENT_NOT_FOUND,
      message: 'Subscription payment not found',
    });
  }

  return payment;
}

function conflict({ error, messageCode, message }) {
  return new AppError({ httpStatus: 409, error, messageCode, message });
}

async function reloadPayment(prisma, paymentId) {
  return prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });
}

function invalidPaidAt(message) {
  return new AppError({
    httpStatus: 400,
    error: SubscriptionErrorCode.INVALID_PAID_AT,
    messageCode: SubscriptionMessageCode.INVALID_PAID_AT,
    message,
  });
}

/**
 * Resolve the instant to store as paidAt from an optional date-only value.
 * Accepted range: [subscription.startDate - PAID_AT_MAX_ADVANCE_MONTHS, today]
 * (a trainer may receive an advance payment shortly before the plan starts,
 * but not years earlier). Today (business timezone) uses the real instant; past
 * days are stored at midday business time so they land inside the intended
 * civil day/month.
 */
function resolvePaidAt(paidAtDate, today, now, subscriptionStartDate) {
  if (!paidAtDate) return null;

  const requestedDay = getDateOnlyAsMidnightUtc(paidAtDate);
  if (requestedDay > today) {
    throw invalidPaidAt('The payment date cannot be in the future');
  }
  if (requestedDay < addMonthsClamped(subscriptionStartDate, -PAID_AT_MAX_ADVANCE_MONTHS)) {
    throw invalidPaidAt('The payment date is too far before the subscription start');
  }
  if (formatDateOnly(requestedDay) === formatDateOnly(today)) return now;

  return zonedWallClockToInstant(
    {
      year: requestedDay.getUTCFullYear(),
      month: requestedDay.getUTCMonth() + 1,
      day: requestedDay.getUTCDate(),
    },
    BUSINESS_TIMEZONE,
    MIDDAY_HOUR,
  );
}

function throwPaymentCancelled() {
  throw conflict({
    error: SubscriptionErrorCode.PAYMENT_CANCELLED,
    messageCode: SubscriptionMessageCode.PAYMENT_CANCELLED,
    message: 'This payment was voided and cannot be changed',
  });
}

function throwPaymentAlreadyPaid() {
  throw conflict({
    error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
    messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
    message: 'A paid payment cannot be changed or voided; revert it to pending first',
  });
}

function throwPaymentConflict() {
  throw conflict({
    error: SubscriptionErrorCode.PAYMENT_CONFLICT,
    messageCode: SubscriptionMessageCode.PAYMENT_CONFLICT,
    message: 'The payment was changed by another operation; refresh and try again',
  });
}

function throwCycleAlreadyExists() {
  throw conflict({
    error: SubscriptionErrorCode.CYCLE_ALREADY_EXISTS,
    messageCode: SubscriptionMessageCode.CYCLE_ALREADY_EXISTS,
    message: 'This billing cycle already exists',
  });
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Generate the next billing cycle of a subscription ("Gerar próximo ciclo").
 * The cycle dates come from the subscription anchor — callers cannot choose
 * them. Only available once the next cycle is within the generation lead
 * window (409 CYCLE_NOT_DUE otherwise); a concurrent request that creates the
 * same cycle first yields 409 CYCLE_ALREADY_EXISTS.
 *
 * The insert is conditional on the subscription still being active at write
 * time (see insertCyclesForActiveSubscriptions), so a cancel racing with this
 * call can never leave a fresh pending charge behind.
 */
export async function createPayment(prisma, owner, subscriptionId, data, now = new Date()) {
  const subscription = await resolveSubscriptionOrThrow(prisma, owner, subscriptionId);

  if (subscription.status === SubscriptionStatus.CANCELLED) {
    throw conflict({
      error: SubscriptionErrorCode.SUBSCRIPTION_CANCELLED,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_CANCELLED,
      message: 'Cannot create payments for a cancelled subscription',
    });
  }

  const today = todayInBusinessTz(now);
  const lastCycle = await prisma.subscriptionPayment.findFirst({
    where: { subscriptionId: subscription.id },
    orderBy: { cycleIndex: 'desc' },
    select: { cycleIndex: true },
  });
  const nextCycle = computeNextCycle(subscription, lastCycle, today);

  if (nextCycle.cycleStartDate > addDaysMs(today, CYCLE_GENERATION_LEAD_DAYS)) {
    throw conflict({
      error: SubscriptionErrorCode.CYCLE_NOT_DUE,
      messageCode: SubscriptionMessageCode.CYCLE_NOT_DUE,
      message: 'The next billing cycle is not available yet',
    });
  }

  const inserted = await insertCyclesForActiveSubscriptions(prisma, [
    {
      subscriptionId: subscription.id,
      cycleIndex: nextCycle.cycleIndex,
      cycleStartDate: nextCycle.cycleStartDate,
      cycleEndDate: nextCycle.cycleEndDate,
      dueDate: data.dueDate ? parseDateOnlyAsUtc(data.dueDate) : nextCycle.cycleStartDate,
      amount: computeAmount(
        subscription.price,
        subscription.discountPercent,
        subscription.discountAmount,
      ),
      notes: data.notes ?? null,
    },
  ]);

  const payment = await prisma.subscriptionPayment.findUnique({
    where: {
      subscriptionId_cycleIndex: {
        subscriptionId: subscription.id,
        cycleIndex: nextCycle.cycleIndex,
      },
    },
  });

  if (inserted === 0) {
    // Nothing inserted: either the cycle already exists (concurrent request)
    // or the subscription was cancelled between the read above and the insert.
    if (payment) throwCycleAlreadyExists();
    throw conflict({
      error: SubscriptionErrorCode.SUBSCRIPTION_CANCELLED,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_CANCELLED,
      message: 'Cannot create payments for a cancelled subscription',
    });
  }

  return formatPayment(payment, today);
}

export async function listPaymentsBySubscription(prisma, owner, subscriptionId, now = new Date()) {
  await resolveSubscriptionOrThrow(prisma, owner, subscriptionId);

  const payments = await prisma.subscriptionPayment.findMany({
    where: { subscriptionId },
    orderBy: [{ cycleStartDate: 'desc' }],
  });

  const today = todayInBusinessTz(now);
  return payments.map((payment) => formatPayment(payment, today));
}

const STUDENT_SUMMARY_SELECT = { id: true, firstName: true, lastName: true, avatarUrl: true };

// Person of a trainer-student or nutritionist-patient link row.
function personOfLink(link) {
  // why: TrainerStudent names the person `student`, NutritionistPatient names it `patient`
  return link?.student ?? link?.patient ?? null;
}

// Finds the person through the live trainer or patient link of the owner, or null.
async function findLinkedPerson(prisma, owner, studentId) {
  if (owner.trainerId) {
    const trainerLink = await prisma.trainerStudent.findFirst({
      where: { trainerId: owner.trainerId, studentId },
      select: { student: { select: STUDENT_SUMMARY_SELECT } },
    });
    if (trainerLink) return personOfLink(trainerLink);
  }
  if (owner.nutritionistId) {
    const patientLink = await prisma.nutritionistPatient.findFirst({
      where: { nutritionistId: owner.nutritionistId, patientId: studentId, deletedAt: null },
      select: { patient: { select: STUDENT_SUMMARY_SELECT } },
    });
    return personOfLink(patientLink);
  }
  return null;
}

/**
 * Student header for the history. Only exposed when the owner has billing
 * history with the student or a live link — otherwise null, so an arbitrary
 * studentId cannot be used to look up other users' names/avatars.
 */
async function resolveStudentSummary(prisma, owner, studentId, payments, resolveAvatarUrl) {
  const student = payments[0]?.subscription.student ?? (await findLinkedPerson(prisma, owner, studentId));
  if (!student) return null;

  return {
    id: student.id,
    name: [student.firstName, student.lastName].filter(Boolean).join(' '),
    avatarUrl: await resolveAvatarUrl(student.avatarUrl),
  };
}

/**
 * Every payment of a student across all of the owner's subscriptions
 * (active and cancelled) plus a summary — 1 payments query + batched include
 * queries (fixed count). Scoped by owner only, so history stays reachable
 * after the student is unlinked.
 */
export async function listPaymentsByStudent(
  prisma,
  owner,
  studentId,
  now = new Date(),
  { resolveAvatarUrl = async (stored) => stored ?? null } = {},
) {
  const payments = await prisma.subscriptionPayment.findMany({
    where: { subscription: { ...ownerScopeWhere(owner), studentId } },
    orderBy: [{ cycleStartDate: 'desc' }],
    include: {
      subscription: {
        select: {
          status: true,
          serviceType: true,
          startDate: true,
          plan: { select: { id: true, name: true, recurrence: true } },
          student: { select: STUDENT_SUMMARY_SELECT },
        },
      },
    },
  });

  const student = await resolveStudentSummary(prisma, owner, studentId, payments, resolveAvatarUrl);

  const today = todayInBusinessTz(now);
  let totalReceived = new Decimal(0);
  let receivedCount = 0;
  let customerSince = null;

  const items = payments.map((payment) => {
    if (payment.status === PaymentStatus.PAID) {
      totalReceived = totalReceived.plus(payment.amount);
      receivedCount += 1;
    }
    const { startDate } = payment.subscription;
    if (!customerSince || startDate < customerSince) customerSince = startDate;

    return {
      ...formatPayment(payment, today),
      subscriptionStatus: payment.subscription.status,
      serviceType: payment.subscription.serviceType,
      plan: payment.subscription.plan,
    };
  });

  return {
    student,
    summary: {
      totalReceived: totalReceived.toFixed(2),
      receivedCount,
      customerSince: formatDateOnly(customerSince),
    },
    payments: items,
  };
}

/** Already paid: same (or no) paidAt is an idempotent no-op; a different paidAt must be reverted first. */
function settleAlreadyPaid(payment, requestedPaidAtDate, today) {
  const currentPaidDay = payment.paidAt ? formatDateOnly(todayInBusinessTz(payment.paidAt)) : null;
  if (requestedPaidAtDate && requestedPaidAtDate !== currentPaidDay) {
    throwPaymentAlreadyPaid();
  }
  return formatPayment(payment, today);
}

/**
 * Mark a payment as paid. `paidAt` (date-only, between subscription start - 12
 * months and today in the business timezone) registers money received earlier
 * so revenue lands in the right month. Pending and voided (cancelled) payments
 * can be paid — the latter covers a late settlement. The write is conditional
 * on the status read, so concurrent void/pay cannot overwrite each other.
 * Paying an already paid payment is idempotent unless a different paidAt is
 * requested (409 — revert to pending first).
 */
export async function markPaymentPaid(prisma, owner, paymentId, { paidAt } = {}, now = new Date()) {
  const payment = await resolvePaymentOrThrow(prisma, owner, paymentId);

  const today = todayInBusinessTz(now);
  const resolvedPaidAt = resolvePaidAt(paidAt, today, now, payment.subscription.startDate);

  if (payment.status === PaymentStatus.PAID) return settleAlreadyPaid(payment, paidAt, today);

  const payNow = () =>
    prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.CANCELLED] } },
      data: { status: PaymentStatus.PAID, paidAt: resolvedPaidAt ?? now },
    });

  let { count } = await payNow();
  let fresh = await reloadPayment(prisma, payment.id);
  if (count === 0 && fresh.status !== PaymentStatus.PAID) {
    // State moved under us (e.g. a concurrent revert); one retry, then give up explicitly.
    ({ count } = await payNow());
    fresh = await reloadPayment(prisma, payment.id);
    if (count === 0 && fresh.status !== PaymentStatus.PAID) throwPaymentConflict();
  }
  if (count === 0) return settleAlreadyPaid(fresh, paidAt, today);

  return formatPayment(fresh, today);
}

/**
 * Revert a paid payment to pending. A payment that was ever voided (voidedAt,
 * set by void/cancel/replace/unlink — kept through a late settlement) goes back
 * to 'cancelled' instead, so it never resurrects as debt. The target is chosen
 * by the conditional write itself (two single-statement updates on voidedAt),
 * never from a stale read.
 */
export async function markPaymentPending(prisma, owner, paymentId, now = new Date()) {
  const payment = await resolvePaymentOrThrow(prisma, owner, paymentId);
  if (payment.status === PaymentStatus.CANCELLED) throwPaymentCancelled();

  const reopened = await prisma.subscriptionPayment.updateMany({
    where: { id: payment.id, status: { in: [PaymentStatus.PAID, PaymentStatus.PENDING] }, voidedAt: null },
    data: { status: PaymentStatus.PENDING, paidAt: null },
  });
  if (reopened.count === 0) {
    const stillVoided = await prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PAID, voidedAt: { not: null } },
      data: { status: PaymentStatus.CANCELLED, paidAt: null },
    });
    if (stillVoided.count === 0) throwPaymentCancelled();
  }

  return formatPayment(await reloadPayment(prisma, payment.id), todayInBusinessTz(now));
}

function amountOrDueDateChanges(payment, patch) {
  const amountChanges =
    patch.amount != null && !new Decimal(patch.amount).equals(payment.amount);
  const dueDateChanges =
    Boolean(patch.dueDate) && patch.dueDate !== formatDateOnly(payment.dueDate);
  return amountChanges || dueDateChanges;
}

function throwForBlockedUpdate(status) {
  if (status === PaymentStatus.CANCELLED) throwPaymentCancelled();
  throwPaymentAlreadyPaid();
}

export async function updatePayment(prisma, owner, paymentId, patch, now = new Date()) {
  const payment = await resolvePaymentOrThrow(prisma, owner, paymentId);
  assertValidMoneyAmount(patch.amount);

  // Editing a paid payment would silently rewrite historical revenue; only notes are editable.
  const changesAmountOrDueDate = amountOrDueDateChanges(payment, patch);
  if (payment.status === PaymentStatus.CANCELLED) throwPaymentCancelled();
  if (payment.status === PaymentStatus.PAID && changesAmountOrDueDate) throwPaymentAlreadyPaid();

  // Only fields that actually change are written, so a concurrent edit of another
  // field is never overwritten with a stale value.
  const data = {};
  if (patch.dueDate && patch.dueDate !== formatDateOnly(payment.dueDate)) {
    data.dueDate = parseDateOnlyAsUtc(patch.dueDate);
  }
  if (patch.amount != null && !new Decimal(patch.amount).equals(payment.amount)) {
    data.amount = new Decimal(patch.amount);
  }
  if (patch.notes !== undefined && patch.notes !== payment.notes) data.notes = patch.notes;

  if (Object.keys(data).length === 0) return formatPayment(payment, todayInBusinessTz(now));

  // Conditional write: the status checked above must still hold when the row is updated.
  const allowedStatus = changesAmountOrDueDate
    ? PaymentStatus.PENDING
    : { not: PaymentStatus.CANCELLED };
  const { count } = await prisma.subscriptionPayment.updateMany({
    where: { id: payment.id, status: allowedStatus },
    data,
  });

  const fresh = await reloadPayment(prisma, payment.id);
  if (count === 0) throwForBlockedUpdate(fresh.status);

  return formatPayment(fresh, todayInBusinessTz(now));
}

/**
 * Void a pending payment (soft: status -> cancelled, so the cycle generator
 * does not recreate it). Paid payments cannot be voided. Voiding an already
 * voided payment is a no-op. Conditional write: a concurrent mark-paid wins
 * and the void answers 409 instead of overwriting the payment.
 */
export async function voidPayment(prisma, owner, paymentId, now = new Date()) {
  const payment = await resolvePaymentOrThrow(prisma, owner, paymentId);

  if (payment.status === PaymentStatus.PAID) throwPaymentAlreadyPaid();

  const { count } = await prisma.subscriptionPayment.updateMany({
    where: { id: payment.id, status: PaymentStatus.PENDING },
    data: { status: PaymentStatus.CANCELLED, voidedAt: now },
  });

  const fresh = await reloadPayment(prisma, payment.id);
  if (count === 0 && fresh.status === PaymentStatus.PAID) throwPaymentAlreadyPaid();

  return formatPayment(fresh, todayInBusinessTz(now));
}
