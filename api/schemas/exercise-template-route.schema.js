import { exerciseTypeValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

// Library exercise templates carry only the exercise identity. Prescription
// ("how it's done") lives on the TrainingTemplateExerciseTemplate junction and the Exercise.
const exerciseTemplateResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    ...i18nField('type', 'exerciseType'),
    videoUrl: { type: 'string', nullable: true },
    isPublic: { type: 'boolean' },
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
      videoUrl: { type: 'string' },
      isPublic: { type: 'boolean' },
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
      videoUrl: { type: 'string' },
      isPublic: { type: 'boolean' },
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
