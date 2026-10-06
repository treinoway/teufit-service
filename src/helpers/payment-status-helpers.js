import {
  PaymentStatus,
  EffectivePaymentStatus,
  PAYMENT_OVERDUE_GRACE_DAYS,
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
