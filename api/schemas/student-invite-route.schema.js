import { i18nField } from '../../src/i18n/schema-helpers.js';
import {
  StudentInviteOutcome,
  studentInviteStatusValues,
  STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT,
  STUDENT_INVITE_LIST_PAGE_SIZE_MAX,
} from '../../src/constants/student-invite.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const inviteIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
};

const studentInviteSchema = {
  type: 'object',
  required: ['id', 'email', 'status', 'expiresAt', 'lastSentAt', 'sendCount', 'createdAt', 'canResend', 'resendAvailableAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    ...i18nField('status', 'inviteStatus'),
    studentId: { type: 'string', format: 'uuid', nullable: true },
    expiresAt: { type: 'string', format: 'date-time' },
    acceptedAt: { type: 'string', format: 'date-time', nullable: true },
    revokedAt: { type: 'string', format: 'date-time', nullable: true },
    lastSentAt: { type: 'string', format: 'date-time' },
    sendCount: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    canResend: {
      type: 'boolean',
      description: 'True when a resend would be accepted right now (pending, under the max sends, cooldown elapsed).',
    },
    resendAvailableAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'When the resend cooldown ends. Null when resend is allowed now or never allowed (not pending / max sends reached).',
    },
  },
  additionalProperties: false,
};

const linkedStudentSchema = {
  type: 'object',
  required: ['id', 'email'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
  },
  additionalProperties: false,
};

const tags = ['trainer'];

export const inviteStudentSchema = {
  tags,
  summary: 'Add a student by email: link an existing user or invite a new one',
  description:
    'If the email belongs to a registered user with a VERIFIED email, the student is linked immediately (outcome "linked", `student` present). '
    + 'Otherwise (no user, or a user whose email is not verified yet) a pending invite is created and emailed (outcome "invited", `invite` present); '
    + 'it is accepted automatically once the student signs up and verifies that email. The plan student cap is checked when inviting. '
    + 'At most 50 invites can be created per trainer per rolling 24h (429 studentInvite.dailyLimit with details.retryAfterSeconds); direct links do not count.',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email' },
    },
  },
  response: {
    201: {
      type: 'object',
      required: ['outcome'],
      properties: {
        outcome: { type: 'string', enum: Object.values(StudentInviteOutcome) },
        student: linkedStudentSchema,
        invite: studentInviteSchema,
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: {
      description: 'Already linked (student.alreadyLinked), already pending (studentInvite.alreadyPending) or trainer profile missing',
      ...errorResponseSchema,
    },
    422: {
      description: 'Cannot link self (student.cannotLinkSelf) or student account deactivated (student.accountDeactivated)',
      ...errorResponseSchema,
    },
    429: {
      description: 'Daily invite limit (studentInvite.dailyLimit; details.retryAfterSeconds) or rate limit',
      ...errorResponseSchema,
    },
    500: errorResponseSchema,
  },
};

export const listStudentInvitesSchema = {
  tags,
  summary: 'List the trainer\'s student invites',
  description: 'Pending invites past their expiry are reported (and filtered) as "expired".',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: [...studentInviteStatusValues] },
      page: { type: 'integer', minimum: 1, default: 1 },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: STUDENT_INVITE_LIST_PAGE_SIZE_MAX,
        default: STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT,
      },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['items', 'total', 'page', 'pageSize'],
      properties: {
        items: { type: 'array', items: studentInviteSchema },
        total: { type: 'integer' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const resendStudentInviteSchema = {
  tags,
  summary: 'Resend a pending student invite',
  description: '1 hour cooldown between sends, max 5 sends per invite. Resending an expired pending invite revives it (new 30 day expiry).',
  security: [{ bearerAuth: [] }],
  params: inviteIdParamsSchema,
  response: {
    200: {
      type: 'object',
      required: ['invite'],
      properties: { invite: studentInviteSchema },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: {
      description: 'Not pending (studentInvite.notPending) or resend limit reached (studentInvite.resendLimit)',
      ...errorResponseSchema,
    },
    429: {
      description: 'Resend cooldown (studentInvite.resendCooldown; details.retryAfterSeconds) or rate limit',
      ...errorResponseSchema,
    },
    500: errorResponseSchema,
    502: {
      description: 'Email provider rejected the send (studentInvite.emailSendFailed); the resend is not counted',
      ...errorResponseSchema,
    },
  },
};

export const revokeStudentInviteSchema = {
  tags,
  summary: 'Cancel a pending student invite',
  security: [{ bearerAuth: [] }],
  params: inviteIdParamsSchema,
  response: {
    200: {
      type: 'object',
      required: ['invite'],
      properties: { invite: studentInviteSchema },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: {
      description: 'Invite is not pending (studentInvite.notPending)',
      ...errorResponseSchema,
    },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
