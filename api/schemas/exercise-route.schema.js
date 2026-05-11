import { exerciseTypeValues, prescriptionModeValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const exerciseBaseProperties = {
  id: { type: 'string', format: 'uuid' },
  trainingId: { type: 'string', format: 'uuid' },
  exerciseTemplateId: { type: 'string', format: 'uuid', nullable: true },
  name: { type: 'string' },
  ...i18nField('type', 'exerciseType'),
  videoUrl: { type: 'string', nullable: true },
  order: { type: 'integer' },
  supersetGroupId: { type: 'string', format: 'uuid', nullable: true },
  supersetOrder: { type: 'integer' },
  substituteForExerciseId: { type: 'string', format: 'uuid', nullable: true },
  substituteOrder: { type: 'integer' },
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
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time', nullable: true },
};

// Substitute exercise has the same shape but will never have a substitutes[] array
const substituteExerciseResponseSchema = {
  type: 'object',
  properties: exerciseBaseProperties,
};

const exerciseResponseSchema = {
  type: 'object',
  properties: {
    ...exerciseBaseProperties,
    substitutes: {
      type: 'array',
      items: substituteExerciseResponseSchema,
    },
  },
};

const exerciseBodyProperties = {
  name: { type: 'string', minLength: 1 },
  type: { type: 'string', enum: exerciseTypeValues },
  prescriptionMode: { type: 'string', enum: prescriptionModeValues },
  videoUrl: { type: 'string' },
  order: { type: 'integer', minimum: 0 },
  supersetGroupId: { type: 'string', format: 'uuid' },
  supersetOrder: { type: 'integer', minimum: 0 },
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
    properties: exerciseBodyProperties,
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
      ...exerciseBodyProperties,
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
  summary: 'Get exercises by training (principals with nested substitutes)',
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

const exerciseUpdateBodyProperties = {
  name: { type: 'string', minLength: 1 },
  type: { type: 'string', enum: exerciseTypeValues },
  prescriptionMode: { type: 'string', enum: prescriptionModeValues },
  videoUrl: { type: 'string' },
  order: { type: 'integer', minimum: 0 },
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
    properties: exerciseUpdateBodyProperties,
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

// Substitute-specific body: excludes superset fields and order (C5)
// Substitutes cannot belong to supersets or carry an explicit principal order.
const substituteBodyProperties = {
  name: exerciseBodyProperties.name,
  type: exerciseBodyProperties.type,
  prescriptionMode: exerciseBodyProperties.prescriptionMode,
  videoUrl: exerciseBodyProperties.videoUrl,
  sets: exerciseBodyProperties.sets,
  repetitions: exerciseBodyProperties.repetitions,
  duration: exerciseBodyProperties.duration,
  hasLoad: exerciseBodyProperties.hasLoad,
  suggestedLoad: exerciseBodyProperties.suggestedLoad,
  restInterval: exerciseBodyProperties.restInterval,
  notes: exerciseBodyProperties.notes,
};

export const addSubstituteSchema = {
  tags: ['Exercises - Trainer'],
  summary: 'Add a substitute exercise under a principal',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['name', 'type'],
    properties: substituteBodyProperties,
    additionalProperties: false,
  },
  response: {
    201: substituteExerciseResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const reorderSubstitutesSchema = {
  tags: ['Exercises - Trainer'],
  summary: 'Reorder substitutes for a principal exercise',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['substituteIds'],
    properties: {
      substituteIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          substituteOrder: { type: 'integer' },
        },
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

export const reorderSupersetMembersSchema = {
  tags: ['Exercises - Trainer'],
  summary: 'Reorder exercises within a superset group',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['trainingId', 'groupId'],
    properties: {
      trainingId: { type: 'string', format: 'uuid' },
      groupId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['exerciseIds'],
    properties: {
      exerciseIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 2,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          supersetOrder: { type: 'integer' },
        },
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
