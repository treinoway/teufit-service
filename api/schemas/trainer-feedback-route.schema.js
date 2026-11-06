import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_PAGE_PATH_MAX_LENGTH,
  FEEDBACK_VIEWPORT_MAX_LENGTH,
  FEEDBACK_DEFAULT_PAGE,
  FEEDBACK_DEFAULT_PAGE_SIZE,
  FEEDBACK_MAX_PAGE_SIZE,
} from '../../src/constants/feedback.js';

const categoryValues = Object.values(FEEDBACK_CATEGORIES);
const statusValues = Object.values(FEEDBACK_STATUSES);
const NON_BLANK_PATTERN = '\\S';

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: { type: 'string', description: 'Bearer access token' },
  },
};

const feedbackItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    ...i18nField('category', 'feedbackCategory'),
    message: { type: 'string' },
    pagePath: { type: 'string', nullable: true },
    viewport: { type: 'string', nullable: true },
    userAgent: { type: 'string', nullable: true },
    status: { type: 'string', enum: statusValues },
    createdAt: { type: 'string', format: 'date-time' },
    readAt: { type: 'string', format: 'date-time', nullable: true },
    trainer: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        email: { type: 'string', nullable: true },
        tier: { type: 'string' },
      },
    },
  },
};

export const createFeedbackSchema = {
  tags: ['feedback'],
  summary: 'Send beta feedback (trainer)',
  description: 'Rate limited: 10 requests/hour.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['category', 'message'],
    additionalProperties: false,
    propertyNames: { enum: ['category', 'message', 'pagePath', 'viewport'] },
    properties: {
      category: { type: 'string', enum: categoryValues },
      message: { type: 'string', minLength: 1, maxLength: FEEDBACK_MESSAGE_MAX_LENGTH, pattern: NON_BLANK_PATTERN },
      pagePath: { type: 'string', maxLength: FEEDBACK_PAGE_PATH_MAX_LENGTH },
      viewport: { type: 'string', maxLength: FEEDBACK_VIEWPORT_MAX_LENGTH },
    },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
  },
};

export const listFeedbacksSchema = {
  tags: ['feedback'],
  summary: 'List trainer feedback (admin)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: statusValues },
      category: { type: 'string', enum: categoryValues },
      page: { type: 'integer', minimum: 1, default: FEEDBACK_DEFAULT_PAGE },
      pageSize: { type: 'integer', minimum: 1, maximum: FEEDBACK_MAX_PAGE_SIZE, default: FEEDBACK_DEFAULT_PAGE_SIZE },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        items: { type: 'array', items: feedbackItemSchema },
        total: { type: 'integer' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
  },
};

export const updateFeedbackStatusSchema = {
  tags: ['feedback'],
  summary: 'Mark trainer feedback as read or new (admin)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['status'],
    additionalProperties: false,
    properties: { status: { type: 'string', enum: statusValues } },
  },
  response: {
    200: feedbackItemSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};
