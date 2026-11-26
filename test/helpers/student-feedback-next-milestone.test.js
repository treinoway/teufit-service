import { describe, expect, it } from 'vitest';
import { nextMilestone, nextMilestoneAt } from '../../src/helpers/student-feedback-schedule.js';
import { StudentFeedbackMilestone } from '../../src/constants/student-feedback.js';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
const ENABLED_LONG_AGO = new Date('2026-01-01T00:00:00Z');
const ALL_ON = Object.freeze({ autoSendEnabled: true, enabledAt: ENABLED_LONG_AGO, d7: true, d15: true, d21: true, d30: true, recurring: true });
const ALL_OFF = Object.freeze({ ...ALL_ON, d7: false, d15: false, d21: false, d30: false, recurring: false });
const ONLY_RECURRING = Object.freeze({ ...ALL_OFF, recurring: true });
const CONFIGS_TO_COMPARE = Object.freeze([
  ['every milestone on', ALL_ON],
  ['d15 and d21 off', { ...ALL_ON, d15: false, d21: false }],
  ['only the recurring one on', ONLY_RECURRING],
  ['the recurring one off', { ...ALL_ON, recurring: false }],
  ['every milestone off', ALL_OFF],
  ['auto-send off', { ...ALL_ON, autoSendEnabled: false }],
]);
const DAYS_TO_COMPARE = Object.freeze([0, 6, 7, 14, 15, 20, 21, 29, 30, 31, 59, 60, 61, 89, 90, 119]);

// 09:00 America/Sao_Paulo (12:00 UTC) of the day the given number of days after the link day
function nineAmOnDay(days) {
  return new Date(Date.UTC(2026, 10, 1 + days, 12, 0, 0));
}

// Instant shifted by a number of milliseconds
function shift(date, ms) {
  return new Date(date.getTime() + ms);
}

