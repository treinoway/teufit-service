/**
 * Subscription cycle service — materializes recurring billing cycles and
 * voids not-yet-due charges when a subscription ends.
 *
 * Generator performance (never N+1): per batch of subscriptions it runs
 *   1. one findMany for the active subscriptions (trainer-scoped or batched
 *      over all trainers by cursor),
 *   2. one DISTINCT ON query for the latest cycle of every subscription in the batch,
 *   3. one conditional INSERT ... ON CONFLICT DO NOTHING for every cycle that
 *      must be created (see insertCyclesForActiveSubscriptions).
 * → 2 queries when nothing is due, 3 otherwise, per batch of
 * CYCLE_GENERATION_BATCH_SIZE subscriptions — independent of student count.
 *
 * Idempotent: @@unique([subscriptionId, cycleIndex]) + ON CONFLICT DO NOTHING
 * make concurrent runs (several instances, cron + overview) safe.
 *
 * Dependencies are injected — never import the prisma singleton here.
 */

import { Prisma } from '@prisma/client';
import {
  SubscriptionStatus,
  PaymentStatus,
  CYCLE_GENERATION_LEAD_DAYS,
  CYCLE_GENERATION_BATCH_SIZE,
  MAX_CYCLES_PER_GENERATION_RUN,
} from '../constants/subscription.js';
import { addDaysMs, formatDateOnly } from '../helpers/date-helpers.js';
import { computeAmount, computeNextCycle } from '../helpers/subscription-helpers.js';

/**
 * Cycles that must exist for one subscription so that no cycle starts later
 * than `generationLimit` without having been created (catch-up included).
 */
function buildMissingCycles(subscription, lastCycle, generationLimit, today) {
  const netAmount = computeAmount(
    subscription.price,
    subscription.discountPercent,
    subscription.discountAmount,
  );
  const missingCycles = [];
  let previousCycle = lastCycle;

  while (missingCycles.length < MAX_CYCLES_PER_GENERATION_RUN) {
    // `today` makes the generator skip cycles that already ended (backdated
    // subscriptions) — it only ever creates the current and upcoming cycles.
    const nextCycle = computeNextCycle(subscription, previousCycle, today);
    if (nextCycle.cycleStartDate > generationLimit) break;

    missingCycles.push({
      subscriptionId: subscription.id,
      cycleIndex: nextCycle.cycleIndex,
      cycleStartDate: nextCycle.cycleStartDate,
      cycleEndDate: nextCycle.cycleEndDate,
      dueDate: nextCycle.cycleStartDate,
      amount: netAmount,
      notes: null,
    });
    previousCycle = nextCycle;
  }

  return missingCycles;
}

/**
 * Insert pending cycles ONLY for subscriptions that are still active at write
 * time, idempotently, in ONE statement.
 *
 * `FOR SHARE OF s` takes a row lock on the subscription: a concurrent cancel
 * (which updates the row, then voids upcoming payments) either completes first
 * — the insert then re-checks status and skips — or waits until this insert
 * commits, after which its payment-voiding UPDATE sees the new rows. A cycle
 * can therefore never be (re)created for a subscription that was just cancelled.
 *
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 * @param {Array<{ subscriptionId: string, cycleIndex: number, cycleStartDate: Date, cycleEndDate: Date, dueDate: Date, amount: import('@prisma/client').Prisma.Decimal, notes: string|null }>} rows
 * @returns {Promise<number>} rows actually inserted
 */
export async function insertCyclesForActiveSubscriptions(client, rows) {
  if (rows.length === 0) return 0;

  const values = Prisma.join(
    rows.map(
      (row) => Prisma.sql`(
        ${row.subscriptionId}::uuid,
        ${row.cycleIndex}::int,
        ${formatDateOnly(row.cycleStartDate)}::date,
        ${formatDateOnly(row.cycleEndDate)}::date,
        ${formatDateOnly(row.dueDate)}::date,
        ${row.amount.toFixed(2)}::numeric,
        ${row.notes}::text
      )`,
    ),
  );

  return client.$executeRaw`
    INSERT INTO subscription_payments
      (id, subscription_id, cycle_index, cycle_start_date, cycle_end_date, due_date, amount, status, notes, created_at)
    SELECT gen_random_uuid(), r.subscription_id, r.cycle_index, r.cycle_start_date, r.cycle_end_date,
           r.due_date, r.amount, ${PaymentStatus.PENDING}::text, r.notes, NOW()
    FROM (VALUES ${values}) AS r(subscription_id, cycle_index, cycle_start_date, cycle_end_date, due_date, amount, notes)
    JOIN student_subscriptions s ON s.id = r.subscription_id
    WHERE s.status = ${SubscriptionStatus.ACTIVE}
    ORDER BY r.subscription_id, r.cycle_index
    FOR SHARE OF s
    ON CONFLICT (subscription_id, cycle_index) DO NOTHING
  `;
}

