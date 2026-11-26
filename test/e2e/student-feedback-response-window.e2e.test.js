import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import { sendDueFeedbacks, sendDueReminders } from '../../src/services/student-feedback-scheduler-service.js';
import {
  RESPONSE_WINDOW_DAYS,
  RESPONSE_WINDOW_MAX_DAYS,
  RESPONSE_WINDOW_MIN_DAYS,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const PASSWORD = 'StrongPassw0rd!';
const CONFIG_URL = '/trainer/student-feedbacks/config';
const PENDING_URL = '/my/feedbacks/pending';
const CHOSEN_WINDOW_DAYS = 5;
const SHORTER_WINDOW_DAYS = 2;
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// 09:00 America/Sao_Paulo seven days after the link
const D7_DUE = new Date('2026-11-08T12:00:00Z');
const CRON_NOW = new Date(D7_DUE.getTime() + HOUR_MS);
const DEFAULT_SWITCHES = { autoSendEnabled: false, d7: true, d15: true, d21: true, d30: true, recurring: true };
const REFUSED_WINDOWS = [
  ['zero', 0],
  ['one above the maximum', RESPONSE_WINDOW_MAX_DAYS + 1],
  ['a fraction', 2.5],
  ['a word', 'três'],
];
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

// Signs a user up and turns it into a trainer
async function createTrainer(app) {
  const { userId, token } = await signUp(app, 'feedback-window-trainer');
  const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: bearer(token) });
  expect(become.statusCode).toBe(200);
  const trainer = await prisma.trainer.findUnique({ where: { userId } });
  return { userId, trainerId: trainer.id, token: become.json().token.accessToken };
}

