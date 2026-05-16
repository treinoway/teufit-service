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
});

export const paymentStatusValues = Object.freeze(Object.values(PaymentStatus));

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
});
