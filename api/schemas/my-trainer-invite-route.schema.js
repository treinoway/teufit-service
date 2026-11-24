import { StudentInviteStatus } from '../../src/constants/student-invite.js';
import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const tags = ['Student app - Trainer invites'];
const security = [{ bearerAuth: [] }];
const nullableString = { type: 'string', nullable: true };

const inviteIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

const answerResponses = {
  400: badRequestErrorResponseSchema,
  401: errorResponseSchema,
  404: { description: 'Unknown invite, invite of another email, or caller email not verified (studentInvite.notFound)', ...errorResponseSchema },
  409: { description: 'Invite already accepted, declined or revoked (studentInvite.notPending)', ...errorResponseSchema },
  422: { description: 'Invite past its expiry (studentInvite.expired)', ...errorResponseSchema },
  500: errorResponseSchema,
};

export const listMyTrainerInvitesSchema = {
  tags,
  summary: 'Pending trainer invites addressed to the caller email',
  description:
    'Only pending, unexpired invites that wait for the consent of the caller (the email already had an account when the trainer invited it), newest first. '
    + 'A caller without a verified email gets an empty list. Nothing is shared with the trainer until the invite is accepted.',
  security,
  response: {
    200: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              trainer: {
                type: 'object',
                properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, avatarUrl: nullableString },
              },
              createdAt: { type: 'string', format: 'date-time' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    401: errorResponseSchema,
    500: errorResponseSchema,
  },
};

// Builds the schema of an accept/decline answer.
function answerSchema(summary, status) {
  return {
    tags,
    summary,
    security,
    params: inviteIdParamsSchema,
    response: {
      200: { type: 'object', properties: { status: { type: 'string', enum: [status] } } },
      ...answerResponses,
    },
  };
}

export const acceptMyTrainerInviteSchema = answerSchema(
  'Accept a trainer invite: creates the trainer-student link',
  StudentInviteStatus.ACCEPTED,
);

export const declineMyTrainerInviteSchema = answerSchema(
  'Decline a trainer invite: no link is created',
  StudentInviteStatus.DECLINED,
);
