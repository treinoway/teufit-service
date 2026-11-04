import { PatientInviteStatus } from '../../src/constants/nutrition.js';
import { badRequestErrorResponseSchema, errorResponseSchema, uuidParam, nullableString } from './nutrition-shared.schema.js';

const tags = ['Nutrition - Patient app'];
const security = [{ bearerAuth: [] }];

const answerResponses = {
  400: badRequestErrorResponseSchema,
  401: errorResponseSchema,
  404: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
};

export const listMyInvitesSchema = {
  tags,
  summary: 'Pending nutritionist invites addressed to the caller email',
  description: 'Only pending, unexpired invites. Nothing is shared with the nutritionist until the invite is accepted.',
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
              nutritionist: {
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
    params: uuidParam('id'),
    response: {
      200: { type: 'object', properties: { status: { type: 'string', enum: [status] } } },
      ...answerResponses,
    },
  };
}

export const acceptMyInviteSchema = answerSchema(
  'Accept a nutritionist invite: creates the nutritionist-patient link',
  PatientInviteStatus.ACCEPTED,
);

export const declineMyInviteSchema = answerSchema(
  'Decline a nutritionist invite: no link is created',
  PatientInviteStatus.DECLINED,
);
