import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import { DASHBOARD_DEFAULTS } from '../../src/constants/training.js';

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

const windowSchema = {
  type: 'object',
  properties: {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
  },
};

const commonQuerystring = {
  dateFrom: { type: 'string', format: 'date-time' },
  dateTo: { type: 'string', format: 'date-time' },
};

const studentIdParam = { studentId: { type: 'string', format: 'uuid' } };

const errorResponses = {
  400: badRequestErrorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
};

// ─── Summary schema ───────────────────────────────────────────────────────────

export const getDashboardSummarySchema = {
  tags: ['Student Dashboard - Trainer'],
  summary: 'Get dashboard summary for a student',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId'],
    properties: studentIdParam,
  },
  querystring: {
    type: 'object',
    properties: commonQuerystring,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        window: windowSchema,
        sessionCounts: {
          type: 'object',
          properties: {
            completed: { type: 'integer' },
            in_progress: { type: 'integer' },
            abandoned: { type: 'integer' },
          },
        },
        totalSessions: { type: 'integer' },
        completionRate: { type: 'number', nullable: true },
        lastSessionAt: { type: 'string', format: 'date-time', nullable: true },
        currentProtocol: {
          type: 'object',
          nullable: true,
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            startDate: { type: 'string', nullable: true },
            expirationDate: { type: 'string', nullable: true },
          },
        },
        maxStreakDays: { type: 'integer', nullable: true },
        sessionsPerWeek: { type: 'number', nullable: true },
        daysSinceLastSession: { type: 'integer', nullable: true },
      },
    },
    ...errorResponses,
  },
};

// ─── Recent sessions schema ───────────────────────────────────────────────────

export const getRecentSessionsSchema = {
  tags: ['Student Dashboard - Trainer'],
  summary: 'Get recent workout sessions for a student',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId'],
    properties: studentIdParam,
  },
  querystring: {
    type: 'object',
    properties: {
      ...commonQuerystring,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: DASHBOARD_DEFAULTS.RECENT_SESSIONS_MAX,
        default: DASHBOARD_DEFAULTS.RECENT_SESSIONS_DEFAULT,
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        window: windowSchema,
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              trainingId: { type: 'string', format: 'uuid' },
              trainingName: { type: 'string', nullable: true },
              status: { type: 'string' },
              startedAt: { type: 'string', format: 'date-time' },
              finishedAt: { type: 'string', format: 'date-time', nullable: true },
              durationSeconds: { type: 'integer', nullable: true },
              avgRpe: { type: 'number', nullable: true },
              noteText: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    ...errorResponses,
  },
};

// ─── Exercise progression list schema ────────────────────────────────────────

const latestAggregateSchema = {
  type: 'object',
  nullable: true,
  properties: {
    date: { type: 'string', format: 'date-time' },
    maxLoad: { type: 'number', nullable: true },
    avgLoad: { type: 'number', nullable: true },
    totalVolume: { type: 'number', nullable: true },
    completedSets: { type: 'integer' },
    totalReps: { type: 'integer' },
    avgRpe: { type: 'number', nullable: true },
  },
};

const trendSchema = {
  type: 'object',
  properties: {
    maxLoadDelta: { type: 'number', nullable: true },
    maxLoadDeltaPct: { type: 'number', nullable: true },
  },
};

export const getExerciseProgressionSchema = {
  tags: ['Student Dashboard - Trainer'],
  summary: 'Get per-exercise progression aggregates for a student',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId'],
    properties: studentIdParam,
  },
  querystring: {
    type: 'object',
    properties: {
      ...commonQuerystring,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: DASHBOARD_DEFAULTS.EXERCISES_LIST_MAX,
        default: DASHBOARD_DEFAULTS.EXERCISES_LIST_DEFAULT,
      },
      includeDurationOnly: { type: 'boolean', default: false },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        window: windowSchema,
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              exerciseId: { type: 'string', format: 'uuid' },
              exerciseName: { type: 'string' },
              hasLoad: { type: 'boolean' },
              prescriptionMode: { type: 'string', nullable: true },
              trainingId: { type: 'string', format: 'uuid' },
              trainingName: { type: 'string' },
              sessionCount: { type: 'integer' },
              lastPerformedAt: { type: 'string', format: 'date-time', nullable: true },
              latest: latestAggregateSchema,
              trend: trendSchema,
              loadHistory: {
                type: 'array',
                items: { type: 'number', nullable: true },
                maxItems: 6,
              },
            },
          },
        },
      },
    },
    ...errorResponses,
  },
};

// ─── Exercise progression detail schema ──────────────────────────────────────

const setLogDetailSchema = {
  type: 'object',
  properties: {
    setNumber: { type: 'integer' },
    repetitions: { type: 'integer', nullable: true },
    load: { type: 'number', nullable: true },
    rpe: { type: 'integer', nullable: true },
    completed: { type: 'boolean' },
  },
};

const sessionDetailSchema = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', format: 'uuid' },
    date: { type: 'string', format: 'date-time' },
    status: { type: 'string' },
    maxLoad: { type: 'number', nullable: true },
    avgLoad: { type: 'number', nullable: true },
    totalVolume: { type: 'number', nullable: true },
    completedSets: { type: 'integer' },
    totalReps: { type: 'integer' },
    avgRpe: { type: 'number', nullable: true },
    sets: { type: 'array', items: setLogDetailSchema },
  },
};

// ─── Daily activity schema ────────────────────────────────────────────────────

export const getDailyActivitySchema = {
  tags: ['Student Dashboard - Trainer'],
  summary: 'Get per-day activity summary for a student',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId'],
    properties: studentIdParam,
  },
  querystring: {
    type: 'object',
    properties: commonQuerystring,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        window: windowSchema,
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              status: { type: 'string' },
              sessionCount: { type: 'integer' },
              sessionIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              volumeKg: { type: 'number' },
              completedSets: { type: 'integer' },
              totalSets: { type: 'integer' },
            },
          },
        },
      },
    },
    ...errorResponses,
  },
};

// ─── Exercise progression detail schema ──────────────────────────────────────

export const getExerciseProgressionDetailSchema = {
  tags: ['Student Dashboard - Trainer'],
  summary: 'Get per-session progression detail for one exercise',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['studentId', 'exerciseId'],
    properties: {
      ...studentIdParam,
      exerciseId: { type: 'string', format: 'uuid' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      ...commonQuerystring,
      sessionLimit: {
        type: 'integer',
        minimum: 1,
        maximum: DASHBOARD_DEFAULTS.SESSIONS_PER_EXERCISE_MAX,
        default: DASHBOARD_DEFAULTS.SESSIONS_PER_EXERCISE_DEFAULT,
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        exercise: {
          type: 'object',
          nullable: true,
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            hasLoad: { type: 'boolean' },
            prescriptionMode: { type: 'string', nullable: true },
            trainingId: { type: 'string', format: 'uuid' },
            trainingName: { type: 'string', nullable: true },
          },
        },
        window: windowSchema,
        sessions: { type: 'array', items: sessionDetailSchema },
      },
    },
    ...errorResponses,
  },
};
