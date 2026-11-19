import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import {
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const DAY_MS = 86400000;
const PASSWORD = 'StrongPassw0rd!';
const TEMPLATES_URL = '/trainer/student-feedbacks/templates';
const MILESTONE_TEMPLATES_URL = '/trainer/student-feedbacks/milestone-templates';
const GENERAL_NAME = 'Padrão TeuFit';
const COPY_NAME = `${GENERAL_NAME} (cópia)`;
const NEW_NAME = 'Check-in quinzenal';
const OPEN_ANSWER_TEXT = 'Semana boa, só o sono que pesou';
const FALLBACK_QUESTIONS = [
  { order: 1, text: 'Como foi tua adesão aos treinos?', type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.TRAINING_ADHERENCE, required: true },
  { order: 2, text: 'Como está teu sono?', type: StudentFeedbackQuestionType.STARS, pillar: StudentFeedbackPillar.SLEEP, required: true },
  { order: 3, text: 'Quer contar algo ao teu treinador?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.REPORT, required: false },
];
const NEW_QUESTIONS = [
  { text: 'Quão cansado ficaste?', helpText: 'De 0 a 10', type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.ROUTINE, required: true, invertScore: true, minLabel: 'Nada', maxLabel: 'Exausto' },
  { text: 'Quer contar algo?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.REPORT, required: false, invertScore: false },
];
const SAVE_BODY = { name: NEW_NAME, questions: NEW_QUESTIONS };

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
  const { userId, token } = await signUp(app, 'feedback-template-trainer');
  const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: bearer(token) });
  expect(become.statusCode).toBe(200);
  const trainer = await prisma.trainer.findUnique({ where: { userId } });
  return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
}

