/**
 * Per-trainer settings of the automatic student feedbacks: the switches and the template of each milestone.
 */

import { DEFAULT_STUDENT_FEEDBACK_CONFIG, MILESTONE_TEMPLATE_SLOTS, RESPONSE_WINDOW_FIELD, STUDENT_FEEDBACK_CONFIG_FIELDS } from '../constants/student-feedback.js';
import { lockStudentFeedbackTemplateForUpdate } from '../helpers/row-locks.js';
import { responseWindowDaysOf, templateNotFoundError, usableTemplateWhere } from './student-feedback-shared.js';

const UNIQUE_VIOLATION_CODE = 'P2002';

// Contract fields of a stored row, or the defaults when the trainer never saved; a row without a response window reads as the default one
function toConfig(row) {
  const source = row ?? DEFAULT_STUDENT_FEEDBACK_CONFIG;
  const fields = Object.fromEntries(STUDENT_FEEDBACK_CONFIG_FIELDS.map((field) => [field, source[field]]));
  return { ...fields, [RESPONSE_WINDOW_FIELD]: responseWindowDaysOf(row) };
}

// Config fields present in the request body
function pickChanges(changes) {
  return Object.fromEntries(STUDENT_FEEDBACK_CONFIG_FIELDS.filter((field) => changes?.[field] !== undefined).map((field) => [field, changes[field]]));
}

// enabledAt after the save: stamped on each off -> on switch, so milestones due before it are never sent
function enabledAtAfter(stored, next, now) {
  const turnedOn = next.autoSendEnabled && !stored?.autoSendEnabled;
  return turnedOn ? now : (stored?.enabledAt ?? null);
}

/**
 * Feedback settings of the trainer; the defaults (auto-send off, every milestone on, default response window) when nothing was saved.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @returns {Promise<{ autoSendEnabled: boolean, d7: boolean, d15: boolean, d21: boolean, d30: boolean, recurring: boolean, responseWindowDays: number }>}
 */
export async function getConfig(prisma, trainerId) {
  const stored = await prisma.studentFeedbackConfig.findUnique({ where: { trainerId } });
  return toConfig(stored);
}

// Writes the fields sent over the stored settings (or the defaults) and returns the stored row
async function saveConfig(prisma, trainerId, changes, now) {
  const stored = await prisma.studentFeedbackConfig.findUnique({ where: { trainerId } });
  const next = { ...toConfig(stored), ...pickChanges(changes) };
  const data = { ...next, enabledAt: enabledAtAfter(stored, next, now) };
  return prisma.studentFeedbackConfig.upsert({
    where: { trainerId },
    update: data,
    create: { trainerId, ...data },
  });
}

/**
 * Saves the fields sent over the stored settings (or the defaults) and returns the full config.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {object} changes - any subset of the config booleans and responseWindowDays (used by the sends made from now on)
 * @param {Date} [now]
 * @returns {Promise<object>} full config
 */
export async function updateConfig(prisma, trainerId, changes, now = new Date()) {
  try {
    return toConfig(await saveConfig(prisma, trainerId, changes, now));
  } catch (err) {
    if (err?.code !== UNIQUE_VIOLATION_CODE) throw err;
    // why: two first saves of one trainer can both try to insert; the loser saves again over the row the winner created.
    return toConfig(await saveConfig(prisma, trainerId, changes, now));
  }
}

// Template id of each milestone of a stored row; null (the general template) for a missing row or column
function toMilestoneTemplates(row) {
  return Object.fromEntries(MILESTONE_TEMPLATE_SLOTS.map(({ field, column }) => [field, row?.[column] ?? null]));
}

// Config columns of the milestones present in the body, with the template id sent (null clears the choice)
function pickTemplateColumns(changes) {
  return Object.fromEntries(MILESTONE_TEMPLATE_SLOTS.filter(({ field }) => changes?.[field] !== undefined).map(({ field, column }) => [column, changes[field]]));
}

// Distinct template ids of a set of config columns, sorted so that concurrent writers lock them in the same order
function templateIdsOf(columns) {
  return [...new Set(Object.values(columns).filter((templateId) => templateId !== null))].sort();
}

// The columns with the general template stored as null (it is the default); 404 when an id is not a template the trainer can use
async function withGeneralAsDefault(prisma, trainerId, columns) {
  const templateIds = templateIdsOf(columns);
  if (templateIds.length === 0) return columns;
  const usable = await prisma.studentFeedbackTemplate.findMany({
    where: { id: { in: templateIds }, ...usableTemplateWhere(trainerId) },
    select: { id: true, isGeneral: true },
  });
  if (usable.length !== templateIds.length) throw templateNotFoundError();
  const generalIds = new Set(usable.filter((template) => template.isGeneral).map((template) => template.id));
  return Object.fromEntries(Object.entries(columns).map(([column, templateId]) => [column, generalIds.has(templateId) ? null : templateId]));
}

// Locks the chosen templates and fails with 404 when one of them was deleted or replaced meanwhile
async function lockChosenTemplates(tx, trainerId, templateIds) {
  for (const templateId of templateIds) await lockStudentFeedbackTemplateForUpdate(tx, templateId);
  if (templateIds.length === 0) return;
  const live = await tx.studentFeedbackTemplate.count({ where: { id: { in: templateIds }, trainerId, deletedAt: null } });
  if (live !== templateIds.length) throw templateNotFoundError();
}

// Writes the template columns over the stored row, creating it with the default switches when the trainer never saved
function saveTemplateColumns(prisma, trainerId, columns) {
  return prisma.$transaction(async (tx) => {
    // why: a template delete or new version takes the same row lock before it repoints the configs, so a choice can never be left on a retired template.
    await lockChosenTemplates(tx, trainerId, templateIdsOf(columns));
    return tx.studentFeedbackConfig.upsert({
      where: { trainerId },
      update: columns,
      create: { trainerId, ...DEFAULT_STUDENT_FEEDBACK_CONFIG, ...columns },
    });
  });
}

/**
 * Template chosen for each milestone of the trainer; null means the general template.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @returns {Promise<{ d7: string|null, d15: string|null, d21: string|null, d30: string|null, recurring: string|null }>}
 */
export async function getMilestoneTemplates(prisma, trainerId) {
  const stored = await prisma.studentFeedbackConfig.findUnique({ where: { trainerId } });
  return toMilestoneTemplates(stored);
}

/**
 * Saves the template of the milestones sent (null or the general template's id clears the choice) and returns every milestone.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {object} changes - any subset of d7, d15, d21, d30, recurring; 404 STUDENT_FEEDBACK_TEMPLATE_NOT_FOUND for a template the trainer cannot use
 * @returns {Promise<object>} template id of every milestone
 */
export async function updateMilestoneTemplates(prisma, trainerId, changes) {
  const columns = await withGeneralAsDefault(prisma, trainerId, pickTemplateColumns(changes));
  try {
    return toMilestoneTemplates(await saveTemplateColumns(prisma, trainerId, columns));
  } catch (err) {
    if (err?.code !== UNIQUE_VIOLATION_CODE) throw err;
    // why: two first saves of one trainer can both try to insert; the loser saves again over the row the winner created.
    return toMilestoneTemplates(await saveTemplateColumns(prisma, trainerId, columns));
  }
}
