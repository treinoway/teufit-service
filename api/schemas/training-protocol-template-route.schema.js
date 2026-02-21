import { weekDayValues, genderOrdinationValues, trainingLevelValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const weekDayEnum = weekDayValues;
const genderOrdinationEnum = genderOrdinationValues;
const trainingLevelEnum = trainingLevelValues;

const scheduleTemplateItemSchema = {
  type: 'object',
  required: ['trainingTemplateId', 'weekDay'],
  properties: {
    trainingTemplateId: { type: 'string', format: 'uuid' },
    weekDay: { type: 'string', enum: weekDayEnum },
    order: { type: 'integer', minimum: 0, default: 0 },
  },
  additionalProperties: false,
};

const scheduleTemplateResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    protocolTemplateId: { type: 'string', format: 'uuid' },
    trainingTemplateId: { type: 'string', format: 'uuid' },
    weekDay: { type: 'string' },
    order: { type: 'integer' },
    trainingTemplate: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        category: { type: 'string' },
        bodySegment: { type: 'string', nullable: true },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const createProtocolTemplateSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Create a new protocol template',
  description: 'Create a reusable protocol template (TRAINER only)',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      availableWeekDays: {
        type: 'array',
        items: { type: 'string', enum: weekDayEnum },
      },
      defaultDurationWeeks: { type: 'integer', minimum: 1 },
      genderOrdination: { type: 'string', enum: genderOrdinationEnum },
      trainingLevel: { type: 'string', enum: trainingLevelEnum },
      trainings: {
        type: 'array',
        items: scheduleTemplateItemSchema,
      },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        trainerId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        defaultDurationWeeks: { type: 'integer', nullable: true },
        genderOrdination: { type: 'string', nullable: true },
        trainingLevel: { type: 'string', nullable: true },
        scheduleTemplates: { type: 'array', items: scheduleTemplateResponseSchema },
        scheduleTemplatesCount: { type: 'integer' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time', nullable: true },
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

export const getProtocolTemplatesSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Get all protocol templates',
  description: 'Get all protocol templates created by the authenticated trainer',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          trainerId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          availableWeekDays: { type: 'array', items: { type: 'string' } },
          defaultDurationWeeks: { type: 'integer', nullable: true },
          genderOrdination: { type: 'string', nullable: true },
          trainingLevel: { type: 'string', nullable: true },
          scheduleTemplatesCount: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getProtocolTemplateByIdSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Get a protocol template by ID',
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
        trainerId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        defaultDurationWeeks: { type: 'integer', nullable: true },
        genderOrdination: { type: 'string', nullable: true },
        trainingLevel: { type: 'string', nullable: true },
        scheduleTemplates: { type: 'array', items: scheduleTemplateResponseSchema },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateProtocolTemplateSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Update a protocol template',
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
      availableWeekDays: {
        type: 'array',
        items: { type: 'string', enum: weekDayEnum },
      },
      defaultDurationWeeks: { type: 'integer', minimum: 1 },
      genderOrdination: { type: 'string', enum: genderOrdinationEnum },
      trainingLevel: { type: 'string', enum: trainingLevelEnum },
      trainings: {
        type: 'array',
        items: scheduleTemplateItemSchema,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        availableWeekDays: { type: 'array', items: { type: 'string' } },
        defaultDurationWeeks: { type: 'integer', nullable: true },
        genderOrdination: { type: 'string', nullable: true },
        trainingLevel: { type: 'string', nullable: true },
        scheduleTemplates: { type: 'array', items: scheduleTemplateResponseSchema },
        updatedAt: { type: 'string', format: 'date-time' },
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

export const deleteProtocolTemplateSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Delete a protocol template',
  description: 'Soft delete a protocol template',
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
        deletedAt: { type: 'string', format: 'date-time' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
