import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: { $disconnect: vi.fn(), trainer: { findUnique: vi.fn() } },
}));

vi.mock('../../src/services/student-feedback-trainer-service.js', () => ({
  countUnread: vi.fn(),
  getStudentHistory: vi.fn(),
  listInbox: vi.fn(),
  markAsRead: vi.fn(),
  sendAdhocFeedback: vi.fn(),
}));

import { buildServer } from '../../api/server.js';
import { prisma } from '../../src/db.js';
import { Roles } from '../../src/constants/roles.js';
import {
  StudentFeedbackBand,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import enUS from '../../src/i18n/locales/en-US.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import { getStudentHistory } from '../../src/services/student-feedback-trainer-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRAINER_ID = '22222222-2222-4222-8222-222222222222';
const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
const FEEDBACK_ID = '44444444-4444-4444-8444-444444444444';
const SCORE_QUESTION_ID = '55555555-5555-4555-8555-555555555555';
const STARS_QUESTION_ID = '66666666-6666-4666-8666-666666666666';
const OPEN_QUESTION_ID = '77777777-7777-4777-8777-777777777777';
const AVATAR_URL = 'https://cdn.example.com/avatar.png';
const SENT_AT = '2026-03-10T12:00:00.000Z';
const EXPIRES_AT = '2026-03-13T12:00:00.000Z';
const SUBMITTED_AT = '2026-03-10T14:00:00.000Z';
const NEXT_DUE_AT = '2026-03-18T12:00:00.000Z';
const SCORE_MAX = 10;
const STARS_MAX = 5;
const LANGUAGE_HEADER = 'app-language';
const ENGLISH = 'en-US';

// Booting the whole server cold (imports of every route and plugin) can take far longer than the 10 s default hook timeout on a loaded machine
const SERVER_LIFECYCLE_TIMEOUT_MS = 120000;

const HTTP_OK = 200;
const STUDENT_FEEDBACKS_URL = `/trainer/students/${STUDENT_ID}/feedbacks`;

const STUDENT = Object.freeze({ id: STUDENT_ID, name: 'Ana Souza', avatarUrl: AVATAR_URL });
const SCORE_ANSWER = Object.freeze({
  questionId: SCORE_QUESTION_ID,
  question: 'Acordaste cansado?',
  type: StudentFeedbackQuestionType.SCORE,
  value: 4,
  max: SCORE_MAX,
  inverted: true,
});
const STARS_ANSWER = Object.freeze({
  questionId: STARS_QUESTION_ID,
  question: 'Como está teu sono?',
  type: StudentFeedbackQuestionType.STARS,
  value: 4,
  max: STARS_MAX,
  inverted: false,
});
const OPEN_ANSWER = Object.freeze({
  questionId: OPEN_QUESTION_ID,
  question: 'Quer contar algo ao teu treinador?',
  pillar: StudentFeedbackPillar.REPORT,
  text: 'Semana corrida',
});
const NEXT = Object.freeze({ milestone: StudentFeedbackMilestone.D15, dueAt: NEXT_DUE_AT });

let app = null;
let trainerToken = null;

// Labels of the given locale for a categorical namespace
function labelsOf(locale, namespace) {
  return locale.categorical[namespace];
}

// Answered feedback of the history as the trainer service returns it, with the new pillar fields
function buildAnsweredFeedback() {
  return {
    id: FEEDBACK_ID,
    milestone: StudentFeedbackMilestone.D7,
    status: StudentFeedbackStatus.ANSWERED,
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
    submittedAt: SUBMITTED_AT,
    readAt: null,
    overallIndex: 68,
    band: StudentFeedbackBand.STABLE,
    pillars: [{ pillar: StudentFeedbackPillar.SLEEP, score: 68, band: StudentFeedbackBand.STABLE, answers: [{ ...SCORE_ANSWER }, { ...STARS_ANSWER }] }],
    openAnswers: [{ ...OPEN_ANSWER }],
  };
}

// Pending feedback of the history as the trainer service returns it
function buildPendingFeedback() {
  return {
    id: FEEDBACK_ID,
    milestone: StudentFeedbackMilestone.ADHOC,
    status: StudentFeedbackStatus.PENDING,
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
    submittedAt: null,
    readAt: null,
    overallIndex: null,
    band: null,
    pillars: [],
    openAnswers: [],
  };
}

// History as the trainer service returns it
function buildHistory({ autoSend = { enabled: true, next: { ...NEXT } }, feedbacks = [buildAnsweredFeedback()] } = {}) {
  return { student: { ...STUDENT }, hasPending: false, autoSend, feedbacks };
}

// The answered feedback as the route sends it in the given locale, labels included
function expectedAnsweredFeedback(locale) {
  const feedback = buildAnsweredFeedback();
  const bandLabel = labelsOf(locale, 'studentFeedbackBand')[StudentFeedbackBand.STABLE];
  const typeLabels = labelsOf(locale, 'studentFeedbackQuestionType');
  return {
    ...feedback,
    milestoneLabel: labelsOf(locale, 'studentFeedbackMilestone')[StudentFeedbackMilestone.D7],
    statusLabel: labelsOf(locale, 'studentFeedbackStatus')[StudentFeedbackStatus.ANSWERED],
    bandLabel,
    pillars: [
      {
        pillar: StudentFeedbackPillar.SLEEP,
        pillarLabel: labelsOf(locale, 'studentFeedbackPillar')[StudentFeedbackPillar.SLEEP],
        score: 68,
        band: StudentFeedbackBand.STABLE,
        bandLabel,
        answers: [
          { ...SCORE_ANSWER, typeLabel: typeLabels[StudentFeedbackQuestionType.SCORE] },
          { ...STARS_ANSWER, typeLabel: typeLabels[StudentFeedbackQuestionType.STARS] },
        ],
      },
    ],
    openAnswers: [{ ...OPEN_ANSWER, pillarLabel: labelsOf(locale, 'studentFeedbackPillar')[StudentFeedbackPillar.REPORT] }],
  };
}

// The auto-send block as the route sends it in the given locale, label included
function expectedAutoSend(locale) {
  return { enabled: true, next: { ...NEXT, milestoneLabel: labelsOf(locale, 'studentFeedbackMilestone')[StudentFeedbackMilestone.D15] } };
}

// Reads the history as the trainer, optionally in another language
function readHistory(language) {
  const headers = { authorization: `Bearer ${trainerToken}`, ...(language ? { [LANGUAGE_HEADER]: language } : {}) };
  return app.inject({ method: 'GET', url: STUDENT_FEEDBACKS_URL, headers });
}

beforeAll(async () => {
  app = await buildServer({ logger: false, adminDb: { $disconnect: vi.fn() } });
  await app.ready();
  trainerToken = app.jwt.sign({ sub: USER_ID, email: 'trainer@example.com', roles: [Roles.TRAINER] });
}, SERVER_LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await app?.close().catch(() => {});
}, SERVER_LIFECYCLE_TIMEOUT_MS);

