import {
  ADMIN_MANAGER_PAGE_SIZE_DEFAULT,
  ADMIN_MANAGER_PAGE_SIZE_MAX,
  ADMIN_MANAGER_PROTOCOL_PERSPECTIVE,
  ADMIN_MANAGER_SEARCH_MAX_LENGTH,
  ADMIN_MANAGER_TEMPLATE_TYPE,
  ADMIN_MANAGER_USER_KIND,
  OVERVIEW_DEFAULT_PERIOD,
  OVERVIEW_PERIODS,
} from '../../src/constants/admin-manager.js';
import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const ADMIN_MANAGER_TAG = 'Admin - Manager';
const SECURITY = [{ bearerAuth: [] }];
const DATE_TIME = { type: 'string', format: 'date-time' };
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true };
const NULLABLE_STRING = { type: 'string', nullable: true };
const NULLABLE_INTEGER = { type: 'integer', nullable: true };
const UUID = { type: 'string', format: 'uuid' };
const DATE_ONLY = { type: 'string', description: 'YYYY-MM-DD' };

const userIdParams = {
  type: 'object',
  required: ['userId'],
  properties: { userId: UUID },
};

const protocolIdParams = {
  type: 'object',
  required: ['protocolId'],
  properties: { protocolId: UUID },
};

const sessionIdParams = {
  type: 'object',
  required: ['sessionId'],
  properties: { sessionId: UUID },
};

// Builds the page/pageSize querystring properties shared by every paginated route.
function paginationProperties() {
  return {
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: ADMIN_MANAGER_PAGE_SIZE_MAX,
      default: ADMIN_MANAGER_PAGE_SIZE_DEFAULT,
    },
  };
}

// Builds a querystring schema with pagination plus the extra properties.
function buildQuerystring(extraProperties = {}, required = []) {
  return {
    type: 'object',
    required,
    properties: { ...paginationProperties(), ...extraProperties },
    additionalProperties: false,
  };
}

// Builds the paginated 200 response envelope around an item schema.
function pageResponse(itemProperties) {
  return {
    type: 'object',
    required: ['items', 'total', 'page', 'pageSize'],
    properties: {
      items: { type: 'array', items: { type: 'object', properties: itemProperties, additionalProperties: false } },
      total: { type: 'integer' },
      page: { type: 'integer' },
      pageSize: { type: 'integer' },
    },
    additionalProperties: false,
  };
}

// Builds the response map shared by every manager route.
function buildResponses(successSchema, { withNotFound = false } = {}) {
  return {
    200: successSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    ...(withNotFound ? { 404: errorResponseSchema } : {}),
    429: errorResponseSchema,
    503: errorResponseSchema,
  };
}

const userProfileProperties = {
  id: UUID,
  firstName: { type: 'string' },
  lastName: { type: 'string' },
  email: NULLABLE_STRING,
  roles: { type: 'array', items: { type: 'string' } },
  status: { type: 'string' },
  createdAt: DATE_TIME,
  deletedAt: NULLABLE_DATE_TIME,
};

const countKeys = [
  'students', 'activeStudents', 'protocolsCreated', 'trainingTemplates', 'exerciseTemplates',
  'challenges', 'trainers', 'protocolsAssigned', 'workoutSessions',
];

const exerciseProperties = {
  id: UUID,
  name: { type: 'string' },
  order: { type: 'integer' },
  sets: NULLABLE_INTEGER,
  repetitions: { description: 'Stored value as-is: {min,max}, a number, an array of reps per set, or null', nullable: true },
  prescriptionMode: NULLABLE_STRING,
  duration: { ...NULLABLE_INTEGER, description: 'Seconds (duration-mode exercises)' },
  hasLoad: { type: 'boolean' },
  suggestedLoad: { type: 'number', nullable: true },
  restInterval: { ...NULLABLE_INTEGER, description: 'Seconds' },
  notes: NULLABLE_STRING,
};

