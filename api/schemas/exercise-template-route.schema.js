import { exerciseTypeValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
import { gifUrlRequestSchema, gifUrlResponseSchema } from './gif-url.schema.js';
import { advancedTechniqueIdsRequestSchema, advancedTechniquesResponseSchema } from './advanced-technique.schema.js';
import { videoFileKeyRequestSchema, videoFileResponseProperties } from './exercise-video.schema.js';

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
    ...videoFileResponseProperties,
    gifUrl: gifUrlResponseSchema,
    isPublic: { type: 'boolean' },
    advancedTechniques: advancedTechniquesResponseSchema,
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
      videoFileKey: videoFileKeyRequestSchema,
      gifUrl: gifUrlRequestSchema,
      isPublic: { type: 'boolean' },
      advancedTechniqueIds: advancedTechniqueIdsRequestSchema,
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
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      q: { type: 'string' },
      type: { type: 'string', enum: exerciseTypeValues },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: exerciseTemplateResponseSchema },
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

export const batchDeleteExerciseTemplatesSchema = {
  tags: ['Exercise Templates'],
  summary: 'Batch delete exercise templates',
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
      videoFileKey: videoFileKeyRequestSchema,
      gifUrl: gifUrlRequestSchema,
      isPublic: { type: 'boolean' },
      advancedTechniqueIds: advancedTechniqueIdsRequestSchema,
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
