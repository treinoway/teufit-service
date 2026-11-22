import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDueFeedbacks } from '../../src/services/student-feedback-scheduler-service.js';
import { getFeedback } from '../../src/services/student-feedback-student-service.js';
import { sendAdhocFeedback } from '../../src/services/student-feedback-trainer-service.js';
import {
  StudentFeedbackMilestone,
  StudentFeedbackStatus,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import { OTHER_STUDENT_ID, OTHER_TRAINER_ID, seedLink } from '../helpers/student-feedback-world.js';
import {
  GENERAL_TEMPLATE_ID,
  OTHER_TEMPLATE_ID,
  OTHER_TEMPLATE_NAME,
  OWN_QUESTIONS,
  OWN_TEMPLATE_ID,
  OWN_TEMPLATE_NAME,
  REQUEST_MODEL,
  STUDENT_ID,
  TEMPLATE_MODEL,
  TRAINER_ID,
  UNKNOWN_TEMPLATE_ID,
  createTemplateWorld,
  seedOwnTemplate,
  seedTemplateConfig,
} from '../helpers/student-feedback-template-world.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const HTTP_NOT_FOUND = 404;
const SECOND_TEMPLATE_ID = 'template-second';
const DELETED_TEMPLATE_ID = 'template-deleted';
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// 09:00 America/Sao_Paulo seven days after the link
const D7_DUE = new Date('2026-11-08T12:00:00Z');
const NOW = new Date(D7_DUE.getTime() + HOUR_MS);
// Linked eight days earlier, so the fifteenth day falls on the same tick
const LINKED_15_DAYS_AGO = new Date(LINKED_AT.getTime() - 8 * DAY_MS);

// Stored request sent to the student, or undefined
function requestOf(world, studentId) {
  return world.rows(REQUEST_MODEL).find((row) => row.studentId === studentId);
}

// Marks a stored template as deleted
function markDeleted(world, templateId) {
  world.rows(TEMPLATE_MODEL).find((row) => row.id === templateId).deletedAt = new Date('2026-11-05T12:00:00Z');
}

// Expectation of the 404 of a template the trainer cannot use
function templateNotFound() {
  return {
    httpStatus: HTTP_NOT_FOUND,
    error: StudentFeedbackTemplateErrorCode.NOT_FOUND,
    messageCode: StudentFeedbackTemplateMessageCode.NOT_FOUND,
  };
}

describe('student feedback sending with templates', () => {
  let world;
  let emailSender;
  let logger;

  beforeEach(() => {
    world = createTemplateWorld();
    seedOwnTemplate(world);
    seedOwnTemplate(world, { id: SECOND_TEMPLATE_ID, name: 'Outro modelo' });
    seedOwnTemplate(world, { id: OTHER_TEMPLATE_ID, trainerId: OTHER_TRAINER_ID, name: OTHER_TEMPLATE_NAME });
    emailSender = {
      sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendStudentFeedbackReminderEmail: vi.fn().mockResolvedValue(undefined),
    };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  describe('sendDueFeedbacks', () => {
    it('uses the template chosen for the milestone', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      seedLink(world, { createdAt: LINKED_AT });

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 1 });
      expect(requestOf(world, STUDENT_ID)).toMatchObject({ milestone: StudentFeedbackMilestone.D7, templateId: OWN_TEMPLATE_ID });
    });

    it('shows the student the questions and the name of the chosen template', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      seedLink(world, { createdAt: LINKED_AT });
      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      const feedback = await getFeedback(world.prisma, STUDENT_ID, requestOf(world, STUDENT_ID).id, NOW);

      expect(feedback.title).toBe(OWN_TEMPLATE_NAME);
      expect(feedback.questions.map((question) => question.text)).toEqual(OWN_QUESTIONS.map((question) => question.text));
    });

    it('uses the general template when no template was chosen for the milestone', async () => {
      seedTemplateConfig(world, { d15TemplateId: OWN_TEMPLATE_ID, recurringTemplateId: SECOND_TEMPLATE_ID });
      seedLink(world, { createdAt: LINKED_AT });

      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(requestOf(world, STUDENT_ID)).toMatchObject({ milestone: StudentFeedbackMilestone.D7, templateId: GENERAL_TEMPLATE_ID });
    });

    it('uses the general template when the chosen one was deleted', async () => {
      seedOwnTemplate(world, { id: DELETED_TEMPLATE_ID, name: 'Apagado' });
      seedTemplateConfig(world, { d7TemplateId: DELETED_TEMPLATE_ID });
      markDeleted(world, DELETED_TEMPLATE_ID);
      seedLink(world, { createdAt: LINKED_AT });

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 1 });
      expect(requestOf(world, STUDENT_ID).templateId).toBe(GENERAL_TEMPLATE_ID);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('uses a different template for each milestone of one trainer in the same run', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, d15TemplateId: SECOND_TEMPLATE_ID });
      seedLink(world, { createdAt: LINKED_AT });
      seedLink(world, { studentId: OTHER_STUDENT_ID, createdAt: LINKED_15_DAYS_AGO });

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 2 });
      expect(requestOf(world, STUDENT_ID)).toMatchObject({ milestone: StudentFeedbackMilestone.D7, templateId: OWN_TEMPLATE_ID });
      expect(requestOf(world, OTHER_STUDENT_ID)).toMatchObject({ milestone: StudentFeedbackMilestone.D15, templateId: SECOND_TEMPLATE_ID });
    });

    it('uses the template of each trainer when two trainers are due in the same run', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      seedTemplateConfig(world, { trainerId: OTHER_TRAINER_ID, d7TemplateId: OTHER_TEMPLATE_ID });
      seedLink(world, { createdAt: LINKED_AT });
      seedLink(world, { trainerId: OTHER_TRAINER_ID, studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 2 });
      expect(requestOf(world, STUDENT_ID)).toMatchObject({ trainerId: TRAINER_ID, templateId: OWN_TEMPLATE_ID });
      expect(requestOf(world, OTHER_STUDENT_ID)).toMatchObject({ trainerId: OTHER_TRAINER_ID, templateId: OTHER_TEMPLATE_ID });
    });

    it('keeps using the general template for a trainer without a choice while another trainer has one', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      seedTemplateConfig(world, { trainerId: OTHER_TRAINER_ID });
      seedLink(world, { createdAt: LINKED_AT });
      seedLink(world, { trainerId: OTHER_TRAINER_ID, studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });

      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(requestOf(world, STUDENT_ID).templateId).toBe(OWN_TEMPLATE_ID);
      expect(requestOf(world, OTHER_STUDENT_ID).templateId).toBe(GENERAL_TEMPLATE_ID);
    });

    it('sends with the chosen template even when the general template is missing', async () => {
      world.rows(TEMPLATE_MODEL).splice(0, world.rows(TEMPLATE_MODEL).length, ...world.rows(TEMPLATE_MODEL).filter((row) => !row.isGeneral));
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      seedLink(world, { createdAt: LINKED_AT });

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 1 });
      expect(requestOf(world, STUDENT_ID).templateId).toBe(OWN_TEMPLATE_ID);
    });
  });

  describe('sendAdhocFeedback', () => {
    beforeEach(() => {
      seedLink(world, { createdAt: LINKED_AT });
    });

    it('uses the template the trainer picked', async () => {
      const result = await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW, logger, { templateId: OWN_TEMPLATE_ID });

      expect(result).toMatchObject({ milestone: StudentFeedbackMilestone.ADHOC, status: StudentFeedbackStatus.PENDING });
      expect(requestOf(world, STUDENT_ID)).toMatchObject({ id: result.id, milestone: StudentFeedbackMilestone.ADHOC, templateId: OWN_TEMPLATE_ID });
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
    });

    it('accepts the general template as the picked one', async () => {
      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW, logger, { templateId: GENERAL_TEMPLATE_ID });

      expect(requestOf(world, STUDENT_ID).templateId).toBe(GENERAL_TEMPLATE_ID);
    });

    it.each([
      ['of another trainer', OTHER_TEMPLATE_ID],
      ['that does not exist', UNKNOWN_TEMPLATE_ID],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a template %s and sends nothing', async (_scenario, templateId) => {
      const send = sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW, logger, { templateId });

      await expect(send).rejects.toMatchObject(templateNotFound());
      expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a deleted template and sends nothing', async () => {
      markDeleted(world, OWN_TEMPLATE_ID);

      const send = sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW, logger, { templateId: OWN_TEMPLATE_ID });

      await expect(send).rejects.toMatchObject(templateNotFound());
      expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
    });

    it.each([
      ['no options', []],
      ['a logger and no options', [null]],
      ['empty options', [null, {}]],
      ['an undefined template id', [null, { templateId: undefined }]],
    ])('uses the general template when called with %s', async (_scenario, extraArgs) => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, recurringTemplateId: SECOND_TEMPLATE_ID });

      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW, ...extraArgs);

      expect(requestOf(world, STUDENT_ID)).toMatchObject({ milestone: StudentFeedbackMilestone.ADHOC, templateId: GENERAL_TEMPLATE_ID });
    });
  });
});
