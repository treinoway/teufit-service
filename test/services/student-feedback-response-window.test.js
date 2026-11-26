import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, updateConfig } from '../../src/services/student-feedback-config-service.js';
import { expireOverdueFeedbacks, sendDueFeedbacks, sendDueReminders } from '../../src/services/student-feedback-scheduler-service.js';
import { sendAdhocFeedback } from '../../src/services/student-feedback-trainer-service.js';
import {
  RESPONSE_WINDOW_DAYS,
  RESPONSE_WINDOW_MAX_DAYS,
  RESPONSE_WINDOW_MIN_DAYS,
  StudentFeedbackMilestone,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
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
const DAY_MS = 24 * HOUR_MS;
const TICK_MS = 15 * MINUTE_MS;
const CONFIG_MODEL = 'studentFeedbackConfig';
const REQUEST_MODEL = 'studentFeedbackRequest';
const STUDENT_EMAIL = `${STUDENT_ID}@example.com`;
const CHOSEN_WINDOW_DAYS = 5;
const SHORTER_WINDOW_DAYS = 2;
const ONE_DAY_WINDOW = 1;
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// 09:00 America/Sao_Paulo seven days after the link
const D7_DUE = new Date('2026-11-08T12:00:00Z');
const ADHOC_AT = new Date('2026-11-12T18:00:00Z');
const ENABLED_BEFORE = new Date('2026-10-01T12:00:00Z');
const NOW = new Date('2026-11-17T15:00:00Z');
const DEFAULT_SWITCHES = Object.freeze({ autoSendEnabled: false, d7: true, d15: true, d21: true, d30: true, recurring: true });

// Instant shifted by a number of milliseconds
function shift(date, ms) {
  return new Date(date.getTime() + ms);
}

// Stored config row of a trainer
function storedConfig(world, trainerId = TRAINER_ID) {
  return world.rows(CONFIG_MODEL).find((row) => row.trainerId === trainerId);
}

// Stored requests of a student, in creation order
function requestsOf(world, studentId = STUDENT_ID) {
  return world.rows(REQUEST_MODEL).filter((row) => row.studentId === studentId);
}

// E-mail sender whose two feedback senders only record their calls
function createEmailSender() {
  return {
    sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined),
    sendStudentFeedbackReminderEmail: vi.fn().mockResolvedValue(undefined),
  };
}

// Runs the cron steps, in the order of the real tick, at one instant
async function runTick(world, emailSender, logger, now) {
  await expireOverdueFeedbacks(world.prisma, now);
  await sendDueFeedbacks(world.prisma, emailSender, logger, now);
  await sendDueReminders(world.prisma, emailSender, logger, now);
}

// Sends the seven-day milestone on time, then runs every 15-minute tick from 23 to 25 hours after the send
async function sendAndTickAroundReminder(world, emailSender, logger) {
  await runTick(world, emailSender, logger, D7_DUE);
  for (let now = shift(D7_DUE, 23 * HOUR_MS); now <= shift(D7_DUE, 25 * HOUR_MS); now = shift(now, TICK_MS)) {
    await runTick(world, emailSender, logger, now);
  }
}