export const listUsersSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'List platform users with search and kind filter — admin only',
  security: SECURITY,
  querystring: buildQuerystring({
    search: { type: 'string', maxLength: ADMIN_MANAGER_SEARCH_MAX_LENGTH },
    kind: { type: 'string', enum: Object.values(ADMIN_MANAGER_USER_KIND) },
  }),
  response: buildResponses(
    pageResponse({
      ...userProfileProperties,
      isTrainer: { type: 'boolean' },
      isStudent: { type: 'boolean' },
    }),
  ),
};

export const getUserOverviewSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'User profile, trainer summary and counts — admin only',
  security: SECURITY,
  params: userIdParams,
  response: buildResponses(
    {
      type: 'object',
      required: ['user', 'trainer', 'counts', 'lastWorkoutAt'],
      properties: {
        user: { type: 'object', properties: userProfileProperties, additionalProperties: false },
        trainer: {
          type: 'object',
          nullable: true,
          properties: { id: UUID, createdAt: DATE_TIME, planTier: NULLABLE_STRING },
          additionalProperties: false,
        },
        counts: {
          type: 'object',
          required: countKeys,
          properties: Object.fromEntries(countKeys.map((key) => [key, { type: 'integer' }])),
          additionalProperties: false,
        },
        lastWorkoutAt: NULLABLE_DATE_TIME,
      },
      additionalProperties: false,
    },
    { withNotFound: true },
  ),
};

export const listUserStudentsSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Students linked to a trainer user — admin only',
  security: SECURITY,
  params: userIdParams,
  querystring: buildQuerystring(),
  response: buildResponses(
    pageResponse({
      studentId: UUID,
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      email: NULLABLE_STRING,
      status: { type: 'string' },
      activeOnPlan: { type: 'boolean' },
      lastWorkoutAt: NULLABLE_DATE_TIME,
      linkedAt: DATE_TIME,
    }),
  ),
};

export const listUserTrainersSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Trainers a user is linked to as a student — admin only',
  security: SECURITY,
  params: userIdParams,
  querystring: buildQuerystring(),
  response: buildResponses(
    pageResponse({
      trainerId: UUID,
      userId: UUID,
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      email: NULLABLE_STRING,
      status: { type: 'string' },
      linkedAt: DATE_TIME,
    }),
  ),
};

export const listUserProtocolsSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Protocols created by (trainer) or assigned to (student) a user — admin only',
  security: SECURITY,
  params: userIdParams,
  querystring: buildQuerystring(
    { as: { type: 'string', enum: Object.values(ADMIN_MANAGER_PROTOCOL_PERSPECTIVE) } },
    ['as'],
  ),
  response: buildResponses(
    pageResponse({
      id: UUID,
      name: { type: 'string' },
      trainerName: { type: 'string' },
      assigneeName: { type: 'string' },
      startDate: DATE_ONLY,
      endDate: { ...DATE_ONLY, nullable: true },
      trainingsCount: { type: 'integer' },
      createdAt: DATE_TIME,
      deletedAt: NULLABLE_DATE_TIME,
    }),
  ),
};

export const getProtocolDetailSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Protocol with trainings and exercises, read-only — admin only',
  security: SECURITY,
  params: protocolIdParams,
  response: buildResponses(
    {
      type: 'object',
      properties: {
        id: UUID,
        name: { type: 'string' },
        description: NULLABLE_STRING,
        status: { type: 'string' },
        trainerName: { type: 'string' },
        assigneeName: { type: 'string' },
        startDate: DATE_ONLY,
        endDate: { ...DATE_ONLY, nullable: true },
        createdAt: DATE_TIME,
        deletedAt: NULLABLE_DATE_TIME,
        trainings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: UUID,
              name: { type: 'string' },
              order: { type: 'integer' },
              exercises: { type: 'array', items: { type: 'object', properties: exerciseProperties, additionalProperties: false } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    { withNotFound: true },
  ),
};

export const listUserTemplatesSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Training or exercise templates of a trainer user — admin only',
  security: SECURITY,
  params: userIdParams,
  querystring: buildQuerystring(
    { type: { type: 'string', enum: Object.values(ADMIN_MANAGER_TEMPLATE_TYPE) } },
    ['type'],
  ),
  response: buildResponses(
    pageResponse({ id: UUID, name: { type: 'string' }, createdAt: DATE_TIME, deletedAt: NULLABLE_DATE_TIME }),
  ),
};

export const listUserSessionsSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Workout sessions of a user, newest first — admin only',
  security: SECURITY,
  params: userIdParams,
  querystring: buildQuerystring(),
  response: buildResponses(
    pageResponse({
      id: UUID,
      trainingName: NULLABLE_STRING,
      startedAt: DATE_TIME,
      finishedAt: NULLABLE_DATE_TIME,
      durationSec: NULLABLE_INTEGER,
      deletedAt: NULLABLE_DATE_TIME,
    }),
  ),
};

