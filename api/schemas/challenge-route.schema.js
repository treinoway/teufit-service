import { errorResponseSchema, badRequestErrorResponseSchema } from './error-response.schema.js';
import {
  CHALLENGE_DESCRIPTION_MAX_LENGTH,
  challengeFormatValues,
  challengeOwnerTypeValues,
  challengeParticipantModeValues,
  challengeStatusValues,
  challengeVisibilityValues,
} from '../../src/constants/challenge.js';
import { Faixa, WeekStatus } from '../../src/constants/consistency-ranking.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: { type: 'string', description: 'Bearer access token' },
  },
};

// ─── Shared shapes ─────────────────────────────────────────────────────────────

const challengeSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    startDate: { type: 'string', format: 'date' },
    endDate: { type: 'string', format: 'date' },
    ...i18nField('status', 'challengeStatus'),
    ...i18nField('participantMode', 'challengeParticipantMode'),
    filterCriteria: { type: 'object', additionalProperties: true, nullable: true },
    cancelledAt: { type: 'string', format: 'date-time', nullable: true },
    participantCount: { type: 'integer' },
    // Per-challenge gamification config (snapshotted at create-time)
    ptsWorkoutCompleted: { type: 'integer', nullable: true },
    ptsStreak7Days: { type: 'integer', nullable: true },
    ptsStreak30Days: { type: 'integer', nullable: true },
    ptsDailyCheckin: { type: 'integer', nullable: true },
    ptsEvolutionRecord: { type: 'integer', nullable: true },
    ptsWorkoutFeedback: { type: 'integer', nullable: true },
    dailyPointsCap: { type: 'integer', nullable: true },
    anonymousRanking: { type: 'boolean' },
    format: { type: 'string', enum: challengeFormatValues, description: '"dates" (free dates, points only) or "weeks" (Monday start, whole weeks, consistency standings)' },
    weeks: { type: 'integer', nullable: true, description: 'Number of weeks; weekly format only' },
    currentWeek: { type: 'integer', nullable: true, description: 'Running week number ("Semana X de Y"); weekly format while running' },
    minPodiumWeeks: { type: 'integer', nullable: true, description: 'Valid weeks needed for the podium; weekly format only' },
    description: { type: 'string', nullable: true },
    visibility: { type: 'string', enum: challengeVisibilityValues },
    ownerType: { type: 'string', enum: challengeOwnerTypeValues },
    closeRequestedAt: { type: 'string', format: 'date-time', nullable: true, description: 'When the trainer asked to end it early' },
    closedAt: { type: 'string', format: 'date-time', nullable: true, description: 'When the final standings were frozen' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const challengeDescriptionBodyField = {
  type: 'string',
  maxLength: CHALLENGE_DESCRIPTION_MAX_LENGTH,
  nullable: true,
};

const weeklyScheduleBodyFields = {
  startWeek: {
    type: 'string',
    format: 'date',
    description: 'Weekly format: start Monday (YYYY-MM-DD, trainer time zone), the current week or a later one',
  },
  weeks: { type: 'integer', description: 'Weekly format: 1 to 12 weeks' },
  minPodiumWeeks: {
    type: 'integer',
    description: 'Weekly format: valid weeks needed for the podium, 1 to min(4, weeks); defaults to the trainer ranking config',
  },
};

const challengePtsOverrideBodyFields = {
  ptsWorkoutCompleted: { type: 'integer', minimum: 0, nullable: true },
  ptsStreak7Days: { type: 'integer', minimum: 0, nullable: true },
  ptsStreak30Days: { type: 'integer', minimum: 0, nullable: true },
  ptsDailyCheckin: { type: 'integer', minimum: 0, nullable: true },
  ptsEvolutionRecord: { type: 'integer', minimum: 0, nullable: true },
  ptsWorkoutFeedback: { type: 'integer', minimum: 0, nullable: true },
  dailyPointsCap: { type: 'integer', minimum: 1, nullable: true },
  anonymousRanking: { type: 'boolean' },
};

const filterCriteriaBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gender: { type: 'string' },
    minAge: { type: 'integer', minimum: 0, maximum: 120 },
    maxAge: { type: 'integer', minimum: 0, maximum: 120 },
    city: { type: 'string' },
    state: { type: 'string' },
  },
};

const rankingEntrySchema = {
  type: 'object',
  properties: {
    position: { type: 'integer' },
    studentId: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
    points: { type: 'integer' },
  },
};

const participantEntrySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    studentId: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
    addedAt: { type: 'string', format: 'date-time' },
  },
};

// ─── Trainer challenge schemas ─────────────────────────────────────────────────

