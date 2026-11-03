import { trainingCategoryValues, bodySegmentValues, exerciseTypeValues, prescriptionModeValues, exerciseIntensityValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
import { gifUrlRequestSchema, gifUrlResponseSchema } from './gif-url.schema.js';
import { advancedTechniqueIdsRequestSchema, advancedTechniquesResponseSchema } from './advanced-technique.schema.js';
import { videoFileKeyRequestSchema, videoFileResponseProperties } from './exercise-video.schema.js';

// The linked library template carries only the exercise identity. Prescription lives on
// the junction (trainingTemplateExerciseTemplateSchema), not here.
const exerciseTemplateRefSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    type: { type: 'string' },
    videoUrl: { type: 'string', nullable: true },
    ...videoFileResponseProperties,
    gifUrl: gifUrlResponseSchema,
    isPublic: { type: 'boolean' },
  },
};

const trainingTemplateExerciseTemplateSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainingTemplateId: { type: 'string', format: 'uuid' },
    exerciseTemplateId: { type: 'string', format: 'uuid' },
    order: { type: 'integer' },
    // Bi-set / superset grouping fields (C3)
    supersetGroupId: { type: 'string', format: 'uuid', nullable: true },
    supersetOrder: { type: 'integer' },
    supersetRestInterval: { type: 'integer', nullable: true },
    // Snapshot fields — independent copy of the exercise at link time
    name: { type: 'string' },
    type: { type: 'string' },
    videoUrl: { type: 'string', nullable: true },
    ...videoFileResponseProperties,
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
    intensity: { type: 'string', nullable: true },
    advancedTechniques: advancedTechniquesResponseSchema,
    exerciseTemplate: exerciseTemplateRefSchema,
  },
};

const templateResponseSchema = {
  type: 'object',
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
};

const templateWithTrainerSchema = {
  type: 'object',
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
    trainer: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            firstName: { type: 'string', nullable: true },
            lastName: { type: 'string', nullable: true },
          },
        },
      },
    },
  },
};

