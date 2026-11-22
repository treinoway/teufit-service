import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lockStudentFeedbackTemplateForUpdate } from '../../src/helpers/row-locks.js';
import enUS from '../../src/i18n/locales/en-US.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import { getMilestoneTemplates, updateMilestoneTemplates } from '../../src/services/student-feedback-config-service.js';
import { sendDueFeedbacks } from '../../src/services/student-feedback-scheduler-service.js';
import { chosenTemplateId, resolveTemplate } from '../../src/services/student-feedback-shared.js';
import { deleteTemplate, duplicateTemplate, saveTemplate } from '../../src/services/student-feedback-template-service.js';
import {
  MILESTONE_TEMPLATE_SLOTS,
  STUDENT_FEEDBACK_TEMPLATE_LIMITS,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import { OTHER_STUDENT_ID, OTHER_TRAINER_ID, TEMPLATE_NAME, seedLink } from '../helpers/student-feedback-world.js';
import {
  GENERAL_TEMPLATE_ID,
  NO_MILESTONE_TEMPLATES,
  OTHER_TEMPLATE_ID,
  OWN_QUESTIONS,
  OWN_TEMPLATE_ID,
  OWN_TEMPLATE_NAME,
  REQUEST_MODEL,
  STUDENT_ID,
  TEMPLATE_COLUMN_BY_FIELD,
  TEMPLATE_MODEL,
  TRAINER_ID,
  createTemplateWorld,
  questionsOf,
  seedAnsweredRequest,
  seedOwnTemplate,
  seedTemplateConfig,
  snapshotTemplates,
  storedMilestoneTemplates,
} from '../helpers/student-feedback-template-world.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HOUR_MS = 3600000;
const SECOND_TEMPLATE_ID = 'template-second';
const BLANK = '   ';
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// One hour after 09:00 America/Sao_Paulo of the seventh day after the link
const NOW = new Date(new Date('2026-11-08T12:00:00Z').getTime() + HOUR_MS);
const INVALID = Object.freeze({
  httpStatus: HTTP_BAD_REQUEST,
  error: StudentFeedbackTemplateErrorCode.INVALID,
  messageCode: StudentFeedbackTemplateMessageCode.INVALID,
});
const NOT_FOUND = Object.freeze({
  httpStatus: HTTP_NOT_FOUND,
  error: StudentFeedbackTemplateErrorCode.NOT_FOUND,
  messageCode: StudentFeedbackTemplateMessageCode.NOT_FOUND,
});

// A valid open question of a save payload unless overridden
function openQuestion(overrides = {}) {
  return { text: 'Quer contar algo?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.REPORT, required: false, invertScore: false, ...overrides };
}

// A valid save payload unless overridden
function savePayload(overrides = {}) {
  return { name: 'Check-in quinzenal', questions: [openQuestion()], ...overrides };
}

// Ids bound to the row-lock queries issued on a spied $queryRaw
function lockedIds(queryRaw) {
  return queryRaw.mock.calls.filter(([strings]) => strings.join('?').includes('FROM student_feedback_templates')).map(([, id]) => id);
}

// Stored template row with the given id
function templateRow(world, templateId) {
  return world.rows(TEMPLATE_MODEL).find((row) => row.id === templateId);
}

describe('student feedback template rules', () => {
  let world;

  beforeEach(() => {
    world = createTemplateWorld();
    seedOwnTemplate(world);
    seedOwnTemplate(world, { id: SECOND_TEMPLATE_ID, name: 'Outro modelo' });
    seedOwnTemplate(world, { id: OTHER_TEMPLATE_ID, trainerId: OTHER_TRAINER_ID, name: 'Modelo da Paula' });
  });

  describe('milestone template slots', () => {
    it('map every toggle to the config column the stored rows use, in schedule order', () => {
      expect(Object.fromEntries(MILESTONE_TEMPLATE_SLOTS.map(({ field, column }) => [field, column]))).toEqual(TEMPLATE_COLUMN_BY_FIELD);
      expect(MILESTONE_TEMPLATE_SLOTS.map(({ milestone }) => milestone)).toEqual([
        StudentFeedbackMilestone.D7,
        StudentFeedbackMilestone.D15,
        StudentFeedbackMilestone.D21,
        StudentFeedbackMilestone.D30,
        StudentFeedbackMilestone.RECURRING,
      ]);
    });

    it('give no column to the ad-hoc milestone', () => {
      expect(chosenTemplateId({ d7TemplateId: OWN_TEMPLATE_ID }, StudentFeedbackMilestone.ADHOC)).toBeNull();
      expect(chosenTemplateId({ d7TemplateId: OWN_TEMPLATE_ID }, StudentFeedbackMilestone.D7)).toBe(OWN_TEMPLATE_ID);
    });
  });

  describe('template error translations', () => {
    it.each(Object.values(StudentFeedbackTemplateMessageCode))('has a pt-BR and an en-US message for %s', (messageCode) => {
      expect(ptBR.errors[messageCode]).toEqual(expect.any(String));
      expect(enUS.errors[messageCode]).toEqual(expect.any(String));
      expect(ptBR.errors[messageCode]).not.toBe(enUS.errors[messageCode]);
    });
  });

  describe('lockStudentFeedbackTemplateForUpdate', () => {
    it('locks the student_feedback_templates row FOR UPDATE with the id bound as a parameter', async () => {
      const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

      await lockStudentFeedbackTemplateForUpdate(tx, OWN_TEMPLATE_ID);

      const [strings, id] = tx.$queryRaw.mock.calls[0];
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(strings.join('?')).toContain('FROM student_feedback_templates');
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(strings.join('?')).not.toContain(OWN_TEMPLATE_ID);
      expect(id).toBe(OWN_TEMPLATE_ID);
    });
  });

  describe('updateMilestoneTemplates with the general template', () => {
    it('stores null when the id of the general template is sent', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });

      const result = await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: GENERAL_TEMPLATE_ID, d15: SECOND_TEMPLATE_ID });

      expect(result).toEqual({ ...NO_MILESTONE_TEMPLATES, d15: SECOND_TEMPLATE_ID });
      expect(storedMilestoneTemplates(world)).toEqual(result);
      await expect(getMilestoneTemplates(world.prisma, TRAINER_ID)).resolves.toEqual(result);
    });

    it('locks only the chosen own templates, in id order, never the general one', async () => {
      const queryRaw = vi.spyOn(world.prisma, '$queryRaw');

      await updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: SECOND_TEMPLATE_ID, d15: GENERAL_TEMPLATE_ID, d21: OWN_TEMPLATE_ID, d30: SECOND_TEMPLATE_ID });

      expect(lockedIds(queryRaw)).toEqual([OWN_TEMPLATE_ID, SECOND_TEMPLATE_ID].sort());
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND and stores nothing when the template is deleted while waiting for its lock', async () => {
      seedTemplateConfig(world);
      vi.spyOn(world.prisma, '$queryRaw').mockImplementation(async () => {
        templateRow(world, OWN_TEMPLATE_ID).deletedAt = NOW;
        return [];
      });

      await expect(updateMilestoneTemplates(world.prisma, TRAINER_ID, { d7: OWN_TEMPLATE_ID })).rejects.toMatchObject(NOT_FOUND);

      expect(storedMilestoneTemplates(world)).toEqual(NO_MILESTONE_TEMPLATES);
    });
  });

  describe('saveTemplate trimming', () => {
    it('stores the name and the texts trimmed, and blank optional texts as null', async () => {
      const question = { text: '  Como foi?  ', helpText: BLANK, type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.SLEEP, required: true, invertScore: false, minLabel: ' Mal ', maxLabel: BLANK };

      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload({ name: '  Check-in  ', questions: [question] }));

      expect(saved.name).toBe('Check-in');
      expect(saved.questions[0]).toMatchObject({ text: 'Como foi?', helpText: null, minLabel: 'Mal', maxLabel: null });
      expect(questionsOf(world, OWN_TEMPLATE_ID)[0]).toMatchObject({ text: 'Como foi?', helpText: null, minLabel: 'Mal', maxLabel: null });
    });

    it.each([
      ['a name that is blank after trimming', () => savePayload({ name: BLANK })],
      ['a question text that is blank after trimming', () => savePayload({ questions: [openQuestion(), openQuestion({ text: BLANK })] })],
      ['no question', () => savePayload({ questions: [] })],
      ['more questions than the limit', () => savePayload({ questions: Array.from({ length: STUDENT_FEEDBACK_TEMPLATE_LIMITS.maxQuestions + 1 }, () => openQuestion()) })],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_INVALID for %s and writes nothing', async (_scenario, buildPayload) => {
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, buildPayload())).rejects.toMatchObject(INVALID);

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('creates no new version for a blank name on a template with requests', async () => {
      seedLink(world, { createdAt: LINKED_AT });
      seedAnsweredRequest(world, OWN_TEMPLATE_ID);
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload({ name: BLANK }))).rejects.toMatchObject(INVALID);

      expect(snapshotTemplates(world)).toEqual(before);
    });
  });

  describe('template writes under the row lock', () => {
    it('saveTemplate locks the template before writing', async () => {
      const queryRaw = vi.spyOn(world.prisma, '$queryRaw');

      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(lockedIds(queryRaw)).toEqual([OWN_TEMPLATE_ID]);
    });

    it('saveTemplate answers NOT_FOUND and writes nothing when the row is retired while waiting for the lock', async () => {
      vi.spyOn(world.prisma, '$queryRaw').mockImplementation(async () => {
        templateRow(world, OWN_TEMPLATE_ID).deletedAt = NOW;
        return [];
      });

      await expect(saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload())).rejects.toMatchObject(NOT_FOUND);

      expect(templateRow(world, OWN_TEMPLATE_ID).name).toBe(OWN_TEMPLATE_NAME);
      expect(questionsOf(world, OWN_TEMPLATE_ID)).toHaveLength(OWN_QUESTIONS.length);
    });

    it('saveTemplate creates a new version when a request shows up while waiting for the lock', async () => {
      seedLink(world, { createdAt: LINKED_AT });
      vi.spyOn(world.prisma, '$queryRaw').mockImplementation(async () => {
        seedAnsweredRequest(world, OWN_TEMPLATE_ID);
        return [];
      });

      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(saved).toMatchObject({ version: 2, hasRequests: false });
      expect(saved.id).not.toBe(OWN_TEMPLATE_ID);
      expect(questionsOf(world, OWN_TEMPLATE_ID)).toHaveLength(OWN_QUESTIONS.length);
    });

    it('saveTemplate stamps the retired row with the given date', async () => {
      seedLink(world, { createdAt: LINKED_AT });
      seedAnsweredRequest(world, OWN_TEMPLATE_ID);

      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload(), NOW);

      expect(templateRow(world, OWN_TEMPLATE_ID).deletedAt).toEqual(NOW);
    });

    it('deleteTemplate locks the template and stamps it with the given date', async () => {
      const queryRaw = vi.spyOn(world.prisma, '$queryRaw');

      await deleteTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, NOW);

      expect(lockedIds(queryRaw)).toEqual([OWN_TEMPLATE_ID]);
      expect(templateRow(world, OWN_TEMPLATE_ID).deletedAt).toEqual(NOW);
    });

    it('deleteTemplate answers NOT_FOUND and keeps the milestones when the row is retired while waiting for the lock', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      vi.spyOn(world.prisma, '$queryRaw').mockImplementation(async () => {
        templateRow(world, OWN_TEMPLATE_ID).deletedAt = LINKED_AT;
        return [];
      });

      await expect(deleteTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, NOW)).rejects.toMatchObject(NOT_FOUND);

      expect(templateRow(world, OWN_TEMPLATE_ID).deletedAt).toEqual(LINKED_AT);
      expect(storedMilestoneTemplates(world).d7).toBe(OWN_TEMPLATE_ID);
    });
  });

  describe('duplicateTemplate', () => {
    it('copies the end labels and the order of a question as they are stored', async () => {
      const copy = await duplicateTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(copy.questions.map((question) => question.order)).toEqual([1, 2, 3]);
      expect(copy.questions[0]).toMatchObject({ minLabel: OWN_QUESTIONS[0].minLabel, maxLabel: OWN_QUESTIONS[0].maxLabel, helpText: OWN_QUESTIONS[0].helpText });
    });
  });

  describe('resolveTemplate with a config column the trainer does not own', () => {
    it('falls back to the general template', async () => {
      const config = seedTemplateConfig(world, { d7TemplateId: OTHER_TEMPLATE_ID });

      const template = await resolveTemplate(world.prisma, { trainerId: TRAINER_ID, milestone: StudentFeedbackMilestone.D7, config });

      expect(template).toMatchObject({ id: GENERAL_TEMPLATE_ID, name: TEMPLATE_NAME });
    });
  });

  describe('sendDueFeedbacks without the general template', () => {
    let emailSender;
    let logger;

    beforeEach(() => {
      emailSender = { sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined) };
      logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      world.rows(TEMPLATE_MODEL).splice(0, world.rows(TEMPLATE_MODEL).length, ...world.rows(TEMPLATE_MODEL).filter((row) => !row.isGeneral));
    });

    it('sends the links with a chosen template, skips the ones that need the general one and logs it once', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
      seedTemplateConfig(world, { trainerId: OTHER_TRAINER_ID });
      seedLink(world, { createdAt: LINKED_AT });
      seedLink(world, { trainerId: OTHER_TRAINER_ID, studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });
      seedLink(world, { trainerId: OTHER_TRAINER_ID, studentId: STUDENT_ID, createdAt: LINKED_AT });

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 1 });
      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
      expect(world.rows(REQUEST_MODEL)[0]).toMatchObject({ trainerId: TRAINER_ID, studentId: STUDENT_ID, templateId: OWN_TEMPLATE_ID });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
});
