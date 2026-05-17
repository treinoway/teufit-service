import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import { PLATFORM_PLAN_TIERS, ASAAS_BILLING_TYPES } from '../../src/constants/platform-plan.js';

const tierValues = Object.values(PLATFORM_PLAN_TIERS);
const billingTypeValues = Object.values(ASAAS_BILLING_TYPES);

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: { type: 'string', description: 'Bearer access token' },
  },
};

// ─── Shared shapes ─────────────────────────────────────────────────────────────

const aiUsageByStudentSchema = {
  type: 'object',
  properties: {
    studentId: { type: 'string', format: 'uuid' },
    actions: { type: 'integer', minimum: 0 },
    cap: { type: ['integer', 'null'] },
  },
};

const usageSchema = {
  type: 'object',
  properties: {
    aiActions: {
      type: 'object',
      properties: {
        total: { type: 'integer', minimum: 0 },
        cap: { type: ['integer', 'null'], description: 'null means unlimited' },
        byStudent: { type: 'array', items: aiUsageByStudentSchema },
      },
    },
    students: {
      type: 'object',
      properties: {
        active: { type: 'integer', minimum: 0 },
        cap: { type: ['integer', 'null'], description: 'null means unlimited' },
      },
    },
  },
};

const limitsSchema = {
  type: 'object',
  properties: {
    studentCap: { type: ['integer', 'null'] },
    aiActionsPerStudent: { type: ['integer', 'null'] },
    aiActionsTrainerCap: { type: ['integer', 'null'] },
    branding: { type: 'boolean' },
    championships: { type: 'boolean' },
  },
};

const platformPlanResponseSchema = {
  type: 'object',
  properties: {
    tier: { type: 'string', enum: tierValues },
    status: { type: 'string' },
    currentPeriodEnd: { type: 'string', format: 'date-time', nullable: true },
    cancelAtPeriodEnd: { type: 'boolean' },
    limits: limitsSchema,
    usage: usageSchema,
  },
};

// ─── GET /trainer/platform-plan ────────────────────────────────────────────────

export const getPlatformPlanSchema = {
  tags: ['Platform Plan'],
  summary: 'Get current platform plan and usage',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: platformPlanResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── POST /trainer/platform-plan/checkout ─────────────────────────────────────

export const checkoutSchema = {
  tags: ['Platform Plan'],
  summary: 'Create a checkout for a platform plan',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['tier', 'billingType'],
    additionalProperties: false,
    properties: {
      tier: { type: 'string', enum: tierValues.filter((t) => t !== 'FREE') },
      billingType: { type: 'string', enum: billingTypeValues },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        checkoutUrl: { type: 'string', nullable: true },
        qrCode: { type: 'string', nullable: true },
        dueDate: { type: 'string', format: 'date' },
        amount: { type: 'number' },
        subscriptionId: { type: 'string' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── POST /trainer/platform-plan/cancel ───────────────────────────────────────

export const cancelPlanSchema = {
  tags: ['Platform Plan'],
  summary: 'Schedule cancellation at next renewal',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: {
      type: 'object',
      properties: {
        cancelAtPeriodEnd: { type: 'boolean' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── POST /trainer/platform-plan/change ───────────────────────────────────────

export const changePlanSchema = {
  tags: ['Platform Plan'],
  summary: 'Upgrade or downgrade plan tier',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['tier'],
    additionalProperties: false,
    properties: {
      tier: { type: 'string', enum: tierValues.filter((t) => t !== 'FREE') },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: tierValues },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};
