import { beforeEach, describe, expect, it } from 'vitest';
import {
  getFeedback,
  getPendingFeedback,
  saveDraft,
  submitFeedback,
} from '../../src/services/student-feedback-student-service.js';
import {
  StudentFeedbackBand,
  StudentFeedbackErrorCode,
  StudentFeedbackMessageCode,
  StudentFeedbackMilestone,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import {
  OTHER_STUDENT_ID,
  OTHER_TRAINER_ID,
  QuestionId,
  STUDENT_ID,
  TEMPLATE_NAME,
  createFeedbackWorld,
  seedConfig,
  seedLink,
  seedRequest,
} from '../helpers/student-feedback-world.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const ANSWER_MODEL = 'studentFeedbackAnswer';
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// 09:00 America/Sao_Paulo seven days after the link
const SENT_AT = new Date('2026-11-08T12:00:00Z');
const D15_DUE = new Date('2026-11-16T12:00:00Z');
const NOW = new Date('2026-11-08T18:00:00Z');
const AFTER_WINDOW = new Date(SENT_AT.getTime() + 3 * DAY_MS + HOUR_MS);
const UNKNOWN_ID = 'request-unknown';
const QUESTIONS_WITHOUT_MEAL_PLAN = [QuestionId.TRAINING, QuestionId.SLEEP, QuestionId.ROUTINE, QuestionId.EVOLUTION, QuestionId.HYDRATION, QuestionId.REPORT];
const QUESTIONS_WITH_MEAL_PLAN = [QuestionId.TRAINING, QuestionId.DIET, QuestionId.SLEEP, QuestionId.ROUTINE, QuestionId.EVOLUTION, QuestionId.HYDRATION, QuestionId.REPORT];
// Pillars 80, 75, 70 (inverted) and 90: mean 78.75, index 79
const REQUIRED_ANSWERS = Object.freeze([
  { questionId: QuestionId.TRAINING, score: 8 },
  { questionId: QuestionId.SLEEP, score: 4 },
  { questionId: QuestionId.ROUTINE, score: 3 },
  { questionId: QuestionId.EVOLUTION, score: 9 },
]);
const EXPECTED_INDEX = 79;

// Awaits the rejection and asserts the student-feedback error of the given key and HTTP status
async function expectFeedbackError(promise, key, httpStatus) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).not.toBeNull();
  expect(error.httpStatus).toBe(httpStatus);
  expect(error.error).toBe(StudentFeedbackErrorCode[key]);
  expect(error.messageCode).toBe(StudentFeedbackMessageCode[key]);
}

