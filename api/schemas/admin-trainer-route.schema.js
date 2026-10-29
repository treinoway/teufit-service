import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';
import { ADMIN_ACCOUNT_TYPE, adminInviteStatusValues } from '../../src/constants/admin-trainer-list.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const ADMIN_TRAINERS_TAG = 'Admin - Trainers';
const TRAINER_LIST_PAGE_SIZE_MAX = 100;
const TRAINER_LIST_PAGE_SIZE_DEFAULT = 20;
const SEARCH_MAX_LENGTH = 200;
const tierValues = Object.values(PLATFORM_PLAN_TIERS);
const accountTypeValues = Object.values(ADMIN_ACCOUNT_TYPE);

const nullableString = { type: 'string', nullable: true };
const nullableInteger = { type: 'integer', nullable: true };

const trainerListItemSchema = {
  type: 'object',
  required: [
    'accountType', 'trainerId', 'userId', 'tier', 'subscriptionStatus',
    'hasAsaasSubscription', 'activeStudents', 'studentCap', 'inviteStatus', 'inviteSentAt',
  ],
  properties: {
    accountType: { type: 'string', enum: accountTypeValues },
    trainerId: { type: 'string', format: 'uuid', nullable: true, description: 'null only for accountType=signup' },
    userId: { type: 'string', format: 'uuid' },
    firstName: nullableString,
    lastName: nullableString,
    email: nullableString,
    tier: { type: 'string', enum: tierValues, nullable: true, description: 'null only for accountType=signup' },
    subscriptionStatus: { ...nullableString, description: 'null only for accountType=signup' },
    hasAsaasSubscription: { type: 'boolean' },
    activeStudents: { ...nullableInteger, description: 'null only for accountType=signup' },
    studentCap: { ...nullableInteger, description: 'null only for accountType=signup' },
    inviteStatus: { type: 'string', enum: adminInviteStatusValues },
    inviteSentAt: { type: 'string', format: 'date-time', nullable: true },
  },
  additionalProperties: false,
};

export const listTrainersSchema = {
  tags: [ADMIN_TRAINERS_TAG],
  summary: 'List trainers with plan and student usage — admin only',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      search: { type: 'string', maxLength: SEARCH_MAX_LENGTH },
      includeSignups: { type: 'boolean', default: false },
      inviteStatus: { type: 'string', enum: adminInviteStatusValues },
      page: { type: 'integer', minimum: 1, default: 1 },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: TRAINER_LIST_PAGE_SIZE_MAX,
        default: TRAINER_LIST_PAGE_SIZE_DEFAULT,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['items', 'total', 'page', 'pageSize'],
      properties: {
        items: { type: 'array', items: trainerListItemSchema },
        total: { type: 'integer' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
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

export const setTrainerPlanSchema = {
  tags: [ADMIN_TRAINERS_TAG],
  summary: "Override a trainer's platform plan tier (no billing call) — admin only",
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['trainerId'],
    properties: { trainerId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['tier'],
    properties: { tier: { type: 'string', enum: tierValues } },
    propertyNames: { enum: ['tier'] },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: [
        'trainerId', 'previousTier', 'tier', 'changed',
        'subscriptionStatus', 'hasAsaasSubscription', 'activeStudents', 'studentCap',
      ],
      properties: {
        trainerId: { type: 'string', format: 'uuid' },
        previousTier: { type: 'string', enum: tierValues },
        tier: { type: 'string', enum: tierValues },
        changed: { type: 'boolean' },
        subscriptionStatus: { ...nullableString, description: 'null only for accountType=signup' },
        hasAsaasSubscription: { type: 'boolean' },
        activeStudents: { type: 'integer' },
        studentCap: { ...nullableInteger, description: 'null only for accountType=signup' },
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
