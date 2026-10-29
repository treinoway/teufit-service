import { trainingCategoryValues, bodySegmentValues, weekDayValues, prescriptionModeValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
import { gifUrlResponseSchema } from './gif-url.schema.js';
import { advancedTechniquesResponseSchema } from './advanced-technique.schema.js';

export const trainingResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainingProtocolId: { type: 'string', format: 'uuid' },
    trainingTemplateId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    ...i18nField('category', 'trainingCategory'),
    ...i18nField('bodySegment', 'bodySegment', { nullable: true }),
    ...i18nField('weekDay', 'weekDay', { nullable: true }),
    order: { type: 'integer', nullable: true },
    notes: { type: 'string', nullable: true },
    estimatedDurationSeconds: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const createTrainingSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Create a training',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['protocolId'],
    properties: { protocolId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['name', 'category'],
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      category: { type: 'string', enum: trainingCategoryValues },
      bodySegment: { type: 'string', enum: bodySegmentValues },
      weekDay: { type: ['string', 'null'], enum: [...weekDayValues, null] },
      order: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
      trainingTemplateId: { type: 'string', format: 'uuid' },
    },
    additionalProperties: false,
  },
  response: {
    201: trainingResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getTrainingsSchema = {
  tags: ['Trainings'],
  summary: 'Get trainings by protocol',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['protocolId'],
    properties: { protocolId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'array',
      items: trainingResponseSchema,
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getTrainingByIdSchema = {
  tags: ['Trainings'],
  summary: 'Get training by ID',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: trainingResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateTrainingSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Update training',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      category: { type: 'string', enum: trainingCategoryValues },
      bodySegment: { type: 'string', enum: bodySegmentValues },
      weekDay: { type: ['string', 'null'], enum: [...weekDayValues, null] },
      order: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    200: trainingResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteTrainingSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Delete training',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
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

export const importedExerciseResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainingId: { type: 'string', format: 'uuid' },
    exerciseTemplateId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' },
    ...i18nField('type', 'exerciseType'),
    videoUrl: { type: 'string', nullable: true },
    gifUrl: gifUrlResponseSchema,
    order: { type: 'integer' },
    supersetGroupId: { type: 'string', format: 'uuid', nullable: true },
    supersetOrder: { type: 'integer' },
    supersetRestInterval: { type: 'integer', nullable: true },
    prescriptionMode: { type: 'string', enum: prescriptionModeValues },
    sets: { type: 'integer', nullable: true },
    repetitions: {
      type: 'object',
      nullable: true,
      properties: {
        min: { type: 'integer', nullable: true, minimum: 1 },
        max: { type: 'integer', nullable: true, minimum: 1 },
      },
    },
    duration: { type: 'integer', nullable: true },
    hasLoad: { type: 'boolean' },
    suggestedLoad: { type: 'number', nullable: true },
    restInterval: { type: 'integer', nullable: true },
    notes: { type: 'string', nullable: true },
    ...i18nField('intensity', 'exerciseIntensity', { nullable: true }),
    advancedTechniques: advancedTechniquesResponseSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const trainingWithExercisesResponseSchema = {
  type: 'object',
  properties: {
    ...trainingResponseSchema.properties,
    exercises: {
      type: 'array',
      items: importedExerciseResponseSchema,
    },
  },
};

export const importTrainingFromTemplateSchema = {
  tags: ['Trainings - Trainer'],
  summary: 'Create training from template',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['protocolId', 'templateId'],
    properties: {
      protocolId: { type: 'string', format: 'uuid' },
      templateId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string' },
      weekDay: { type: ['string', 'null'], enum: [...weekDayValues, null] },
      order: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    201: trainingWithExercisesResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