// Signs a student up and links it to the trainer at LINKED_AT, so its seven-day milestone falls due at D7_DUE
async function createStudent(app, trainerId) {
  const student = await signUp(app, 'feedback-window-student');
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

// Reads the config as the trainer
function readConfig(app, trainer) {
  return app.inject({ method: 'GET', url: CONFIG_URL, headers: bearer(trainer.token) });
}

// Saves a partial config as the trainer
function saveConfig(app, trainer, payload) {
  return app.inject({ method: 'PUT', url: CONFIG_URL, headers: bearer(trainer.token), payload });
}

// Sends an ad-hoc feedback from the trainer to the student
function sendAdhoc(app, trainer, studentId) {
  return app.inject({ method: 'POST', url: `/trainer/students/${studentId}/feedbacks`, headers: bearer(trainer.token) });
}

// Stored config row of the trainer
function storedConfigOf(trainerId) {
  return prisma.studentFeedbackConfig.findUnique({ where: { trainerId } });
}

// Stored feedback requests of a student, oldest first
function requestsOf(studentId) {
  return prisma.studentFeedbackRequest.findMany({ where: { studentId }, orderBy: { sentAt: 'asc' } });
}

// Milliseconds between the send and the deadline of a request
function windowMsOf(request) {
  return new Date(request.expiresAt).getTime() - new Date(request.sentAt).getTime();
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

e2eDescribe('e2e: student feedback response window', () => {
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

  describe('config', () => {
    it('reports the default window for a trainer that never saved', async () => {
      const res = await readConfig(app, trainer);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ...DEFAULT_SWITCHES, responseWindowDays: RESPONSE_WINDOW_DAYS });
    });

    it('saves the window, returns the full config and reports it on the next read', async () => {
      const saved = await saveConfig(app, trainer, { responseWindowDays: CHOSEN_WINDOW_DAYS });

      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ ...DEFAULT_SWITCHES, responseWindowDays: CHOSEN_WINDOW_DAYS });
      const reread = await readConfig(app, trainer);
      expect(reread.json()).toEqual(saved.json());
      expect((await storedConfigOf(trainer.trainerId)).responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
    });

    it.each([RESPONSE_WINDOW_MIN_DAYS, RESPONSE_WINDOW_MAX_DAYS])('stores a window of %i day(s), the edge of the range', async (days) => {
      const saved = await saveConfig(app, trainer, { responseWindowDays: days });

      expect(saved.statusCode).toBe(200);
      expect((await readConfig(app, trainer)).json().responseWindowDays).toBe(days);
    });

    it('keeps the saved window when a later save leaves it out', async () => {
      await saveConfig(app, trainer, { responseWindowDays: CHOSEN_WINDOW_DAYS });

      const saved = await saveConfig(app, trainer, { autoSendEnabled: true, d21: false });

      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ ...DEFAULT_SWITCHES, autoSendEnabled: true, d21: false, responseWindowDays: CHOSEN_WINDOW_DAYS });
    });

    it('gives the default window to a row created without one, through the column default', async () => {
      await prisma.studentFeedbackConfig.create({ data: { trainerId: trainer.trainerId, autoSendEnabled: true, enabledAt: LINKED_AT } });

      const res = await readConfig(app, trainer);

      expect(res.json().responseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
      expect((await storedConfigOf(trainer.trainerId)).responseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
    });

    it.each(REFUSED_WINDOWS)('refuses %s as the window with the validation error contract and keeps the stored one', async (_label, value) => {
      await saveConfig(app, trainer, { responseWindowDays: CHOSEN_WINDOW_DAYS });

      const res = await saveConfig(app, trainer, { responseWindowDays: value });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expect(typeof body.message).toBe('string');
      expect(Array.isArray(body.details)).toBe(true);
      expect((await readConfig(app, trainer)).json().responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
    });
  });

  describe('ad-hoc send', () => {
    it('expires three days after the send for a trainer that never saved a window', async () => {
      const created = await sendAdhoc(app, trainer, student.userId);

      expect(created.statusCode).toBe(201);
      expect(windowMsOf(created.json())).toBe(RESPONSE_WINDOW_DAYS * DAY_MS);
    });

    it('expires after the saved window and stores that deadline', async () => {
      await saveConfig(app, trainer, { responseWindowDays: CHOSEN_WINDOW_DAYS });

      const created = await sendAdhoc(app, trainer, student.userId);

      expect(created.statusCode).toBe(201);
      expect(windowMsOf(created.json())).toBe(CHOSEN_WINDOW_DAYS * DAY_MS);
      const [stored] = await requestsOf(student.userId);
      expect(windowMsOf(stored)).toBe(CHOSEN_WINDOW_DAYS * DAY_MS);
    });

    it('shows the student the days left of the saved window', async () => {
      await saveConfig(app, trainer, { responseWindowDays: CHOSEN_WINDOW_DAYS });
      const created = await sendAdhoc(app, trainer, student.userId);

      const pending = await app.inject({ method: 'GET', url: PENDING_URL, headers: bearer(student.token) });

      expect(pending.statusCode).toBe(200);
      expect(pending.json().feedback).toMatchObject({ id: created.json().id, expiresAt: created.json().expiresAt, daysLeft: CHOSEN_WINDOW_DAYS });
    });

    it('keeps the deadline of a request already sent when the trainer changes the window', async () => {
      await saveConfig(app, trainer, { responseWindowDays: CHOSEN_WINDOW_DAYS });
      const created = await sendAdhoc(app, trainer, student.userId);

      const saved = await saveConfig(app, trainer, { responseWindowDays: SHORTER_WINDOW_DAYS });

      expect(saved.statusCode).toBe(200);
      const [stored] = await requestsOf(student.userId);
      expect(stored.expiresAt.toISOString()).toBe(created.json().expiresAt);
      expect(windowMsOf(stored)).toBe(CHOSEN_WINDOW_DAYS * DAY_MS);
    });

    it('uses the new window from the next send on', async () => {
      await saveConfig(app, trainer, { responseWindowDays: CHOSEN_WINDOW_DAYS });
      const first = await sendAdhoc(app, trainer, student.userId);
      await prisma.studentFeedbackRequest.update({ where: { id: first.json().id }, data: { status: StudentFeedbackStatus.EXPIRED } });
      await saveConfig(app, trainer, { responseWindowDays: SHORTER_WINDOW_DAYS });

      const second = await sendAdhoc(app, trainer, student.userId);

      expect(second.statusCode).toBe(201);
      expect(windowMsOf(second.json())).toBe(SHORTER_WINDOW_DAYS * DAY_MS);
    });
  });

  describe('automatic send', () => {
    let emailSender;
    let logger;

    beforeEach(() => {
      emailSender = createFakeEmailSender();
      logger = createFakeLogger();
    });

    it('expires after the saved window and tells the e-mail the number of days', async () => {
      await saveConfig(app, trainer, { autoSendEnabled: true, responseWindowDays: SHORTER_WINDOW_DAYS });
      await prisma.studentFeedbackConfig.update({ where: { trainerId: trainer.trainerId }, data: { enabledAt: LINKED_AT } });

      const result = await sendDueFeedbacks(prisma, emailSender, logger, CRON_NOW);

      expect(result).toEqual({ created: 1 });
      const [stored] = await requestsOf(student.userId);
      expect(stored).toMatchObject({
        milestone: StudentFeedbackMilestone.D7,
        status: StudentFeedbackStatus.PENDING,
        sentAt: CRON_NOW,
        expiresAt: new Date(CRON_NOW.getTime() + SHORTER_WINDOW_DAYS * DAY_MS),
      });
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ to: student.email, responseWindowDays: SHORTER_WINDOW_DAYS }));
    });

    it('expires three days after the send for a config row created without a window', async () => {
      await prisma.studentFeedbackConfig.create({ data: { trainerId: trainer.trainerId, autoSendEnabled: true, enabledAt: LINKED_AT } });

      await sendDueFeedbacks(prisma, emailSender, logger, CRON_NOW);

      const [stored] = await requestsOf(student.userId);
      expect(stored.expiresAt).toEqual(new Date(CRON_NOW.getTime() + RESPONSE_WINDOW_DAYS * DAY_MS));
    });

    it('sends no reminder for a one-day window, 24 hours after the send', async () => {
      await prisma.studentFeedbackConfig.create({
        data: { trainerId: trainer.trainerId, autoSendEnabled: true, enabledAt: LINKED_AT, responseWindowDays: RESPONSE_WINDOW_MIN_DAYS },
      });
      await sendDueFeedbacks(prisma, emailSender, logger, CRON_NOW);

      const result = await sendDueReminders(prisma, emailSender, logger, new Date(CRON_NOW.getTime() + DAY_MS));

      expect(result).toEqual({ reminded: 0 });
      expect(emailSender.sendStudentFeedbackReminderEmail).not.toHaveBeenCalled();
    });
  });
});
