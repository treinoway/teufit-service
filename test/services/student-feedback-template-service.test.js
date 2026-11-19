import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
} from '../../src/services/student-feedback-template-service.js';
import { getFeedback } from '../../src/services/student-feedback-student-service.js';
import {
  STUDENT_FEEDBACK_TEMPLATE_LIMITS,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionCondition,
  StudentFeedbackQuestionType,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import { OTHER_TRAINER_ID, TEMPLATE_NAME, seedLink } from '../helpers/student-feedback-world.js';
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
  liveTemplatesOf,
  questionsOf,
  seedAnsweredRequest,
  seedOwnTemplate,
  seedTemplateConfig,
  snapshotTemplates,
  storedMilestoneTemplates,
} from '../helpers/student-feedback-template-world.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const COPY_SUFFIX = ' (cópia)';
const GENERAL_QUESTION_COUNT = 7;
const NEW_NAME = 'Check-in quinzenal';
const DELETED_AT = new Date('2026-10-20T12:00:00Z');
const READ_AT = new Date('2026-10-12T12:00:00Z');
const ALL_SCHEDULED_MILESTONES = [
  StudentFeedbackMilestone.D7,
  StudentFeedbackMilestone.D15,
  StudentFeedbackMilestone.D21,
  StudentFeedbackMilestone.D30,
  StudentFeedbackMilestone.RECURRING,
];

// Questions of a save payload: a new first question, the inverted routine score and an optional open one
const NEW_QUESTIONS = Object.freeze([
  Object.freeze({
    text: 'Quão cansado ficaste?',
    helpText: 'De 0 a 10',
    type: StudentFeedbackQuestionType.SCORE,
    pillar: StudentFeedbackPillar.ROUTINE,
    required: true,
    invertScore: true,
    minLabel: 'Nada',
    maxLabel: 'Exausto',
  }),
  Object.freeze({
    text: 'Seguiste o plano alimentar?',
    type: StudentFeedbackQuestionType.STARS,
    pillar: StudentFeedbackPillar.DIET_ADHERENCE,
    required: true,
    invertScore: false,
    condition: StudentFeedbackQuestionCondition.HAS_MEAL_PLAN,
  }),
  Object.freeze({
    text: 'Quer contar algo?',
    type: StudentFeedbackQuestionType.OPEN,
    pillar: StudentFeedbackPillar.REPORT,
    required: false,
    invertScore: false,
  }),
]);

// Save payload with the new name and questions unless overridden
function savePayload(overrides = {}) {
  return { name: NEW_NAME, questions: NEW_QUESTIONS.map((question) => ({ ...question })), ...overrides };
}

// Texts of a list of questions, in the order given
function textsOf(questions) {
  return questions.map((question) => question.text);
}

// Expectation of a rejection with a template error of the unified contract
function templateError(key, httpStatus) {
  return {
    httpStatus,
    error: StudentFeedbackTemplateErrorCode[key],
    messageCode: StudentFeedbackTemplateMessageCode[key],
  };
}

// Template row of the trainer that replaced the given one as its next version
function successorOf(world, previousId) {
  return world.rows(TEMPLATE_MODEL).find((row) => row.parentId === previousId);
}