// Answers sorted by question id, reduced to the contract fields
function byQuestion(answers) {
  return [...answers]
    .map(({ questionId, score, text }) => ({ questionId, score, text }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
}

describe('student feedback student service', () => {
  let world;
  let request;

  beforeEach(() => {
    world = createFeedbackWorld();
    seedConfig(world);
    seedLink(world, { createdAt: LINKED_AT });
    request = seedRequest(world, { sentAt: SENT_AT });
  });

  describe('getPendingFeedback', () => {
    it('returns the header of the pending request', async () => {
      const { feedback } = await getPendingFeedback(world.prisma, STUDENT_ID, NOW);

      expect(feedback).toMatchObject({
        id: request.id,
        milestone: StudentFeedbackMilestone.D7,
        title: TEMPLATE_NAME,
        trainer: { name: 'Rafael Silva', avatarUrl: null },
        questionCount: QUESTIONS_WITHOUT_MEAL_PLAN.length,
        expiresAt: request.expiresAt,
        daysLeft: 3,
      });
    });

    it('estimates a whole positive number of minutes', async () => {
      const { feedback } = await getPendingFeedback(world.prisma, STUDENT_ID, NOW);

      expect(Number.isInteger(feedback.estimatedMinutes)).toBe(true);
      expect(feedback.estimatedMinutes).toBeGreaterThan(0);
    });

    it('counts the meal-plan question only when the request recorded a meal plan', async () => {
      request.hasMealPlan = true;

      const { feedback } = await getPendingFeedback(world.prisma, STUDENT_ID, NOW);

      expect(feedback.questionCount).toBe(QUESTIONS_WITH_MEAL_PLAN.length);
    });

    it('returns null when the student has no request', async () => {
      expect(await getPendingFeedback(world.prisma, OTHER_STUDENT_ID, NOW)).toEqual({ feedback: null });
    });

    it.each([StudentFeedbackStatus.ANSWERED, StudentFeedbackStatus.EXPIRED])('returns null when the only request is %s', async (status) => {
      request.status = status;

      expect(await getPendingFeedback(world.prisma, STUDENT_ID, NOW)).toEqual({ feedback: null });
    });

    it('returns null when the pending request is past expiresAt but the cron has not marked it yet', async () => {
      expect(await getPendingFeedback(world.prisma, STUDENT_ID, AFTER_WINDOW)).toEqual({ feedback: null });
    });

    it('returns the most recent pending request when two are open', async () => {
      const adhoc = seedRequest(world, { trainerId: OTHER_TRAINER_ID, milestone: StudentFeedbackMilestone.ADHOC, sentAt: new Date(SENT_AT.getTime() + HOUR_MS) });

      const { feedback } = await getPendingFeedback(world.prisma, STUDENT_ID, NOW);

      expect(feedback.id).toBe(adhoc.id);
      expect(feedback.trainer.name).toBe('Paula Silva');
    });
  });

  describe('getFeedback', () => {
    it('returns the header fields with the status', async () => {
      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, NOW);

      expect(feedback).toMatchObject({
        id: request.id,
        milestone: StudentFeedbackMilestone.D7,
        title: TEMPLATE_NAME,
        status: StudentFeedbackStatus.PENDING,
        trainer: { name: 'Rafael Silva', avatarUrl: null },
        questionCount: QUESTIONS_WITHOUT_MEAL_PLAN.length,
        expiresAt: request.expiresAt,
        daysLeft: 3,
      });
    });

    it('returns the questions in order, without the meal-plan question when the request has no meal plan', async () => {
      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, NOW);

      expect(feedback.questions.map((question) => question.id)).toEqual(QUESTIONS_WITHOUT_MEAL_PLAN);
    });

    it('includes the meal-plan question when the request recorded a meal plan', async () => {
      request.hasMealPlan = true;

      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, NOW);

      expect(feedback.questions.map((question) => question.id)).toEqual(QUESTIONS_WITH_MEAL_PLAN);
    });

    it('returns each question with the contract fields', async () => {
      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, NOW);

      expect(feedback.questions[0]).toMatchObject({
        id: QuestionId.TRAINING,
        order: 1,
        text: 'Como foi tua adesão aos treinos?',
        helpText: null,
        type: StudentFeedbackQuestionType.SCORE,
        required: true,
        minLabel: 'Não treinei',
        maxLabel: 'Fiz tudo',
      });
      expect(feedback.questions.at(-1)).toMatchObject({ id: QuestionId.REPORT, helpText: 'Opcional', type: StudentFeedbackQuestionType.OPEN, required: false });
    });

    it('returns no answers before any draft was saved', async () => {
      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, NOW);

      expect(feedback.answers).toEqual([]);
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for the request of another student', async () => {
      await expectFeedbackError(getFeedback(world.prisma, OTHER_STUDENT_ID, request.id, NOW), 'NOT_FOUND', 404);
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for an unknown request', async () => {
      await expectFeedbackError(getFeedback(world.prisma, STUDENT_ID, UNKNOWN_ID, NOW), 'NOT_FOUND', 404);
    });
  });

  describe('saveDraft', () => {
    const DRAFT = Object.freeze([
      { questionId: QuestionId.TRAINING, score: 8 },
      { questionId: QuestionId.SLEEP, score: 4 },
      { questionId: QuestionId.REPORT, text: 'Semana puxada no trabalho' },
    ]);
    const STORED_DRAFT = [
      { questionId: QuestionId.REPORT, score: null, text: 'Semana puxada no trabalho' },
      { questionId: QuestionId.SLEEP, score: 4, text: null },
      { questionId: QuestionId.TRAINING, score: 8, text: null },
    ];

    it('returns the saved answers', async () => {
      const result = await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: DRAFT }, NOW);

      expect(byQuestion(result.answers)).toEqual(STORED_DRAFT);
    });

    it('gives the saved answers back when the request is read again', async () => {
      await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: DRAFT }, NOW);

      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, NOW);

      expect(byQuestion(feedback.answers)).toEqual(STORED_DRAFT);
    });

    it('keeps the request pending', async () => {
      await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: DRAFT }, NOW);

      expect(request.status).toBe(StudentFeedbackStatus.PENDING);
      expect(request.submittedAt).toBeNull();
    });

    it('replaces the answer of a question saved before and keeps the others', async () => {
      await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: DRAFT }, NOW);

      await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: [{ questionId: QuestionId.TRAINING, score: 5 }] }, NOW);

      const feedback = await getFeedback(world.prisma, STUDENT_ID, request.id, NOW);
      expect(byQuestion(feedback.answers)).toEqual([STORED_DRAFT[0], STORED_DRAFT[1], { questionId: QuestionId.TRAINING, score: 5, text: null }]);
    });

    it.each([
      ['a score above 10', { questionId: QuestionId.TRAINING, score: 11 }],
      ['a score below 0', { questionId: QuestionId.TRAINING, score: -1 }],
      ['a fractional score', { questionId: QuestionId.TRAINING, score: 7.5 }],
      ['zero stars', { questionId: QuestionId.SLEEP, score: 0 }],
      ['six stars', { questionId: QuestionId.SLEEP, score: 6 }],
      ['an unknown question', { questionId: 'q-unknown', score: 5 }],
      ['the meal-plan question when the request has no meal plan', { questionId: QuestionId.DIET, score: 5 }],
    ])('answers STUDENT_FEEDBACK_INVALID_ANSWER for %s and saves nothing', async (_label, invalid) => {
      const answers = [{ questionId: QuestionId.EVOLUTION, score: 9 }, invalid];

      await expectFeedbackError(saveDraft(world.prisma, STUDENT_ID, request.id, { answers }, NOW), 'INVALID_ANSWER', 400);

      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it.each([
      ['a score of 0', { questionId: QuestionId.TRAINING, score: 0 }],
      ['a score of 10', { questionId: QuestionId.TRAINING, score: 10 }],
      ['one star', { questionId: QuestionId.SLEEP, score: 1 }],
      ['five stars', { questionId: QuestionId.SLEEP, score: 5 }],
    ])('accepts the boundary value %s', async (_label, answer) => {
      const result = await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: [answer] }, NOW);

      expect(byQuestion(result.answers)).toEqual([{ ...answer, text: null }]);
    });

    it('accepts the meal-plan question when the request recorded a meal plan', async () => {
      request.hasMealPlan = true;

      const result = await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: [{ questionId: QuestionId.DIET, score: 6 }] }, NOW);

      expect(byQuestion(result.answers)).toEqual([{ questionId: QuestionId.DIET, score: 6, text: null }]);
    });

    it('answers STUDENT_FEEDBACK_EXPIRED for a request marked expired', async () => {
      request.status = StudentFeedbackStatus.EXPIRED;

      await expectFeedbackError(saveDraft(world.prisma, STUDENT_ID, request.id, { answers: DRAFT }, NOW), 'EXPIRED', 409);
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers STUDENT_FEEDBACK_EXPIRED for a pending request past expiresAt', async () => {
      await expectFeedbackError(saveDraft(world.prisma, STUDENT_ID, request.id, { answers: DRAFT }, AFTER_WINDOW), 'EXPIRED', 409);
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for the request of another student and saves nothing', async () => {
      await expectFeedbackError(saveDraft(world.prisma, OTHER_STUDENT_ID, request.id, { answers: DRAFT }, NOW), 'NOT_FOUND', 404);
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for an unknown request', async () => {
      await expectFeedbackError(saveDraft(world.prisma, STUDENT_ID, UNKNOWN_ID, { answers: DRAFT }, NOW), 'NOT_FOUND', 404);
    });
  });

  describe('submitFeedback', () => {
    it('marks the request answered at the submit instant', async () => {
      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW);

      expect(request.status).toBe(StudentFeedbackStatus.ANSWERED);
      expect(request.submittedAt).toEqual(NOW);
    });

    it('stores the overall index and its band', async () => {
      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW);

      expect(request.overallIndex).toBe(EXPECTED_INDEX);
      expect(request.band).toBe(StudentFeedbackBand.GOOD);
    });

    it('stores a stable band for a middling result', async () => {
      const answers = [
        { questionId: QuestionId.TRAINING, score: 6 },
        { questionId: QuestionId.SLEEP, score: 3 },
        { questionId: QuestionId.ROUTINE, score: 4 },
        { questionId: QuestionId.EVOLUTION, score: 6 },
      ];

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW);

      expect(request.overallIndex).toBe(58);
      expect(request.band).toBe(StudentFeedbackBand.STABLE);
    });

    it('stores an attention band for a low result', async () => {
      const answers = [
        { questionId: QuestionId.TRAINING, score: 2 },
        { questionId: QuestionId.SLEEP, score: 2 },
        { questionId: QuestionId.ROUTINE, score: 8 },
        { questionId: QuestionId.EVOLUTION, score: 3 },
      ];

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW);

      expect(request.overallIndex).toBe(24);
      expect(request.band).toBe(StudentFeedbackBand.ATTENTION);
    });

    it('counts an optional scored answer in the index', async () => {
      const answers = [...REQUIRED_ANSWERS, { questionId: QuestionId.HYDRATION, score: 1 }];

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW);

      expect(request.overallIndex).toBe(63);
    });

    it('keeps the submitted answers', async () => {
      const answers = [...REQUIRED_ANSWERS, { questionId: QuestionId.REPORT, text: 'Tudo certo' }];

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW);

      const stored = world.rows(ANSWER_MODEL).filter((row) => row.requestId === request.id);
      expect(byQuestion(stored)).toEqual(
        byQuestion([...REQUIRED_ANSWERS.map((answer) => ({ ...answer, text: null })), { questionId: QuestionId.REPORT, score: null, text: 'Tudo certo' }]),
      );
    });

    it('completes the answers saved as a draft with the ones sent on submit', async () => {
      await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS.slice(0, 3) }, NOW);

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS.slice(3) }, NOW);

      expect(request.status).toBe(StudentFeedbackStatus.ANSWERED);
      expect(request.overallIndex).toBe(EXPECTED_INDEX);
    });

    it('returns the instant of the next milestone as nextFeedbackAt', async () => {
      const result = await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW);

      expect(new Date(result.nextFeedbackAt)).toEqual(D15_DUE);
    });

    it('returns a null nextFeedbackAt when the trainer has auto-send off', async () => {
      world.rows('studentFeedbackConfig')[0].autoSendEnabled = false;

      const result = await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW);

      expect(result).toEqual({ nextFeedbackAt: null });
    });

    it('answers STUDENT_FEEDBACK_REQUIRED_ANSWER_MISSING when a required question has no answer', async () => {
      const answers = REQUIRED_ANSWERS.slice(1);

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW), 'REQUIRED_ANSWER_MISSING', 400);

      expect(request.status).toBe(StudentFeedbackStatus.PENDING);
      expect(request.overallIndex).toBeNull();
    });

    it('requires the meal-plan question when the request recorded a meal plan', async () => {
      request.hasMealPlan = true;

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'REQUIRED_ANSWER_MISSING', 400);

      expect(request.status).toBe(StudentFeedbackStatus.PENDING);
    });

    it('accepts the submit with the meal-plan question answered', async () => {
      request.hasMealPlan = true;
      const answers = [...REQUIRED_ANSWERS, { questionId: QuestionId.DIET, score: 10 }];

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW);

      expect(request.status).toBe(StudentFeedbackStatus.ANSWERED);
      expect(request.overallIndex).toBe(83);
    });

    it('answers STUDENT_FEEDBACK_INVALID_ANSWER for an out-of-range value and keeps the request pending', async () => {
      const answers = [...REQUIRED_ANSWERS.slice(1), { questionId: QuestionId.TRAINING, score: 12 }];

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW), 'INVALID_ANSWER', 400);

      expect(request.status).toBe(StudentFeedbackStatus.PENDING);
    });

    it('answers STUDENT_FEEDBACK_ALREADY_SUBMITTED on a second submit', async () => {
      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW);

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'ALREADY_SUBMITTED', 409);
    });

    it('answers STUDENT_FEEDBACK_EXPIRED for a request marked expired', async () => {
      request.status = StudentFeedbackStatus.EXPIRED;

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'EXPIRED', 409);
    });

    it('answers STUDENT_FEEDBACK_EXPIRED for a pending request past expiresAt', async () => {
      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, AFTER_WINDOW), 'EXPIRED', 409);

      expect(request.submittedAt).toBeNull();
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for the request of another student and leaves it pending', async () => {
      await expectFeedbackError(submitFeedback(world.prisma, OTHER_STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'NOT_FOUND', 404);

      expect(request.status).toBe(StudentFeedbackStatus.PENDING);
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for an unknown request', async () => {
      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, UNKNOWN_ID, { answers: REQUIRED_ANSWERS }, NOW), 'NOT_FOUND', 404);
    });
  });
});
