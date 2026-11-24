/**
 * Trainer Finance Service — the "Financeiro" overview.
 *
 * One call replaces the previous per-subscription N+1 from the web client.
 *
 * Query budget (fixed, independent of roster size):
 *   1. (owner is resolved by the route)
 *   2-3. ensureUpcomingCycles scoped to the trainer (active subscriptions +
 *        latest cycles; +1 conditional INSERT only when a cycle is due)
 *   4. ONE findMany with nested include of subscription/student/plan (Prisma's
 *      default query strategy resolves the includes in 3 more batched
 *      `IN (...)` queries — a fixed count, never per-row).
 * KPIs are summed in memory from those same rows (Decimal-safe), so there is
 * no extra aggregate round trip and dashboard/overview can never disagree
 * (both use buildOverduePaymentWhere / deriveEffectiveStatus).
 *
 * Row scope:
 *   - overdue payments of ANY month, including from cancelled subscriptions
 *     (real debt must stay visible),
 *   - pending payments with dueDate < first day of the NEXT month, with NO lower
 *     bound (older pending payments inside the grace window stay visible),
 *   - paid payments whose paidAt falls in the month (business timezone window).
 * Voided (cancelled) payments are never listed.
 *
 * Dependencies are injected — never import the prisma singleton here.
 */

import { Prisma } from '@prisma/client';
import {
  PaymentStatus,
  EffectivePaymentStatus,
  PAYMENT_OVERDUE_GRACE_DAYS,
} from '../constants/subscription.js';
import {
  currentYearMonthInBusinessTz,
  firstDayOfNextMonthUtc,
  monthWindowInBusinessTz,
  todayInBusinessTz,
} from '../helpers/date-helpers.js';
import { buildOverduePaymentWhere } from '../helpers/payment-status-helpers.js';
import { formatPayment } from '../helpers/subscription-helpers.js';
import { ownerScopeWhere } from '../helpers/subscription-owner-helpers.js';
import { ensureUpcomingCycles } from './subscription-cycle-service.js';

const { Decimal } = Prisma;
const PERCENT_SCALE = 100;
const PERCENT_DECIMAL_PLACES = 2;

function buildOverviewWhere(owner, today, monthWindow, nextMonthStart) {
  return {
    subscription: ownerScopeWhere(owner),
    OR: [
      { status: PaymentStatus.PAID, paidAt: { gte: monthWindow.start, lt: monthWindow.end } },
      { status: PaymentStatus.PENDING, dueDate: { lt: nextMonthStart } },
      buildOverduePaymentWhere(today),
    ],
  };
}

function sumAmounts(amounts) {
  return amounts.reduce((total, amount) => total.plus(amount), new Decimal(0)).toFixed(2);
}

function computeKpis(rows) {
  const byStatus = (status) => rows.filter((row) => row.effectiveStatus === status);
  const received = byStatus(EffectivePaymentStatus.PAID);
  const pending = byStatus(EffectivePaymentStatus.PENDING);
  const overdue = byStatus(EffectivePaymentStatus.OVERDUE);

  const billedStudents = new Set(rows.map((row) => row.student.id)).size;
  const overdueStudents = new Set(overdue.map((row) => row.student.id)).size;
  const delinquencyRate =
    billedStudents === 0
      ? 0
      : new Decimal(overdueStudents)
          .dividedBy(billedStudents)
          .times(PERCENT_SCALE)
          .toDecimalPlaces(PERCENT_DECIMAL_PLACES)
          .toNumber();

  return {
    receivedAmount: sumAmounts(received.map((row) => row.amount)),
    receivedCount: received.length,
    pendingAmount: sumAmounts(pending.map((row) => row.amount)),
    pendingCount: pending.length,
    overdueAmount: sumAmounts(overdue.map((row) => row.amount)),
    overdueCount: overdue.length,
    overdueStudents,
    billedStudents,
    delinquencyRate,
  };
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ userId: string, trainerId: string|null, nutritionistId: string|null }} owner - resolved professional owner
 * @param {{ month?: string }} [query] - "YYYY-MM" (business timezone); defaults to the current month
 * @param {{ now?: Date, logger?: { error: Function }, resolveAvatarUrl?: (stored: string|null) => Promise<string|null> }} [dependencies]
 */
export async function getFinanceOverview(
  prisma,
  owner,
  { month } = {},
  { now = new Date(), resolveAvatarUrl = async (stored) => stored ?? null, logger = console } = {},
) {
  const today = todayInBusinessTz(now);
  const yearMonth = month ?? currentYearMonthInBusinessTz(now);

  // Self-healing generation must never break the read: log and serve what exists.
  try {
    await ensureUpcomingCycles(prisma, { owner, today });
  } catch (error) {
    logger.error({ err: error }, '[finance:overview] cycle generation failed; serving existing data');
  }

  const payments = await prisma.subscriptionPayment.findMany({
    where: buildOverviewWhere(
      owner,
      today,
      monthWindowInBusinessTz(yearMonth),
      firstDayOfNextMonthUtc(yearMonth),
    ),
    orderBy: [{ dueDate: 'asc' }, { cycleIndex: 'asc' }],
    include: {
      subscription: {
        select: {
          status: true,
          serviceType: true,
          student: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          plan: { select: { id: true, name: true, recurrence: true } },
        },
      },
    },
  });

  const studentsById = new Map(payments.map(({ subscription }) => [subscription.student.id, subscription.student]));
  const avatarEntries = await Promise.all(
    [...studentsById.values()].map(async (student) => [
      student.id,
      await resolveAvatarUrl(student.avatarUrl),
    ]),
  );
  const avatarByStudentId = new Map(avatarEntries);

  const rows = payments.map((payment) => {
    const { subscription } = payment;
    const { student } = subscription;
    return {
      ...formatPayment(payment, today),
      subscriptionStatus: subscription.status,
      serviceType: subscription.serviceType,
      student: {
        id: student.id,
        name: [student.firstName, student.lastName].filter(Boolean).join(' '),
        avatarUrl: avatarByStudentId.get(student.id),
      },
      plan: subscription.plan,
    };
  });

  return {
    month: yearMonth,
    overdueGraceDays: PAYMENT_OVERDUE_GRACE_DAYS,
    kpis: computeKpis(rows),
    payments: rows,
  };
}

/**
 * Overdue debt across every owner row of a professional user (sidebar badge).
 * Counts payments of any month, including those of cancelled subscriptions, like the overview.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ userId: string, trainerId: string|null, nutritionistId: string|null }} owner
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ overdueCount: number, overdueAmount: string }>}
 */
export async function getFinanceSummary(prisma, owner, { now = new Date() } = {}) {
  const overdue = await prisma.subscriptionPayment.aggregate({
    where: {
      subscription: ownerScopeWhere(owner),
      ...buildOverduePaymentWhere(todayInBusinessTz(now)),
    },
    _count: { _all: true },
    _sum: { amount: true },
  });

  return {
    overdueCount: overdue._count._all,
    overdueAmount: new Decimal(overdue._sum.amount ?? 0).toFixed(2),
  };
}
