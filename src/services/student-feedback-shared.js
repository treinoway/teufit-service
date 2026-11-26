/**
 * Pieces shared by the student feedback services: errors, request creation and the request e-mail.
 */

import { AppError } from '../errors/app-error.js';
import { PlanStatus } from '../constants/nutrition.js';
import {
  MILESTONE_TEMPLATE_SLOTS,
  RESPONSE_WINDOW_DAYS,
  StudentFeedbackErrorCode,
  StudentFeedbackMessageCode,
  StudentFeedbackQuestionCondition,
  StudentFeedbackStatus,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../constants/student-feedback.js';
import { expiresAtFor } from '../helpers/student-feedback-schedule.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const LOCK_NAMESPACE = 'student-feedback';

export const PERSON_NAME_SELECT = Object.freeze({ firstName: true, lastName: true, username: true });
const TEMPLATE_SUMMARY_SELECT = Object.freeze({ id: true, name: true });

// Error of the student feedback contract for the given key of StudentFeedbackErrorCode
function feedbackError(key, httpStatus, message, details = {}) {
  return new AppError({
    httpStatus,
    error: StudentFeedbackErrorCode[key],
    messageCode: StudentFeedbackMessageCode[key],
    message,
    details,
  });
}

// 404 for a request that does not exist or belongs to someone else
export function notFoundError() {
  return feedbackError('NOT_FOUND', HTTP_NOT_FOUND, 'Feedback not found');
}

// 409 for a request whose answer window closed
export function expiredError() {
  return feedbackError('EXPIRED', HTTP_CONFLICT, 'This feedback has expired');
}

// 409 for a request that was already answered
export function alreadySubmittedError() {
  return feedbackError('ALREADY_SUBMITTED', HTTP_CONFLICT, 'This feedback was already submitted');
}

// 409 for a send while the student still has an open request of the trainer
export function alreadyPendingError() {
  return feedbackError('ALREADY_PENDING', HTTP_CONFLICT, 'This student already has a pending feedback');
}

// 400 for a submit that leaves required questions without an answer
export function requiredAnswerMissingError(questionIds) {
  return feedbackError('REQUIRED_ANSWER_MISSING', HTTP_BAD_REQUEST, 'A required question has no answer', { questionIds });
}

// 400 for an answer to an unknown question or with a value outside the range of its type
export function invalidAnswerError(questionId) {
  return feedbackError('INVALID_ANSWER', HTTP_BAD_REQUEST, 'An answer is invalid', { questionId });
}

// Error of the template contract for the given key of StudentFeedbackTemplateErrorCode
function templateError(key, httpStatus, message) {
  return new AppError({
    httpStatus,
    error: StudentFeedbackTemplateErrorCode[key],
    messageCode: StudentFeedbackTemplateMessageCode[key],
    message,
    details: {},
  });
}

// 404 for a template that does not exist, was deleted or replaced, or belongs to another trainer
export function templateNotFoundError() {
  return templateError('NOT_FOUND', HTTP_NOT_FOUND, 'Feedback template not found');
}

// 403 for a write on the general template
export function templateReadOnlyError() {
  return templateError('READ_ONLY', HTTP_FORBIDDEN, 'The general feedback template is read-only');
}

// 400 for a template content that breaks a rule the route schema cannot express
export function templateInvalidError() {
  return templateError('INVALID', HTTP_BAD_REQUEST, 'The feedback template is invalid');
}

/**
 * Display name of a user: first and last name, else the username, else empty.
 *
 * @param {{ firstName?: string|null, lastName?: string|null, username?: string|null }|null|undefined} user
 * @returns {string}
 */
export function fullNameOf(user) {
  const name = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  return name || user?.username || '';
}

/**
 * Questions of the request's template the student must see, in order: conditional ones only when the request meets the condition.
 *
 * @param {{ hasMealPlan: boolean, template: { questions: object[] } }} request
 * @returns {object[]}
 */
export function visibleQuestions(request) {
  return request.template.questions
    .filter((question) => question.condition !== StudentFeedbackQuestionCondition.HAS_MEAL_PLAN || request.hasMealPlan)
    .sort((left, right) => left.order - right.order);
}

/**
 * Where clause of the requests of a trainer-student pair that still accept answers.
 *
 * @param {string} trainerId
 * @param {string} studentId
 * @param {Date} now
 * @returns {object}
 */
export function openRequestWhere(trainerId, studentId, now) {
  return { trainerId, studentId, status: StudentFeedbackStatus.PENDING, expiresAt: { gt: now } };
}

/**
 * Takes the transaction-scoped advisory lock of the trainer-student pair without waiting, so two sends never race.
 *
 * @param {object} tx - Prisma transaction client
 * @param {string} trainerId
 * @param {string} studentId
 * @returns {Promise<boolean>} false when another transaction holds it
 */
export async function tryLockStudentFeedback(tx, trainerId, studentId) {
  const key = `${LOCK_NAMESPACE}:${trainerId}:${studentId}`;
  const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
  return locked;
}

/**
 * Latest version of the general template ("Padrão TeuFit"), or null when the database has none.
 *
 * @param {object} prisma
 * @returns {Promise<{ id: string, name: string }|null>}
 */
export function findGeneralTemplate(prisma) {
  return prisma.studentFeedbackTemplate.findFirst({
    where: { isGeneral: true, deletedAt: null },
    orderBy: { version: 'desc' },
    select: TEMPLATE_SUMMARY_SELECT,
  });
}

/**
 * Where clause of the non-deleted templates a trainer can use: the general one and their own.
 *
 * @param {string} trainerId
 * @returns {object}
 */
export function usableTemplateWhere(trainerId) {
  return { deletedAt: null, OR: [{ isGeneral: true }, { trainerId }] };
}

/**
 * Id of the template the config stores for a milestone; null when none was chosen or the milestone has no choice (ad-hoc).
 *
 * @param {object|null|undefined} config - stored StudentFeedbackConfig row
 * @param {string} milestone
 * @returns {string|null}
 */
export function chosenTemplateId(config, milestone) {
  const slot = MILESTONE_TEMPLATE_SLOTS.find((candidate) => candidate.milestone === milestone);
  return slot ? (config?.[slot.column] ?? null) : null;
}

/**
 * Days a student has to answer a request of the trainer; the default for a trainer that never saved or a row without the value.
 *
 * @param {object|null|undefined} config - stored StudentFeedbackConfig row
 * @returns {number}
 */
export function responseWindowDaysOf(config) {
  return config?.responseWindowDays ?? RESPONSE_WINDOW_DAYS;
}

// The non-deleted template of the trainer chosen for the milestone, or null when there is no usable choice
async function findChosenTemplate(prisma, { trainerId, milestone, config }) {
  const chosenId = chosenTemplateId(config, milestone);
  if (!chosenId) return null;
  return prisma.studentFeedbackTemplate.findFirst({
    where: { id: chosenId, trainerId, isGeneral: false, deletedAt: null },
    select: TEMPLATE_SUMMARY_SELECT,
  });
}

/**
 * Template of a send: the explicit one (404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND unless general or the trainer's), else the one chosen for the milestone, else the general one.
 *
 * @param {object} prisma
 * @param {{ trainerId: string, milestone: string, config?: object|null, templateId?: string|null }} input
 * @returns {Promise<{ id: string, name: string }|null>} null only when the general template is needed and missing
 */
export async function resolveTemplate(prisma, { trainerId, milestone, config, templateId }) {
  if (templateId) {
    const picked = await prisma.studentFeedbackTemplate.findFirst({
      where: { id: templateId, ...usableTemplateWhere(trainerId) },
      select: TEMPLATE_SUMMARY_SELECT,
    });
    if (!picked) throw templateNotFoundError();
    return picked;
  }
  return (await findChosenTemplate(prisma, { trainerId, milestone, config })) ?? findGeneralTemplate(prisma);
}

// Whether the student has a published diet protocol under a nutritionist whose link is active
async function studentHasMealPlan(prisma, studentId) {
  const plan = await prisma.dietProtocol.findFirst({
    where: {
      assigneeId: studentId,
      status: PlanStatus.PUBLISHED,
      nutritionist: { patients: { some: { patientId: studentId, deletedAt: null } } },
    },
    select: { id: true },
  });
  return plan !== null;
}

/**
 * Creates a pending request sent now that expires after the response window, recording whether the student has a meal plan at this moment.
 *
 * @param {object} tx - Prisma client or transaction
 * @param {{ trainerId: string, studentId: string, templateId: string, milestone: string, dueAt: Date|null, now: Date, responseWindowDays?: number }} input - responseWindowDays: window of the trainer; the default when omitted
 * @returns {Promise<object>} the stored request
 */
export async function createRequest(tx, { trainerId, studentId, templateId, milestone, dueAt, now, responseWindowDays }) {
  const hasMealPlan = await studentHasMealPlan(tx, studentId);
  return tx.studentFeedbackRequest.create({
    data: {
      trainerId,
      studentId,
      templateId,
      milestone,
      status: StudentFeedbackStatus.PENDING,
      hasMealPlan,
      dueAt,
      sentAt: now,
      expiresAt: expiresAtFor(now, responseWindowDays),
    },
  });
}

/**
 * Sends one feedback e-mail and never throws: a failure (thrown, or returned by the provider) is only logged.
 *
 * @param {(payload: object) => Promise<object|undefined>} send
 * @param {object} payload
 * @param {object|null|undefined} logger
 * @returns {Promise<void>}
 */
export async function sendEmailSafely(send, payload, logger) {
  try {
    const response = await send(payload);
    // why: the Resend SDK returns { data, error } instead of throwing; only the error name is logged because its message may echo the recipient.
    if (response?.error) logger?.warn?.({ providerError: response.error.name ?? 'unknown_error' }, '[student-feedback] e-mail rejected by the provider');
  } catch (err) {
    logger?.warn?.({ err }, '[student-feedback] e-mail failed');
  }
}
