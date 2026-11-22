import { beforeEach, describe, expect, it } from 'vitest';
import { saveTemplate } from '../../src/services/student-feedback-template-service.js';
import {
  StudentFeedbackPillar,
  StudentFeedbackQuestionCondition,
  StudentFeedbackQuestionType,
  StudentFeedbackTemplateErrorCode,
  StudentFeedbackTemplateMessageCode,
} from '../../src/constants/student-feedback.js';
import { seedLink } from '../helpers/student-feedback-world.js';
import {
  OWN_TEMPLATE_ID,
  TRAINER_ID,
  createTemplateWorld,
  liveTemplatesOf,
  questionsOf,
  seedAnsweredRequest,
  seedOwnTemplate,
  seedTemplateConfig,
  snapshotTemplates,
} from '../helpers/student-feedback-template-world.js';

const HTTP_BAD_REQUEST = 400;
const SAVED_NAME = 'Check-in quinzenal';
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
const NOW = new Date('2026-11-08T13:00:00Z');
const { HAS_MEAL_PLAN } = StudentFeedbackQuestionCondition;
const INVALID = Object.freeze({
  httpStatus: HTTP_BAD_REQUEST,
  error: StudentFeedbackTemplateErrorCode.INVALID,
  messageCode: StudentFeedbackTemplateMessageCode.INVALID,
});

// A valid question of a save payload that every student sees, unless overridden
function question(overrides = {}) {
  return { text: 'Como foi tua semana?', type: StudentFeedbackQuestionType.STARS, pillar: StudentFeedbackPillar.SLEEP, required: true, invertScore: false, ...overrides };
}

// A valid question of a save payload shown only to students with a meal plan
function mealPlanQuestion(overrides = {}) {
  return question({ text: 'Seguiste a dieta?', pillar: StudentFeedbackPillar.REPORT, condition: HAS_MEAL_PLAN, ...overrides });
}

// A save payload with the given questions
function savePayload(questions) {
  return { name: SAVED_NAME, questions };
}

// Conditions stored for the questions of a template, in order
function storedConditions(world, templateId) {
  return questionsOf(world, templateId).map((row) => row.condition);
}

describe('saveTemplate question conditions', () => {
  let world;

  beforeEach(() => {
    world = createTemplateWorld();
    seedOwnTemplate(world);
    seedTemplateConfig(world, { d7TemplateId: OWN_TEMPLATE_ID });
  });

  describe('when no question is shown to every student', () => {
    it('answers STUDENT_FEEDBACK_TEMPLATE_INVALID and writes nothing when every question is conditional', async () => {
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload([mealPlanQuestion(), mealPlanQuestion({ text: 'Bebeste água?' })]))).rejects.toMatchObject(INVALID);

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('answers STUDENT_FEEDBACK_TEMPLATE_INVALID and writes nothing when the single question is conditional', async () => {
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload([mealPlanQuestion()]))).rejects.toMatchObject(INVALID);

      expect(snapshotTemplates(world)).toEqual(before);
    });

    it('creates no new version and keeps the milestones when the template already has requests', async () => {
      seedLink(world, { createdAt: LINKED_AT });
      seedAnsweredRequest(world, OWN_TEMPLATE_ID);
      const before = snapshotTemplates(world);

      await expect(saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload([mealPlanQuestion(), mealPlanQuestion()]), NOW)).rejects.toMatchObject(INVALID);

      expect(snapshotTemplates(world)).toEqual(before);
      expect(liveTemplatesOf(world).map((row) => row.id)).toEqual([OWN_TEMPLATE_ID]);
    });
  });

  describe('when at least one question is shown to every student', () => {
    it('saves one unconditional question among conditional ones and keeps each condition', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload([mealPlanQuestion(), question(), mealPlanQuestion()]));

      expect(saved.questions.map((row) => row.condition)).toEqual([HAS_MEAL_PLAN, null, HAS_MEAL_PLAN]);
      expect(storedConditions(world, OWN_TEMPLATE_ID)).toEqual([HAS_MEAL_PLAN, null, HAS_MEAL_PLAN]);
    });

    it('accepts an explicit null condition as the unconditional question', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload([mealPlanQuestion(), question({ condition: null })]));

      expect(saved.name).toBe(SAVED_NAME);
      expect(storedConditions(world, OWN_TEMPLATE_ID)).toEqual([HAS_MEAL_PLAN, null]);
    });

    it('saves a template in which every question is unconditional', async () => {
      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload([question(), question({ condition: null })]));

      expect(saved).toMatchObject({ id: OWN_TEMPLATE_ID, name: SAVED_NAME });
      expect(storedConditions(world, OWN_TEMPLATE_ID)).toEqual([null, null]);
    });

    it('creates the new version of a template with requests when one question is unconditional', async () => {
      seedLink(world, { createdAt: LINKED_AT });
      seedAnsweredRequest(world, OWN_TEMPLATE_ID);

      const saved = await saveTemplate(world.prisma, TRAINER_ID, OWN_TEMPLATE_ID, savePayload([question(), mealPlanQuestion()]), NOW);

      expect(saved.id).not.toBe(OWN_TEMPLATE_ID);
      expect(storedConditions(world, saved.id)).toEqual([null, HAS_MEAL_PLAN]);
    });
  });
});
