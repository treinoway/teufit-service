import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
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

const paymentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    subscriptionId: { type: 'string', format: 'uuid' },
    cycleStartDate: { type: 'string', format: 'date' },
    cycleEndDate: { type: 'string', format: 'date' },
    dueDate: { type: 'string', format: 'date' },
    amount: moneyString,
    ...i18nField('status', 'paymentStatus'),
    paidAt: { type: 'string', format: 'date-time', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

// ─── Route schemas ─────────────────────────────────────────────────────────────

export const createPaymentSchema = {
  tags: ['subscription-payments'],
  summary: 'Create a payment cycle for a subscription',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['subscriptionId'],
    properties: {
      subscriptionId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['cycleStartDate'],
    additionalProperties: false,
    properties: {
      cycleStartDate: { type: 'string', format: 'date' },
      dueDate: { type: 'string', format: 'date', nullable: true },
      notes: { type: 'string', maxLength: 500, nullable: true },
    },
  },
  response: {
    201: paymentSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const listPaymentsBySubscriptionSchema = {
  tags: ['subscription-payments'],
  summary: 'List payments for a subscription',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['subscriptionId'],
    properties: {
      subscriptionId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: { type: 'array', items: paymentSchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const updatePaymentSchema = {
  tags: ['subscription-payments'],
  summary: 'Update payment fields (dueDate, amount, notes)',
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
      dueDate: { type: 'string', format: 'date', nullable: true },
      amount: { type: 'number', exclusiveMinimum: 0, nullable: true },
      notes: { type: 'string', maxLength: 500, nullable: true },
    },
  },
  response: {
    200: paymentSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const markPaymentPaidSchema = {
  tags: ['subscription-payments'],
  summary: 'Mark a payment as paid',
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
    200: paymentSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const markPaymentPendingSchema = {
  tags: ['subscription-payments'],
  summary: 'Mark a payment as pending (undo paid)',
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
    200: paymentSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const deletePaymentSchema = {
  tags: ['subscription-payments'],
  summary: 'Delete a payment cycle record',
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
    204: { type: 'null', description: 'Payment deleted' },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};
