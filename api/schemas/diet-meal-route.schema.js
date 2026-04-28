import { mealTypeValues } from '../../src/constants/diet.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const foodItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    dietMealId: { type: 'string', format: 'uuid' },
    foodId: { type: 'string', format: 'uuid', nullable: true },
    foodName: { type: 'string' },
    quantityG: { type: 'number' },
    unit: { type: 'string' },
    energyKcal: { type: 'number', nullable: true },
    proteinG: { type: 'number', nullable: true },
    carbohydratesG: { type: 'number', nullable: true },
    totalFatG: { type: 'number', nullable: true },
    fiberG: { type: 'number', nullable: true },
    order: { type: 'integer' },
    notes: { type: 'string', nullable: true },
  },
};

const mealResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    dietProtocolId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    ...i18nField('mealType', 'mealType'),
    order: { type: 'integer' },
    scheduledTime: { type: 'string', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    foodItems: { type: 'array', items: foodItemSchema },
  },
};

export const createMealSchema = {
  tags: ['Diet Meals'],
  summary: 'Add a meal to a diet protocol',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['protocolId'],
    properties: {
      protocolId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['name', 'mealType'],
    properties: {
      name: { type: 'string', minLength: 1 },
      mealType: { type: 'string', enum: mealTypeValues },
      order: { type: 'integer', minimum: 0 },
      scheduledTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    201: mealResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateMealSchema = {
  tags: ['Diet Meals'],
  summary: 'Update a diet meal',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['mealId'],
    properties: {
      mealId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      mealType: { type: 'string', enum: mealTypeValues },
      order: { type: 'integer', minimum: 0 },
      scheduledTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    200: mealResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteMealSchema = {
  tags: ['Diet Meals'],
  summary: 'Delete a diet meal',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['mealId'],
    properties: {
      mealId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        deletedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