// Signs a student up and links it to the trainer ten days ago
async function createStudent(app, trainerId) {
  const student = await signUp(app, 'feedback-template-student');
  await prisma.trainerStudent.create({ data: { trainerId, studentId: student.userId, createdAt: new Date(Date.now() - 10 * DAY_MS) } });
  return student;
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

// Templates the trainer sees in the list
async function listTemplates(app, trainer) {
  const res = await asTrainer(app, trainer, 'GET', TEMPLATES_URL);
  expect(res.statusCode).toBe(200);
  return res.json().templates;
}

// Id of the general template, as the trainer sees it
async function generalTemplateId(app, trainer) {
  const templates = await listTemplates(app, trainer);
  return templates.find((template) => template.isGeneral).id;
}

// Duplicates a template as the trainer and returns the copy
async function duplicate(app, trainer, templateId) {
  const res = await asTrainer(app, trainer, 'POST', `${TEMPLATES_URL}/${templateId}/duplicate`);
  expect(res.statusCode).toBe(201);
  return res.json().template;
}

// Saves a template as the trainer
function save(app, trainer, templateId, body = SAVE_BODY) {
  return asTrainer(app, trainer, 'PUT', `${TEMPLATES_URL}/${templateId}`, body);
}

// Sends an ad-hoc feedback with the given template and returns the created request
async function sendAdhocWith(app, trainer, studentId, templateId) {
  const res = await asTrainer(app, trainer, 'POST', `/trainer/students/${studentId}/feedbacks`, { templateId });
  expect(res.statusCode).toBe(201);
  return res.json();
}

// Reads a feedback as the student
async function readFeedback(app, student, id) {
  const res = await app.inject({ method: 'GET', url: `/my/feedbacks/${id}`, headers: bearer(student.token) });
  expect(res.statusCode).toBe(200);
  return res.json();
}

// A valid answer for a question, by its type
function answerFor(question) {
  if (question.type === StudentFeedbackQuestionType.SCORE) return { questionId: question.id, score: 8 };
  if (question.type === StudentFeedbackQuestionType.STARS) return { questionId: question.id, score: 4 };
  return { questionId: question.id, text: OPEN_ANSWER_TEXT };
}

// Answers every question of a feedback as the student
async function answerAll(app, student, id) {
  const { questions } = await readFeedback(app, student, id);
  const res = await app.inject({ method: 'POST', url: `/my/feedbacks/${id}/submit`, headers: bearer(student.token), payload: { answers: questions.map(answerFor) } });
  expect(res.statusCode).toBe(200);
}

// The feedback of the student in the history the trainer sees
async function historyItem(app, trainer, studentId, id) {
  const res = await asTrainer(app, trainer, 'GET', `/trainer/students/${studentId}/feedbacks`);
  expect(res.statusCode).toBe(200);
  return res.json().feedbacks.find((feedback) => feedback.id === id);
}

// Asserts the unified error contract with a template code
function expectTemplateError(res, statusCode, key) {
  expect(res.statusCode).toBe(statusCode);
  const body = res.json();
  expect(body).toMatchObject({ error: StudentFeedbackTemplateErrorCode[key], messageCode: StudentFeedbackTemplateMessageCode[key] });
  expect(typeof body.message).toBe('string');
  expect(body).toHaveProperty('details');
}

e2eDescribe('e2e: student feedback templates', () => {
  let app;
  let trainer;
  let student;

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
    student = await createStudent(app, trainer.trainerId);
  });

  describe('templates the trainer cannot change (criterion 17)', () => {
    it('refuses to save the general template with 403 STUDENT_FEEDBACK_TEMPLATE_READ_ONLY and leaves it as it was', async () => {
      const generalId = await generalTemplateId(app, trainer);
      const before = await prisma.studentFeedbackQuestion.findMany({ where: { templateId: generalId }, orderBy: { order: 'asc' } });

      const res = await save(app, trainer, generalId);

      expectTemplateError(res, 403, 'READ_ONLY');
      const stored = await prisma.studentFeedbackTemplate.findUnique({ where: { id: generalId } });
      expect(stored).toMatchObject({ name: GENERAL_NAME, isGeneral: true, deletedAt: null });
      expect(await prisma.studentFeedbackQuestion.findMany({ where: { templateId: generalId }, orderBy: { order: 'asc' } })).toEqual(before);
    });

    it('refuses to delete the general template with 403 STUDENT_FEEDBACK_TEMPLATE_READ_ONLY', async () => {
      const generalId = await generalTemplateId(app, trainer);

      const res = await asTrainer(app, trainer, 'DELETE', `${TEMPLATES_URL}/${generalId}`);

      expectTemplateError(res, 403, 'READ_ONLY');
      expect((await prisma.studentFeedbackTemplate.findUnique({ where: { id: generalId } })).deletedAt).toBeNull();
    });

    it('hides the template of another trainer behind 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND on read, save, duplicate and delete', async () => {
      const other = await createTrainer(app);
      const theirs = await duplicate(app, other, await generalTemplateId(app, other));

      const read = await asTrainer(app, trainer, 'GET', `${TEMPLATES_URL}/${theirs.id}`);
      const saved = await save(app, trainer, theirs.id);
      const copied = await asTrainer(app, trainer, 'POST', `${TEMPLATES_URL}/${theirs.id}/duplicate`);
      const deleted = await asTrainer(app, trainer, 'DELETE', `${TEMPLATES_URL}/${theirs.id}`);

      for (const res of [read, saved, copied, deleted]) expectTemplateError(res, 404, 'NOT_FOUND');
      const stored = await prisma.studentFeedbackTemplate.findUnique({ where: { id: theirs.id } });
      expect(stored).toMatchObject({ name: COPY_NAME, trainerId: other.trainerId, deletedAt: null });
    });

    it('never lists the template of another trainer', async () => {
      const other = await createTrainer(app);
      const theirs = await duplicate(app, other, await generalTemplateId(app, other));

      const templates = await listTemplates(app, trainer);

      expect(templates.map((template) => template.id)).not.toContain(theirs.id);
      expect(templates.filter((template) => template.isGeneral)).toHaveLength(1);
    });

    it('refuses the template of another trainer for a milestone and for an ad-hoc send', async () => {
      const other = await createTrainer(app);
      const theirs = await duplicate(app, other, await generalTemplateId(app, other));

      const milestone = await asTrainer(app, trainer, 'PUT', MILESTONE_TEMPLATES_URL, { d7: theirs.id });
      const adhoc = await asTrainer(app, trainer, 'POST', `/trainer/students/${student.userId}/feedbacks`, { templateId: theirs.id });

      expectTemplateError(milestone, 404, 'NOT_FOUND');
      expectTemplateError(adhoc, 404, 'NOT_FOUND');
      expect(await prisma.studentFeedbackRequest.count()).toBe(0);
    });

    it('rejects the template routes for a user who is not a trainer with 403', async () => {
      const res = await app.inject({ method: 'GET', url: TEMPLATES_URL, headers: bearer(student.token) });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('saving an own template (criteria 18 and 19)', () => {
    it('edits a template without requests in place', async () => {
      const copy = await duplicate(app, trainer, await generalTemplateId(app, trainer));

      const res = await save(app, trainer, copy.id);

      expect(res.statusCode).toBe(200);
      expect(res.json().template).toMatchObject({ id: copy.id, name: NEW_NAME, version: 1, hasRequests: false });
      expect(res.json().template.questions.map((question) => question.text)).toEqual(NEW_QUESTIONS.map((question) => question.text));
      expect(await prisma.studentFeedbackTemplate.count({ where: { trainerId: trainer.trainerId } })).toBe(1);
    });

    it('creates a new version once a request was sent, repoints the milestones and keeps the request as the student answered it', async () => {
      const copy = await duplicate(app, trainer, await generalTemplateId(app, trainer));
      const chosen = await asTrainer(app, trainer, 'PUT', MILESTONE_TEMPLATES_URL, { d7: copy.id, recurring: copy.id });
      expect(chosen.statusCode).toBe(200);
      const request = await sendAdhocWith(app, trainer, student.userId, copy.id);
      const sentFeedback = await readFeedback(app, student, request.id);
      await answerAll(app, student, request.id);
      const answeredBefore = await historyItem(app, trainer, student.userId, request.id);

      const res = await save(app, trainer, copy.id);

      expect(res.statusCode).toBe(200);
      const saved = res.json().template;
      expect(saved.id).not.toBe(copy.id);
      expect(saved).toMatchObject({ name: NEW_NAME, version: 2, isGeneral: false, hasRequests: false });
      expect(saved.milestones).toEqual([StudentFeedbackMilestone.D7, StudentFeedbackMilestone.RECURRING]);
      expect(saved.questions.map((question) => question.text)).toEqual(NEW_QUESTIONS.map((question) => question.text));

      const [previousRow, newRow] = await Promise.all([
        prisma.studentFeedbackTemplate.findUnique({ where: { id: copy.id } }),
        prisma.studentFeedbackTemplate.findUnique({ where: { id: saved.id } }),
      ]);
      expect(previousRow.deletedAt).not.toBeNull();
      expect(previousRow).toMatchObject({ name: COPY_NAME, version: 1 });
      expect(newRow).toMatchObject({ parentId: copy.id, trainerId: trainer.trainerId, version: 2, isGeneral: false, deletedAt: null });

      const milestones = await asTrainer(app, trainer, 'GET', MILESTONE_TEMPLATES_URL);
      expect(milestones.json()).toEqual({ milestoneTemplates: { d7: saved.id, d15: null, d21: null, d30: null, recurring: saved.id } });

      const listed = (await listTemplates(app, trainer)).map((template) => template.id);
      expect(listed).toContain(saved.id);
      expect(listed).not.toContain(copy.id);

      const storedRequest = await prisma.studentFeedbackRequest.findUnique({ where: { id: request.id } });
      expect(storedRequest.templateId).toBe(copy.id);
      const feedbackAfter = await readFeedback(app, student, request.id);
      expect(feedbackAfter.title).toBe(sentFeedback.title);
      expect(feedbackAfter.questions).toEqual(sentFeedback.questions);
      expect(feedbackAfter.status).toBe(StudentFeedbackStatus.ANSWERED);
      const answeredAfter = await historyItem(app, trainer, student.userId, request.id);
      expect(answeredAfter).toEqual(answeredBefore);
      expect(answeredAfter.overallIndex).toEqual(expect.any(Number));
    });

    it('sends the next ad-hoc feedback with the questions of the new version', async () => {
      const copy = await duplicate(app, trainer, await generalTemplateId(app, trainer));
      const first = await sendAdhocWith(app, trainer, student.userId, copy.id);
      await answerAll(app, student, first.id);
      const saved = (await save(app, trainer, copy.id)).json().template;

      const second = await sendAdhocWith(app, trainer, student.userId, saved.id);

      const feedback = await readFeedback(app, student, second.id);
      expect(feedback.title).toBe(NEW_NAME);
      expect(feedback.questions.map((question) => question.text)).toEqual(NEW_QUESTIONS.map((question) => question.text));
    });

    it('answers 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND when saving the version that was replaced', async () => {
      const copy = await duplicate(app, trainer, await generalTemplateId(app, trainer));
      const request = await sendAdhocWith(app, trainer, student.userId, copy.id);
      await answerAll(app, student, request.id);
      await save(app, trainer, copy.id);

      const res = await save(app, trainer, copy.id, { ...SAVE_BODY, name: 'Tarde demais' });

      expectTemplateError(res, 404, 'NOT_FOUND');
      expect(await prisma.studentFeedbackTemplate.count({ where: { trainerId: trainer.trainerId } })).toBe(2);
    });
  });
});
