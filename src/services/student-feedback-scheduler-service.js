/**
 * Cron side of the student feedbacks: sends the due milestones, the single reminder, and expires the overdue requests.
 */

import { REMINDER_AFTER_HOURS, StudentFeedbackStatus } from '../constants/student-feedback.js';
import { dueMilestone } from '../helpers/student-feedback-schedule.js';
import {
  PERSON_NAME_SELECT,
  chosenTemplateId,
  createRequest,
  fullNameOf,
  openRequestWhere,
  resolveTemplate,
  sendEmailSafely,
  tryLockStudentFeedback,
} from './student-feedback-shared.js';

const HOUR_MS = 3600000;
const LINK_PAGE_SIZE = 200;
const GENERAL_TEMPLATE_CACHE_KEY = 'general';
const STUDENT_CONTACT_SELECT = Object.freeze({ email: true, firstName: true });
const TRAINER_NAME_SELECT = Object.freeze({ user: { select: PERSON_NAME_SELECT } });

// One page of the active links of the trainers with auto-send on, in id order after the given id, with what the milestone check and the e-mail need
function findAutoSendLinksPage(prisma, afterId) {
  return prisma.trainerStudent.findMany({
    where: {
      activeOnPlan: true,
      trainer: { studentFeedbackConfig: { autoSendEnabled: true } },
      student: { deletedAt: null },
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: LINK_PAGE_SIZE,
    select: {
      id: true,
      trainerId: true,
      studentId: true,
      createdAt: true,
      trainer: { select: { studentFeedbackConfig: true, ...TRAINER_NAME_SELECT } },
      student: { select: STUDENT_CONTACT_SELECT },
    },
  });
}

// Links paired with the milestone they must receive now
function withDueMilestone(links, now) {
  return links
    .map((link) => ({ link, due: dueMilestone({ linkedAt: link.createdAt, config: link.trainer.studentFeedbackConfig, now }) }))
    .filter(({ due }) => due !== null);
}

// Key of a trainer-student pair
function pairKey(trainerId, studentId) {
  return `${trainerId}:${studentId}`;
}

// Where clause of the requests that stop the due milestone of a link: the same occurrence already sent, or an open request of the pair
function blockingRequestWhere({ link, due }, now) {
  const { trainerId, studentId } = link;
  return { OR: [{ trainerId, studentId, dueAt: due.dueAt }, openRequestWhere(trainerId, studentId, now)] };
}

// Due links without the ones a stored request already blocks, found with one query for the whole page
async function withoutBlockedLinks(prisma, dueLinks, now) {
  if (dueLinks.length === 0) return dueLinks;
  const blocking = await prisma.studentFeedbackRequest.findMany({
    where: { OR: dueLinks.map((dueLink) => blockingRequestWhere(dueLink, now)) },
    select: { trainerId: true, studentId: true },
  });
  const blockedPairs = new Set(blocking.map((request) => pairKey(request.trainerId, request.studentId)));
  return dueLinks.filter(({ link }) => !blockedPairs.has(pairKey(link.trainerId, link.studentId)));
}

// Creates the request of a milestone once: skipped when it was already sent, or while the student has an open request of the trainer
function createDueRequest(prisma, { link, due, templateId, now }) {
  const { trainerId, studentId } = link;
  return prisma.$transaction(async (tx) => {
    if (!(await tryLockStudentFeedback(tx, trainerId, studentId))) return null;
    // why: dueAt identifies the milestone occurrence; the page pre-filter ran outside the lock, so it is checked again here, and the unique (trainer, student, dueAt) index is the last guard.
    const blocking = await tx.studentFeedbackRequest.findFirst({ where: blockingRequestWhere({ link, due }, now), select: { id: true } });
    if (blocking) return null;
    return createRequest(tx, { trainerId, studentId, templateId, milestone: due.milestone, dueAt: due.dueAt, now });
  });
}

// E-mail payload shared by the request and the reminder
function emailPayload(student, trainerUser, expiresAt) {
  return { to: student.email, studentName: student.firstName, trainerName: fullNameOf(trainerUser), expiresAt };
}

// Creates and announces the due request of one link; true when a request was created
async function sendDueFeedback(prisma, emailSender, logger, { link, due, templateId, now }) {
  const request = await createDueRequest(prisma, { link, due, templateId, now });
  if (!request) return false;
  if (link.student.email) {
    const payload = emailPayload(link.student, link.trainer.user, request.expiresAt);
    await sendEmailSafely((data) => emailSender.sendStudentFeedbackRequestEmail(data), payload, logger);
  }
  return true;
}

// Cache key of the template of a due link: the trainer's choice for the milestone, or the general template shared by everyone without one
function templateCacheKey({ link, due }) {
  const chosenId = chosenTemplateId(link.trainer.studentFeedbackConfig, due.milestone);
  return chosenId ? `${link.trainerId}:${chosenId}` : GENERAL_TEMPLATE_CACHE_KEY;
}

// Template of a due link, resolved once per run for each trainer choice; null when the general one is needed and missing
async function templateOf(prisma, run, { link, due }) {
  const key = templateCacheKey({ link, due });
  if (!run.templates.has(key)) {
    const input = { trainerId: link.trainerId, milestone: due.milestone, config: link.trainer.studentFeedbackConfig };
    run.templates.set(key, await resolveTemplate(prisma, input));
  }
  return run.templates.get(key);
}

// Logs the missing general template only once per run
function logMissingTemplateOnce(logger, run) {
  if (run.missingTemplateLogged) return;
  run.missingTemplateLogged = true;
  logger.error('[student-feedback] general template missing; the feedbacks that need it were not sent');
}

// Sends the due feedback of one link with its template; false when nothing was created
async function sendWithTemplate(prisma, emailSender, logger, { dueLink, run, now }) {
  const template = await templateOf(prisma, run, dueLink);
  if (!template) {
    logMissingTemplateOnce(logger, run);
    return false;
  }
  return sendDueFeedback(prisma, emailSender, logger, { ...dueLink, templateId: template.id, now });
}

// Sends the due feedbacks of one page of links, one failing student never stopping the others; returns how many were created
async function sendDuePage(prisma, emailSender, logger, { dueLinks, run, now }) {
  let created = 0;
  for (const dueLink of dueLinks) {
    const { link } = dueLink;
    try {
      if (await sendWithTemplate(prisma, emailSender, logger, { dueLink, run, now })) created += 1;
    } catch (err) {
      logger.error({ err, trainerId: link.trainerId, studentId: link.studentId }, '[student-feedback] sending a due feedback failed');
    }
  }
  return created;
}

/**
 * Creates one pending request (and sends its e-mail) for every active student whose latest milestone fell due, with the template chosen for the milestone or the general one, reading the links in pages; idempotent across ticks and instances, and one failing student never stops the others.
 *
 * @param {object} prisma
 * @param {{ sendStudentFeedbackRequestEmail: Function }} emailSender
 * @param {object} logger
 * @param {Date} [now]
 * @returns {Promise<{ created: number }>}
 */
export async function sendDueFeedbacks(prisma, emailSender, logger, now = new Date()) {
  let created = 0;
  const run = { templates: new Map(), missingTemplateLogged: false };
  let afterId = null;
  do {
    const links = await findAutoSendLinksPage(prisma, afterId);
    const dueLinks = await withoutBlockedLinks(prisma, withDueMilestone(links, now), now);
    created += await sendDuePage(prisma, emailSender, logger, { dueLinks, run, now });
    afterId = links.length === LINK_PAGE_SIZE ? links[links.length - 1].id : null;
  } while (afterId);
  return { created };
}

// Pending requests inside their window, sent long enough ago and not reminded yet
function findRemindable(prisma, now) {
  return prisma.studentFeedbackRequest.findMany({
    where: {
      status: StudentFeedbackStatus.PENDING,
      reminderSentAt: null,
      sentAt: { lte: new Date(now.getTime() - REMINDER_AFTER_HOURS * HOUR_MS) },
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      expiresAt: true,
      student: { select: { ...STUDENT_CONTACT_SELECT, deletedAt: true } },
      trainer: { select: TRAINER_NAME_SELECT },
    },
  });
}

// Marks the reminder as sent; false when another instance already took it
async function claimReminder(prisma, requestId, now) {
  const claimed = await prisma.studentFeedbackRequest.updateMany({
    where: { id: requestId, status: StudentFeedbackStatus.PENDING, reminderSentAt: null },
    data: { reminderSentAt: now },
  });
  return claimed.count === 1;
}

/**
 * Sends the single reminder of every pending request sent at least 24 hours ago; the reminder is claimed before the e-mail, so it is never repeated.
 *
 * @param {object} prisma
 * @param {{ sendStudentFeedbackReminderEmail: Function }} emailSender
 * @param {object} logger
 * @param {Date} [now]
 * @returns {Promise<{ reminded: number }>}
 */
export async function sendDueReminders(prisma, emailSender, logger, now = new Date()) {
  let reminded = 0;
  for (const request of await findRemindable(prisma, now)) {
    if (!(await claimReminder(prisma, request.id, now))) continue;
    reminded += 1;
    if (!request.student.email || request.student.deletedAt) continue;
    const payload = emailPayload(request.student, request.trainer.user, request.expiresAt);
    await sendEmailSafely((data) => emailSender.sendStudentFeedbackReminderEmail(data), payload, logger);
  }
  return { reminded };
}

/**
 * Marks every pending request past its window as expired.
 *
 * @param {object} prisma
 * @param {Date} [now]
 * @returns {Promise<{ expired: number }>}
 */
export async function expireOverdueFeedbacks(prisma, now = new Date()) {
  const expired = await prisma.studentFeedbackRequest.updateMany({
    where: { status: StudentFeedbackStatus.PENDING, expiresAt: { lte: now } },
    data: { status: StudentFeedbackStatus.EXPIRED },
  });
  return { expired: expired.count };
}
