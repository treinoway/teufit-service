import { MealLogStatus } from '../../src/constants/nutrition.js';
import { badRequestErrorResponseSchema, errorResponseSchema, todaySchema } from './nutrition-shared.schema.js';

const tags = ['Nutrition - Patient app'];
const security = [{ bearerAuth: [] }];
const MAX_NOTE_LENGTH = 500;
const MAX_WATER_DELTA_ML = 10000;

// Params schema with the :date path parameter plus extra uuid parameters.
const dateParams = (...extra) => ({
  type: 'object',
  required: ['date', ...extra],
  properties: {
    date: { type: 'string', format: 'date' },
    ...Object.fromEntries(extra.map((name) => [name, { type: 'string', format: 'uuid' }])),
  },
});

const responses = {
  200: todaySchema,
  400: badRequestErrorResponseSchema,
  401: errorResponseSchema,
  404: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
};

export const getTodaySchema = {
  tags,
  summary: 'The patient day: published plan, status of each meal, swaps, water',
  description: 'date defaults to today in America/Sao_Paulo. plan is null without a published plan.',
  security,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { date: { type: 'string', format: 'date' } },
  },
  response: responses,
};

export const putMealSchema = {
  tags,
  summary: 'Mark a meal done / "ate differently" and/or choose its option for the date',
  security,
  params: dateParams('mealId'),
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: Object.values(MealLogStatus) },
      optionId: { type: 'string', format: 'uuid' },
      note: { type: 'string', maxLength: MAX_NOTE_LENGTH, nullable: true },
    },
  },
  response: responses,
};

export const deleteMealSchema = {
  tags,
  summary: 'Undo the done / different status of a meal for the date (keeps the option choice)',
  security,
  params: dateParams('mealId'),
  response: responses,
};

export const putSwapSchema = {
  tags,
  summary: 'Swap an item for a released substitute, for the date only',
  security,
  params: dateParams('itemId'),
  body: {
    type: 'object',
    required: ['substituteId'],
    additionalProperties: false,
    properties: { substituteId: { type: 'string', format: 'uuid' } },
  },
  response: responses,
};

export const deleteSwapSchema = {
  tags,
  summary: 'Remove the swap of an item for the date',
  security,
  params: dateParams('itemId'),
  response: responses,
};

export const postWaterSchema = {
  tags,
  summary: 'Add water for the date (negative ml undoes); total clamped to [0, 2x target]',
  security,
  params: dateParams(),
  body: {
    type: 'object',
    required: ['ml'],
    additionalProperties: false,
    properties: { ml: { type: 'integer', minimum: -MAX_WATER_DELTA_ML, maximum: MAX_WATER_DELTA_ML } },
  },
  response: responses,
};
