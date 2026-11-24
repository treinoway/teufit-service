import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error.js';
import {
  RECURRENCE_MONTHS,
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  MAX_MONEY_AMOUNT,
  MONEY_DECIMAL_PLACES,
} from '../constants/subscription.js';
import { addMonthsClamped, dateWithClampedDay, formatDateOnly } from './date-helpers.js';
import { deriveEffectiveStatus } from './payment-status-helpers.js';

const { Decimal } = Prisma;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start of the billing-day-aligned cycle `monthsOffset` months after cycle 0.
 *
 * @param {Date} anchorDate
 * @param {number} billingDay - 1..31
 * @param {number} monthsOffset
 * @returns {Date} midnight UTC
 */
function computeAlignedCycleStart(anchorDate, billingDay, monthsOffset) {
  const year = anchorDate.getUTCFullYear();
  const monthIndex = anchorDate.getUTCMonth();
  const anchorMonthStart = dateWithClampedDay(year, monthIndex, billingDay);
  const baseMonthIndex = anchorDate < anchorMonthStart ? monthIndex - 1 : monthIndex;
  return dateWithClampedDay(year, baseMonthIndex + monthsOffset, billingDay);
}

/**
 * Bounds of billing cycle `cycleIndex` of a subscription.
 *
 * Every cycle is derived from the ORIGINAL anchor (the subscription startDate),
 * never from the previous cycle, so the billing day never drifts:
 *   start(i) = anchor + i * months   (day clamped to month length)
 *   end(i)   = start(i + 1) - 1 day
 *
 * Examples (anchor Jan 31, monthly): i=0 → Jan 31..Feb 27, i=1 → Feb 28..Mar 30,
 * i=2 → Mar 31..Apr 29 — the billing day returns to the 31st when it exists.
 *
 * With a `billingDay` the grid is aligned to that day of the month instead
 * (see computeAlignedCycleStart); null/undefined keeps the anchor-day grid.
 *
 * @param {Date} anchorDate - subscription startDate (date-only, UTC)
 * @param {string} recurrence - key of RECURRENCE_MONTHS
 * @param {number} cycleIndex - zero-based
 * @param {number|null} [billingDay] - 1..31 or null
 * @returns {{ cycleStartDate: Date, cycleEndDate: Date }}
 */
export function computeCycleBounds(anchorDate, recurrence, cycleIndex, billingDay = null) {
  const months = RECURRENCE_MONTHS[recurrence];
  // why: offset applies to the base month then re-clamps, never to a clamped date (no drift)
  const startOf = (index) => billingDay == null
    ? addMonthsClamped(anchorDate, index * months)
    : computeAlignedCycleStart(anchorDate, billingDay, index * months);
  const cycleStartDate = startOf(cycleIndex);
  const nextCycleStart = startOf(cycleIndex + 1);
  return {
    cycleStartDate,
    cycleEndDate: new Date(nextCycleStart.getTime() - ONE_DAY_MS),
  };
}

/**
 * Effective start of a cycle: the later of its start and the subscription start day (midnight UTC).
 *
 * @param {Date} cycleStartDate
 * @param {Date} subscriptionStartDate
 * @returns {Date}
 */
export function computeEffectiveStart(cycleStartDate, subscriptionStartDate) {
  const startDay = new Date(Date.UTC(
    subscriptionStartDate.getUTCFullYear(),
    subscriptionStartDate.getUTCMonth(),
    subscriptionStartDate.getUTCDate(),
  ));
  return cycleStartDate > startDay ? cycleStartDate : startDay;
}

