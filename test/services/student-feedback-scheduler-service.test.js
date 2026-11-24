import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expireOverdueFeedbacks,
  sendDueFeedbacks,
  sendDueReminders,
} from '../../src/services/student-feedback-scheduler-service.js';
import { StudentFeedbackMilestone, StudentFeedbackStatus } from '../../src/constants/student-feedback.js';
import {
  OTHER_STUDENT_ID,
  OTHER_TRAINER_ID,
  STUDENT_ID,
  TEMPLATE_ID,
  TRAINER_ID,
  createFeedbackWorld,
  seedConfig,
  seedLink,
  seedPublishedMealPlan,
  seedRequest,
} from '../helpers/student-feedback-world.js';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const REQUEST_MODEL = 'studentFeedbackRequest';
const STUDENT_EMAIL = `${STUDENT_ID}@example.com`;
const OTHER_STUDENT_EMAIL = `${OTHER_STUDENT_ID}@example.com`;
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// 09:00 America/Sao_Paulo seven days after the link
const D7_DUE = new Date('2026-11-08T12:00:00Z');
const D15_DUE = new Date('2026-11-16T12:00:00Z');

// Instant shifted by a number of milliseconds
function shift(date, ms) {
  return new Date(date.getTime() + ms);
}

describe('student feedback scheduler', () => {
  let world;
  let emailSender;
  let logger;

  beforeEach(() => {
    world = createFeedbackWorld();
    emailSender = {
      sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendStudentFeedbackReminderEmail: vi.fn().mockResolvedValue(undefined),
    };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  describe('sendDueFeedbacks', () => {
    describe('with auto-send on and an active student linked seven days ago', () => {
      beforeEach(() => {
        seedConfig(world);
        seedLink(world, { createdAt: LINKED_AT });
      });

      it('creates one pending request for the milestone, expiring three days after it was sent', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
        expect(world.rows(REQUEST_MODEL)[0]).toMatchObject({
          trainerId: TRAINER_ID,
          studentId: STUDENT_ID,
          templateId: TEMPLATE_ID,
          milestone: StudentFeedbackMilestone.D7,
          status: StudentFeedbackStatus.PENDING,
          sentAt: D7_DUE,
          expiresAt: shift(D7_DUE, 3 * DAY_MS),
        });
      });

      it('sends the request e-mail to the student', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
        expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ to: STUDENT_EMAIL }));
        expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
      });

      it('creates nothing and sends nothing on a second tick', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);
        await sendDueFeedbacks(world.prisma, emailSender, logger, shift(D7_DUE, 15 * MINUTE_MS));

        expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
        expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
      });

      it('does not send the same milestone again after the request expired', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);
        world.rows(REQUEST_MODEL)[0].status = StudentFeedbackStatus.EXPIRED;

        await sendDueFeedbacks(world.prisma, emailSender, logger, shift(D7_DUE, 4 * DAY_MS));

        expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
        expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
      });

      it('creates nothing before 09:00 America/Sao_Paulo of the milestone day', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, shift(D7_DUE, -15 * MINUTE_MS));

        expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
        expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
      });

      it('creates the request on a tick later the same day', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, shift(D7_DUE, 45 * MINUTE_MS));

        expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
        expect(world.rows(REQUEST_MODEL)[0].milestone).toBe(StudentFeedbackMilestone.D7);
      });

      it('creates the next milestone as a separate request', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);
        world.rows(REQUEST_MODEL)[0].status = StudentFeedbackStatus.EXPIRED;

        await sendDueFeedbacks(world.prisma, emailSender, logger, D15_DUE);

        expect(world.rows(REQUEST_MODEL).map((row) => row.milestone)).toEqual([StudentFeedbackMilestone.D7, StudentFeedbackMilestone.D15]);
        expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(2);
      });

      it('creates a recurring request sixty days after the link', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, new Date('2026-12-31T12:00:00Z'));

        expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
        expect(world.rows(REQUEST_MODEL)[0].milestone).toBe(StudentFeedbackMilestone.RECURRING);
      });

      it('leaves the students of a trainer without auto-send alone', async () => {
        seedLink(world, { trainerId: OTHER_TRAINER_ID, studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL).map((row) => row.studentId)).toEqual([STUDENT_ID]);
      });

      it('still creates the requests of the other students when one e-mail fails', async () => {
        seedLink(world, { studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });
        emailSender.sendStudentFeedbackRequestEmail.mockRejectedValueOnce(new TypeError('resend down'));

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL).map((row) => row.studentId).sort()).toEqual([STUDENT_ID, OTHER_STUDENT_ID].sort());
        expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ to: OTHER_STUDENT_EMAIL }));
      });
    });

    describe('when nothing must be sent', () => {
      it('creates nothing when the trainer has no config', async () => {
        seedLink(world, { createdAt: LINKED_AT });

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
      });

      it('creates nothing when auto-send is off', async () => {
        seedConfig(world, { autoSendEnabled: false, enabledAt: null });
        seedLink(world, { createdAt: LINKED_AT });

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
        expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
      });

      it('creates nothing when the milestone is toggled off', async () => {
        seedConfig(world, { d7: false });
        seedLink(world, { createdAt: LINKED_AT });

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
        expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
      });

      it('creates nothing for a student who is not active on plan', async () => {
        seedConfig(world);
        seedLink(world, { createdAt: LINKED_AT, activeOnPlan: false });

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
        expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
      });

      it('never sends a milestone that fell due before auto-send was turned on', async () => {
        seedConfig(world, { enabledAt: shift(D7_DUE, HOUR_MS) });
        seedLink(world, { createdAt: LINKED_AT });

        await sendDueFeedbacks(world.prisma, emailSender, logger, shift(D7_DUE, 2 * HOUR_MS));
        await sendDueFeedbacks(world.prisma, emailSender, logger, shift(D7_DUE, 2 * DAY_MS));

        expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
        expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
      });

      it('sends the first milestone that falls due after auto-send was turned on', async () => {
        seedConfig(world, { enabledAt: shift(D7_DUE, HOUR_MS) });
        seedLink(world, { createdAt: LINKED_AT });

        await sendDueFeedbacks(world.prisma, emailSender, logger, D15_DUE);

        expect(world.rows(REQUEST_MODEL).map((row) => row.milestone)).toEqual([StudentFeedbackMilestone.D15]);
      });
    });

    describe('meal plan', () => {
      beforeEach(() => {
        seedConfig(world);
        seedLink(world, { createdAt: LINKED_AT });
      });

      it('records hasMealPlan true when the student has a published diet protocol', async () => {
        seedPublishedMealPlan(world, STUDENT_ID);

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)[0].hasMealPlan).toBe(true);
      });

      it('records hasMealPlan false when the student has no diet protocol', async () => {
        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)[0].hasMealPlan).toBe(false);
      });

      it('records hasMealPlan false when the diet protocol is still a draft', async () => {
        seedPublishedMealPlan(world, STUDENT_ID, 'draft');

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)[0].hasMealPlan).toBe(false);
      });

      it('does not take the published diet protocol of another student', async () => {
        seedPublishedMealPlan(world, OTHER_STUDENT_ID);

        await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

        expect(world.rows(REQUEST_MODEL)[0].hasMealPlan).toBe(false);
      });
    });
  });

  describe('sendDueReminders', () => {
    const SENT_AT = D7_DUE;

    it('sends one reminder for a pending request sent 24 hours ago', async () => {
      const request = seedRequest(world, { sentAt: SENT_AT });
      const now = shift(SENT_AT, 24 * HOUR_MS);

      await sendDueReminders(world.prisma, emailSender, logger, now);

      expect(emailSender.sendStudentFeedbackReminderEmail).toHaveBeenCalledTimes(1);
      expect(emailSender.sendStudentFeedbackReminderEmail).toHaveBeenCalledWith(expect.objectContaining({ to: STUDENT_EMAIL }));
      expect(request.reminderSentAt).toEqual(now);
    });

    it('never repeats the reminder', async () => {
      seedRequest(world, { sentAt: SENT_AT });

      await sendDueReminders(world.prisma, emailSender, logger, shift(SENT_AT, 24 * HOUR_MS));
      await sendDueReminders(world.prisma, emailSender, logger, shift(SENT_AT, 24 * HOUR_MS + 15 * MINUTE_MS));
      await sendDueReminders(world.prisma, emailSender, logger, shift(SENT_AT, 48 * HOUR_MS));

      expect(emailSender.sendStudentFeedbackReminderEmail).toHaveBeenCalledTimes(1);
    });

    it('sends nothing before 24 hours have passed', async () => {
      const request = seedRequest(world, { sentAt: SENT_AT });

      await sendDueReminders(world.prisma, emailSender, logger, shift(SENT_AT, 23 * HOUR_MS));

      expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
      expect(request.reminderSentAt).toBeNull();
    });

    it('sends nothing for an answered request', async () => {
      seedRequest(world, { sentAt: SENT_AT, status: StudentFeedbackStatus.ANSWERED, submittedAt: shift(SENT_AT, HOUR_MS) });

      await sendDueReminders(world.prisma, emailSender, logger, shift(SENT_AT, 24 * HOUR_MS));

      expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
    });

    it('sends nothing for an expired request', async () => {
      seedRequest(world, { sentAt: SENT_AT, status: StudentFeedbackStatus.EXPIRED });

      await sendDueReminders(world.prisma, emailSender, logger, shift(SENT_AT, 4 * DAY_MS));

      expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
    });

    it('sends nothing for a pending request whose window already closed', async () => {
      seedRequest(world, { sentAt: SENT_AT });

      await sendDueReminders(world.prisma, emailSender, logger, shift(SENT_AT, 3 * DAY_MS + HOUR_MS));

      expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
    });

    it('does not send the request e-mail', async () => {
      seedRequest(world, { sentAt: SENT_AT });

      await sendDueReminders(world.prisma, emailSender, logger, shift(SENT_AT, 24 * HOUR_MS));

      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
    });
  });

  describe('expireOverdueFeedbacks', () => {
    const SENT_AT = D7_DUE;

    it('marks a pending request past expiresAt as expired', async () => {
      const request = seedRequest(world, { sentAt: SENT_AT });

      await expireOverdueFeedbacks(world.prisma, shift(SENT_AT, 3 * DAY_MS + MINUTE_MS));

      expect(request.status).toBe(StudentFeedbackStatus.EXPIRED);
    });

    it('keeps a pending request that is still inside its window', async () => {
      const request = seedRequest(world, { sentAt: SENT_AT });

      await expireOverdueFeedbacks(world.prisma, shift(SENT_AT, 3 * DAY_MS - MINUTE_MS));

      expect(request.status).toBe(StudentFeedbackStatus.PENDING);
    });

    it('never touches an answered request', async () => {
      const request = seedRequest(world, { sentAt: SENT_AT, status: StudentFeedbackStatus.ANSWERED, submittedAt: shift(SENT_AT, HOUR_MS) });

      await expireOverdueFeedbacks(world.prisma, shift(SENT_AT, 10 * DAY_MS));

      expect(request.status).toBe(StudentFeedbackStatus.ANSWERED);
    });
  });
});
