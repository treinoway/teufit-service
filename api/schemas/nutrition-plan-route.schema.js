import { QuantityUnit, SwapBasis } from '../../src/constants/nutrition.js';
import {
  badRequestErrorResponseSchema,
  errorResponseSchema,
  uuidParam,
  planSchema,
  goalsBodySchema,
  guidanceBodySchema,
  mealNameSchema,
  mealTimeSchema,
  mealTipSchema,
  householdMeasureInput,
} from './nutrition-shared.schema.js';

const tags = ['Nutritionist - Plan'];
const security = [{ bearerAuth: [] }];
const MAX_QUANTITY = 100000;

const planResponses = {
  200: planSchema,
  400: badRequestErrorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
};

const uuidList = { type: 'array', items: { type: 'string', format: 'uuid' } };

// Builds a route schema returning a Plan.
function planRoute(summary, extras = {}) {
  return { tags, summary, security, response: planResponses, ...extras };
}

export const getPlanSchema = planRoute('Plan of a patient (creates the draft on the first call)', {
  params: uuidParam('patientId'),
});

export const updateGoalsSchema = planRoute('Update the plan goals (partial)', {
  params: uuidParam('planId'),
  body: { ...goalsBodySchema, minProperties: 1 },
});

export const updateGuidanceSchema = planRoute('Update the plan guidance (partial)', {
  params: uuidParam('planId'),
  body: { ...guidanceBodySchema, minProperties: 1 },
});

export const publishPlanSchema = planRoute(
  'Publish the plan: freezes the snapshot the patient app reads and increments the version',
  { params: uuidParam('planId') },
);

export const createMealSchema = planRoute('Add a meal (with one empty option)', {
  params: uuidParam('planId'),
  body: {
    type: 'object',
    required: ['name', 'time'],
    additionalProperties: false,
    properties: { name: mealNameSchema, time: mealTimeSchema, tip: mealTipSchema },
  },
});

export const updateMealSchema = planRoute('Edit a meal', {
  params: uuidParam('mealId'),
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: { name: mealNameSchema, time: mealTimeSchema, tip: mealTipSchema },
  },
});

export const deleteMealSchema = planRoute('Remove a meal', { params: uuidParam('mealId') });

export const reorderMealsSchema = planRoute('Reorder the meals of a plan', {
  params: uuidParam('planId'),
  body: { type: 'object', required: ['mealIds'], additionalProperties: false, properties: { mealIds: uuidList } },
});

export const addOptionSchema = planRoute('Add a meal option copying option 1 (max 3)', {
  params: uuidParam('mealId'),
});

export const deleteOptionSchema = planRoute('Remove a meal option (option 1 cannot be removed)', {
  params: uuidParam('optionId'),
});

export const addItemSchema = planRoute('Add a food to a meal option', {
  params: uuidParam('optionId'),
  body: {
    type: 'object',
    required: ['foodId'],
    additionalProperties: false,
    properties: {
      foodId: { type: 'string', format: 'uuid' },
      quantity: { type: 'number', exclusiveMinimum: 0, maximum: MAX_QUANTITY },
      unit: { type: 'string', enum: Object.values(QuantityUnit) },
      householdMeasure: householdMeasureInput,
    },
  },
});

export const updateItemSchema = planRoute('Edit an item; changing quantity or swapBasis recomputes the substitutes', {
  params: uuidParam('itemId'),
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
      quantity: { type: 'number', exclusiveMinimum: 0, maximum: MAX_QUANTITY },
      unit: { type: 'string', enum: Object.values(QuantityUnit) },
      householdMeasure: householdMeasureInput,
      swapBasis: { type: 'string', enum: Object.values(SwapBasis) },
      order: { type: 'integer', minimum: 0 },
    },
  },
});

export const deleteItemSchema = planRoute('Remove an item', { params: uuidParam('itemId') });

export const addSubstituteSchema = planRoute('Release a substitute food for an item', {
  params: uuidParam('itemId'),
  body: {
    type: 'object',
    required: ['foodId'],
    additionalProperties: false,
    properties: { foodId: { type: 'string', format: 'uuid' } },
  },
});

export const removeSubstituteSchema = planRoute('Remove a substitute', { params: uuidParam('substituteId') });
