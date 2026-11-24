/**
 * Trainer side of the student feedbacks: inbox, unread count, per-student history and the ad-hoc send.
 */

import {
  AVERAGE_INDEX_SAMPLE_SIZE,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  RESPONSE_RATE_WINDOW_DAYS,
  StudentFeedbackInboxFilter,
  StudentFeedbackMilestone,
  StudentFeedbackQuestionType,
  StudentFeedbackStatus,
  studentFeedbackPillarValues,
} from '../constants/student-feedback.js';
import { assertStudentOfTrainer } from './consistency-student-access.js';
import { assertStudentActiveOnPlan } from './platform-plan-service.js';
import {
  PERSON_NAME_SELECT,
  alreadyPendingError,
  createRequest,
  fullNameOf,
  notFoundError,
  openRequestWhere,
  resolveTemplate,
  sendEmailSafely,
  templateNotFoundError,
  tryLockStudentFeedback,
  usableTemplateWhere,
} from './student-feedback-shared.js';
import { AppError } from '../errors/app-error.js';

const DAY_MS = 86400000;
const PERCENT = 100;
const STUDENT_SELECT = Object.freeze({ id: true, ...PERSON_NAME_SELECT, avatarUrl: true });

// Where clause of the answered requests of the trainer that were not read yet
function unreadWhere(trainerId) {
  return { trainerId, status: StudentFeedbackStatus.ANSWERED, readAt: null };
}

// Where clause of the inbox status filter: unread = answered and not read, unanswered = expired
function statusFilterWhere(trainerId, status) {
  if (status === StudentFeedbackInboxFilter.UNREAD) return unreadWhere(trainerId);
  if (status === StudentFeedbackInboxFilter.UNANSWERED) return { trainerId, status: StudentFeedbackStatus.EXPIRED };
  return { trainerId };
}

// Student as shown to the trainer
function toStudent(user) {
  return { id: user.id, name: fullNameOf(user), avatarUrl: user.avatarUrl ?? null };
}

// Fields every listing of a request shares
function toRequestSummary(request) {
  return {
    id: request.id,
    milestone: request.milestone,
    status: request.status,
    sentAt: request.sentAt,
    expiresAt: request.expiresAt,
    submittedAt: request.submittedAt ?? null,
    readAt: request.readAt ?? null,
    overallIndex: request.overallIndex ?? null,
    band: request.band ?? null,
  };
}

// Rounded mean of a list of numbers, or null when it is empty
function roundedMeanOrNull(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// Overall indexes of the trainer's most recently sent answered feedbacks, capped so the average never loads the whole history
async function findRecentAnsweredIndexes(prisma, trainerId) {
  const answered = await prisma.studentFeedbackRequest.findMany({
    where: { trainerId, status: StudentFeedbackStatus.ANSWERED, overallIndex: { not: null } },
    orderBy: { sentAt: 'desc' },
    take: AVERAGE_INDEX_SAMPLE_SIZE,
    select: { overallIndex: true },
  });
  return answered.map((request) => request.overallIndex);
}

// Number of inbox items to return: the default when none was asked, never above the maximum
function inboxLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) return INBOX_DEFAULT_LIMIT;
  return Math.min(limit, INBOX_MAX_LIMIT);
}

// Summary tiles of the whole inbox of the trainer, whatever the filters
async function inboxSummary(prisma, trainerId, now) {
  const sentInWindow = { trainerId, sentAt: { gte: new Date(now.getTime() - RESPONSE_RATE_WINDOW_DAYS * DAY_MS) } };
  const requests = prisma.studentFeedbackRequest;
  const [sentCount, answeredCount, unansweredCount, unreadCount, answered] = await Promise.all([
    requests.count({ where: sentInWindow }),
    requests.count({ where: { ...sentInWindow, status: StudentFeedbackStatus.ANSWERED } }),
    requests.count({ where: { trainerId, status: StudentFeedbackStatus.EXPIRED } }),
    requests.count({ where: unreadWhere(trainerId) }),
    findRecentAnsweredIndexes(prisma, trainerId),
  ]);
  return {
    responseRate30d: sentCount === 0 ? null : Math.round((answeredCount / sentCount) * PERCENT),
    averageIndex: roundedMeanOrNull(answered),
    unansweredCount,
    unreadCount,
  };
}

