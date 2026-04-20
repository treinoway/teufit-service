import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';
import { i18nField } from '../../src/i18n/schema-helpers.js';

const nutritionistProfileResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    birthDate: { type: 'string', nullable: true, description: 'Date-only string (YYYY-MM-DD)' },
    avatarUrl: { type: 'string', nullable: true },
    professionalDocument: { type: 'string', nullable: true },
    clinicName: { type: 'string', nullable: true },
    notes: { type: 'string', nullable: true },
    ...i18nField('serviceMode', 'trainerServiceMode', { nullable: true }),
    profileCompletedAt: { type: 'string', format: 'date-time', nullable: true },
    address: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        line1: { type: 'string', nullable: true },
        line2: { type: 'string', nullable: true },
        neighborhood: { type: 'string', nullable: true },
        city: { type: 'string', nullable: true },
        state: { type: 'string', nullable: true },
        stateCode: { type: 'string', nullable: true },
        country: { type: 'string', nullable: true },
        countryCode: { type: 'string', nullable: true },
        postalCode: { type: 'string', nullable: true },
      },
      additionalProperties: true,
    },
    socialNetworks: {
      type: 'object',
      nullable: true,
      properties: {
        instagram: { type: 'string', nullable: true },
        whatsapp: { type: 'string', nullable: true },
        x: { type: 'string', nullable: true },
        threads: { type: 'string', nullable: true },
        youtube: { type: 'string', nullable: true },
        linkedin: { type: 'string', nullable: true },
        facebook: { type: 'string', nullable: true },
      },
      additionalProperties: true,
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
  additionalProperties: true,
};

export const getNutritionistSchema = {
  tags: ['nutritionist'],
  summary: 'Get the authenticated nutritionist profile',
  security: [{ bearerAuth: [] }],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  response: {
    200: nutritionistProfileResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const nutritionistListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    firstName: { type: 'string', nullable: true },
    lastName: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
    ...i18nField('serviceMode', 'trainerServiceMode', { nullable: true }),
    address: {
      type: 'object',
      nullable: true,
      properties: {
        city: { type: 'string', nullable: true },
        state: { type: 'string', nullable: true },
        country: { type: 'string', nullable: true },
      },
    },
    socialNetworks: {
      type: 'object',
      nullable: true,
      additionalProperties: true,
    },
  },
};

export const listNutritionistsSchema = {
  tags: ['nutritionist'],
  summary: 'List all active nutritionists with completed profiles',
  security: [{ bearerAuth: [] }],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  response: {
    200: {
      type: 'array',
      items: nutritionistListItemSchema,
    },
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const updateNutritionistSchema = {
  tags: ['nutritionist'],
  summary: 'Update nutritionist profile',
  security: [{ bearerAuth: [] }],
  headers: {
    type: 'object',
    required: ['authorization'],
    properties: {
      authorization: {
        type: 'string',
        description: 'Bearer access token (e.g., "Bearer <token>")',
      },
    },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nutritionist: {
        type: 'object',
        additionalProperties: false,
        description: 'Nutritionist profile fields to update',
        properties: {
          professionalDocument: {
            type: 'string',
            nullable: true,
            description: 'Professional registration/document (e.g., CRN number)',
          },
          clinicName: {
            type: 'string',
            nullable: true,
            description: 'Clinic or practice name',
          },
          notes: {
            type: 'string',
            nullable: true,
            description: 'Additional notes about the nutritionist',
          },
          serviceMode: {
            type: 'string',
            nullable: true,
            description: 'Service mode offered by the nutritionist',
            enum: ['online', 'in_person', 'hybrid'],
          },
        },
      },
    },
  },
  response: {
    200: { type: 'object', additionalProperties: true },
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
