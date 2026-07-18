/**
 * Trainer Dashboard Service
 *
 * Aggregates the KPIs for the trainer Home "Torre de Controle" — plans,
 * routines, finance, and engagement — behind a single response. This
 * replaces what the frontend previously had to compose client-side from
 * briefing + subscriptions + payments + protocols (an N+1 pattern already
 * degrading Financeiro.jsx).
 *
 * Every query below is a DB-side count/aggregate scoped directly by
 * trainerId (or by a trainerId-resolved subscription id list, for finance —
 * see resolveAllSubscriptionIds). None of them transfer per-row data to
 * compute a result and none loop per student — this keeps the response
 * time constant regardless of roster size. 11 Prisma calls total on the
 * happy path, backed by indexes added in the
 * add_trainer_dashboard_indexes migration.
 *
 * engagement.* (other than weekPrCount) is read from the
 * TrainerBriefingSnapshot rather than recomputed here — recomputing would
 * re-run ~13 queries (see computeBriefing in briefing-service.js) on every
 * dashboard load, blowing the performance budget for this endpoint. The
 * trade-off is that those values may be up to ~1 day stale (daily cron +
 * write-time dirty-flag invalidation) — see briefing-service.js docstring.
 *
 * Dependencies are injected as arguments — never import prisma singleton here.
 */

import { SubscriptionStatus, PaymentStatus } from '../constants/subscription.js';
import { TrainingStatus } from '../constants/training.js';
import { NotFoundAppError } from '../errors/app-error.js';
import { getDateOnlyAsMidnightUtc, addDaysMs } from '../helpers/date-helpers.js';
import { getBriefingByTrainerId, startOfCurrentMonth } from './briefing-service.js';

// Both the "plans renewing soon" and "routines expiring soon" windows use the
// same 7-day, inclusive-on-both-ends convention: [today, today + 7d]. Keep
// them as separate constants (not shared) since they describe different
// domain concepts that happen to share a value today.
const RENEWING_SOON_WINDOW_DAYS = 7;
const EXPIRING_SOON_WINDOW_DAYS = 7;
const ENGAGEMENT_PR_WINDOW_DAYS = 7;


// ─── Internal helpers ─────────────────────────────────────────────────────────

async function resolveTrainerOrThrow(prisma, userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new NotFoundAppError({
      message: 'Trainer profile not found',
      messageCode: 'trainer.notFound',
    });
  }

  return trainer;
}

/**
 * Format a Prisma Decimal aggregate sum (possibly null when zero rows
 * matched) as a fixed 2-decimal money string. Never returns null — an empty
 * sum is "0.00", matching the moneyString contract used across subscription
 * schemas.
 *
 * @param {import('@prisma/client/runtime/library').Decimal | null} sum
 * @returns {string}
 */
function formatMoneySum(sum) {
  return sum ? sum.toFixed(2) : '0.00';
}

/**
 * plans.expiredCount — active subscriptions with at least one overdue
 * (pending, past-due) payment.
 *
 * Counts SUBSCRIPTIONS, not payments — a subscription with 3 overdue
 * payments counts once here. This intentionally differs from
 * finance.overdueCount, which counts PAYMENTS (so the same subscription
 * could contribute 3 there). Not a bug — different unit of measure for a
 * different card.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @param {Date} today - UTC midnight of the current day
 * @returns {Promise<number>}
 */
async function countExpiredPlans(prisma, trainerId, today) {
  return prisma.studentSubscription.count({
    where: {
      trainerId,
      status: SubscriptionStatus.ACTIVE,
      payments: {
        some: { status: PaymentStatus.PENDING, dueDate: { lt: today } },
      },
    },
  });
}

