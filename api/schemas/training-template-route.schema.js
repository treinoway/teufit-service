import { trainingCategoryValues, bodySegmentValues } from '../../src/constants/training.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const templateResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    category: { type: 'string' },
    bodySegment: { type: 'string', nullable: true },
    tags: { type: 'array', items: { type: 'string' } },
    isPublic: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const templateWithTrainerSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    category: { type: 'string' },
    bodySegment: { type: 'string', nullable: true },
    tags: { type: 'array', items: { type: 'string' } },
    isPublic: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
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
  response: {
    200: {
      type: 'array',
      items: templateWithTrainerSchema,
    },
    401: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
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
