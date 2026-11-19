import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveDraft, submitFeedback } from '../../src/services/student-feedback-student-service.js';
import { scoreFeedback } from '../../src/helpers/student-feedback-score.js';
import {
  StudentFeedbackErrorCode,
  StudentFeedbackMessageCode,
  StudentFeedbackPillar,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import { QuestionId, STUDENT_ID, createFeedbackWorld, seedConfig, seedLink, seedRequest } from '../helpers/student-feedback-world.js';

const HOUR_MS = 3600000;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const ANSWER_MODEL = 'studentFeedbackAnswer';
const QUESTION_MODEL = 'studentFeedbackQuestion';
const UNKNOWN_QUESTION_TYPE = 'slider';
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
const SENT_AT = new Date('2026-11-08T12:00:00Z');
const NOW = new Date('2026-11-08T18:00:00Z');
const BEFORE_NOW = new Date(NOW.getTime() - HOUR_MS);
const TRAINING_ANSWER = Object.freeze({ questionId: QuestionId.TRAINING, score: 8 });
const OTHER_REQUIRED_ANSWERS = Object.freeze([
  { questionId: QuestionId.SLEEP, score: 4 },
  { questionId: QuestionId.ROUTINE, score: 3 },
  { questionId: QuestionId.EVOLUTION, score: 9 },
]);
const REQUIRED_ANSWERS = Object.freeze([TRAINING_ANSWER, ...OTHER_REQUIRED_ANSWERS]);
const LOW_TRAINING_SCORE = 2;
const LOW_TRAINING_PILLAR = 20;

// Awaits the rejection and asserts the student-feedback error of the given key and HTTP status; returns the error
async function expectFeedbackError(promise, key, httpStatus) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).not.toBeNull();
  expect(error.httpStatus).toBe(httpStatus);
  expect(error.error).toBe(StudentFeedbackErrorCode[key]);
  expect(error.messageCode).toBe(StudentFeedbackMessageCode[key]);
  return error;
}

// Runs the change while the service waits for the row lock, as a competing transaction that committed first would
function whileWaitingForTheLock(world, change) {
  vi.spyOn(world.prisma, '$queryRaw').mockImplementation(async () => {
    await change();
    return [{ locked: true }];
  });
}

// Runs the change right before the request is claimed as answered, after it was read under the lock
function rightBeforeTheClaim(world, change) {
  const requests = world.prisma.studentFeedbackRequest;
  const updateMany = requests.updateMany;
  vi.spyOn(requests, 'updateMany').mockImplementation(async (args) => {
    change();
    return updateMany(args);
  });
}

