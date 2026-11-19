import { describe, expect, it } from 'vitest';
import {
  daysLeft,
  dueMilestone,
  expiresAtFor,
  isExpired,
  isReminderDue,
  milestoneDueAt,
  nextMilestoneAt,
} from '../../src/helpers/student-feedback-schedule.js';
import {
  MILESTONE_DAYS,
  RECURRING_INTERVAL_DAYS,
  REMINDER_AFTER_HOURS,
  RESPONSE_WINDOW_DAYS,
  SEND_HOUR,
  SEND_TIME_ZONE,
  StudentFeedbackMilestone,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
const ENABLED_LONG_AGO = new Date('2026-01-01T00:00:00Z');
const ALL_ON = Object.freeze({ autoSendEnabled: true, enabledAt: ENABLED_LONG_AGO, d7: true, d15: true, d21: true, d30: true, recurring: true });

// 09:00 America/Sao_Paulo (12:00 UTC) of the day the given number of days after the link day
function nineAmOnDay(days) {
  return new Date(Date.UTC(2026, 10, 1 + days, 12, 0, 0));
}

// Instant shifted by a number of milliseconds
function shift(date, ms) {
  return new Date(date.getTime() + ms);
}

// Pending request sent at the given instant
function pendingSentAt(sentAt, overrides = {}) {
  return { status: StudentFeedbackStatus.PENDING, sentAt, expiresAt: shift(sentAt, 3 * DAY_MS), reminderSentAt: null, ...overrides };
}

describe('schedule constants', () => {
  it('sends on days 7, 15, 21 and 30, then every 30 days', () => {
    expect(MILESTONE_DAYS).toEqual([7, 15, 21, 30]);
    expect(RECURRING_INTERVAL_DAYS).toBe(30);
  });

  it('sends at 09:00 America/Sao_Paulo, reminds after 24 hours and expires after 3 days', () => {
    expect(SEND_HOUR).toBe(9);
    expect(SEND_TIME_ZONE).toBe('America/Sao_Paulo');
    expect(REMINDER_AFTER_HOURS).toBe(24);
    expect(RESPONSE_WINDOW_DAYS).toBe(3);
  });
});

describe('milestoneDueAt', () => {
  it('is 09:00 America/Sao_Paulo on the day the milestone falls', () => {
    expect(milestoneDueAt(LINKED_AT, 7)).toEqual(new Date('2026-11-08T12:00:00Z'));
  });

  it('counts the days from the civil date of the link in Sao Paulo, not in UTC', () => {
    const lateEveningInSaoPaulo = new Date('2026-11-02T01:30:00Z');

    expect(milestoneDueAt(lateEveningInSaoPaulo, 7)).toEqual(new Date('2026-11-08T12:00:00Z'));
  });

  it('crosses month ends', () => {
    expect(milestoneDueAt(LINKED_AT, 30)).toEqual(new Date('2026-12-01T12:00:00Z'));
  });
});

describe('dueMilestone', () => {
  it('returns null before the first milestone', () => {
    expect(dueMilestone({ linkedAt: LINKED_AT, config: ALL_ON, now: nineAmOnDay(6) })).toBeNull();
  });

  it('returns null on the milestone day before 09:00 America/Sao_Paulo', () => {
    const now = shift(nineAmOnDay(7), -60000);

    expect(dueMilestone({ linkedAt: LINKED_AT, config: ALL_ON, now })).toBeNull();
  });

  it.each([
    [7, StudentFeedbackMilestone.D7],
    [15, StudentFeedbackMilestone.D15],
    [21, StudentFeedbackMilestone.D21],
    [30, StudentFeedbackMilestone.D30],
    [60, StudentFeedbackMilestone.RECURRING],
    [90, StudentFeedbackMilestone.RECURRING],
    [120, StudentFeedbackMilestone.RECURRING],
  ])('returns the day %i milestone at 09:00 America/Sao_Paulo of that day', (day, milestone) => {
    const now = nineAmOnDay(day);

    expect(dueMilestone({ linkedAt: LINKED_AT, config: ALL_ON, now })).toEqual({ milestone, day, dueAt: now });
  });

  it('keeps pointing at the latest reached milestone between two milestones', () => {
    const due = dueMilestone({ linkedAt: LINKED_AT, config: ALL_ON, now: shift(nineAmOnDay(45), 5 * HOUR_MS) });

    expect(due).toEqual({ milestone: StudentFeedbackMilestone.D30, day: 30, dueAt: nineAmOnDay(30) });
  });

  it('returns null when auto-send is off', () => {
    const config = { ...ALL_ON, autoSendEnabled: false };

    expect(dueMilestone({ linkedAt: LINKED_AT, config, now: nineAmOnDay(7) })).toBeNull();
  });

  it.each([
    ['d7', 7],
    ['d15', 15],
    ['d21', 21],
    ['d30', 30],
    ['recurring', 60],
    ['recurring', 90],
  ])('returns null when the %s toggle is off on day %i', (toggle, day) => {
    const config = { ...ALL_ON, [toggle]: false };

    expect(dueMilestone({ linkedAt: LINKED_AT, config, now: nineAmOnDay(day) })).toBeNull();
  });

  it('still returns a milestone whose own toggle is on when another one is off', () => {
    const config = { ...ALL_ON, d7: false };

    expect(dueMilestone({ linkedAt: LINKED_AT, config, now: nineAmOnDay(15) })).toMatchObject({ milestone: StudentFeedbackMilestone.D15, day: 15 });
  });

  it('never returns a milestone that fell due before auto-send was turned on', () => {
    const config = { ...ALL_ON, enabledAt: shift(nineAmOnDay(7), HOUR_MS) };

    expect(dueMilestone({ linkedAt: LINKED_AT, config, now: shift(nineAmOnDay(7), 2 * HOUR_MS) })).toBeNull();
    expect(dueMilestone({ linkedAt: LINKED_AT, config, now: nineAmOnDay(10) })).toBeNull();
  });

  it('returns the first milestone that falls due after auto-send was turned on', () => {
    const config = { ...ALL_ON, enabledAt: shift(nineAmOnDay(7), HOUR_MS) };

    expect(dueMilestone({ linkedAt: LINKED_AT, config, now: nineAmOnDay(15) })).toMatchObject({ milestone: StudentFeedbackMilestone.D15, day: 15 });
  });
});

describe('nextMilestoneAt', () => {
  it('returns the due instant of the next milestone after the given moment', () => {
    const after = shift(nineAmOnDay(7), 4 * HOUR_MS);

    expect(nextMilestoneAt({ linkedAt: LINKED_AT, config: ALL_ON, after })).toEqual(nineAmOnDay(15));
  });

  it('skips milestones that are toggled off', () => {
    const config = { ...ALL_ON, d15: false, d21: false };

    expect(nextMilestoneAt({ linkedAt: LINKED_AT, config, after: nineAmOnDay(8) })).toEqual(nineAmOnDay(30));
  });

  it('continues every 30 days after day 30', () => {
    expect(nextMilestoneAt({ linkedAt: LINKED_AT, config: ALL_ON, after: nineAmOnDay(31) })).toEqual(nineAmOnDay(60));
    expect(nextMilestoneAt({ linkedAt: LINKED_AT, config: ALL_ON, after: nineAmOnDay(61) })).toEqual(nineAmOnDay(90));
  });

  it('returns null after day 30 when the recurring toggle is off', () => {
    const config = { ...ALL_ON, recurring: false };

    expect(nextMilestoneAt({ linkedAt: LINKED_AT, config, after: nineAmOnDay(31) })).toBeNull();
  });

  it('returns null when auto-send is off', () => {
    const config = { ...ALL_ON, autoSendEnabled: false };

    expect(nextMilestoneAt({ linkedAt: LINKED_AT, config, after: nineAmOnDay(8) })).toBeNull();
  });

  it('returns null when every milestone is toggled off', () => {
    const config = { ...ALL_ON, d7: false, d15: false, d21: false, d30: false, recurring: false };

    expect(nextMilestoneAt({ linkedAt: LINKED_AT, config, after: nineAmOnDay(1) })).toBeNull();
  });
});

describe('expiresAtFor', () => {
  it('is three days after the send instant', () => {
    expect(expiresAtFor(new Date('2026-11-08T12:00:00Z'))).toEqual(new Date('2026-11-11T12:00:00Z'));
  });
});

describe('isReminderDue', () => {
  const sentAt = new Date('2026-11-08T12:00:00Z');

  it('is false before 24 hours have passed', () => {
    expect(isReminderDue(pendingSentAt(sentAt), shift(sentAt, 24 * HOUR_MS - 1))).toBe(false);
  });

  it('is true once 24 hours have passed', () => {
    expect(isReminderDue(pendingSentAt(sentAt), shift(sentAt, 24 * HOUR_MS))).toBe(true);
  });

  it('is false when the reminder was already sent', () => {
    const request = pendingSentAt(sentAt, { reminderSentAt: shift(sentAt, 24 * HOUR_MS) });

    expect(isReminderDue(request, shift(sentAt, 30 * HOUR_MS))).toBe(false);
  });

  it.each([StudentFeedbackStatus.ANSWERED, StudentFeedbackStatus.EXPIRED])('is false for a request that is %s', (status) => {
    expect(isReminderDue(pendingSentAt(sentAt, { status }), shift(sentAt, 30 * HOUR_MS))).toBe(false);
  });

  it('is false once the answer window has closed', () => {
    expect(isReminderDue(pendingSentAt(sentAt), shift(sentAt, 3 * DAY_MS))).toBe(false);
  });
});

describe('isExpired', () => {
  const sentAt = new Date('2026-11-08T12:00:00Z');

  it('is false for a pending request inside its window', () => {
    expect(isExpired(pendingSentAt(sentAt), shift(sentAt, 3 * DAY_MS - 1))).toBe(false);
  });

  it('is true for a pending request at or after expiresAt', () => {
    expect(isExpired(pendingSentAt(sentAt), shift(sentAt, 3 * DAY_MS))).toBe(true);
  });

  it('is true for a request already marked expired', () => {
    expect(isExpired(pendingSentAt(sentAt, { status: StudentFeedbackStatus.EXPIRED }), shift(sentAt, HOUR_MS))).toBe(true);
  });

  it('is false for an answered request, even after expiresAt', () => {
    expect(isExpired(pendingSentAt(sentAt, { status: StudentFeedbackStatus.ANSWERED }), shift(sentAt, 5 * DAY_MS))).toBe(false);
  });
});

describe('daysLeft', () => {
  const expiresAt = new Date('2026-11-11T12:00:00Z');

  it('counts started days until expiresAt', () => {
    expect(daysLeft(expiresAt, shift(expiresAt, -3 * DAY_MS))).toBe(3);
    expect(daysLeft(expiresAt, shift(expiresAt, -2 * DAY_MS - HOUR_MS))).toBe(3);
    expect(daysLeft(expiresAt, shift(expiresAt, -HOUR_MS))).toBe(1);
  });

  it('is zero at or after expiresAt', () => {
    expect(daysLeft(expiresAt, expiresAt)).toBe(0);
    expect(daysLeft(expiresAt, shift(expiresAt, DAY_MS))).toBe(0);
  });
});
