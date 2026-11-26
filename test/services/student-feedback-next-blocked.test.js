import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStudentHistory } from '../../src/services/student-feedback-trainer-service.js';
import { expireOverdueFeedbacks, sendDueFeedbacks } from '../../src/services/student-feedback-scheduler-service.js';
import { StudentFeedbackMilestone, StudentFeedbackStatus } from '../../src/constants/student-feedback.js';
import {
  OTHER_STUDENT_ID,
  OTHER_TRAINER_ID,
  STUDENT_ID,
  TRAINER_ID,
  createFeedbackWorld,
  seedConfig,
  seedLink,
  seedRequest,
} from '../helpers/student-feedback-world.js';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const TICK_MS = 15 * MINUTE_MS;
const REQUEST_MODEL = 'studentFeedbackRequest';
// Days after the link on which a milestone falls due inside the period the scenarios cover
const MILESTONE_DAYS = Object.freeze([7, 15, 21, 30, 60]);
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');

// 09:00 America/Sao_Paulo (12:00 UTC) of the day the given number of days after the link day
function nineAmOnDay(days) {
  return new Date(Date.UTC(2026, 10, 1 + days, 12, 0, 0));
}

// Three hours after the send hour of the day the given number of days after the link day
function afternoonOfDay(days) {
  return new Date(nineAmOnDay(days).getTime() + 3 * HOUR_MS);
}

// Instant shifted by a number of milliseconds
function shift(date, ms) {
  return new Date(date.getTime() + ms);
}

// Seeds the seven-day milestone as sent on time and expired without an answer
function seedExpiredD7(world) {
  return seedRequest(world, { milestone: StudentFeedbackMilestone.D7, dueAt: nineAmOnDay(7), sentAt: nineAmOnDay(7), status: StudentFeedbackStatus.EXPIRED });
}

// Seeds a pending ad-hoc request with the given send and expiry instants
function seedOpenAdhoc(world, { sentAt, expiresAt, ...overrides }) {
  return seedRequest(world, { milestone: StudentFeedbackMilestone.ADHOC, dueAt: null, sentAt, expiresAt, ...overrides });
}

// Seeds a pending milestone request sent on time on its day, open for the given number of days
function seedOpenMilestone(world, milestone, day, windowDays) {
  return seedRequest(world, { milestone, dueAt: nineAmOnDay(day), sentAt: nineAmOnDay(day), expiresAt: nineAmOnDay(day + windowDays) });
}

// The next automatic send the history of the fixture student reports
async function nextOf(world, now) {
  return (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, now)).autoSend.next;
}

// Instants at which the decision of the cron can change: every milestone day at the send hour and the expiry of every stored request
function cronEvents(world) {
  return [...MILESTONE_DAYS.map(nineAmOnDay), ...world.rows(REQUEST_MODEL).map((row) => row.expiresAt)];
}

// Ticks of the 15-minute cron worth running from the given instant: the first one, then the tick before, at and after every event, in order
function cronTicks(world, from) {
  const around = cronEvents(world).flatMap((event) => [shift(event, -TICK_MS), event, shift(event, TICK_MS)]);
  const times = [from, ...around].map((tick) => tick.getTime()).filter((time) => time >= from.getTime());
  return [...new Set(times)].sort((left, right) => left - right).map((time) => new Date(time));
}

// Runs the real cron, nobody answering, on every tick where its decision can change and returns the first request it creates for the fixture pair
async function firstCronSend(world, from) {
  const emailSender = { sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined), sendStudentFeedbackReminderEmail: vi.fn().mockResolvedValue(undefined) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const known = new Set(world.rows(REQUEST_MODEL));
  for (const now of cronTicks(world, from)) {
    await expireOverdueFeedbacks(world.prisma, now);
    await sendDueFeedbacks(world.prisma, emailSender, logger, now);
    const created = world.rows(REQUEST_MODEL).find((row) => !known.has(row));
    if (created) return created;
  }
  return null;
}

