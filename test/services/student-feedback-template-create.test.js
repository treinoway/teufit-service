import { beforeEach, describe, expect, it } from 'vitest';
import * as templateService from '../../src/services/student-feedback-template-service.js';
import {
  STUDENT_FEEDBACK_TEMPLATE_LIMITS,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import { OTHER_TRAINER_ID, TEMPLATE_NAME } from '../helpers/student-feedback-world.js';
import {
  GENERAL_TEMPLATE_ID,
  OTHER_TEMPLATE_ID,
  OTHER_TEMPLATE_NAME,
  OWN_QUESTIONS,
  OWN_TEMPLATE_ID,
  OWN_TEMPLATE_NAME,
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

const { duplicateTemplate, getTemplate, listTemplates } = templateService;

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const COPY_SUFFIX = ' (cópia)';
const NEW_NAME = 'Check-in mensal';
const DELETED_AT = new Date('2026-10-20T12:00:00Z');
const COPIED_QUESTION_FIELDS = ['order', 'text', 'helpText', 'type', 'pillar', 'required', 'condition', 'invertScore', 'minLabel', 'maxLabel'];

// Calls the planned createTemplate export; while it is missing each test fails on its own instead of the whole file failing at import
function createTemplate(...args) {
  return templateService.createTemplate(...args);
}

// Expectation of a rejection with a template error of the unified contract
function templateError(key, httpStatus) {
  return {
    httpStatus,
    error: StudentFeedbackTemplateErrorCode[key],
    messageCode: StudentFeedbackTemplateMessageCode[key],
  };
}

// Stored template row with the given id
function storedTemplate(world, id) {
  return world.rows(TEMPLATE_MODEL).find((row) => row.id === id);
}

// The fields a copy must carry over from each question, with missing optional ones read as their defaults
function copiedFieldsOf(questions) {
  return questions.map((question) => Object.fromEntries(COPIED_QUESTION_FIELDS.map((field) => [field, question[field] ?? null])));
}

describe('student feedback template service: createTemplate', () => {
  let world;

  beforeEach(() => {
    world = createTemplateWorld();
    seedOwnTemplate(world);
    seedOwnTemplate(world, { id: OTHER_TEMPLATE_ID, trainerId: OTHER_TRAINER_ID, name: OTHER_TEMPLATE_NAME });
  });

  describe('without a source template', () => {
    it('stores a new own template of the trainer, version 1, live and without parent', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      const stored = storedTemplate(world, created.id);
      expect([GENERAL_TEMPLATE_ID, OWN_TEMPLATE_ID, OTHER_TEMPLATE_ID]).not.toContain(created.id);
      expect(stored).toMatchObject({ trainerId: TRAINER_ID, isGeneral: false, version: 1, name: NEW_NAME });
      expect(stored.parentId ?? null).toBeNull();
      expect(stored.deletedAt ?? null).toBeNull();
    });

    it('returns the template as own, version 1, without requests and without milestones', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      expect(created).toMatchObject({ name: NEW_NAME, isGeneral: false, version: 1, hasRequests: false, milestones: [] });
    });

    it('creates exactly one starter question', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      expect(created.questions).toHaveLength(1);
      expect(questionsOf(world, created.id)).toHaveLength(1);
    });

    it('makes the starter question a required score of the pillar other, without condition and not inverted', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      const expected = {
        order: 1,
        type: StudentFeedbackQuestionType.SCORE,
        pillar: StudentFeedbackPillar.OTHER,
        required: true,
        condition: null,
        invertScore: false,
      };
      expect(created.questions[0]).toMatchObject(expected);
      const [stored] = questionsOf(world, created.id);
      expect({ ...stored, condition: stored.condition ?? null, invertScore: stored.invertScore ?? false }).toMatchObject(expected);
    });

    it('gives the starter question a non-blank text that fits the question text limit', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      const [{ text }] = created.questions;
      expect(typeof text).toBe('string');
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(STUDENT_FEEDBACK_TEMPLATE_LIMITS.questionTextMaxLength);
      expect(questionsOf(world, created.id)[0].text).toBe(text);
    });

    it('returns the template in the exact shape of getTemplate', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      expect(created).toEqual(await getTemplate(world.prisma, TRAINER_ID, created.id));
      expect(Object.keys(created).sort()).toEqual(['hasRequests', 'id', 'isGeneral', 'milestones', 'name', 'questions', 'version']);
    });

    it('lists the new template among the own templates of the trainer', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      const templates = await listTemplates(world.prisma, TRAINER_ID);
      expect(templates.find((template) => template.id === created.id)).toMatchObject({ name: NEW_NAME, isGeneral: false, version: 1, questionCount: 1, milestones: [] });
    });

    it('stores the name trimmed', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: `  ${NEW_NAME}  ` });

      expect(created.name).toBe(NEW_NAME);
      expect(storedTemplate(world, created.id).name).toBe(NEW_NAME);
    });

    it('accepts a name exactly at the name limit', async () => {
      const name = 'N'.repeat(STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength);

      const created = await createTemplate(world.prisma, TRAINER_ID, { name });

      expect(created.name).toBe(name);
    });

    it('does not point any milestone at the new template', async () => {
      seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });

      await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      expect(storedMilestoneTemplates(world)).toEqual({ d7: OWN_TEMPLATE_ID, d15: null, d21: null, d30: null, recurring: null });
    });

    it('adds one template and leaves every existing template and question as it was', async () => {
      const before = snapshotTemplates(world);

      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME });

      const after = snapshotTemplates(world);
      expect(after.templates.filter((row) => row.id !== created.id)).toEqual(before.templates);
      expect(after.questions.filter((row) => row.templateId !== created.id)).toEqual(before.questions);
      expect(liveTemplatesOf(world, OTHER_TRAINER_ID).map((row) => row.id)).toEqual([OTHER_TEMPLATE_ID]);
    });
  });

  describe('from a source template', () => {
    it.each([
      ['the general template', GENERAL_TEMPLATE_ID],
      ['an own template', OWN_TEMPLATE_ID],
    ])('copies the questions of %s in order, with every field', async (_scenario, sourceTemplateId) => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId });

      const original = questionsOf(world, sourceTemplateId);
      const copied = questionsOf(world, created.id);
      expect(copiedFieldsOf(copied)).toEqual(copiedFieldsOf(original));
      expect(copiedFieldsOf(created.questions)).toEqual(copiedFieldsOf(original));
      copied.forEach((question, index) => expect(question.id).not.toBe(original[index].id));
    });

    it.each([
      ['the general template', GENERAL_TEMPLATE_ID, TEMPLATE_NAME],
      ['an own template', OWN_TEMPLATE_ID, OWN_TEMPLATE_NAME],
    ])('names the template created from %s with the given name, not as a copy', async (_scenario, sourceTemplateId, sourceName) => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: `  ${NEW_NAME} ` , sourceTemplateId });

      expect(created.name).toBe(NEW_NAME);
      expect(created.name).not.toContain(COPY_SUFFIX);
      expect(storedTemplate(world, created.id).name).toBe(NEW_NAME);
      expect(storedTemplate(world, sourceTemplateId).name).toBe(sourceName);
    });

    it('stores the template created from the general one as an own live template, version 1', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId: GENERAL_TEMPLATE_ID });

      const stored = storedTemplate(world, created.id);
      expect(created.id).not.toBe(GENERAL_TEMPLATE_ID);
      expect(stored).toMatchObject({ trainerId: TRAINER_ID, isGeneral: false, version: 1 });
      expect(stored.deletedAt ?? null).toBeNull();
      expect(created).toMatchObject({ isGeneral: false, version: 1, hasRequests: false, milestones: [] });
    });

    it('starts at version 1 without requests even when the source has versions, requests and milestones', async () => {
      seedOwnTemplate(world, { id: 'template-own-v3', version: 3, parentId: OWN_TEMPLATE_ID });
      seedAnsweredRequest(world, 'template-own-v3');
      seedTemplateConfig(world, { d7TemplateId: 'template-own-v3' });

      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId: 'template-own-v3' });

      expect(created).toMatchObject({ version: 1, hasRequests: false, milestones: [] });
      expect(storedTemplate(world, created.id).version).toBe(1);
      expect(storedMilestoneTemplates(world).d7).toBe('template-own-v3');
    });

    it('returns the template in the exact shape of getTemplate', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId: OWN_TEMPLATE_ID });

      expect(created.questions).toHaveLength(OWN_QUESTIONS.length);
      expect(created).toEqual(await getTemplate(world.prisma, TRAINER_ID, created.id));
    });

    it('leaves the source template and its questions untouched', async () => {
      const before = snapshotTemplates(world);

      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId: GENERAL_TEMPLATE_ID });

      const after = snapshotTemplates(world);
      expect(after.templates.filter((row) => row.id !== created.id)).toEqual(before.templates);
      expect(after.questions.filter((row) => row.templateId !== created.id)).toEqual(before.questions);
    });

    it.each([
      ['a template of another trainer', OTHER_TEMPLATE_ID],
      ['a template that does not exist', UNKNOWN_TEMPLATE_ID],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for %s as source and writes nothing', async (_scenario, sourceTemplateId) => {
      const before = snapshotTemplates(world);

      await expect(createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId })).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a deleted own template as source and writes nothing', async () => {
      seedOwnTemplate(world, { id: 'template-deleted', deletedAt: DELETED_AT });
      const before = snapshotTemplates(world);

      await expect(createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId: 'template-deleted' })).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a version that was already replaced and writes nothing', async () => {
      storedTemplate(world, OWN_TEMPLATE_ID).deletedAt = DELETED_AT;
      seedOwnTemplate(world, { id: 'template-own-v2', version: 2, parentId: OWN_TEMPLATE_ID });
      const before = snapshotTemplates(world);

      await expect(createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId: OWN_TEMPLATE_ID })).rejects.toMatchObject(templateError('NOT_FOUND', HTTP_NOT_FOUND));

      expect(snapshotTemplates(world)).toEqual(before);
    });
  });

  describe('name validation', () => {
    const TOO_LONG_NAME = 'N'.repeat(STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength + 1);

    it.each([
      ['an empty name', ''],
      ['a name of spaces only', '   '],
      ['a name over the limit', TOO_LONG_NAME],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_INVALID for %s without a source and writes nothing', async (_scenario, name) => {
      const before = snapshotTemplates(world);

      await expect(createTemplate(world.prisma, TRAINER_ID, { name })).rejects.toMatchObject(templateError('INVALID', HTTP_BAD_REQUEST));

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it.each([
      ['an empty name', ''],
      ['a name of spaces only', '   '],
      ['a name over the limit', TOO_LONG_NAME],
    ])('answers STUDENT_FEEDBACK_TEMPLATE_INVALID for %s with a usable source and writes nothing', async (_scenario, name) => {
      const before = snapshotTemplates(world);

      await expect(createTemplate(world.prisma, TRAINER_ID, { name, sourceTemplateId: GENERAL_TEMPLATE_ID })).rejects.toMatchObject(templateError('INVALID', HTTP_BAD_REQUEST));

      expect(snapshotTemplates(world)).toEqual(before);
    });
  });

  describe('duplicating afterwards', () => {
    it('still names the duplicate of a created template as a copy', async () => {
      const created = await createTemplate(world.prisma, TRAINER_ID, { name: NEW_NAME, sourceTemplateId: OWN_TEMPLATE_ID });

      const copy = await duplicateTemplate(world.prisma, TRAINER_ID, created.id);

      expect(copy.id).not.toBe(created.id);
      expect(copy).toMatchObject({ name: `${NEW_NAME}${COPY_SUFFIX}`, version: 1, hasRequests: false, milestones: [] });
      expect(copiedFieldsOf(copy.questions)).toEqual(copiedFieldsOf(created.questions));
    });
  });
});
