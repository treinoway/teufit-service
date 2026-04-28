import {
  dietProtocolStatusValues,
  dietTypeValues,
  goalTypeValues,
  tmbFormulaValues,
  activityLevelValues,
} from '../../src/constants/diet.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const assigneeSchema = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
  },
  additionalProperties: false,
};

const nutritionistInfoSchema = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
  },
  additionalProperties: false,
};

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
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const mealSchema = {
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

const protocolBaseProperties = {
  id: { type: 'string', format: 'uuid' },
  nutritionistId: { type: 'string', format: 'uuid' },
  assigneeId: { type: 'string', format: 'uuid' },
  dietProtocolTemplateId: { type: 'string', format: 'uuid', nullable: true },
  name: { type: 'string' },
  description: { type: 'string', nullable: true },
  ...i18nField('status', 'dietProtocolStatus'),
  startDate: { type: 'string', format: 'date' },
  expirationDate: { type: 'string', format: 'date', nullable: true },
  ...i18nField('dietType', 'dietType', { nullable: true }),
  ...i18nField('goalType', 'goalType', { nullable: true }),
  tmbFormula: { type: 'string', nullable: true },
  tmbKcal: { type: 'number', nullable: true },
  activityLevel: { type: 'string', nullable: true },
  getKcal: { type: 'number', nullable: true },
  dailyCaloricTarget: { type: 'number', nullable: true },
  notes: { type: 'string', nullable: true },
  createdAt: { type: 'string', format: 'date-time' },
};

export const createProtocolSchema = {
  tags: ['Diet Protocols - Nutritionist'],
  summary: 'Create a diet protocol for a patient',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['assigneeId', 'name', 'startDate'],
    properties: {
      assigneeId: { type: 'string', format: 'uuid' },
      dietProtocolTemplateId: { type: 'string', format: 'uuid' },
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      status: { type: 'string', enum: dietProtocolStatusValues },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
      dietType: { type: 'string', enum: dietTypeValues },
      goalType: { type: 'string', enum: goalTypeValues },
      tmbFormula: { type: 'string', enum: tmbFormulaValues },
      tmbKcal: { type: 'number', minimum: 0 },
      activityLevel: { type: 'string', enum: activityLevelValues },
      getKcal: { type: 'number', minimum: 0 },
      dailyCaloricTarget: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        ...protocolBaseProperties,
        assignee: assigneeSchema,
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

export const importFromTemplateSchema = {
  tags: ['Diet Protocols - Nutritionist'],
  summary: 'Create a diet protocol from a template',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['templateId', 'assigneeId'],
    properties: {
      templateId: { type: 'string', format: 'uuid' },
      assigneeId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string' },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
      dietType: { type: 'string', enum: dietTypeValues },
      goalType: { type: 'string', enum: goalTypeValues },
      tmbFormula: { type: 'string', enum: tmbFormulaValues },
      tmbKcal: { type: 'number', minimum: 0 },
      activityLevel: { type: 'string', enum: activityLevelValues },
      getKcal: { type: 'number', minimum: 0 },
      dailyCaloricTarget: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        ...protocolBaseProperties,
        assignee: assigneeSchema,
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

export const listProtocolsSchema = {
  tags: ['Diet Protocols - Nutritionist'],
  summary: 'List diet protocols created by nutritionist',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: dietProtocolStatusValues },
      assigneeId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ...protocolBaseProperties,
          assignee: assigneeSchema,
        },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getProtocolByIdSchema = {
  tags: ['Diet Protocols - Nutritionist'],
  summary: 'Get diet protocol by ID',
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
        ...protocolBaseProperties,
        assignee: assigneeSchema,
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

export const updateProtocolSchema = {
  tags: ['Diet Protocols - Nutritionist'],
  summary: 'Update a diet protocol',
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
      status: { type: 'string', enum: dietProtocolStatusValues },
      startDate: { type: 'string', format: 'date' },
      expirationDate: { type: 'string', format: 'date' },
      dietType: { type: 'string', enum: dietTypeValues },
      goalType: { type: 'string', enum: goalTypeValues },
      tmbFormula: { type: 'string', enum: tmbFormulaValues },
      tmbKcal: { type: 'number', minimum: 0 },
      activityLevel: { type: 'string', enum: activityLevelValues },
      getKcal: { type: 'number', minimum: 0 },
      dailyCaloricTarget: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        ...protocolBaseProperties,
        assignee: assigneeSchema,
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

export const deleteProtocolSchema = {
  tags: ['Diet Protocols - Nutritionist'],
  summary: 'Delete a diet protocol',
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

// My diet protocols schemas (patient view)
export const getMyProtocolsSchema = {
  tags: ['Diet Protocols - My'],
  summary: 'Get diet protocols assigned to the authenticated user',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: dietProtocolStatusValues },
    },
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ...protocolBaseProperties,
          nutritionist: nutritionistInfoSchema,
          meals: { type: 'array', items: mealSchema },
        },
      },
    },
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getMyProtocolByIdSchema = {
  tags: ['Diet Protocols - My'],
  summary: 'Get diet protocol by ID (patient view)',
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
        ...protocolBaseProperties,
        nutritionist: nutritionistInfoSchema,
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