const NULLABLE_NUMBER = { type: 'number', nullable: true };

const sessionSetLogProperties = {
  id: UUID,
  setNumber: { type: 'integer' },
  repetitions: NULLABLE_INTEGER,
  load: NULLABLE_NUMBER,
  duration: { ...NULLABLE_INTEGER, description: 'Seconds' },
  rpe: NULLABLE_INTEGER,
  restSeconds: NULLABLE_INTEGER,
  completed: { type: 'boolean' },
  notes: NULLABLE_STRING,
};

const previousSetLogProperties = {
  setNumber: { type: 'integer' },
  repetitions: NULLABLE_INTEGER,
  load: NULLABLE_NUMBER,
  duration: { ...NULLABLE_INTEGER, description: 'Seconds' },
};

const bestSetSchema = {
  type: 'object',
  nullable: true,
  description: 'Completed set with the highest load × repetitions; null when none qualifies',
  properties: {
    setNumber: { type: 'integer' },
    load: { type: 'number' },
    repetitions: { type: 'integer' },
    duration: NULLABLE_INTEGER,
    rpe: NULLABLE_INTEGER,
    restSeconds: NULLABLE_INTEGER,
    completed: { type: 'boolean' },
    tonnage: { type: 'number' },
  },
  additionalProperties: false,
};

const previousLogSchema = {
  type: 'object',
  nullable: true,
  description: 'Last completed session of the student that finished before this session started, for the same effective exercise',
  properties: {
    workoutSessionId: UUID,
    finishedAt: DATE_TIME,
    setLogs: { type: 'array', items: { type: 'object', properties: previousSetLogProperties, additionalProperties: false } },
    bestSet: bestSetSchema,
  },
  additionalProperties: false,
};

const sessionExerciseProperties = {
  id: UUID,
  name: { type: 'string' },
  sets: NULLABLE_INTEGER,
  repetitions: exerciseProperties.repetitions,
  prescriptionMode: NULLABLE_STRING,
  duration: { ...NULLABLE_INTEGER, description: 'Seconds (duration-mode exercises)' },
  hasLoad: { type: 'boolean' },
  suggestedLoad: NULLABLE_NUMBER,
  restInterval: { ...NULLABLE_INTEGER, description: 'Seconds' },
};

const sessionExerciseLogProperties = {
  id: UUID,
  order: { type: 'integer' },
  status: { type: 'string' },
  notes: NULLABLE_STRING,
  exercise: { type: 'object', properties: sessionExerciseProperties, additionalProperties: false },
  substitutedByExerciseId: { ...UUID, nullable: true },
  substitutedByExerciseName: NULLABLE_STRING,
  setLogs: { type: 'array', items: { type: 'object', properties: sessionSetLogProperties, additionalProperties: false } },
  previousLog: previousLogSchema,
};

export const getSessionDetailSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Workout session with exercise logs, sets and previous logs, read-only — admin only',
  security: SECURITY,
  params: sessionIdParams,
  response: buildResponses(
    {
      type: 'object',
      properties: {
        id: UUID,
        status: { type: 'string' },
        startedAt: DATE_TIME,
        finishedAt: NULLABLE_DATE_TIME,
        durationSec: NULLABLE_INTEGER,
        notes: NULLABLE_STRING,
        deletedAt: NULLABLE_DATE_TIME,
        training: {
          type: 'object',
          properties: { id: UUID, name: { type: 'string' } },
          additionalProperties: false,
        },
        student: {
          type: 'object',
          properties: { id: UUID, firstName: NULLABLE_STRING, lastName: NULLABLE_STRING, email: NULLABLE_STRING },
          additionalProperties: false,
        },
        exerciseLogs: {
          type: 'array',
          items: { type: 'object', properties: sessionExerciseLogProperties, additionalProperties: false },
        },
      },
      additionalProperties: false,
    },
    { withNotFound: true },
  ),
};

