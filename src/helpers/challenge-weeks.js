/**
 * Calendar rules of weekly championships (format "weeks"): Monday start, whole weeks, status in the trainer time zone.
 * Civil dates are `{ year, month, day }` (month 1-12); @db.Date values are midnight-UTC Dates.
 */

import { AppError } from '../errors/app-error.js';
import {
  CHALLENGE_MAX_PODIUM_WEEKS,
  CHALLENGE_MAX_WEEKS,
  CHALLENGE_MIN_PODIUM_WEEKS,
  CHALLENGE_MIN_WEEKS,
  ChallengeErrorCode,
  ChallengeMessageCode,
  ChallengeStatus,
} from '../constants/challenge.js';
import { weekStartFor } from './consistency-week.js';
import { zonedWallClockToInstant } from './date-helpers.js';

const MS_PER_DAY = 86400000;
const DAYS_IN_WEEK = 7;
const MONDAY_UTC_DAY = 1;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// Midnight-UTC Date of a civil date
function civilToDate({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Civil date of a midnight-UTC Date
function dateToCivil(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Strict "YYYY-MM-DD" parse to a civil date, or null when malformed or not a real calendar day
function parseCivil(value) {
  const match = typeof value === 'string' ? DATE_ONLY_PATTERN.exec(value) : null;
  if (!match) return null;
  const civil = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const roundTrip = dateToCivil(civilToDate(civil));
  const sameDay = roundTrip.year === civil.year && roundTrip.month === civil.month && roundTrip.day === civil.day;
  return sameDay ? civil : null;
}

// Whether the value is an integer in [min, max]
function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// 400 for an invalid start Monday or number of weeks
function invalidWeeks(message, field) {
  return new AppError({
    httpStatus: 400,
    error: ChallengeErrorCode.CHALLENGE_INVALID_WEEKS,
    messageCode: ChallengeMessageCode.CHALLENGE_INVALID_WEEKS,
    message,
    details: { field },
  });
}

/**
 * Stored dates of a weekly championship: the start Monday and the Sunday of its last week.
 *
 * @param {{ startWeek: string, weeks: number }} input - startWeek "YYYY-MM-DD" (a Monday)
 * @returns {{ startDate: Date, endDate: Date }} midnight-UTC Dates for the @db.Date columns
 */
export function weeksSpan({ startWeek, weeks }) {
  const startDate = civilToDate(parseCivil(startWeek));
  const endDate = new Date(startDate.getTime() + (weeks * DAYS_IN_WEEK - 1) * MS_PER_DAY);
  return { startDate, endDate };
}

/**
 * Validates the weekly fields: a Monday not before the current week (trainer time zone), 1-12 weeks, podium 1..min(4, weeks).
 *
 * @param {{ startWeek: string, weeks: number, minPodiumWeeks: number }} input
 * @param {{ timeZone: string, now: Date }} context
 * @returns {void} throws a 400 AppError when invalid
 */
export function validateWeeksInput({ startWeek, weeks, minPodiumWeeks }, { timeZone, now }) {
  const civil = parseCivil(startWeek);
  if (!civil || civilToDate(civil).getUTCDay() !== MONDAY_UTC_DAY) {
    throw invalidWeeks('startWeek must be a Monday in YYYY-MM-DD format', 'startWeek');
  }
  if (civilToDate(civil) < civilToDate(weekStartFor(now, timeZone))) {
    throw invalidWeeks('startWeek cannot be before the current week', 'startWeek');
  }
  if (!isIntegerInRange(weeks, CHALLENGE_MIN_WEEKS, CHALLENGE_MAX_WEEKS)) {
    throw invalidWeeks(`weeks must be an integer from ${CHALLENGE_MIN_WEEKS} to ${CHALLENGE_MAX_WEEKS}`, 'weeks');
  }
  const maxPodium = Math.min(CHALLENGE_MAX_PODIUM_WEEKS, weeks);
  if (!isIntegerInRange(minPodiumWeeks, CHALLENGE_MIN_PODIUM_WEEKS, maxPodium)) {
    throw new AppError({
      httpStatus: 400,
      error: ChallengeErrorCode.CHALLENGE_INVALID_MIN_PODIUM,
      messageCode: ChallengeMessageCode.CHALLENGE_INVALID_MIN_PODIUM,
      message: `minPodiumWeeks must be an integer from ${CHALLENGE_MIN_PODIUM_WEEKS} to ${maxPodium}`,
      details: { field: 'minPodiumWeeks' },
    });
  }
}

/**
 * Status of a weekly championship: cancelled > closed (closedAt) > before the start Monday 00:00 (trainer time zone) > active.
 *
 * @param {{ startDate: Date, cancelledAt: Date|null, closedAt: Date|null }} challenge
 * @param {{ now: Date, timeZone: string }} context
 * @returns {'scheduled'|'active'|'completed'|'cancelled'}
 */
export function weeklyStatus(challenge, { now, timeZone }) {
  if (challenge.cancelledAt) return ChallengeStatus.CANCELLED;
  if (challenge.closedAt) return ChallengeStatus.COMPLETED;
  const startInstant = zonedWallClockToInstant(dateToCivil(challenge.startDate), timeZone, 0);
  return now < startInstant ? ChallengeStatus.SCHEDULED : ChallengeStatus.ACTIVE;
}

/**
 * Championship week number ("Semana X de Y") of a Monday: 0 before the start, capped at the number of weeks.
 *
 * @param {{ startDate: Date, weeks: number }} challenge
 * @param {Date} mondayDate - midnight-UTC Date of a Monday
 * @returns {number}
 */
export function currentWeekOf(challenge, mondayDate) {
  const elapsedDays = Math.round((mondayDate.getTime() - challenge.startDate.getTime()) / MS_PER_DAY);
  if (elapsedDays < 0) return 0;
  return Math.min(Math.floor(elapsedDays / DAYS_IN_WEEK) + 1, challenge.weeks);
}