// Pillar scores stored on an answered request as a list, in the canonical pillar order
function toPillars(request) {
  const scores = request.status === StudentFeedbackStatus.ANSWERED ? (request.pillarScores ?? {}) : {};
  return studentFeedbackPillarValues.filter((pillar) => scores[pillar] !== undefined).map((pillar) => ({ pillar, score: scores[pillar] }));
}

// Text answers of an answered request with their question, in question order
function toOpenAnswers(request) {
  if (request.status !== StudentFeedbackStatus.ANSWERED) return [];
  return request.answers
    .filter((answer) => answer.question.type === StudentFeedbackQuestionType.OPEN && answer.text)
    .sort((left, right) => left.question.order - right.question.order)
    .map((answer) => ({ questionId: answer.questionId, question: answer.question.text, pillar: answer.question.pillar, text: answer.text }));
}

// 404 when the template was deleted or replaced since it was resolved
async function assertTemplateStillUsable(tx, trainerId, templateId) {
  const live = await tx.studentFeedbackTemplate.findFirst({ where: { id: templateId, ...usableTemplateWhere(trainerId) }, select: { id: true } });
  if (!live) throw templateNotFoundError();
}

// Creates the ad-hoc request unless the student still has an open one of this trainer or the template was retired meanwhile
function createAdhocRequest(prisma, { trainerId, studentId, templateId, now }) {
  return prisma.$transaction(async (tx) => {
    if (!(await tryLockStudentFeedback(tx, trainerId, studentId))) throw alreadyPendingError();
    const open = await tx.studentFeedbackRequest.findFirst({ where: openRequestWhere(trainerId, studentId, now), select: { id: true } });
    if (open) throw alreadyPendingError();
    const request = await createRequest(tx, { trainerId, studentId, templateId, milestone: StudentFeedbackMilestone.ADHOC, dueAt: null, now });
    // why: the insert holds the foreign key's key-share lock on the template, so only after it can no save or delete retire the template unseen; a failure rolls the insert back.
    await assertTemplateStillUsable(tx, trainerId, templateId);
    return request;
  });
}

// Sends the request e-mail of an ad-hoc feedback; a student without e-mail or a failing provider never fails the send
async function announceRequest(prisma, emailSender, request, logger) {
  const [student, trainer] = await Promise.all([
    prisma.user.findUnique({ where: { id: request.studentId }, select: { email: true, firstName: true, deletedAt: true } }),
    prisma.trainer.findUnique({ where: { id: request.trainerId }, select: { user: { select: PERSON_NAME_SELECT } } }),
  ]);
  if (!student?.email || student.deletedAt) return;
  const payload = { to: student.email, studentName: student.firstName, trainerName: fullNameOf(trainer?.user), expiresAt: request.expiresAt };
  await sendEmailSafely((data) => emailSender.sendStudentFeedbackRequestEmail(data), payload, logger);
}

/**
 * Inbox of the trainer: the most recently sent requests first, filtered by status and milestone and capped by the limit, plus the summary of the whole inbox.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {{ status?: string, milestone?: string, limit?: number }} filters - limit defaults to INBOX_DEFAULT_LIMIT and never exceeds INBOX_MAX_LIMIT
 * @param {Date} [now]
 * @returns {Promise<{ summary: object, items: object[] }>}
 */
export async function listInbox(prisma, trainerId, { status, milestone, limit } = {}, now = new Date()) {
  const where = { ...statusFilterWhere(trainerId, status), ...(milestone ? { milestone } : {}) };
  const [requests, summary] = await Promise.all([
    prisma.studentFeedbackRequest.findMany({ where, orderBy: { sentAt: 'desc' }, take: inboxLimit(limit), include: { student: { select: STUDENT_SELECT } } }),
    inboxSummary(prisma, trainerId, now),
  ]);
  const items = requests.map((request) => {
    const { id, ...rest } = toRequestSummary(request);
    return { id, student: toStudent(request.student), ...rest };
  });
  return { summary, items };
}

