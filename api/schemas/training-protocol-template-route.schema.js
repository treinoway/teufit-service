import { weekDayValues, genderOrdinationValues, trainingLevelValues, protocolTypeValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const weekDayEnum = weekDayValues;
const genderOrdinationEnum = genderOrdinationValues;
const trainingLevelEnum = trainingLevelValues;
const protocolTypeEnum = protocolTypeValues;

const templateTrainingItemSchema = {
  type: 'object',
  required: ['trainingTemplateId'],
  properties: {
    trainingTemplateId: { type: 'string', format: 'uuid' },
    weekDay: { type: 'string', enum: weekDayEnum },
    order: { type: 'integer', minimum: 0, default: 0 },
  },
  additionalProperties: false,
};

const templateTrainingResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    protocolTemplateId: { type: 'string', format: 'uuid' },
    trainingTemplateId: { type: 'string', format: 'uuid' },
    weekDay: { type: 'string', nullable: true },
    order: { type: 'integer' },
    trainingTemplate: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        ...i18nField('category', 'trainingCategory'),
        ...i18nField('bodySegment', 'bodySegment', { nullable: true }),
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
      defaultDurationWeeks: { type: ['integer', 'null'], minimum: 1 },
      genderOrdination: { type: 'string', enum: genderOrdinationEnum },
      trainingLevel: { type: 'string', enum: trainingLevelEnum },
      type: { type: 'string', enum: protocolTypeEnum },
      trainings: {
        type: 'array',
        items: templateTrainingItemSchema,
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
        defaultDurationWeeks: { type: 'integer', nullable: true },
        ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
        ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
        ...i18nField('type', 'protocolType', { nullable: true }),
        trainings: { type: 'array', items: templateTrainingResponseSchema },
        trainingsCount: { type: 'integer' },
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
          defaultDurationWeeks: { type: 'integer', nullable: true },
          ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
          ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
          ...i18nField('type', 'protocolType', { nullable: true }),
          trainingsCount: { type: 'integer' },
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
        defaultDurationWeeks: { type: 'integer', nullable: true },
        ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
        ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
        ...i18nField('type', 'protocolType', { nullable: true }),
        trainings: { type: 'array', items: templateTrainingResponseSchema },
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
      defaultDurationWeeks: { type: ['integer', 'null'], minimum: 1 },
      genderOrdination: { type: 'string', enum: genderOrdinationEnum },
      trainingLevel: { type: 'string', enum: trainingLevelEnum },
      type: { type: 'string', enum: protocolTypeEnum },
      trainings: {
        type: 'array',
        items: templateTrainingItemSchema,
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
        defaultDurationWeeks: { type: 'integer', nullable: true },
        ...i18nField('genderOrdination', 'genderOrdination', { nullable: true }),
        ...i18nField('trainingLevel', 'trainingLevel', { nullable: true }),
        ...i18nField('type', 'protocolType', { nullable: true }),
        trainings: { type: 'array', items: templateTrainingResponseSchema },
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
