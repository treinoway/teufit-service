/**
 * Week calendar helpers for the consistency ranking.
 * A civil date is `{ year, month, day }` (month 1-12); weeks run Monday to the configured close.
 */

import { CATEGORY_TO_PILLAR, Pillar } from '../constants/consistency-ranking.js';
import { WeekDays } from '../constants/training.js';
import { civilDateInTimeZone, getWeekdayInTimeZone, zonedWallClockToInstant } from './date-helpers.js';

const MS_PER_DAY = 86400000;
const DAYS_IN_WEEK = 7;
const WEEKDAY_ORDER = Object.freeze([
  WeekDays.MONDAY,
  WeekDays.TUESDAY,
  WeekDays.WEDNESDAY,
  WeekDays.THURSDAY,
  WeekDays.FRIDAY,
  WeekDays.SATURDAY,
  WeekDays.SUNDAY,
]);

// Adds (or subtracts) whole civil days to a civil date
function addCivilDays({ year, month, day }, days) {
  const moved = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

// Monday-based index (0-6) of the close weekday, where closeWeekday follows JS (0 = Sunday)
function closeOffsetFromMonday(closeWeekday) {
  return (closeWeekday + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK;
}

// Midnight-UTC key of a civil date, comparable with @db.Date values
function civilKey({ year, month, day }) {
  return Date.UTC(year, month - 1, day);
}

// Weekday name (Monday-first enum) of a civil date
function weekdayOfCivil(civil) {
  const index = (new Date(civilKey(civil)).getUTCDay() + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK;
  return WEEKDAY_ORDER[index];
}

/**
 * Civil Monday of the week containing the instant, in the given timezone.
 *
 * @param {Date} instant
 * @param {string} timeZone - IANA timezone
 * @returns {{ year: number, month: number, day: number }}
 */
export function weekStartFor(instant, timeZone) {
  const civil = civilDateInTimeZone(instant, timeZone);
  const weekday = getWeekdayInTimeZone(instant, timeZone);
  return addCivilDays(civil, -WEEKDAY_ORDER.indexOf(weekday));
}

/**
 * Start and close instants of a week plus the civil days that generate a target.
 *
 * @param {{ year: number, month: number, day: number }} weekStart - civil Monday
 * @param {{ closeWeekday: number, closeHour: number, timeZone: string }} rule - closeWeekday 0 = Sunday
 * @returns {{ startInstant: Date, closeInstant: Date, scheduleDays: Array<{ year: number, month: number, day: number }> }}
 */
export function weekBounds(weekStart, rule) {
  const offset = closeOffsetFromMonday(rule.closeWeekday);
  const scheduleDays = Array.from({ length: offset + 1 }, (_, index) => addCivilDays(weekStart, index));
  return {
    startInstant: zonedWallClockToInstant(weekStart, rule.timeZone, 0),
    closeInstant: zonedWallClockToInstant(scheduleDays[offset], rule.timeZone, rule.closeHour),
    scheduleDays,
  };
}

/**
 * Window of finished sessions that count for the week: previous week close to this week close, no gap (AD-006).
 *
 * @param {{ year: number, month: number, day: number }} weekStart - civil Monday
 * @param {object} rule - rule of this week
 * @param {object|null} previousRule - rule of the previous week; falls back to `rule`
 * @returns {{ from: Date, to: Date }}
 */
export function doneWindow(weekStart, rule, previousRule) {
  const previousWeekStart = addCivilDays(weekStart, -DAYS_IN_WEEK);
  return {
    from: weekBounds(previousWeekStart, previousRule ?? rule).closeInstant,
    to: weekBounds(weekStart, rule).closeInstant,
  };
}

// Whether the protocol is valid on the civil day (start and expiration inclusive)
function isProtocolValidOn(protocol, civil) {
  const key = civilKey(civil);
  if (key < protocol.startDate.getTime()) return false;
  return !protocol.expirationDate || key <= protocol.expirationDate.getTime();
}

// Sessions a single training expects across the valid schedule days
function sessionsForTraining(training, validDays) {
  if (!training.weekDay) return validDays.length > 0 ? 1 : 0;
  return validDays.filter((civil) => weekdayOfCivil(civil) === training.weekDay).length;
}

/**
 * Expected sessions per pillar from the active protocols over the schedule days (undated trainings count once).
 *
 * @param {Array<{ startDate: Date, expirationDate: Date|null, trainings: Array<{ weekDay: string|null, category: string }> }>} protocols
 * @param {Array<{ year: number, month: number, day: number }>} scheduleDays
 * @returns {{ workouts: number, cardio: number }}
 */
export function expectedFromProtocols(protocols, scheduleDays) {
  const expected = { workouts: 0, cardio: 0 };
  for (const protocol of protocols) {
    const validDays = scheduleDays.filter((civil) => isProtocolValidOn(protocol, civil));
    for (const training of protocol.trainings) {
      const pillar = CATEGORY_TO_PILLAR[training.category];
      if (pillar === Pillar.WORKOUTS || pillar === Pillar.CARDIO) {
        expected[pillar] += sessionsForTraining(training, validDays);
      }
    }
  }
  return expected;
}
