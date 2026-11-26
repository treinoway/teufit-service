import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import {
  ANSWER_RANGES,
  StudentFeedbackBand,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import { milestoneDueAt } from '../../src/helpers/student-feedback-schedule.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const DAY_MS = 86400000;
const PASSWORD = 'StrongPassw0rd!';
const CONFIG_URL = '/trainer/student-feedbacks/config';
const DAYS_SINCE_LINK = 10;
const NEXT_MILESTONE_DAY = 15;
const SCORE_VALUE = 8;
const STARS_VALUE = 4;
const OPEN_ANSWER_TEXT = 'Semana boa, só o sono que pesou';
const ALL_MILESTONES_OFF = { d7: false, d15: false, d21: false, d30: false, recurring: false };
const LEGACY_FEEDBACK_KEYS = [
  'id',
  'milestone',
  'milestoneLabel',
  'status',
  'statusLabel',
  'sentAt',
  'expiresAt',
  'submittedAt',
  'readAt',
  'overallIndex',
  'band',
  'bandLabel',
  'pillars',
  'openAnswers',
];
const FALLBACK_QUESTIONS = [
  { order: 1, text: 'Como foi tua adesão aos treinos?', type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.TRAINING_ADHERENCE, required: true },
  { order: 2, text: 'Como está teu sono?', type: StudentFeedbackQuestionType.STARS, pillar: StudentFeedbackPillar.SLEEP, required: true },
  { order: 3, text: 'Quão corrida foi tua rotina?', type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.ROUTINE, required: true, invertScore: true },
  { order: 4, text: 'Quer contar algo ao teu treinador?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.REPORT, required: false },
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
  const { userId, token } = await signUp(app, 'history-trainer');
  const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: bearer(token) });
  expect(become.statusCode).toBe(200);
  const trainer = await prisma.trainer.findUnique({ where: { userId } });
  return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
}

// Signs a student up and links it to the trainer ten days ago; returns the student with the link date
async function createStudent(app, trainerId) {
  const student = await signUp(app, 'history-student');
  const linkedAt = new Date(Date.now() - DAYS_SINCE_LINK * DAY_MS);
  await prisma.trainerStudent.create({ data: { trainerId, studentId: student.userId, createdAt: linkedAt } });
  return { ...student, linkedAt };
}

// Makes sure a general template exists: the migration seeds it, but a cascading truncate may have removed it
async function ensureGeneralTemplate() {
  const existing = await prisma.studentFeedbackTemplate.findFirst({ where: { isGeneral: true } });
  if (existing) return;
  await prisma.studentFeedbackTemplate.create({
    data: { isGeneral: true, name: 'Padrão TeuFit', version: 1, questions: { create: FALLBACK_QUESTIONS } },
  });
}

// Saves a partial feedback config as the trainer
async function saveConfig(app, trainer, payload) {
  const res = await app.inject({ method: 'PUT', url: CONFIG_URL, headers: bearer(trainer.token), payload });
  expect(res.statusCode).toBe(200);
}

// Reads the feedback history of the student as the trainer
function readHistory(app, trainer, studentId, headers = {}) {
  return app.inject({ method: 'GET', url: `/trainer/students/${studentId}/feedbacks`, headers: { ...bearer(trainer.token), ...headers } });
}

// A valid answer for a question, by its type
function answerFor(question) {
  if (question.type === StudentFeedbackQuestionType.SCORE) return { questionId: question.id, score: SCORE_VALUE };
  if (question.type === StudentFeedbackQuestionType.STARS) return { questionId: question.id, score: STARS_VALUE };
  return { questionId: question.id, text: OPEN_ANSWER_TEXT };
}

// Sends an ad-hoc feedback and has the student answer every question it shows; returns the feedback id
async function sendAndAnswer(app, trainer, student) {
  const sent = await app.inject({ method: 'POST', url: `/trainer/students/${student.userId}/feedbacks`, headers: bearer(trainer.token) });
  expect(sent.statusCode).toBe(201);
  const { id } = sent.json();
  const shown = await app.inject({ method: 'GET', url: `/my/feedbacks/${id}`, headers: bearer(student.token) });
  const answers = shown.json().questions.map(answerFor);
  const submitted = await app.inject({ method: 'POST', url: `/my/feedbacks/${id}/submit`, headers: bearer(student.token), payload: { answers } });
  expect(submitted.statusCode).toBe(200);
  return id;
}