const INTEGER = { type: 'integer' };
const TIER = { type: 'string', enum: Object.values(PLATFORM_PLAN_TIERS) };

// Builds a closed object schema where every listed property is required.
function closedObject(properties) {
  return { type: 'object', required: Object.keys(properties), properties, additionalProperties: false };
}

const kpiSchema = closedObject({ current: INTEGER, previous: INTEGER });
const rangeSchema = closedObject({ from: DATE_TIME, to: DATE_TIME });

const aiTopTrainerSchema = closedObject({
  trainerId: UUID,
  firstName: NULLABLE_STRING,
  lastName: NULLABLE_STRING,
  email: NULLABLE_STRING,
  tier: TIER,
  totalTokens: INTEGER,
  estimatedCostUsd: { type: 'number', description: 'USD, rounded to cents; models without a price are left out' },
});

const aiUsageSchema = closedObject({
  month: { type: 'string', description: 'Current UTC billing month, YYYY-MM' },
  inputTokens: INTEGER,
  outputTokens: INTEGER,
  cacheReadTokens: INTEGER,
  cacheWriteTokens: INTEGER,
  totalTokens: INTEGER,
  interactions: { ...INTEGER, description: 'Number of iArnold turns (ai_token_usage rows)' },
  trainers: { ...INTEGER, description: 'Distinct trainers with usage this month' },
  estimatedCostUsd: { type: 'number', description: 'USD, rounded to cents, over models with a known price' },
  costComplete: { type: 'boolean', description: 'false when some usage is on a model without a price' },
  topTrainers: { type: 'array', items: aiTopTrainerSchema },
});

const latestTrainerSchema = closedObject({
  userId: UUID,
  firstName: NULLABLE_STRING,
  lastName: NULLABLE_STRING,
  email: NULLABLE_STRING,
  tier: TIER,
  studentCount: INTEGER,
  createdAt: DATE_TIME,
});

const pendingCountProperties = {
  pendingInvites: { ...INTEGER, description: 'Trainer invites pending and not expired' },
  newFeedbacks: { ...INTEGER, description: 'Trainer feedbacks with status NEW' },
};

export const getOverviewSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Manager dashboard overview for a 7/30/90-day period — admin only',
  security: SECURITY,
  querystring: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: Object.values(OVERVIEW_PERIODS), default: OVERVIEW_DEFAULT_PERIOD },
    },
    additionalProperties: false,
  },
  response: buildResponses(
    closedObject({
      period: { type: 'string', enum: Object.values(OVERVIEW_PERIODS) },
      generatedAt: DATE_TIME,
      range: rangeSchema,
      previousRange: rangeSchema,
      kpis: closedObject({
        newTrainers: kpiSchema,
        newStudents: kpiSchema,
        activeTrainers: kpiSchema,
        completedSessions: kpiSchema,
      }),
      weeklySignups: {
        type: 'array',
        description: 'Last 8 America/Sao_Paulo weeks, oldest first',
        items: closedObject({ weekStart: DATE_ONLY, trainers: INTEGER, students: INTEGER }),
      },
      ai: aiUsageSchema,
      plans: { type: 'array', items: closedObject({ tier: TIER, count: INTEGER }) },
      pending: closedObject({
        ...pendingCountProperties,
        trainersWithoutStudents: { ...INTEGER, description: 'Live trainers older than 14 days with no live student' },
      }),
      latestTrainers: { type: 'array', items: latestTrainerSchema },
    }),
  ),
};

export const getPendingSchema = {
  tags: [ADMIN_MANAGER_TAG],
  summary: 'Pending manager items for the navigation badge — admin only',
  security: SECURITY,
  response: buildResponses(closedObject(pendingCountProperties)),
};
