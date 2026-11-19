import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import {
  StudentFeedbackBand,
  StudentFeedbackErrorCode,
  StudentFeedbackInboxFilter,
  StudentFeedbackMessageCode,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const DAY_MS = 86400000;
const PASSWORD = 'StrongPassw0rd!';
const PENDING_URL = '/my/feedbacks/pending';
const INBOX_URL = '/trainer/student-feedbacks';
const UNREAD_COUNT_URL = '/trainer/student-feedbacks/unread-count';
const CONFIG_URL = '/trainer/student-feedbacks/config';
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const OPEN_ANSWER_TEXT = 'Semana boa, só o sono que pesou';
const DEFAULT_CONFIG = { autoSendEnabled: false, d7: true, d15: true, d21: true, d30: true, recurring: true };
const FALLBACK_QUESTIONS = [
  { order: 1, text: 'Como foi tua adesão aos treinos?', type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.TRAINING_ADHERENCE, required: true },
  { order: 2, text: 'Como está teu sono?', type: StudentFeedbackQuestionType.STARS, pillar: StudentFeedbackPillar.SLEEP, required: true },
  { order: 3, text: 'Quer contar algo ao teu treinador?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.REPORT, required: false },
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
  const { userId, token } = await signUp(app, 'feedback-trainer');
  const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: bearer(token) });
  expect(become.statusCode).toBe(200);
  const trainer = await prisma.trainer.findUnique({ where: { userId } });
  return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
}

// Signs a student up and links it to the trainer ten days ago
async function createStudent(app, trainerId) {
  const student = await signUp(app, 'feedback-student');
  await prisma.trainerStudent.create({ data: { trainerId, studentId: student.userId, createdAt: new Date(Date.now() - 10 * DAY_MS) } });
  return student;
}

// Makes sure a general template exists: the migration seeds it, but a cascading truncate may have removed it
async function ensureGeneralTemplate() {
  const existing = await prisma.studentFeedbackTemplate.findFirst({ where: { isGeneral: true } });
  if (existing) return;
  await prisma.studentFeedbackTemplate.create({
    data: { isGeneral: true, name: 'Padrão TeuFit', version: 1, questions: { create: FALLBACK_QUESTIONS } },
  });
}

// Sends an ad-hoc feedback from the trainer to the student
function sendAdhoc(app, trainer, studentId) {
  return app.inject({ method: 'POST', url: `/trainer/students/${studentId}/feedbacks`, headers: bearer(trainer.token) });
}

// Reads a feedback as the student
function readFeedback(app, student, id) {
  return app.inject({ method: 'GET', url: `/my/feedbacks/${id}`, headers: bearer(student.token) });
}

// Saves a draft as the student
function saveDraft(app, student, id, answers) {
  return app.inject({ method: 'PATCH', url: `/my/feedbacks/${id}/draft`, headers: bearer(student.token), payload: { answers } });
}

// Submits a feedback as the student
function submit(app, student, id, answers) {
  return app.inject({ method: 'POST', url: `/my/feedbacks/${id}/submit`, headers: bearer(student.token), payload: { answers } });
}

// A valid answer for a question, by its type
function answerFor(question) {
  if (question.type === StudentFeedbackQuestionType.SCORE) return { questionId: question.id, score: 8 };
  if (question.type === StudentFeedbackQuestionType.STARS) return { questionId: question.id, score: 4 };
  return { questionId: question.id, text: OPEN_ANSWER_TEXT };
}

// Valid answers for every question the student sees in the feedback
async function validAnswers(app, student, id) {
  const res = await readFeedback(app, student, id);
  expect(res.statusCode).toBe(200);
  return res.json().questions.map(answerFor);
}

// Asserts the unified error contract with a student-feedback code
function expectFeedbackError(res, statusCode, key) {
  expect(res.statusCode).toBe(statusCode);
  const body = res.json();
  expect(body).toMatchObject({ error: StudentFeedbackErrorCode[key], messageCode: StudentFeedbackMessageCode[key] });
  expect(typeof body.message).toBe('string');
  expect(body).toHaveProperty('details');
}

// Asserts a non-empty label sibling
function expectLabel(value) {
  expect(typeof value).toBe('string');
  expect(value.length).toBeGreaterThan(0);
}

