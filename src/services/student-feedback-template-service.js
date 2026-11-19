/**
 * Trainer-owned student feedback templates: list, read, create, duplicate, save (in place or as a new version) and delete.
 */

import {
  MILESTONE_TEMPLATE_SLOTS,
  STUDENT_FEEDBACK_TEMPLATE_COPY_SUFFIX,
  STUDENT_FEEDBACK_TEMPLATE_LIMITS,
  STUDENT_FEEDBACK_TEXT_NAMESPACE,
  STUDENT_FEEDBACK_STARTER_QUESTION_TEXT_KEY,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
} from '../constants/student-feedback.js';
import { DEFAULT_LOCALE } from '../i18n/constants.js';
import { translate } from '../i18n/i18n-service.js';
import { lockStudentFeedbackTemplateForUpdate } from '../helpers/row-locks.js';
import { templateInvalidError, templateNotFoundError, templateReadOnlyError, usableTemplateWhere } from './student-feedback-shared.js';

const FIRST_VERSION = 1;
const QUESTIONS_IN_ORDER = Object.freeze({ orderBy: { order: 'asc' } });
const TEMPLATE_LIST_ORDER = Object.freeze([{ isGeneral: 'desc' }, { name: 'asc' }]);

// Stored feedback config of the trainer, or null when never saved
function findConfig(prisma, trainerId) {
  return prisma.studentFeedbackConfig.findUnique({ where: { trainerId } });
}

// Milestones that use the template for this trainer: the ones pointing at it, or, for the general template, the ones without a choice
function milestonesOf(template, config) {
  return MILESTONE_TEMPLATE_SLOTS.filter(({ column }) => {
    const chosenId = config?.[column] ?? null;
    return template.isGeneral ? chosenId === null : chosenId === template.id;
  }).map(({ milestone }) => milestone);
}

// Contract shape of a template in the list
function toListItem(template, config) {
  return {
    id: template.id,
    name: template.name,
    isGeneral: template.isGeneral,
    version: template.version,
    questionCount: template._count.questions,
    milestones: milestonesOf(template, config),
    updatedAt: template.updatedAt ?? null,
  };
}

// Contract shape of a question of a template
function toQuestion(question) {
  return {
    id: question.id,
    order: question.order,
    text: question.text,
    helpText: question.helpText ?? null,
    type: question.type,
    pillar: question.pillar,
    required: question.required,
    condition: question.condition ?? null,
    invertScore: question.invertScore ?? false,
    minLabel: question.minLabel ?? null,
    maxLabel: question.maxLabel ?? null,
  };
}

// Contract shape of a template with its questions
function toTemplate(template, config) {
  return {
    id: template.id,
    name: template.name,
    isGeneral: template.isGeneral,
    version: template.version,
    hasRequests: template._count.requests > 0,
    milestones: milestonesOf(template, config),
    questions: template.questions.map(toQuestion),
  };
}

// The general template or a non-deleted template of the trainer, with questions and request count; 404 otherwise
async function findUsableTemplate(prisma, trainerId, templateId) {
  const template = await prisma.studentFeedbackTemplate.findFirst({
    where: { id: templateId, ...usableTemplateWhere(trainerId) },
    include: { questions: QUESTIONS_IN_ORDER, _count: { select: { requests: true } } },
  });
  if (!template) throw templateNotFoundError();
  return template;
}

// A non-deleted template of the trainer; 404 when not usable by the trainer, 403 for the general template
async function findEditableTemplate(prisma, trainerId, templateId) {
  const template = await findUsableTemplate(prisma, trainerId, templateId);
  if (template.isGeneral) throw templateReadOnlyError();
  return template;
}

// Trimmed text, or null when missing or blank
function trimmedOrNull(text) {
  return text?.trim() || null;
}

// Stored fields of a question of a save payload at the given position; end labels are kept only on score questions
function toQuestionData(question, index) {
  const isScore = question.type === StudentFeedbackQuestionType.SCORE;
  return {
    order: index + 1,
    text: question.text?.trim() ?? '',
    helpText: trimmedOrNull(question.helpText),
    type: question.type,
    pillar: question.pillar,
    required: question.required ?? false,
    condition: question.condition ?? null,
    invertScore: question.invertScore ?? false,
    minLabel: isScore ? trimmedOrNull(question.minLabel) : null,
    maxLabel: isScore ? trimmedOrNull(question.maxLabel) : null,
  };
}

