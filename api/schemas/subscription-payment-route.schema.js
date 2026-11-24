import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import { MAX_MONEY_AMOUNT } from '../../src/constants/subscription.js';
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
    cycleIndex: { type: 'integer' },
    ...i18nField('status', 'paymentStatus'),
    // Derived: pending past the grace window is reported as `overdue`.
    ...i18nField('effectiveStatus', 'paymentStatus'),
    daysOverdue: { type: 'integer', description: 'Days past dueDate; 0 unless effectiveStatus is overdue' },
    paidAt: { type: 'string', format: 'date-time', nullable: true },
    voidedAt: { type: 'string', format: 'date-time', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

// ─── Route schemas ─────────────────────────────────────────────────────────────

export const createPaymentSchema = {
  tags: ['subscription-payments'],
  summary: 'Generate the next billing cycle of a subscription',
  description:
    'Cycle dates are derived from the subscription anchor and cannot be chosen. ' +
    'Optional body: dueDate (defaults to cycleStartDate) and notes. Available once the next cycle is within ' +
    'the generation lead window (409 SUBSCRIPTION_CYCLE_NOT_DUE otherwise); 409 SUBSCRIPTION_CANCELLED ' +
    'when the subscription is cancelled.',
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
    additionalProperties: false,
    properties: {
      // Explicitly rejected (400): Fastify's Ajv strips unknown properties, which
      // would silently ignore a legacy client-chosen cycle date.
      cycleStartDate: { not: {}, description: 'No longer accepted — cycle dates come from the subscription anchor' },
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
    409: errorResponseSchema,
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
  description:
    'amount/dueDate of a paid payment cannot change (409 SUBSCRIPTION_PAYMENT_ALREADY_PAID); notes can. ' +
    'Cancelled payments cannot be edited (409). Invalid amount returns 400 SUBSCRIPTION_INVALID_AMOUNT.',
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
      amount: { type: 'number', exclusiveMinimum: 0, maximum: MAX_MONEY_AMOUNT, nullable: true },
      notes: { type: 'string', maxLength: 500, nullable: true },
    },
  },
  response: {
    200: paymentSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const markPaymentPaidSchema = {
  tags: ['subscription-payments'],
  summary: 'Mark a payment as paid',
  description:
    'Optional paidAt (date-only, not in the future, business timezone) registers money received earlier. ' +
    'Voided (cancelled) payments can be paid (late settlement).',
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
    nullable: true,
    properties: {
      paidAt: { type: 'string', format: 'date' },
    },
  },
  response: {
    200: paymentSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const markPaymentPendingSchema = {
  tags: ['subscription-payments'],
  summary: 'Mark a payment as pending (undo paid); voided payments cannot be reopened (409)',
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
    409: errorResponseSchema,
  },
};

export const deletePaymentSchema = {
  tags: ['subscription-payments'],
  summary: 'Void a payment (alias of POST /trainer/payments/:id/void)',
  description: 'Soft void: a pending payment becomes cancelled; a paid payment returns 409.',
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
    204: { type: 'null', description: 'Payment voided' },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  },
};

export const voidPaymentSchema = {
  tags: ['subscription-payments'],
  summary: 'Void a pending payment',
  description:
    'Soft void: status becomes cancelled (the cycle generator will not recreate it). ' +
    'Paid payments return 409 SUBSCRIPTION_PAYMENT_ALREADY_PAID. Idempotent for already voided payments.',
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
    409: errorResponseSchema,
  },
};

export const listPaymentsByStudentSchema = {
  tags: ['subscription-payments'],
  summary: 'List every payment of a student (all subscriptions) with a summary',
  description:
    'Scoped by trainer only — history stays available after the student is unlinked. Single query.',
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
      type: 'object',
      properties: {
        student: {
          type: 'object',
          nullable: true,
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            avatarUrl: { type: 'string', nullable: true },
          },
        },
        summary: {
          type: 'object',
          properties: {
            totalReceived: moneyString,
            receivedCount: { type: 'integer' },
            customerSince: { type: 'string', format: 'date', nullable: true },
          },
        },
        payments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ...paymentSchema.properties,
              ...i18nField('subscriptionStatus', 'subscriptionStatus'),
              ...i18nField('serviceType', 'subscriptionServiceType'),
              plan: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  ...i18nField('recurrence', 'subscriptionRecurrence'),
                },
              },
            },
          },
        },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};
