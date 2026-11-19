import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import { scoreFeedback } from '../../src/helpers/student-feedback-score.js';
import {
  expireOverdueFeedbacks,
  sendDueFeedbacks,
  sendDueReminders,
} from '../../src/services/student-feedback-scheduler-service.js';
import { saveDraft, submitFeedback } from '../../src/services/student-feedback-student-service.js';
import {
  StudentFeedbackErrorCode,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionCondition,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const PASSWORD = 'StrongPassw0rd!';
const RACE_ROUNDS = 8;
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// 09:00 America/Sao_Paulo seven days after the link
const D7_DUE = new Date('2026-11-08T12:00:00Z');
const NOW = new Date(D7_DUE.getTime() + HOUR_MS);
const NEXT_TICK = new Date(NOW.getTime() + HOUR_MS / 4);
const ANSWERED_AT = new Date(NOW.getTime() + 2 * HOUR_MS);
const REMINDER_DUE_AT = new Date(NOW.getTime() + DAY_MS);
const WINDOW_END = new Date(NOW.getTime() + 3 * DAY_MS);
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

// Signs a user up through the real flow and returns its id, e-mail and access token
async function signUp(app, prefix) {
  counter += 1;
  const email = `e2e+${prefix}-${Date.now()}-${counter}@example.com`;
  const res = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { userId: body.user.id, email, token: body.token.accessToken };
}

// Signs a user up, turns it into a trainer and switches its automatic feedbacks on since the link date
async function createAutoSendTrainer(app) {
  const { userId, token } = await signUp(app, 'feedback-cron-trainer');
  const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: bearer(token) });
  expect(become.statusCode).toBe(200);
  const trainer = await prisma.trainer.findUnique({ where: { userId } });
  await prisma.studentFeedbackConfig.create({ data: { trainerId: trainer.id, autoSendEnabled: true, enabledAt: LINKED_AT } });
  return { userId, trainerId: trainer.id };
}

// Signs a student up and links it to the trainer at LINKED_AT, so its seven-day milestone falls due at D7_DUE
async function createDueStudent(app, trainerId) {
  const student = await signUp(app, 'feedback-cron-student');
  await prisma.trainerStudent.create({ data: { trainerId, studentId: student.userId, createdAt: LINKED_AT, activeOnPlan: true } });
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

// E-mail sender whose two feedback senders only record their calls
function createFakeEmailSender() {
  return {
    sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined),
    sendStudentFeedbackReminderEmail: vi.fn().mockResolvedValue(undefined),
  };
}

// Logger that only records its calls
function createFakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Stored feedback requests of a student, oldest first
function requestsOf(studentId) {
  return prisma.studentFeedbackRequest.findMany({ where: { studentId }, orderBy: { sentAt: 'asc' } });
}

// Recipients of the calls a fake sender recorded
function recipientsOf(sender) {
  return sender.mock.calls.map(([payload]) => payload.to);
}

// Questions the student sees in a request that recorded no meal plan, in order
async function visibleQuestionsOf(templateId) {
  const questions = await prisma.studentFeedbackQuestion.findMany({ where: { templateId }, orderBy: { order: 'asc' } });
  return questions.filter((question) => question.condition !== StudentFeedbackQuestionCondition.HAS_MEAL_PLAN);
}

// A valid answer for a question, by its type
function answerFor(question) {
  if (question.type === StudentFeedbackQuestionType.SCORE) return { questionId: question.id, score: 8 };
  if (question.type === StudentFeedbackQuestionType.STARS) return { questionId: question.id, score: 4 };
  return { questionId: question.id, text: 'Semana boa, só o sono que pesou' };
}

// Creates a pending ad-hoc request of the pair sent at NOW, straight in the database
function createPendingRequest(trainerId, studentId, templateId) {
  return prisma.studentFeedbackRequest.create({
    data: {
      trainerId,
      studentId,
      templateId,
      milestone: StudentFeedbackMilestone.ADHOC,
      status: StudentFeedbackStatus.PENDING,
      hasMealPlan: false,
      dueAt: null,
      sentAt: NOW,
      expiresAt: WINDOW_END,
    },
  });
}