// Whether a question has text and does not invert a score it does not have
function isValidQuestion(question) {
  return question.text.length > 0 && !(question.type === StudentFeedbackQuestionType.OPEN && question.invertScore);
}

// Whether a question is shown to every student, whatever their plans
function isUnconditional(question) {
  return question.condition === null;
}

// Name and questions to store for a save payload; 400 when a rule the route schema cannot express is broken
function toTemplateData(payload) {
  const name = payload?.name?.trim() ?? '';
  const questions = (payload?.questions ?? []).map(toQuestionData);
  const countAllowed = questions.length > 0 && questions.length <= STUDENT_FEEDBACK_TEMPLATE_LIMITS.maxQuestions;
  if (!name || !countAllowed || !questions.every(isValidQuestion)) throw templateInvalidError();
  // why: a student without a meal plan would otherwise receive a request with no visible question.
  if (!questions.some(isUnconditional)) throw templateInvalidError();
  return { name, questions };
}

// Stored fields of a question copied as it is into another template
function toQuestionCopy(question) {
  const { order, text, helpText, type, pillar, required, condition, invertScore, minLabel, maxLabel } = question;
  return { order, text, helpText, type, pillar, required, condition, invertScore, minLabel, maxLabel };
}

// Name of a copy: the original name cut so that the copy suffix fits the name limit
function copyNameOf(name) {
  const room = STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength - STUDENT_FEEDBACK_TEMPLATE_COPY_SUFFIX.length;
  return `${name.slice(0, room).trimEnd()}${STUDENT_FEEDBACK_TEMPLATE_COPY_SUFFIX}`;
}

// Trimmed name of a new template; 400 when blank or over the name limit
function toTemplateName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > STUDENT_FEEDBACK_TEMPLATE_LIMITS.nameMaxLength) throw templateInvalidError();
  return trimmed;
}

// The single question a template created from scratch starts with, in the language of the trainer
function starterQuestions(language) {
  return [
    {
      order: 1,
      text: translate(STUDENT_FEEDBACK_TEXT_NAMESPACE, STUDENT_FEEDBACK_STARTER_QUESTION_TEXT_KEY, language),
      type: StudentFeedbackQuestionType.SCORE,
      pillar: StudentFeedbackPillar.OTHER,
      required: true,
      condition: null,
      invertScore: false,
    },
  ];
}

// Stores a new own template of the trainer (version 1, no parent, no milestone) and returns it in the shape of getTemplate
async function createOwnTemplate(prisma, trainerId, name, questions) {
  const created = await prisma.studentFeedbackTemplate.create({
    data: { trainerId, isGeneral: false, name, version: FIRST_VERSION, questions: { create: questions } },
    select: { id: true },
  });
  return getTemplate(prisma, trainerId, created.id);
}

// Points every milestone of the trainer that uses one template at another one (null = back to the general template)
async function repointMilestones(tx, trainerId, fromTemplateId, toTemplateId) {
  for (const { column } of MILESTONE_TEMPLATE_SLOTS) {
    await tx.studentFeedbackConfig.updateMany({ where: { trainerId, [column]: fromTemplateId }, data: { [column]: toTemplateId } });
  }
}

// Rewrites name and questions of a template no request was sent with; returns its id
async function replaceContent(tx, templateId, { name, questions }) {
  await tx.studentFeedbackQuestion.deleteMany({ where: { templateId } });
  await tx.studentFeedbackQuestion.createMany({ data: questions.map((question) => ({ ...question, templateId })) });
  await tx.studentFeedbackTemplate.update({ where: { id: templateId }, data: { name } });
  return templateId;
}

// Stores the content as the next version, retires the current row and moves the trainer's milestones to the new one; returns the new id
async function createNextVersion(tx, current, { name, questions }, now) {
  const next = await tx.studentFeedbackTemplate.create({
    data: {
      trainerId: current.trainerId,
      isGeneral: false,
      name,
      version: current.version + 1,
      parentId: current.id,
      questions: { create: questions },
    },
    select: { id: true },
  });
  await tx.studentFeedbackTemplate.update({ where: { id: current.id }, data: { deletedAt: now } });
  await repointMilestones(tx, current.trainerId, current.id, next.id);
  return next.id;
}

