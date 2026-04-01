import { badRequestErrorResponseSchema, errorResponseSchema } from './error-response.schema.js';

const authHeaders = {
  type: 'object',
  required: ['authorization'],
  properties: {
    authorization: {
      type: 'string',
      description: 'Bearer access token (e.g., "Bearer <token>")',
    },
  },
};

const brandingObjectSchema = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string', format: 'uuid' },
    trainerId: { type: 'string', format: 'uuid' },
    primaryColor: { type: 'string' },
    secondaryColor: { type: 'string', nullable: true },
    logoUrl: { type: 'string', nullable: true },
    coverImageUrl: { type: 'string', nullable: true },
    welcomeMessage: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const upsertBrandingSchema = {
  tags: ['trainer-branding'],
  summary: 'Create or update trainer branding configuration',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  body: {
    type: 'object',
    required: ['primaryColor'],
    additionalProperties: false,
    properties: {
      primaryColor: {
        type: 'string',
        pattern: '^#[0-9A-Fa-f]{6}$',
        description: 'Primary brand color in hex format (e.g. #FF5733)',
      },
      secondaryColor: {
        type: 'string',
        pattern: '^#[0-9A-Fa-f]{6}$',
        nullable: true,
        description: 'Secondary brand color in hex format (e.g. #33A1FF)',
      },
      welcomeMessage: {
        type: 'string',
        maxLength: 200,
        nullable: true,
        description: 'Welcome message shown to students (max 200 characters)',
      },
    },
  },
  response: {
    200: brandingObjectSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const getBrandingSchema = {
  tags: ['trainer-branding'],
  summary: 'Get the authenticated trainer branding configuration',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: { ...brandingObjectSchema, nullable: true },
    401: errorResponseSchema,
    403: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

export const uploadBrandingImageSchema = {
  tags: ['trainer-branding'],
  summary: 'Upload a branding image (logo or cover)',
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  consumes: ['multipart/form-data'],
  response: {
    200: brandingObjectSchema,
    400: badRequestErrorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};

const studentBrandingResponseSchema = {
  type: 'object',
  nullable: true,
  properties: {
    gymName: { type: 'string', nullable: true },
    trainerName: { type: 'string', nullable: true },
    trainerAvatarUrl: { type: 'string', nullable: true },
    branding: {
      type: 'object',
      nullable: true,
      properties: {
        primaryColor: { type: 'string' },
        secondaryColor: { type: 'string', nullable: true },
        logoUrl: { type: 'string', nullable: true },
        coverImageUrl: { type: 'string', nullable: true },
        welcomeMessage: { type: 'string', nullable: true },
      },
    },
  },
};

export const getStudentTrainerBrandingSchema = {
  tags: ['trainer-branding'],
  summary: "Get the student's active trainer branding",
  security: [{ bearerAuth: [] }],
  headers: authHeaders,
  response: {
    200: studentBrandingResponseSchema,
    401: errorResponseSchema,
    429: errorResponseSchema,
    500: errorResponseSchema,
  },
};