describe('nextMilestone', () => {
  describe('fixed milestones', () => {
    it.each([
      [0, StudentFeedbackMilestone.D7, 7],
      [8, StudentFeedbackMilestone.D15, 15],
      [16, StudentFeedbackMilestone.D21, 21],
      [22, StudentFeedbackMilestone.D30, 30],
    ])('returns, on day %i, the %s milestone with its due instant', (day, milestone, dueDay) => {
      const next = nextMilestone({ linkedAt: LINKED_AT, config: ALL_ON, after: nineAmOnDay(day) });

      expect(next).toEqual({ milestone, dueAt: nineAmOnDay(dueDay) });
    });

    it('returns the due instant as a Date', () => {
      const next = nextMilestone({ linkedAt: LINKED_AT, config: ALL_ON, after: nineAmOnDay(8) });

      expect(next.dueAt).toBeInstanceOf(Date);
    });

    it('still returns the milestone of the day one minute before its send hour', () => {
      const after = shift(nineAmOnDay(7), -MINUTE_MS);

      expect(nextMilestone({ linkedAt: LINKED_AT, config: ALL_ON, after })).toEqual({ milestone: StudentFeedbackMilestone.D7, dueAt: nineAmOnDay(7) });
    });

    it('moves on to the following milestone at the very instant one falls due', () => {
      const next = nextMilestone({ linkedAt: LINKED_AT, config: ALL_ON, after: nineAmOnDay(7) });

      expect(next).toEqual({ milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) });
    });

    it('counts the days from the civil date of the link in Sao Paulo, not in UTC', () => {
      const lateEveningInSaoPaulo = new Date('2026-11-02T01:30:00Z');

      const next = nextMilestone({ linkedAt: lateEveningInSaoPaulo, config: ALL_ON, after: shift(lateEveningInSaoPaulo, HOUR_MS) });

      expect(next).toEqual({ milestone: StudentFeedbackMilestone.D7, dueAt: nineAmOnDay(7) });
    });
  });

  describe('toggles', () => {
    it('skips the fixed milestones that are toggled off', () => {
      const config = { ...ALL_ON, d15: false, d21: false };

      const next = nextMilestone({ linkedAt: LINKED_AT, config, after: nineAmOnDay(8) });

      expect(next).toEqual({ milestone: StudentFeedbackMilestone.D30, dueAt: nineAmOnDay(30) });
    });

    it('skips a toggled-off first milestone', () => {
      const config = { ...ALL_ON, d7: false };

      const next = nextMilestone({ linkedAt: LINKED_AT, config, after: nineAmOnDay(1) });

      expect(next).toEqual({ milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) });
    });

    it('falls through to the first recurring milestone, on day 60, when no fixed one is enabled', () => {
      const next = nextMilestone({ linkedAt: LINKED_AT, config: ONLY_RECURRING, after: nineAmOnDay(8) });

      expect(next).toEqual({ milestone: StudentFeedbackMilestone.RECURRING, dueAt: nineAmOnDay(60) });
    });

    it('falls through to the recurring milestone when the remaining fixed ones are off', () => {
      const config = { ...ALL_ON, d21: false, d30: false };

      const next = nextMilestone({ linkedAt: LINKED_AT, config, after: nineAmOnDay(16) });

      expect(next).toEqual({ milestone: StudentFeedbackMilestone.RECURRING, dueAt: nineAmOnDay(60) });
    });
  });

  describe('recurring milestone', () => {
    it.each([
      [31, 60],
      [59, 60],
      [60, 90],
      [61, 90],
      [125, 150],
    ])('returns, on day %i, the recurring milestone due on day %i', (day, dueDay) => {
      const next = nextMilestone({ linkedAt: LINKED_AT, config: ALL_ON, after: nineAmOnDay(day) });

      expect(next).toEqual({ milestone: StudentFeedbackMilestone.RECURRING, dueAt: nineAmOnDay(dueDay) });
    });

    it('names day 30 itself D30, not the recurring one', () => {
      const next = nextMilestone({ linkedAt: LINKED_AT, config: ALL_ON, after: nineAmOnDay(29) });

      expect(next.milestone).toBe(StudentFeedbackMilestone.D30);
    });
  });

  describe('nothing left to send', () => {
    it('returns null when auto-send is off', () => {
      const config = { ...ALL_ON, autoSendEnabled: false };

      expect(nextMilestone({ linkedAt: LINKED_AT, config, after: nineAmOnDay(8) })).toBeNull();
    });

    it('returns null when there is no config', () => {
      expect(nextMilestone({ linkedAt: LINKED_AT, config: null, after: nineAmOnDay(8) })).toBeNull();
    });

    it('returns null when every milestone is toggled off', () => {
      expect(nextMilestone({ linkedAt: LINKED_AT, config: ALL_OFF, after: nineAmOnDay(1) })).toBeNull();
    });

    it('returns null after day 30 when the recurring toggle is off', () => {
      const config = { ...ALL_ON, recurring: false };

      expect(nextMilestone({ linkedAt: LINKED_AT, config, after: nineAmOnDay(31) })).toBeNull();
    });

    it('returns null when the remaining fixed milestones and the recurring one are off', () => {
      const config = { ...ALL_ON, d21: false, d30: false, recurring: false };

      expect(nextMilestone({ linkedAt: LINKED_AT, config, after: nineAmOnDay(16) })).toBeNull();
    });
  });

  describe('agreement with nextMilestoneAt', () => {
    it.each(CONFIGS_TO_COMPARE)('falls due exactly when nextMilestoneAt says, with %s', (_label, config) => {
      for (const day of DAYS_TO_COMPARE) {
        const input = { linkedAt: LINKED_AT, config, after: shift(nineAmOnDay(day), HOUR_MS) };

        expect(nextMilestone(input)?.dueAt ?? null).toEqual(nextMilestoneAt(input));
      }
    });
  });
});
