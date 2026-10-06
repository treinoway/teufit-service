import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: { type: 'string', description: 'Bearer access token' },
  },
};

const moneyString = { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' };

const overviewPaymentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    subscriptionId: { type: 'string', format: 'uuid' },
    cycleIndex: { type: 'integer' },
    cycleStartDate: { type: 'string', format: 'date' },
    cycleEndDate: { type: 'string', format: 'date' },
    dueDate: { type: 'string', format: 'date' },
    amount: moneyString,
    ...i18nField('status', 'paymentStatus'),
    ...i18nField('effectiveStatus', 'paymentStatus'),
    daysOverdue: { type: 'integer', description: 'Days past dueDate; 0 unless effectiveStatus is overdue' },
    paidAt: { type: 'string', format: 'date-time', nullable: true },
    voidedAt: { type: 'string', format: 'date-time', nullable: true },
    notes: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
    ...i18nField('subscriptionStatus', 'subscriptionStatus'),
    student: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        avatarUrl: { type: 'string', nullable: true },
      },
    },
    plan: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        ...i18nField('recurrence', 'subscriptionRecurrence'),
      },
    },
  },
};

export const getFinanceOverviewSchema = {
  tags: ['trainer-finance'],
  summary: 'Financeiro overview: KPIs and payment rows for a month',
  description:
    'Rows: overdue payments as of today (any month, including cancelled subscriptions), pending payments with ' +
    'dueDate before the first day of the next month (no lower bound), and payments paid inside the month ' +
    '(America/Sao_Paulo window). Overdue = ' +
    'pending AND dueDate < today - 3 days (same rule as GET /trainer/dashboard). Upcoming recurring ' +
    'cycles are generated before the query. Fixed query count, independent of roster size.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      month: {
        type: 'string',
        pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
        description: 'YYYY-MM in America/Sao_Paulo. Defaults to the current month.',
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        month: { type: 'string' },
        overdueGraceDays: { type: 'integer', description: 'Days of tolerance after dueDate before a pending payment is overdue' },
        kpis: {
          type: 'object',
          properties: {
            receivedAmount: moneyString,
            receivedCount: { type: 'integer' },
            pendingAmount: moneyString,
            pendingCount: { type: 'integer' },
            overdueAmount: moneyString,
            overdueCount: { type: 'integer' },
            overdueStudents: { type: 'integer', description: 'Distinct students with an overdue payment' },
            billedStudents: { type: 'integer', description: 'Distinct students with at least one listed payment' },
            delinquencyRate: {
              type: 'number',
              description: 'overdueStudents / billedStudents as a 0-100 percentage (2 decimals); 0 when nobody is billed',
            },
          },
        },
        payments: { type: 'array', items: overviewPaymentSchema },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
  },
};
