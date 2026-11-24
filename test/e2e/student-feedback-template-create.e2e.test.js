import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import {
  STUDENT_FEEDBACK_TEMPLATE_LIMITS,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const TEMPLATES_URL = '/trainer/student-feedbacks/templates';
const GENERAL_NAME = 'Padrão TeuFit';
const NEW_NAME = 'Check-in mensal';
const COPY_SUFFIX = ' (cópia)';
const UNKNOWN_TEMPLATE_ID = '99999999-9999-4999-8999-999999999999';
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const COPIED_QUESTION_FIELDS = ['order', 'text', 'helpText', 'type', 'pillar', 'required', 'condition', 'invertScore', 'minLabel', 'maxLabel'];
const FALLBACK_QUESTIONS = [
  { order: 1, text: 'Como foi tua adesão aos treinos?', type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.TRAINING_ADHERENCE, required: true },
  { order: 2, text: 'Como está teu sono?', type: StudentFeedbackQuestionType.STARS, pillar: StudentFeedbackPillar.SLEEP, required: true },
  { order: 3, text: 'Quer contar algo ao teu treinador?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.REPORT, required: false },
];
const OWN_QUESTIONS = [
  { text: 'Quão cansado ficaste?', helpText: 'De 0 a 10', type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.ROUTINE, required: true, invertScore: true, minLabel: 'Nada', maxLabel: 'Exausto' },
  { text: 'Quer contar algo?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.REPORT, required: false, invertScore: false },
];

let counter = 0;

// Authorization header of a token
function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

// Signs a user up through the real flow and returns its id and access token
async function signUp(app, prefix) {
  counter += 1;
  const email = `e2e+${prefix}-${Date.now()}-${counter}@example.com`;
  const res = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { userId: body.user.id, token: body.token.accessToken };
}

// Signs a user up and turns it into a trainer
async function createTrainer(app) {
  const { userId, token } = await signUp(app, 'feedback-create-trainer');
  const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: bearer(token) });
  expect(become.statusCode).toBe(200);
  const trainer = await prisma.trainer.findUnique({ where: { userId } });
  return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
}

// Makes sure a general template exists: the migration seeds it, but a cascading truncate may have removed it
async function ensureGeneralTemplate() {
  const existing = await prisma.studentFeedbackTemplate.findFirst({ where: { isGeneral: true } });
  if (existing) return;
  await prisma.studentFeedbackTemplate.create({
    data: { isGeneral: true, name: GENERAL_NAME, version: 1, questions: { create: FALLBACK_QUESTIONS } },
  });
}

// Calls a trainer endpoint with the token of the trainer
function asTrainer(app, trainer, method, url, payload) {
  return app.inject({ method, url, headers: bearer(trainer.token), payload });
}

// Sends the create request as the trainer
function create(app, trainer, payload) {
  return asTrainer(app, trainer, 'POST', TEMPLATES_URL, payload);
}

// Reads a template as the trainer
async function readTemplate(app, trainer, templateId) {
  const res = await asTrainer(app, trainer, 'GET', `${TEMPLATES_URL}/${templateId}`);
  expect(res.statusCode).toBe(200);
  return res.json().template;
}

// The general template with its questions, as the trainer reads it
async function readGeneralTemplate(app, trainer) {
  const list = await asTrainer(app, trainer, 'GET', TEMPLATES_URL);
  expect(list.statusCode).toBe(200);
  return readTemplate(app, trainer, list.json().templates.find((template) => template.isGeneral).id);
}

// An own template of the trainer with its own name and questions, built through the existing duplicate and save endpoints
async function createOwnTemplate(app, trainer, name) {
  const general = await readGeneralTemplate(app, trainer);
  const copy = await asTrainer(app, trainer, 'POST', `${TEMPLATES_URL}/${general.id}/duplicate`);
  expect(copy.statusCode).toBe(201);
  const saved = await asTrainer(app, trainer, 'PUT', `${TEMPLATES_URL}/${copy.json().template.id}`, { name, questions: OWN_QUESTIONS });
  expect(saved.statusCode).toBe(200);
  return saved.json().template;
}

// The fields a new template must carry over from each question of its source
function copiedFieldsOf(questions) {
  return questions.map((question) => Object.fromEntries(COPIED_QUESTION_FIELDS.map((field) => [field, question[field]])));
}

// Number of templates stored for a trainer, deleted ones included
function countTemplatesOf(trainer) {
  return prisma.studentFeedbackTemplate.count({ where: { trainerId: trainer.trainerId } });
}

// Asserts the unified error contract with a template code
function expectTemplateError(res, statusCode, key) {
  expect(res.statusCode).toBe(statusCode);
  const body = res.json();
  expect(body).toMatchObject({ error: StudentFeedbackTemplateErrorCode[key], messageCode: StudentFeedbackTemplateMessageCode[key] });
  expect(typeof body.message).toBe('string');
  expect(body).toHaveProperty('details');
}

e2eDescribe('e2e: student feedback template creation (criterion 28)', () => {
  let app;
  let trainer;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await ensureGeneralTemplate();
    trainer = await createTrainer(app);
  });

  describe('without a source template', () => {
    it('creates an own template, version 1, with one starter question', async () => {
      const res = await create(app, trainer, { name: NEW_NAME });

      expect(res.statusCode).toBe(201);
      const { template } = res.json();
      expect(template).toMatchObject({ name: NEW_NAME, isGeneral: false, version: 1, hasRequests: false, milestones: [] });
      expect(template.questions).toHaveLength(1);
      expect(template.questions[0]).toMatchObject({
        order: 1,
        type: StudentFeedbackQuestionType.SCORE,
        pillar: StudentFeedbackPillar.OTHER,
        required: true,
        condition: null,
        invertScore: false,
      });
      expect(template.questions[0].text.trim().length).toBeGreaterThan(0);
      expect(template.questions[0].typeLabel.length).toBeGreaterThan(0);
      expect(template.questions[0].pillarLabel.length).toBeGreaterThan(0);
    });

    it('stores the template for the trainer and answers in the exact shape of the read endpoint', async () => {
      const res = await create(app, trainer, { name: `  ${NEW_NAME}  ` });

      expect(res.statusCode).toBe(201);
      const { template } = res.json();
      const stored = await prisma.studentFeedbackTemplate.findUnique({ where: { id: template.id } });
      expect(stored).toMatchObject({ trainerId: trainer.trainerId, name: NEW_NAME, isGeneral: false, version: 1, parentId: null, deletedAt: null });
      expect(await prisma.studentFeedbackQuestion.count({ where: { templateId: template.id } })).toBe(1);
      expect(await readTemplate(app, trainer, template.id)).toEqual(template);
    });

    it('lets the trainer save the new template as it came, so the starter question is a valid one', async () => {
      const { template } = (await create(app, trainer, { name: NEW_NAME })).json();
      const [{ text, type, pillar, required, condition, invertScore }] = template.questions;

      const res = await asTrainer(app, trainer, 'PUT', `${TEMPLATES_URL}/${template.id}`, { name: NEW_NAME, questions: [{ text, type, pillar, required, condition, invertScore }] });

      expect(res.statusCode).toBe(200);
      expect(res.json().template).toMatchObject({ id: template.id, version: 1 });
    });

    it('lists the new template for its trainer only', async () => {
      const other = await createTrainer(app);

      const { template } = (await create(app, trainer, { name: NEW_NAME })).json();

      const mine = (await asTrainer(app, trainer, 'GET', TEMPLATES_URL)).json().templates;
      const theirs = (await asTrainer(app, other, 'GET', TEMPLATES_URL)).json().templates;
      expect(mine.find((item) => item.id === template.id)).toMatchObject({ name: NEW_NAME, isGeneral: false, version: 1, questionCount: 1, milestones: [] });
      expect(theirs.map((item) => item.id)).not.toContain(template.id);
    });
  });

  describe('from a source template', () => {
    it('copies the questions of the general template under the given name', async () => {
      const general = await readGeneralTemplate(app, trainer);

      const res = await create(app, trainer, { name: NEW_NAME, sourceTemplateId: general.id });

      expect(res.statusCode).toBe(201);
      const { template } = res.json();
      expect(template.id).not.toBe(general.id);
      expect(template).toMatchObject({ name: NEW_NAME, isGeneral: false, version: 1, hasRequests: false, milestones: [] });
      expect(copiedFieldsOf(template.questions)).toEqual(copiedFieldsOf(general.questions));
      expect(await readTemplate(app, trainer, template.id)).toEqual(template);
      expect(await readGeneralTemplate(app, trainer)).toEqual(general);
    });

    it('copies the questions of an own template under the given name, without the copy suffix', async () => {
      const own = await createOwnTemplate(app, trainer, 'Modelo de origem');

      const res = await create(app, trainer, { name: NEW_NAME, sourceTemplateId: own.id });

      expect(res.statusCode).toBe(201);
      const { template } = res.json();
      expect(template.id).not.toBe(own.id);
      expect(template.name).toBe(NEW_NAME);
      expect(template).toMatchObject({ isGeneral: false, version: 1, hasRequests: false, milestones: [] });
      expect(copiedFieldsOf(template.questions)).toEqual(copiedFieldsOf(own.questions));
      expect(await readTemplate(app, trainer, own.id)).toEqual(own);
    });

    it('answers 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for the template of another trainer and writes nothing', async () => {
      const other = await createTrainer(app);
      const theirs = await createOwnTemplate(app, other, 'Modelo da Paula');

      const res = await create(app, trainer, { name: NEW_NAME, sourceTemplateId: theirs.id });

      expectTemplateError(res, 404, 'NOT_FOUND');
      expect(await countTemplatesOf(trainer)).toBe(0);
      expect(await countTemplatesOf(other)).toBe(1);
    });

    it('answers 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a deleted own template and writes nothing', async () => {
      const own = await createOwnTemplate(app, trainer, 'Modelo apagado');
      const deleted = await asTrainer(app, trainer, 'DELETE', `${TEMPLATES_URL}/${own.id}`);
      expect(deleted.statusCode).toBe(204);

      const res = await create(app, trainer, { name: NEW_NAME, sourceTemplateId: own.id });

      expectTemplateError(res, 404, 'NOT_FOUND');
      expect(await countTemplatesOf(trainer)).toBe(1);
    });

    it('answers 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a source that does not exist and writes nothing', async () => {
      const res = await create(app, trainer, { name: NEW_NAME, sourceTemplateId: UNKNOWN_TEMPLATE_ID });

      expectTemplateError(res, 404, 'NOT_FOUND');
      expect(await countTemplatesOf(trainer)).toBe(0);
    });
  });

  describe('refused requests', () => {
    it('answers 400 STUDENT_FEEDBACK_TEMPLATE_INVALID for a name of spaces only and writes nothing', async () => {
      const res = await create(app, trainer, { name: '   ' });

      expectTemplateError(res, 400, 'INVALID');
      expect(await countTemplatesOf(trainer)).toBe(0);
    });

    it('answers 400 for a name over the limit and writes nothing', async () => {
      const res = await create(app, trainer, { name: 'N'.repeat(STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength + 1) });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.any(String), messageCode: expect.any(String), message: expect.any(String) });
      expect(await countTemplatesOf(trainer)).toBe(0);
    });

    it('answers 400 validation.failed for a body without name and writes nothing', async () => {
      const general = await readGeneralTemplate(app, trainer);

      const res = await create(app, trainer, { sourceTemplateId: general.id });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: VALIDATION_ERROR, messageCode: VALIDATION_MESSAGE_CODE });
      expect(await countTemplatesOf(trainer)).toBe(0);
    });

    it('rejects a user who is not a trainer with 403 and a call without token with 401', async () => {
      const student = await signUp(app, 'feedback-create-student');

      const forbidden = await app.inject({ method: 'POST', url: TEMPLATES_URL, headers: bearer(student.token), payload: { name: NEW_NAME } });
      const anonymous = await app.inject({ method: 'POST', url: TEMPLATES_URL, payload: { name: NEW_NAME } });

      expect(forbidden.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
      expect(await prisma.studentFeedbackTemplate.count({ where: { isGeneral: false } })).toBe(0);
    });
  });

  describe('the duplicate endpoint next to it', () => {
    it('still names the duplicate of a created template as a copy', async () => {
      const { template } = (await create(app, trainer, { name: NEW_NAME })).json();

      const res = await asTrainer(app, trainer, 'POST', `${TEMPLATES_URL}/${template.id}/duplicate`);

      expect(res.statusCode).toBe(201);
      expect(res.json().template.id).not.toBe(template.id);
      expect(res.json().template).toMatchObject({ name: `${NEW_NAME}${COPY_SUFFIX}`, version: 1, hasRequests: false, milestones: [] });
      expect(copiedFieldsOf(res.json().template.questions)).toEqual(copiedFieldsOf(template.questions));
    });
  });
});