/**
 * Number of answered requests the trainer has not read, for the sidebar badge.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @returns {Promise<{ count: number }>}
 */
export async function countUnread(prisma, trainerId) {
  return { count: await prisma.studentFeedbackRequest.count({ where: unreadWhere(trainerId) }) };
}

/**
 * Marks an answered request as read, keeping the first read date; a request not answered yet stays unread.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} requestId
 * @param {Date} [now]
 * @returns {Promise<{ id: string, readAt: Date|null }>}
 */
export async function markAsRead(prisma, trainerId, requestId, now = new Date()) {
  // why: the readAt: null guard makes concurrent calls keep the first read date.
  await prisma.studentFeedbackRequest.updateMany({
    where: { id: requestId, trainerId, status: StudentFeedbackStatus.ANSWERED, readAt: null },
    data: { readAt: now },
  });
  const request = await prisma.studentFeedbackRequest.findFirst({ where: { id: requestId, trainerId }, select: { id: true, readAt: true } });
  if (!request) throw notFoundError();
  return { id: request.id, readAt: request.readAt ?? null };
}

/**
 * Feedbacks this trainer sent to one of their students, oldest first, with pillar scores and open answers of the answered ones.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} studentId - User.id; 404 when the student is not linked to the trainer
 * @param {Date} [now]
 * @returns {Promise<{ student: object, hasPending: boolean, feedbacks: object[] }>}
 */
export async function getStudentHistory(prisma, trainerId, studentId, now = new Date()) {
  await assertStudentOfTrainer(prisma, trainerId, studentId);
  const [student, requests] = await Promise.all([
    prisma.user.findUnique({ where: { id: studentId }, select: STUDENT_SELECT }),
    prisma.studentFeedbackRequest.findMany({
      where: { trainerId, studentId },
      orderBy: { sentAt: 'asc' },
      include: { answers: { include: { question: true } } },
    }),
  ]);
  return {
    student: toStudent(student),
    hasPending: requests.some((request) => request.status === StudentFeedbackStatus.PENDING && request.expiresAt > now),
    feedbacks: requests.map((request) => ({ ...toRequestSummary(request), pillars: toPillars(request), openAnswers: toOpenAnswers(request) })),
  };
}

/**
 * Sends an ad-hoc feedback to a student of the trainer, whatever the auto-send setting; refused while the student has an open request of this trainer.
 *
 * @param {object} prisma
 * @param {{ sendStudentFeedbackRequestEmail: Function }} emailSender
 * @param {string} trainerId - Trainer.id
 * @param {string} studentId - User.id; 404 when not linked to the trainer, 403 when blocked on the trainer's plan
 * @param {Date} [now]
 * @param {object|null} [logger] - receives the e-mail failures
 * @param {{ templateId?: string }} [options] - template to send; the general one when omitted, 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND unless general or the trainer's
 * @returns {Promise<{ id: string, milestone: string, status: string, sentAt: Date, expiresAt: Date }>}
 */
export async function sendAdhocFeedback(prisma, emailSender, trainerId, studentId, now = new Date(), logger = null, options = {}) {
  await assertStudentOfTrainer(prisma, trainerId, studentId);
  await assertStudentActiveOnPlan(prisma, trainerId, studentId);
  const template = await resolveTemplate(prisma, { trainerId, milestone: StudentFeedbackMilestone.ADHOC, templateId: options?.templateId });
  if (!template) throw new AppError({ message: 'Student feedback general template is missing' });
  const request = await createAdhocRequest(prisma, { trainerId, studentId, templateId: template.id, now });
  await announceRequest(prisma, emailSender, request, logger);
  return { id: request.id, milestone: request.milestone, status: request.status, sentAt: request.sentAt, expiresAt: request.expiresAt };
}
