import { describe, expect, it } from 'vitest';
import { expiresAtFor, isReminderDue, nextMilestone } from '../../src/helpers/student-feedback-schedule.js';
import {
  REMINDER_AFTER_HOURS,
  RESPONSE_WINDOW_DAYS,
  RESPONSE_WINDOW_MAX_DAYS,
  RESPONSE_WINDOW_MIN_DAYS,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_WINDOW_DAYS = 3;
const SHORTEST_WINDOW_DAYS = 1;
const LONGEST_WINDOW_DAYS = 7;
const SENT_AT = new Date('2026-11-08T12:00:00Z');
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
const DAY_EIGHT = new Date('2026-11-09T15:00:00Z');
const ALL_ON_NEVER_STAMPED = Object.freeze({ autoSendEnabled: true, enabledAt: null, d7: true, d15: true, d21: true, d30: true, recurring: true });

// Instant the given number of days after SENT_AT
function daysAfterSend(days) {
  return new Date(SENT_AT.getTime() + days * DAY_MS);
}

// Pending request sent at SENT_AT with a window of the given number of days, not reminded yet
function pendingRequest(windowDays) {
  return { status: StudentFeedbackStatus.PENDING, sentAt: SENT_AT, expiresAt: daysAfterSend(windowDays), reminderSentAt: null };
}

describe('response window constants', () => {
  it('keeps RESPONSE_WINDOW_DAYS as the default of three days', () => {
    expect(RESPONSE_WINDOW_DAYS).toBe(DEFAULT_WINDOW_DAYS);
  });

  it('allows a window from one day', () => {
    expect(RESPONSE_WINDOW_MIN_DAYS).toBe(SHORTEST_WINDOW_DAYS);
  });

  it('allows a window up to seven days', () => {
    expect(RESPONSE_WINDOW_MAX_DAYS).toBe(LONGEST_WINDOW_DAYS);
  });

  it('keeps the default inside the allowed range', () => {
    expect(RESPONSE_WINDOW_DAYS).toBeGreaterThanOrEqual(RESPONSE_WINDOW_MIN_DAYS);
    expect(RESPONSE_WINDOW_DAYS).toBeLessThanOrEqual(RESPONSE_WINDOW_MAX_DAYS);
  });
});

describe('expiresAtFor with a response window', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('expires %i day(s) after the send when given that window', (days) => {
    expect(expiresAtFor(SENT_AT, days)).toEqual(daysAfterSend(days));
  });

  it('keeps expiring after the default window when called with the send instant only', () => {
    expect(expiresAtFor(SENT_AT)).toEqual(daysAfterSend(RESPONSE_WINDOW_DAYS));
  });

  it('falls back to the default window when the days are undefined', () => {
    expect(expiresAtFor(SENT_AT, undefined)).toEqual(daysAfterSend(RESPONSE_WINDOW_DAYS));
  });

  it('returns a new Date and leaves the send instant untouched', () => {
    const sentAt = new Date(SENT_AT);

    const expiresAt = expiresAtFor(sentAt, LONGEST_WINDOW_DAYS);

    expect(expiresAt).not.toBe(sentAt);
    expect(sentAt).toEqual(SENT_AT);
  });
});

describe('reminder of a request with a one-day window', () => {
  const REMINDER_INSTANT = new Date(SENT_AT.getTime() + REMINDER_AFTER_HOURS * HOUR_MS);

  it('is never due: the request stops accepting answers at the very instant the reminder would go out', () => {
    expect(isReminderDue(pendingRequest(SHORTEST_WINDOW_DAYS), REMINDER_INSTANT)).toBe(false);
  });

  it('is not due one minute before the reminder instant either', () => {
    expect(isReminderDue(pendingRequest(SHORTEST_WINDOW_DAYS), new Date(REMINDER_INSTANT.getTime() - 60000))).toBe(false);
  });

  it('is still due 24 hours after the send with a two-day window', () => {
    expect(isReminderDue(pendingRequest(2), REMINDER_INSTANT)).toBe(true);
  });
});

describe('nextMilestone without an enabledAt stamp', () => {
  it('returns null when auto-send is on but enabledAt is null, the same guard the cron applies', () => {
    expect(nextMilestone({ linkedAt: LINKED_AT, config: ALL_ON_NEVER_STAMPED, after: DAY_EIGHT })).toBeNull();
  });

  it('returns null when auto-send is on and the row has no enabledAt at all', () => {
    const { enabledAt: _enabledAt, ...config } = ALL_ON_NEVER_STAMPED;

    expect(nextMilestone({ linkedAt: LINKED_AT, config, after: DAY_EIGHT })).toBeNull();
  });
});
