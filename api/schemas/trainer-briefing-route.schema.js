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

const briefingResponseSchema = {
  type: 'object',
  properties: {
    activeStudents: {
      type: 'integer',
      description: 'Distinct students with a completed session in the last 30 days',
    },
    returningThisWeek: {
      type: 'integer',
      description: 'Active students who came back after a 7-day gap',
    },
    stagnantProgress: {
      type: 'integer',
      description: 'Active students with no new load PR in the last 14 days',
    },
    inactiveStudents: {
      type: 'integer',
      description: 'Roster students with no completed session in the last 7 days',
    },
    overallAdherence: {
      type: 'string',
      description: 'Current-month adherence rate (0–100), formatted to 2 decimal places',
    },
    adherenceDeltaPp: {
      type: 'string',
      description: 'Adherence change vs prior month in percentage points (can be negative)',
    },
    computedAt: {
      type: 'string',
      format: 'date-time',
      description: 'ISO timestamp of when this snapshot was last computed',
    },
  },
};

export const getBriefingSchema = {
  tags: ['trainer-briefing'],
  summary: 'Get the trainer briefing snapshot (SEUS ALUNOS AGORA KPIs)',
  description:
    'Returns a cached snapshot of key student-activity KPIs. ' +
    'The snapshot is refreshed synchronously when dirty or missing. ' +
    'A daily cron at 22:00 UTC pre-warms all snapshots.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: briefingResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
