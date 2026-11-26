import { BUSINESS_TIMEZONE } from '../constants/subscription.js';
import { OVERVIEW_PERIOD_DAYS, OVERVIEW_WEEKLY_BUCKETS } from '../constants/admin-manager.js';
import { weekStartFor } from './consistency-week.js';

const MS_PER_DAY = 86_400_000;
const DAYS_IN_WEEK = 7;
const TOKENS_PER_MILLION = 1_000_000;
const CENTS_PER_DOLLAR = 100;
const ISO_DATE_LENGTH = 10;

// Returns the instant a number of days before the given instant.
function daysBefore(instant, days) {
  return new Date(instant.getTime() - days * MS_PER_DAY);
}

/**
 * Current window [now − P, now) and previous window [now − 2P, now − P) for an overview period.
 *
 * @param {Date} now
 * @param {string} period - one of OVERVIEW_PERIODS
 * @returns {{ from: Date, to: Date, previousFrom: Date, previousTo: Date }}
 */
export function overviewPeriodWindows(now, period) {
  const days = OVERVIEW_PERIOD_DAYS[period];
  const from = daysBefore(now, days);
  return { from, to: new Date(now.getTime()), previousFrom: daysBefore(now, 2 * days), previousTo: from };
}

/**
 * Mondays (YYYY-MM-DD, business timezone) of the last OVERVIEW_WEEKLY_BUCKETS weeks, oldest first, ending with the current week.
 *
 * @param {Date} now
 * @returns {string[]}
 */
export function overviewWeekStarts(now) {
  const monday = weekStartFor(now, BUSINESS_TIMEZONE);
  const mondayUtc = Date.UTC(monday.year, monday.month - 1, monday.day);
  return Array.from({ length: OVERVIEW_WEEKLY_BUCKETS }, (_, index) => {
    const weeksBack = OVERVIEW_WEEKLY_BUCKETS - 1 - index;
    return new Date(mondayUtc - weeksBack * DAYS_IN_WEEK * MS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH);
  });
}

// Returns the USD cost of one token counter at the given per-million prices.
function counterCostUsd(counter, price) {
  const weightedTokens = counter.inputTokens * price.input
    + counter.outputTokens * price.output
    + counter.cacheReadTokens * price.cacheRead
    + counter.cacheWriteTokens * price.cacheWrite;
  return weightedTokens / TOKENS_PER_MILLION;
}

/**
 * Estimated USD cost of per-model token counters, rounded to cents; models without a price are left out and mark the cost incomplete.
 *
 * @param {Array<{ model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }>} counters
 * @param {Record<string, { input: number, output: number, cacheRead: number, cacheWrite: number }>} priceTable
 * @returns {{ estimatedCostUsd: number, costComplete: boolean }}
 */
export function estimateAiCostUsd(counters, priceTable) {
  let rawCostUsd = 0;
  let costComplete = true;
  for (const counter of counters) {
    const price = Object.hasOwn(priceTable, counter.model) ? priceTable[counter.model] : undefined;
    if (price) rawCostUsd += counterCostUsd(counter, price);
    else costComplete = false;
  }
  return { estimatedCostUsd: Math.round(rawCostUsd * CENTS_PER_DOLLAR) / CENTS_PER_DOLLAR, costComplete };
}
