/**
 * Subscription Plans domain constants.
 */

export const SubscriptionRecurrence = Object.freeze({
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  SEMIANNUAL: 'semiannual',
  ANNUAL: 'annual',
});

export const subscriptionRecurrenceValues = Object.freeze(Object.values(SubscriptionRecurrence));

export const SubscriptionStatus = Object.freeze({
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
});

export const subscriptionStatusValues = Object.freeze(Object.values(SubscriptionStatus));

export const PaymentStatus = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  CANCELLED: 'cancelled',
});

export const paymentStatusValues = Object.freeze(Object.values(PaymentStatus));

/**
 * Status exposed to clients (derived, never persisted): a pending payment
 * past the grace window is reported as `overdue`.
 */
export const EffectivePaymentStatus = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  OVERDUE: 'overdue',
  CANCELLED: 'cancelled',
});

export const effectivePaymentStatusValues = Object.freeze(Object.values(EffectivePaymentStatus));

/** A pending payment is overdue only after dueDate + this many days. */
export const PAYMENT_OVERDUE_GRACE_DAYS = 3;

/** Next billing cycle is materialized this many days before it starts. */
export const CYCLE_GENERATION_LEAD_DAYS = 7;

/** Safety cap on cycles materialized per subscription in a single run (catch-up). */
export const MAX_CYCLES_PER_GENERATION_RUN = 60;

/** Subscriptions processed per batch by the cycle generator (cron path). */
export const CYCLE_GENERATION_BATCH_SIZE = 500;

/** Fixed business timezone for all "today" / month-window calculations. */
export const BUSINESS_TIMEZONE = 'America/Sao_Paulo';

/** Largest amount representable by Decimal(10,2). */
export const MAX_MONEY_AMOUNT = 99999999.99;
export const MONEY_DECIMAL_PLACES = 2;

/** paidAt may be at most this many months before the subscription start (advance payments). */
export const PAID_AT_MAX_ADVANCE_MONTHS = 12;

/** Key namespace of the per trainer/student advisory lock serializing assign/unlink. */
export const SUBSCRIPTION_ASSIGNMENT_LOCK_PREFIX = 'subscription-assign';

export const CANCELLATION_REASON_REPLACED = 'Replaced by new plan assignment';
export const CANCELLATION_REASON_UNLINKED = 'Student unlinked from trainer';

/**
 * Number of calendar months each recurrence covers.
 * Used to compute cycleEndDate = cycleStartDate + RECURRENCE_MONTHS[recurrence] months - 1 day.
 */
export const RECURRENCE_MONTHS = Object.freeze({
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
});

export const SubscriptionErrorCode = Object.freeze({
  PLAN_NOT_FOUND: 'SUBSCRIPTION_PLAN_NOT_FOUND',
  PLAN_ARCHIVED: 'SUBSCRIPTION_PLAN_ARCHIVED',
  BOTH_DISCOUNTS_SET: 'SUBSCRIPTION_BOTH_DISCOUNTS_SET',
  DISCOUNT_EXCEEDS_PRICE: 'SUBSCRIPTION_DISCOUNT_EXCEEDS_PRICE',
  SUBSCRIPTION_NOT_FOUND: 'STUDENT_SUBSCRIPTION_NOT_FOUND',
  CANNOT_EDIT_CANCELLED: 'SUBSCRIPTION_CANNOT_EDIT_CANCELLED',
  PAYMENT_NOT_FOUND: 'SUBSCRIPTION_PAYMENT_NOT_FOUND',
  STUDENT_NOT_LINKED: 'SUBSCRIPTION_STUDENT_NOT_LINKED',
  TRAINER_NOT_FOUND: 'SUBSCRIPTION_TRAINER_NOT_FOUND',
  PAYMENT_ALREADY_PAID: 'SUBSCRIPTION_PAYMENT_ALREADY_PAID',
  PAYMENT_CANCELLED: 'SUBSCRIPTION_PAYMENT_CANCELLED',
  SUBSCRIPTION_CANCELLED: 'SUBSCRIPTION_CANCELLED',
  SUBSCRIPTION_ALREADY_ACTIVE: 'SUBSCRIPTION_ALREADY_ACTIVE',
  CYCLE_NOT_DUE: 'SUBSCRIPTION_CYCLE_NOT_DUE',
  CYCLE_ALREADY_EXISTS: 'SUBSCRIPTION_CYCLE_ALREADY_EXISTS',
  PAYMENT_CONFLICT: 'SUBSCRIPTION_PAYMENT_CONFLICT',
  INVALID_AMOUNT: 'SUBSCRIPTION_INVALID_AMOUNT',
  INVALID_PAID_AT: 'SUBSCRIPTION_INVALID_PAID_AT',
});

export const SubscriptionMessageCode = Object.freeze({
  PLAN_NOT_FOUND: 'subscription.planNotFound',
  PLAN_ARCHIVED: 'subscription.planArchived',
  BOTH_DISCOUNTS_SET: 'subscription.bothDiscountsSet',
  DISCOUNT_EXCEEDS_PRICE: 'subscription.discountExceedsPrice',
  SUBSCRIPTION_NOT_FOUND: 'subscription.notFound',
  CANNOT_EDIT_CANCELLED: 'subscription.cannotEditCancelled',
  PAYMENT_NOT_FOUND: 'subscription.paymentNotFound',
  STUDENT_NOT_LINKED: 'student.notLinked',
  TRAINER_NOT_FOUND: 'trainer.notFound',
  PAYMENT_ALREADY_PAID: 'subscription.paymentAlreadyPaid',
  PAYMENT_CANCELLED: 'subscription.paymentCancelled',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  SUBSCRIPTION_ALREADY_ACTIVE: 'subscription.alreadyActive',
  CYCLE_NOT_DUE: 'subscription.cycleNotDue',
  CYCLE_ALREADY_EXISTS: 'subscription.cycleAlreadyExists',
  PAYMENT_CONFLICT: 'subscription.paymentConflict',
  INVALID_AMOUNT: 'subscription.invalidAmount',
  INVALID_PAID_AT: 'subscription.invalidPaidAt',
});
