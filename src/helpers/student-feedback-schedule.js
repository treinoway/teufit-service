/**
 * Schedule of the student feedbacks: milestones count civil days from the trainer-student link in the send timezone.
 */

import {
  MILESTONE_BY_DAY,
  MILESTONE_DAYS,
  RECURRING_INTERVAL_DAYS,
  RECURRING_MILESTONE,
  REMINDER_AFTER_HOURS,
  RESPONSE_WINDOW_DAYS,
  SEND_HOUR,
  SEND_TIME_ZONE,
  StudentFeedbackStatus,
} from '../constants/student-feedback.js';
import { civilDateInTimeZone, zonedWallClockToInstant } from './date-helpers.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const LAST_FIXED_DAY = MILESTONE_DAYS[MILESTONE_DAYS.length - 1];
const FIRST_RECURRING_DAY = LAST_FIXED_DAY + RECURRING_INTERVAL_DAYS;

// Midnight-UTC key of the civil date of an instant in the send timezone
function civilKeyOf(instant) {
  const { year, month, day } = civilDateInTimeZone(instant, SEND_TIME_ZONE);
  return Date.UTC(year, month - 1, day);
}

// Milestone and config toggle of a milestone day (fixed days, then the recurring ones)
function milestoneOfDay(day) {
  return MILESTONE_BY_DAY[day] ?? RECURRING_MILESTONE;
}

// Number of whole milestone days already reached at the instant (the day counts from its send hour)
function reachedDays(linkedAt, instant) {
  const civilDays = Math.round((civilKeyOf(instant) - civilKeyOf(linkedAt)) / DAY_MS);
  return milestoneDueAt(linkedAt, civilDays) > instant ? civilDays - 1 : civilDays;
}

// Latest milestone day at or before the given number of reached days, or null before the first one
function latestMilestoneDay(days) {
  if (days >= FIRST_RECURRING_DAY) return Math.floor(days / RECURRING_INTERVAL_DAYS) * RECURRING_INTERVAL_DAYS;
  return MILESTONE_DAYS.findLast((day) => day <= days) ?? null;
}

// First recurring day after the given number of reached days
function nextRecurringDay(days) {
  const next = (Math.floor(days / RECURRING_INTERVAL_DAYS) + 1) * RECURRING_INTERVAL_DAYS;
  return Math.max(next, FIRST_RECURRING_DAY);
}

/**
 * Instant a milestone falls due: the send hour, in the send timezone, `day` civil days after the link.
 *
 * @param {Date} linkedAt - TrainerStudent.createdAt
 * @param {number} day
 * @returns {Date}
 */
export function milestoneDueAt(linkedAt, day) {
  const civil = civilDateInTimeZone(linkedAt, SEND_TIME_ZONE);
  return zonedWallClockToInstant({ ...civil, day: civil.day + day }, SEND_TIME_ZONE, SEND_HOUR);
}

/**
 * Milestone to send now: only the latest one already reached counts (no catch-up), and only when auto-send is on, its toggle is on and it fell due after auto-send was turned on.
 *
 * @param {{ linkedAt: Date, config: object|null, now: Date }} input
 * @returns {{ milestone: string, day: number, dueAt: Date }|null}
 */
export function dueMilestone({ linkedAt, config, now }) {
  if (!config?.autoSendEnabled || !config.enabledAt) return null;
  const day = latestMilestoneDay(reachedDays(linkedAt, now));
  if (day === null) return null;
  const { milestone, toggle } = milestoneOfDay(day);
  const dueAt = milestoneDueAt(linkedAt, day);
  if (!config[toggle] || dueAt < config.enabledAt) return null;
  return { milestone, day, dueAt };
}

/**
 * Next milestone after the given moment that the config will send, with its due instant, or null when none will (auto-send off or never stamped, or nothing enabled left).
 *
 * @param {{ linkedAt: Date, config: object|null, after: Date }} input
 * @returns {{ milestone: string, dueAt: Date }|null}
 */