const CRON_SCENARIOS = Object.freeze([
  {
    label: 'no open request',
    now: afternoonOfDay(8),
    seed: (world) => seedExpiredD7(world),
    expected: { milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) },
  },
  {
    label: 'an open request that expires before the next milestone falls due',
    now: afternoonOfDay(8),
    seed: (world) => seedOpenMilestone(world, StudentFeedbackMilestone.D7, 7, 3),
    expected: { milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) },
  },
  {
    label: 'an open request that expires exactly when the next milestone falls due',
    now: afternoonOfDay(14),
    seed: (world) => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: nineAmOnDay(12), expiresAt: nineAmOnDay(15) });
    },
    expected: { milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) },
  },
  {
    label: 'a seven-day D15 still open when D21 falls due',
    now: afternoonOfDay(16),
    seed: (world) => seedOpenMilestone(world, StudentFeedbackMilestone.D15, 15, 7),
    expected: { milestone: StudentFeedbackMilestone.D21, dueAt: nineAmOnDay(22) },
  },
  {
    label: 'an ad-hoc request blocking a D15 that is already past due',
    now: afternoonOfDay(16),
    seed: (world) => seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(17) }),
    expected: { milestone: StudentFeedbackMilestone.D15, dueAt: afternoonOfDay(17) },
  },
  {
    label: 'an ad-hoc request open from before D15 until after D21 fell due',
    now: shift(afternoonOfDay(14), HOUR_MS),
    seed: (world) => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(21) });
    },
    expected: { milestone: StudentFeedbackMilestone.D21, dueAt: afternoonOfDay(21) },
  },
  {
    label: 'an ad-hoc request that expires exactly when D21 falls due',
    now: afternoonOfDay(14),
    seed: (world) => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: nineAmOnDay(14), expiresAt: nineAmOnDay(21) });
    },
    expected: { milestone: StudentFeedbackMilestone.D21, dueAt: nineAmOnDay(21) },
  },
  {
    label: 'an ad-hoc request that expires one tick before D21 falls due',
    now: afternoonOfDay(14),
    seed: (world) => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: shift(nineAmOnDay(14), -TICK_MS), expiresAt: shift(nineAmOnDay(21), -TICK_MS) });
    },
    expected: { milestone: StudentFeedbackMilestone.D15, dueAt: shift(nineAmOnDay(21), -TICK_MS) },
  },
  {
    label: 'an ad-hoc request open over D15 and D21 with D21 toggled off',
    now: shift(afternoonOfDay(14), HOUR_MS),
    config: { d21: false },
    seed: (world) => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(21) });
    },
    expected: { milestone: StudentFeedbackMilestone.D30, dueAt: nineAmOnDay(30) },
  },
  {
    label: 'an ad-hoc request blocking a D15 that fell due before auto-send was turned on',
    now: afternoonOfDay(16),
    config: { enabledAt: afternoonOfDay(15) },
    seed: (world) => seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(17) }),
    expected: { milestone: StudentFeedbackMilestone.D21, dueAt: nineAmOnDay(21) },
  },
]);