/**
 * plans.renewingSoonCount — active subscriptions whose current billing
 * cycle ends within the next 7 days (inclusive both ends).
 *
 * StudentSubscription has no endDate/nextChargeDate field, so "renewing
 * soon" is derived from MAX(payment.cycleEndDate) landing in
 * [today, today + 7d]. Expressed relationally (no row transfer, no JS-side
 * MAX): "has a payment whose cycleEndDate falls in the window" AND "has no
 * payment whose cycleEndDate falls after the window" together imply the
 * subscription's latest cycleEndDate is inside the window.
 *
 * Known limitation (accepted): if the next billing cycle's payment row
 * hasn't been materialized yet, the subscription won't appear here even
 * though it is, in fact, renewing soon. A subscription with zero payments
 * at all also never counts (fails the `some` clause) — this is correct,
 * not a bug: there's nothing to call "renewing soon" without a cycle to
 * compare against.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @param {Date} today - UTC midnight of the current day
 * @param {Date} windowEnd - today + RENEWING_SOON_WINDOW_DAYS, UTC midnight
 * @returns {Promise<number>}
 */
async function countRenewingSoonPlans(prisma, trainerId, today, windowEnd) {
  return prisma.studentSubscription.count({
    where: {
      trainerId,
      status: SubscriptionStatus.ACTIVE,
      payments: {
        some: { cycleEndDate: { gte: today, lte: windowEnd } },
        none: { cycleEndDate: { gt: windowEnd } },
      },
    },
  });
}

/**
 * routines.expiredCount / routines.expiringSoonCount — active,
 * non-deleted TrainingProtocols bucketed by expirationDate.
 *
 * Protocols with expirationDate = null never expire and are excluded from
 * both buckets. Boundaries are explicit and non-overlapping:
 *   - expired:       expirationDate <  today
 *   - expiringSoon:  today <= expirationDate <= today + 7d (inclusive both
 *     ends — same convention as plans.renewingSoonCount)
 *
 * Uses two indexed COUNT(*) queries (trainerId is indexed on
 * TrainingProtocol) rather than a single findMany + JS bucketing: a findMany
 * would transfer every matching row, including protocols that expired years
 * ago and were never cleaned up — an unbounded transfer with no cap, the
 * same class of problem this design avoided for finance.totalReceived.
 * COUNT(*) is DB-side and transfers nothing regardless of match volume.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @param {Date} today - UTC midnight of the current day
 * @param {Date} expiringSoonWindowEnd - today + EXPIRING_SOON_WINDOW_DAYS, UTC midnight
 * @returns {Promise<{ expiredCount: number, expiringSoonCount: number }>}
 */
async function countRoutines(prisma, trainerId, today, expiringSoonWindowEnd) {
  const [expiredCount, expiringSoonCount] = await Promise.all([
    prisma.trainingProtocol.count({
      where: {
        trainerId,
        status: TrainingStatus.ACTIVE,
        deletedAt: null,
        expirationDate: { not: null, lt: today },
      },
    }),
    prisma.trainingProtocol.count({
      where: {
        trainerId,
        status: TrainingStatus.ACTIVE,
        deletedAt: null,
        expirationDate: { gte: today, lte: expiringSoonWindowEnd },
      },
    }),
  ]);

  return { expiredCount, expiringSoonCount };
}

/**
 * Resolve every SubscriptionPayment-bearing subscriptionId owned by this
 * trainer, across ALL statuses (active AND cancelled — see computeFinance's
 * docstring for why status isn't filtered here).
 *
 * Backed by StudentSubscription's existing @@index([trainerId, status]) —
 * a query filtered by trainerId alone still uses the leftmost prefix of
 * that composite index, so this is a plain index scan.
 *
 * Resolved once and shared across all three finance aggregates in
 * computeFinance(). Passing a concrete id list (`subscriptionId: { in: ... }`)
 * instead of the relational filter `subscription: { trainerId }` matters:
 * the relational form compiles to
 * `WHERE subscription_id IN (SELECT id FROM student_subscriptions WHERE trainer_id = $1)`,
 * which the query planner can satisfy with a seq scan on subscription_payments
 * once that table is large enough — unpredictable, and dependent on table
 * statistics. An `IN (id, id, ...)` list makes an index scan on
 * subscription_payments(subscription_id, ...) the only reasonable plan.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @returns {Promise<string[]>}
 */