describe('student feedback template service', () => {
  let world;

  beforeEach(() => {
    world = createTemplateWorld();
    seedOwnTemplate(world);
    seedOwnTemplate(world, { id: OTHER_TEMPLATE_ID, trainerId: OTHER_TRAINER_ID, name: OTHER_TEMPLATE_NAME });
  });

  describe('template constants', () => {
    it('exposes the template error codes', () => {
      expect(StudentFeedbackTemplateErrorCode).toEqual({
        NOT_FOUND: 'STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND',
        READ_ONLY: 'STUDENT_FEEDBACK_TEMPLATE_READ_ONLY',
        INVALID: 'STUDENT_FEEDBACK_TEMPLATE_INVALID',
      });
    });

    it('exposes one stable messageCode per template error', () => {
      expect(StudentFeedbackTemplateMessageCode).toEqual({
        NOT_FOUND: 'studentFeedbackTemplate.notFound',
        READ_ONLY: 'studentFeedbackTemplate.readOnly',
        INVALID: 'studentFeedbackTemplate.invalid',
      });
    });

    it('exposes the template limits', () => {
      expect(STUDENT_FEEDBACK_TEMPLATE_LIMITS).toEqual({
        maxQuestions: 15,
        nameMaxLength: 80,
        questionTextMaxLength: 300,
        helpTextMaxLength: 300,
        labelMaxLength: 60,
      });
    });
  });

  describe('listTemplates', () => {
    it('returns the general template first, then the own templates', async () => {
      const templates = await listTemplates(world.prisma, TRAINER_ID);

      expect(templates.map((template) => template.id)).toEqual([GENERAL_TEMPLATE_ID, OWN_TEMPLATE_ID]);
    });

    it('describes each template with name, ownership, version and question count', async () => {
      const [general, own] = await listTemplates(world.prisma, TRAINER_ID);

      expect(general).toMatchObject({ id: GENERAL_TEMPLATE_ID, name: TEMPLATE_NAME, isGeneral: true, version: 1, questionCount: GENERAL_QUESTION_COUNT });
      expect(own).toMatchObject({ id: OWN_TEMPLATE_ID, name: OWN_TEMPLATE_NAME, isGeneral: false, version: 1, questionCount: OWN_QUESTIONS.length });
    });

    it('returns exactly the contract fields of each template', async () => {
      const [, own] = await listTemplates(world.prisma, TRAINER_ID);

      expect(Object.keys(own).sort()).toEqual(['id', 'isGeneral', 'milestones', 'name', 'questionCount', 'updatedAt', 'version']);
      expect(own.updatedAt).toEqual(world.rows(TEMPLATE_MODEL).find((row) => row.id === OWN_TEMPLATE_ID).updatedAt);
    });

    it('never returns a template of another trainer', async () => {
      const templates = await listTemplates(world.prisma, TRAINER_ID);

      expect(templates.map((template) => template.id)).not.toContain(OTHER_TEMPLATE_ID);
    });

    it('orders the own templates by name', async () => {
      seedOwnTemplate(world, { id: 'template-zulu', name: 'Zulu' });
      seedOwnTemplate(world, { id: 'template-alfa', name: 'Alfa' });

      const templates = await listTemplates(world.prisma, TRAINER_ID);

      expect(templates.map((template) => template.name)).toEqual([TEMPLATE_NAME, 'Alfa', OWN_TEMPLATE_NAME, 'Zulu']);
    });

    it('never returns a deleted template', async () => {
      seedOwnTemplate(world, { id: 'template-deleted', name: 'Apagado', deletedAt: DELETED_AT });

      const templates = await listTemplates(world.prisma, TRAINER_ID);

      expect(templates.map((template) => template.id)).toEqual([GENERAL_TEMPLATE_ID, OWN_TEMPLATE_ID]);
    });

    it('returns only the latest version of a template that was versioned', async () => {
      world.rows(TEMPLATE_MODEL).find((row) => row.id === OWN_TEMPLATE_ID).deletedAt = DELETED_AT;
      seedOwnTemplate(world, { id: 'template-own-v2', version: 2, parentId: OWN_TEMPLATE_ID });

      const templates = await listTemplates(world.prisma, TRAINER_ID);

      expect(templates.map((template) => template.id)).toEqual([GENERAL_TEMPLATE_ID, 'template-own-v2']);
      expect(templates[1].version).toBe(2);
    });

    it('lists on each own template the milestones that use it', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, recurringTemplateId: OWN_TEMPLATE_ID });

      const [, own] = await listTemplates(world.prisma, TRAINER_ID);

      expect(own.milestones).toEqual([StudentFeedbackMilestone.D7, StudentFeedbackMilestone.RECURRING]);
    });

    it('lists on the general template the milestones without a chosen template', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, recurringTemplateId: OWN_TEMPLATE_ID });

      const [general] = await listTemplates(world.prisma, TRAINER_ID);

      expect(general.milestones).toEqual([StudentFeedbackMilestone.D15, StudentFeedbackMilestone.D21, StudentFeedbackMilestone.D30]);
    });

    it('gives every milestone to the general template when the trainer never saved a config', async () => {
      const [general, own] = await listTemplates(world.prisma, TRAINER_ID);

      expect(general.milestones).toEqual(ALL_SCHEDULED_MILESTONES);
      expect(own.milestones).toEqual([]);
    });

    it('ignores the milestone choices of another trainer', async () => {
      seedTemplateConfig(world, { trainerId: OTHER_TRAINER_ID, d7TemplateId: OTHER_TEMPLATE_ID });

      const [general] = await listTemplates(world.prisma, TRAINER_ID);

      expect(general.milestones).toEqual(ALL_SCHEDULED_MILESTONES);
    });
  });

  describe('getTemplate', () => {
    it('returns an own template with its questions in order', async () => {
      const template = await getTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(template).toMatchObject({ id: OWN_TEMPLATE_ID, name: OWN_TEMPLATE_NAME, isGeneral: false, version: 1, hasRequests: false, milestones: [] });
      expect(textsOf(template.questions)).toEqual(textsOf(OWN_QUESTIONS));
    });

    it('returns every contract field of a question', async () => {
      const { questions } = await getTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(questions[0]).toMatchObject({
        id: `${OWN_TEMPLATE_ID}-q1`,
        order: 1,
        text: OWN_QUESTIONS[0].text,
        helpText: OWN_QUESTIONS[0].helpText,
        type: StudentFeedbackQuestionType.SCORE,
        pillar: StudentFeedbackPillar.TRAINING_ADHERENCE,
        required: true,
        condition: null,
        invertScore: false,
        minLabel: OWN_QUESTIONS[0].minLabel,
        maxLabel: OWN_QUESTIONS[0].maxLabel,
      });
      expect(questions[2]).toMatchObject({ helpText: null, minLabel: null, maxLabel: null, required: false });
    });

    it('returns the general template to any trainer', async () => {
      const template = await getTemplate(world.prisma, TRAINER_ID, GENERAL_TEMPLATE_ID);

      expect(template).toMatchObject({ id: GENERAL_TEMPLATE_ID, name: TEMPLATE_NAME, isGeneral: true, milestones: ALL_SCHEDULED_MILESTONES });
      expect(template.questions).toHaveLength(GENERAL_QUESTION_COUNT);
    });

    it('reports hasRequests once a request was sent with the template', async () => {
      seedAnsweredRequest(world, OWN_TEMPLATE_ID);

      const template = await getTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(template.hasRequests).toBe(true);
    });

    it('lists the milestones that use the template', async () => {
      seedTemplateConfig(world, { d15TemplateId: OWN_TEMPLATE_ID });

      const template = await getTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(template.milestones).toEqual([StudentFeedbackMilestone.D15]);
    });

    it.each([
      ['a template of another trainer', OTHER_TEMPLATE_ID],
      ['a template that does not exist', UNKNOWN_TEMPLATE_ID],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for %s', async (_scenario, templateId) => {
      await expect(getTemplate(world.prisma, TRAINER_ID, templateId)).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a deleted own template', async () => {
      seedOwnTemplate(world, { id: 'template-deleted', deletedAt: DELETED_AT });

      await expect(getTemplate(world.prisma, TRAINER_ID, 'template-deleted')).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));
    });
  });

  describe('duplicateTemplate', () => {
    it('creates a new own template from the general one, version 1 and named as a copy', async () => {
      const copy = await duplicateTemplate(world.prisma, TRAINER_ID, GENERAL_TEMPLATE_ID);

      const stored = world.rows(TEMPLATE_MODEL).find((row) => row.id === copy.id);
      expect(copy.id).not.toBe(GENERAL_TEMPLATE_ID);
      expect(stored).toMatchObject({ trainerId: TRAINER_ID, isGeneral: false, version: 1, name: `${TEMPLATE_NAME}${COPY_SUFFIX}` });
      expect(stored.parentId ?? null).toBeNull();
      expect(stored.deletedAt ?? null).toBeNull();
    });

    it('copies the questions of the general template in order, with every field', async () => {
      const copy = await duplicateTemplate(world.prisma, TRAINER_ID, GENERAL_TEMPLATE_ID);

      const original = questionsOf(world, GENERAL_TEMPLATE_ID);
      const copied = questionsOf(world, copy.id);
      expect(textsOf(copied)).toEqual(textsOf(original));
      copied.forEach((question, index) => {
        const { type, pillar, required, invertScore, condition, helpText, minLabel, maxLabel } = original[index];
        expect(question).toMatchObject({ type, pillar, required, invertScore, condition, helpText, minLabel, maxLabel });
        expect(question.id).not.toBe(original[index].id);
      });
    });

    it('leaves the general template and its questions untouched', async () => {
      const before = structuredClone({ template: world.rows(TEMPLATE_MODEL).find((row) => row.id === GENERAL_TEMPLATE_ID), questions: questionsOf(world, GENERAL_TEMPLATE_ID) });

      await duplicateTemplate(world.prisma, TRAINER_ID, GENERAL_TEMPLATE_ID);

      expect(world.rows(TEMPLATE_MODEL).find((row) => row.id === GENERAL_TEMPLATE_ID)).toEqual(before.template);
      expect(questionsOf(world, GENERAL_TEMPLATE_ID)).toEqual(before.questions);
    });

    it('returns the copy in the shape of getTemplate', async () => {
      const copy = await duplicateTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(copy).toMatchObject({ name: `${OWN_TEMPLATE_NAME}${COPY_SUFFIX}`, isGeneral: false, version: 1, hasRequests: false, milestones: [] });
      expect(textsOf(copy.questions)).toEqual(textsOf(OWN_QUESTIONS));
      expect(copy).toEqual(await getTemplate(world.prisma, TRAINER_ID, copy.id));
    });

    it('duplicates an own template that already has versions as a fresh version 1 without parent', async () => {
      seedOwnTemplate(world, { id: 'template-own-v3', version: 3, parentId: OWN_TEMPLATE_ID });

      const copy = await duplicateTemplate(world.prisma, TRAINER_ID, 'template-own-v3');

      const stored = world.rows(TEMPLATE_MODEL).find((row) => row.id === copy.id);
      expect(stored.version).toBe(1);
      expect(stored.parentId ?? null).toBeNull();
    });

    it('truncates the name so the copy fits the name limit and still ends with the copy suffix', async () => {
      const longName = 'N'.repeat(STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength);
      seedOwnTemplate(world, { id: 'template-long', name: longName });

      const copy = await duplicateTemplate(world.prisma, TRAINER_ID, 'template-long');

      expect(copy.name).toHaveLength(STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength);
      expect(copy.name.endsWith(COPY_SUFFIX)).toBe(true);
      expect(copy.name.startsWith('NNN')).toBe(true);
    });

    it('does not point any milestone at the copy', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });

      await duplicateTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(storedMilestoneTemplates(world)).toMatchObject({ d7: OWN_TEMPLATE_ID, d15: null, d21: null, d30: null, recurring: null });
    });

    it.each([
      ['a template of another trainer', OTHER_TEMPLATE_ID],
      ['a template that does not exist', UNKNOWN_TEMPLATE_ID],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for %s and creates nothing', async (_scenario, templateId) => {
      const before = snapshotTemplates(world);

      await expect(duplicateTemplate(world.prisma, TRAINER_ID, templateId)).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a deleted own template', async () => {
      seedOwnTemplate(world, { id: 'template-deleted', deletedAt: DELETED_AT });

      await expect(duplicateTemplate(world.prisma, TRAINER_ID, 'template-deleted')).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));
    });
  });

  describe('saveTemplate on a template that is not editable', () => {
    it('answers STUDENT_FEEDBACK_TEMPLATE_READ_ONLY for the general template and writes nothing', async () => {
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, GENERAL_TEMPLATE_ID, savePayload())).rejects.toMatchObject(templateError('READ_ONLY', HTTP_FORBIDDEN));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it.each([
      ['a template of another trainer', OTHER_TEMPLATE_ID],
      ['a template that does not exist', UNKNOWN_TEMPLATE_ID],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for %s and writes nothing', async (_scenario, templateId) => {
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, templateId, savePayload())).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a version that was already replaced', async () => {
      seedOwnTemplate(world, { id: 'template-retired', deletedAt: DELETED_AT });
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, 'template-retired', savePayload())).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));

      expect(snapshotTemplates(world)).toEqual(before);
    });
  });

  describe('saveTemplate on an own template without requests', () => {
    it('updates the template in place, keeping its id and version', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(saved).toMatchObject({ id: OWN_TEMPLATE_ID, name: NEW_NAME, version: 1, isGeneral: false, hasRequests: false });
      expect(liveTemplatesOf(world)).toHaveLength(1);
      expect(liveTemplatesOf(world)[0]).toMatchObject({ id: OWN_TEMPLATE_ID, name: NEW_NAME, version: 1, trainerId: TRAINER_ID });
      expect(world.rows(TEMPLATE_MODEL).filter((row) => row.trainerId === TRAINER_ID)).toHaveLength(1);
    });

    it('replaces the questions with the ones sent, in the order sent', async () => {
      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      const stored = questionsOf(world, OWN_TEMPLATE_ID);
      expect(textsOf(stored)).toEqual(textsOf(NEW_QUESTIONS));
      expect(stored[0]).toMatchObject({ helpText: 'De 0 a 10', type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.ROUTINE, required: true, invertScore: true, minLabel: 'Nada', maxLabel: 'Exausto' });
      expect(stored[1]).toMatchObject({ type: StudentFeedbackQuestionType.STARS, condition: StudentFeedbackQuestionCondition.HAS_MEAL_PLAN, invertScore: false });
      expect(stored[2]).toMatchObject({ type: StudentFeedbackQuestionType.OPEN, required: false });
    });

    it('returns the saved questions in order with increasing order numbers', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(textsOf(saved.questions)).toEqual(textsOf(NEW_QUESTIONS));
      expect(saved.questions[0].order).toBeLessThan(saved.questions[1].order);
      expect(saved.questions[1].order).toBeLessThan(saved.questions[2].order);
    });

    it('stores the optional fields left out as null', async () => {
      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      const open = questionsOf(world, OWN_TEMPLATE_ID)[2];
      expect(open.helpText ?? null).toBeNull();
      expect(open.condition ?? null).toBeNull();
      expect(open.minLabel ?? null).toBeNull();
      expect(open.maxLabel ?? null).toBeNull();
    });

    it('accepts a single question', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload({ questions: [{ ...NEW_QUESTIONS[2] }] }));

      expect(saved.questions).toHaveLength(1);
      expect(questionsOf(world, OWN_TEMPLATE_ID)).toHaveLength(1);
    });

    it('keeps the milestones pointing at the template', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });

      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(storedMilestoneTemplates(world).d7).toBe(OWN_TEMPLATE_ID);
      expect(saved.milestones).toEqual([StudentFeedbackMilestone.D7]);
    });

    it('drops the end labels sent on a question that is not a score', async () => {
      const questions = [
        { ...NEW_QUESTIONS[1], minLabel: 'Pouco', maxLabel: 'Muito' },
        { ...NEW_QUESTIONS[2], minLabel: 'Pouco', maxLabel: 'Muito' },
      ];

      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload({ questions }));

      for (const question of [...saved.questions, ...questionsOf(world, OWN_TEMPLATE_ID)]) {
        expect(question.minLabel ?? null).toBeNull();
        expect(question.maxLabel ?? null).toBeNull();
      }
    });

    it('does not touch the template of another trainer', async () => {
      const before = structuredClone(questionsOf(world, OTHER_TEMPLATE_ID));

      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(questionsOf(world, OTHER_TEMPLATE_ID)).toEqual(before);
      expect(world.rows(TEMPLATE_MODEL).find((row) => row.id === OTHER_TEMPLATE_ID).name).toBe(OTHER_TEMPLATE_NAME);
    });
  });

  describe('saveTemplate on an own template that already has a request', () => {
    let request;

    beforeEach(() => {
      seedLink(world, { createdAt: new Date('2026-09-01T15:00:00Z') });
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, d30TemplateId: OWN_TEMPLATE_ID, d15TemplateId: 'template-second' });
      seedOwnTemplate(world, { id: 'template-second', name: 'Outro modelo' });
      request = seedAnsweredRequest(world, OWN_TEMPLATE_ID, { readAt: READ_AT });
    });

    it('creates a new row as the next version, child of the previous one', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      const successor = successorOf(world, OWN_TEMPLATE_ID);
      expect(saved.id).not.toBe(OWN_TEMPLATE_ID);
      expect(successor).toMatchObject({ id: saved.id, trainerId: TRAINER_ID, isGeneral: false, version: 2, parentId: OWN_TEMPLATE_ID, name: NEW_NAME });
      expect(successor.deletedAt ?? null).toBeNull();
    });

    it('returns the new version with the saved questions and no request yet', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(saved).toMatchObject({ name: NEW_NAME, version: 2, isGeneral: false, hasRequests: false });
      expect(textsOf(saved.questions)).toEqual(textsOf(NEW_QUESTIONS));
      expect(textsOf(questionsOf(world, saved.id))).toEqual(textsOf(NEW_QUESTIONS));
    });

    it('retires the previous row', async () => {
      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      const previous = world.rows(TEMPLATE_MODEL).find((row) => row.id === OWN_TEMPLATE_ID);
      expect(previous.deletedAt).toBeInstanceOf(Date);
    });

    it('keeps the name, version and questions of the previous row', async () => {
      const questionsBefore = structuredClone(questionsOf(world, OWN_TEMPLATE_ID));

      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      const previous = world.rows(TEMPLATE_MODEL).find((row) => row.id === OWN_TEMPLATE_ID);
      expect(previous).toMatchObject({ name: OWN_TEMPLATE_NAME, version: 1, trainerId: TRAINER_ID });
      expect(questionsOf(world, OWN_TEMPLATE_ID)).toEqual(questionsBefore);
    });

    it('moves every milestone that pointed at the previous row to the new one and leaves the others', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(storedMilestoneTemplates(world)).toEqual({ d7: saved.id, d15: 'template-second', d21: null, d30: saved.id, recurring: null });
      expect(saved.milestones).toEqual([StudentFeedbackMilestone.D7, StudentFeedbackMilestone.D30]);
    });

    it('leaves the request already sent on the previous row with its scores', async () => {
      const before = structuredClone(request);

      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
      expect(world.rows(REQUEST_MODEL)[0]).toEqual(before);
      expect(world.rows(REQUEST_MODEL)[0].templateId).toBe(OWN_TEMPLATE_ID);
    });

    it('keeps showing the student the title and questions the request was sent with', async () => {
      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, new Date('2026-10-12T12:00:00Z'));

      expect(feedback.title).toBe(OWN_TEMPLATE_NAME);
      expect(textsOf(feedback.questions)).toEqual(textsOf(OWN_QUESTIONS));
    });

    it('shows only the new version in the list', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      const templates = await listTemplates(world.prisma, TRAINER_ID);

      expect(templates.map((template) => template.id)).toEqual([GENERAL_TEMPLATE_ID, saved.id, 'template-second']);
    });

    it('creates version 3 from version 2 once version 2 has a request', async () => {
      const second = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());
      seedAnsweredRequest(world, second.id, { sentAt: new Date('2026-10-20T12:00:00Z'), dueAt: null });

      const third = await saveTemplate(world.prisma, TRAINER_ID, second.id, savePayload({ name: 'Terceira' }));

      expect(world.rows(TEMPLATE_MODEL).find((row) => row.id === third.id)).toMatchObject({ version: 3, parentId: second.id, name: 'Terceira' });
      expect(liveTemplatesOf(world).map((row) => row.id).sort()).toEqual([third.id, 'template-second'].sort());
    });

    it('edits the new version in place while it has no request', async () => {
      const second = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      const again = await saveTemplate(world.prisma, TRAINER_ID, second.id, savePayload({ name: 'Ajuste' }));

      expect(again).toMatchObject({ id: second.id, version: 2, name: 'Ajuste' });
    });

    it('does not repoint the milestones of another trainer', async () => {
      seedTemplateConfig(world, { trainerId: OTHER_TRAINER_ID, d7TemplateId: OTHER_TEMPLATE_ID });

      await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(storedMilestoneTemplates(world, OTHER_TRAINER_ID).d7).toBe(OTHER_TEMPLATE_ID);
    });

    it('creates a new version even when the only request is still pending', async () => {
      world.rows(REQUEST_MODEL)[0].status = 'pending';

      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload());

      expect(saved.id).not.toBe(OWN_TEMPLATE_ID);
      expect(saved.version).toBe(2);
    });
  });

  describe('saveTemplate validation', () => {
    it('answers STUDENT_FEEDBACK_TEMPLATE_INVALID for invertScore on an open question and writes nothing', async () => {
      const questions = [{ ...NEW_QUESTIONS[0] }, { ...NEW_QUESTIONS[2], invertScore: true }];
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload({ questions }))).rejects.toMatchObject(templateError('INVALID', HTTP_BAD_REQUEST));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('creates no new version for an invalid payload on a template with requests', async () => {
      seedLink(world, { createdAt: new Date('2026-09-01T15:00:00Z') });
      seedAnsweredRequest(world, OWN_TEMPLATE_ID);
      const questions = [{ ...NEW_QUESTIONS[2], invertScore: true }];
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload({ questions }))).rejects.toMatchObject(templateError('INVALID', HTTP_BAD_REQUEST));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it.each([
      ['score', 0],
      ['stars', 1],
    ])('accepts invertScore on a %s question', async (_type, index) => {
      const questions = [{ ...NEW_QUESTIONS[index], condition: null, invertScore: true }];

      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload({ questions }));

      expect(saved.questions[0].invertScore).toBe(true);
    });
  });

  describe('deleteTemplate', () => {
    it('removes an own template from the list', async () => {
      await deleteTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      const templates = await listTemplates(world.prisma, TRAINER_ID);
      expect(templates.map((template) => template.id)).toEqual([GENERAL_TEMPLATE_ID]);
    });

    it('marks the row as deleted instead of removing it', async () => {
      await deleteTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      const stored = world.rows(TEMPLATE_MODEL).find((row) => row.id === OWN_TEMPLATE_ID);
      expect(stored.deletedAt).toBeInstanceOf(Date);
      expect(questionsOf(world, OWN_TEMPLATE_ID)).toHaveLength(OWN_QUESTIONS.length);
    });

    it('sends the milestones that used it back to the general template', async () => {
      seedOwnTemplate(world, { id: 'template-second', name: 'Outro modelo' });
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID, d15TemplateId: 'template-second', recurringTemplateId: OWN_TEMPLATE_ID });

      await deleteTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(storedMilestoneTemplates(world)).toEqual({ d7: null, d15: 'template-second', d21: null, d30: null, recurring: null });
      const [general] = await listTemplates(world.prisma, TRAINER_ID);
      expect(general.milestones).toEqual([StudentFeedbackMilestone.D7, StudentFeedbackMilestone.D21, StudentFeedbackMilestone.D30, StudentFeedbackMilestone.RECURRING]);
    });

    it('leaves the requests already sent untouched and readable by the student', async () => {
      seedLink(world, { createdAt: new Date('2026-09-01T15:00:00Z') });
      const request = seedAnsweredRequest(world, OWN_TEMPLATE_ID);
      const before = structuredClone(request);

      await deleteTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      expect(world.rows(REQUEST_MODEL)[0]).toEqual(before);
      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, new Date('2026-10-12T12:00:00Z'));
      expect(feedback.title).toBe(OWN_TEMPLATE_NAME);
      expect(textsOf(feedback.questions)).toEqual(textsOf(OWN_QUESTIONS));
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_READ_ONLY for the general template and deletes nothing', async () => {
      const before = snapshotTemplates(world);

      await expect(deleteTemplate(world.prisma, TRAINER_ID, GENERAL_TEMPLATE_ID)).rejects.toMatchObject(templateError('READ_ONLY', HTTP_FORBIDDEN));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it.each([
      ['a template of another trainer', OTHER_TEMPLATE_ID],
      ['a template that does not exist', UNKNOWN_TEMPLATE_ID],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for %s and deletes nothing', async (_scenario, templateId) => {
      seedTemplateConfig(world, { trainerId: OTHER_TRAINER_ID, d7TemplateId: OTHER_TEMPLATE_ID });
      const before = snapshotTemplates(world);

      await expect(deleteTemplate(world.prisma, TRAINER_ID, templateId)).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND when the template was already deleted', async () => {
      await deleteTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID);

      await expect(deleteTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID)).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));
    });
  });
});