e2eDescribe('e2e: student feedback scheduler against Postgres', () => {
  let app;
  let trainer;
  let student;
  let emailSender;
  let logger;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await ensureGeneralTemplate();
    trainer = await createAutoSendTrainer(app);
    student = await createDueStudent(app, trainer.trainerId);
    emailSender = createFakeEmailSender();
    logger = createFakeLogger();
  });

  describe('sendDueFeedbacks', () => {
    it('creates one pending request and sends one e-mail for the due student', async () => {
      const result = await sendDueFeedbacks(prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 1 });
      const requests = await requestsOf(student.userId);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        trainerId: trainer.trainerId,
        milestone: StudentFeedbackMilestone.D7,
        status: StudentFeedbackStatus.PENDING,
        dueAt: D7_DUE,
        sentAt: NOW,
        expiresAt: WINDOW_END,
      });
      expect(recipientsOf(emailSender.sendStudentFeedbackRequestEmail)).toEqual([student.email]);
    });

    it('creates nothing and sends nothing when called a second time', async () => {
      await sendDueFeedbacks(prisma, emailSender, logger, NOW);

      const second = await sendDueFeedbacks(prisma, emailSender, logger, NEXT_TICK);

      expect(second).toEqual({ created: 0 });
      expect(await requestsOf(student.userId)).toHaveLength(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
    });

    it('creates exactly one request and one e-mail per due student when two calls run at the same time', async () => {
      const others = [await createDueStudent(app, trainer.trainerId), await createDueStudent(app, trainer.trainerId)];
      const students = [student, ...others];

      const results = await Promise.all([
        sendDueFeedbacks(prisma, emailSender, logger, NOW),
        sendDueFeedbacks(prisma, emailSender, logger, NOW),
      ]);

      expect(results[0].created + results[1].created).toBe(students.length);
      for (const due of students) expect(await requestsOf(due.userId)).toHaveLength(1);
      expect(recipientsOf(emailSender.sendStudentFeedbackRequestEmail).sort()).toEqual(students.map((due) => due.email).sort());
    });

    it('stays at one request per student after concurrent calls followed by another tick', async () => {
      await Promise.all([
        sendDueFeedbacks(prisma, emailSender, logger, NOW),
        sendDueFeedbacks(prisma, emailSender, logger, NOW),
      ]);

      const later = await sendDueFeedbacks(prisma, emailSender, logger, NEXT_TICK);

      expect(later).toEqual({ created: 0 });
      expect(await prisma.studentFeedbackRequest.count()).toBe(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
    });

    it('leaves alone the student of a trainer without automatic feedbacks', async () => {
      await prisma.studentFeedbackConfig.update({ where: { trainerId: trainer.trainerId }, data: { autoSendEnabled: false } });

      const result = await sendDueFeedbacks(prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 0 });
      expect(await prisma.studentFeedbackRequest.count()).toBe(0);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
    });
  });

  describe('sendDueReminders', () => {
    beforeEach(async () => {
      await sendDueFeedbacks(prisma, emailSender, logger, NOW);
    });

    it('sends nothing before 24 hours have passed', async () => {
      const result = await sendDueReminders(prisma, emailSender, logger, new Date(REMINDER_DUE_AT.getTime() - HOUR_MS));

      expect(result).toEqual({ reminded: 0 });
      expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
    });

    it('sends the reminder once after 24 hours and never again', async () => {
      const first = await sendDueReminders(prisma, emailSender, logger, REMINDER_DUE_AT);
      const second = await sendDueReminders(prisma, emailSender, logger, new Date(REMINDER_DUE_AT.getTime() + HOUR_MS));

      expect(first).toEqual({ reminded: 1 });
      expect(second).toEqual({ reminded: 0 });
      expect(recipientsOf(emailSender.sendStudentFeedbackReminderEmail)).toEqual([student.email]);
      const [request] = await requestsOf(student.userId);
      expect(request.reminderSentAt).toEqual(REMINDER_DUE_AT);
    });

    it('sends a single reminder when two calls run at the same time', async () => {
      const results = await Promise.all([
        sendDueReminders(prisma, emailSender, logger, REMINDER_DUE_AT),
        sendDueReminders(prisma, emailSender, logger, REMINDER_DUE_AT),
      ]);

      expect(results[0].reminded + results[1].reminded).toBe(1);
      expect(emailSender.sendStudentFeedbackReminderEmail).toHaveBeenCalledTimes(1);
    });

    it('sends no reminder for a request that was already answered', async () => {
      const [request] = await requestsOf(student.userId);
      await prisma.studentFeedbackRequest.update({ where: { id: request.id }, data: { status: StudentFeedbackStatus.ANSWERED, submittedAt: ANSWERED_AT } });

      const result = await sendDueReminders(prisma, emailSender, logger, REMINDER_DUE_AT);

      expect(result).toEqual({ reminded: 0 });
      expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
    });
  });

  describe('expireOverdueFeedbacks', () => {
    beforeEach(async () => {
      await sendDueFeedbacks(prisma, emailSender, logger, NOW);
    });

    it('keeps a request pending while its window is open', async () => {
      const result = await expireOverdueFeedbacks(prisma, new Date(WINDOW_END.getTime() - 1));

      expect(result).toEqual({ expired: 0 });
      const [request] = await requestsOf(student.userId);
      expect(request.status).toBe(StudentFeedbackStatus.PENDING);
    });

    it('expires a pending request once its window passed', async () => {
      const result = await expireOverdueFeedbacks(prisma, WINDOW_END);

      expect(result).toEqual({ expired: 1 });
      const [request] = await requestsOf(student.userId);
      expect(request.status).toBe(StudentFeedbackStatus.EXPIRED);
    });

    it('never touches an answered request past its window', async () => {
      const [request] = await requestsOf(student.userId);
      await prisma.studentFeedbackRequest.update({ where: { id: request.id }, data: { status: StudentFeedbackStatus.ANSWERED, submittedAt: ANSWERED_AT } });

      const result = await expireOverdueFeedbacks(prisma, WINDOW_END);

      expect(result).toEqual({ expired: 0 });
      expect((await requestsOf(student.userId))[0].status).toBe(StudentFeedbackStatus.ANSWERED);
    });

    it('does not send the same milestone again after it expired', async () => {
      await expireOverdueFeedbacks(prisma, WINDOW_END);

      const result = await sendDueFeedbacks(prisma, emailSender, logger, new Date(WINDOW_END.getTime() + HOUR_MS));

      expect(result).toEqual({ created: 0 });
      expect(await requestsOf(student.userId)).toHaveLength(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('a draft save racing the submit', () => {
    it('leaves the stored scores consistent with the stored answers, whoever wins', async () => {
      const template = await prisma.studentFeedbackTemplate.findFirst({ where: { isGeneral: true, deletedAt: null }, orderBy: { version: 'desc' } });
      const questions = await visibleQuestionsOf(template.id);
      const raced = questions.find((question) => question.type !== StudentFeedbackQuestionType.OPEN);
      const allAnswers = questions.map(answerFor);
      const submitAnswers = allAnswers.filter((answer) => answer.questionId !== raced.id);
      const draftChange = [{ questionId: raced.id, score: 1 }];

      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const request = await createPendingRequest(trainer.trainerId, student.userId, template.id);
        await saveDraft(prisma, student.userId, request.id, { answers: allAnswers }, ANSWERED_AT);

        const [submitted, drafted] = await Promise.allSettled([
          submitFeedback(prisma, student.userId, request.id, { answers: submitAnswers }, ANSWERED_AT),
          saveDraft(prisma, student.userId, request.id, { answers: draftChange }, ANSWERED_AT),
        ]);

        expect(submitted.status, String(submitted.reason)).toBe('fulfilled');
        if (drafted.status === 'rejected') expect(drafted.reason.error).toBe(StudentFeedbackErrorCode.ALREADY_SUBMITTED);
        const stored = await prisma.studentFeedbackRequest.findUnique({ where: { id: request.id }, include: { answers: true } });
        const expected = scoreFeedback(questions, stored.answers);
        expect(stored.status).toBe(StudentFeedbackStatus.ANSWERED);
        expect({ pillars: stored.pillarScores, overallIndex: stored.overallIndex, band: stored.band }).toEqual(expected);
      }
    });

    it('answers ALREADY_SUBMITTED to one of two submits racing on the same request and scores it once', async () => {
      const template = await prisma.studentFeedbackTemplate.findFirst({ where: { isGeneral: true, deletedAt: null }, orderBy: { version: 'desc' } });
      const questions = await visibleQuestionsOf(template.id);
      const answers = questions.map(answerFor);
      const request = await createPendingRequest(trainer.trainerId, student.userId, template.id);

      const results = await Promise.allSettled([
        submitFeedback(prisma, student.userId, request.id, { answers }, ANSWERED_AT),
        submitFeedback(prisma, student.userId, request.id, { answers }, ANSWERED_AT),
      ]);

      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.error).toBe(StudentFeedbackErrorCode.ALREADY_SUBMITTED);
      const stored = await prisma.studentFeedbackRequest.findUnique({ where: { id: request.id }, include: { answers: true } });
      expect(stored.answers).toHaveLength(answers.length);
      expect(stored.overallIndex).toBe(scoreFeedback(questions, stored.answers).overallIndex);
    });
  });

  describe('account deletion', () => {
    it('removes the feedback requests and answers of the deleted student and keeps the ones of other students', async () => {
      const other = await createDueStudent(app, trainer.trainerId);
      await sendDueFeedbacks(prisma, emailSender, logger, NOW);
      const [request] = await requestsOf(student.userId);
      const questions = await visibleQuestionsOf(request.templateId);
      await saveDraft(prisma, student.userId, request.id, { answers: questions.map(answerFor) }, ANSWERED_AT);
      expect(await prisma.studentFeedbackAnswer.count({ where: { requestId: request.id } })).toBeGreaterThan(0);

      const deleted = await app.inject({ method: 'DELETE', url: '/me', headers: bearer(student.token) });

      expect(deleted.statusCode).toBe(204);
      expect(await requestsOf(student.userId)).toHaveLength(0);
      expect(await prisma.studentFeedbackAnswer.count({ where: { requestId: request.id } })).toBe(0);
      expect(await requestsOf(other.userId)).toHaveLength(1);
    });

    it('sends nothing to a student whose account was deleted before the milestone tick', async () => {
      const deleted = await app.inject({ method: 'DELETE', url: '/me', headers: bearer(student.token) });
      expect(deleted.statusCode).toBe(204);

      const result = await sendDueFeedbacks(prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 0 });
      expect(await prisma.studentFeedbackRequest.count()).toBe(0);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
    });
  });
});
