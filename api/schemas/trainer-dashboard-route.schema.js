import { errorResponseSchema } from './error-response.schema.js';

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: {
      type: 'string',
      description: 'Bearer access token (e.g., "Bearer <token>")',
    },
  },
};

// ─── Shared shapes ─────────────────────────────────────────────────────────────

// Local copy of the moneyString shape also defined in
// subscription-plan-route.schema.js, student-subscription-route.schema.js,
// and subscription-payment-route.schema.js — following the existing local
// pattern rather than introducing a shared import across schema files.
const moneyString = { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' };

// Adherence delta can be negative (this month vs last month), so it can't
// reuse moneyString's unsigned pattern. Same 2-decimal precision, signed.
const signedPercentageString = { type: 'string', pattern: '^-?\\d+(\\.\\d{1,2})?$' };

const dashboardResponseSchema = {
  type: 'object',
  properties: {
    plans: {
      type: 'object',
      properties: {
        expiredCount: {
          type: 'integer',
          description:
            'Distinct active subscriptions with at least one overdue (pending, past-due) payment. ' +
            'Counts SUBSCRIPTIONS, not payments — differs from finance.overdueCount, which counts ' +
            'PAYMENTS. A subscription with 3 overdue payments counts once here, 3 there. Intentional.',
        },
        renewingSoonCount: {
          type: 'integer',
          description:
            'Active subscriptions whose latest billing cycle ends within the next 7 days ' +
            '(inclusive both ends: today through today+7d). Derived from ' +
            'MAX(SubscriptionPayment.cycleEndDate) since StudentSubscription has no endDate field. ' +
            "Known limitation: if the next cycle's payment row hasn't been materialized yet, the " +
            'subscription will not appear here even though it is renewing soon.',
        },
      },
    },
    routines: {
      type: 'object',
      properties: {
        expiredCount: {
          type: 'integer',
          description:
            'Active, non-deleted TrainingProtocols with expirationDate strictly before today. ' +
            'Protocols with expirationDate = null (never expire) are excluded.',
        },
        expiringSoonCount: {
          type: 'integer',
          description:
            'Active, non-deleted TrainingProtocols with expirationDate between today and today+7d, ' +
            'inclusive both ends. Protocols with expirationDate = null are excluded.',
        },
      },
    },
    finance: {
      type: 'object',
      properties: {
        monthReceived: {
          ...moneyString,
          description:
            'Sum of PAID payment amounts with paidAt in the current UTC calendar month ' +
            '(same window boundary as trainer-briefing). "0.00" when no payments matched.',
        },
        totalReceived: {
          ...moneyString,
          description:
            'All-time sum of PAID payment amounts for this trainer. "0.00" when no payments matched.',
        },
        overdueCount: {
          type: 'integer',
          description:
            'Count of individual PENDING payments with dueDate before today. Counts PAYMENTS, not ' +
            'subscriptions — see plans.expiredCount for the subscription-level count.',
        },
        overdueAmount: {
          ...moneyString,
          description: 'Sum of amounts for the overdue payments counted in overdueCount. "0.00" when none.',
        },
      },
    },
    engagement: {
      type: 'object',
      properties: {
        inactiveStudentsCount: {
          type: 'integer',
          description:
            'Roster students with no completed session in the last 7 days. Read from the cached ' +
            'TrainerBriefingSnapshot — may be up to ~1 day stale.',
        },
        adherenceMonthPct: {
          ...moneyString,
          description:
            'Current-month adherence rate (0-100), formatted to 2 decimal places. Same value and ' +
            'format as GET /trainer/briefing overallAdherence. Read from the cached snapshot.',
        },
        adherenceDeltaPp: {
          ...signedPercentageString,
          description:
            'Adherence change vs prior month in percentage points — can be negative. Read from the ' +
            'cached snapshot.',
        },
        weekPrCount: {
          type: 'integer',
          description: 'Roster students with a new load personal record in the last 7 days. Computed live.',
        },
      },
    },
    generatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'ISO timestamp of when this response was generated.',
    },
  },
};

export const getTrainerDashboardSchema = {
  tags: ['trainer-dashboard'],
  summary: 'Get the trainer Home "Torre de Controle" aggregated dashboard',
  description:
    'Returns aggregated KPIs across subscription plans, training routines, finance, and student ' +
    'engagement for the authenticated trainer. Replaces the client-side composition of briefing + ' +
    'subscriptions + payments + protocols. engagement.* (except weekPrCount) is read from the ' +
    'trainer briefing snapshot and may be up to ~1 day stale; every other field is computed live.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: dashboardResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