async function resolveAllSubscriptionIds(prisma, trainerId) {
  const subscriptions = await prisma.studentSubscription.findMany({
    where: { trainerId },
    select: { id: true },
  });
  return subscriptions.map((subscription) => subscription.id);
}

/**
 * finance.* — monthReceived, totalReceived, overdueCount, overdueAmount.
 *
 * Deliberately queries SubscriptionPayment scoped by the trainer's FULL
 * subscription id list (see resolveAllSubscriptionIds) — NOT by the
 * TrainerStudent roster and NOT filtered to active subscriptions. A student
 * blocked by the trainer's seat quota (activeOnPlan=false) or a cancelled
 * subscription can still have money owed; excluding them would silently
 * hide real overdue debt from the finance card. plans.* and engagement.*
 * have different, narrower scoping rules on purpose — see their own
 * docstrings.
 *
 * TODO(scaling): totalReceived sums the trainer's entire payment history
 * with no date bound. The (subscriptionId, status, paidAt) index makes the
 * scan itself efficient, but the underlying row count still grows without
 * bound as payment history accumulates. Candidate for a periodic
 * snapshot/materialization once this becomes measurable, same pattern as
 * TrainerBriefingSnapshot.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} subscriptionIds - trainer's full subscription id list, any status
 * @param {Date} today - UTC midnight of the current day
 * @param {Date} monthStart - UTC start of the current calendar month
 * @param {Date} now - current instant, exclusive upper bound for "this month"
 * @returns {Promise<{
 *   monthReceived: string,
 *   totalReceived: string,
 *   overdueCount: number,
 *   overdueAmount: string,
 * }>}
 */
