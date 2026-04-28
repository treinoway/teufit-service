import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const foodItemResponseSchema = {
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
    createdAt: { type: 'string', format: 'date-time' },
    food: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
};

export const createFoodItemSchema = {
  tags: ['Diet Food Items'],
  summary: 'Add a food item to a diet meal',
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
    required: ['quantityG'],
    properties: {
      foodId: { type: 'string', format: 'uuid' },
      foodName: { type: 'string', minLength: 1 },
      quantityG: { type: 'number', minimum: 0.01 },
      unit: { type: 'string' },
      energyKcal: { type: 'number' },
      proteinG: { type: 'number' },
      carbohydratesG: { type: 'number' },
      totalFatG: { type: 'number' },
      fiberG: { type: 'number' },
      order: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    201: foodItemResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateFoodItemSchema = {
  tags: ['Diet Food Items'],
  summary: 'Update a diet food item',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['foodItemId'],
    properties: {
      foodItemId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      foodId: { type: 'string', format: 'uuid' },
      foodName: { type: 'string', minLength: 1 },
      quantityG: { type: 'number', minimum: 0.01 },
      unit: { type: 'string' },
      energyKcal: { type: 'number' },
      proteinG: { type: 'number' },
      carbohydratesG: { type: 'number' },
      totalFatG: { type: 'number' },
      fiberG: { type: 'number' },
      order: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    200: foodItemResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteFoodItemSchema = {
  tags: ['Diet Food Items'],
  summary: 'Delete a diet food item',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['foodItemId'],
    properties: {
      foodItemId: { type: 'string', format: 'uuid' },
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
