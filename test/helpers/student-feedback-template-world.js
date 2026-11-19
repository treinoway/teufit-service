/**
 * Part 2 (template builder) additions to the in-memory Prisma stand-in of the student feedbacks.
 *
 * Registers the relations the base world does not model (template versions, config -> template per
 * milestone) and seeds trainer-owned templates, so the tests assert what is stored and returned
 * instead of the shape of each query.
 */

import {
  RELATIONS,
  STUDENT_ID,
  TEMPLATE_ID,
  TRAINER_ID,
  createFeedbackWorld,
  seedConfig,
  seedRequest,
} from './student-feedback-world.js';

export const TEMPLATE_MODEL = 'studentFeedbackTemplate';
export const QUESTION_MODEL = 'studentFeedbackQuestion';
export const CONFIG_MODEL = 'studentFeedbackConfig';
export const REQUEST_MODEL = 'studentFeedbackRequest';

export const OWN_TEMPLATE_ID = 'template-own';
export const OWN_TEMPLATE_NAME = 'Check-in semanal';
export const OTHER_TEMPLATE_ID = 'template-other-trainer';
export const OTHER_TEMPLATE_NAME = 'Modelo da Paula';
export const UNKNOWN_TEMPLATE_ID = 'template-unknown';

// Config column holding the template of each milestone toggle
export const TEMPLATE_COLUMN_BY_FIELD = Object.freeze({
  d7: 'd7TemplateId',
  d15: 'd15TemplateId',
  d21: 'd21TemplateId',
  d30: 'd30TemplateId',
  recurring: 'recurringTemplateId',
});

export const MILESTONE_TEMPLATE_FIELDS = Object.freeze(Object.keys(TEMPLATE_COLUMN_BY_FIELD));
export const NO_MILESTONE_TEMPLATES = Object.freeze({ d7: null, d15: null, d21: null, d30: null, recurring: null });

const SEEDED_AT = new Date('2026-10-01T12:00:00Z');

// Questions of the trainer-owned fixture template: one of each type
export const OWN_QUESTIONS = Object.freeze([
  Object.freeze({ text: 'Como foi tua semana de treino?', helpText: 'Pensa nos últimos 7 dias', type: 'score', pillar: 'training_adherence', required: true, minLabel: 'Péssima', maxLabel: 'Ótima' }),
  Object.freeze({ text: 'Como dormiste?', type: 'stars', pillar: 'sleep', required: true }),
  Object.freeze({ text: 'Algo a relatar?', type: 'open', pillar: 'report', required: false }),
]);

// To-one relation descriptor in the format of the base world: this model holds the foreign key
function one(model, foreignKey) {
  return { kind: 'one', model, foreignKey };
}

// To-many relation descriptor in the format of the base world: the other model holds the foreign key
function many(model, foreignKey) {
  return { kind: 'many', model, foreignKey };
}

// Adds the part 2 relations to the registry of the base world; safe to call more than once
function registerTemplateRelations() {
  RELATIONS.studentFeedbackTemplate.parent = one(TEMPLATE_MODEL, 'parentId');
  RELATIONS.studentFeedbackTemplate.forks = many(TEMPLATE_MODEL, 'parentId');
  for (const [field, column] of Object.entries(TEMPLATE_COLUMN_BY_FIELD)) {
    RELATIONS.studentFeedbackConfig[`${field}Template`] = one(TEMPLATE_MODEL, column);
    RELATIONS.studentFeedbackTemplate[`${field}Configs`] = many(CONFIG_MODEL, column);
  }
}

registerTemplateRelations();

/**
 * Seeds a trainer-owned template with its questions (order 1..n); owned by the main trainer, version 1 and not deleted unless overridden.
 *
 * @param {object} world
 * @param {{ id?: string, trainerId?: string, name?: string, version?: number, parentId?: string|null, deletedAt?: Date|null, questions?: object[] }} [overrides]
 * @returns {object} the stored template row
 */
export function seedOwnTemplate(world, { questions = OWN_QUESTIONS, ...overrides } = {}) {
  const template = world.seed(TEMPLATE_MODEL, {
    id: OWN_TEMPLATE_ID,
    trainerId: TRAINER_ID,
    isGeneral: false,
    name: OWN_TEMPLATE_NAME,
    version: 1,
    parentId: null,
    deletedAt: null,
    updatedAt: SEEDED_AT,
    ...overrides,
  });
  questions.forEach((question, index) => {
    world.seed(QUESTION_MODEL, {
      id: `${template.id}-q${index + 1}`,
      helpText: null,
      minLabel: null,
      maxLabel: null,
      invertScore: false,
      condition: null,
      ...question,
      order: index + 1,
      templateId: template.id,
    });
  });
  return template;
}

// Seeds the config of a trainer with every milestone template column empty unless overridden
export function seedTemplateConfig(world, overrides = {}) {
  return seedConfig(world, {
    d7TemplateId: null,
    d15TemplateId: null,
    d21TemplateId: null,
    d30TemplateId: null,
    recurringTemplateId: null,
    ...overrides,
  });
}

// Seeds an answered request of the main trainer and student that used the given template
export function seedAnsweredRequest(world, templateId, overrides = {}) {
  return seedRequest(world, {
    templateId,
    sentAt: new Date('2026-10-10T12:00:00Z'),
    status: 'answered',
    submittedAt: new Date('2026-10-11T12:00:00Z'),
    overallIndex: 80,
    band: 'good',
    pillarScores: { training_adherence: 80 },
    ...overrides,
  });
}

// Stored rows of the non-deleted templates of a trainer
export function liveTemplatesOf(world, trainerId = TRAINER_ID) {
  return world.rows(TEMPLATE_MODEL).filter((row) => row.trainerId === trainerId && !row.deletedAt);
}

// Stored questions of a template, in order
export function questionsOf(world, templateId) {
  return world
    .rows(QUESTION_MODEL)
    .filter((row) => row.templateId === templateId)
    .sort((left, right) => left.order - right.order);
}

// Stored config row of a trainer, or undefined
export function configOf(world, trainerId = TRAINER_ID) {
  return world.rows(CONFIG_MODEL).find((row) => row.trainerId === trainerId);
}

// Milestone template ids stored for a trainer, by toggle field; a missing row or column reads as null
export function storedMilestoneTemplates(world, trainerId = TRAINER_ID) {
  const config = configOf(world, trainerId);
  return Object.fromEntries(MILESTONE_TEMPLATE_FIELDS.map((field) => [field, config?.[TEMPLATE_COLUMN_BY_FIELD[field]] ?? null]));
}

// Deep copy of every stored row of the template models, to prove a rejected call wrote nothing
export function snapshotTemplates(world) {
  return structuredClone({
    templates: world.rows(TEMPLATE_MODEL),
    questions: world.rows(QUESTION_MODEL),
    configs: world.rows(CONFIG_MODEL),
    requests: world.rows(REQUEST_MODEL),
  });
}

/**
 * World of the base fixture (two trainers, two students, the general template) ready for the template tests.
 *
 * @returns {object} the world
 */
export function createTemplateWorld() {
  return createFeedbackWorld();
}

export { STUDENT_ID, TEMPLATE_ID as GENERAL_TEMPLATE_ID, TRAINER_ID };