async function computeFinance(prisma, subscriptionIds, today, monthStart, now) {
  // Short-circuit for a trainer with zero subscriptions ever (e.g. brand
  // new account) — avoids 3 pointless round trips with an empty `in: []`.
  if (subscriptionIds.length === 0) {
    return { monthReceived: '0.00', totalReceived: '0.00', overdueCount: 0, overdueAmount: '0.00' };
  }

  const [monthReceivedAgg, totalReceivedAgg, overdueAgg] = await Promise.all([
    prisma.subscriptionPayment.aggregate({
      where: {
        subscriptionId: { in: subscriptionIds },
        status: PaymentStatus.PAID,
        // Same UTC window convention as briefing's monthly adherence:
        // [monthStart, now) — not [monthStart, endOfMonth), since paidAt
        // can never be in the future anyway.
        paidAt: { gte: monthStart, lt: now },
      },
      _sum: { amount: true },
    }),
    prisma.subscriptionPayment.aggregate({
      where: {
        subscriptionId: { in: subscriptionIds },
        status: PaymentStatus.PAID,
      },
      _sum: { amount: true },
    }),
    prisma.subscriptionPayment.aggregate({
      where: {
        subscriptionId: { in: subscriptionIds },
        status: PaymentStatus.PENDING,
        dueDate: { lt: today },
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  return {
    monthReceived: formatMoneySum(monthReceivedAgg._sum.amount),
    totalReceived: formatMoneySum(totalReceivedAgg._sum.amount),
    overdueCount: overdueAgg._count._all,
    overdueAmount: formatMoneySum(overdueAgg._sum.amount),
  };
}

/**
 * engagement.weekPrCount — roster students with a new load PR recorded in
 * the last 7 days. Uses the write-time-denormalized TrainerStudent.currentPrAt
 * (see schema.prisma comment on TrainerStudent) — no join, no aggregation
 * over SetLog needed.
 *
 * Filtered to `activeOnPlan: true` on purpose — NOT a leftover from
 * elsewhere in the file. The other three engagement.* fields
 * (inactiveStudentsCount, adherenceMonthPct, adherenceDeltaPp) all come from
 * the TrainerBriefingSnapshot, which is computed over
 * resolveActiveRosterIds()'s activeOnPlan-filtered roster
 * (briefing-service.js). Without this filter, weekPrCount would count a
 * different population than its three siblings in the same `engagement`
 * block. This is not hypothetical: activeOnPlan only gates the TRAINER's
 * writes (assertStudentActiveOnPlan in training-protocol-service.js,
 * student-subscription-service.js, anamnesis-service.js) — a student
 * blocked by the trainer's seat quota can still train and hit a PR, so an
 * unfiltered count would silently include students the rest of this card
 * excludes.
 *
 * Bonus: activeOnPlan and currentPrAt are on the same row (no join), and
 * TrainerStudent's existing @@index([trainerId, activeOnPlan]) now serves
 * both columns of this filter instead of just the trainerId prefix.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} trainerId
 * @param {Date} prWindowStart - today - ENGAGEMENT_PR_WINDOW_DAYS, UTC midnight
 * @returns {Promise<number>}
 */
async function countWeekPrs(prisma, trainerId, prWindowStart) {
  return prisma.trainerStudent.count({
    where: { trainerId, activeOnPlan: true, currentPrAt: { gte: prWindowStart } },
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the full trainer dashboard payload for the authenticated trainer
 * user. Resolves the trainer once and shares trainerId/today/window
 * boundaries across every KPI query below — 11 total Prisma calls, all
 * DB-side counts/aggregates (zero N+1, zero per-student iteration,
 * constant in roster size). The 11th call (resolveAllSubscriptionIds) runs
 * in the same parallel wave as everything else, and its result only gates
 * computeFinance — so this is two sequential waves of parallel queries, not
 * 11 round trips in series.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId - User.id of the authenticated trainer
 * @returns {Promise<object>}
 */
export async function getTrainerDashboard(prisma, userId) {
  const trainer = await resolveTrainerOrThrow(prisma, userId);

  const now = new Date();
  const today = getDateOnlyAsMidnightUtc(now);
  const renewingSoonWindowEnd = addDaysMs(today, RENEWING_SOON_WINDOW_DAYS);
  const expiringSoonWindowEnd = addDaysMs(today, EXPIRING_SOON_WINDOW_DAYS);
  const prWindowStart = addDaysMs(today, -ENGAGEMENT_PR_WINDOW_DAYS);
  // Pass the already-captured `now` so monthStart is derived from the exact
  // same instant — two independent `new Date()` calls near midnight on the
  // last day of the month could otherwise straddle the month boundary and
  // produce an inverted [monthStart, now) range. See startOfCurrentMonth's
  // docstring in briefing-service.js.
  const monthStart = startOfCurrentMonth(now);

  const [
    briefing,
    expiredPlansCount,
    renewingSoonPlansCount,
    subscriptionIds,
    routines,
    weekPrCount,
  ] = await Promise.all([
    getBriefingByTrainerId(prisma, trainer.id),
    countExpiredPlans(prisma, trainer.id, today),
    countRenewingSoonPlans(prisma, trainer.id, today, renewingSoonWindowEnd),
    resolveAllSubscriptionIds(prisma, trainer.id),
    countRoutines(prisma, trainer.id, today, expiringSoonWindowEnd),
    countWeekPrs(prisma, trainer.id, prWindowStart),
  ]);

  const finance = await computeFinance(prisma, subscriptionIds, today, monthStart, now);

  return {
    plans: {
      expiredCount: expiredPlansCount,
      renewingSoonCount: renewingSoonPlansCount,
    },
    routines: {
      expiredCount: routines.expiredCount,
      expiringSoonCount: routines.expiringSoonCount,
    },
    finance,
    engagement: {
      inactiveStudentsCount: briefing.inactiveStudents,
      adherenceMonthPct: briefing.overallAdherence,
      adherenceDeltaPp: briefing.adherenceDeltaPp,
      weekPrCount,
    },
    generatedAt: now.toISOString(),
  };
}
