import { pillarValues } from '../../src/constants/consistency-ranking.js';
import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';

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

const dateOnlyPattern = '^\\d{4}-\\d{2}-\\d{2}$';
const seasonWeeksValues = [4, 8, 12];

const standingsQuerystring = {
  type: 'object',
  properties: {
    season: {
      type: 'integer',
      minimum: 1,
      description: 'Season number; omitted means the current season',
    },
  },
};

const pillarCountSchema = {
  type: 'object',
  properties: {
    expected: { type: 'integer' },
    done: { type: 'integer' },
  },
};

const seasonSchema = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    startWeek: { type: 'string', pattern: dateOnlyPattern, description: 'Monday of the first week (YYYY-MM-DD)' },
    endWeek: { type: 'string', pattern: dateOnlyPattern, description: 'Monday of the last week (YYYY-MM-DD)' },
    weeks: { type: 'integer' },
    currentWeek: { type: 'integer', description: 'Current week of the season, clamped to 1..weeks' },
    status: { type: 'string', enum: ['active', 'closed'] },
  },
};

const standingsRowSchema = {
  type: 'object',
  properties: {
    studentId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    position: { type: 'integer' },
    eligible: { type: 'boolean' },
    average: { type: 'number', description: 'Season average score (0-100)' },
    validWeeks: { type: 'integer' },
    weeksAt100: { type: 'integer' },
    streak: { type: 'integer' },
    partialScore: {
      type: 'number',
      nullable: true,
      description: 'Running-week score; null when the week has no target. Absent on closed seasons',
    },
    weekStatus: {
      type: 'string',
      enum: ['valid', 'neutral', 'paused'],
      description: 'Running-week status. Absent on closed seasons',
    },
    pillars: {
      type: 'object',
      description: 'Running-week counts per pillar. Absent on closed seasons',
      properties: {
        workouts: pillarCountSchema,
        cardio: pillarCountSchema,
      },
    },
  },
};

const enteringItemSchema = {
  type: 'object',
  properties: {
    studentId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    validWeeks: { type: 'integer' },
    weeksMissing: { type: 'integer' },
  },
};

const standingsResponseSchema = {
  type: 'object',
  properties: {
    season: { ...seasonSchema, nullable: true, description: 'null before the ranking launches' },
    rows: { type: 'array', items: standingsRowSchema },
    entering: { type: 'array', items: enteringItemSchema },
  },
};

const weightsSchema = {
  type: 'object',
  properties: {
    workouts: { type: 'integer', minimum: 0, maximum: 100 },
    diet: { type: 'integer', minimum: 0, maximum: 100 },
    cardio: { type: 'integer', minimum: 0, maximum: 100 },
    feedback: { type: 'integer', minimum: 0, maximum: 100 },
    hydration: { type: 'integer', minimum: 0, maximum: 100 },
  },
};

const configProperties = {
  weights: weightsSchema,
  activePillars: { type: 'array', items: { type: 'string', enum: pillarValues } },
  seasonWeeks: { type: 'integer', enum: seasonWeeksValues },
  minPodiumWeeks: { type: 'integer', minimum: 1, maximum: 4 },
  closeWeekday: { type: 'integer', minimum: 0, maximum: 6, description: '0 = Sunday' },
  closeHour: { type: 'integer', minimum: 0, maximum: 23 },
  timeZone: { type: 'string', description: 'IANA time zone (e.g., "America/Sao_Paulo")' },
};

const configResponseSchema = {
  type: 'object',
  properties: configProperties,
};

const updatedConfigResponseSchema = {
  type: 'object',
  properties: {
    ...configProperties,
    effectiveFrom: {
      type: 'string',
      pattern: dateOnlyPattern,
      nullable: true,
      description: 'Monday from which the new scoring rule applies; null when no rule changed',
    },
  },
};

const updateConfigBody = {
  type: 'object',
  properties: {
    weights: { ...weightsSchema, additionalProperties: false },
    activePillars: configProperties.activePillars,
    seasonWeeks: configProperties.seasonWeeks,
    minPodiumWeeks: configProperties.minPodiumWeeks,
    closeWeekday: configProperties.closeWeekday,
    closeHour: configProperties.closeHour,
    timeZone: configProperties.timeZone,
  },
  additionalProperties: false,
};

const pauseBody = {
  type: 'object',
  required: ['weekStart'],
  properties: {
    weekStart: {
      type: 'string',
      pattern: dateOnlyPattern,
      description: 'Monday of the week (YYYY-MM-DD); the route rejects non-Mondays with 400',
    },
    studentId: {
      type: 'string',
      format: 'uuid',
      description: 'Omit to apply to the whole team',
    },
    reason: { type: 'string', maxLength: 255 },
  },
  additionalProperties: false,
};

const pauseResponseSchema = {
  type: 'object',
  properties: {
    weekStart: { type: 'string', pattern: dateOnlyPattern },
    studentId: { type: 'string', format: 'uuid', nullable: true },
    paused: { type: 'boolean' },
    reason: { type: 'string', nullable: true, description: 'Present on pause only' },
  },
};

export const getStandingsSchema = {
  tags: ['consistency-ranking'],
  summary: 'Get the consistency ranking standings of the trainer',
  description:
    'Returns the season, the ranked students and the students still entering the ranking. ' +
    'Without `season` it returns the current season; `season` selects a closed one. ' +
    'Before the ranking launches `season` is null and the lists are empty. ' +
    'Closed seasons omit partialScore, weekStatus and pillars from each row.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: standingsQuerystring,
  response: {
    200: standingsResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const adminGetStandingsSchema = {
  tags: ['admin-consistency-ranking'],
  summary: 'Get the consistency ranking standings of a trainer (admin)',
  description:
    'Same payload as the trainer standings route, for any trainer. Requires the admin role.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['trainerId'],
    properties: { trainerId: { type: 'string', format: 'uuid' } },
  },
  querystring: standingsQuerystring,
  response: {
    200: standingsResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getConfigSchema = {
  tags: ['consistency-ranking'],
  summary: 'Get the consistency ranking configuration of the trainer',
  description:
    'Returns the scoring weights, active pillars, weekly close rule, season length ' +
    'and minimum weeks to be eligible for the podium. Defaults apply when never configured.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: configResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateConfigSchema = {
  tags: ['consistency-ranking'],
  summary: 'Update the consistency ranking configuration of the trainer',
  description:
    'Partial update. Scoring and close-rule changes take effect from the next Monday ' +
    '(`effectiveFrom`); `seasonWeeks` applies from the next season.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: updateConfigBody,
  response: {
    200: updatedConfigResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const pauseWeekSchema = {
  tags: ['consistency-ranking'],
  summary: 'Pause a week for the team or for one student',
  description:
    'Marks the week as paused so it does not count toward the ranking. ' +
    'Fails with 409 when the week is no longer editable and 404 for an unknown student.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: pauseBody,
  response: {
    200: pauseResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const resumeWeekSchema = {
  tags: ['consistency-ranking'],
  summary: 'Resume a paused week for the team or for one student',
  description:
    'Removes the pause (or reactivates a student of a paused team week). ' +
    'The target travels in the JSON request body, like the pause route.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: pauseBody,
  response: {
    200: pauseResponseSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const closeCurrentSeasonSchema = {
  tags: ['consistency-ranking'],
  summary: 'Request the early close of the current season',
  description:
    'The season ends after the next weekly close. Returns 404 when there is no active season.',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: seasonSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};