/**
 * Next cycle to materialize for a subscription: always a cell of the anchor
 * grid (computeCycleBounds), so every cycle has the full recurrence length.
 *
 * Without `today` it is simply grid cycle `lastCycleIndex + 1` (0 when there is
 * no cycle yet). With `today` (business-timezone civil day) cycles that already
 * ended are skipped — a backdated subscription must not burst-create a charge
 * for every past period. The skipped indexes are simply never materialized, so
 * cycleIndex stays the grid index and the (subscriptionId, cycleIndex) unique
 * key keeps working.
 *
 * @param {{ startDate: Date, recurrence: string, billingDay?: number|null }} subscription
 * @param {{ cycleIndex: number } | null} lastCycle
 * @param {Date} [today]
 * @returns {{ cycleIndex: number, cycleStartDate: Date, cycleEndDate: Date }}
 */
export function computeNextCycle(subscription, lastCycle, today = null) {
  const { startDate, recurrence, billingDay = null } = subscription;

  let cycleIndex = lastCycle ? lastCycle.cycleIndex + 1 : 0;
  let bounds = computeCycleBounds(startDate, recurrence, cycleIndex, billingDay);

  while (today && bounds.cycleEndDate < today) {
    cycleIndex += 1;
    bounds = computeCycleBounds(startDate, recurrence, cycleIndex, billingDay);
  }

  return { cycleIndex, ...bounds };
}

/**
 * Net amount after applying the discount: a Decimal floored at 0 and rounded
 * half-up to 2 places (explicit, so it never depends on the DB write cast).
 */
export function computeAmount(price, discountPercent, discountAmount) {
  const priceDecimal = new Decimal(price);
  let net = priceDecimal;

  if (discountPercent != null) {
    const discounted = priceDecimal.times(new Decimal(discountPercent)).dividedBy(100);
    net = priceDecimal.minus(discounted);
  } else if (discountAmount != null) {
    net = priceDecimal.minus(new Decimal(discountAmount));
  }

  return Decimal.max(net, new Decimal(0)).toDecimalPlaces(MONEY_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
}

/**
 * Reject monetary inputs that Decimal(10,2) cannot store faithfully:
 * more than 2 decimal places (0.001 would silently become 0.00) or above the maximum.
 * `null`/`undefined` are ignored (optional fields).
 */
export function assertValidMoneyAmount(value) {
  if (value == null) return;

  const amount = new Decimal(value);
  if (amount.decimalPlaces() > MONEY_DECIMAL_PLACES || amount.greaterThan(MAX_MONEY_AMOUNT)) {
    throw new AppError({
      httpStatus: 400,
      error: SubscriptionErrorCode.INVALID_AMOUNT,
      messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
      message: 'Amount must have at most 2 decimal places and not exceed 99999999.99',
    });
  }
}

/**
 * Reject discount percentages with more than 2 decimal places (Decimal(5,2)
 * would silently round them). Range is enforced by the schema/validateDiscount.
 */
export function assertValidPercentage(value) {
  if (value == null) return;

  if (new Decimal(value).decimalPlaces() > MONEY_DECIMAL_PLACES) {
    throw new AppError({
      httpStatus: 400,
      error: SubscriptionErrorCode.INVALID_AMOUNT,
      messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
      message: 'Percentage must have at most 2 decimal places',
    });
  }
}

/**
 * Serialize a SubscriptionPayment row, including the derived effective status.
 *
 * @param {object} payment - Prisma row
 * @param {Date} today - business-timezone civil today (midnight UTC)
 */
export function formatPayment(payment, today) {
  const { effectiveStatus, daysOverdue } = deriveEffectiveStatus(payment, today);
  return {
    id: payment.id,
    subscriptionId: payment.subscriptionId,
    cycleIndex: payment.cycleIndex,
    cycleStartDate: formatDateOnly(payment.cycleStartDate),
    cycleEndDate: formatDateOnly(payment.cycleEndDate),
    dueDate: formatDateOnly(payment.dueDate),
    amount: payment.amount.toString(),
    status: payment.status,
    effectiveStatus,
    daysOverdue,
    paidAt: payment.paidAt ?? null,
    voidedAt: payment.voidedAt ?? null,
    notes: payment.notes ?? null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt ?? null,
  };
}
