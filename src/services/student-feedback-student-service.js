/**
 * Student side of the feedbacks: the pending card, the questionnaire, draft saves and the submit.
 */

import {
  ANSWER_RANGES,
  ESTIMATED_SECONDS_PER_QUESTION,
  OPEN_ANSWER_MAX_LENGTH,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
} from '../constants/student-feedback.js';
import { daysLeft, isExpired, nextMilestoneAt } from '../helpers/student-feedback-schedule.js';
import { lockStudentFeedbackRequestForUpdate } from '../helpers/row-locks.js';
import { scoreFeedback } from '../helpers/student-feedback-score.js';
import {
  PERSON_NAME_SELECT,
  alreadySubmittedError,
  expiredError,
  fullNameOf,
  invalidAnswerError,
  notFoundError,
  requiredAnswerMissingError,
  visibleQuestions,
} from './student-feedback-shared.js';

const SECONDS_PER_MINUTE = 60;
const REQUEST_INCLUDE = Object.freeze({
  template: { include: { questions: { orderBy: { order: 'asc' } } } },
  trainer: { select: { user: { select: { ...PERSON_NAME_SELECT, avatarUrl: true } } } },
  answers: true,
});

// Request of the student with its template, trainer and answers; 404 when it does not exist or is not theirs
async function requireOwnRequest(prisma, studentId, requestId) {
  const request = await prisma.studentFeedbackRequest.findFirst({ where: { id: requestId, studentId }, include: REQUEST_INCLUDE });
  if (!request) throw notFoundError();
  return request;
}

// Throws unless the request still accepts answers
function assertOpen(request, now) {
  if (request.status === StudentFeedbackStatus.ANSWERED) throw alreadySubmittedError();
  if (isExpired(request, now)) throw expiredError();
}

// Status the student sees: a pending request past its window already reads as expired
function effectiveStatus(request, now) {
  return isExpired(request, now) ? StudentFeedbackStatus.EXPIRED : request.status;
}

// Whole minutes the questionnaire should take, at least one
function estimateMinutes(questionCount) {
  return Math.max(1, Math.ceil((questionCount * ESTIMATED_SECONDS_PER_QUESTION) / SECONDS_PER_MINUTE));
}

// Header fields of a request for the student
function toHeader(request, questions, now) {
  const trainerUser = request.trainer.user;
  return {
    id: request.id,
    milestone: request.milestone,
    title: request.template.name,
    trainer: { name: fullNameOf(trainerUser), avatarUrl: trainerUser.avatarUrl ?? null },
    questionCount: questions.length,
    estimatedMinutes: estimateMinutes(questions.length),
    expiresAt: request.expiresAt,
    daysLeft: daysLeft(request.expiresAt, now),
  };
}

// Contract fields of a question
function toQuestion(question) {
  return {
    id: question.id,
    order: question.order,
    text: question.text,
    helpText: question.helpText ?? null,
    type: question.type,
    required: question.required,
    minLabel: question.minLabel ?? null,
    maxLabel: question.maxLabel ?? null,
  };
}

// Stored answers of the visible questions, in question order, with the contract fields
function toAnswers(questions, storedAnswers) {
  const byQuestion = new Map(storedAnswers.map((answer) => [answer.questionId, answer]));
  return questions
    .filter((question) => byQuestion.has(question.id))
    .map((question) => ({ questionId: question.id, score: byQuestion.get(question.id).score ?? null, text: byQuestion.get(question.id).text ?? null }));
}

// Validated integer of a scored answer, or null when it was left empty
function normalizeScore(question, input) {
  if (input.score === null || input.score === undefined) return null;
  const range = ANSWER_RANGES[question.type];
  if (!range || !Number.isInteger(input.score) || input.score < range.min || input.score > range.max) throw invalidAnswerError(question.id);
  return input.score;
}

// Trimmed text of an open answer, or null when it was left empty
function normalizeText(question, input) {
  if (input.text === null || input.text === undefined) return null;
  if (typeof input.text !== 'string' || input.text.length > OPEN_ANSWER_MAX_LENGTH) throw invalidAnswerError(question.id);
  return input.text.trim() || null;
}

