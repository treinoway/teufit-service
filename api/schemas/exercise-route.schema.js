import { exerciseTypeValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const exerciseResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainingId: { type: 'string', format: 'uuid' },
    exerciseTemplateId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' },
    type: { type: 'string' },
    videoUrl: { type: 'string', nullable: true },
    order: { type: 'integer' },
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
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const createExerciseSchema = {
  tags: ['Exercises - Trainer'],
  summary: 'Create exercise',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['trainingId'],
    properties: { trainingId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['name', 'type'],
    properties: {
      name: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: exerciseTypeValues },
      videoUrl: { type: 'string' },
      order: { type: 'integer', minimum: 0 },
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
    },
    additionalProperties: false,
  },
  response: {
    201: exerciseResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const createExerciseFromTemplateSchema = {
  tags: ['Exercises - Trainer'],
  summary: 'Create exercise from template',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['trainingId', 'templateId'],
    properties: {
      trainingId: { type: 'string', format: 'uuid' },
      templateId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      type: { type: 'string', enum: exerciseTypeValues },
      videoUrl: { type: 'string' },
      order: { type: 'integer', minimum: 0 },
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
    },
    additionalProperties: false,
  },
  response: {
    201: exerciseResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getExercisesSchema = {
  tags: ['Exercises'],
  summary: 'Get exercises by training',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['trainingId'],
    properties: { trainingId: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'array',
      items: exerciseResponseSchema,
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getExerciseByIdSchema = {
  tags: ['Exercises'],
  summary: 'Get exercise by ID',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: exerciseResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateExerciseSchema = {
  tags: ['Exercises - Trainer'],
  summary: 'Update exercise',
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
      order: { type: 'integer', minimum: 0 },
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
    },
    additionalProperties: false,
  },
  response: {
    200: exerciseResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteExerciseSchema = {
  tags: ['Exercises - Trainer'],
  summary: 'Delete exercise',
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
