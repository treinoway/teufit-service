import { exerciseTypeValues, prescriptionModeValues, exerciseIntensityValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const exerciseTemplateResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    ...i18nField('type', 'exerciseType'),
    videoUrl: { type: 'string', nullable: true },
    isPublic: { type: 'boolean' },
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
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const createExerciseTemplateSchema = {
  tags: ['Exercise Templates'],
  summary: 'Create exercise template',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['name', 'type'],
    properties: {
      name: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: exerciseTypeValues },
      prescriptionMode: { type: 'string', enum: prescriptionModeValues },
      videoUrl: { type: 'string' },
      isPublic: { type: 'boolean' },
      sets: { type: 'integer', minimum: 1 },
      repetitions: {
        type: 'object',
        required: ['min', 'max'],
        properties: {
          min: { type: 'integer', minimum: 1 },
          max: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
      duration: { type: 'integer', minimum: 1 },
      hasLoad: { type: 'boolean' },
      suggestedLoad: { type: 'number', minimum: 0 },
      restInterval: { type: 'integer', minimum: 0 },
      notes: { type: 'string' },
      intensity: { type: ['string', 'null'], enum: [...exerciseIntensityValues, null] },
    },
    additionalProperties: false,
  },
  response: {
    201: exerciseTemplateResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getExerciseTemplatesSchema = {
  tags: ['Exercise Templates'],
  summary: 'Get exercise templates',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: exerciseTemplateResponseSchema,
    },
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getPublicExerciseTemplatesSchema = {
  tags: ['Exercise Templates'],
  summary: 'Get public exercise templates',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: exerciseTemplateResponseSchema,
    },
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getExerciseTemplateByIdSchema = {
  tags: ['Exercise Templates'],
  summary: 'Get exercise template by ID',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: exerciseTemplateResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateExerciseTemplateSchema = {
  tags: ['Exercise Templates'],
  summary: 'Update exercise template',
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
      type: { type: 'string', enum: exerciseTypeValues },
      prescriptionMode: { type: 'string', enum: prescriptionModeValues },
      videoUrl: { type: 'string' },
      isPublic: { type: 'boolean' },
      sets: { type: ['integer', 'null'], minimum: 1 },
      repetitions: {
        type: ['object', 'null'],
        properties: {
          min: { type: ['integer', 'null'], minimum: 1 },
          max: { type: ['integer', 'null'], minimum: 1 },
        },
        additionalProperties: false,
      },
      duration: { type: ['integer', 'null'], minimum: 1 },
      hasLoad: { type: 'boolean' },
      suggestedLoad: { type: ['number', 'null'], minimum: 0 },
      restInterval: { type: ['integer', 'null'], minimum: 0 },
      notes: { type: 'string' },
      intensity: { type: ['string', 'null'], enum: [...exerciseIntensityValues, null] },
    },
    additionalProperties: false,
  },
  response: {
    200: exerciseTemplateResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteExerciseTemplateSchema = {
  tags: ['Exercise Templates'],
  summary: 'Delete exercise template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: exerciseTemplateResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
