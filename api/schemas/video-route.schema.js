import {
  trainingCategoryValues,
  bodySegmentValues,
} from '../../src/constants/training.js';
import {
  errorResponseSchema,
  badRequestErrorResponseSchema,
} from './error-response.schema.js';
import { videoSchema } from './admin-video-route.schema.js';
import { VIDEO_LIST_PAGE_SIZE_MAX } from '../../src/constants/video.js';

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

export const listVideosSchema = {
  tags: ['Videos'],
  summary: 'List/search videos in the public library',
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

export const getVideoSchema = {
  tags: ['Videos'],
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
