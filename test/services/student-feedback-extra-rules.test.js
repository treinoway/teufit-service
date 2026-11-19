import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDueFeedbacks } from '../../src/services/student-feedback-scheduler-service.js';
import { getFeedback, saveDraft, submitFeedback } from '../../src/services/student-feedback-student-service.js';
import { markAsRead } from '../../src/services/student-feedback-trainer-service.js';
import { StudentFeedbackErrorCode, StudentFeedbackMilestone, StudentFeedbackStatus } from '../../src/constants/student-feedback.js';
import {
  QuestionId,
  STUDENT_ID,
  TRAINER_ID,
  createFeedbackWorld,
  seedConfig,
  seedLink,
  seedRequest,
} from '../helpers/student-feedback-world.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const REQUEST_MODEL = 'studentFeedbackRequest';
const ANSWER_MODEL = 'studentFeedbackAnswer';
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// 09:00 America/Sao_Paulo seven days after the link
const D7_DUE = new Date('2026-11-08T12:00:00Z');

describe('student feedback rules beyond the locked tests', () => {
  let world;
  let emailSender;
  let logger;

  beforeEach(() => {
    world = createFeedbackWorld();
    seedConfig(world);
    seedLink(world, { createdAt: LINKED_AT });
    emailSender = {
      sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendStudentFeedbackReminderEmail: vi.fn().mockResolvedValue(undefined),
    };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  describe('sendDueFeedbacks', () => {
    it('waits while an ad-hoc request of the trainer is open and sends the milestone once it is closed', async () => {
      const adhoc = seedRequest(world, { milestone: StudentFeedbackMilestone.ADHOC, sentAt: new Date(D7_DUE.getTime() - DAY_MS) });

      await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();

      adhoc.status = StudentFeedbackStatus.ANSWERED;
      await sendDueFeedbacks(world.prisma, emailSender, logger, new Date(D7_DUE.getTime() + HOUR_MS));

      expect(world.rows(REQUEST_MODEL).map((row) => row.milestone)).toEqual([StudentFeedbackMilestone.ADHOC, StudentFeedbackMilestone.D7]);
      expect(world.rows(REQUEST_MODEL)[1].dueAt).toEqual(D7_DUE);
    });

    it('logs and sends nothing when the general template is missing', async () => {
      world.rows('studentFeedbackTemplate').splice(0);

      await expect(sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE)).resolves.toEqual({ created: 0 });

      expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('logs an e-mail the provider rejected and keeps the request', async () => {
      emailSender.sendStudentFeedbackRequestEmail.mockResolvedValue({ data: null, error: { name: 'validation_error' } });

      await sendDueFeedbacks(world.prisma, emailSender, logger, D7_DUE);

      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith({ providerError: 'validation_error' }, expect.any(String));
    });
  });

  describe('student answers', () => {
    const NOW = new Date(D7_DUE.getTime() + 6 * HOUR_MS);
    let request;

    beforeEach(() => {
      request = seedRequest(world, { sentAt: D7_DUE });
    });

    it('removes a saved answer when the draft sends it empty', async () => {
      const filled = [{ questionId: QuestionId.TRAINING, score: 8 }, { questionId: QuestionId.REPORT, text: 'oi' }];
      const cleared = [{ questionId: QuestionId.TRAINING, score: null }, { questionId: QuestionId.REPORT, text: '   ' }];
      await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: filled }, NOW);

      const result = await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: cleared }, NOW);

      expect(result.answers).toEqual([]);
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers STUDENT_FEEDBACK_ALREADY_SUBMITTED for a draft on an answered request', async () => {
      request.status = StudentFeedbackStatus.ANSWERED;

      await expect(saveDraft(world.prisma, STUDENT_ID, request.id, { answers: [] }, NOW)).rejects.toMatchObject({
        httpStatus: 409,
        error: StudentFeedbackErrorCode.ALREADY_SUBMITTED,
      });
    });

    it('reads a pending request past its window as expired', async () => {
      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, new Date(D7_DUE.getTime() + 4 * DAY_MS));

      expect(feedback).toMatchObject({ status: StudentFeedbackStatus.EXPIRED, daysLeft: 0 });
    });

    it('returns a null nextFeedbackAt when the student is no longer active on the plan', async () => {
      world.rows('trainerStudent')[0].activeOnPlan = false;
      const answers = [
        { questionId: QuestionId.TRAINING, score: 8 },
        { questionId: QuestionId.SLEEP, score: 4 },
        { questionId: QuestionId.ROUTINE, score: 3 },
        { questionId: QuestionId.EVOLUTION, score: 9 },
      ];

      const result = await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW);

      expect(result).toEqual({ nextFeedbackAt: null });
    });
  });

  describe('markAsRead on a request that was not answered', () => {
    it('leaves a pending request unread', async () => {
      const request = seedRequest(world, { sentAt: D7_DUE });

      const result = await markAsRead(world.prisma, TRAINER_ID, request.id, new Date(D7_DUE.getTime() + HOUR_MS));

      expect(result).toEqual({ id: request.id, readAt: null });
      expect(request.readAt).toBeNull();
    });
  });
});
