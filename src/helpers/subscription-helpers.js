import { RECURRENCE_MONTHS } from '../constants/subscription.js';
import { parseDateOnlyAsUtc } from './date-helpers.js';

/**
 * Compute the last day of the billing cycle (cycleEndDate).
 *
 * Semantics: the cycle ends the day before the next billing date would fall.
 * When the start day does not exist in the target month (e.g. Jan 31 + 1 month → Feb has no 31),
 * the cycle ends on the last calendar day of that month instead of rolling over to the next month.
 *
 * Examples:
 *   May 1  + monthly  → May 31   (Jun 1 − 1d, no overflow)
 *   Jan 31 + monthly  → Feb 28/29 (Feb has no day 31 → last day of Feb)
 *   Aug 31 + monthly  → Sep 30   (Sep has no day 31 → last day of Sep)
 *   Jan 1  + quarterly → Mar 31  (Apr 1 − 1d, no overflow)
 *
 * @param {Date|string} startDate - UTC Date or "YYYY-MM-DD" string
 * @param {string} recurrence - one of the RECURRENCE_MONTHS keys (monthly, quarterly, …)
 * @returns {Date} cycleEndDate in UTC
 */
export function computeCycleEndDate(startDate, recurrence) {
  const months = RECURRENCE_MONTHS[recurrence];
  const d = startDate instanceof Date ? startDate : parseDateOnlyAsUtc(startDate);

  const startDay = d.getUTCDate();
  const targetYear = d.getUTCFullYear();
  const targetMonth = d.getUTCMonth() + months;

  // Last day of the target month: Date.UTC(y, targetMonth+1, 0) gives day 0 of next month = last day.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  if (startDay > lastDayOfTargetMonth) {
    // Start day overflows in target month: cycle ends on the last day of that month.
    return new Date(Date.UTC(targetYear, targetMonth, lastDayOfTargetMonth));
  }

  // No overflow: next billing falls on the same day in the target month; cycle ends the day before.
  return new Date(Date.UTC(targetYear, targetMonth, startDay) - 24 * 60 * 60 * 1000);
}