export const createChallengeSchema = {
  tags: ['challenges'],
  summary: 'Create a challenge and snapshot participants and gamification config',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['name', 'participantMode'],
    additionalProperties: false,
    description: 'Without `format: "weeks"` the challenge uses free dates and needs startDate and endDate. Any owner type sent is ignored.',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      startDate: { type: 'string', format: 'date', description: 'Dates format only (required there)' },
      endDate: { type: 'string', format: 'date', description: 'Dates format only (required there)' },
      format: { type: 'string', enum: challengeFormatValues },
      ...weeklyScheduleBodyFields,
      description: challengeDescriptionBodyField,
      visibility: { type: 'string', enum: challengeVisibilityValues },
      participantMode: { type: 'string', enum: challengeParticipantModeValues },
      filter: filterCriteriaBodySchema,
      studentIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
      // Optional per-challenge pts overrides (override trainer template)
      ...challengePtsOverrideBodyFields,
    },
  },
  response: {
    201: challengeSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    422: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listChallengesSchema = {
  tags: ['challenges'],
  summary: 'List trainer challenges with optional status filter',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: challengeStatusValues },
    },
  },
  response: {
    200: { type: 'array', items: challengeSchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getChallengeSchema = {
  tags: ['challenges'],
  summary: 'Get a challenge detail',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: challengeSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateChallengeSchema = {
  tags: ['challenges'],
  summary: 'Update a challenge; weekly format: every field while scheduled, only name, description, anonymous ranking and visibility while running',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      ...weeklyScheduleBodyFields,
      description: challengeDescriptionBodyField,
      visibility: { type: 'string', enum: challengeVisibilityValues },
      ...challengePtsOverrideBodyFields,
    },
  },
  response: {
    200: challengeSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const cancelChallengeSchema = {
  tags: ['challenges'],
  summary: 'Cancel a challenge',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: challengeSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const deleteChallengeSchema = {
  tags: ['challenges'],
  summary: 'Hard-delete a challenge (only scheduled)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    204: { type: 'null' },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getChallengeRankingSchema = {
  tags: ['challenges'],
  summary: 'Get challenge leaderboard (trainer)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: { type: 'array', items: rankingEntrySchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listParticipantsSchema = {
  tags: ['challenges'],
  summary: 'List participants in a challenge',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: { type: 'array', items: participantEntrySchema },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const addParticipantsSchema = {
  tags: ['challenges'],
  summary: 'Bulk-add participants to a challenge',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['studentIds'],
    additionalProperties: false,
    properties: {
      studentIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        added: { type: 'integer' },
        participantCount: { type: 'integer' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const removeParticipantSchema = {
  tags: ['challenges'],
  summary: 'Remove a participant from a challenge',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id', 'studentId'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      studentId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    204: { type: 'null' },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const previewParticipantsSchema = {
  tags: ['challenges'],
  summary: 'Preview which students would match a participant filter',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['mode'],
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: challengeParticipantModeValues },
      filter: filterCriteriaBodySchema,
      studentIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        studentIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
        count: { type: 'integer' },
      },
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Trainer weekly championship schemas ───────────────────────────────────────

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

export const closeChallengeSchema = {
  tags: ['challenges'],
  summary: 'End a running weekly championship early: the running week becomes the last one and it closes at that week close',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: idParams,
  response: {
    200: {
      type: 'object',
      properties: {
        ...challengeSchema.properties,
        closesAt: { type: 'string', format: 'date-time', description: 'Close instant of the running week, when the championship closes' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const consistencyEnteringSchema = {
  type: 'object',
  nullable: true,
  description: 'Present while the participant lacks the valid weeks for the podium',
  properties: {
    validWeeks: { type: 'integer' },
    required: { type: 'integer' },
  },
};

const challengeConsistencyRowSchema = {
  type: 'object',
  properties: {
    studentId: { type: 'string', format: 'uuid' },
    name: { type: 'string', description: 'Full name, also with anonymous ranking on' },
    displayName: { type: 'string', description: 'First name and initial of the last name' },
    initials: { type: 'string' },
    position: { type: 'integer', nullable: true, description: 'Null for participants still entering' },
    eligible: { type: 'boolean' },
    faixa: { type: 'string', enum: Object.values(Faixa) },
    average: { type: 'number', nullable: true, description: 'Average over the championship valid weeks' },
    validWeeks: { type: 'integer' },
    weeks100: { type: 'integer' },
    weeksAt100: { type: 'integer' },
    streak: { type: 'integer' },
    currentWeekScore: { type: 'number', nullable: true, description: 'Partial score of the running week; null once closed' },
    weekStatus: { type: 'string', enum: Object.values(WeekStatus), nullable: true },
    entering: consistencyEnteringSchema,
    weeksMissing: { type: 'integer', description: 'Valid weeks still missing for the podium' },
  },
};

export const getChallengeConsistencySchema = {
  tags: ['challenges'],
  summary: 'Consistency standings of a weekly championship: empty while scheduled, live while running, frozen once closed',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: idParams,
  response: {
    200: {
      type: 'object',
      properties: {
        challenge: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            startDate: { type: 'string', format: 'date' },
            endDate: { type: 'string', format: 'date' },
            weeks: { type: 'integer' },
            minPodiumWeeks: { type: 'integer' },
            anonymousRanking: { type: 'boolean' },
            visibility: { type: 'string', enum: challengeVisibilityValues },
            closeRequestedAt: { type: 'string', format: 'date-time', nullable: true },
            closedAt: { type: 'string', format: 'date-time', nullable: true },
            participantCount: { type: 'integer' },
          },
        },
        ...i18nField('status', 'challengeStatus'),
        currentWeek: { type: 'integer', nullable: true, description: 'Week number while running; the number of weeks once closed' },
        closesAt: { type: 'string', format: 'date-time', nullable: true, description: 'Close instant of the running week' },
        rows: { type: 'array', items: challengeConsistencyRowSchema },
        entering: { type: 'array', items: challengeConsistencyRowSchema },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// ─── Student challenge schemas ─────────────────────────────────────────────────

export const listMyChallengesSchema = {
  tags: ['challenges'],
  summary: 'List challenges the student participates in',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  querystring: {
    type: 'object',
    properties: {
      trainerId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: challengeStatusValues },
    },
  },
  response: {
    200: { type: 'array', items: challengeSchema },
    401: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getMyChallengSchema = {
  tags: ['challenges'],
  summary: 'Get a challenge detail as a participant',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: challengeSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getMyChallengeRankingSchema = {
  tags: ['challenges'],
  summary: 'Get challenge ranking from student perspective',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: rankingEntrySchema },
        myPosition: { type: 'integer', nullable: true },
        myPoints: { type: 'integer' },
      },
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    500: errorResponseSchema,
  },
};