// Stored answers of a request reduced to the contract fields, sorted by question id
function storedAnswers(world, requestId) {
  return world
    .rows(ANSWER_MODEL)
    .filter((row) => row.requestId === requestId)
    .map(({ questionId, score, text }) => ({ questionId, score: score ?? null, text: text ?? null }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
}

// Questions the student sees in a request without meal plan
function visibleQuestionRows(world) {
  return world.rows(QUESTION_MODEL).filter((question) => question.id !== QuestionId.DIET);
}

// Asserts the request was left pending, without submit date or scores
function expectStillPending(request) {
  expect(request.status).toBe(StudentFeedbackStatus.PENDING);
  expect(request.submittedAt).toBeNull();
  expect(request.overallIndex).toBeNull();
}

describe('student feedback student service review fixes', () => {
  let world;
  let request;

  beforeEach(() => {
    world = createFeedbackWorld();
    seedConfig(world);
    seedLink(world, { createdAt: LINKED_AT });
    request = seedRequest(world, { sentAt: SENT_AT });
  });

  describe('saveDraft that lost a race', () => {
    it('answers STUDENT_FEEDBACK_ALREADY_SUBMITTED and stores nothing when the request was submitted while it waited for the lock', async () => {
      whileWaitingForTheLock(world, () => {
        request.status = StudentFeedbackStatus.ANSWERED;
      });

      await expectFeedbackError(saveDraft(world.prisma, STUDENT_ID, request.id, { answers: [TRAINING_ANSWER] }, NOW), 'ALREADY_SUBMITTED', HTTP_CONFLICT);

      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers STUDENT_FEEDBACK_EXPIRED and stores nothing when the request was marked expired while it waited for the lock', async () => {
      whileWaitingForTheLock(world, () => {
        request.status = StudentFeedbackStatus.EXPIRED;
      });

      await expectFeedbackError(saveDraft(world.prisma, STUDENT_ID, request.id, { answers: [TRAINING_ANSWER] }, NOW), 'EXPIRED', HTTP_CONFLICT);

      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('does not rewrite the answers of a request that was scored while it waited for the lock', async () => {
      await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, BEFORE_NOW);
      const scoredAnswers = storedAnswers(world, request.id);
      whileWaitingForTheLock(world, () => {
        request.status = StudentFeedbackStatus.ANSWERED;
      });
      const change = [{ questionId: QuestionId.TRAINING, score: LOW_TRAINING_SCORE }];

      await expectFeedbackError(saveDraft(world.prisma, STUDENT_ID, request.id, { answers: change }, NOW), 'ALREADY_SUBMITTED', HTTP_CONFLICT);

      expect(storedAnswers(world, request.id)).toEqual(scoredAnswers);
    });
  });

  describe('submitFeedback that lost a race', () => {
    it('answers STUDENT_FEEDBACK_ALREADY_SUBMITTED when another submit won while it waited for the lock', async () => {
      const firstSubmittedAt = BEFORE_NOW;
      whileWaitingForTheLock(world, () => {
        request.status = StudentFeedbackStatus.ANSWERED;
        request.submittedAt = firstSubmittedAt;
      });

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'ALREADY_SUBMITTED', HTTP_CONFLICT);

      expect(request.submittedAt).toEqual(firstSubmittedAt);
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers STUDENT_FEEDBACK_EXPIRED when the request was marked expired while it waited for the lock', async () => {
      whileWaitingForTheLock(world, () => {
        request.status = StudentFeedbackStatus.EXPIRED;
      });

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'EXPIRED', HTTP_CONFLICT);

      expect(request.status).toBe(StudentFeedbackStatus.EXPIRED);
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers STUDENT_FEEDBACK_ALREADY_SUBMITTED when the claim finds the request already answered', async () => {
      rightBeforeTheClaim(world, () => {
        request.status = StudentFeedbackStatus.ANSWERED;
      });

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'ALREADY_SUBMITTED', HTTP_CONFLICT);

      expect(request.overallIndex).toBeNull();
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers STUDENT_FEEDBACK_EXPIRED when the claim finds the request marked expired', async () => {
      rightBeforeTheClaim(world, () => {
        request.status = StudentFeedbackStatus.EXPIRED;
      });

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'EXPIRED', HTTP_CONFLICT);

      expect(request.overallIndex).toBeNull();
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });
  });

  describe('submitFeedback when expiresAt passed between the read and the claim', () => {
    it('refuses with STUDENT_FEEDBACK_EXPIRED, leaves the request pending and stores no answer', async () => {
      rightBeforeTheClaim(world, () => {
        request.expiresAt = BEFORE_NOW;
      });

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'EXPIRED', HTTP_CONFLICT);

      expectStillPending(request);
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('refuses a request that expires exactly at the submit instant', async () => {
      rightBeforeTheClaim(world, () => {
        request.expiresAt = NOW;
      });

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'EXPIRED', HTTP_CONFLICT);

      expectStillPending(request);
    });

    it('refuses with STUDENT_FEEDBACK_EXPIRED when the window closed while it waited for the lock', async () => {
      whileWaitingForTheLock(world, () => {
        request.expiresAt = BEFORE_NOW;
      });

      await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW), 'EXPIRED', HTTP_CONFLICT);

      expectStillPending(request);
    });
  });

  describe('question of an unknown type', () => {
    beforeEach(() => {
      world.rows(QUESTION_MODEL).find((question) => question.id === QuestionId.HYDRATION).type = UNKNOWN_QUESTION_TYPE;
    });

    it('answers 400 STUDENT_FEEDBACK_INVALID_ANSWER with the question id on a draft', async () => {
      const answers = [{ questionId: QuestionId.HYDRATION, score: 3 }];

      const error = await expectFeedbackError(saveDraft(world.prisma, STUDENT_ID, request.id, { answers }, NOW), 'INVALID_ANSWER', HTTP_BAD_REQUEST);

      expect(error.details).toEqual({ questionId: QuestionId.HYDRATION });
      expect(world.rows(ANSWER_MODEL)).toHaveLength(0);
    });

    it('answers 400 STUDENT_FEEDBACK_INVALID_ANSWER on a submit and keeps the request pending', async () => {
      const answers = [...REQUIRED_ANSWERS, { questionId: QuestionId.HYDRATION, score: 3 }];

      const error = await expectFeedbackError(submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW), 'INVALID_ANSWER', HTTP_BAD_REQUEST);

      expect(error.details).toEqual({ questionId: QuestionId.HYDRATION });
      expectStillPending(request);
    });

    it('still accepts a submit that leaves the question of the unknown type empty', async () => {
      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: REQUIRED_ANSWERS }, NOW);

      expect(request.status).toBe(StudentFeedbackStatus.ANSWERED);
    });
  });

  describe('score computed from the answers as stored', () => {
    beforeEach(async () => {
      await saveDraft(world.prisma, STUDENT_ID, request.id, { answers: [TRAINING_ANSWER] }, BEFORE_NOW);
    });

    it('scores the draft answer saved while the submit waited for the lock, not the one read before it', async () => {
      whileWaitingForTheLock(world, () => {
        world.rows(ANSWER_MODEL).find((row) => row.questionId === QuestionId.TRAINING).score = LOW_TRAINING_SCORE;
      });

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: OTHER_REQUIRED_ANSWERS }, NOW);

      expect(request.pillarScores[StudentFeedbackPillar.TRAINING_ADHERENCE]).toBe(LOW_TRAINING_PILLAR);
    });

    it('stores an index, band and pillar scores that match the stored answers after such a race', async () => {
      whileWaitingForTheLock(world, () => {
        world.rows(ANSWER_MODEL).find((row) => row.questionId === QuestionId.TRAINING).score = LOW_TRAINING_SCORE;
      });

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: OTHER_REQUIRED_ANSWERS }, NOW);

      const expected = scoreFeedback(visibleQuestionRows(world), storedAnswers(world, request.id));
      expect({ pillars: request.pillarScores, overallIndex: request.overallIndex, band: request.band }).toEqual(expected);
    });

    it('counts a draft answer that was first saved while the submit waited for the lock', async () => {
      whileWaitingForTheLock(world, () => world.prisma.studentFeedbackAnswer.create({ data: { requestId: request.id, questionId: QuestionId.HYDRATION, score: 5, text: null } }));

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: OTHER_REQUIRED_ANSWERS }, NOW);

      expect(request.pillarScores[StudentFeedbackPillar.HYDRATION]).toBe(100);
    });

    it('refuses the submit when a required draft answer was cleared while it waited for the lock', async () => {
      whileWaitingForTheLock(world, () => {
        world.rows(ANSWER_MODEL).splice(0);
      });

      const error = await expectFeedbackError(
        submitFeedback(world.prisma, STUDENT_ID, request.id, { answers: OTHER_REQUIRED_ANSWERS }, NOW),
        'REQUIRED_ANSWER_MISSING',
        HTTP_BAD_REQUEST,
      );

      expect(error.details).toEqual({ questionIds: [QuestionId.TRAINING] });
      expectStillPending(request);
    });

    it('lets the answers of the submit win over the stored draft in the score', async () => {
      const answers = [{ questionId: QuestionId.TRAINING, score: LOW_TRAINING_SCORE }, ...OTHER_REQUIRED_ANSWERS];

      await submitFeedback(world.prisma, STUDENT_ID, request.id, { answers }, NOW);

      expect(request.pillarScores[StudentFeedbackPillar.TRAINING_ADHERENCE]).toBe(LOW_TRAINING_PILLAR);
      expect(storedAnswers(world, request.id)).toContainEqual({ questionId: QuestionId.TRAINING, score: LOW_TRAINING_SCORE, text: null });
    });
  });
});
