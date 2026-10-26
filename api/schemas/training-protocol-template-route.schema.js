import { weekDayValues, genderOrdinationValues, trainingLevelValues, protocolTypeValues, prescriptionModeValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
import { gifUrlResponseSchema } from './gif-url.schema.js';

const weekDayEnum = weekDayValues;
const genderOrdinationEnum = genderOrdinationValues;
const trainingLevelEnum = trainingLevelValues;
const protocolTypeEnum = protocolTypeValues;

const templateTrainingItemSchema = {
  type: 'object',
  required: ['trainingTemplateId'],
  properties: {
    trainingTemplateId: { type: 'string', format: 'uuid' },
    weekDay: { type: ['string', 'null'], enum: [...weekDayEnum, null] },
    order: { type: 'integer', minimum: 0, default: 0 },
  },
  additionalProperties: false,
};

const exerciseTemplateRefSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    type: { type: 'string' },
    videoUrl: { type: 'string', nullable: true },
    gifUrl: gifUrlResponseSchema,
    isPublic: { type: 'boolean' },
    prescriptionMode: { type: 'string', enum: prescriptionModeValues },
    sets: { type: 'integer', nullable: true },
    repetitions: {
      type: 'object',
      nullable: true,
      properties: {
        min: { type: 'integer', minimum: 1 },
        max: { type: 'integer', minimum: 1 },
      },
    },
    duration: { type: 'integer', nullable: true },
    hasLoad: { type: 'boolean' },
    suggestedLoad: { type: 'number', nullable: true },
    restInterval: { type: 'integer', nullable: true },
    notes: { type: 'string', nullable: true },
  },
};

const trainingTemplateExerciseTemplateSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainingTemplateId: { type: 'string', format: 'uuid' },
    exerciseTemplateId: { type: 'string', format: 'uuid' },
    order: { type: 'integer' },
    // Snapshot fields — independent copy of the exercise at link time
    name: { type: 'string' },
    type: { type: 'string' },
    videoUrl: { type: 'string', nullable: true },
    gifUrl: gifUrlResponseSchema,
    prescriptionMode: { type: 'string', enum: prescriptionModeValues },
    sets: { type: 'integer', nullable: true },
    repetitions: {
      type: 'object',
      nullable: true,
      properties: {
        min: { type: 'integer', minimum: 1 },
        max: { type: 'integer', minimum: 1 },
      },
    },
    duration: { type: 'integer', nullable: true },
    hasLoad: { type: 'boolean' },
    suggestedLoad: { type: 'number', nullable: true },
    restInterval: { type: 'integer', nullable: true },
    notes: { type: 'string', nullable: true },
    exerciseTemplate: exerciseTemplateRefSchema,
  },
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
        trainerId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        description: { type: 'string', nullable: true },
        ...i18nField('category', 'trainingCategory'),
        ...i18nField('bodySegment', 'bodySegment', { nullable: true }),
        tags: { type: 'array', items: { type: 'string' } },
        isPublic: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time', nullable: true },
        trainingTemplateExerciseTemplates: {
          type: 'array',
          items: trainingTemplateExerciseTemplateSchema,
        },
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

const protocolTemplateListItemSchema = {
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
};

export const getProtocolTemplatesSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Get all protocol templates',
  description: 'Get all protocol templates created by the authenticated trainer',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      q: { type: 'string' },
      type: { type: 'string', enum: protocolTypeEnum },
      trainingLevel: { type: 'string', enum: trainingLevelEnum },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: protocolTemplateListItemSchema },
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['data', 'total', 'page', 'limit'],
    },
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const batchDeleteProtocolTemplatesSchema = {
  tags: ['Training Protocol Templates'],
  summary: 'Batch delete protocol templates',
  description: 'Soft-delete multiple protocol templates owned by the trainer. Non-owned IDs are silently skipped.',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['ids'],
    additionalProperties: false,
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        maxItems: 200,
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        deletedCount: { type: 'integer' },
      },
      required: ['deletedCount'],
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
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