beforeEach(() => {
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
});

describe('GET /trainer/students/:studentId/feedbacks response schema', () => {
  describe('autoSend', () => {
    it('should expose the auto-send state and the next milestone with its pt-BR label by default', async () => {
      getStudentHistory.mockResolvedValue(buildHistory());

      const res = await readHistory();

      expect(res.statusCode).toBe(HTTP_OK);
      expect(res.json().autoSend).toEqual(expectedAutoSend(ptBR));
    });

    it('should label the next milestone in en-US when asked', async () => {
      getStudentHistory.mockResolvedValue(buildHistory());

      const res = await readHistory(ENGLISH);

      expect(res.json().autoSend).toEqual(expectedAutoSend(enUS));
    });

    it('should expose the recurring milestone as the next one', async () => {
      const next = { milestone: StudentFeedbackMilestone.RECURRING, dueAt: NEXT_DUE_AT };
      getStudentHistory.mockResolvedValue(buildHistory({ autoSend: { enabled: true, next } }));

      const res = await readHistory();

      expect(res.json().autoSend.next).toEqual({ ...next, milestoneLabel: labelsOf(ptBR, 'studentFeedbackMilestone')[StudentFeedbackMilestone.RECURRING] });
    });

    it('should expose a null next milestone when auto-send is on and nothing is left to send', async () => {
      getStudentHistory.mockResolvedValue(buildHistory({ autoSend: { enabled: true, next: null } }));

      const res = await readHistory();

      expect(res.statusCode).toBe(HTTP_OK);
      expect(res.json().autoSend).toEqual({ enabled: true, next: null });
    });

    it('should expose auto-send off with a null next milestone', async () => {
      getStudentHistory.mockResolvedValue(buildHistory({ autoSend: { enabled: false, next: null }, feedbacks: [] }));

      const res = await readHistory();

      expect(res.statusCode).toBe(HTTP_OK);
      expect(res.json().autoSend).toEqual({ enabled: false, next: null });
    });
  });

  describe('pillars', () => {
    it('should expose the band of each pillar with its pt-BR label', async () => {
      getStudentHistory.mockResolvedValue(buildHistory());

      const res = await readHistory();

      const [pillar] = res.json().feedbacks[0].pillars;
      expect(pillar).toMatchObject({ band: StudentFeedbackBand.STABLE, bandLabel: labelsOf(ptBR, 'studentFeedbackBand')[StudentFeedbackBand.STABLE] });
    });

    it('should expose the scored answers of each pillar with the pt-BR label of their type', async () => {
      getStudentHistory.mockResolvedValue(buildHistory());

      const res = await readHistory();

      const typeLabels = labelsOf(ptBR, 'studentFeedbackQuestionType');
      expect(res.json().feedbacks[0].pillars[0].answers).toEqual([
        { ...SCORE_ANSWER, typeLabel: typeLabels[StudentFeedbackQuestionType.SCORE] },
        { ...STARS_ANSWER, typeLabel: typeLabels[StudentFeedbackQuestionType.STARS] },
      ]);
    });

    it('should label the pillar band and the answer types in en-US when asked', async () => {
      getStudentHistory.mockResolvedValue(buildHistory());

      const res = await readHistory(ENGLISH);

      expect(res.json().feedbacks[0].pillars).toEqual(expectedAnsweredFeedback(enUS).pillars);
    });

    it('should keep the pillar and its score next to the new fields', async () => {
      getStudentHistory.mockResolvedValue(buildHistory());

      const res = await readHistory();

      const [pillar] = res.json().feedbacks[0].pillars;
      expect(pillar).toMatchObject({ pillar: StudentFeedbackPillar.SLEEP, pillarLabel: labelsOf(ptBR, 'studentFeedbackPillar')[StudentFeedbackPillar.SLEEP], score: 68 });
      expect(Object.keys(pillar).sort()).toEqual(['answers', 'band', 'bandLabel', 'pillar', 'pillarLabel', 'score']);
    });
  });

  describe('whole response', () => {
    it('should expose every field it had before plus the new ones, with pt-BR labels', async () => {
      getStudentHistory.mockResolvedValue(buildHistory());

      const res = await readHistory();

      expect(res.statusCode).toBe(HTTP_OK);
      expect(getStudentHistory).toHaveBeenCalledWith(prisma, TRAINER_ID, STUDENT_ID, expect.any(Date));
      expect(res.json()).toEqual({
        student: STUDENT,
        hasPending: false,
        autoSend: expectedAutoSend(ptBR),
        feedbacks: [expectedAnsweredFeedback(ptBR)],
      });
    });

    it('should still expose every field of a feedback that was not answered', async () => {
      getStudentHistory.mockResolvedValue({ ...buildHistory({ autoSend: { enabled: false, next: null }, feedbacks: [buildPendingFeedback()] }), hasPending: true });

      const res = await readHistory();

      expect(res.json()).toMatchObject({
        student: STUDENT,
        hasPending: true,
        feedbacks: [
          {
            ...buildPendingFeedback(),
            milestoneLabel: labelsOf(ptBR, 'studentFeedbackMilestone')[StudentFeedbackMilestone.ADHOC],
            statusLabel: labelsOf(ptBR, 'studentFeedbackStatus')[StudentFeedbackStatus.PENDING],
          },
        ],
      });
    });

    it('should still expose the fields that existed before on an answered feedback', async () => {
      getStudentHistory.mockResolvedValue(buildHistory());

      const res = await readHistory();

      const { pillars: _pillars, ...legacyFields } = expectedAnsweredFeedback(ptBR);
      expect(res.json()).toMatchObject({ student: STUDENT, hasPending: false, feedbacks: [legacyFields] });
      expect(res.json().feedbacks[0].pillars[0]).toMatchObject({ pillar: StudentFeedbackPillar.SLEEP, score: 68 });
    });
  });
});