export function nextMilestone({ linkedAt, config, after }) {
  if (!config?.autoSendEnabled || !config.enabledAt) return null;
  const days = reachedDays(linkedAt, after);
  const fixedDay = MILESTONE_DAYS.find((day) => day > days && config[MILESTONE_BY_DAY[day].toggle]);
  if (fixedDay === undefined && !config[RECURRING_MILESTONE.toggle]) return null;
  const day = fixedDay ?? nextRecurringDay(days);
  return { milestone: milestoneOfDay(day).milestone, dueAt: milestoneDueAt(linkedAt, day) };
}

/**
 * Due instant of the next milestone after the given moment that the config will send, or null when none will.
 *
 * @param {{ linkedAt: Date, config: object|null, after: Date }} input
 * @returns {Date|null}
 */
export function nextMilestoneAt({ linkedAt, config, after }) {
  return nextMilestone({ linkedAt, config, after })?.dueAt ?? null;
}

// Whether a request still accepts answers, which stops the cron from sending another one to the pair
function isOpen(request, now) {
  return request.status === StudentFeedbackStatus.PENDING && request.expiresAt > now;
}

// Instant the last open request of the pair expires, or null when none is open
function blockedUntil(requests, now) {
  const expiries = requests.filter((request) => isOpen(request, now)).map((request) => request.expiresAt.getTime());
  return expiries.length === 0 ? null : new Date(Math.max(...expiries));
}

// Whether the milestone occurrence due at the instant was already sent to the pair
function wasSent(requests, dueAt) {
  return requests.some((request) => request.dueAt?.getTime() === dueAt.getTime());
}

/**
 * Next automatic send of a trainer-student pair as the cron will make it if nobody answers: while a request is open nothing goes out, and when it expires the cron sends the latest milestone reached by then (unless already sent), else the next one on time.
 *
 * @param {{ linkedAt: Date, config: object|null, now: Date, requests: { status: string, dueAt: Date|null, expiresAt: Date }[] }} input - requests: every request of the pair
 * @returns {{ milestone: string, dueAt: Date }|null} dueAt is the instant the send goes out
 */
export function nextAutoSend({ linkedAt, config, now, requests }) {
  const unblockedAt = blockedUntil(requests, now);
  if (unblockedAt === null) return nextMilestone({ linkedAt, config, after: now });
  const delayed = dueMilestone({ linkedAt, config, now: unblockedAt });
  if (delayed && !wasSent(requests, delayed.dueAt)) return { milestone: delayed.milestone, dueAt: unblockedAt };
  return nextMilestone({ linkedAt, config, after: unblockedAt });
}

/**
 * Instant a request sent at `sentAt` stops accepting answers.
 *
 * @param {Date} sentAt
 * @param {number} [days] - response window of the trainer; the default window when omitted
 * @returns {Date}
 */
export function expiresAtFor(sentAt, days = RESPONSE_WINDOW_DAYS) {
  return new Date(sentAt.getTime() + days * DAY_MS);
}

/**
 * Whether the single reminder of a request must go out now: still pending, inside its window, not reminded, sent long enough ago.
 *
 * @param {{ status: string, sentAt: Date, expiresAt: Date, reminderSentAt: Date|null }} request
 * @param {Date} now
 * @returns {boolean}
 */
export function isReminderDue(request, now) {
  if (request.status !== StudentFeedbackStatus.PENDING || request.reminderSentAt) return false;
  if (now >= request.expiresAt) return false;
  return now.getTime() - request.sentAt.getTime() >= REMINDER_AFTER_HOURS * HOUR_MS;
}

/**
 * Whether a request no longer accepts answers because its window closed (marked expired, or pending past expiresAt).
 *
 * @param {{ status: string, expiresAt: Date }} request
 * @param {Date} now
 * @returns {boolean}
 */
export function isExpired(request, now) {
  if (request.status === StudentFeedbackStatus.EXPIRED) return true;
  return request.status === StudentFeedbackStatus.PENDING && now >= request.expiresAt;
}

/**
 * Started days left until expiresAt; zero once it passed.
 *
 * @param {Date} expiresAt
 * @param {Date} now
 * @returns {number}
 */
export function daysLeft(expiresAt, now) {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS));
}
