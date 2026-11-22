import { i18nField } from '../../src/i18n/schema-helpers.js';
import { StudentInviteOutcome } from '../../src/constants/student-invite.js';
import { Sex, patientInviteStatusValues } from '../../src/constants/nutrition.js';
import {
  badRequestErrorResponseSchema,
  errorResponseSchema,
  uuidParam,
  nullableString,
  patientRowSchema,
  sheetSchema,
} from './nutrition-shared.schema.js';

const tags = ['Nutritionist - Patients'];
const security = [{ bearerAuth: [] }];
const MAX_WEIGHT_KG = 500;
const MAX_HEIGHT_CM = 300;
const MAX_BODY_FAT_PCT = 100;
const statusToken = patientInviteStatusValues.join('|');
const STATUS_LIST_PATTERN = `^(${statusToken})(,(${statusToken}))*$`;

const inviteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    ...i18nField('status', 'inviteStatus'),
    expiresAt: { type: 'string', format: 'date-time' },
    lastSentAt: { type: 'string', format: 'date-time' },
    sendCount: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    canResend: { type: 'boolean' },
    resendAvailableAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const standardErrors = {
  400: badRequestErrorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  409: errorResponseSchema,
  500: errorResponseSchema,
};

export const invitePatientSchema = {
  tags,
  summary: 'Invite a patient by email (the link only exists after the patient accepts in the app)',
  description:
    'Always creates a pending invite and emails it (outcome "invited", `invite`), whether or not the email already has an account. The patient accepts or declines in the app; nothing about the patient is visible to the nutritionist before acceptance. Outcome "linked" is kept in the enum for compatibility but is no longer produced. A sender whose email is not confirmed can create 3 invites per rolling 24h; the next one answers 403 emailVerification.required (accounts created before the open-signup cut-off are exempt).',
  security,
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: { email: { type: 'string', format: 'email' } },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: Object.values(StudentInviteOutcome) },
        invite: inviteSchema,
      },
    },
    ...standardErrors,
    403: {
      description: 'Not a nutritionist, or sender email not confirmed after 3 invites in 24h (emailVerification.required)',
      ...errorResponseSchema,
    },
    422: errorResponseSchema,
    429: errorResponseSchema,
  },
};

export const listPatientInvitesSchema = {
  tags,
  summary: 'List the nutritionist patient invites',
  security,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        type: 'string',
        pattern: STATUS_LIST_PATTERN,
        description: `One status or a comma separated list (e.g. pending,declined): ${patientInviteStatusValues.join(', ')}.`,
      },
    },
  },
  response: {
    200: { type: 'object', properties: { items: { type: 'array', items: inviteSchema } } },
    ...standardErrors,
  },
};

export const resendPatientInviteSchema = {
  tags,
  summary: 'Resend a pending patient invite or revive a declined one',
  description: '1 hour cooldown between sends, max 5 sends per invite. Resending a declined invite sets it back to pending.',
  security,
  params: uuidParam('id'),
  response: {
    200: inviteSchema,
    ...standardErrors,
    404: errorResponseSchema,
    429: errorResponseSchema,
    502: errorResponseSchema,
  },
};

export const revokePatientInviteSchema = {
  tags,
  summary: 'Cancel a pending patient invite',
  security,
  params: uuidParam('id'),
  response: { 204: { type: 'null' }, ...standardErrors, 404: errorResponseSchema },
};

export const listPatientsSchema = {
  tags,
  summary: 'List the linked patients',
  security,
  response: { 200: { type: 'object', properties: { items: { type: 'array', items: patientRowSchema } } }, ...standardErrors },
};

export const unlinkPatientSchema = {
  tags,
  summary: 'Unlink a patient (soft)',
  security,
  params: uuidParam('patientId'),
  response: { 204: { type: 'null' }, ...standardErrors, 404: errorResponseSchema },
};

export const getSheetSchema = {
  tags,
  summary: 'Patient sheet (ficha), prefilled from the patient data when never saved',
  security,
  params: uuidParam('patientId'),
  response: { 200: sheetSchema, ...standardErrors, 404: errorResponseSchema },
};

export const putSheetSchema = {
  tags,
  summary: 'Save the patient sheet (ficha)',
  security,
  params: uuidParam('patientId'),
  body: {
    type: 'object',
    required: ['sex', 'weightKg', 'heightCm'],
    additionalProperties: false,
    properties: {
      sex: { type: 'string', enum: Object.values(Sex) },
      weightKg: { type: 'number', exclusiveMinimum: 0, maximum: MAX_WEIGHT_KG },
      heightCm: { type: 'number', exclusiveMinimum: 0, maximum: MAX_HEIGHT_CM },
      bodyFatPct: { type: 'number', minimum: 0, maximum: MAX_BODY_FAT_PCT, nullable: true },
      assessedAt: { type: 'string', format: 'date', nullable: true },
    },
  },
  response: { 200: sheetSchema, ...standardErrors, 404: errorResponseSchema },
};

export const getOverviewSchema = {
  tags,
  summary: 'Plan summary header: patient, trainer and 7-day adherence',
  security,
  params: uuidParam('patientId'),
  response: {
    200: {
      type: 'object',
      properties: {
        patient: patientRowSchema,
        trainer: {
          type: 'object',
          nullable: true,
          properties: {
            id: { type: 'string', format: 'uuid' },
            firstName: nullableString,
            lastName: nullableString,
            avatarUrl: nullableString,
          },
        },
        adherence7d: {
          type: 'object',
          properties: {
            mealsDone: { type: 'integer' },
            mealsExpected: { type: 'integer' },
            percent: { type: 'number' },
            swaps: {
              type: 'object',
              properties: {
                total: { type: 'integer' },
                topPair: { type: 'object', nullable: true, properties: { from: { type: 'string' }, to: { type: 'string' } } },
              },
            },
            ateDifferent: {
              type: 'object',
              properties: { total: { type: 'integer' }, topMealName: nullableString },
            },
          },
        },
      },
    },
    ...standardErrors,
    404: errorResponseSchema,
  },
};

export const trainingActivitiesSchema = {
  tags,
  summary: 'Activities suggested from the patient active training protocol',
  security,
  params: uuidParam('patientId'),
  response: {
    200: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              met: { type: 'number' },
              minutes: { type: 'number' },
              perWeek: { type: 'number' },
            },
          },
        },
      },
    },
    ...standardErrors,
    404: errorResponseSchema,
  },
};