// A schema-valid body for the route, so the request reaches the auth check
function validPayloadFor(method, url) {
  if (url === CONFIG_URL && method === 'PUT') return { d7: false };
  if (url.endsWith('/draft') || url.endsWith('/submit')) return { answers: [] };
  return undefined;
}

// Band that an index belongs to
function bandOf(index) {
  if (index < 50) return StudentFeedbackBand.ATTENTION;
  return index < 75 ? StudentFeedbackBand.STABLE : StudentFeedbackBand.GOOD;
}

e2eDescribe('e2e: student feedback routes', () => {
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

  describe('happy path', () => {
    it('sends an ad-hoc feedback and shows it as pending to the student', async () => {
      const sent = await sendAdhoc(app, trainer, student.userId);

      expect(sent.statusCode).toBe(201);
      const created = sent.json();
      expect(created).toMatchObject({ milestone: StudentFeedbackMilestone.ADHOC, status: StudentFeedbackStatus.PENDING });
      expectLabel(created.milestoneLabel);
      expectLabel(created.statusLabel);
      expect(new Date(created.expiresAt).getTime() - new Date(created.sentAt).getTime()).toBe(3 * DAY_MS);

      const pending = await app.inject({ method: 'GET', url: PENDING_URL, headers: bearer(student.token) });

      expect(pending.statusCode).toBe(200);
      const { feedback } = pending.json();
      expect(feedback).toMatchObject({ id: created.id, milestone: StudentFeedbackMilestone.ADHOC, daysLeft: 3 });
      expectLabel(feedback.milestoneLabel);
      expectLabel(feedback.title);
      expect(feedback.trainer).toEqual({ name: expect.any(String), avatarUrl: null });
      expect(feedback.questionCount).toBeGreaterThan(0);
      expect(feedback.estimatedMinutes).toBeGreaterThan(0);
      expect(feedback.expiresAt).toBe(created.expiresAt);
    });

    it('answers a null pending feedback when nothing was sent', async () => {
      const pending = await app.inject({ method: 'GET', url: PENDING_URL, headers: bearer(student.token) });

      expect(pending.statusCode).toBe(200);
      expect(pending.json()).toEqual({ feedback: null });
    });

    it('returns the feedback with its questions and no answers', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();

      const res = await readFeedback(app, student, id);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ id, milestone: StudentFeedbackMilestone.ADHOC, status: StudentFeedbackStatus.PENDING, daysLeft: 3, answers: [] });
      expectLabel(body.statusLabel);
      expect(body.questions).toHaveLength(body.questionCount);
      expect(body.questions.map((question) => question.order)).toEqual([...body.questions.map((question) => question.order)].sort((a, b) => a - b));
      for (const question of body.questions) {
        expect(Object.keys(question)).toEqual(expect.arrayContaining(['id', 'order', 'text', 'helpText', 'type', 'typeLabel', 'required', 'minLabel', 'maxLabel']));
        expect(Object.values(StudentFeedbackQuestionType)).toContain(question.type);
        expectLabel(question.typeLabel);
      }
    });

    it('saves a draft and gives it back on the next read', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();
      const [first] = await validAnswers(app, student, id);

      const saved = await saveDraft(app, student, id, [first]);

      expect(saved.statusCode).toBe(200);
      const stored = { questionId: first.questionId, score: first.score ?? null, text: first.text ?? null };
      expect(saved.json()).toEqual({ answers: [stored] });
      expect((await readFeedback(app, student, id)).json().answers).toEqual([stored]);
    });

    it('submits, scores and reaches the trainer inbox, history and unread count', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();
      const answers = await validAnswers(app, student, id);

      const submitted = await submit(app, student, id, answers);

      expect(submitted.statusCode).toBe(200);
      expect(submitted.json()).toEqual({ nextFeedbackAt: null });
      expect((await app.inject({ method: 'GET', url: PENDING_URL, headers: bearer(student.token) })).json()).toEqual({ feedback: null });

      const inbox = await app.inject({ method: 'GET', url: INBOX_URL, headers: bearer(trainer.token) });

      expect(inbox.statusCode).toBe(200);
      const { summary, items } = inbox.json();
      expect(items).toHaveLength(1);
      const [item] = items;
      expect(item).toMatchObject({
        id,
        student: { id: student.userId, avatarUrl: null },
        milestone: StudentFeedbackMilestone.ADHOC,
        status: StudentFeedbackStatus.ANSWERED,
        readAt: null,
      });
      expect(typeof item.student.name).toBe('string');
      expect(Number.isInteger(item.overallIndex)).toBe(true);
      expect(item.band).toBe(bandOf(item.overallIndex));
      expectLabel(item.milestoneLabel);
      expectLabel(item.statusLabel);
      expectLabel(item.bandLabel);
      expect(Number.isNaN(Date.parse(item.sentAt))).toBe(false);
      expect(Number.isNaN(Date.parse(item.expiresAt))).toBe(false);
      expect(Number.isNaN(Date.parse(item.submittedAt))).toBe(false);
      expect(summary).toEqual({ responseRate30d: 100, averageIndex: item.overallIndex, unansweredCount: 0, unreadCount: 1 });

      const unread = await app.inject({ method: 'GET', url: UNREAD_COUNT_URL, headers: bearer(trainer.token) });
      expect(unread.statusCode).toBe(200);
      expect(unread.json()).toEqual({ count: 1 });

      const history = await app.inject({ method: 'GET', url: `/trainer/students/${student.userId}/feedbacks`, headers: bearer(trainer.token) });

      expect(history.statusCode).toBe(200);
      const body = history.json();
      expect(body.student).toMatchObject({ id: student.userId, avatarUrl: null });
      expect(body.hasPending).toBe(false);
      expect(body.feedbacks).toHaveLength(1);
      const [feedback] = body.feedbacks;
      expect(feedback).toMatchObject({ id, milestone: StudentFeedbackMilestone.ADHOC, status: StudentFeedbackStatus.ANSWERED, overallIndex: item.overallIndex, band: item.band, readAt: null });
      expectLabel(feedback.milestoneLabel);
      expectLabel(feedback.statusLabel);
      expectLabel(feedback.bandLabel);
      expect(feedback.pillars.length).toBeGreaterThan(0);
      for (const pillar of feedback.pillars) {
        expect(Object.values(StudentFeedbackPillar)).toContain(pillar.pillar);
        expectLabel(pillar.pillarLabel);
        expect(pillar.score).toBeGreaterThanOrEqual(0);
        expect(pillar.score).toBeLessThanOrEqual(100);
      }
      for (const open of feedback.openAnswers) {
        expect(open).toMatchObject({ questionId: expect.any(String), question: expect.any(String), text: OPEN_ANSWER_TEXT });
        expectLabel(open.pillarLabel);
      }
    });

    it('filters the inbox by status and milestone', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();
      await submit(app, student, id, await validAnswers(app, student, id));

      const unread = await app.inject({ method: 'GET', url: `${INBOX_URL}?status=${StudentFeedbackInboxFilter.UNREAD}&milestone=${StudentFeedbackMilestone.ADHOC}`, headers: bearer(trainer.token) });
      const unanswered = await app.inject({ method: 'GET', url: `${INBOX_URL}?status=${StudentFeedbackInboxFilter.UNANSWERED}`, headers: bearer(trainer.token) });
      const otherMilestone = await app.inject({ method: 'GET', url: `${INBOX_URL}?status=${StudentFeedbackInboxFilter.ALL}&milestone=${StudentFeedbackMilestone.D7}`, headers: bearer(trainer.token) });

      expect(unread.json().items.map((item) => item.id)).toEqual([id]);
      expect(unanswered.json().items).toEqual([]);
      expect(otherMilestone.json().items).toEqual([]);
      expect(otherMilestone.json().summary.unreadCount).toBe(1);
    });

    it('marks an answered feedback as read and drops the unread count', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();
      await submit(app, student, id, await validAnswers(app, student, id));

      const read = await app.inject({ method: 'PATCH', url: `${INBOX_URL}/${id}/read`, headers: bearer(trainer.token) });

      expect(read.statusCode).toBe(200);
      expect(read.json().id).toBe(id);
      expect(Number.isNaN(Date.parse(read.json().readAt))).toBe(false);
      const unread = await app.inject({ method: 'GET', url: UNREAD_COUNT_URL, headers: bearer(trainer.token) });
      expect(unread.json()).toEqual({ count: 0 });
      const inbox = await app.inject({ method: 'GET', url: INBOX_URL, headers: bearer(trainer.token) });
      expect(inbox.json().items[0].readAt).toBe(read.json().readAt);
    });

    it('returns the next milestone as nextFeedbackAt when auto-send is on', async () => {
      const enabled = await app.inject({ method: 'PUT', url: CONFIG_URL, headers: bearer(trainer.token), payload: { autoSendEnabled: true } });
      expect(enabled.statusCode).toBe(200);
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();

      const submitted = await submit(app, student, id, await validAnswers(app, student, id));

      expect(submitted.statusCode).toBe(200);
      expect(Date.parse(submitted.json().nextFeedbackAt)).toBeGreaterThan(Date.now());
    });
  });

  describe('config', () => {
    it('returns the defaults, saves a partial change and returns the full config', async () => {
      const initial = await app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(trainer.token) });

      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual(DEFAULT_CONFIG);

      const saved = await app.inject({ method: 'PUT', url: CONFIG_URL, headers: bearer(trainer.token), payload: { autoSendEnabled: true, d21: false } });

      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ ...DEFAULT_CONFIG, autoSendEnabled: true, d21: false });
      const reread = await app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(trainer.token) });
      expect(reread.json()).toEqual(saved.json());
    });

    it('rejects a non-boolean toggle with the validation error contract', async () => {
      const res = await app.inject({ method: 'PUT', url: CONFIG_URL, headers: bearer(trainer.token), payload: { d7: 'sometimes' } });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('refusals of the student flow', () => {
    it('answers STUDENT_FEEDBACK_REQUIRED_ANSWER_MISSING on an empty submit and keeps the feedback pending', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();

      expectFeedbackError(await submit(app, student, id, []), 400, 'REQUIRED_ANSWER_MISSING');

      expect((await readFeedback(app, student, id)).json().status).toBe(StudentFeedbackStatus.PENDING);
    });

    it('answers STUDENT_FEEDBACK_INVALID_ANSWER for an unknown question', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();

      expectFeedbackError(await saveDraft(app, student, id, [{ questionId: UNKNOWN_UUID, score: 5 }]), 400, 'INVALID_ANSWER');
    });

    it('answers STUDENT_FEEDBACK_INVALID_ANSWER for six stars', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();
      const { questions } = (await readFeedback(app, student, id)).json();
      const stars = questions.find((question) => question.type === StudentFeedbackQuestionType.STARS);

      expectFeedbackError(await saveDraft(app, student, id, [{ questionId: stars.id, score: 6 }]), 400, 'INVALID_ANSWER');
    });

    it('rejects a body without answers with the validation error contract', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();

      const res = await app.inject({ method: 'PATCH', url: `/my/feedbacks/${id}/draft`, headers: bearer(student.token), payload: {} });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('answers STUDENT_FEEDBACK_ALREADY_SUBMITTED on a second submit', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();
      const answers = await validAnswers(app, student, id);
      await submit(app, student, id, answers);

      expectFeedbackError(await submit(app, student, id, answers), 409, 'ALREADY_SUBMITTED');
    });

    it('answers STUDENT_FEEDBACK_EXPIRED on draft and submit after the window closed', async () => {
      const { id } = (await sendAdhoc(app, trainer, student.userId)).json();
      const answers = await validAnswers(app, student, id);
      await prisma.studentFeedbackRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 60000) } });

      expectFeedbackError(await saveDraft(app, student, id, answers), 409, 'EXPIRED');
      expectFeedbackError(await submit(app, student, id, answers), 409, 'EXPIRED');
    });

    it('answers STUDENT_FEEDBACK_ALREADY_PENDING on a second ad-hoc send while one is pending', async () => {
      await sendAdhoc(app, trainer, student.userId);

      expectFeedbackError(await sendAdhoc(app, trainer, student.userId), 409, 'ALREADY_PENDING');
    });
  });

  describe('ownership', () => {
    let feedbackId;
    let otherTrainer;
    let otherStudent;

    beforeEach(async () => {
      feedbackId = (await sendAdhoc(app, trainer, student.userId)).json().id;
      otherTrainer = await createTrainer(app);
      otherStudent = await createStudent(app, otherTrainer.trainerId);
    });

    it('does not show the pending feedback of another student', async () => {
      const pending = await app.inject({ method: 'GET', url: PENDING_URL, headers: bearer(otherStudent.token) });

      expect(pending.json()).toEqual({ feedback: null });
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND when a student reads the feedback of another student', async () => {
      expectFeedbackError(await readFeedback(app, otherStudent, feedbackId), 404, 'NOT_FOUND');
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND when a student drafts or submits the feedback of another student', async () => {
      const answers = await validAnswers(app, student, feedbackId);

      expectFeedbackError(await saveDraft(app, otherStudent, feedbackId, answers), 404, 'NOT_FOUND');
      expectFeedbackError(await submit(app, otherStudent, feedbackId, answers), 404, 'NOT_FOUND');

      const own = (await readFeedback(app, student, feedbackId)).json();
      expect(own).toMatchObject({ status: StudentFeedbackStatus.PENDING, answers: [] });
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for an unknown feedback', async () => {
      expectFeedbackError(await readFeedback(app, student, UNKNOWN_UUID), 404, 'NOT_FOUND');
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND when a trainer marks the feedback of another trainer as read', async () => {
      await submit(app, student, feedbackId, await validAnswers(app, student, feedbackId));

      const res = await app.inject({ method: 'PATCH', url: `${INBOX_URL}/${feedbackId}/read`, headers: bearer(otherTrainer.token) });

      expectFeedbackError(res, 404, 'NOT_FOUND');
      const unread = await app.inject({ method: 'GET', url: UNREAD_COUNT_URL, headers: bearer(trainer.token) });
      expect(unread.json()).toEqual({ count: 1 });
    });

    it('keeps the inbox and the unread count of each trainer apart', async () => {
      await submit(app, student, feedbackId, await validAnswers(app, student, feedbackId));

      const inbox = await app.inject({ method: 'GET', url: INBOX_URL, headers: bearer(otherTrainer.token) });
      const unread = await app.inject({ method: 'GET', url: UNREAD_COUNT_URL, headers: bearer(otherTrainer.token) });

      expect(inbox.json().items).toEqual([]);
      expect(unread.json()).toEqual({ count: 0 });
    });

    it('answers 404 when a trainer reads the history of or sends to a student of another trainer', async () => {
      const history = await app.inject({ method: 'GET', url: `/trainer/students/${student.userId}/feedbacks`, headers: bearer(otherTrainer.token) });
      const send = await sendAdhoc(app, otherTrainer, student.userId);

      expect(history.statusCode).toBe(404);
      expect(send.statusCode).toBe(404);
      expect(Object.keys(send.json())).toEqual(expect.arrayContaining(['error', 'messageCode', 'message']));
    });
  });

  describe('access control', () => {
    const TRAINER_ROUTES = [
      ['GET', INBOX_URL],
      ['GET', UNREAD_COUNT_URL],
      ['PATCH', `${INBOX_URL}/${UNKNOWN_UUID}/read`],
      ['GET', `/trainer/students/${UNKNOWN_UUID}/feedbacks`],
      ['POST', `/trainer/students/${UNKNOWN_UUID}/feedbacks`],
      ['GET', CONFIG_URL],
      ['PUT', CONFIG_URL],
    ];
    const STUDENT_ROUTES = [
      ['GET', PENDING_URL],
      ['GET', `/my/feedbacks/${UNKNOWN_UUID}`],
      ['PATCH', `/my/feedbacks/${UNKNOWN_UUID}/draft`],
      ['POST', `/my/feedbacks/${UNKNOWN_UUID}/submit`],
    ];

    it.each(TRAINER_ROUTES)('rejects a non-trainer on %s %s with 403', async (method, url) => {
      const res = await app.inject({ method, url, headers: bearer(student.token), payload: validPayloadFor(method, url) });

      expect(res.statusCode).toBe(403);
      expect(Object.keys(res.json())).toEqual(expect.arrayContaining(['error', 'messageCode', 'message']));
    });

    it.each([...TRAINER_ROUTES, ...STUDENT_ROUTES])('rejects an unauthenticated call on %s %s with 401', async (method, url) => {
      const res = await app.inject({ method, url, payload: validPayloadFor(method, url) });

      expect(res.statusCode).toBe(401);
    });
  });
});