// One validated answer: scored types keep only the score, open ones only the text
function normalizeAnswer(question, input) {
  if (question.type === StudentFeedbackQuestionType.OPEN) return { questionId: question.id, score: null, text: normalizeText(question, input) };
  return { questionId: question.id, score: normalizeScore(question, input), text: null };
}

// Validated answers of the payload, one per question (the last one wins); throws on an unknown question or an invalid value
function normalizeAnswers(questions, inputs) {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const byQuestion = new Map();
  for (const input of inputs ?? []) {
    const question = questionById.get(input.questionId);
    if (!question) throw invalidAnswerError(input.questionId);
    byQuestion.set(question.id, normalizeAnswer(question, input));
  }
  return [...byQuestion.values()];
}

// Whether a normalized answer carries no value (the student cleared or skipped the question)
function isEmptyAnswer(answer) {
  return answer.score === null && answer.text === null;
}

// Stores the answers: an empty one removes what was saved for its question
async function applyAnswers(tx, requestId, answers) {
  for (const { questionId, score, text } of answers) {
    if (isEmptyAnswer({ score, text })) {
      await tx.studentFeedbackAnswer.deleteMany({ where: { requestId, questionId } });
      continue;
    }
    await tx.studentFeedbackAnswer.upsert({
      where: { requestId_questionId: { requestId, questionId } },
      update: { score, text },
      create: { requestId, questionId, score, text },
    });
  }
}

// Saved draft completed and overridden by the answers of the payload, without the empty ones
function mergeAnswers(storedAnswers, changes) {
  const byQuestion = new Map(storedAnswers.map((answer) => [answer.questionId, answer]));
  for (const change of changes) byQuestion.set(change.questionId, change);
  return [...byQuestion.values()].filter((answer) => !isEmptyAnswer({ score: answer.score ?? null, text: answer.text ?? null }));
}

// Throws when a required visible question has no answer
function assertRequiredAnswered(questions, answers) {
  const answered = new Set(answers.map((answer) => answer.questionId));
  const missing = questions.filter((question) => question.required && !answered.has(question.id)).map((question) => question.id);
  if (missing.length > 0) throw requiredAnswerMissingError(missing);
}

// Request of the student read again under its row lock, so a draft save and a submit of one request never interleave; throws unless it still accepts answers
async function lockOpenRequest(tx, studentId, requestId, now) {
  await lockStudentFeedbackRequestForUpdate(tx, requestId);
  const request = await requireOwnRequest(tx, studentId, requestId);
  assertOpen(request, now);
  return request;
}

// Throws the reason a request stopped accepting answers: answered, else expired
async function throwClosedError(tx, requestId) {
  const current = await tx.studentFeedbackRequest.findFirst({ where: { id: requestId }, select: { status: true } });
  if (current?.status === StudentFeedbackStatus.ANSWERED) throw alreadySubmittedError();
  throw expiredError();
}

// Marks the request answered with its scores while it is still pending inside its window; a lost race answers ALREADY_SUBMITTED or EXPIRED
async function claimSubmission(tx, requestId, result, now) {
  const claimed = await tx.studentFeedbackRequest.updateMany({
    where: { id: requestId, status: StudentFeedbackStatus.PENDING, expiresAt: { gt: now } },
    data: {
      status: StudentFeedbackStatus.ANSWERED,
      submittedAt: now,
      overallIndex: result.overallIndex,
      band: result.band,
      pillarScores: result.pillars,
    },
  });
  if (claimed.count === 0) await throwClosedError(tx, requestId);
}

// Validates the payload over the draft stored right now, scores it and stores the submission, all under the row lock of the request
function storeSubmission(prisma, { studentId, requestId, answers, now }) {
  return prisma.$transaction(async (tx) => {
    const request = await lockOpenRequest(tx, studentId, requestId, now);
    const questions = visibleQuestions(request);
    const changes = normalizeAnswers(questions, answers);
    const merged = mergeAnswers(request.answers, changes);
    assertRequiredAnswered(questions, merged);
    await claimSubmission(tx, request.id, scoreFeedback(questions, merged), now);
    await applyAnswers(tx, request.id, changes);
    return request;
  });
}