/**
 * Templates the trainer can use: the general one first, then their own latest versions by name.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @returns {Promise<Array<{ id: string, name: string, isGeneral: boolean, version: number, questionCount: number, milestones: string[], updatedAt: Date|null }>>}
 */
export async function listTemplates(prisma, trainerId) {
  const [templates, config] = await Promise.all([
    prisma.studentFeedbackTemplate.findMany({
      where: usableTemplateWhere(trainerId),
      orderBy: TEMPLATE_LIST_ORDER,
      include: { _count: { select: { questions: true } } },
    }),
    findConfig(prisma, trainerId),
  ]);
  return templates.map((template) => toListItem(template, config));
}

/**
 * One template the trainer can use (general or own), with its questions in order; 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND otherwise.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} templateId
 * @returns {Promise<{ id: string, name: string, isGeneral: boolean, version: number, hasRequests: boolean, milestones: string[], questions: object[] }>}
 */
export async function getTemplate(prisma, trainerId, templateId) {
  const [template, config] = await Promise.all([findUsableTemplate(prisma, trainerId, templateId), findConfig(prisma, trainerId)]);
  return toTemplate(template, config);
}

/**
 * Copies the general template or an own one into a new own template (version 1, no parent, no milestone).
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} templateId - template to copy
 * @returns {Promise<object>} the copy, in the shape of getTemplate
 */
export async function duplicateTemplate(prisma, trainerId, templateId) {
  const source = await findUsableTemplate(prisma, trainerId, templateId);
  return createOwnTemplate(prisma, trainerId, copyNameOf(source.name), source.questions.map(toQuestionCopy));
}

/**
 * Creates an own template with the given name: with the questions of a usable source template, or with one starter question.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {{ name: string, sourceTemplateId?: string|null }} input - 400 STUDENT_FEEDBACK_TEMPLATE_INVALID for a blank or too long name, 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a source the trainer cannot use
 * @param {string} [language] - locale of the starter question text
 * @returns {Promise<object>} the new template (version 1, no parent, no milestone), in the shape of getTemplate
 */
export async function createTemplate(prisma, trainerId, { name, sourceTemplateId } = {}, language = DEFAULT_LOCALE) {
  const templateName = toTemplateName(name);
  if (!sourceTemplateId) return createOwnTemplate(prisma, trainerId, templateName, starterQuestions(language));
  const source = await findUsableTemplate(prisma, trainerId, sourceTemplateId);
  return createOwnTemplate(prisma, trainerId, templateName, source.questions.map(toQuestionCopy));
}

/**
 * Saves name and questions of an own template: in place while no request was sent with it, otherwise as a new version that replaces it.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} templateId - 404 when not usable by the trainer, 403 for the general template
 * @param {{ name: string, questions: object[] }} payload - 400 STUDENT_FEEDBACK_TEMPLATE_INVALID when a rule is broken
 * @param {Date} [now]
 * @returns {Promise<object>} the saved template in the shape of getTemplate; its id differs when a new version was created
 */
export async function saveTemplate(prisma, trainerId, templateId, payload, now = new Date()) {
  await findEditableTemplate(prisma, trainerId, templateId);
  const content = toTemplateData(payload);
  const savedId = await prisma.$transaction(async (tx) => {
    await lockStudentFeedbackTemplateForUpdate(tx, templateId);
    // why: the first read ran outside the lock; a concurrent save may have retired this row or a send may have used it since.
    const current = await findEditableTemplate(tx, trainerId, templateId);
    if (current._count.requests === 0) return replaceContent(tx, templateId, content);
    return createNextVersion(tx, current, content, now);
  });
  return getTemplate(prisma, trainerId, savedId);
}

/**
 * Soft-deletes an own template and sends the milestones that used it back to the general template; requests already sent keep it.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} templateId - 404 when not usable by the trainer, 403 for the general template
 * @param {Date} [now]
 * @returns {Promise<void>}
 */
export async function deleteTemplate(prisma, trainerId, templateId, now = new Date()) {
  await findEditableTemplate(prisma, trainerId, templateId);
  await prisma.$transaction(async (tx) => {
    await lockStudentFeedbackTemplateForUpdate(tx, templateId);
    const retired = await tx.studentFeedbackTemplate.updateMany({ where: { id: templateId, trainerId, deletedAt: null }, data: { deletedAt: now } });
    if (retired.count === 0) throw templateNotFoundError();
    await repointMilestones(tx, trainerId, templateId, null);
  });
}
