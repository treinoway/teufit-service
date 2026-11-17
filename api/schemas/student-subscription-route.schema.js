import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import {
  subscriptionStatusValues,
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

const paymentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    subscriptionId: { type: 'string', format: 'uuid' },
    cycleStartDate: { type: 'string', format: 'date' },
    cycleEndDate: { type: 'string', format: 'date' },
    dueDate: { type: 'string', format: 'date' },
    amount: moneyString,
    cycleIndex: { type: 'integer' },
    status: { type: 'string' },
    effectiveStatus: { type: 'string' },
    daysOverdue: { type: 'integer' },
    paidAt: { type: 'string', format: 'date-time', nullable: true },
    voidedAt: { type: 'string', format: 'date-time', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const subscriptionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    ...i18nField('serviceType', 'subscriptionServiceType'),
    studentId: { type: 'string', format: 'uuid' },
    planId: { type: 'string', format: 'uuid' },
    ...i18nField('recurrence', 'subscriptionRecurrence'),
    price: moneyString,
    discountPercent: moneyStringNullable,
    discountAmount: moneyStringNullable,
    billingDay: { type: 'integer', description: 'Effective day of month charges fall due (1-31)' },
    startDate: { type: 'string', format: 'date' },
    ...i18nField('status', 'subscriptionStatus'),
    cancelledAt: { type: 'string', format: 'date-time', nullable: true },
    cancellationReason: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const subscriptionWithFirstPaymentSchema = {
  type: 'object',
  properties: {
    ...subscriptionSchema.properties,
    firstPayment: paymentSchema,
  },
};

// ─── Route schemas ─────────────────────────────────────────────────────────────

export const assignPlanSchema = {
  tags: ['student-subscriptions'],
  summary: 'Assign a subscription plan to a student',
  description:
    'Creates the subscription and its first payment cycle. 409 SUBSCRIPTION_ALREADY_ACTIVE when the student ' +
    'already has an active subscription.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['studentId'],
    properties: {
      studentId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['planId', 'startDate'],
    additionalProperties: false,
    properties: {
      planId: { type: 'string', format: 'uuid' },
      startDate: { type: 'string', format: 'date' },
      discountPercent: { type: 'number', minimum: 0, maximum: 100, nullable: true },
      discountAmount: { type: 'number', minimum: 0, maximum: MAX_MONEY_AMOUNT, nullable: true },
      billingDay: { type: 'integer', minimum: 1, maximum: 31, nullable: true, description: 'Overrides the plan billing day' },
    },
  },
  response: {
    201: subscriptionWithFirstPaymentSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const listSubscriptionsByStudentSchema = {
  tags: ['student-subscriptions'],
  summary: 'List all subscriptions for a student',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['studentId'],
    properties: {
      studentId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: { type: 'array', items: subscriptionSchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
  },
};

export const getActiveSubscriptionByStudentSchema = {
  tags: ['student-subscriptions'],
  summary: 'Get the active subscription for a student',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['studentId'],
    properties: {
      studentId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      oneOf: [
        subscriptionSchema,
        { type: 'null' },
      ],
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
  },
};

export const listSubscriptionsSchema = {
  tags: ['student-subscriptions'],
  summary: 'List subscriptions across all students (trainer dashboard)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: subscriptionStatusValues, nullable: true },
      planId: { type: 'string', format: 'uuid', nullable: true },
    },
  },
  response: {
    200: { type: 'array', items: subscriptionSchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
  },
};

export const getSubscriptionByIdSchema = {
  tags: ['student-subscriptions'],
  summary: 'Get a subscription by ID',
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
    200: subscriptionSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};

export const cancelSubscriptionSchema = {
  tags: ['student-subscriptions'],
  summary: 'Cancel a subscription',
  description:
    'Voids (status cancelled) pending payments that are not yet due; due/overdue pending payments are kept ' +
    'for collection and paid payments are untouched.',
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
    200: subscriptionSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};