// Validates and stores the draft answers under the row lock of the request and returns every answer saved so far
function storeDraft(prisma, { studentId, requestId, answers, now }) {
  return prisma.$transaction(async (tx) => {
    const request = await lockOpenRequest(tx, studentId, requestId, now);
    const questions = visibleQuestions(request);
    await applyAnswers(tx, request.id, normalizeAnswers(questions, answers));
    const stored = await tx.studentFeedbackAnswer.findMany({ where: { requestId: request.id } });
    return toAnswers(questions, stored);
  });
}

// Due instant of the student's next automatic feedback from this trainer, or null when none is scheduled
async function findNextFeedbackAt(prisma, { trainerId, studentId }, now) {
  const [link, config] = await Promise.all([
    prisma.trainerStudent.findUnique({ where: { trainerId_studentId: { trainerId, studentId } }, select: { createdAt: true, activeOnPlan: true } }),
    prisma.studentFeedbackConfig.findUnique({ where: { trainerId } }),
  ]);
  if (!link?.activeOnPlan) return null;
  return nextMilestoneAt({ linkedAt: link.createdAt, config, after: now });
}

/**
 * Header of the student's most recent request that still accepts answers, for the home card.
 *
 * @param {object} prisma
 * @param {string} studentId - User.id
 * @param {Date} [now]
 * @returns {Promise<{ feedback: object|null }>}
 */
export async function getPendingFeedback(prisma, studentId, now = new Date()) {
  const request = await prisma.studentFeedbackRequest.findFirst({
    where: { studentId, status: StudentFeedbackStatus.PENDING, expiresAt: { gt: now } },
    orderBy: { sentAt: 'desc' },
    include: REQUEST_INCLUDE,
  });
  if (!request) return { feedback: null };
  return { feedback: toHeader(request, visibleQuestions(request), now) };
}

/**
 * One request of the student with its questions and the answers saved so far.
 *
 * @param {object} prisma
 * @param {string} studentId - User.id
 * @param {string} requestId
 * @param {Date} [now]
 * @returns {Promise<object>}
 */
export async function getFeedback(prisma, studentId, requestId, now = new Date()) {
  const request = await requireOwnRequest(prisma, studentId, requestId);
  const questions = visibleQuestions(request);
  return {
    ...toHeader(request, questions, now),
    status: effectiveStatus(request, now),
    questions: questions.map(toQuestion),
    answers: toAnswers(questions, request.answers),
  };
}

/**
 * Saves answers as a draft: validates everything first, replaces the answer of each question sent and keeps the others.
 *
 * @param {object} prisma
 * @param {string} studentId - User.id
 * @param {string} requestId
 * @param {{ answers: Array<{ questionId: string, score?: number|null, text?: string|null }> }} body
 * @param {Date} [now]
 * @returns {Promise<{ answers: Array<{ questionId: string, score: number|null, text: string|null }> }>} every answer saved so far
 */
export async function saveDraft(prisma, studentId, requestId, { answers }, now = new Date()) {
  const request = await requireOwnRequest(prisma, studentId, requestId);
  assertOpen(request, now);
  return { answers: await storeDraft(prisma, { studentId, requestId: request.id, answers, now }) };
}

/**
 * Submits the feedback: the payload completes the saved draft, every required question must be answered, and the request is scored and marked answered.
 *
 * @param {object} prisma
 * @param {string} studentId - User.id
 * @param {string} requestId
 * @param {{ answers: Array<{ questionId: string, score?: number|null, text?: string|null }> }} body
 * @param {Date} [now]
 * @returns {Promise<{ nextFeedbackAt: Date|null }>}
 */
export async function submitFeedback(prisma, studentId, requestId, { answers }, now = new Date()) {
  const found = await requireOwnRequest(prisma, studentId, requestId);
  assertOpen(found, now);
  const request = await storeSubmission(prisma, { studentId, requestId: found.id, answers, now });
  return { nextFeedbackAt: await findNextFeedbackAt(prisma, request, now) };
}
