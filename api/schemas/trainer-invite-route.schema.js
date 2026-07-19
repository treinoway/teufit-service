import { i18nField } from '../../src/i18n/schema-helpers.js';
import { inviteStatusValues, INVITE_LIST_PAGE_SIZE_MAX } from '../../src/constants/trainer-invite.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const inviteSchema = {
  type: 'object',
  required: ['id', 'email', 'status', 'expiresAt', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    ...i18nField('status', 'inviteStatus'),
    invitedByUserId: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid', nullable: true },
    expiresAt: { type: 'string', format: 'date-time' },
    acceptedAt: { type: 'string', format: 'date-time', nullable: true },
    revokedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};

// Minimal shape returned right after creation — the caller already has the
// invitedByUserId (themselves) and doesn't need userId/acceptedAt/revokedAt yet.
const createdInviteSchema = {
  type: 'object',
  required: ['id', 'email', 'status', 'expiresAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    ...i18nField('status', 'inviteStatus'),
    expiresAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};

export const createInviteSchema = {
  tags: ['Trainer Invites - Admin'],
  summary: 'Create a trainer invite (closed beta) — admin only',
  description: 'Sends a magic-link + code invite to the given email. Any prior pending invite for that email is revoked. Returns the plain code (shown once, also emailed).',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      required: ['invite', 'code'],
      properties: {
        invite: createdInviteSchema,
        code: { type: 'string', description: 'Plain invite code, e.g. TW-XXXX-XXXX-XX. Shown once.' },
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: {
      description: 'Conflict — this email already has an accepted (active) invite (invite.alreadyActiveForEmail)',
      ...errorResponseSchema,
    },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const listInvitesSchema = {
  tags: ['Trainer Invites - Admin'],
  summary: 'List/search trainer invites — admin only',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...inviteStatusValues] },
      email: { type: 'string' },
      page: { type: 'integer', minimum: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: INVITE_LIST_PAGE_SIZE_MAX },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['items', 'total', 'page', 'pageSize'],
      properties: {
        items: { type: 'array', items: inviteSchema },
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

export const revokeInviteSchema = {
  tags: ['Trainer Invites - Admin'],
  summary: 'Revoke a pending trainer invite — admin only',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      required: ['invite'],
      properties: { invite: inviteSchema },
      additionalProperties: false,
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: {
      description: 'Conflict — only pending invites can be revoked (resource.conflict)',
      ...errorResponseSchema,
    },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const redeemInviteSchema = {
  tags: ['Trainer Invites'],
  summary: 'Redeem a trainer invite code — grants the trainer role',
  description: 'The authenticated user must be logged in with the same email the invite was sent to. On success the trainer role is granted and fresh tokens are issued (same pattern as /become-trainer).',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['code'],
    properties: {
      code: { type: 'string', minLength: 1, maxLength: 32, description: 'Invite code, e.g. TW-XXXX-XXXX-XX. Dashes/prefix are optional and case-insensitive.' },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['betaAccess', 'activeProfile', 'token', 'refreshToken'],
      properties: {
        betaAccess: { type: 'boolean' },
        activeProfile: {
          type: 'string',
          enum: ['student', 'trainer', 'nutritionist'],
        },
        token: {
          type: 'object',
          required: ['accessToken'],
          properties: {
            accessToken: { type: 'string', description: 'New JWT access token with the trainer role' },
          },
          additionalProperties: false,
        },
        refreshToken: { type: 'string' },
      },
      additionalProperties: false,
    },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: {
      description: 'Forbidden — invite.revoked, invite.expired, or invite.emailMismatch',
      ...errorResponseSchema,
    },
    404: {
      description: 'Not found — invite.notFound (unknown/mistyped code)',
      ...errorResponseSchema,
    },
    409: {
      description: 'Conflict — invite.alreadyAccepted (already redeemed by another user, or lost a concurrent-redeem race)',
      ...errorResponseSchema,
    },
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
