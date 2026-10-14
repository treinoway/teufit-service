import {
  PaymentStatus,
  EffectivePaymentStatus,
  PAYMENT_OVERDUE_GRACE_DAYS,
  RENEWING_SOON_WINDOW_DAYS,
  BillingStatus,
} from '../constants/subscription.js';
import { addDaysMs, diffInDays } from './date-helpers.js';

/**
 * SINGLE source of truth for "overdue". Used by the dashboard, the student
 * blockers and the finance overview — never re-implement this comparison.
 *
 * A payment is overdue when it is pending AND dueDate < today - grace days.
 */

/**
 * Cut-off date: pending payments with dueDate strictly before it are overdue.
 *
 * @param {Date} today - business-timezone civil today (midnight UTC)
 * @returns {Date}
 */
export function overdueThreshold(today) {
  return addDaysMs(today, -PAYMENT_OVERDUE_GRACE_DAYS);
}

/**
 * Prisma `where` fragment matching overdue payments.
 *
 * @param {Date} today
 */
export function buildOverduePaymentWhere(today) {
  return { status: PaymentStatus.PENDING, dueDate: { lt: overdueThreshold(today) } };
}

/**
 * Prisma `where` fragment matching "due soon" payments: pending, NOT yet
 * overdue, due within [today - grace days, today + RENEWING_SOON_WINDOW_DAYS]
 * (inclusive). Together with the overdue fragment every pending payment in
 * that range falls in exactly one bucket. Single source for the dashboard
 * (plans.renewingSoonCount) and the students list (billingStatus).
 *
 * @param {Date} today
 */
export function buildDueSoonPaymentWhere(today) {
  return {
    status: PaymentStatus.PENDING,
    dueDate: { gte: overdueThreshold(today), lte: addDaysMs(today, RENEWING_SOON_WINDOW_DAYS) },
  };
}

/**
 * Billing status of one student from the facts the two predicates above produce.
 *
 * @param {{ hasActiveSubscription: boolean, hasOverduePayment: boolean, hasDueSoonPayment: boolean }} facts
 * @returns {string} BillingStatus value
 */
export function deriveBillingStatus({ hasActiveSubscription, hasOverduePayment, hasDueSoonPayment }) {
  if (!hasActiveSubscription) return BillingStatus.NONE;
  if (hasOverduePayment) return BillingStatus.OVERDUE;
  if (hasDueSoonPayment) return BillingStatus.DUE_SOON;
  return BillingStatus.OK;
}

/**
 * Status shown to clients, plus how many days past dueDate the payment is.
 *
 * @param {{ status: string, dueDate: Date }} payment
 * @param {Date} today
 * @returns {{ effectiveStatus: string, daysOverdue: number }}
 */
export function deriveEffectiveStatus(payment, today) {
  if (payment.status === PaymentStatus.PENDING && payment.dueDate < overdueThreshold(today)) {
    return {
      effectiveStatus: EffectivePaymentStatus.OVERDUE,
      daysOverdue: diffInDays(today, payment.dueDate),
    };
  }
  return { effectiveStatus: payment.status, daysOverdue: 0 };
}