describe('student feedback history: next automatic send while a request is open', () => {
  let world;

  beforeEach(() => {
    world = createFeedbackWorld();
    seedLink(world, { createdAt: LINKED_AT });
  });

  describe('open request that does not reach the next milestone', () => {
    beforeEach(() => {
      seedConfig(world);
    });

    it('keeps the next milestone when the open request expires before it falls due', async () => {
      seedOpenMilestone(world, StudentFeedbackMilestone.D7, 7, 3);

      expect(await nextOf(world, afternoonOfDay(8))).toEqual({ milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) });
    });

    it('keeps the next milestone on time when the open request expires at the very instant it falls due', async () => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: nineAmOnDay(12), expiresAt: nineAmOnDay(15) });

      expect(await nextOf(world, afternoonOfDay(14))).toEqual({ milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) });
    });
  });

  describe('milestone named while an open request blocks the cron', () => {
    beforeEach(() => {
      seedConfig(world);
    });

    it('names the blocked milestone that is already past due, which the cron sends as soon as the open request expires', async () => {
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(17) });

      const next = await nextOf(world, afternoonOfDay(16));

      expect(next.milestone).toBe(StudentFeedbackMilestone.D15);
    });

    it('names the latest milestone reached when the open request expires, not the earlier one it blocked for good', async () => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(21) });

      const next = await nextOf(world, shift(afternoonOfDay(14), HOUR_MS));

      expect(next.milestone).toBe(StudentFeedbackMilestone.D21);
    });

    it('names D21, sent late, when a seven-day D15 is still open on the day D21 falls due', async () => {
      seedOpenMilestone(world, StudentFeedbackMilestone.D15, 15, 7);

      const next = await nextOf(world, afternoonOfDay(16));

      expect(next.milestone).toBe(StudentFeedbackMilestone.D21);
    });

    it('still names the blocked milestone when the open request expires one tick before the following one falls due', async () => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: shift(nineAmOnDay(14), -TICK_MS), expiresAt: shift(nineAmOnDay(21), -TICK_MS) });

      const next = await nextOf(world, afternoonOfDay(14));

      expect(next.milestone).toBe(StudentFeedbackMilestone.D15);
    });

    it('names the following milestone, on time, when the open request expires at the very instant that one falls due', async () => {
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: nineAmOnDay(14), expiresAt: nineAmOnDay(21) });

      expect(await nextOf(world, afternoonOfDay(14))).toEqual({ milestone: StudentFeedbackMilestone.D21, dueAt: nineAmOnDay(21) });
    });

    it('does not name again a milestone that was already sent', async () => {
      seedOpenMilestone(world, StudentFeedbackMilestone.D7, 7, 7);

      expect(await nextOf(world, afternoonOfDay(8))).toEqual({ milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) });
    });
  });

  describe('milestones the cron will not send once the open request expires', () => {
    it('skips a milestone toggled off that is the latest one reached when the open request expires', async () => {
      seedConfig(world, { d21: false });
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(21) });

      expect(await nextOf(world, shift(afternoonOfDay(14), HOUR_MS))).toEqual({ milestone: StudentFeedbackMilestone.D30, dueAt: nineAmOnDay(30) });
    });

    it('skips a blocked milestone that fell due before auto-send was turned on', async () => {
      seedConfig(world, { enabledAt: afternoonOfDay(15) });
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(17) });

      expect(await nextOf(world, afternoonOfDay(16))).toEqual({ milestone: StudentFeedbackMilestone.D21, dueAt: nineAmOnDay(21) });
    });

    it('has no next send when nothing enabled remains after the open request expires', async () => {
      seedConfig(world, { d21: false, d30: false, recurring: false });
      seedExpiredD7(world);
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(21) });

      expect(await nextOf(world, shift(afternoonOfDay(14), HOUR_MS))).toBeNull();
    });
  });

  describe('date of a send that the open request delays', () => {
    beforeEach(() => {
      seedConfig(world);
    });

    it('is the instant the open request expires for a blocked milestone that is already past due', async () => {
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(17) });

      expect(await nextOf(world, afternoonOfDay(16))).toEqual({ milestone: StudentFeedbackMilestone.D15, dueAt: afternoonOfDay(17) });
    });

    it('is the instant the open request expires for a milestone that falls due while the request is still open', async () => {
      seedOpenMilestone(world, StudentFeedbackMilestone.D15, 15, 7);

      expect(await nextOf(world, afternoonOfDay(16))).toEqual({ milestone: StudentFeedbackMilestone.D21, dueAt: nineAmOnDay(22) });
    });

    it('is returned as a Date', async () => {
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(17) });

      const next = await nextOf(world, afternoonOfDay(16));

      expect(next.dueAt).toBeInstanceOf(Date);
    });
  });

  describe('requests that do not block the cron', () => {
    const NOW = shift(afternoonOfDay(14), HOUR_MS);
    const UNBLOCKED_NEXT = Object.freeze({ milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) });

    beforeEach(() => {
      seedConfig(world);
      seedExpiredD7(world);
    });

    it('ignores a request the student already answered, even with its window still running', async () => {
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(21), status: StudentFeedbackStatus.ANSWERED, submittedAt: NOW });

      expect(await nextOf(world, NOW)).toEqual(UNBLOCKED_NEXT);
    });

    it('ignores the open request another trainer sent to the student', async () => {
      seedOpenAdhoc(world, { trainerId: OTHER_TRAINER_ID, sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(21) });

      expect(await nextOf(world, NOW)).toEqual(UNBLOCKED_NEXT);
    });

    it('ignores the open request of another student of the trainer', async () => {
      seedLink(world, { studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });
      seedOpenAdhoc(world, { studentId: OTHER_STUDENT_ID, sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(21) });

      expect(await nextOf(world, NOW)).toEqual(UNBLOCKED_NEXT);
    });
  });

  describe('agreement with the cron', () => {
    it.each(CRON_SCENARIOS)('names the milestone and the instant of the first send the cron really makes, with $label', async ({ now, config, seed, expected }) => {
      seedConfig(world, config);
      seed(world);

      const next = await nextOf(world, now);
      const sent = await firstCronSend(world, now);

      expect({ milestone: sent.milestone, dueAt: sent.sentAt }).toEqual(expected);
      expect(next).toEqual(expected);
    });
  });

  describe('auto-send on without an enabledAt stamp', () => {
    it('has no next send, since the cron never sends for such a config', async () => {
      seedConfig(world, { enabledAt: null });

      const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, afternoonOfDay(8));

      expect(history.autoSend.next).toBeNull();
    });

    it('has no next send with an open request either', async () => {
      seedConfig(world, { enabledAt: null });
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(17) });

      expect(await nextOf(world, afternoonOfDay(16))).toBeNull();
    });

    it('agrees with the cron, which creates nothing', async () => {
      seedConfig(world, { enabledAt: null });

      expect(await firstCronSend(world, afternoonOfDay(8))).toBeNull();
    });
  });

  describe('student blocked on the plan', () => {
    it('has no next send even while an open request would delay one', async () => {
      world.rows('trainerStudent')[0].activeOnPlan = false;
      seedConfig(world);
      seedOpenAdhoc(world, { sentAt: afternoonOfDay(14), expiresAt: afternoonOfDay(17) });

      expect(await nextOf(world, afternoonOfDay(16))).toBeNull();
    });
  });
});
