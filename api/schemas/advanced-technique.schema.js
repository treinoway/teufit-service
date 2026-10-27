import { AdvancedTechniqueLimits } from '../../src/constants/advanced-technique.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { gifUrlRequestSchema, gifUrlResponseSchema } from './gif-url.schema.js';

const NON_BLANK_PATTERN = '\\S';

// Request: ordered technique ids attached to an exercise / template (max 5, unique).
export const advancedTechniqueIdsRequestSchema = {
  type: 'array',
  items: { type: 'string', format: 'uuid' },
  maxItems: AdvancedTechniqueLimits.MAX_PER_EXERCISE,
  uniqueItems: true,
};

// Response: technique reference nested in exercise-like responses.
export const advancedTechniqueRefSchema = {
  type: 'object',
  required: ['isDeleted'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    key: { type: 'string', nullable: true },
    name: { type: 'string' },
    description: { type: 'string' },
    videoUrl: { type: 'string', nullable: true },
    gifUrl: gifUrlResponseSchema,
    isDeleted: { type: 'boolean' },
    order: { type: 'integer' },
  },
};

export const advancedTechniquesResponseSchema = {
  type: 'array',
  items: advancedTechniqueRefSchema,
};

const techniqueItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    key: { type: 'string', nullable: true },
    name: { type: 'string' },
    description: { type: 'string' },
    videoUrl: { type: 'string', nullable: true },
    gifUrl: gifUrlResponseSchema,
    isSystem: { type: 'boolean' },
    trainerId: { type: 'string', format: 'uuid', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

const nameProperty = {
  type: 'string',
  minLength: 1,
  maxLength: AdvancedTechniqueLimits.NAME_MAX_LENGTH,
  pattern: NON_BLANK_PATTERN,
};

const descriptionProperty = {
  type: 'string',
  minLength: 1,
  maxLength: AdvancedTechniqueLimits.DESCRIPTION_MAX_LENGTH,
  pattern: NON_BLANK_PATTERN,
};

const baseErrors = {
  401: errorResponseSchema,
  403: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
};

export const listAdvancedTechniquesSchema = {
  tags: ['Advanced Techniques - Trainer'],
  summary: 'List system + own advanced techniques',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      q: { type: 'string' },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: AdvancedTechniqueLimits.MAX_PAGE_SIZE },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: techniqueItemSchema },
        total: { type: 'integer' },
        page: { type: 'integer' },
        limit: { type: 'integer' },
      },
    },
    400: badRequestErrorResponseSchema,
    ...baseErrors,
  },
};

export const getAdvancedTechniqueSchema = {
  tags: ['Advanced Techniques - Trainer'],
  summary: 'Get an advanced technique',
  security: [{ bearerAuth: [] }],
  params: idParams,
  response: { 200: techniqueItemSchema, 400: badRequestErrorResponseSchema, 404: errorResponseSchema, ...baseErrors },
};

export const createAdvancedTechniqueSchema = {
  tags: ['Advanced Techniques - Trainer'],
  summary: 'Create an advanced technique',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['name', 'description'],
    properties: {
      name: nameProperty,
      description: descriptionProperty,
      videoUrl: { type: ['string', 'null'] },
      gifUrl: gifUrlRequestSchema,
    },
    additionalProperties: false,
  },
  response: { 201: techniqueItemSchema, 400: badRequestErrorResponseSchema, ...baseErrors },
};

export const updateAdvancedTechniqueSchema = {
  tags: ['Advanced Techniques - Trainer'],
  summary: 'Update an own advanced technique',
  security: [{ bearerAuth: [] }],
  params: idParams,
  body: {
    type: 'object',
    properties: {
      name: nameProperty,
      description: descriptionProperty,
      videoUrl: { type: ['string', 'null'] },
      gifUrl: gifUrlRequestSchema,
    },
    additionalProperties: false,
  },
  response: { 200: techniqueItemSchema, 400: badRequestErrorResponseSchema, 404: errorResponseSchema, ...baseErrors },
};

export const deleteAdvancedTechniqueSchema = {
  tags: ['Advanced Techniques - Trainer'],
  summary: 'Soft-delete an own advanced technique',
  security: [{ bearerAuth: [] }],
  params: idParams,
  response: { 200: techniqueItemSchema, 400: badRequestErrorResponseSchema, 404: errorResponseSchema, ...baseErrors },
};
