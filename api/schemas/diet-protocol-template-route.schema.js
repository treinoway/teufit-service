import { dietTypeValues, goalTypeValues, mealTypeValues } from '../../src/constants/diet.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const foodItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    dietTemplateMealId: { type: 'string', format: 'uuid' },
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
  },
};

const mealSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    dietProtocolTemplateId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    ...i18nField('mealType', 'mealType'),
    order: { type: 'integer' },
    scheduledTime: { type: 'string', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    foodItems: { type: 'array', items: foodItemSchema },
  },
};

const templateSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    nutritionistId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    ...i18nField('dietType', 'dietType', { nullable: true }),
    ...i18nField('goalType', 'goalType', { nullable: true }),
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const foodItemBodySchema = {
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
};

const mealBodySchema = {
  type: 'object',
  required: ['name', 'mealType'],
  properties: {
    name: { type: 'string', minLength: 1 },
    mealType: { type: 'string', enum: mealTypeValues },
    order: { type: 'integer', minimum: 0 },
    scheduledTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
    notes: { type: 'string' },
    foodItems: { type: 'array', items: foodItemBodySchema },
  },
  additionalProperties: false,
};

export const createTemplateSchema = {
  tags: ['Diet Protocol Templates'],
  summary: 'Create a diet protocol template',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      dietType: { type: 'string', enum: dietTypeValues },
      goalType: { type: 'string', enum: goalTypeValues },
      meals: { type: 'array', items: mealBodySchema },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      description: 'Created diet protocol template',
      ...templateSchema,
      properties: {
        ...templateSchema.properties,
        mealsCount: { type: 'integer' },
        meals: { type: 'array', items: mealSchema },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listTemplatesSchema = {
  tags: ['Diet Protocol Templates'],
  summary: 'List diet protocol templates',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: {
        ...templateSchema,
        properties: {
          ...templateSchema.properties,
          mealsCount: { type: 'integer' },
        },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getTemplateByIdSchema = {
  tags: ['Diet Protocol Templates'],
  summary: 'Get diet protocol template by ID',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      ...templateSchema,
      properties: {
        ...templateSchema.properties,
        meals: { type: 'array', items: mealSchema },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateTemplateSchema = {
  tags: ['Diet Protocol Templates'],
  summary: 'Update a diet protocol template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      dietType: { type: 'string', enum: dietTypeValues },
      goalType: { type: 'string', enum: goalTypeValues },
      meals: { type: 'array', items: mealBodySchema },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      ...templateSchema,
      properties: {
        ...templateSchema.properties,
        meals: { type: 'array', items: mealSchema },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteTemplateSchema = {
  tags: ['Diet Protocol Templates'],
  summary: 'Delete a diet protocol template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
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
