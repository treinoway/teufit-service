import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import {
  subscriptionRecurrenceValues,
  MAX_MONEY_AMOUNT,
} from '../../src/constants/subscription.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: { type: 'string', description: 'Bearer access token' },
  },
};

// ─── Shared shapes ─────────────────────────────────────────────────────────────

const moneyString = { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' };
const moneyStringNullable = { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', nullable: true };

const subscriptionPlanSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    ...i18nField('recurrence', 'subscriptionRecurrence'),
    price: moneyString,
    discountPercent: moneyStringNullable,
    discountAmount: moneyStringNullable,
    isArchived: { type: 'boolean' },
    activeSubscriptionCount: { type: 'integer', description: 'Active subscriptions on this plan (list endpoint only)' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

// ─── Route schemas ─────────────────────────────────────────────────────────────

export const createPlanSchema = {
  tags: ['subscription-plans'],
  summary: 'Create a subscription plan',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['name', 'recurrence', 'price'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 500, nullable: true },
      recurrence: { type: 'string', enum: subscriptionRecurrenceValues },
      price: { type: 'number', exclusiveMinimum: 0, maximum: MAX_MONEY_AMOUNT },
      discountPercent: { type: 'number', minimum: 0, maximum: 100, nullable: true },
      discountAmount: { type: 'number', minimum: 0, maximum: MAX_MONEY_AMOUNT, nullable: true },
    },
  },
  response: {
    201: subscriptionPlanSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
  },
};

export const listPlansSchema = {
  tags: ['subscription-plans'],
  summary: 'List subscription plans',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      includeArchived: { type: 'boolean', default: false },
    },
  },
  response: {
    200: {
      type: 'array',
      items: subscriptionPlanSchema,
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
  },
};

export const getPlanByIdSchema = {
  tags: ['subscription-plans'],
  summary: 'Get a subscription plan by ID',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: subscriptionPlanSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const updatePlanSchema = {
  tags: ['subscription-plans'],
  summary: 'Update a subscription plan',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 500, nullable: true },
      recurrence: { type: 'string', enum: subscriptionRecurrenceValues },
      price: { type: 'number', exclusiveMinimum: 0, maximum: MAX_MONEY_AMOUNT },
      discountPercent: { type: 'number', minimum: 0, maximum: 100, nullable: true },
      discountAmount: { type: 'number', minimum: 0, maximum: MAX_MONEY_AMOUNT, nullable: true },
    },
  },
  response: {
    200: subscriptionPlanSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const archivePlanSchema = {
  tags: ['subscription-plans'],
  summary: 'Archive a subscription plan (soft delete)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: subscriptionPlanSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const unarchivePlanSchema = {
  tags: ['subscription-plans'],
  summary: 'Unarchive a subscription plan',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: subscriptionPlanSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};
