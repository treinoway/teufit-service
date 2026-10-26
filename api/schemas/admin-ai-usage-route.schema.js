import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const MONTH_PATTERN = '^\\d{4}-(0[1-9]|1[0-2])$';

const tokenCountersProperties = {
  inputTokens: { type: 'integer' },
  outputTokens: { type: 'integer' },
  cacheReadTokens: { type: 'integer' },
  cacheWriteTokens: { type: 'integer' },
  totalTokens: { type: 'integer' },
  turns: { type: 'integer' },
};
const tokenCountersRequired = Object.keys(tokenCountersProperties);

const trainerUsageSchema = {
  type: 'object',
  required: ['trainerId', 'tier', ...tokenCountersRequired],
  properties: {
    trainerId: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    email: { type: 'string', nullable: true },
    tier: { type: 'string', enum: Object.values(PLATFORM_PLAN_TIERS) },
    ...tokenCountersProperties,
  },
  additionalProperties: false,
};

export const getAiUsageSchema = {
  tags: ['Admin - AI Usage'],
  summary: 'iArnold token usage for a billing month, total and per trainer — admin only',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: { month: { type: 'string', pattern: MONTH_PATTERN } },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['month', 'totals', 'trainers'],
      properties: {
        month: { type: 'string' },
        totals: {
          type: 'object',
          required: tokenCountersRequired,
          properties: tokenCountersProperties,
          additionalProperties: false,
        },
        trainers: { type: 'array', items: trainerUsageSchema },
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
