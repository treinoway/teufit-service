import {
  ADMIN_MANAGER_PAGE_SIZE_DEFAULT,
  ADMIN_MANAGER_PAGE_SIZE_MAX,
  ADMIN_MANAGER_PROTOCOL_PERSPECTIVE,
  ADMIN_MANAGER_SEARCH_MAX_LENGTH,
  ADMIN_MANAGER_TEMPLATE_TYPE,
  ADMIN_MANAGER_USER_KIND,
} from '../../src/constants/admin-manager.js';
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
    }),
  ),
};