describe('student feedback response window', () => {
  let world;
  let emailSender;
  let logger;

  beforeEach(() => {
    world = createFeedbackWorld();
    emailSender = createEmailSender();
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  describe('getConfig', () => {
    it('reports the default window for a trainer that never saved', async () => {
      const config = await getConfig(world.prisma, TRAINER_ID);

      expect(config.responseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
    });

    it('returns the defaults plus the default window, and nothing else, for a trainer that never saved', async () => {
      expect(await getConfig(world.prisma, TRAINER_ID)).toEqual({ ...DEFAULT_SWITCHES, responseWindowDays: RESPONSE_WINDOW_DAYS });
    });

    it('reports the default window for a stored row that predates the column', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE });

      const config = await getConfig(world.prisma, TRAINER_ID);

      expect(config.responseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
    });

    it('reports the default window for a stored row whose window is null', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE, responseWindowDays: null });

      const config = await getConfig(world.prisma, TRAINER_ID);

      expect(config.responseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
    });

    it('reports the stored window', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE, responseWindowDays: CHOSEN_WINDOW_DAYS });

      const config = await getConfig(world.prisma, TRAINER_ID);

      expect(config.responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
    });

    it('does not report the window of another trainer', async () => {
      seedConfig(world, { trainerId: OTHER_TRAINER_ID, responseWindowDays: CHOSEN_WINDOW_DAYS });

      const config = await getConfig(world.prisma, TRAINER_ID);

      expect(config.responseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
    });
  });

  describe('updateConfig', () => {
    it('stores the window on the first save and returns the full config', async () => {
      const config = await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: CHOSEN_WINDOW_DAYS }, NOW);

      expect(config).toEqual({ ...DEFAULT_SWITCHES, responseWindowDays: CHOSEN_WINDOW_DAYS });
      expect(storedConfig(world)).toMatchObject({ trainerId: TRAINER_ID, responseWindowDays: CHOSEN_WINDOW_DAYS });
    });

    it('reports the saved window on the next read', async () => {
      await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: CHOSEN_WINDOW_DAYS }, NOW);

      const config = await getConfig(world.prisma, TRAINER_ID);

      expect(config.responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
    });

    it.each([RESPONSE_WINDOW_MIN_DAYS, RESPONSE_WINDOW_DAYS, RESPONSE_WINDOW_MAX_DAYS])('stores a window of %i day(s)', async (days) => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE, responseWindowDays: CHOSEN_WINDOW_DAYS });

      const config = await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: days }, NOW);

      expect(config.responseWindowDays).toBe(days);
      expect(storedConfig(world).responseWindowDays).toBe(days);
    });

    it('keeps the stored window when the body leaves it out', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE, responseWindowDays: CHOSEN_WINDOW_DAYS });

      const config = await updateConfig(world.prisma, TRAINER_ID, { d21: false }, NOW);

      expect(config).toEqual({ autoSendEnabled: true, d7: true, d15: true, d21: false, d30: true, recurring: true, responseWindowDays: CHOSEN_WINDOW_DAYS });
      expect(storedConfig(world).responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
    });

    it('keeps the stored window with an empty body', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE, responseWindowDays: CHOSEN_WINDOW_DAYS });

      const config = await updateConfig(world.prisma, TRAINER_ID, {}, NOW);

      expect(config.responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
      expect(storedConfig(world).responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
    });

    it('reports the default window after a save that leaves it out on a row that predates the column', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE });

      const config = await updateConfig(world.prisma, TRAINER_ID, { d7: false }, NOW);

      expect(config.responseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
    });

    it('changes only the window when only the window is sent', async () => {
      seedConfig(world, { d15: false, recurring: false, enabledAt: ENABLED_BEFORE });

      const config = await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: CHOSEN_WINDOW_DAYS }, NOW);

      expect(config).toEqual({ autoSendEnabled: true, d7: true, d15: false, d21: true, d30: true, recurring: false, responseWindowDays: CHOSEN_WINDOW_DAYS });
    });

    it('does not stamp a new enabledAt when only the window changes', async () => {
      seedConfig(world, { enabledAt: ENABLED_BEFORE });

      await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: CHOSEN_WINDOW_DAYS }, NOW);

      expect(storedConfig(world).enabledAt).toEqual(ENABLED_BEFORE);
    });

    it('accepts the window together with the switches', async () => {
      const input = { autoSendEnabled: true, d7: false, d15: false, d21: false, d30: false, recurring: false, responseWindowDays: RESPONSE_WINDOW_MAX_DAYS };

      expect(await updateConfig(world.prisma, TRAINER_ID, input, NOW)).toEqual(input);
    });

    it('keeps one row per trainer across saves of the window', async () => {
      await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: CHOSEN_WINDOW_DAYS }, NOW);
      await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: SHORTER_WINDOW_DAYS }, shift(NOW, DAY_MS));

      expect(world.rows(CONFIG_MODEL)).toHaveLength(1);
      expect(storedConfig(world).responseWindowDays).toBe(SHORTER_WINDOW_DAYS);
    });

    it('does not touch the window of another trainer', async () => {
      seedConfig(world, { trainerId: OTHER_TRAINER_ID, enabledAt: ENABLED_BEFORE, responseWindowDays: CHOSEN_WINDOW_DAYS });

      await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: SHORTER_WINDOW_DAYS }, NOW);

      expect(storedConfig(world, OTHER_TRAINER_ID).responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
    });
  });

  describe('automatic send (cron)', () => {
    beforeEach(() => {
      seedLink(world, { createdAt: LINKED_AT });
    });

    it.each([RESPONSE_WINDOW_MIN_DAYS, CHOSEN_WINDOW_DAYS, RESPONSE_WINDOW_MAX_DAYS])('expires the request %i day(s) after it was sent, the window of the trainer', async (days) => {
      seedConfig(world, { responseWindowDays: days });

      await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

      expect(requestsOf(world)).toHaveLength(1);
      expect(requestsOf(world)[0]).toMatchObject({ milestone: StudentFeedbackMilestone.D7, sentAt: D7_DUE, expiresAt: shift(D7_DUE, days * DAY_MS) });
    });

    it('counts the window from the instant of the send, not from the due instant of the milestone', async () => {
      seedConfig(world, { responseWindowDays: CHOSEN_WINDOW_DAYS });
      const lateTick = shift(D7_DUE, 3 * TICK_MS);

      await sendDueFeedbacks(world.prisma, emailSender, logger, lateTick);

      expect(requestsOf(world)[0]).toMatchObject({ dueAt: D7_DUE, sentAt: lateTick, expiresAt: shift(lateTick, CHOSEN_WINDOW_DAYS * DAY_MS) });
    });

    it('uses the default window for a config row that predates the column', async () => {
      seedConfig(world);

      await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

      expect(requestsOf(world)[0].expiresAt).toEqual(shift(D7_DUE, RESPONSE_WINDOW_DAYS * DAY_MS));
    });

    it('uses the window of each trainer when two trainers are due in the same run', async () => {
      seedConfig(world, { responseWindowDays: CHOSEN_WINDOW_DAYS });
      seedConfig(world, { trainerId: OTHER_TRAINER_ID, responseWindowDays: SHORTER_WINDOW_DAYS });
      seedLink(world, { trainerId: OTHER_TRAINER_ID, studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });

      await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

      expect(requestsOf(world)[0].expiresAt).toEqual(shift(D7_DUE, CHOSEN_WINDOW_DAYS * DAY_MS));
      expect(requestsOf(world, OTHER_STUDENT_ID)[0].expiresAt).toEqual(shift(D7_DUE, SHORTER_WINDOW_DAYS * DAY_MS));
    });

    it('tells the request e-mail the window of the trainer', async () => {
      seedConfig(world, { responseWindowDays: CHOSEN_WINDOW_DAYS });

      await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: STUDENT_EMAIL, responseWindowDays: CHOSEN_WINDOW_DAYS, expiresAt: shift(D7_DUE, CHOSEN_WINDOW_DAYS * DAY_MS) }),
      );
    });

    it('tells the request e-mail the default window for a config row that predates the column', async () => {
      seedConfig(world);

      await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ to: STUDENT_EMAIL, responseWindowDays: RESPONSE_WINDOW_DAYS }));
    });

    it('keeps the deadline of a request already sent when the trainer changes the window, and uses the new one from the next send on', async () => {
      seedConfig(world, { responseWindowDays: CHOSEN_WINDOW_DAYS });
      await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);
      const sentBefore = requestsOf(world)[0];

      await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: SHORTER_WINDOW_DAYS }, shift(D7_DUE, HOUR_MS));
      sentBefore.status = StudentFeedbackStatus.ANSWERED;
      const d15Due = shift(D7_DUE, 8 * DAY_MS);
      await sendDueFeedbacks(world.prisma, emailSender, logger, d15Due);

      expect(requestsOf(world).map((row) => row.expiresAt)).toEqual([shift(D7_DUE, CHOSEN_WINDOW_DAYS * DAY_MS), shift(d15Due, SHORTER_WINDOW_DAYS * DAY_MS)]);
    });
  });

  describe('reminder', () => {
    beforeEach(() => {
      seedLink(world, { createdAt: LINKED_AT });
    });

    it('is never sent for a request with a one-day window: it expires at the instant the reminder would go out', async () => {
      seedConfig(world, { responseWindowDays: ONE_DAY_WINDOW });

      await sendAndTickAroundReminder(world, emailSender, logger);

      expect(requestsOf(world)).toHaveLength(1);
      expect(requestsOf(world)[0]).toMatchObject({ status: StudentFeedbackStatus.EXPIRED, expiresAt: shift(D7_DUE, DAY_MS) });
      expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
    });

    it('is sent once, 24 hours after the send, for a request with a two-day window', async () => {
      seedConfig(world, { responseWindowDays: SHORTER_WINDOW_DAYS });

      await sendAndTickAroundReminder(world, emailSender, logger);

      expect(emailSender.sendStudentFeedbackReminderEmail).toHaveBeenCalledTimes(1);
      expect(requestsOf(world)[0].reminderSentAt).toEqual(shift(D7_DUE, DAY_MS));
    });

    it('is still sent only once, 24 hours after the send, for a request with the longest window', async () => {
      seedConfig(world, { responseWindowDays: RESPONSE_WINDOW_MAX_DAYS });

      await sendAndTickAroundReminder(world, emailSender, logger);

      expect(emailSender.sendStudentFeedbackReminderEmail).toHaveBeenCalledTimes(1);
      expect(requestsOf(world)[0]).toMatchObject({ status: StudentFeedbackStatus.PENDING, reminderSentAt: shift(D7_DUE, DAY_MS) });
    });
  });

  describe('ad-hoc send', () => {
    beforeEach(() => {
      seedLink(world, { createdAt: LINKED_AT });
    });

    it.each([RESPONSE_WINDOW_MIN_DAYS, CHOSEN_WINDOW_DAYS, RESPONSE_WINDOW_MAX_DAYS])('expires the request %i day(s) after it was sent, the window of the trainer', async (days) => {
      seedConfig(world, { autoSendEnabled: false, enabledAt: null, responseWindowDays: days });

      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, ADHOC_AT);

      expect(requestsOf(world)).toHaveLength(1);
      expect(requestsOf(world)[0]).toMatchObject({ milestone: StudentFeedbackMilestone.ADHOC, sentAt: ADHOC_AT, expiresAt: shift(ADHOC_AT, days * DAY_MS) });
    });

    it('returns the deadline of the window of the trainer', async () => {
      seedConfig(world, { autoSendEnabled: false, enabledAt: null, responseWindowDays: CHOSEN_WINDOW_DAYS });

      const result = await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, ADHOC_AT);

      expect(result).toMatchObject({ sentAt: ADHOC_AT, expiresAt: shift(ADHOC_AT, CHOSEN_WINDOW_DAYS * DAY_MS) });
    });

    it('uses the default window for a trainer that never saved a config', async () => {
      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, ADHOC_AT);

      expect(requestsOf(world)[0].expiresAt).toEqual(shift(ADHOC_AT, RESPONSE_WINDOW_DAYS * DAY_MS));
    });

    it('uses the default window for a config row that predates the column', async () => {
      seedConfig(world);

      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, ADHOC_AT);

      expect(requestsOf(world)[0].expiresAt).toEqual(shift(ADHOC_AT, RESPONSE_WINDOW_DAYS * DAY_MS));
    });

    it('ignores the window of another trainer', async () => {
      seedConfig(world, { trainerId: OTHER_TRAINER_ID, responseWindowDays: CHOSEN_WINDOW_DAYS });

      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, ADHOC_AT);

      expect(requestsOf(world)[0].expiresAt).toEqual(shift(ADHOC_AT, RESPONSE_WINDOW_DAYS * DAY_MS));
    });

    it('tells the request e-mail the window of the trainer', async () => {
      seedConfig(world, { autoSendEnabled: false, enabledAt: null, responseWindowDays: CHOSEN_WINDOW_DAYS });

      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, ADHOC_AT);

      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: STUDENT_EMAIL, responseWindowDays: CHOSEN_WINDOW_DAYS, expiresAt: shift(ADHOC_AT, CHOSEN_WINDOW_DAYS * DAY_MS) }),
      );
    });

    it('tells the request e-mail the default window for a trainer that never saved a config', async () => {
      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, ADHOC_AT);

      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ to: STUDENT_EMAIL, responseWindowDays: RESPONSE_WINDOW_DAYS }));
    });

    it('keeps the deadline of a request already sent when the trainer changes the window, and uses the new one from the next send on', async () => {
      seedConfig(world, { autoSendEnabled: false, enabledAt: null, responseWindowDays: CHOSEN_WINDOW_DAYS });
      const sentBefore = seedRequest(world, { milestone: StudentFeedbackMilestone.ADHOC, sentAt: D7_DUE, expiresAt: shift(D7_DUE, CHOSEN_WINDOW_DAYS * DAY_MS), status: StudentFeedbackStatus.ANSWERED });

      await updateConfig(world.prisma, TRAINER_ID, { responseWindowDays: SHORTER_WINDOW_DAYS }, shift(D7_DUE, HOUR_MS));
      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, ADHOC_AT);

      expect(sentBefore.expiresAt).toEqual(shift(D7_DUE, CHOSEN_WINDOW_DAYS * DAY_MS));
      expect(requestsOf(world)[1].expiresAt).toEqual(shift(ADHOC_AT, SHORTER_WINDOW_DAYS * DAY_MS));
    });
  });
});