export const createTrainingTemplateSchema = {
  tags: ['Training Templates'],
  summary: 'Create a training template',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['name', 'category'],
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      category: { type: 'string', enum: trainingCategoryValues },
      bodySegment: { type: 'string', enum: bodySegmentValues },
      tags: { type: 'array', items: { type: 'string' } },
      isPublic: { type: 'boolean' },
      exerciseTemplateIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Optional list of exercise template UUIDs (order = array index)',
      },
      exerciseTemplates: {
        type: 'array',
        items: {
          type: 'object',
          required: ['exerciseTemplateId'],
          properties: {
            exerciseTemplateId: { type: 'string', format: 'uuid' },
            order: { type: 'integer' },
            // Bi-set / superset grouping (C3)
            supersetGroupId: { type: 'string', format: 'uuid', nullable: true },
            supersetOrder: { type: 'integer', minimum: 0 },
            supersetRestInterval: { type: 'integer', nullable: true, minimum: 0 },
            name: { type: 'string' },
            type: { type: 'string' },
            videoUrl: { type: 'string', nullable: true },
            videoFileKey: videoFileKeyRequestSchema,
            gifUrl: gifUrlRequestSchema,
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
            intensity: { type: ['string', 'null'], enum: [...exerciseIntensityValues, null] },
            advancedTechniqueIds: advancedTechniqueIdsRequestSchema,
          },
          additionalProperties: false,
        },
        description: 'Optional list of { exerciseTemplateId, order?, supersetGroupId?, supersetOrder?, ...prescription }; alternative to exerciseTemplateIds',
      },
    },
    additionalProperties: false,
  },
  response: {
    201: templateResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getTrainingTemplatesSchema = {
  tags: ['Training Templates'],
  summary: 'Get training templates',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      q: { type: 'string' },
      category: { type: 'string', enum: trainingCategoryValues },
      bodySegment: { type: 'string', enum: bodySegmentValues },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: templateWithTrainerSchema },
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

export const batchDeleteTrainingTemplatesSchema = {
  tags: ['Training Templates'],
  summary: 'Batch delete training templates',
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

export const getPublicTemplatesSchema = {
  tags: ['Training Templates'],
  summary: 'Get public training templates',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'array',
      items: templateWithTrainerSchema,
    },
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getTrainingTemplateByIdSchema = {
  tags: ['Training Templates'],
  summary: 'Get training template by ID',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: templateWithTrainerSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateTrainingTemplateSchema = {
  tags: ['Training Templates'],
  summary: 'Update training template',
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
      tags: { type: 'array', items: { type: 'string' } },
      isPublic: { type: 'boolean' },
      exerciseTemplateIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
      exerciseTemplates: {
        type: 'array',
        items: {
          type: 'object',
          required: ['exerciseTemplateId'],
          properties: {
            exerciseTemplateId: { type: 'string', format: 'uuid' },
            order: { type: 'integer' },
            // Bi-set / superset grouping (C3)
            supersetGroupId: { type: 'string', format: 'uuid', nullable: true },
            supersetOrder: { type: 'integer', minimum: 0 },
            supersetRestInterval: { type: 'integer', nullable: true, minimum: 0 },
            name: { type: 'string' },
            type: { type: 'string' },
            videoUrl: { type: 'string', nullable: true },
            videoFileKey: videoFileKeyRequestSchema,
            gifUrl: gifUrlRequestSchema,
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
            advancedTechniqueIds: advancedTechniqueIdsRequestSchema,
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  response: {
    200: templateResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteTrainingTemplateSchema = {
  tags: ['Training Templates'],
  summary: 'Delete training template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: templateResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const createTrainingTemplateExerciseSchema = {
  tags: ['Training Templates'],
  summary: 'Create an ad-hoc exercise and attach it to a training template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['templateId'],
    properties: {
      templateId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['name', 'type'],
    properties: {
      name: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: exerciseTypeValues },
      prescriptionMode: { type: 'string', enum: prescriptionModeValues },
      videoUrl: { type: 'string', nullable: true },
      videoFileKey: videoFileKeyRequestSchema,
      gifUrl: gifUrlRequestSchema,
      isPublic: { type: 'boolean' },
      // Bi-set / superset grouping (C3)
      supersetGroupId: { type: 'string', format: 'uuid', nullable: true },
      supersetOrder: { type: 'integer', minimum: 0 },
      supersetRestInterval: { type: 'integer', nullable: true, minimum: 0 },
      sets: { type: 'integer', nullable: true, minimum: 1 },
      repetitions: {
        type: 'object',
        nullable: true,
        properties: {
          min: { type: 'integer', minimum: 1 },
          max: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
      duration: { type: 'integer', nullable: true, minimum: 1 },
      hasLoad: { type: 'boolean' },
      suggestedLoad: { type: 'number', nullable: true, minimum: 0 },
      restInterval: { type: 'integer', nullable: true, minimum: 0 },
      notes: { type: 'string', nullable: true },
      intensity: { type: ['string', 'null'], enum: [...exerciseIntensityValues, null] },
      advancedTechniqueIds: advancedTechniqueIdsRequestSchema,
      order: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  response: {
    201: trainingTemplateExerciseTemplateSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const createTrainingTemplateExerciseFromTemplateSchema = {
  tags: ['Training Templates'],
  summary: 'Attach an existing exercise template to a training template (junction row only)',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['templateId'],
    properties: {
      templateId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['exerciseTemplateId'],
    properties: {
      exerciseTemplateId: { type: 'string', format: 'uuid' },
      order: { type: 'integer', minimum: 0 },
      // Bi-set / superset grouping (C3)
      supersetGroupId: { type: 'string', format: 'uuid', nullable: true },
      supersetOrder: { type: 'integer', minimum: 0 },
      supersetRestInterval: { type: 'integer', nullable: true, minimum: 0 },
      // Prescription set by the trainer at link time — the library template carries none.
      prescriptionMode: { type: 'string', enum: prescriptionModeValues },
      sets: { type: 'integer', nullable: true, minimum: 1 },
      repetitions: {
        type: 'object',
        nullable: true,
        properties: {
          min: { type: 'integer', minimum: 1 },
          max: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
      duration: { type: 'integer', nullable: true, minimum: 1 },
      hasLoad: { type: 'boolean' },
      suggestedLoad: { type: 'number', nullable: true, minimum: 0 },
      restInterval: { type: 'integer', nullable: true, minimum: 0 },
      notes: { type: 'string', nullable: true },
      intensity: { type: ['string', 'null'], enum: [...exerciseIntensityValues, null] },
      advancedTechniqueIds: advancedTechniqueIdsRequestSchema,
    },
    additionalProperties: false,
  },
  response: {
    201: trainingTemplateExerciseTemplateSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteTrainingTemplateExerciseSchema = {
  tags: ['Training Templates'],
  summary: 'Remove an exercise (junction row) from a training template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['templateId', 'exerciseId'],
    properties: {
      templateId: { type: 'string', format: 'uuid' },
      exerciseId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: trainingTemplateExerciseTemplateSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateTrainingTemplateExerciseSchema = {
  tags: ['Training Templates'],
  summary: 'Update a single exercise (junction row) inside a training template',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['templateId', 'exerciseId'],
    properties: {
      templateId: { type: 'string', format: 'uuid' },
      exerciseId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 1 },
      type: { type: 'string' },
      prescriptionMode: { type: 'string', enum: prescriptionModeValues },
      videoUrl: { type: 'string', nullable: true },
      videoFileKey: videoFileKeyRequestSchema,
      gifUrl: gifUrlRequestSchema,
      // Bi-set / superset grouping (C3)
      supersetGroupId: { type: 'string', format: 'uuid', nullable: true },
      supersetOrder: { type: 'integer', minimum: 0 },
      supersetRestInterval: { type: 'integer', nullable: true, minimum: 0 },
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
      intensity: { type: ['string', 'null'], enum: [...exerciseIntensityValues, null] },
      advancedTechniqueIds: advancedTechniqueIdsRequestSchema,
      order: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  response: {
    200: trainingTemplateExerciseTemplateSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