/**
 * Latest cycle (highest cycleIndex) of each given subscription in ONE query,
 * served by the (subscription_id, cycle_index) unique index.
 */
async function loadLatestCycles(prisma, subscriptionIds) {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (subscription_id)
      subscription_id AS "subscriptionId",
      cycle_index AS "cycleIndex",
      cycle_end_date AS "cycleEndDate"
    FROM subscription_payments
    WHERE subscription_id = ANY(${subscriptionIds}::uuid[])
    ORDER BY subscription_id, cycle_index DESC
  `;
  return new Map(rows.map((row) => [row.subscriptionId, row]));
}

/**
 * Materialize the missing cycles of the given subscriptions (rows carry
 * id/startDate/recurrence/price/discounts) up to `generationLimit`, via the
 * conditional insert. `minCycleStart` drops cycles starting on/before it.
 *
 * @returns {Promise<number>} rows inserted
 */
export async function materializeCycles(client, subscriptions, generationLimit, today, minCycleStart = null) {
  return generateForBatch(client, subscriptions, generationLimit, today, minCycleStart);
}

async function generateForBatch(prisma, subscriptions, generationLimit, today, minCycleStart = null) {
  const latestCycleBySubscription = await loadLatestCycles(
    prisma,
    subscriptions.map((subscription) => subscription.id),
  );

  const rowsToCreate = subscriptions
    .flatMap((subscription) =>
      buildMissingCycles(
        subscription,
        latestCycleBySubscription.get(subscription.id) ?? null,
        generationLimit,
        today,
      ),
    )
    .filter((row) => !minCycleStart || row.cycleStartDate > minCycleStart);

  return insertCyclesForActiveSubscriptions(prisma, rowsToCreate);
}

/**
 * Ensure every active subscription has its cycles materialized up to
 * `today + CYCLE_GENERATION_LEAD_DAYS`.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ trainerId?: string, today: Date }} options - `today` is the
 *   business-timezone civil day (midnight UTC); omit `trainerId` to process
 *   every trainer (cron).
 * @returns {Promise<{ subscriptionsChecked: number, cyclesCreated: number }>}
 */
export async function ensureUpcomingCycles(prisma, { trainerId, today }) {
  const generationLimit = addDaysMs(today, CYCLE_GENERATION_LEAD_DAYS);
  let subscriptionsChecked = 0;
  let cyclesCreated = 0;
  let lastSeenId;

  for (;;) {
    const subscriptions = await prisma.studentSubscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        ...(trainerId ? { trainerId } : {}),
        ...(lastSeenId ? { id: { gt: lastSeenId } } : {}),
      },
      select: {
        id: true,
        startDate: true,
        recurrence: true,
        price: true,
        discountPercent: true,
        discountAmount: true,
      },
      orderBy: { id: 'asc' },
      take: CYCLE_GENERATION_BATCH_SIZE,
    });

    if (subscriptions.length === 0) break;

    subscriptionsChecked += subscriptions.length;
    cyclesCreated += await generateForBatch(prisma, subscriptions, generationLimit, today);

    if (subscriptions.length < CYCLE_GENERATION_BATCH_SIZE) break;
    lastSeenId = subscriptions[subscriptions.length - 1].id;
  }

  return { subscriptionsChecked, cyclesCreated };
}

/**
 * Void pending payments whose cycle has not started yet (cycleStartDate > today).
 * When replacing a plan (`replacementCycleStart` given) the cut-off is instead
 * the new subscription's first cycle: only pending payments starting on/after
 * it are voided (the new plan bills that period, so the old charge would be a
 * duplicate); older cycles of the replaced plan stay billable at full price —
 * no proration. Pending payments already due stay pending — real debt.
 * Voided rows get voidedAt. One UPDATE regardless of how many subscriptions match.
 *
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 * @param {object} subscriptionWhere - Prisma where on StudentSubscription (e.g. { id } or { trainerId, studentId })
 * @param {Date} today - business-timezone civil day (midnight UTC)
 * @param {{ now?: Date, replacementCycleStart?: Date }} [options]
 * @returns {Promise<number>} number of payments voided
 */
export async function cancelUpcomingPayments(
  client,
  subscriptionWhere,
  today,
  { now = new Date(), replacementCycleStart } = {},
) {
  const voidFilter = replacementCycleStart
    ? { cycleStartDate: { gte: replacementCycleStart } }
    : { cycleStartDate: { gt: today } };

  const result = await client.subscriptionPayment.updateMany({
    where: {
      status: PaymentStatus.PENDING,
      ...voidFilter,
      subscription: subscriptionWhere,
    },
    data: { status: PaymentStatus.CANCELLED, voidedAt: now },
  });
  return result.count;
}
