/**
 * Asaas Webhook Route Schema
 *
 * Validates the incoming webhook body from Asaas.
 * The route returns 200 even on internal errors (to prevent Asaas retry storms).
 * Only structurally invalid bodies return 400.
 */

import { errorResponseSchema } from './error-response.schema.js';

const asaasPaymentShape = {
  type: 'object',
  nullable: true,
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    subscription: { type: 'string', nullable: true },
    value: { type: 'number', nullable: true },
    dueDate: { type: 'string', nullable: true },
    billingType: { type: 'string', nullable: true },
    externalReference: { type: 'string', nullable: true },
    status: { type: 'string', nullable: true },
    invoiceUrl: { type: 'string', nullable: true },
  },
};

const asaasSubscriptionShape = {
  type: 'object',
  nullable: true,
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    externalReference: { type: 'string', nullable: true },
    status: { type: 'string', nullable: true },
    value: { type: 'number', nullable: true },
    cycle: { type: 'string', nullable: true },
  },
};

export const webhookSchema = {
  tags: ['Webhooks'],
  summary: 'Asaas webhook receiver',
  description:
    'Receives payment and subscription lifecycle events from Asaas. ' +
    'Always returns 200 unless the body is structurally invalid.',
  body: {
    type: 'object',
    required: ['event'],
    additionalProperties: true,
    properties: {
      event: {
        type: 'string',
        description: 'Asaas event type',
      },
      payment: asaasPaymentShape,
      subscription: asaasSubscriptionShape,
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        received: { type: 'boolean' },
      },
    },
    400: errorResponseSchema,
    500: errorResponseSchema,
  },
};
