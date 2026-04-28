import {
  trainingCategoryValues,
  bodySegmentValues,
} from '../../src/constants/training.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
import {
  errorResponseSchema,
  badRequestErrorResponseSchema,
} from './error-response.schema.js';
import {
  VIDEO_TITLE_MAX,
  VIDEO_DESCRIPTION_MAX,
  VIDEO_TAG_MAX,
  VIDEO_TAGS_MAX_COUNT,
  VIDEO_DURATION_MAX,
  VIDEO_LIST_PAGE_SIZE_MAX,
} from '../../src/constants/video.js';

export const videoSchema = {
  type: 'object',
  required: ['id', 'title', 'url', 'category', 'tags', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    url: { type: 'string' },
    thumbnailUrl: { type: 'string', nullable: true },
    duration: { type: 'integer', nullable: true },
    ...i18nField('category', 'trainingCategory'),
    ...i18nField('bodySegment', 'bodySegment', { nullable: true }),
    tags: { type: 'array', items: { type: 'string' } },
    createdById: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
  additionalProperties: false,
};

const paginatedVideosSchema = {
  type: 'object',
  required: ['items', 'total', 'page', 'pageSize'],
  properties: {
    items: { type: 'array', items: videoSchema },
    total: { type: 'integer' },
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
  },
  additionalProperties: false,
};

const videoBodyBase = {
  title: { type: 'string', minLength: 1, maxLength: VIDEO_TITLE_MAX },
  description: { type: 'string', maxLength: VIDEO_DESCRIPTION_MAX, nullable: true },
  url: { type: 'string', format: 'uri' },
  thumbnailUrl: { type: 'string', format: 'uri', nullable: true },
  duration: { type: 'integer', minimum: 0, maximum: VIDEO_DURATION_MAX, nullable: true },
  category: { type: 'string', enum: [...trainingCategoryValues] },
  bodySegment: { type: 'string', enum: [...bodySegmentValues, null], nullable: true },
  tags: {
    type: 'array',
    maxItems: VIDEO_TAGS_MAX_COUNT,
    items: { type: 'string', maxLength: VIDEO_TAG_MAX },
  },
};

const listQuerystring = {
  type: 'object',
  properties: {
    search: { type: 'string' },
    category: { type: 'string', enum: [...trainingCategoryValues] },
    bodySegment: { type: 'string', enum: [...bodySegmentValues] },
    tag: { type: 'string' },
    page: { type: 'integer', minimum: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: VIDEO_LIST_PAGE_SIZE_MAX },
  },
  additionalProperties: false,
};

const idParams = {
  type: 'object',
  required: ['videoId'],
  properties: { videoId: { type: 'string', format: 'uuid' } },
};

export const createVideoSchema = {
  tags: ['Videos - Admin'],
  summary: 'Create a video in the public library',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['title', 'url', 'category'],
    properties: videoBodyBase,
    additionalProperties: false,
  },
  response: {
    201: videoSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listVideosAdminSchema = {
  tags: ['Videos - Admin'],
  summary: 'List/search videos in the public library (admin)',
  security: [{ bearerAuth: [] }],
  querystring: listQuerystring,
  response: {
    200: paginatedVideosSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getVideoAdminSchema = {
  tags: ['Videos - Admin'],
  summary: 'Get a video by id',
  security: [{ bearerAuth: [] }],
  params: idParams,
  response: {
    200: videoSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateVideoSchema = {
  tags: ['Videos - Admin'],
  summary: 'Update a video',
  security: [{ bearerAuth: [] }],
  params: idParams,
  body: {
    type: 'object',
    properties: videoBodyBase,
    additionalProperties: false,
    minProperties: 1,
  },
  response: {
    200: videoSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteVideoSchema = {
  tags: ['Videos - Admin'],
  summary: 'Soft-delete a video',
  security: [{ bearerAuth: [] }],
  params: idParams,
  response: {
    200: {
      type: 'object',
      required: ['id', 'deletedAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        deletedAt: { type: 'string', format: 'date-time' },
      },
      additionalProperties: false,
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