// Questions of the template of a request, by id
async function questionsOf(requestId) {
  const request = await prisma.studentFeedbackRequest.findUnique({ where: { id: requestId }, include: { template: { include: { questions: true } } } });
  return new Map(request.template.questions.map((question) => [question.id, question]));
}

// Band that a score belongs to
function bandOf(score) {
  if (score < 50) return StudentFeedbackBand.ATTENTION;
  return score < 75 ? StudentFeedbackBand.STABLE : StudentFeedbackBand.GOOD;
}

// The answer of a pillar the stored question and the submitted value lead to
function expectedAnswer(question) {
  return {
    questionId: question.id,
    question: question.text,
    type: question.type,
    typeLabel: ptBR.categorical.studentFeedbackQuestionType[question.type],
    value: question.type === StudentFeedbackQuestionType.SCORE ? SCORE_VALUE : STARS_VALUE,
    max: ANSWER_RANGES[question.type].max,
    inverted: question.invertScore,
  };
}

e2eDescribe('e2e: student feedback history clarity', () => {
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

  describe('autoSend', () => {
    it('is off without a next milestone while the trainer never turned auto-send on', async () => {
      const res = await readHistory(app, trainer, student.userId);

      expect(res.statusCode).toBe(200);
      expect(res.json().autoSend).toEqual({ enabled: false, next: null });
      expect(res.json()).toMatchObject({ hasPending: false, feedbacks: [] });
    });

    it('is on with the next milestone, its label and its due date once auto-send is on', async () => {
      await saveConfig(app, trainer, { autoSendEnabled: true });

      const res = await readHistory(app, trainer, student.userId);

      expect(res.statusCode).toBe(200);
      expect(res.json().autoSend).toEqual({
        enabled: true,
        next: {
          milestone: StudentFeedbackMilestone.D15,
          milestoneLabel: ptBR.categorical.studentFeedbackMilestone[StudentFeedbackMilestone.D15],
          dueAt: milestoneDueAt(student.linkedAt, NEXT_MILESTONE_DAY).toISOString(),
        },
      });
      expect(Date.parse(res.json().autoSend.next.dueAt)).toBeGreaterThan(Date.now());
    });

    it('labels the next milestone in en-US when asked', async () => {
      await saveConfig(app, trainer, { autoSendEnabled: true });

      const res = await readHistory(app, trainer, student.userId, { 'app-language': 'en-US' });

      expect(res.json().autoSend.next.milestoneLabel).not.toBe(ptBR.categorical.studentFeedbackMilestone[StudentFeedbackMilestone.D15]);
      expect(res.json().autoSend.next.milestoneLabel.length).toBeGreaterThan(0);
    });

    it('skips a milestone the trainer toggled off', async () => {
      await saveConfig(app, trainer, { autoSendEnabled: true, d15: false });

      const res = await readHistory(app, trainer, student.userId);

      expect(res.json().autoSend.next).toMatchObject({ milestone: StudentFeedbackMilestone.D21, dueAt: milestoneDueAt(student.linkedAt, 21).toISOString() });
    });

    it('stays on without a next milestone when every milestone is toggled off', async () => {
      await saveConfig(app, trainer, { autoSendEnabled: true, ...ALL_MILESTONES_OFF });

      const res = await readHistory(app, trainer, student.userId);

      expect(res.json().autoSend).toEqual({ enabled: true, next: null });
    });

    it('stays on without a next milestone for a student blocked on the plan', async () => {
      await saveConfig(app, trainer, { autoSendEnabled: true });
      await prisma.trainerStudent.update({
        where: { trainerId_studentId: { trainerId: trainer.trainerId, studentId: student.userId } },
        data: { activeOnPlan: false },
      });

      const res = await readHistory(app, trainer, student.userId);

      expect(res.statusCode).toBe(200);
      expect(res.json().autoSend).toEqual({ enabled: true, next: null });
    });

    it('goes back to off without a next milestone when auto-send is turned off', async () => {
      await saveConfig(app, trainer, { autoSendEnabled: true });
      await saveConfig(app, trainer, { autoSendEnabled: false });

      const res = await readHistory(app, trainer, student.userId);

      expect(res.json().autoSend).toEqual({ enabled: false, next: null });
    });
  });

  describe('pillars of an answered feedback', () => {
    it('carries the band of each pillar and the scored answers behind it', async () => {
      const id = await sendAndAnswer(app, trainer, student);
      const questions = await questionsOf(id);

      const res = await readHistory(app, trainer, student.userId);

      expect(res.statusCode).toBe(200);
      const [feedback] = res.json().feedbacks;
      expect(feedback.pillars.length).toBeGreaterThan(0);
      for (const pillar of feedback.pillars) {
        expect(pillar.band).toBe(bandOf(pillar.score));
        expect(pillar.bandLabel).toBe(ptBR.categorical.studentFeedbackBand[pillar.band]);
        expect(pillar.answers.length).toBeGreaterThan(0);
        const stored = pillar.answers.map((answer) => questions.get(answer.questionId));
        expect(stored.map((question) => question.pillar)).toEqual(pillar.answers.map(() => pillar.pillar));
        expect(stored.map((question) => question.order)).toEqual([...stored.map((question) => question.order)].sort((a, b) => a - b));
        expect(pillar.answers).toEqual(stored.map(expectedAnswer));
      }
    });

    it('lists every scored answer of the student once and no open answer', async () => {
      const id = await sendAndAnswer(app, trainer, student);
      const stored = await prisma.studentFeedbackAnswer.findMany({ where: { requestId: id, score: { not: null } } });

      const res = await readHistory(app, trainer, student.userId);

      const listed = res.json().feedbacks[0].pillars.flatMap((pillar) => pillar.answers);
      expect(listed.map((answer) => answer.questionId).sort()).toEqual(stored.map((answer) => answer.questionId).sort());
      expect(listed.map((answer) => answer.type)).not.toContain(StudentFeedbackQuestionType.OPEN);
    });

    it('keeps every field the history had before', async () => {
      const id = await sendAndAnswer(app, trainer, student);

      const res = await readHistory(app, trainer, student.userId);

      const body = res.json();
      expect(Object.keys(body)).toEqual(expect.arrayContaining(['student', 'hasPending', 'feedbacks', 'autoSend']));
      expect(body.student).toMatchObject({ id: student.userId, avatarUrl: null });
      expect(body.hasPending).toBe(false);
      const [feedback] = body.feedbacks;
      expect(Object.keys(feedback)).toEqual(expect.arrayContaining(LEGACY_FEEDBACK_KEYS));
      expect(feedback).toMatchObject({ id, milestone: StudentFeedbackMilestone.ADHOC, status: StudentFeedbackStatus.ANSWERED, readAt: null });
      expect(feedback.band).toBe(bandOf(feedback.overallIndex));
      for (const pillar of feedback.pillars) {
        expect(Object.keys(pillar)).toEqual(expect.arrayContaining(['pillar', 'pillarLabel', 'score', 'band', 'bandLabel', 'answers']));
        expect(Object.values(StudentFeedbackPillar)).toContain(pillar.pillar);
        expect(Number.isInteger(pillar.score)).toBe(true);
      }
      for (const open of feedback.openAnswers) {
        expect(open).toMatchObject({ questionId: expect.any(String), question: expect.any(String), text: OPEN_ANSWER_TEXT });
      }
    });
  });

  describe('feedback not answered yet', () => {
    it('keeps its pillars empty', async () => {
      const sent = await app.inject({ method: 'POST', url: `/trainer/students/${student.userId}/feedbacks`, headers: bearer(trainer.token) });
      expect(sent.statusCode).toBe(201);

      const res = await readHistory(app, trainer, student.userId);

      expect(res.json().hasPending).toBe(true);
      expect(res.json().feedbacks[0]).toMatchObject({ id: sent.json().id, status: StudentFeedbackStatus.PENDING, pillars: [], openAnswers: [] });
      expect(res.json().autoSend).toEqual({ enabled: false, next: null });
    });
  });
});
