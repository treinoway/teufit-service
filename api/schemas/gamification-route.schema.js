import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: { type: 'string', description: 'Bearer access token' },
  },
};

// ─── Config schemas ────────────────────────────────────────────────────────────

const gamificationConfigSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', nullable: true },
    trainerId: { type: 'string', format: 'uuid' },
    enabled: { type: 'boolean' },
    ptsWorkoutCompleted: { type: 'integer', nullable: true },
    ptsStreak7Days: { type: 'integer', nullable: true },
    ptsStreak30Days: { type: 'integer', nullable: true },
    ptsDailyCheckin: { type: 'integer', nullable: true },
    ptsEvolutionRecord: { type: 'integer', nullable: true },
    ptsWorkoutFeedback: { type: 'integer', nullable: true },
    dailyPointsCap: { type: 'integer', nullable: true },
    streakToleranceHours: { type: 'integer' },
    anonymousRanking: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time', nullable: true },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const upsertConfigSchema = {
  tags: ['gamification'],
  summary: 'Create or update gamification configuration (used as template for new challenges)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: { type: 'boolean' },
      ptsWorkoutCompleted: { type: 'integer', minimum: 0, nullable: true },
      ptsStreak7Days: { type: 'integer', minimum: 0, nullable: true },
      ptsStreak30Days: { type: 'integer', minimum: 0, nullable: true },
      ptsDailyCheckin: { type: 'integer', minimum: 0, nullable: true },
      ptsEvolutionRecord: { type: 'integer', minimum: 0, nullable: true },
      ptsWorkoutFeedback: { type: 'integer', minimum: 0, nullable: true },
      dailyPointsCap: { type: 'integer', minimum: 1, nullable: true },
      streakToleranceHours: { type: 'integer', minimum: 1, maximum: 72 },
      anonymousRanking: { type: 'boolean' },
    },
  },
  response: {
    200: gamificationConfigSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getConfigSchema = {
  tags: ['gamification'],
  summary: 'Get gamification configuration (trainer template for new challenges)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: gamificationConfigSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Point history/summary schemas ────────────────────────────────────────────

const pointTransactionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    studentId: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    challengeId: { type: 'string', format: 'uuid' },
    action: { type: 'string' },
    points: { type: 'integer' },
    referenceId: { type: 'string', format: 'uuid', nullable: true },
    reason: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const paginatedTransactionsSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: pointTransactionSchema },
    total: { type: 'integer' },
    page: { type: 'integer' },
    limit: { type: 'integer' },
  },
};

export const getStudentPointHistorySchema = {
  tags: ['gamification'],
  summary: "Get a student's point transaction history for a challenge",
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['studentId'],
    properties: {
      studentId: { type: 'string', format: 'uuid' },
    },
  },
  querystring: {
    type: 'object',
    required: ['challengeId'],
    properties: {
      challengeId: { type: 'string', format: 'uuid' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
  response: {
    200: paginatedTransactionsSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getMyPointHistorySchema = {
  tags: ['gamification'],
  summary: 'Get own point transaction history for a challenge',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: {
    type: 'object',
    required: ['challengeId'],
    properties: {
      challengeId: { type: 'string', format: 'uuid' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
  response: {
    200: paginatedTransactionsSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const pointSummarySchema = {
  type: 'object',
  properties: {
    totalPoints: { type: 'integer' },
    breakdown: { type: 'object', additionalProperties: { type: 'integer' } },
  },
};

export const getMyPointSummarySchema = {
  tags: ['gamification'],
  summary: 'Get own point summary with per-action breakdown for a challenge',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: {
    type: 'object',
    required: ['challengeId'],
    properties: {
      challengeId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: pointSummarySchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Bonus schema ──────────────────────────────────────────────────────────────

export const awardBonusSchema = {
  tags: ['gamification'],
  summary: 'Award a manual point bonus to a student within a challenge',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['challengeId', 'studentId'],
    properties: {
      challengeId: { type: 'string', format: 'uuid' },
      studentId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['points'],
    additionalProperties: false,
    properties: {
      points: { type: 'integer', minimum: 1, maximum: 10000 },
      reason: { type: 'string', maxLength: 300, nullable: true },
    },
  },
  response: {
    201: pointTransactionSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Deprecated global ranking schemas (410 Gone) ─────────────────────────────

const goneErrorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    messageCode: { type: 'string' },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
};

export const getTrainerRankingGoneSchema = {
  tags: ['gamification'],
  summary: '[REMOVED] Global trainer ranking — use challenge rankings instead',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    410: goneErrorSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
  },
};

export const getMyRankingGoneSchema = {
  tags: ['gamification'],
  summary: '[REMOVED] Global student ranking — use challenge rankings instead',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    410: goneErrorSchema,
    401: errorResponseSchema,
  },
};
